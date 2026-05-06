// lib/fixOrSell/engine.ts
// Fix or Sell Decision ADVISOR — pure logic, no API calls.
//
// V5: Contextual advisor model.
// Produces provisional recommendations with confidence + uncertainty factors.
// Designed to feed into conversational refinement, not static reports.

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

// ── Soft verdict system ──────────────────────────────────────────────────────

export type SoftVerdict =
  | 'likely_fix'
  | 'leaning_fix'
  | 'borderline'
  | 'leaning_sell'
  | 'likely_sell'
  | 'needs_context';

export type RecommendationConfidence = 'high' | 'medium' | 'low';

export type RepairTier = 'decision_driving' | 'supporting' | 'cosmetic';

export interface TieredRepairItem extends ParsedRepairItem {
  tier: RepairTier;
  tierLabel: string;
}

export interface ReplacementRisk {
  summary: string;
  factors: string[];
}

export interface NegotiatedVerdict {
  fairTotal: number;
  fairRatio: number;
  savings: number;
  note: string;
}

export interface FixSellVerdict {
  // Core recommendation
  decision: SoftVerdict;
  confidence: RecommendationConfidence;
  headline: string;
  subheadline: string;

  // Numbers
  repairRatio: number;
  forwardCost12mo: number;
  vehicleValue: number;
  repairCost: number;

  // Narrative
  explanation: string;
  recommendation: string;

  // What could change
  whatCouldChange: string[];
  followUpQuestions: string[];

  // Repair analysis
  repairMix: { routine: number; drivetrain: number; safety: number; other: number };
  tieredItems: TieredRepairItem[];

  // Replacement risk
  replacementRisk: ReplacementRisk;

  // Intelligence
  cascadeSummary: string;
  cascadeItems: (CascadeResult & { description: string })[];
  negotiated: NegotiatedVerdict | null;
  confidenceNote: string;

  // Classification
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

// ── Repair Tier Classification ───────────────────────────────────────────────

const DECISION_DRIVING = /transmiss|engine|motor|head gasket|timing chain|timing belt|frame|hybrid battery|cvt|transfer case/i;
const COSMETIC = /mirror|trim|emblem|badge|bulb|light lens|touch.?up|dent|scratch|clear coat|paint|chrome|molding|visor/i;

function classifyRepairTier(item: ParsedRepairItem): RepairTier {
  if (DECISION_DRIVING.test(item.description)) return 'decision_driving';
  if (COSMETIC.test(item.description)) return 'cosmetic';
  if (item.category === 'drivetrain') return 'decision_driving';
  if (item.category === 'body') return 'cosmetic';
  return 'supporting';
}

function tierLabel(tier: RepairTier): string {
  switch (tier) {
    case 'decision_driving': return 'Decision-Driving';
    case 'supporting': return 'Supporting Repair';
    case 'cosmetic': return 'Cosmetic / Minor';
  }
}

function tierItems(items: ParsedRepairItem[]): TieredRepairItem[] {
  return items.map(item => {
    const tier = classifyRepairTier(item);
    return { ...item, tier, tierLabel: tierLabel(tier) };
  });
}

// ── Replacement Risk ─────────────────────────────────────────────────────────

function computeReplacementRisk(input: FixSellInput): ReplacementRisk {
  const factors: string[] = [];
  const at = input.archetype.archetype;

  factors.push('Any replacement vehicle may have its own unknown mechanical issues');
  factors.push('Expect ~$1,500–2,500 in taxes, registration, and transaction fees');

  if (at === 'enthusiast') {
    factors.push('Comparable enthusiast vehicles are scarce — finding one in similar condition takes time');
    factors.push('Buying someone else\'s project may cost more in the long run');
  } else if (at === 'truck_work') {
    factors.push(`New trucks are $45,000–65,000+ — used truck prices remain elevated`);
  } else if (at === 'reliable_appliance') {
    factors.push('You know this car\'s history. A replacement is an unknown.');
  }

  if (input.vehicleMileage && input.vehicleMileage > 100000) {
    factors.push('At this price point, most replacements will also have high mileage and deferred maintenance');
  }

  const summary = at === 'enthusiast'
    ? 'Replacing an enthusiast vehicle is rarely simple — comparable examples are scarce and you inherit unknown history.'
    : at === 'truck_work'
    ? 'Truck replacement costs are near all-time highs. Repairing what you know is often the lower-risk move.'
    : 'Replacing this vehicle avoids the current repair but introduces unknown condition risk, transaction costs, and downtime.';

  return { summary, factors };
}

// ── What Could Change ────────────────────────────────────────────────────────

function computeWhatCouldChange(
  input: FixSellInput,
  rawDecision: string,
  repairRatio: number,
  drivetrainShare: number,
): string[] {
  const factors: string[] = [];
  const at = input.archetype.archetype;

  // Universal
  if (!input.ownershipHorizon) {
    factors.push('How long you plan to keep this vehicle (1 year vs 5+ years significantly changes the math)');
  }

  // Condition-dependent (especially for enthusiast)
  if (at === 'enthusiast' || at === 'truck_work') {
    factors.push('Overall body and rust condition (a rust-free example is worth significantly more)');
    factors.push('Recent major maintenance history (if major services were recently completed)');
    factors.push('Engine/drivetrain health beyond this specific repair');
  }

  // Value-dependent
  if (input.vehicleValueSource !== 'marketcheck') {
    factors.push('A more accurate vehicle valuation (our estimate has limited comparable data)');
  }

  // Negotiation
  const hasOverpriced = input.repairItems.some(i => i.isFair === false);
  if (hasOverpriced) {
    factors.push('Negotiating the repair price down (some items appear overpriced)');
  }

  // Luxury depreciator
  if (at === 'luxury_depreciator') {
    factors.push('Whether you have access to an independent mechanic (reduces repair costs 30-40% vs dealer)');
    factors.push('Future maintenance trajectory — these vehicles often have cascading expensive repairs');
  }

  // Near borderline
  if (rawDecision === 'borderline') {
    if (drivetrainShare > 0.3) {
      factors.push('Whether this drivetrain issue is isolated or part of a pattern');
    }
    factors.push('Getting a second opinion or competitive quote');
  }

  return factors.slice(0, 5);
}

// ── Adaptive Follow-Up Questions ─────────────────────────────────────────────

function computeFollowUpQuestions(
  input: FixSellInput,
  rawDecision: string,
): string[] {
  const qs: string[] = [];
  const at = input.archetype.archetype;

  if (!input.ownershipHorizon) {
    qs.push('How long do you plan to keep this vehicle?');
  }

  if (at === 'enthusiast') {
    qs.push('Is the body/frame rust-free?');
    qs.push('Has any major maintenance been done recently (timing belt, seals, etc)?');
    qs.push('Is the engine/drivetrain otherwise healthy?');
  } else if (at === 'luxury_depreciator') {
    qs.push('Are you using a dealer or independent mechanic?');
    qs.push('How much have you spent on repairs in the past 12 months?');
  } else if (at === 'truck_work') {
    qs.push('Do you depend on this truck for work?');
    qs.push('What would a comparable replacement cost in your area?');
  } else if (at === 'reliable_appliance') {
    qs.push('Has the car been reliable for you so far?');
  }

  if (rawDecision === 'borderline' || rawDecision === 'sell') {
    qs.push('Have you gotten a second quote?');
  }

  const hasOverpriced = input.repairItems.some(i => i.isFair === false);
  if (hasOverpriced) {
    qs.push('Are you open to negotiating the quoted prices?');
  }

  return qs.slice(0, 4);
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

  // ── Raw decision (same archetype logic) ──────────────────────────────────
  let rawDecision: 'fix' | 'sell' | 'borderline';

  if (repairRatio < th.fixCeiling && !cascade.hasSellSignal) {
    rawDecision = 'fix';
  } else if (repairRatio < th.fixCeiling && !th.cascadeSellSignals) {
    rawDecision = 'fix';
  } else if (repairRatio < th.fixCeiling * 1.5 && reliabilityGood && cascade.totalAdjust >= -3) {
    rawDecision = 'fix';
  } else if (repairRatio < th.fixCeiling * 1.3 && routineShare > 0.7) {
    rawDecision = 'fix';
  } else if (th.cascadeSellSignals && cascade.hasSellSignal && repairRatio > th.fixCeiling) {
    rawDecision = 'sell';
  } else if (repairRatio > th.sellFloor) {
    rawDecision = 'sell';
  } else if (at === 'luxury_depreciator' && repairRatio > 0.20) {
    const forwardDepr = vehicleValue * (archetype.annualDepreciationPct / 100);
    rawDecision = (repairCost + forwardDepr > vehicleValue * 0.45) ? 'sell' : 'borderline';
  } else if (repairRatio > th.fixCeiling * 2 && reliabilityBad) {
    rawDecision = 'sell';
  } else if (repairRatio > th.fixCeiling * 2 && nearTermCount >= 2) {
    rawDecision = 'sell';
  } else if (forwardCost12mo > vehicleValue * 0.60 && th.cascadeSellSignals) {
    rawDecision = 'sell';
  } else {
    rawDecision = 'borderline';
  }

  // Ownership horizon adjustments
  if (rawDecision === 'borderline' && ownershipHorizon) {
    if (ownershipHorizon === '3+yr' && repairRatio < th.sellFloor && !reliabilityBad) {
      rawDecision = 'fix';
    } else if (ownershipHorizon === '<1yr' && repairRatio > th.fixCeiling * 1.5) {
      rawDecision = 'sell';
    }
  }

  // ── Map to soft verdict + confidence ──────────────────────────────────────
  let decision: SoftVerdict;
  let confidence: RecommendationConfidence;

  // Strong fix
  if (rawDecision === 'fix' && repairRatio < th.fixCeiling * 0.6) {
    decision = 'likely_fix'; confidence = 'high';
  } else if (rawDecision === 'fix') {
    decision = 'leaning_fix'; confidence = 'medium';
  }
  // Strong sell
  else if (rawDecision === 'sell' && repairRatio > th.sellFloor * 1.2) {
    decision = 'likely_sell'; confidence = 'high';
  } else if (rawDecision === 'sell') {
    decision = 'leaning_sell'; confidence = 'medium';
  }
  // Borderline
  else {
    decision = 'borderline'; confidence = 'low';
  }

  // Downgrade confidence when missing key context
  if (!ownershipHorizon && confidence === 'high') confidence = 'medium';
  if (input.vehicleValueSource === 'ai_estimated' && confidence !== 'low') confidence = 'medium';
  if (at === 'enthusiast' && confidence === 'high') confidence = 'medium'; // condition unknown

  // Upgrade to needs_context when we really can't say
  if (confidence === 'low' && at === 'enthusiast' && !ownershipHorizon) {
    decision = 'needs_context';
  }

  // ── Build all outputs ────────────────────────────────────────────────────
  const tiered = tierItems(repairItems);
  const whatCouldChange = computeWhatCouldChange(input, rawDecision, repairRatio, drivetrainShare);
  const followUpQuestions = computeFollowUpQuestions(input, rawDecision);
  const replacementRisk = computeReplacementRisk(input);
  const negotiated = computeNegotiatedVerdict(repairItems, vehicleValue);
  const headline = generateHeadline(decision, repairRatio, routineShare, drivetrainShare, at);
  const subheadline = generateSubheadline(decision, confidence);
  const explanation = generateExplanation(input, repairRatio, mix, forwardCost12mo, expectedMaint12mo, nearTermCount, nearTermCost, cascade, at);
  const recommendation = generateRecommendation(decision, input, repairRatio, routineShare, negotiated);
  const confidenceNote = generateConfidenceNote(input);

  return {
    decision, confidence, headline, subheadline,
    repairRatio: Math.round(repairRatio * 100),
    forwardCost12mo, vehicleValue, repairCost,
    explanation, recommendation,
    whatCouldChange, followUpQuestions,
    repairMix: mix, tieredItems: tiered,
    replacementRisk,
    cascadeSummary: cascade.summary,
    cascadeItems: cascade.results,
    negotiated, confidenceNote,
    archetype: at, archetypeLabel: archetype.label,
  };
}

// ── Negotiated Verdict ───────────────────────────────────────────────────────

function computeNegotiatedVerdict(
  items: ParsedRepairItem[],
  vehicleValue: number,
): NegotiatedVerdict | null {
  const itemsWithFair = items.filter(i => i.fairPriceRange);
  if (itemsWithFair.length === 0) return null;

  const fairTotal = items.reduce((sum, item) => {
    if (item.isFair === false && item.fairPriceRange) {
      return sum + Math.round((item.fairPriceRange.low + item.fairPriceRange.high) / 2);
    }
    return sum + item.cost;
  }, 0);

  const quotedTotal = items.reduce((sum, i) => sum + i.cost, 0);
  const savings = quotedTotal - fairTotal;
  if (savings < 50) return null;

  const fairRatio = vehicleValue > 0 ? Math.round((fairTotal / vehicleValue) * 100) : 0;
  const note = `At fair market prices (~$${fairTotal.toLocaleString()}), the repair drops to ${fairRatio}% of value — saving you $${savings.toLocaleString()}. Always negotiate before deciding.`;

  return { fairTotal, fairRatio, savings, note };
}

// ── Headline Generator ───────────────────────────────────────────────────────

function generateHeadline(
  decision: SoftVerdict,
  ratio: number,
  routineShare: number,
  drivetrainShare: number,
  archetype?: VehicleArchetype,
): string {
  switch (decision) {
    case 'likely_fix':
      if (ratio < 0.10) return "Likely worth fixing — this is a minor expense.";
      if (routineShare > 0.7) return "Likely worth fixing — this is routine maintenance.";
      if (archetype === 'enthusiast') return "Likely worth fixing — this vehicle holds its value.";
      if (archetype === 'truck_work') return "Likely worth fixing — cheaper than replacing.";
      return "Likely worth fixing — the numbers work in your favor.";
    case 'leaning_fix':
      if (archetype === 'reliable_appliance') return "Leaning toward fix — this car has a lot of life left.";
      if (archetype === 'enthusiast') return "Leaning toward fix — but condition details matter.";
      return "Leaning toward fix — though a few factors could change this.";
    case 'borderline':
      return "Borderline — this could go either way depending on your situation.";
    case 'leaning_sell':
      if (archetype === 'luxury_depreciator') return "Leaning toward sell — repair costs vs. depreciation is the concern.";
      return "Leaning toward sell — but context could change this.";
    case 'likely_sell':
      if (ratio > 0.60) return "Likely better to sell — the repair cost is too high relative to value.";
      return "Likely better to sell — multiple factors point that direction.";
    case 'needs_context':
      return "Need more information before making a recommendation.";
  }
}

function generateSubheadline(decision: SoftVerdict, confidence: RecommendationConfidence): string {
  const confLabel = confidence === 'high' ? 'High' : confidence === 'medium' ? 'Medium' : 'Low';
  if (decision === 'needs_context') {
    return `We need a few more details to give you a meaningful recommendation.`;
  }
  return `Recommendation confidence: ${confLabel}. This is an initial assessment that may change with additional context.`;
}

// ── Explanation Generator ────────────────────────────────────────────────────

function generateExplanation(
  input: FixSellInput,
  ratio: number,
  mix: ReturnType<typeof categorySums>,
  forwardCost: number,
  expectedMaint: number,
  nearTermCount: number,
  nearTermCost: number,
  cascade: ReturnType<typeof evaluateAllCascades>,
  archetype: VehicleArchetype,
): string {
  const pct = Math.round(ratio * 100);
  const parts: string[] = [];

  parts.push(
    `You're looking at spending $${input.repairCost.toLocaleString()} on a vehicle worth roughly $${input.vehicleValue.toLocaleString()} — that's ${pct}% of the vehicle's value.`
  );

  if (mix.routine > 0 && mix.routine / input.repairCost > 0.6) {
    parts.push(`Most of this quote is routine maintenance — the kind of work that keeps a good vehicle running, not a warning sign.`);
  } else if (mix.drivetrain > 0 && mix.drivetrain / input.repairCost > 0.4) {
    if (archetype === 'enthusiast') {
      parts.push(`A significant portion is drivetrain work. On this type of vehicle, that's often a worthwhile investment rather than a red flag.`);
    } else {
      parts.push(`A significant portion is drivetrain work — these are the expensive repairs that can signal more problems ahead.`);
    }
  }

  if (cascade.hasSellSignal || cascade.cascadeCount >= 2) {
    parts.push(cascade.summary);
  }

  if (nearTermCount >= 2) {
    parts.push(
      `There are ${nearTermCount} additional repairs likely in the near term (~$${Math.round(nearTermCost).toLocaleString()} more), which adds risk.`
    );
  }

  return parts.join(' ');
}

// ── Recommendation Generator ─────────────────────────────────────────────────

function generateRecommendation(
  decision: SoftVerdict,
  input: FixSellInput,
  ratio: number,
  routineShare: number,
  negotiated: NegotiatedVerdict | null,
): string {
  const negNote = negotiated && negotiated.savings >= 100
    ? ` Consider negotiating first — you may save ~$${negotiated.savings.toLocaleString()}.`
    : '';
  const at = input.archetype.archetype;

  if (decision === 'likely_fix' || decision === 'leaning_fix') {
    if (at === 'enthusiast') {
      return `This repair is likely a sound investment. These vehicles hold their value and well-maintained examples command a premium.${negNote}`;
    }
    if (at === 'truck_work') {
      return `Repairing is likely the smarter move. Replacing this truck in today's market would cost significantly more than this repair.${negNote}`;
    }
    if (routineShare > 0.7) {
      return `This is standard maintenance — exactly what you should be spending on to keep a good vehicle running.${negNote}`;
    }
    return `At ${Math.round(ratio * 100)}% of value, this repair preserves a vehicle worth significantly more than the cost to fix it.${negNote}`;
  }

  if (decision === 'likely_sell' || decision === 'leaning_sell') {
    if (at === 'luxury_depreciator') {
      return `This vehicle is likely losing value faster than you can maintain it. Consider selling before more value erodes.`;
    }
    return `The repair cost is hard to justify given the vehicle's current value. Explore your selling options — but consider the replacement costs and risks too.`;
  }

  if (decision === 'needs_context') {
    return `We need more information about your vehicle's condition and your plans before we can make a meaningful recommendation. Let's talk through it.`;
  }

  // borderline
  if (input.ownershipHorizon === '3+yr') {
    return `If you're keeping this vehicle long-term, the repair is probably worth it. The math gets better the longer you drive it.${negNote}`;
  }
  return `This is a close call. Your ownership plans, the vehicle's overall condition, and whether you can negotiate a better price all factor in. Let's talk through it.${negNote}`;
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
