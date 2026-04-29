// app/api/maintenance-audit/route.ts
// Orchestration endpoint for Maintenance Debt Audit.
//
// Pipeline:
//   extract → normalize → VDB schedule → [AI fallback] → repairEstimates → compareEngine

export const maxDuration = 120; // Allow up to 2 min for large PDFs (Vercel/Next.js)

import { NextResponse } from "next/server";
import type { ServiceHistoryEvent, VehicleIdentity } from "@/lib/maintenanceDebt/types";
import { extractFromText } from "@/lib/maintenanceDebt/extract";
import { normalizeServiceHistory } from "@/lib/maintenanceDebt/normalize";
import { compareHistoryToSchedule } from "@/lib/maintenanceDebt/compareEngine";
import { getMaintenanceSchedule } from "@/lib/vehicleDatabases/maintenance";
import { getRepairEstimateMap } from "@/lib/vehicleDatabases/repairEstimates";
import { estimateScheduleFromYMMT } from "@/lib/maintenanceDebt/estimateSchedule";
import { applyPricingToDebtItems, aggregateDebt, type PricingContext } from "@/lib/maintenanceDebt/pricingEngine";
import { fetchBaTPricingContext } from "@/lib/vehicleDatabases/enthusiastPricing";

import { computeVerdict } from "@/lib/maintenanceDebt/verdict";
import OpenAI from "openai";

// ─── Market Value Estimator ───────────────────────────────────────────────────
// Primary: MarketCheck /v2/predict/car/price/us (real listings, free tier)
// Fallback: GPT-4o-mini estimate (used when no API key or VIN unavailable)

async function estimateMarketValue(
  vehicle: Partial<VehicleIdentity>
): Promise<{ low: number; high: number; confidence: "low" | "medium" | "high"; source?: string } | null> {
  const { year, make, model, trim, currentMileage, vin } = vehicle;
  if (!year || !make || !model) return null;

  const mcKey = process.env.MARKETCHECK_API_KEY;

  // ── Enthusiast Detection ────────────────────────────────────────────────
  const ENTHUSIAST_MAKES = ["porsche", "land rover", "ferrari", "aston martin", "lotus"];
  const ENTHUSIAST_MODELS = ["911", "defender", "land cruiser", "s2000", "m3", "supra"];
  const isEnthusiast = (typeof year === 'number' && year <= 2005) || 
                       ENTHUSIAST_MAKES.includes(make.toLowerCase()) || 
                       ENTHUSIAST_MODELS.some(m => model.toLowerCase().includes(m));

  if (isEnthusiast && process.env.FIRECRAWL_API_KEY) {
    console.log(`[marketValue] Enthusiast vehicle detected (${year} ${make} ${model}). Routing to BaT Pricing.`);
    const batPrice = await fetchBaTPricingContext(typeof year === 'number' ? year : parseInt(year as string), make, model);
    if (batPrice) return batPrice;
  }

  // ── Attempt 1: MarketCheck (real market data) ────────────────────────────
  if (mcKey && vin && vin.length === 17 && currentMileage) {
    try {
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), 4000); // 4s timeout

      // Default to Denver (80218) — all WrenchCheck beta vehicles are Colorado-based.
      // Change to user zip when we add location detection.
      const zip = "80218";

      // Correct endpoint: /v2/predict/car/us/marketcheck_price (not /car/price/us)
      // Auth: api_key + api_secret as query params (headers return 401 on this plan)
      // Required: vin, miles, dealer_type, zip, radius
      const url = new URL("https://api.marketcheck.com/v2/predict/car/us/marketcheck_price");
      url.searchParams.set("api_key", mcKey);
      url.searchParams.set("api_secret", process.env.MARKETCHECK_API_SECRET ?? "");
      url.searchParams.set("vin", vin);
      url.searchParams.set("miles", String(currentMileage));
      url.searchParams.set("dealer_type", "franchise"); // conservative; use 'independent' for private seller comps
      url.searchParams.set("zip", "80218"); // Denver — all beta vehicles are CO-based
      url.searchParams.set("radius", "100");

      const res = await fetch(url.toString(), { signal: abort.signal });
      clearTimeout(timer);

      if (res.ok) {
        const data = await res.json();
        // Response shape: { marketcheck_price: 34513, msrp: 64520 }
        const price: number | undefined = data?.marketcheck_price ?? data?.price ?? data?.predicted_price;

        if (price && price > 0) {
          // API returns a single point estimate — build a ±10% natural range around it
          const low  = Math.round(price * 0.90 / 500) * 500;
          const high = Math.round(price * 1.10 / 500) * 500;
          console.log(`[marketValue] MarketCheck ✓ ${vin}: $${price.toLocaleString()} → range $${low.toLocaleString()}–$${high.toLocaleString()}`);
          return { low, high, confidence: "high" as const, source: "marketcheck" };
        } else {
          console.warn(`[marketValue] MarketCheck 200 but no price field:`, JSON.stringify(data).slice(0, 200));
        }
      } else {
        console.warn(`[marketValue] MarketCheck ${res.status} — falling back to AI`);
      }
    } catch (err) {
      console.warn("[marketValue] MarketCheck error:", err instanceof Error ? err.message : err);
    }
  }

  // ── Attempt 2: GPT-4o-mini fallback ─────────────────────────────────────
  const desc = [year, make, model, trim].filter(Boolean).join(" ");
  const mi = currentMileage?.toLocaleString() ?? "unknown";
  try {
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const mvAbort = new AbortController();
    const mvTimer = setTimeout(() => mvAbort.abort(), 12000);
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: `What is the current private-party market value for a ${desc} with ${mi} miles in the US?\n\nRespond with ONLY a JSON object, no explanation:\n{"low": <number>, "high": <number>, "confidence": "low"|"medium"|"high"}\n\nUse realistic used car prices based on current market (2024-2025). Round to nearest $500.` }],
      max_tokens: 80, temperature: 0.1, response_format: { type: "json_object" },
    }, { signal: mvAbort.signal });
    clearTimeout(mvTimer);
    const raw = JSON.parse(completion.choices[0].message.content ?? "{}");
    if (typeof raw.low === "number" && typeof raw.high === "number") {
      console.log(`[marketValue] AI fallback: ${desc} @ ${mi}mi → $${raw.low.toLocaleString()}–$${raw.high.toLocaleString()}`);
      return { low: raw.low, high: raw.high, confidence: raw.confidence ?? "medium", source: "ai_estimated" };
    }
    return null;
  } catch (err) {
    console.warn("[marketValue] AI fallback failed:", err instanceof Error ? err.message : err);
    return null;
  }
}


// ─── Carfax Signal Extraction ────────────────────────────────────────────────
// Parse owner history, accidents, service quality, and geography from raw PDF text.

export type CarfaxSignals = {
  ownerCount: number | null;
  ownerTypes: string[];
  hasAccident: boolean | null;
  accidentCount: number | null;
  serviceRecordCount: number | null;
  serviceQuality: "dealer_consistent" | "mixed" | "independent_only" | "unknown";
  lastState: string | null;
  isColoradoCar: boolean;
  dealerName: string | null;
};

function extractCarfaxSignals(text: string): CarfaxSignals {
  const ownerMatch = text.match(/(\d+)\s+(?:previous\s+)?owner/i);
  const ownerCount = ownerMatch ? parseInt(ownerMatch[1]) : null;
  const ownerTypes: string[] = [];
  if (/personal\s+lease/i.test(text)) ownerTypes.push("Personal Lease");
  if (/personal\s+use/i.test(text)) ownerTypes.push("Personal Use");
  if (/\bfleet\b/i.test(text)) ownerTypes.push("Fleet");
  if (/\brental\b/i.test(text)) ownerTypes.push("Rental");
  if (/\bcorporate\b/i.test(text)) ownerTypes.push("Corporate");
  const noAccident = /no accidents?\s+or\s+damage\s+reported/i.test(text) || /0\s+accidents?/i.test(text);
  const accidentMatch = text.match(/(\d+)\s+accidents?\s+reported/i);
  const hasAccident = noAccident ? false : accidentMatch ? true : null;
  const accidentCount = accidentMatch ? parseInt(accidentMatch[1]) : (noAccident ? 0 : null);
  const recordMatch = text.match(/(\d+)\s+(?:detailed\s+)?records?\s+available/i);
  const serviceRecordCount = recordMatch ? parseInt(recordMatch[1]) : null;
  const dealerMentions = (text.match(/dealer|dealership|authorized service/gi) || []).length;
  const indepMentions = (text.match(/independent|quick lube|jiffy|midas|firestone|pep boys|valvoline/gi) || []).length;
  const serviceQuality: CarfaxSignals["serviceQuality"] =
    dealerMentions >= 3 ? "dealer_consistent"
    : dealerMentions > 0 && indepMentions > 0 ? "mixed"
    : indepMentions > 0 ? "independent_only" : "unknown";
  const stateMatch = text.match(/last\s+(?:owned|registered)\s+in\s+([A-Za-z ]+)/i);
  const lastState = stateMatch ? stateMatch[1].trim() : null;
  const isColoradoCar = /colorado/i.test(text);
  const dealerMatch = text.match(/(?:service(?:d)?|inspected)\s+(?:at|by)\s+([A-Z][A-Za-z\s\-]{3,40}(?:Mercedes|BMW|Toyota|Jeep|Land Rover|Lincoln|Ford|Chevrolet|Honda|Nissan|Mazda|Audi|Porsche|Volvo|Cadillac|Mitsubishi)[A-Za-z\s]{0,20})/i);
  const dealerName = dealerMatch ? dealerMatch[1].trim() : null;
  return { ownerCount, ownerTypes, hasAccident, accidentCount, serviceRecordCount, serviceQuality, lastState, isColoradoCar, dealerName };
}


// ─── Model Intelligence ───────────────────────────────────────────────────────
// YMMT-specific watchouts + named upcoming services + full buying analysis.

export type ModelInsights = {
  watchouts: { text: string; estimatedCost?: number | null }[];
  namedUpcoming: { name: string; dueMileage?: number | null; estimatedCost: number }[];
  ownershipOutlook: string;
  warrantyStatus?: string | null;
  expertTake?: string | null;
  // Rich analysis
  reliabilityTier: "excellent" | "good" | "below_average" | "poor" | null;
  avgAnnualCost: number | null;
  majorExposures: { name: string; costLow: number; costHigh: number; urgency: "near_term" | "watch" | "long_term"; note: string }[];
  tco: { year1Low: number; year1High: number; year3Low: number; year3High: number } | null;
  goodBuyIf: string[];
  badBuyIf: string[];
  vehicleNarrative: string | null;
  originalMsrp: number | null;
  controversyIndex: number;
  // Year/trim-specific feature intel
  yearFeatures: string[];   // notable features introduced or changed for this specific model year
  trimNotes: string | null; // notable trim-specific capabilities or missing features vs other trims
};

async function generateModelInsights(
  vehicle: Partial<VehicleIdentity>,
  overdueCount: number,
  overdueTotal: number,
  carfaxSignals?: CarfaxSignals | null,
  peerContext?: string | null,
): Promise<ModelInsights | null> {
  const { year, make, model, trim, currentMileage } = vehicle;
  if (!year || !make || !model) return null;
  const desc = [year, make, model, trim].filter(Boolean).join(" ");
  const mi = currentMileage ?? 0;
  const age = new Date().getFullYear() - (year as number);
  const likelyUnderWarranty = age <= 3 && mi < 36000;
  const likelyPowertrainWarranty = age <= 5 && mi < 60000;
  const warrantyNote = likelyUnderWarranty
    ? `This vehicle is likely still under factory bumper-to-bumper warranty (~${3 - age}yr remaining).`
    : likelyPowertrainWarranty
    ? `Factory bumper-to-bumper warranty likely expired, powertrain may still be active.`
    : "";

  // Build Carfax context string for the AI
  const cfxContext = carfaxSignals ? [
    carfaxSignals.ownerCount != null ? `${carfaxSignals.ownerCount} previous owner(s)` : null,
    carfaxSignals.ownerTypes.length ? `Owner types: ${carfaxSignals.ownerTypes.join(", ")}` : null,
    carfaxSignals.hasAccident === false ? "No accidents reported" : carfaxSignals.hasAccident ? `${carfaxSignals.accidentCount ?? "Unknown number of"} accident(s) reported` : null,
    carfaxSignals.serviceQuality === "dealer_consistent" ? "Consistently dealer-serviced" : carfaxSignals.serviceQuality === "mixed" ? "Mixed dealer + independent service" : null,
    carfaxSignals.isColoradoCar ? "Has lived in Colorado (dry climate, minimal rust risk)" : carfaxSignals.lastState ? `Last owned in ${carfaxSignals.lastState}` : null,
    carfaxSignals.serviceRecordCount != null ? `${carfaxSignals.serviceRecordCount} service records on file` : null,
  ].filter(Boolean).join(". ") : null;

  try {
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 25000);
    const prompt = `You are an expert mechanic and used car advisor evaluating a ${desc} with ${mi.toLocaleString()} miles.
${overdueCount > 0 ? `Overdue maintenance: ${overdueCount} items totaling ~$${overdueTotal}.` : "All scheduled maintenance appears current."}
${warrantyNote}
${cfxContext ? `\nKnown facts about this specific car:\n${cfxContext}` : ""}
${peerContext ? `\nCOMPARISON CONTEXT — this car is being evaluated head-to-head against these alternatives:\n${peerContext}\nYour analysis MUST meaningfully differentiate THIS specific car from these alternatives. Generic model-level advice that applies to all of them equally is useless. Focus on what is DIFFERENT about buying this one.` : ""}

Be direct — no hedging, no generic advice. Every sentence must be specific to THIS EXACT car based on its EXACT mileage of ${mi.toLocaleString()} miles and its unique history. DO NOT simply parrot the most famous mechanical issue for the model if the mileage doesn't align.

Respond ONLY with this JSON (no markdown):
{
  "watchouts": [{"text": "<Issue title> – <one sentence: what this means SPECIFICALLY at ${mi.toLocaleString()} miles on this ${make} ${model}. Is this issue IMMINENT at this mileage, approaching, or just a long-term watch?>", "estimatedCost": <number or null>}],
  "namedUpcoming": [{"name": "<service>", "dueMileage": <number or null>, "estimatedCost": <number>}],
  "ownershipOutlook": "<one direct sentence: specific dollar range for THIS car's next 12-18 months based on its actual ${mi.toLocaleString()}-mile position>",
  "expertTake": "<ONE sentence that MUST include the exact phrase '${mi.toLocaleString()} miles' and tell the buyer what action to take. CRITICAL: Analyze what actually breaks at THIS specific mileage. DO NOT repeat the same generic failure mode for every car of this model. Example: 'At ${mi.toLocaleString()} miles you're entering the air suspension compressor's statistical first-failure window...' Not a description. An action.>",
  "warrantyStatus": "<one sentence if factory warranty likely active, else null>",
  "reliabilityTier": "excellent" | "good" | "below_average" | "poor",
  "avgAnnualCost": <estimated annual maintenance + repair cost in dollars, number. Must be consistent with tco year1.>,
  "majorExposures": [
    {"name": "<component>", "costLow": <number>, "costHigh": <number>, "urgency": "near_term" | "watch" | "long_term", "note": "<one sentence that names the urgency relative to THIS car's ${mi.toLocaleString()} miles — 'near_term' = within 15k miles of current odometer>"}
  ],
  "tco": {"year1Low": <number>, "year1High": <number>, "year3Low": <number>, "year3High": <number>},
  "goodBuyIf": ["<persona statement specific to THIS car's ${mi.toLocaleString()}-mile profile and history. A 138k-mile car's personas must differ from a 64k-mile car's.>"],
  "badBuyIf": ["<persona statement specific to THIS car's ${mi.toLocaleString()}-mile profile>"],
  "vehicleNarrative": "<ONE sentence that functions as an honest used-car pitch for THIS individual vehicle. MUST weave together the exact mileage, location, trim, and history. Make it read like a unique BaT listing summary. DO NOT be generically applicable to any other ${make} ${model}.>",
  "originalMsrp": <number — estimated original new MSRP for this specific model/year/trim. Use base MSRP. null if genuinely unknown.>,
  "controversyIndex": <0-10: 0=bulletproof daily, 4=mainstream risk, 7=enthusiast/elevated, 10=extreme project territory>,
  "yearFeatures": ["<Specific physical feature added or changed for the ${year ?? "this"} model year. Name the actual feature. 2-4 items. Empty array if none.>"],
  "trimNotes": "<What this trim includes or lacks vs other trims for this year/model. null if base/only trim.>"
}

Rules:
- expertTake: MUST contain "${mi.toLocaleString()} miles" verbatim. Must be an action instruction, not a description. Never use "can be costly to repair" without citing the cost range.
- watchouts: 2-3 items. Each one must be mileage-calibrated: at ${mi.toLocaleString()} miles is this issue IMMINENT (already overdue), APPROACHING (next 20k miles), or a long-term WATCH? Say which. Use " – " separator.
- majorExposures urgency must reflect THIS car's ${mi.toLocaleString()}-mile position. near_term = within 15k miles. watch = 15-40k miles. long_term = beyond 40k miles.
- tco: Year 1 = first 12 months of ownership costs at this mileage. Year 3 = cumulative 3-year estimate. For same-platform cars, year3Low should stay within $1,000 of comparable mileage/year examples UNLESS there is a documented mechanical or parts-cost difference. Do not invent large gaps between same-platform vehicles.
- avgAnnualCost: must be consistent with tco (year1Low + year1High / 2 ≈ avgAnnualCost).
- goodBuyIf / badBuyIf: 2-3 bullets each. Must reflect the realities of THIS specific odometer reading and history. The 138k-mile car's ideal buyer profile is different from the 64k-mile car's.
- vehicleNarrative: reference real facts from the carfax signals (owner count, service quality, location, accidents). Never a generic statement that applies to every example of this model.
- yearFeatures: Name the EXACT physical feature with year context ("Power tailgate added — not on 2016"). Most differentiating for buyers choosing between adjacent years.
- NEVER say "typical for this mileage", "follow the owner's manual", "consult a mechanic", or any sentence that applies equally to every example of this model.`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 1400, temperature: 0.5, response_format: { type: "json_object" },
    }, { signal: abort.signal });
    clearTimeout(timer);
    const raw = JSON.parse(completion.choices[0].message.content ?? "{}");
    if (!raw.watchouts || !raw.namedUpcoming) return null;
    console.log(`[modelInsights] ${desc} @ ${mi}mi → ${raw.watchouts.length} watchouts, reliability=${raw.reliabilityTier}`);
    return {
      watchouts: (raw.watchouts as any[]).slice(0, 3),
      namedUpcoming: (raw.namedUpcoming as any[]).slice(0, 4),
      ownershipOutlook: raw.ownershipOutlook || "",
      expertTake: raw.expertTake || null,
      warrantyStatus: raw.warrantyStatus || null,
      reliabilityTier: raw.reliabilityTier || null,
      avgAnnualCost: typeof raw.avgAnnualCost === "number" ? raw.avgAnnualCost : null,
      majorExposures: (raw.majorExposures as any[] || []).slice(0, 3),
      tco: raw.tco || null,
      goodBuyIf: (raw.goodBuyIf as string[] || []).slice(0, 3),
      badBuyIf: (raw.badBuyIf as string[] || []).slice(0, 3),
      vehicleNarrative: raw.vehicleNarrative || null,
      originalMsrp: typeof raw.originalMsrp === "number" && raw.originalMsrp > 0 ? raw.originalMsrp : null,
      controversyIndex: typeof raw.controversyIndex === "number" ? Math.min(10, Math.max(0, raw.controversyIndex)) : 3,
      yearFeatures: Array.isArray(raw.yearFeatures) ? (raw.yearFeatures as string[]).slice(0, 4) : [],
      trimNotes: typeof raw.trimNotes === "string" ? raw.trimNotes : null,
    };
  } catch (err) {
    console.warn("[modelInsights] failed:", err instanceof Error ? err.message : err);
    return null;
  }
}



// ─── Extraction types ────────────────────────────────────────────────────────

type ExtractionHealth = {
  fileType: "pdf" | "image" | "text";
  pageCount: number;
  textLength: number;
  pagesWithUsefulText: number;
  foundVin: boolean;
  foundMileage: boolean;
  foundServicePatterns: boolean;
  likelyImageOnly: boolean;
  confidence: "high" | "medium" | "low";
};

type ExtractionResult = {
  text: string;
  health: ExtractionHealth;
  debugLog: DebugEntry[];
};

type DebugEntry = {
  stage: string;
  status: "started" | "succeeded" | "failed" | "skipped";
  durationMs: number;
  reason?: string;
  fallbackChosen?: boolean;
};

// ─── Observability helper ────────────────────────────────────────────────────

function makeLogger(debugLog: DebugEntry[]) {
  return function log(stage: string, status: DebugEntry["status"], startMs: number, reason?: string) {
    const durationMs = Date.now() - startMs;
    const entry: DebugEntry = { stage, status, durationMs, reason, fallbackChosen: status === "failed" };
    debugLog.push(entry);
    console.log(`[ingestion] [${status.toUpperCase()}] ${stage} (${durationMs}ms)${reason ? ` — ${reason}` : ""}`);
    return entry;
  };
}

// ─── Health assessment ───────────────────────────────────────────────────────

function assessHealth(text: string, pageTexts: string[], pageCount: number): ExtractionHealth {
  const foundVin = /\b[A-HJ-NPR-Z0-9]{17}\b/i.test(text);
  const foundMileage =
    /\b\d{1,3}(,\d{3})*\s*(mi|miles|mileage|km|kilometers)\b/i.test(text) ||
    /\b(mileage|odometer)[:\s]+\d{1,3}(,\d{3})*\b/i.test(text);
  const foundServicePatterns =
    /(?:oil change|tire rotation|brake|fluid|filter|inspection|service|replaced|checked|maintenance)/i.test(text);
  const pagesWithUsefulText = pageTexts.filter(p => p.trim().length > 50).length;
  const likelyImageOnly = text.trim().length < 200 && pageCount > 0;

  let confidence: ExtractionHealth["confidence"] = "low";
  if (text.length > 500 && pagesWithUsefulText > 0) {
    if (foundVin && foundServicePatterns) confidence = "high";
    else if (foundServicePatterns) confidence = "medium";
  }

  return {
    fileType: "pdf",
    pageCount,
    textLength: text.length,
    pagesWithUsefulText,
    foundVin,
    foundMileage,
    foundServicePatterns,
    likelyImageOnly,
    confidence,
  };
}

// ─── Tier 1: Local pdfjs-dist (no workers, no cost) ────────────────────────

async function runLocalPdfExtraction(
  buffer: Buffer,
  log: ReturnType<typeof makeLogger>
): Promise<{ pageTexts: string[]; pageCount: number } | null> {
  const start = Date.now();
  log("Tier 1: Local PDF Extraction", "started", start);
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pdfjs: any = await import("pdfjs-dist/legacy/build/pdf.js");
    pdfjs.GlobalWorkerOptions.workerSrc = "";

    const doc: any = await Promise.race([
      pdfjs.getDocument({ data: new Uint8Array(buffer), useWorkerFetch: false, disableFontFace: true }).promise,
      new Promise((_, rej) => setTimeout(() => rej(new Error("Local extraction timeout (5s)")), 5000)),
    ]);

    const pageTexts: string[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const str = content.items.map((item: any) => item.str).join(" ");
      pageTexts.push(str);
    }

    log("Tier 1: Local PDF Extraction", "succeeded", start, `${doc.numPages} pages, ${pageTexts.join("").length} chars`);
    return { pageTexts, pageCount: doc.numPages };
  } catch (e) {
    log("Tier 1: Local PDF Extraction", "failed", start, (e as Error).message);
    return null;
  }
}

// ─── Tier 2a: Cheap text model (high confidence) ────────────────────────────

async function runCheapTextModel(text: string, log: ReturnType<typeof makeLogger>): Promise<string | null> {
  const start = Date.now();
  log("Tier 2a: Text Model (OpenAI gpt-4o-mini)", "started", start);
  try {
    const { default: OpenAI } = await import("openai");
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const resp: any = await Promise.race([
      openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [{
          role: "user",
          content: `The following is raw text extracted from a vehicle service history document. Return it exactly as-is — do not summarize or reformat.\n\n${text}`,
        }],
        max_tokens: 4096,
      }),
      new Promise((_, rej) => setTimeout(() => rej(new Error("Text model timeout (12s)")), 12000)),
    ]);

    const out = resp.choices?.[0]?.message?.content ?? "";
    log("Tier 2a: Text Model (OpenAI gpt-4o-mini)", "succeeded", start, `${out.length} chars`);
    return out.length > 100 ? out : text; // prefer model-cleaned output but fallback to raw if tiny
  } catch (e) {
    log("Tier 2a: Text Model (OpenAI gpt-4o-mini)", "failed", start, (e as Error).message);
    return text; // still return raw text — it's good enough for medium confidence
  }
}

// ─── Tier 2b: Stronger text model (medium confidence) ───────────────────────

async function runStrongerTextModel(text: string, log: ReturnType<typeof makeLogger>): Promise<string> {
  const start = Date.now();
  log("Tier 2b: Stronger Text Model (OpenAI gpt-4o)", "started", start);
  try {
    const { default: OpenAI } = await import("openai");
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const resp: any = await Promise.race([
      openai.chat.completions.create({
        model: "gpt-4o",
        messages: [{
          role: "user",
          content: `The following is partially extracted text from a vehicle service history PDF. It may be incomplete or garbled. Extract and reconstruct every service event with: date, mileage, and description. Output raw text only.\n\n${text}`,
        }],
        max_tokens: 4096,
      }),
      new Promise((_, rej) => setTimeout(() => rej(new Error("Stronger text model timeout (20s)")), 20000)),
    ]);

    const out = resp.choices?.[0]?.message?.content ?? "";
    log("Tier 2b: Stronger Text Model (OpenAI gpt-4o)", "succeeded", start, `${out.length} chars`);
    return out || text;
  } catch (e) {
    log("Tier 2b: Stronger Text Model (OpenAI gpt-4o)", "failed", start, (e as Error).message);
    return text;
  }
}

// ─── Tier 2c: Vision parsing (low confidence / image-only PDF) ──────────────

async function runVisionModel(
  buffer: Buffer,
  mimeType: string,
  log: ReturnType<typeof makeLogger>
): Promise<string> {
  const start = Date.now();
  log("Tier 2c: Vision Model (OpenAI gpt-4o vision)", "started", start);
  try {
    const { default: OpenAI } = await import("openai");
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const base64 = buffer.toString("base64");
    const imgMime = mimeType === "application/pdf" ? "image/jpeg" : mimeType;

    // For scanned PDFs we send as base64 directly since gpt-4o accepts image/jpeg
    const resp: any = await Promise.race([
      openai.chat.completions.create({
        model: "gpt-4o",
        messages: [{
          role: "user",
          content: [
            { type: "text", text: "Extract ALL text from this vehicle service history document. Include every service event with date, mileage, and description. Return raw text only." },
            { type: "image_url", image_url: { url: `data:${imgMime};base64,${base64}`, detail: "high" } },
          ],
        }],
        max_tokens: 4096,
      }),
      new Promise((_, rej) => setTimeout(() => rej(new Error("Vision model timeout (25s)")), 25000)),
    ]);

    const out = resp.choices?.[0]?.message?.content ?? "";
    log("Tier 2c: Vision Model (OpenAI gpt-4o vision)", "succeeded", start, `${out.length} chars`);
    return out;
  } catch (e) {
    log("Tier 2c: Vision Model (OpenAI gpt-4o vision)", "failed", start, (e as Error).message);
    return "";
  }
}

// ─── Tier 3: Emergency full-file OpenAI fallback ────────────────────────────

async function runEmergencyFallback(
  buffer: Buffer,
  filename: string,
  log: ReturnType<typeof makeLogger>
): Promise<string> {
  const start = Date.now();
  log("Tier 3: Emergency Full-File Fallback (OpenAI Responses API)", "started", start);
  try {
    const { default: OpenAI } = await import("openai");
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const base64 = buffer.toString("base64");

    const response: any = await Promise.race([
      (openai.responses as any).create({
        model: "gpt-4o",
        input: [{ role: "user", content: [
          { type: "input_file", filename: filename || "vehicle-history.pdf", file_data: `data:application/pdf;base64,${base64}` },
          { type: "input_text", text: "Extract ALL text from this vehicle service history document exactly as it appears. Return only raw extracted text. Do not summarize." },
        ]}],
      }),
      new Promise((_, rej) => setTimeout(() => rej(new Error("Emergency fallback timeout (30s)")), 30000)),
    ]);

    const out = response.output_text ?? "";
    log("Tier 3: Emergency Full-File Fallback (OpenAI Responses API)", "succeeded", start, `${out.length} chars`);
    return out;
  } catch (e) {
    log("Tier 3: Emergency Full-File Fallback (OpenAI Responses API)", "failed", start, (e as Error).message);
    return "";
  }
}

// ─── Main ingestion router ───────────────────────────────────────────────────

async function ingestFile(file: File): Promise<ExtractionResult> {
  const debugLog: DebugEntry[] = [];
  const log = makeLogger(debugLog);
  const buffer = Buffer.from(await file.arrayBuffer());
  const mimeType = file.type || "";
  const ext = file.name.split(".").pop()?.toLowerCase();
  const isPdf = ext === "pdf" || mimeType === "application/pdf";
  const isImage = ["image/png", "image/jpeg", "image/webp", "image/heic", "image/heif"].includes(mimeType)
    || ["png", "jpg", "jpeg", "webp", "heic", "heif"].includes(ext ?? "");

  // ── Route: Image / Screenshot ──────────────────────────────────────────────
  if (isImage) {
    let imgBuffer = buffer;
    let imgMime = mimeType || `image/${ext}`;

    // HEIC/HEIF (iPhone) → convert to JPEG so GPT-4o vision can process it
    if (["image/heic", "image/heif"].includes(imgMime) || ["heic", "heif"].includes(ext ?? "")) {
      try {
        log("HEIC conversion", "started", Date.now(), "Converting HEIC → JPEG via sharp");
        const sharp = (await import("sharp")).default;
        imgBuffer = Buffer.from(await sharp(buffer).rotate().jpeg({ quality: 92 }).toBuffer()) as Buffer<ArrayBuffer>;
        imgMime = "image/jpeg";
        log("HEIC conversion", "succeeded", Date.now(), `${imgBuffer.length} bytes`);
      } catch (e) {
        log("HEIC conversion", "failed", Date.now(), (e as Error).message);
        // Fall through with original buffer — vision model will likely fail gracefully
      }
    }

    const text = await runVisionModel(imgBuffer, imgMime, log);
    const health: ExtractionHealth = {
      fileType: "image", pageCount: 1, textLength: text.length,
      pagesWithUsefulText: text.length > 100 ? 1 : 0,
      foundVin: /\b[A-HJ-NPR-Z0-9]{17}\b/i.test(text),
      foundMileage: /\b\d{1,3}(,\d{3})*\s*(mi|miles)\b/i.test(text),
      foundServicePatterns: /(?:oil change|brake|fluid|service|replaced|maintenance)/i.test(text),
      likelyImageOnly: true,
      confidence: text.length > 500 ? "medium" : "low",
    };
    return { text, health, debugLog };
  }

  // ── Route: PDF ─────────────────────────────────────────────────────────────
  if (isPdf) {
    // Step 1: Local extraction (always first, no token cost)
    const localResult = await runLocalPdfExtraction(buffer, log);
    const pageTexts = localResult?.pageTexts ?? [];
    const pageCount = localResult?.pageCount ?? 0;
    const rawText = pageTexts.join("\n").trim();
    const health = assessHealth(rawText, pageTexts, pageCount);

    console.log(`[ingestion] Extraction health: confidence=${health.confidence} vin=${health.foundVin} service=${health.foundServicePatterns} pages=${health.pagesWithUsefulText}/${health.pageCount} chars=${health.textLength}`);

    // Step 2: Route by confidence
    if (health.confidence === "high") {
      // pdfjs text is clean and structured — return directly, no LLM needed
      log("Tier 1: Local PDF Extraction", "succeeded", Date.now(), `Returning raw text directly (confidence=high, ${rawText.length} chars)`);
      return { text: rawText, health, debugLog };
    }

    if (health.confidence === "medium") {
      // Has service patterns, may be missing VIN — raw text is still usable
      log("Tier 1: Local PDF Extraction", "succeeded", Date.now(), `Returning raw text directly (confidence=medium, ${rawText.length} chars)`);
      return { text: rawText, health, debugLog };
    }

    // Low confidence: PDF is likely image-only or encrypted
    if (health.likelyImageOnly) {
      // Send as image to vision model
      const text = await runVisionModel(buffer, "image/jpeg", log);
      if (text.length > 200) {
        health.textLength = text.length;
        return { text, health, debugLog };
      }
    }

    // Last resort: full-file emergency fallback
    const text = await runEmergencyFallback(buffer, file.name, log);
    return { text, health, debugLog };
  }

  // ── Unsupported file type ──────────────────────────────────────────────────
  console.warn(`[ingestion] Unsupported file type: ${mimeType}`);
  return {
    text: "",
    health: { fileType: "text", pageCount: 0, textLength: 0, pagesWithUsefulText: 0, foundVin: false, foundMileage: false, foundServicePatterns: false, likelyImageOnly: false, confidence: "low" },
    debugLog,
  };
}


// ─── Shared pipeline ──────────────────────────────────────────────────────────

type SendFn = (data: object) => void;

export async function runAuditPipeline({
  text,
  source = "unknown",
  vehicleOverride,
  historyOverride,
  pricingContext = {},
  earlyVdb,
  debugParams = {},
  send = () => {},
  skipSchedule = false,  // Hunt mode: skip expensive schedule estimation
  peerContext,           // Hunt mode: sibling car context for differentiated modelInsights
}: {
  text?: string;
  source?: ServiceHistoryEvent["source"];
  vehicleOverride?: Partial<VehicleIdentity>;
  historyOverride?: ServiceHistoryEvent[];
  pricingContext?: PricingContext;
  earlyVdb?: Promise<{ schedule: any[], estimates: any }> | null;
  debugParams?: { debugLog?: any[]; extractionHealth?: ExtractionHealth | null };
  send?: SendFn;
  skipSchedule?: boolean;
  peerContext?: string | null;
}): Promise<object> {
  const pipelineStart = Date.now();
  let { vehicle, events } = text
    ? await extractFromText(text, source)
    : { vehicle: {} as VehicleIdentity, events: [] };

  // Apply manual overrides
  if (vehicleOverride) vehicle = { ...vehicle, ...vehicleOverride };
  if (historyOverride && historyOverride.length > 0) events = [...events, ...historyOverride];

  // Emit vehicle identity as soon as it's known — this is the first user-visible result
  if (vehicle.make && vehicle.model && vehicle.year) {
    send({ type: "vehicle", vehicle, pct: 38 });
  }

  // Normalize history
  const normalizedHistory = await normalizeServiceHistory(events);

  // ── Schedule fetch with fallback ──────────────────────────────────────────
  type ScheduleSource = "vehicle_databases" | "ai_estimated" | "none";
  let scheduleSource: ScheduleSource = "none";
  let schedule: import("@/lib/maintenanceDebt/types").MaintenanceScheduleItem[] = [];
  let repairEstimates: Record<string, import("@/lib/maintenanceDebt/types").ServiceCostEstimate> = {};

  const vin = vehicle.vin;

  // Use early VDB results if available and VIN matches
  if (earlyVdb) {
    const { schedule: vdbSchedule, estimates: vdbEstimates } = await earlyVdb;
    if (vdbSchedule && vdbSchedule.length > 0) {
      schedule = vdbSchedule;
      repairEstimates = vdbEstimates;
      scheduleSource = "vehicle_databases";
    }
  }

  // Otherwise, fetch normally if we have a VIN and didn't get results yet
  if (scheduleSource === "none" && vin && vin.length === 17) {
    const [vdbSchedule, vdbEstimates] = await Promise.all([
      getMaintenanceSchedule({ vin }),
      getRepairEstimateMap({ vin }).then((m) => m ?? {}),
    ]);

    if (vdbSchedule && vdbSchedule.length > 0) {
      schedule = vdbSchedule;
      repairEstimates = vdbEstimates;
      scheduleSource = "vehicle_databases";
    }
  }

  // ── Fire market value + model insights IMMEDIATELY after YMMT is known ────
  let marketValuePromise: Promise<{ low: number; high: number; confidence: "low" | "medium" | "high" } | null> = Promise.resolve(null);
  let modelInsightsPromise: Promise<ModelInsights | null> = Promise.resolve(null);

  // Extract Carfax header signals from raw text (owner count, accidents, service quality)
  const carfaxSignals: CarfaxSignals | null = (text && source === "carfax") ? extractCarfaxSignals(text) : null;
  if (carfaxSignals) console.log(`[carfaxSignals] owners=${carfaxSignals.ownerCount}, accident=${carfaxSignals.hasAccident}, quality=${carfaxSignals.serviceQuality}, CO=${carfaxSignals.isColoradoCar}`);

  if (vehicle.make && vehicle.model && vehicle.year) {
    marketValuePromise = estimateMarketValue(vehicle);
    modelInsightsPromise = generateModelInsights(vehicle, 0, 0, carfaxSignals, peerContext);
    console.log("[maintenance-audit] Fired marketValue + modelInsights in parallel with schedule pipeline");
  }

  send({ type: "progress", message: "Analyzing maintenance records...", pct: 55 });

  if (!skipSchedule && scheduleSource === "none" && (vehicle.make || vehicle.model || vehicle.year)) {
    console.log("[maintenance-audit] VDB miss → AI schedule fallback");
    const aiSchedule = await estimateScheduleFromYMMT(vehicle);
    if (aiSchedule.length > 0) {
      schedule = aiSchedule;
      scheduleSource = "ai_estimated";
    }
  } else if (skipSchedule) {
    console.log("[maintenance-audit] skipSchedule=true — skipping AI schedule estimation");
  }

  if (scheduleSource === "none") {
    console.warn("[maintenance-audit] No schedule — vehicle identity insufficient for fallback");
  }

  // Compare
  const result = compareHistoryToSchedule({
    vehicle,
    normalizedHistory,
    schedule,
    repairEstimates,
  });

  // Apply structured pricing to all debt items
  result.debtItems = await applyPricingToDebtItems(
    repairEstimates,
    result.debtItems,
    vehicle,
    pricingContext
  );

  // Re-aggregate debt totals after pricing is applied
  const { debtEstimateLow, debtEstimateHigh } = aggregateDebt(result.debtItems);
  result.debtEstimateLow = debtEstimateLow;
  result.debtEstimateHigh = debtEstimateHigh;

  // Rule: NEVER return "clean" when no schedule was available
  if (scheduleSource === "none") {
    result.verdict = "incomplete";
    result.summary = "We couldn't retrieve an OEM maintenance schedule for this vehicle. Provide a VIN or Year/Make/Model for a complete analysis.";
  }

  // Compute confidence
  const hasVin = Boolean(vin && vin.length === 17);
  const mileageConfirmed = vehicle.mileageConfidence === "confirmed";
  const highConfidenceEvents = normalizedHistory.filter(e => e.confidence === "high").length;
  const totalEvents = normalizedHistory.length;

  let confidence: "low" | "medium" | "high";
  if (scheduleSource === "vehicle_databases" && hasVin && mileageConfirmed) {
    confidence = "high";
  } else if (scheduleSource !== "none" && (hasVin || mileageConfirmed)) {
    confidence = "medium";
  } else if (totalEvents > 0 && highConfidenceEvents / totalEvents > 0.6) {
    confidence = "medium";
  } else {
    confidence = "low";
  }

  // Attach required fields from spec
  result.scheduleSource = scheduleSource;
  result.confidence = confidence;
  result.extractedHistory = events;

  // Recalibrate verdict with confidence + scheduleSource context.
  if (scheduleSource !== "none") {
    result.verdict = computeVerdict({
      debtItems: result.debtItems,
      debtEstimateLow: result.debtEstimateLow,
      debtEstimateHigh: result.debtEstimateHigh,
      confidence,
      scheduleSource,
    }) as any;
  }

  // Emit early verdict — user sees condition result before market/insights load
  send({
    type: "verdict",
    verdict: result.verdict,
    debtItems: result.debtItems,
    debtEstimateLow: result.debtEstimateLow,
    debtEstimateHigh: result.debtEstimateHigh,
    pct: 78,
  });

  // Await parallel calls — both were fired much earlier, so wait should be minimal
  const [marketValueEstimate, modelInsights] = await Promise.all([marketValuePromise, modelInsightsPromise]);
  if (marketValueEstimate) result.marketValueEstimate = marketValueEstimate;
  if (modelInsights) (result as any).modelInsights = modelInsights;
  if (carfaxSignals) (result as any).carfaxSignals = carfaxSignals;

  const payload = {
    success: true,
    result,
    meta: {
      scheduleSource,
      hasSchedule: scheduleSource !== "none",
      hasPricing: Object.keys(repairEstimates).length > 0,
      eventCount: events.length,
      normalizedCount: normalizedHistory.length,
      debug: {
        extractionLog: debugParams.debugLog || [],
        extractionHealth: debugParams.extractionHealth || null,
        pipelineDurationMs: Date.now() - pipelineStart,
      },
    },
  };

  return payload;
}

// ─── Route handler ────────────────────────────────────────────────────────────

export async function POST(req: Request) {
  const contentType = req.headers.get("content-type") || "";

  // ── File upload path: streaming SSE ────────────────────────────────────────
  if (contentType.includes("multipart/form-data")) {
    let file: File | null = null;
    let vehicleOverride: Partial<VehicleIdentity> | undefined;
    try {
      const formData = await req.formData();
      file = formData.get("file") as File | null;
      const overrideStr = formData.get("vehicleOverride") as string | null;
      if (overrideStr) vehicleOverride = JSON.parse(overrideStr);
    } catch {
      return NextResponse.json({ success: false, error: "Failed to parse upload." }, { status: 400 });
    }

    if (!file) return NextResponse.json({ success: false, error: "No file uploaded." }, { status: 400 });
    if (file.size > 20 * 1024 * 1024) return NextResponse.json({ success: false, error: "File too large (max 20 MB)." }, { status: 400 });

    // ── Early VIN detection (CARFAX often encodes VIN in filename) ──
    const filenameVin = file.name.match(/\b([A-HJ-NPR-Z0-9]{17})\b/i)?.[1]?.toUpperCase() ?? null;
    const filenameYear = (() => {
      const m = file.name.match(/\b(19|20)\d{2}\b/);
      return m ? parseInt(m[0], 10) : null;
    })();
    const filenameMake = (() => {
      const makes = ["toyota","honda","ford","chevrolet","gmc","dodge","jeep","bmw","mercedes","audi","volkswagen","hyundai","kia","nissan","subaru","mazda","lexus","acura","infiniti","cadillac","buick","lincoln","volvo","ram","chrysler","mitsubishi","porsche"];
      const lower = file.name.toLowerCase();
      return makes.find(m => lower.includes(m)) ?? null;
    })();

    // Start fetching VDB data in parallel with PDF parsing if we have a VIN
    let earlyVdbPromise: Promise<{ schedule: any[], estimates: any }> | null = null;
    if (filenameVin) {
      console.log("[maintenance-audit] Starting early VDB fetch for VIN:", filenameVin);
      earlyVdbPromise = (Promise.all([
        getMaintenanceSchedule({ vin: filenameVin }),
        getRepairEstimateMap({ vin: filenameVin }).then((m) => m ?? {}),
      ]).then(([schedule, estimates]) => ({ schedule: schedule ?? [], estimates }))) as Promise<{ schedule: any[]; estimates: any }>;
    }

    const filenameOverride: Partial<VehicleIdentity> = {};
    if (filenameVin)  filenameOverride.vin = filenameVin;
    if (filenameYear) filenameOverride.year = filenameYear;
    if (filenameMake) filenameOverride.make = filenameMake.charAt(0).toUpperCase() + filenameMake.slice(1);

    const mergedVehicleOverride = Object.keys(filenameOverride).length > 0
      ? { ...filenameOverride, ...vehicleOverride }
      : vehicleOverride;

    const source = file.name.toLowerCase().includes("carfax") ? "carfax"
      : file.name.toLowerCase().includes("autocheck") ? "autocheck"
      : "receipt";

    // ── Stream response back to client ────────────────────────────────────────
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const send: SendFn = (data) => {
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
          } catch { /* stream may be closed */ }
        };

        try {
          send({ type: "progress", message: "Reading document...", pct: 8 });

          let ingestResult;
          try {
            ingestResult = await ingestFile(file!);
          } catch (e) {
            console.error("[ingestion] Fatal error:", e);
            send({ type: "error", success: false, error: "Failed to read file." });
            return;
          }

          const { text: extractedText, health: extractionHealth, debugLog } = ingestResult;
          send({ type: "progress", message: "Extracting service records...", pct: 22 });

          const payload = await runAuditPipeline({
            text: extractedText,
            source,
            vehicleOverride: mergedVehicleOverride,
            earlyVdb: earlyVdbPromise,
            debugParams: { debugLog, extractionHealth },
            send,
          });

          send({ type: "complete", ...payload, pct: 100 });

        } catch (err) {
          console.error("[maintenance-audit] stream error:", err);
          send({ type: "error", success: false, error: "Audit failed. Please try again." });
        } finally {
          try { controller.close(); } catch { /* already closed */ }
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  }

  // ── JSON path (pasted text or manual entry) — synchronous ──────────────────
  try {
    const body = await req.json();
    const {
      text,
      source = "unknown",
      vehicleOverride,
      historyOverride,
      pricingContext,
    }: {
      text?: string;
      source?: ServiceHistoryEvent["source"];
      vehicleOverride?: Partial<VehicleIdentity>;
      historyOverride?: ServiceHistoryEvent[];
      pricingContext?: PricingContext;
    } = body;

    const payload = await runAuditPipeline({ text, source, vehicleOverride, historyOverride, pricingContext, debugParams: { debugLog: [], extractionHealth: null } });
    return NextResponse.json(payload);
  } catch (error) {
    console.error("[maintenance-audit] error:", error);
    return NextResponse.json({ success: false, error: "Audit failed. Please try again." }, { status: 500 });
  }
}
