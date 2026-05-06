// lib/fixOrSell/engine.ts
// Fix or Sell Decision Engine — pure logic, no API calls.
//
// V4: Archetype-driven decision thresholds.
// Takes: repair cost, vehicle value, archetype, reliability profile
// Returns: Fix / Sell / Borderline verdict with archetype-aware explanation

import { evaluateAllCascades, type CascadeResult } from './cascadeRules';
import { type VehicleArchetype, type ArchetypeResult, getArchetypeThresholds } from './vehicleArchetypes';

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
  dealerRetailValue: number;
  vehicleValueSource: 'marketcheck' | 'ai_estimated' | 'user_entered';
  reliabilityTier: 'excellent' | 'good' | 'below_average' | 'poor' | null;
  tco: { year1Low: number; year1High: number } | null;
  majorExposures: { name: string; costLow: number; costHigh: number; urgency: 'near_term' | 'watch' | 'long_term' }[];
  repairItems: ParsedRepairItem[];
  ownershipHorizon?: OwnershipHorizon;
  vehicleMileage?: number;
  vehicleYear?: number;
  vehicleMake?: string;
  vehicleModel?: string;
  vehicleDesc: string;
  archetype: ArchetypeResult;
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
  // V4 additions
  cascadeSummary: string;
  cascadeItems: (CascadeResult & { description: string })[];
  negotiated: NegotiatedVerdict | null;
  archetype: VehicleArchetype;
  archetypeLabel: string;
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
  const { repairCost, vehicleValue, reliabilityTier, tco, majorExposures,
    repairItems, ownershipHorizon, vehicleDesc, vehicleMileage,
    vehicleMake, vehicleModel, vehicleYear, archetype } = input;

  const at = archetype.archetype;
  const th = getArchetypeThresholds(at);
  const repairRatio = vehicleValue > 0 ? repairCost / vehicleValue : 1;
  const mix = categorySums(repairItems);
  const routineShare = repairCost > 0 ? mix.routine / repairCost : 0;
  const drivetrainShare = repairCost > 0 ? mix.drivetrain / repairCost : 0;

  const expectedMaint12mo = tco
    ? Math.round((tco.year1Low + tco.year1High) / 2)
    : Math.round(vehicleValue * 0.06);
  const forwardCost12mo = repairCost + expectedMaint12mo;

  const nearTermCount = nearTermExposureCount(majorExposures);
  const nearTermCost = nearTermExposureCost(majorExposures);
  const reliabilityGood = reliabilityTier === 'excellent' || reliabilityTier === 'good';
  const reliabilityBad = reliabilityTier === 'below_average' || reliabilityTier === 'poor';

  const cascade = evaluateAllCascades(repairItems, vehicleMileage, vehicleMake, vehicleModel, vehicleYear);

  // ── Archetype-driven decision tree ───────────────────────────────────────
  let decision: FixSellDecision;

  // Fix: below archetype fix ceiling
  if (repairRatio < th.fixCeiling && !cascade.hasSellSignal) {
    decision = 'fix';
  } else if (repairRatio < th.fixCeiling && !th.cascadeSellSignals) {
    decision = 'fix'; // enthusiast/truck: cascade signals suppressed
  }
  // Fix: reliable appliance with good reliability
  else if (repairRatio < th.fixCeiling * 1.5 && reliabilityGood && cascade.totalAdjust >= -3) {
    decision = 'fix';
  }
  // Fix: mostly routine
  else if (repairRatio < th.fixCeiling * 1.3 && routineShare > 0.7) {
    decision = 'fix';
  }
  // Sell: cascade sell signal (only if archetype respects them)
  else if (th.cascadeSellSignals && cascade.hasSellSignal && repairRatio > th.fixCeiling) {
    decision = 'sell';
  }
  // Sell: above archetype sell floor
  else if (repairRatio > th.sellFloor) {
    decision = 'sell';
  }
  // Sell: luxury depreciator trap — forward depreciation exceeds repair
  else if (at === 'luxury_depreciator' && repairRatio > 0.20) {
    const forwardDepr = vehicleValue * (archetype.annualDepreciationPct / 100);
    if (repairCost + forwardDepr > vehicleValue * 0.45) {
      decision = 'sell';
    } else {
      decision = 'borderline';
    }
  }
  // Sell: bad reliability + high ratio
  else if (repairRatio > th.fixCeiling * 2 && reliabilityBad) {
    decision = 'sell';
  }
  // Sell: multiple near-term exposures
  else if (repairRatio > th.fixCeiling * 2 && nearTermCount >= 2) {
    decision = 'sell';
  }
  // Sell: forward cost exceeds value
  else if (forwardCost12mo > vehicleValue * 0.60 && th.cascadeSellSignals) {
    decision = 'sell';
  }
  else {
    decision = 'borderline';
  }

  // Ownership horizon adjustments
  if (decision === 'borderline' && ownershipHorizon) {
    if (ownershipHorizon === '3+yr' && repairRatio < th.sellFloor && !reliabilityBad) {
      decision = 'fix';
    } else if (ownershipHorizon === '<1yr' && repairRatio > th.fixCeiling * 1.5) {
      decision = 'sell';
    }
  }

  const negotiated = computeNegotiatedVerdict(repairItems, vehicleValue, decision);
  const headline = generateHeadline(decision, repairRatio, routineShare, drivetrainShare, at);
  const explanation = generateExplanation(decision, input, repairRatio, mix, forwardCost12mo, expectedMaint12mo, nearTermCount, nearTermCost, cascade);
  const recommendation = generateRecommendation(decision, input, repairRatio, routineShare, negotiated);
  const confidenceNote = generateConfidenceNote(input);

  return {
    decision, headline,
    repairRatio: Math.round(repairRatio * 100),
    forwardCost12mo, vehicleValue, repairCost,
    explanation, recommendation,
    repairMix: mix, confidenceNote,
    cascadeSummary: cascade.summary,
    cascadeItems: cascade.results,
    negotiated,
    archetype: at,
    archetypeLabel: archetype.label,
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
  archetype?: VehicleArchetype,
): string {
  if (decision === 'fix') {
    if (ratio < 0.10) return "Easy fix — barely a dent in the car's value.";
    if (routineShare > 0.7) return "Fix it — this is routine maintenance, not a red flag.";
    if (archetype === 'enthusiast') return "Fix it — this is a worthwhile investment in a vehicle that holds its value.";
    if (archetype === 'truck_work') return "Fix it — cheaper than replacing a truck in today's market.";
    if (archetype === 'reliable_appliance') return "Fix it — this car will keep running for years to come.";
    return "Fix it — this repair makes financial sense.";
  }
  if (decision === 'sell') {
    if (archetype === 'luxury_depreciator') return "Sell — repair costs stay high while the car's value keeps dropping.";
    if (ratio > 0.60) return "Sell — the repair cost is too high relative to the car's value.";
    if (drivetrainShare > 0.5) return "Sell — major drivetrain work on a vehicle entering decline.";
    return "Sell — this repair doesn't justify the car's remaining value.";
  }
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
    if (input.archetype.archetype === 'luxury_depreciator') {
      return `Sell before more value evaporates. This vehicle loses ~${input.archetype.annualDepreciationPct}% per year — even a perfect repair won't stop that. List on FB Marketplace or get trade-in offers.`;
    }
    return `Sell instead of repairing. List on FB Marketplace for the best price, or get dealer trade-in offers. Selling as-is avoids sinking $${input.repairCost.toLocaleString()} into a vehicle that's not worth the investment.`;
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
