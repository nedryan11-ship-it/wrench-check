// lib/fixOrSell/engine.ts
// Fix or Sell Decision Engine — pure logic, no API calls.
//
// Takes: repair cost, vehicle value, reliability profile, model intelligence
// Returns: Fix / Sell / Borderline verdict with explanation

export type RepairCategory = 'routine' | 'drivetrain' | 'safety' | 'electrical' | 'body' | 'other';

export interface ParsedRepairItem {
  description: string;
  cost: number;
  category: RepairCategory;
  fairPriceRange?: { low: number; high: number } | null;
  isFair?: boolean | null;
}

export type OwnershipHorizon = '<1yr' | '1-3yr' | '3+yr';

export interface FixSellInput {
  repairCost: number;
  vehicleValue: number;
  vehicleValueSource: 'marketcheck' | 'ai_estimated' | 'user_entered';
  reliabilityTier: 'excellent' | 'good' | 'below_average' | 'poor' | null;
  tco: { year1Low: number; year1High: number } | null;
  majorExposures: { name: string; costLow: number; costHigh: number; urgency: 'near_term' | 'watch' | 'long_term' }[];
  repairItems: ParsedRepairItem[];
  ownershipHorizon?: OwnershipHorizon;
  vehicleMileage?: number;
  vehicleYear?: number;
  vehicleDesc: string; // "2016 Honda Accord EX-L"
}

export type FixSellDecision = 'fix' | 'sell' | 'borderline';

export interface FixSellVerdict {
  decision: FixSellDecision;
  headline: string;
  repairRatio: number;
  forwardCost12mo: number;
  vehicleValue: number;
  repairCost: number;
  explanation: string;
  recommendation: string;
  repairMix: {
    routine: number;
    drivetrain: number;
    safety: number;
    other: number;
  };
  confidenceNote: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function categorySums(items: ParsedRepairItem[]): { routine: number; drivetrain: number; safety: number; other: number } {
  const sums = { routine: 0, drivetrain: 0, safety: 0, other: 0 };
  for (const item of items) {
    const cost = item.cost || 0;
    if (item.category === 'routine') sums.routine += cost;
    else if (item.category === 'drivetrain') sums.drivetrain += cost;
    else if (item.category === 'safety') sums.safety += cost;
    else sums.other += cost;
  }
  return sums;
}

function nearTermExposureCount(exposures: FixSellInput['majorExposures']): number {
  return exposures.filter(e => e.urgency === 'near_term').length;
}

function nearTermExposureCost(exposures: FixSellInput['majorExposures']): number {
  return exposures
    .filter(e => e.urgency === 'near_term')
    .reduce((sum, e) => sum + (e.costLow + e.costHigh) / 2, 0);
}

// ── Core Decision Logic ──────────────────────────────────────────────────────

export function computeFixOrSell(input: FixSellInput): FixSellVerdict {
  const {
    repairCost,
    vehicleValue,
    reliabilityTier,
    tco,
    majorExposures,
    repairItems,
    ownershipHorizon,
    vehicleDesc,
  } = input;

  const repairRatio = vehicleValue > 0 ? repairCost / vehicleValue : 1;
  const mix = categorySums(repairItems);
  const routineShare = repairCost > 0 ? mix.routine / repairCost : 0;
  const drivetrainShare = repairCost > 0 ? mix.drivetrain / repairCost : 0;

  // Forward cost = repair + expected year 1 maintenance
  const expectedMaint12mo = tco
    ? Math.round((tco.year1Low + tco.year1High) / 2)
    : Math.round(vehicleValue * 0.06); // fallback: 6% of value
  const forwardCost12mo = repairCost + expectedMaint12mo;

  const nearTermCount = nearTermExposureCount(majorExposures);
  const nearTermCost = nearTermExposureCost(majorExposures);
  const reliabilityGood = reliabilityTier === 'excellent' || reliabilityTier === 'good';
  const reliabilityBad = reliabilityTier === 'below_average' || reliabilityTier === 'poor';

  // ── Decision tree ────────────────────────────────────────────────────────

  let decision: FixSellDecision;

  // Strong FIX signals
  if (repairRatio < 0.15) {
    decision = 'fix';
  } else if (repairRatio < 0.25 && reliabilityGood) {
    decision = 'fix';
  } else if (repairRatio < 0.20 && routineShare > 0.7) {
    // Mostly routine work (brakes, oil, fluids) — fix regardless of reliability
    decision = 'fix';
  }
  // Strong SELL signals
  else if (repairRatio > 0.50) {
    decision = 'sell';
  } else if (repairRatio > 0.35 && reliabilityBad) {
    decision = 'sell';
  } else if (repairRatio > 0.35 && nearTermCount >= 2) {
    decision = 'sell';
  } else if (drivetrainShare > 0.5 && repairRatio > 0.30) {
    // Major drivetrain work on a car where repair > 30% of value
    decision = 'sell';
  } else if (forwardCost12mo > vehicleValue * 0.60) {
    decision = 'sell';
  }
  // Everything else is borderline
  else {
    decision = 'borderline';
  }

  // ── Ownership horizon adjustments ────────────────────────────────────────
  if (decision === 'borderline' && ownershipHorizon) {
    if (ownershipHorizon === '3+yr' && repairRatio < 0.40 && !reliabilityBad) {
      decision = 'fix';
    } else if (ownershipHorizon === '<1yr' && repairRatio > 0.25) {
      decision = 'sell';
    }
  }

  // ── Generate human-readable output ───────────────────────────────────────

  const headline = generateHeadline(decision, repairRatio, routineShare, drivetrainShare);
  const explanation = generateExplanation(decision, input, repairRatio, mix, forwardCost12mo, expectedMaint12mo, nearTermCount, nearTermCost);
  const recommendation = generateRecommendation(decision, input, repairRatio, routineShare);
  const confidenceNote = generateConfidenceNote(input);

  return {
    decision,
    headline,
    repairRatio: Math.round(repairRatio * 100),
    forwardCost12mo,
    vehicleValue,
    repairCost,
    explanation,
    recommendation,
    repairMix: mix,
    confidenceNote,
  };
}

// ── Headline Generator ───────────────────────────────────────────────────────

function generateHeadline(
  decision: FixSellDecision,
  ratio: number,
  routineShare: number,
  drivetrainShare: number,
): string {
  if (decision === 'fix') {
    if (ratio < 0.10) return "Easy fix — barely a dent in the car's value.";
    if (routineShare > 0.7) return "Fix it — this is routine maintenance, not a red flag.";
    return "Fix it — this repair makes financial sense.";
  }
  if (decision === 'sell') {
    if (ratio > 0.60) return "Sell — you'd be pouring money into a sinking ship.";
    if (drivetrainShare > 0.5) return "Sell — major drivetrain work on a depreciating car.";
    return "Sell — this repair doesn't justify the car's remaining value.";
  }
  // borderline
  if (routineShare > 0.5) return "Close call — leans toward fix if you're keeping it.";
  return "Close call — depends on how long you plan to keep it.";
}

// ── Explanation Generator ────────────────────────────────────────────────────

function generateExplanation(
  decision: FixSellDecision,
  input: FixSellInput,
  ratio: number,
  mix: ReturnType<typeof categorySums>,
  forwardCost: number,
  expectedMaint: number,
  nearTermCount: number,
  nearTermCost: number,
): string {
  const pct = Math.round(ratio * 100);
  const parts: string[] = [];

  // Core ratio statement
  parts.push(
    `You're looking at spending $${input.repairCost.toLocaleString()} on a car worth roughly $${input.vehicleValue.toLocaleString()} — that's ${pct}% of the car's value.`
  );

  // Repair type context
  if (mix.routine > 0 && mix.routine / input.repairCost > 0.6) {
    parts.push(`Most of this quote is routine maintenance (brakes, fluids, filters) — the kind of work that keeps a good car running, not a warning sign.`);
  } else if (mix.drivetrain > 0 && mix.drivetrain / input.repairCost > 0.4) {
    parts.push(`A significant portion of this quote is drivetrain work (engine, transmission) — these are the expensive repairs that often signal more problems ahead.`);
  }

  // Forward cost
  if (decision !== 'fix') {
    parts.push(
      `Including expected maintenance over the next 12 months (~$${expectedMaint.toLocaleString()}), you'd spend roughly $${forwardCost.toLocaleString()} total to keep this car on the road.`
    );
  }

  // Near-term exposures
  if (nearTermCount >= 2) {
    parts.push(
      `There are ${nearTermCount} additional repairs likely within the next 15,000 miles (~$${Math.round(nearTermCost).toLocaleString()} more), which increases the risk of fixing now.`
    );
  }

  return parts.join(' ');
}

// ── Recommendation Generator ─────────────────────────────────────────────────

function generateRecommendation(
  decision: FixSellDecision,
  input: FixSellInput,
  ratio: number,
  routineShare: number,
): string {
  if (decision === 'fix') {
    if (routineShare > 0.7) {
      return `Fix it and keep driving. This is standard upkeep on a ${input.vehicleDesc} — exactly what you should be spending money on.`;
    }
    return `Fix it. At ${Math.round(ratio * 100)}% of the car's value, this repair preserves a car worth significantly more than the cost to fix it.`;
  }
  if (decision === 'sell') {
    return `Sell instead of repairing. Get quotes from CarMax, Carvana, or a local dealer — even selling as-is, you'll likely come out ahead versus sinking $${input.repairCost.toLocaleString()} into this repair.`;
  }
  // borderline
  if (input.ownershipHorizon === '3+yr') {
    return `If you're truly keeping this car 3+ years, the repair is worth it. Otherwise, sell.`;
  }
  if (input.ownershipHorizon === '<1yr') {
    return `If you're planning to move on within a year, sell now and skip the repair. The math doesn't work for a short hold.`;
  }
  return `If you plan to keep this car 2+ years, fix it. If you're on the fence about the car, this is your exit signal.`;
}

// ── Confidence Note ──────────────────────────────────────────────────────────

function generateConfidenceNote(input: FixSellInput): string {
  if (input.vehicleValueSource === 'marketcheck') {
    return 'Vehicle value based on real-time market listings.';
  }
  if (input.vehicleValueSource === 'ai_estimated') {
    return 'Vehicle value is an AI estimate — actual value may vary ±15%.';
  }
  return 'Vehicle value based on your input.';
}
