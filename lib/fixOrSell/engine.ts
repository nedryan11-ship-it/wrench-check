// lib/fixOrSell/engine.ts
// Fix or Sell Decision Engine — pure logic, no API calls.
//
// Takes: repair cost, vehicle value, reliability profile, model intelligence
// Returns: Fix / Sell / Borderline verdict with explanation
//
// V2: Integrates cascade rules, negotiated pricing, sell estimates, replacement cost.

import { evaluateAllCascades, type CascadeResult } from './cascadeRules';

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
  dealerRetailValue: number;      // pre-discount dealer price (for sell estimates)
  vehicleValueSource: 'marketcheck' | 'ai_estimated' | 'user_entered';
  reliabilityTier: 'excellent' | 'good' | 'below_average' | 'poor' | null;
  tco: { year1Low: number; year1High: number } | null;
  majorExposures: { name: string; costLow: number; costHigh: number; urgency: 'near_term' | 'watch' | 'long_term' }[];
  repairItems: ParsedRepairItem[];
  ownershipHorizon?: OwnershipHorizon;
  vehicleMileage?: number;
  vehicleYear?: number;
  vehicleMake?: string;
  vehicleDesc: string;
}

export type FixSellDecision = 'fix' | 'sell' | 'borderline';

export interface NegotiatedVerdict {
  fairTotal: number;
  fairRatio: number;
  fairDecision: FixSellDecision;
  savings: number;
  note: string;
}

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
  // V2 additions
  cascadeSummary: string;
  cascadeItems: (CascadeResult & { description: string })[];
  negotiated: NegotiatedVerdict | null;
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
    vehicleMileage,
    vehicleMake,
  } = input;

  const repairRatio = vehicleValue > 0 ? repairCost / vehicleValue : 1;
  const mix = categorySums(repairItems);
  const routineShare = repairCost > 0 ? mix.routine / repairCost : 0;
  const drivetrainShare = repairCost > 0 ? mix.drivetrain / repairCost : 0;

  // Forward cost = repair + expected year 1 maintenance
  const expectedMaint12mo = tco
    ? Math.round((tco.year1Low + tco.year1High) / 2)
    : Math.round(vehicleValue * 0.06);
  const forwardCost12mo = repairCost + expectedMaint12mo;

  const nearTermCount = nearTermExposureCount(majorExposures);
  const nearTermCost = nearTermExposureCost(majorExposures);
  const reliabilityGood = reliabilityTier === 'excellent' || reliabilityTier === 'good';
  const reliabilityBad = reliabilityTier === 'below_average' || reliabilityTier === 'poor';

  // ── Cascade analysis (hardcoded rules, not LLM) ─────────────────────────
  const cascade = evaluateAllCascades(repairItems, vehicleMileage, vehicleMake);

  // ── Decision tree ────────────────────────────────────────────────────────
  let decision: FixSellDecision;

  // Cascade override: sell signal from hardcoded rules
  if (cascade.hasSellSignal && repairRatio > 0.20) {
    decision = 'sell';
  }
  // Strong FIX signals
  else if (repairRatio < 0.15 && !cascade.hasSellSignal) {
    decision = 'fix';
  } else if (repairRatio < 0.25 && reliabilityGood && cascade.totalAdjust >= -3) {
    decision = 'fix';
  } else if (repairRatio < 0.20 && routineShare > 0.7) {
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
    decision = 'sell';
  } else if (forwardCost12mo > vehicleValue * 0.60) {
    decision = 'sell';
  }
  // Cascade-influenced borderline → sell
  else if (cascade.cascadeCount >= 2 && repairRatio > 0.25) {
    decision = 'sell';
  }
  else {
    decision = 'borderline';
  }

  // ── Ownership horizon adjustments ────────────────────────────────────────
  if (decision === 'borderline' && ownershipHorizon) {
    if (ownershipHorizon === '3+yr' && repairRatio < 0.40 && !reliabilityBad && !cascade.hasSellSignal) {
      decision = 'fix';
    } else if (ownershipHorizon === '<1yr' && repairRatio > 0.25) {
      decision = 'sell';
    }
  }

  // ── Negotiated verdict (what if you get fair prices?) ────────────────────
  const negotiated = computeNegotiatedVerdict(repairItems, vehicleValue, decision);

  // ── Generate human-readable output ───────────────────────────────────────
  const headline = generateHeadline(decision, repairRatio, routineShare, drivetrainShare);
  const explanation = generateExplanation(decision, input, repairRatio, mix, forwardCost12mo, expectedMaint12mo, nearTermCount, nearTermCost, cascade);
  const recommendation = generateRecommendation(decision, input, repairRatio, routineShare, negotiated);
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
    cascadeSummary: cascade.summary,
    cascadeItems: cascade.results,
    negotiated,
  };
}

// ── Negotiated Verdict ───────────────────────────────────────────────────────

function computeNegotiatedVerdict(
  items: ParsedRepairItem[],
  vehicleValue: number,
  originalDecision: FixSellDecision,
): NegotiatedVerdict | null {
  const itemsWithFair = items.filter(i => i.fairPriceRange);
  if (itemsWithFair.length === 0) return null;

  // Compute fair total: use midpoint of fair range for overpriced items, keep quoted for fair items
  const fairTotal = items.reduce((sum, item) => {
    if (item.isFair === false && item.fairPriceRange) {
      return sum + Math.round((item.fairPriceRange.low + item.fairPriceRange.high) / 2);
    }
    return sum + item.cost;
  }, 0);

  const quotedTotal = items.reduce((sum, i) => sum + i.cost, 0);
  const savings = quotedTotal - fairTotal;

  if (savings < 50) return null; // not worth mentioning

  const fairRatio = vehicleValue > 0 ? Math.round((fairTotal / vehicleValue) * 100) : 0;
  const quotedRatio = vehicleValue > 0 ? Math.round((quotedTotal / vehicleValue) * 100) : 0;

  // Does negotiating change the verdict?
  let fairDecision: FixSellDecision = originalDecision;
  if (fairRatio < 15) fairDecision = 'fix';
  else if (fairRatio < 25) fairDecision = 'fix';
  else if (fairRatio > 50) fairDecision = 'sell';
  else if (originalDecision === 'borderline' && fairRatio < 25) fairDecision = 'fix';
  else if (originalDecision === 'sell' && fairRatio < 30) fairDecision = 'borderline';

  const verdictChanged = fairDecision !== originalDecision;

  let note: string;
  if (verdictChanged) {
    note = `At fair prices (~$${fairTotal.toLocaleString()}), this drops from ${quotedRatio}% to ${fairRatio}% of your car's value — changing the verdict to ${fairDecision.toUpperCase()}. Negotiate $${savings.toLocaleString()} off first.`;
  } else {
    note = `Negotiating to fair prices (~$${fairTotal.toLocaleString()}) saves you $${savings.toLocaleString()}, but doesn't change the verdict.`;
  }

  return { fairTotal, fairRatio, fairDecision, savings, note };
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
  cascade: ReturnType<typeof evaluateAllCascades>,
): string {
  const pct = Math.round(ratio * 100);
  const parts: string[] = [];

  parts.push(
    `You're looking at spending $${input.repairCost.toLocaleString()} on a car worth roughly $${input.vehicleValue.toLocaleString()} — that's ${pct}% of the car's value.`
  );

  if (mix.routine > 0 && mix.routine / input.repairCost > 0.6) {
    parts.push(`Most of this quote is routine maintenance (brakes, fluids, filters) — the kind of work that keeps a good car running, not a warning sign.`);
  } else if (mix.drivetrain > 0 && mix.drivetrain / input.repairCost > 0.4) {
    parts.push(`A significant portion of this quote is drivetrain work (engine, transmission) — these are the expensive repairs that often signal more problems ahead.`);
  }

  // Cascade intelligence
  if (cascade.hasSellSignal || cascade.cascadeCount >= 2) {
    parts.push(cascade.summary);
  }

  if (decision !== 'fix') {
    parts.push(
      `Including expected maintenance over the next 12 months (~$${expectedMaint.toLocaleString()}), you'd spend roughly $${forwardCost.toLocaleString()} total to keep this car on the road.`
    );
  }

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
  negotiated: NegotiatedVerdict | null,
): string {
  const negNote = negotiated && negotiated.savings >= 100
    ? ` But negotiate first — you can likely save $${negotiated.savings.toLocaleString()} by pushing for fair prices.`
    : '';

  if (decision === 'fix') {
    if (routineShare > 0.7) {
      return `Fix it and keep driving. This is standard upkeep on a ${input.vehicleDesc} — exactly what you should be spending money on.${negNote}`;
    }
    return `Fix it. At ${Math.round(ratio * 100)}% of the car's value, this repair preserves a car worth significantly more than the cost to fix it.${negNote}`;
  }
  if (decision === 'sell') {
    return `Sell instead of repairing. Get instant offers from CarMax or Carvana, or list on FB Marketplace for the best price. Even selling as-is avoids sinking $${input.repairCost.toLocaleString()} into a declining asset.`;
  }
  if (input.ownershipHorizon === '3+yr') {
    return `If you're truly keeping this car 3+ years, the repair is worth it. Otherwise, sell.${negNote}`;
  }
  if (input.ownershipHorizon === '<1yr') {
    return `If you're planning to move on within a year, sell now and skip the repair. The math doesn't work for a short hold.`;
  }
  return `If you plan to keep this car 2+ years, fix it. If you're on the fence, this is your exit signal.${negNote}`;
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
