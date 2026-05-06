// app/api/fix-or-sell/route.ts
// Streaming SSE endpoint for the Fix or Sell decision engine.
//
// Pipeline:
//   1. Parse repair quote (text/file) → extract items + vehicle info
//   2. If vehicle info missing → return needsVehicle prompt
//   3. In parallel: estimate value + model intelligence + fair prices
//   4. Run Fix/Sell engine → stream verdict

export const maxDuration = 60;

import { NextRequest, NextResponse } from "next/server";
import { parseRepairQuote, enrichWithFairPrices } from "@/lib/fixOrSell/parseRepairQuote";
import { estimateVehicleValue } from "@/lib/fixOrSell/vehicleValue";
import { computeFixOrSell, type OwnershipHorizon } from "@/lib/fixOrSell/engine";
import { computeSellEstimates } from "@/lib/fixOrSell/sellEstimates";
import { classifyVehicle, assessValuationConfidence } from "@/lib/fixOrSell/vehicleArchetypes";
import OpenAI from "openai";

// ── Model Intelligence (lightweight version for fix-or-sell) ─────────────────

async function getModelIntelligence(vehicle: {
  year: number; make: string; model: string; trim?: string; mileage: number;
}): Promise<{
  reliabilityTier: 'excellent' | 'good' | 'below_average' | 'poor';
  tco: { year1Low: number; year1High: number } | null;
  majorExposures: { name: string; costLow: number; costHigh: number; urgency: 'near_term' | 'watch' | 'long_term' }[];
  ownershipOutlook: string;
} | null> {
  const desc = [vehicle.year, vehicle.make, vehicle.model, vehicle.trim].filter(Boolean).join(" ");

  try {
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 15000);

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{
        role: "user",
        content: `You are evaluating a ${desc} with ${vehicle.mileage.toLocaleString()} miles for a Fix or Sell decision.

Respond ONLY with JSON:
{
  "reliabilityTier": "excellent" | "good" | "below_average" | "poor",
  "tco": {"year1Low": <number>, "year1High": <number>},
  "majorExposures": [
    {"name": "<component>", "costLow": <number>, "costHigh": <number>, "urgency": "near_term" | "watch" | "long_term"}
  ],
  "ownershipOutlook": "<one sentence: what to expect owning this car for the next 12-24 months at this mileage>"
}

Rules:
- tco = expected maintenance + repair costs for year 1 (NOT the repair quote — general ownership costs)
- majorExposures: 1-3 items most likely to need attention at ${vehicle.mileage.toLocaleString()} miles
- near_term = within 15k miles. watch = 15-40k. long_term = beyond 40k
- Be specific to this exact mileage point`,
      }],
      max_tokens: 600,
      temperature: 0.3,
      response_format: { type: "json_object" },
    }, { signal: abort.signal });

    clearTimeout(timer);
    const raw = JSON.parse(completion.choices[0].message.content ?? "{}");

    return {
      reliabilityTier: raw.reliabilityTier || 'good',
      tco: raw.tco || null,
      majorExposures: (raw.majorExposures || []).slice(0, 3),
      ownershipOutlook: raw.ownershipOutlook || "",
    };
  } catch {
    return null;
  }
}

// ── File extraction (reuse from audit pipeline) ──────────────────────────────

async function extractTextFromFile(file: File): Promise<string> {
  const buffer = Buffer.from(await file.arrayBuffer());
  const mimeType = file.type || "";
  const ext = file.name.split(".").pop()?.toLowerCase();
  const isImage = ["image/png", "image/jpeg", "image/webp", "image/heic", "image/heif"].includes(mimeType)
    || ["png", "jpg", "jpeg", "webp", "heic", "heif"].includes(ext ?? "");
  const isPdf = ext === "pdf" || mimeType === "application/pdf";

  if (isImage || isPdf) {
    // Use GPT-4o vision for images and scanned PDFs
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    let imgBuffer = buffer;
    let imgMime = mimeType || `image/${ext}`;

    // HEIC conversion
    if (["image/heic", "image/heif"].includes(imgMime) || ["heic", "heif"].includes(ext ?? "")) {
      try {
        const sharp = (await import("sharp")).default;
        imgBuffer = Buffer.from(await sharp(buffer).rotate().jpeg({ quality: 92 }).toBuffer()) as Buffer<ArrayBuffer>;
        imgMime = "image/jpeg";
      } catch { /* fall through */ }
    }

    // For PDFs, try local text extraction first
    if (isPdf) {
      try {
        const pdfjs: any = await import("pdfjs-dist/legacy/build/pdf.js");
        pdfjs.GlobalWorkerOptions.workerSrc = "";
        const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer), useWorkerFetch: false, disableFontFace: true }).promise;
        const pages: string[] = [];
        for (let i = 1; i <= doc.numPages; i++) {
          const page = await doc.getPage(i);
          const content = await page.getTextContent();
          pages.push(content.items.map((item: any) => item.str).join(" "));
        }
        const text = pages.join("\n").trim();
        if (text.length > 200 && /\$\s*[\d,]+/.test(text)) {
          console.log(`[fix-or-sell] PDF text extraction: ${text.length} chars`);
          return text;
        }
      } catch { /* fall through to vision */ }
    }

    // Vision fallback
    const base64 = imgBuffer.toString("base64");
    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "Extract ALL text from this vehicle repair estimate / invoice. Include every line item with its price. Return raw text only — do not summarize." },
          { type: "image_url", image_url: { url: `data:${isPdf ? 'image/jpeg' : imgMime};base64,${base64}`, detail: "high" } },
        ],
      }],
      max_tokens: 4000,
    });

    return completion.choices[0]?.message?.content ?? "";
  }

  return "";
}

// ── POST handler ─────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  try {
    const contentType = req.headers.get("content-type") || "";
    let rawText = "";
    let vehicleOverride: { year?: number; make?: string; model?: string; trim?: string; mileage?: number } | undefined;
    let ownershipHorizon: OwnershipHorizon | undefined;

    if (contentType.includes("multipart/form-data")) {
      // File upload
      const formData = await req.formData();
      const file = formData.get("file") as File | null;
      const manualText = formData.get("text") as string | null;

      if (file) {
        rawText = await extractTextFromFile(file);
      } else if (manualText) {
        rawText = manualText;
      }

      // Check for vehicle override fields
      const year = formData.get("year");
      const make = formData.get("make");
      const model = formData.get("model");
      const mileage = formData.get("mileage");
      const horizon = formData.get("horizon") as string | null;

      if (year || make || model) {
        vehicleOverride = {
          year: year ? parseInt(year as string) : undefined,
          make: make as string || undefined,
          model: model as string || undefined,
          mileage: mileage ? parseInt(mileage as string) : undefined,
        };
      }
      if (horizon) ownershipHorizon = horizon as OwnershipHorizon;

    } else {
      // JSON body
      const body = await req.json();
      rawText = body.text || "";
      vehicleOverride = body.vehicle;
      ownershipHorizon = body.horizon;
    }

    if (!rawText || rawText.length < 10) {
      return NextResponse.json({ error: "No repair quote text provided." }, { status: 400 });
    }

    // ── Step 1: Parse the repair quote ──────────────────────────────────────
    console.log(`[fix-or-sell] Parsing repair quote (${rawText.length} chars)...`);
    const quote = await parseRepairQuote(rawText);

    if (quote.items.length === 0) {
      return NextResponse.json({
        error: "Couldn't find repair items in the text. Try including specific services and prices.",
      }, { status: 400 });
    }

    // ── Step 2: Resolve vehicle info ────────────────────────────────────────
    const vehicle = {
      year: vehicleOverride?.year || quote.vehicleFromQuote?.year,
      make: vehicleOverride?.make || quote.vehicleFromQuote?.make,
      model: vehicleOverride?.model || quote.vehicleFromQuote?.model,
      trim: vehicleOverride?.trim || quote.vehicleFromQuote?.trim,
      mileage: vehicleOverride?.mileage || quote.vehicleFromQuote?.mileage,
      vin: quote.vehicleFromQuote?.vin,
    };

    if (!vehicle.year || !vehicle.make || !vehicle.model || !vehicle.mileage) {
      // Return partial result — need vehicle info from user
      return NextResponse.json({
        needsVehicle: true,
        quote: {
          shopName: quote.shopName,
          items: quote.items,
          totalCost: quote.totalCost,
          vehicleFromQuote: quote.vehicleFromQuote,
        },
      });
    }

    // ── Step 3: Run enrichment in parallel ──────────────────────────────────
    console.log(`[fix-or-sell] Vehicle: ${vehicle.year} ${vehicle.make} ${vehicle.model} @ ${vehicle.mileage}mi`);
    const vehicleDesc = [vehicle.year, vehicle.make, vehicle.model, vehicle.trim].filter(Boolean).join(" ");

    const [valueEstimate, modelIntel, enrichedItems] = await Promise.all([
      estimateVehicleValue({
        year: vehicle.year!,
        make: vehicle.make!,
        model: vehicle.model!,
        trim: vehicle.trim,
        mileage: vehicle.mileage!,
        vin: vehicle.vin,
      }),
      getModelIntelligence({
        year: vehicle.year!,
        make: vehicle.make!,
        model: vehicle.model!,
        trim: vehicle.trim,
        mileage: vehicle.mileage!,
      }),
      enrichWithFairPrices(quote.items, vehicleDesc),
    ]);

    if (!valueEstimate) {
      return NextResponse.json({
        error: "Couldn't estimate your vehicle's value. Please try again or enter it manually.",
      }, { status: 400 });
    }

    // ── Step 4: Classify vehicle archetype ──────────────────────────────────
    const dealerRetailValue = Math.round(valueEstimate.value / 0.83 / 100) * 100;
    const archetypeResult = classifyVehicle(vehicle.make, vehicle.model, vehicle.year, vehicleDesc);
    const valConfidence = assessValuationConfidence(
      archetypeResult.archetype,
      valueEstimate.compCount || 0,
      valueEstimate.source,
      false, // TODO: condition input not yet wired
    );

    // ── Step 5: Run the decision engine ─────────────────────────────────────
    const verdict = computeFixOrSell({
      repairCost: quote.totalCost,
      vehicleValue: valueEstimate.value,
      dealerRetailValue,
      vehicleValueSource: valueEstimate.source === 'marketcheck_listings' ? 'marketcheck' : valueEstimate.source,
      reliabilityTier: modelIntel?.reliabilityTier ?? null,
      tco: modelIntel?.tco ?? null,
      majorExposures: modelIntel?.majorExposures ?? [],
      repairItems: enrichedItems,
      ownershipHorizon,
      vehicleMileage: vehicle.mileage,
      vehicleYear: vehicle.year,
      vehicleMake: vehicle.make,
      vehicleModel: vehicle.model,
      vehicleDesc,
      archetype: archetypeResult,
    });

    // ── Step 6: Sell estimates ──────────────────────────────────────────────
    const sellEstimates = computeSellEstimates(dealerRetailValue, archetypeResult);

    // ── Step 7: Fetch real market comps for display ─────────────────────────
    let comps: { heading: string; price: number; miles: number; city: string; state: string; url: string }[] = [];
    try {
      const apiKey = process.env.MARKETCHECK_API_KEY;
      if (apiKey && vehicle.year && vehicle.make && vehicle.model) {
        const params = new URLSearchParams({
          api_key: apiKey,
          year: String(vehicle.year),
          make: vehicle.make,
          model: vehicle.model,
          rows: '6',
        });
        const compRes = await fetch(`https://api.marketcheck.com/v2/search/car/active?${params}`, {
          signal: AbortSignal.timeout(8000),
        });
        if (compRes.ok) {
          const compData = await compRes.json();
          comps = (compData.listings || [])
            .filter((l: any) => l.price && l.price > 0)
            .map((l: any) => ({
              heading: l.heading || `${l.build?.year || ''} ${l.build?.make || ''} ${l.build?.model || ''}`.trim(),
              price: l.price,
              miles: l.miles || 0,
              city: l.dealer?.city || '',
              state: l.dealer?.state || '',
              url: l.vdp_url || '',
            }))
            .slice(0, 5);
        }
      }
    } catch {
      // Non-critical — comps are nice-to-have
    }

    console.log(`[fix-or-sell] Verdict: ${verdict.decision} (${verdict.confidence}) | archetype=${archetypeResult.archetype} | ratio=${verdict.repairRatio}% | repair=$${quote.totalCost.toLocaleString()} / value=$${valueEstimate.value.toLocaleString()} | comps=${comps.length}`);

    // ── Return complete result ──────────────────────────────────────────────
    return NextResponse.json({
      verdict,
      quote: {
        shopName: quote.shopName,
        items: enrichedItems,
        totalCost: quote.totalCost,
      },
      vehicle: {
        ...vehicle,
        desc: vehicleDesc,
      },
      valueEstimate: {
        value: valueEstimate.value,
        rangeLow: valueEstimate.rangeLow,
        rangeHigh: valueEstimate.rangeHigh,
        source: valueEstimate.source,
        confidence: valueEstimate.confidence,
        compCount: valueEstimate.compCount,
        methodology: valueEstimate.methodology,
      },
      comps,
      sellEstimates,
      archetypeInfo: {
        archetype: archetypeResult.archetype,
        label: archetypeResult.label,
        emoji: archetypeResult.emoji,
        description: archetypeResult.description,
      },
      valuationConfidence: valConfidence,
      modelIntel: modelIntel ? {
        reliabilityTier: modelIntel.reliabilityTier,
        ownershipOutlook: modelIntel.ownershipOutlook,
        majorExposures: modelIntel.majorExposures,
      } : null,
    });

  } catch (err) {
    console.error("[fix-or-sell] Error:", err);
    return NextResponse.json(
      { error: "Something went wrong processing your repair quote." },
      { status: 500 }
    );
  }
}
