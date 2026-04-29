import OpenAI from "openai";
import type { ComparisonResult, ComparedCar } from "./types";
import type { PhotoConditionReport } from "./analyzePhotos";
import { gradeToScore } from "./analyzePhotos";

// ─── Salt-belt states (high rust / road-salt risk) ─────────────────────────
const SALT_BELT_STATES = new Set([
  "ME","NH","VT","MA","RI","CT","NY","NJ","PA","DE","MD","DC",
  "OH","IN","MI","WI","MN","IA","IL","MO","ND","SD","NE","KS","KY","WV","VA",
]);
const RUST_BELT_DISCOUNT = 2500; // flat conservative discount vs. dry-state comparable

function detectSaltBelt(location: string | null | undefined): boolean {
  if (!location) return false;
  const loc = location.toUpperCase();
  for (const state of SALT_BELT_STATES) {
    // Match ", IL" or " IL" or "Illinois" etc.
    if (
      loc.includes(`, ${state}`) ||
      loc.includes(` ${state}`) ||
      loc.endsWith(state)
    ) return true;
  }
  // Match on well-known cities
  const saltBeltCities = ["CHICAGO","DETROIT","CLEVELAND","COLUMBUS","MINNEAPOLIS",
    "BOSTON","NEW YORK","PHILADELPHIA","PITTSBURGH","CINCINNATI","MILWAUKEE",
    "INDIANAPOLIS","KANSAS CITY","ST. LOUIS","OMAHA","BUFFALO","ALBANY","HARTFORD",
    "WORCESTER","PROVIDENCE","BALTIMORE","WASHINGTON"];
  return saltBeltCities.some(c => loc.includes(c));
}

// ─── Mileage-adjusted price verdict ───────────────────────────────────────
// Uses a simple linear depreciation from market mid.
// Market mid is typically calibrated for ~70k miles (BaT "driver quality").
// We adjust ±$0.08/mile from that baseline.
const MILEAGE_BASELINE = 70_000;
const DEPRECIATION_PER_MILE = 0.08;

function mileageAdjustedMid(
  marketMid: number,
  currentMileage: number | null,
  isSaltBelt: boolean,
): number {
  if (!currentMileage || marketMid === 0) return marketMid;
  const mileageDelta = currentMileage - MILEAGE_BASELINE;
  const adjustment   = mileageDelta * DEPRECIATION_PER_MILE;
  const saltAdj      = isSaltBelt ? RUST_BELT_DISCOUNT : 0;
  return Math.round(marketMid - adjustment - saltAdj);
}

function priceVerdict(
  asking: number | null,
  adjustedMid: number,
  isSaltBelt: boolean,
): { label: string; dollars: number; direction: "above" | "below" | "at" } {
  if (!asking || adjustedMid === 0) {
    return { label: "At market", dollars: 0, direction: "at" };
  }
  const gap    = asking - adjustedMid;
  const gapAbs = Math.abs(gap);
  const saltNote = isSaltBelt ? " (salt-belt adjusted)" : "";

  if (gapAbs < 1_000) {
    return { label: `At fair value${saltNote}`, dollars: 0, direction: "at" };
  }
  const kStr = gapAbs >= 1_000 ? `$${(gapAbs / 1_000).toFixed(1)}k` : `$${gapAbs}`;
  if (gap > 0) {
    return { label: `${kStr} above fair value${saltNote}`, dollars: gap, direction: "above" };
  }
  return { label: `${kStr} below fair value${saltNote}`, dollars: gap, direction: "below" };
}

/**
 * Takes N completed audit results + optional photo reports and produces a
 * structured comparison. One AI call, full JSON output.
 */
export async function synthesizeComparison(
  auditResults: any[],
  photoReports: (PhotoConditionReport | null)[],
  listingUrls: (string | null)[],
  listingNotes: string[],
  photoCounts: number[],
  scrapedLocations?: (string | null)[],
): Promise<Omit<ComparisonResult, "sessionId" | "createdAt" | "auditSummaries">> {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  // ── Detect same-car mode ──────────────────────────────────────────────────
  const modelKeys = auditResults.map((r: any) => {
    const v = r.vehicle ?? {};
    return `${v.year ?? ""}_${(v.make ?? "").toLowerCase()}_${(v.model ?? "").toLowerCase()}`;
  });
  const uniqueModels  = new Set(modelKeys.filter(k => k !== "__"));
  const isSameCar     = uniqueModels.size === 1 && auditResults.length >= 2;

  // ── Build per-car enriched context ────────────────────────────────────────
  const carContexts = auditResults.map((r: any, idx: number) => {
    const v         = r.vehicle ?? {};
    const mi        = r.modelInsights ?? {};
    const mv        = r.marketValueEstimate ?? {};
    const overdue   = (r.debtItems ?? []).filter((i: any) => i.status === "overdue" || i.status === "due_now");
    const debtTotal = overdue.reduce((s: number, i: any) => s + Math.round(((i.estimatedCostLow || 0) + (i.estimatedCostHigh || 0)) / 2), 0);
    const name      = [v.year, v.make, v.model, v.trim].filter(Boolean).join(" ");
    const marketMid = mv.low && mv.high ? Math.round((mv.low + mv.high) / 2) : 0;
    const asking    = r.askingPrice ?? null;

    // Location: prefer scraped location from Firecrawl over carfax signal
    const rawLocation = scrapedLocations?.[idx] ?? r.carfaxSignals?.lastState ?? null;
    const isSaltBelt  = detectSaltBelt(rawLocation);

    // Mileage-adjusted price verdict
    const adjMid      = mileageAdjustedMid(marketMid, v.currentMileage ?? null, isSaltBelt);
    const verdict     = priceVerdict(asking, adjMid, isSaltBelt);
    const gap         = asking && adjMid ? asking - adjMid : 0;

    const photo = photoReports[idx];

    // Year features from modelInsights
    const yearFeatures: string[] = mi.yearFeatures ?? [];
    const trimNotes: string | null = mi.trimNotes ?? null;

    return {
      index: idx + 1,
      name,
      vin: v.vin,
      mileage: v.currentMileage,
      asking,
      marketLow: mv.low ?? null,
      marketHigh: mv.high ?? null,
      marketMid,
      adjustedMid: adjMid,
      priceGapDollars: gap,
      priceVerdict: verdict,
      isSaltBelt,
      location: rawLocation ?? (listingUrls[idx] ? "see listing" : "unknown"),
      overdueCount: overdue.length,
      debtTotal,
      tco: mi.tco ?? null,
      avgAnnualCost: mi.avgAnnualCost ?? null,
      reliabilityTier: mi.reliabilityTier ?? null,
      majorExposures: (mi.majorExposures ?? []).slice(0, 2).map((e: any) => `${e.name} ($${e.costLow?.toLocaleString()}–$${e.costHigh?.toLocaleString()})`),
      expertTake: mi.expertTake ?? null,
      originalMsrp: mi.originalMsrp ?? null,
      ownerHistory: r.carfaxSignals
        ? `${r.carfaxSignals.ownerCount ?? "unknown"} owners, ${r.carfaxSignals.hasAccident ? `${r.carfaxSignals.accidentCount ?? 1} accident(s)` : "no accidents"}, service quality: ${r.carfaxSignals.serviceQuality ?? "unknown"}`
        : "history unknown",
      photoGrade: photo?.grade ?? null,
      photoSummary: photo ? `Grade ${photo.grade}: ${photo.gradeLabel}. Red flags: ${photo.redFlags.length > 0 ? photo.redFlags.join("; ") : "none"}.` : "No photos provided",
      listingUrl: listingUrls[idx] ?? null,
      listingNotes: listingNotes[idx] ?? null,
      yearFeatures,
      trimNotes,
    };
  });

  // ── Cross-car feature diff: find features that differ between model years ──
  // e.g. "2019 has power tailgate, 2016 does not"
  const allYearFeatures = carContexts.map(c => ({ name: c.name, features: c.yearFeatures }));
  const featureDiffContext = allYearFeatures.some(c => c.features.length > 0)
    ? `\nMODEL YEAR FEATURE DIFFERENCES (use this when explaining ranking):\n${allYearFeatures.map(c => c.features.length > 0 ? `${c.name}: ${c.features.join(" | ")}` : `${c.name}: no year-specific differences noted`).join("\n")}`
    : "";

  // ── Location context ─────────────────────────────────────────────────────
  const locationContext = carContexts.some(c => c.isSaltBelt)
    ? `\nSALT BELT NOTE: ${carContexts.filter(c => c.isSaltBelt).map(c => `Car ${c.index} (${c.location})`).join(", ")} are in salt-belt states. This increases rust risk and reduces fair value by ~$${RUST_BELT_DISCOUNT.toLocaleString()} vs. equivalent dry-state cars. Call this out explicitly in bottomLine.`
    : "";

  // ── isSameCar context ────────────────────────────────────────────────────
  const sameCarContext = isSameCar
    ? `\nIMPORTANT: All these vehicles are the same make/model/year. Do NOT compare reliability or model-level traits. Focus ONLY on: owner history, price vs adjusted fair value, mileage, location (salt belt = deduction), photo condition, seller type. The winner is the best SPECIFIC EXAMPLE, not the best model.\n`
    : "";

  // ── Final prompt ──────────────────────────────────────────────────────────
  const prompt = `You are an expert used car advisor helping a buyer choose between ${carContexts.length} vehicles.
${sameCarContext}${locationContext}${featureDiffContext}

Here are the details for each car:

${carContexts.map(c => `
CAR ${c.index}: ${c.name}
- Mileage: ${c.mileage?.toLocaleString() ?? "unknown"} mi
- Asking: ${c.asking ? `$${c.asking.toLocaleString()}` : "not provided"}
- Fair Value (mileage + location adjusted): ${c.adjustedMid ? `$${c.adjustedMid.toLocaleString()}` : "unknown"}
- Price vs Fair Value: ${c.priceVerdict.label}${c.isSaltBelt ? " ⚠ salt-belt car" : ""}
- Verdict: ${c.overdueCount > 0 ? `${c.overdueCount} overdue items (~$${c.debtTotal.toLocaleString()})` : "maintenance current"}
- Owner History: ${c.ownerHistory}
- Location: ${c.location}${c.isSaltBelt ? " (SALT BELT — rust risk)" : ""}
- Reliability: ${c.reliabilityTier ?? "unknown"}
- TCO: ${c.tco ? `Year 1: $${c.tco.year1Low?.toLocaleString()}–$${c.tco.year1High?.toLocaleString()}, 3-Year: $${c.tco.year3Low?.toLocaleString()}–$${c.tco.year3High?.toLocaleString()}` : "unknown"}
- Major Risks: ${c.majorExposures.length > 0 ? c.majorExposures.join("; ") : "none identified"}
- Photo Condition: ${c.photoSummary}
${c.yearFeatures.length > 0 ? `- Year-Specific Features: ${c.yearFeatures.join("; ")}` : ""}
${c.trimNotes ? `- Trim Notes: ${c.trimNotes}` : ""}
- Listing Notes: ${c.listingNotes || "none"}
`).join("\n")}

RULES:
- Be specific: use exact dollar amounts, real observations, not generic statements
- Name specific year features when ranking (e.g. "2018 gets power tailgate that 2016 lacks")  
- Call out salt-belt cars explicitly in the bottomLine — it's a real buyer risk
- Rank by: adjusted price position + owner history + mileage + location + maintenance debt
- downtimeEvents: use ranges like "0–1/yr" NEVER specific day counts
- optimalSellMileage: estimate when major maintenance clusters for this model/year

Respond ONLY with this JSON (no markdown):
{
  "headline": "<The real tradeoff: one punchy sentence naming the specific cars/years>",
  "winner": "<exact vehicle name or distinguishing label + location>",
  "winnerReason": "<one specific sentence: exact dollar position + key advantage>",
  "tcoComparison": "<dollar-specific comparison. If salt belt cars involved, note the rust discount.>",
  "bottomLine": "<2-3 decisive sentences. Name SPECIFIC cars. Include salt-belt warnings. Reference year features if relevant.>",
  "crossCarFeatureDiff": "<If comparing different model years of same model: one sentence summarizing what newer years have that older ones don't. null if all same year.>",
  "cars": [
    {
      "vehicleName": "<exact name from list>",
      "rank": <1=best>,
      "rankReason": "<one sentence, specific — name dollar amount or named feature>",
      "frictionTier": "<low|medium|high>",
      "frictionNote": "<one concrete line about ownership feel>",
      "downtimeEvents": "<e.g. '0–1 unplanned/yr'>",
      "riskLevel": "<low|medium|high>",
      "majorRisk": "<Most important risk with cost — or null if none>",
      "optimalSellMileage": <number or null>,
      "optimalSellNote": "<one sentence on when to sell and why — or null>"
    }
  ]
}`;

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 30000);

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 1600,
      temperature: 0.2,
      response_format: { type: "json_object" },
    }, { signal: abort.signal });
    clearTimeout(timer);

    const raw = JSON.parse(completion.choices[0].message.content ?? "{}");

    // ── Merge audit data with AI synthesis into ComparedCar objects ──────────
    const cars: ComparedCar[] = auditResults.map((r: any, idx: number) => {
      const v         = r.vehicle ?? {};
      const mi        = r.modelInsights ?? {};
      const mv        = r.marketValueEstimate ?? {};
      const overdue   = (r.debtItems ?? []).filter((i: any) => i.status === "overdue" || i.status === "due_now");
      const debtTotal = overdue.reduce((s: number, i: any) => s + Math.round(((i.estimatedCostLow||0)+(i.estimatedCostHigh||0))/2), 0);
      const name      = [v.year, v.make, v.model, v.trim].filter(Boolean).join(" ");
      const marketMid = mv.low && mv.high ? Math.round((mv.low + mv.high) / 2) : 0;
      const asking    = r.askingPrice ?? null;

      const rawLocation = scrapedLocations?.[idx] ?? r.carfaxSignals?.lastState ?? null;
      const isSaltBelt  = detectSaltBelt(rawLocation);
      const adjMid      = mileageAdjustedMid(marketMid, v.currentMileage ?? null, isSaltBelt);
      const verdict     = priceVerdict(asking, adjMid, isSaltBelt);
      const gap         = asking && adjMid ? asking - adjMid : 0;

      // Match AI car by name OR by index position
      const aiCar = (raw.cars ?? []).find((c: any) => c.vehicleName === name)
        ?? (raw.cars ?? [])[idx]
        ?? {};

      const photo = photoReports[idx];

      return {
        vehicleName: name,
        vin: v.vin ?? null,
        mileage: v.currentMileage ?? null,
        fileIndex: idx,
        rank: aiCar.rank ?? idx + 1,
        rankReason: aiCar.rankReason ?? "",
        askingPrice: asking,
        marketLow: mv.low ?? 0,
        marketHigh: mv.high ?? 0,
        marketMid: adjMid || marketMid,     // use adjusted mid as the reference
        priceGapDollars: gap,
        priceGapLabel: verdict.label,       // specific e.g. "$4.2k above fair value (salt-belt adjusted)"
        tcoYear1Low:  mi.tco?.year1Low ?? 0,
        tcoYear1High: mi.tco?.year1High ?? 0,
        tcoYear3Low:  mi.tco?.year3Low ?? 0,
        tcoYear3High: mi.tco?.year3High ?? 0,
        avgAnnualCost: mi.avgAnnualCost ?? null,
        frictionTier: aiCar.frictionTier ?? "medium",
        frictionNote: aiCar.frictionNote ?? "",
        downtimeEvents: aiCar.downtimeEvents ?? "1–2/yr",
        reliabilityTier: mi.reliabilityTier ?? null,
        majorRisk: aiCar.majorRisk ?? (mi.majorExposures?.[0] ? `${mi.majorExposures[0].name} ($${mi.majorExposures[0].costLow?.toLocaleString()}–$${mi.majorExposures[0].costHigh?.toLocaleString()})` : null),
        riskLevel: aiCar.riskLevel ?? "medium",
        optimalSellMileage: aiCar.optimalSellMileage ?? null,
        optimalSellNote: aiCar.optimalSellNote ?? null,
        photoConditionReport: photo ?? null,
        photoCount: photoCounts[idx] ?? 0,
        verdict: r.verdict ?? "unknown",
        maintenanceDebt: debtTotal,
        overdueCount: overdue.length,
        listingUrl: listingUrls[idx] ?? null,
        listingNotes: listingNotes[idx] || null,
        location: rawLocation,
        isSaltBelt,
      };
    }).sort((a: ComparedCar, b: ComparedCar) => a.rank - b.rank);

    // ── Same-car mode: re-rank deterministically ───────────────────────────
    if (isSameCar) {
      const scored = cars.map(car => {
        let score = 0;
        const cf = auditResults[car.fileIndex]?.carfaxSignals;
        if (cf?.hasAccident === false)           score += 3;
        if ((cf?.ownerCount ?? 2) === 1)         score += 2;
        if (car.priceGapDollars < -500)          score += 2;
        else if (Math.abs(car.priceGapDollars) <= 500) score += 1;
        if ((car as any).isSaltBelt)             score -= 2;  // salt-belt penalty
        if (car.photoConditionReport) score += Math.max(0, gradeToScore(car.photoConditionReport.grade) - 2);
        if (car.maintenanceDebt < 200)           score += 1;
        else if (car.maintenanceDebt > 1000)     score -= 1;
        // Penalty: unknown mileage means we can't validate the car's core value
        if (!car.mileage)                        score -= 3;
        return { ...car, sameCarScore: score };
      });
      scored.sort((a, b) => (b as any).sameCarScore - (a as any).sameCarScore);
      scored.forEach((car, i) => {
        car.rank = i + 1;
        // Flag cars with missing data so the UI can warn the buyer
        if (!car.mileage && car.rank === 1) {
          car.rankReason = (car.rankReason ? car.rankReason + " " : "") + "⚠ Mileage unverified — confirm before buying.";
        }
      });
      cars.splice(0, cars.length, ...scored);
    }

    return {
      headline:        raw.headline ?? "Here's the real tradeoff:",
      winner:          cars[0]?.vehicleName ?? raw.winner ?? "",
      winnerReason:    raw.winnerReason ?? "",
      tcoComparison:   raw.tcoComparison ?? "",
      bottomLine:      raw.bottomLine ?? "",
      isSameCar,
      crossCarFeatureDiff: raw.crossCarFeatureDiff ?? null,
      cars,
    };
  } catch (err) {
    clearTimeout(timer);
    console.error("[synthesize] failed:", err instanceof Error ? err.message : err);
    throw err;
  }
}
