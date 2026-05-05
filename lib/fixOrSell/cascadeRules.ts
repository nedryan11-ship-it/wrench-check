// lib/fixOrSell/cascadeRules.ts
// Hardcoded failure cascade intelligence.
// "Once you see X, expect Y" — based on real mechanical patterns, NOT LLM.
//
// Each repair item gets tagged with a cascade signal that adjusts the verdict.

export type CascadeSignal =
  | 'one_time_fix'   // Fix it and forget it. No cascade.
  | 'neutral'        // Standalone issue, no broader implication.
  | 'watch'          // Could indicate early signs of more. Monitor.
  | 'cascade'        // This fix often leads to another within 12 months.
  | 'sell_signal';   // Strong indicator the car is entering decline.

export interface CascadeResult {
  signal: CascadeSignal;
  note: string;
  adjustScore: number; // -10 to +10, applied to verdict confidence
}

interface CascadeRule {
  pattern: RegExp;
  mileageThreshold?: number; // only apply if mileage > this
  makeFilter?: string[];     // only for these makes (lowercase)
  signal: CascadeSignal;
  note: string;
  adjustScore: number;
  // Override signal if mileage > this
  highMileageOverride?: {
    mileage: number;
    signal: CascadeSignal;
    note: string;
    adjustScore: number;
  };
}

const RULES: CascadeRule[] = [
  // ── Drivetrain (highest stakes) ──────────────────────────────────────────
  {
    pattern: /transmission.*(rebuild|replace|overhaul)/i,
    signal: 'sell_signal',
    note: "Transmission rebuild on a high-mileage car rarely ends the story. Expect more drivetrain issues.",
    adjustScore: -8,
    highMileageOverride: { mileage: 120000, signal: 'sell_signal', note: "Transmission rebuild past 120k miles — historically a declining-value inflection point.", adjustScore: -10 },
  },
  {
    pattern: /transmission.*(flush|fluid|service)/i,
    signal: 'neutral',
    note: "Transmission fluid service is routine maintenance. No cascade risk.",
    adjustScore: 0,
    highMileageOverride: { mileage: 130000, signal: 'watch', note: "Late transmission flush can dislodge debris. Monitor for slipping or hard shifts.", adjustScore: -3 },
  },
  {
    pattern: /head gasket/i,
    makeFilter: ["subaru"],
    signal: 'cascade',
    note: "Known Subaru EJ25 head gasket issue. Fix is valid but this engine has a documented design flaw — monitor for recurrence.",
    adjustScore: -5,
  },
  {
    pattern: /head gasket/i,
    signal: 'sell_signal',
    note: "Head gasket failure typically indicates significant engine distress. More problems are likely.",
    adjustScore: -8,
  },
  {
    pattern: /engine.*(rebuild|replace|overhaul|swap)/i,
    signal: 'sell_signal',
    note: "Engine replacement is the most expensive single repair. At this point, the car's total cost of ownership is spiraling.",
    adjustScore: -10,
  },
  {
    pattern: /timing (chain|belt).*(replace|service)/i,
    signal: 'one_time_fix',
    note: "Timing chain/belt is a one-time, interval-based repair. Car is typically solid after this work.",
    adjustScore: +3,
  },
  {
    pattern: /catalytic converter/i,
    signal: 'watch',
    note: "Catalytic converter failure can indicate upstream engine issues (burning oil, misfires). Monitor engine health.",
    adjustScore: -3,
  },
  {
    pattern: /turbo|supercharger/i,
    signal: 'cascade',
    note: "Forced induction failure often cascades — oil starvation, bearing damage, and catalytic converter contamination follow.",
    adjustScore: -6,
  },

  // ── Cooling system ──────────────────────────────────────────────────────
  {
    pattern: /radiator.*(replace|crack|leak)/i,
    signal: 'watch',
    note: "Radiator failure suggests the cooling system is aging. Water pump and thermostat may follow within 12-18 months.",
    adjustScore: -2,
  },
  {
    pattern: /water pump/i,
    signal: 'one_time_fix',
    note: "Water pump is a wear item with a known interval. Standard replacement, no cascade.",
    adjustScore: +1,
  },
  {
    pattern: /coolant.*(flush|service|fill)/i,
    signal: 'neutral',
    note: "Coolant service is routine maintenance.",
    adjustScore: 0,
  },

  // ── Suspension / Steering ──────────────────────────────────────────────
  {
    pattern: /strut|shock|shock absorber/i,
    signal: 'cascade',
    note: "When struts/shocks go, control arms, bushings, and tie rods at similar mileage often follow within 6-12 months.",
    adjustScore: -3,
  },
  {
    pattern: /control arm|ball joint|tie rod|wheel bearing/i,
    signal: 'cascade',
    note: "Suspension components wear together. If one is gone, others at this mileage are close behind.",
    adjustScore: -3,
  },
  {
    pattern: /steering rack|power steering pump/i,
    signal: 'watch',
    note: "Steering system repair — monitor for continued leaks or noise. Usually doesn't cascade if fixed properly.",
    adjustScore: -2,
  },
  {
    pattern: /alignment/i,
    signal: 'neutral',
    note: "Alignment is routine — no cascade risk.",
    adjustScore: 0,
  },

  // ── Brakes ─────────────────────────────────────────────────────────────
  {
    pattern: /brake.*(pad|rotor|disc)/i,
    signal: 'one_time_fix',
    note: "Brakes are wear items with predictable intervals. Standard replacement, no cascade.",
    adjustScore: +2,
  },
  {
    pattern: /brake.*(caliper|line|hose)/i,
    signal: 'watch',
    note: "Caliper or line replacement suggests aging brake hydraulics. The other side may need attention soon.",
    adjustScore: -1,
  },
  {
    pattern: /abs.*(module|sensor|pump)/i,
    signal: 'watch',
    note: "ABS component failure is typically standalone but can indicate electrical aging.",
    adjustScore: -2,
  },

  // ── Electrical ─────────────────────────────────────────────────────────
  {
    pattern: /alternator/i,
    signal: 'one_time_fix',
    note: "Alternator is a wear item. Replace and move on.",
    adjustScore: +1,
  },
  {
    pattern: /starter/i,
    signal: 'one_time_fix',
    note: "Starter motor is a wear item. Standard replacement.",
    adjustScore: +1,
  },
  {
    pattern: /battery/i,
    signal: 'neutral',
    note: "Battery replacement is normal maintenance every 3-5 years.",
    adjustScore: 0,
  },

  // ── A/C ────────────────────────────────────────────────────────────────
  {
    pattern: /a\/?c.*(compressor|condenser)/i,
    signal: 'neutral',
    note: "A/C compressor is a standalone system. Failure doesn't indicate broader mechanical problems.",
    adjustScore: 0,
  },
  {
    pattern: /a\/?c.*(recharge|refrigerant|freon)/i,
    signal: 'neutral',
    note: "A/C recharge is routine. May indicate a slow leak — ask about leak detection.",
    adjustScore: 0,
  },

  // ── Routine maintenance (always positive) ──────────────────────────────
  {
    pattern: /oil change|oil filter|oil service/i,
    signal: 'one_time_fix',
    note: "Routine maintenance — keeping up with this extends engine life.",
    adjustScore: +2,
  },
  {
    pattern: /air filter|cabin filter/i,
    signal: 'neutral',
    note: "Filter replacement is basic maintenance.",
    adjustScore: 0,
  },
  {
    pattern: /spark plug|ignition coil/i,
    signal: 'one_time_fix',
    note: "Spark plugs and coils are interval-based. Standard tune-up work.",
    adjustScore: +1,
  },
  {
    pattern: /fluid.*(flush|service|exchange)/i,
    signal: 'neutral',
    note: "Fluid service is preventive maintenance.",
    adjustScore: 0,
  },
  {
    pattern: /tire rotation|tire balance|wheel balance/i,
    signal: 'neutral',
    note: "Routine tire maintenance.",
    adjustScore: 0,
  },
  {
    pattern: /serpentine belt|drive belt|accessory belt/i,
    signal: 'one_time_fix',
    note: "Belt replacement is interval-based. Standard wear item.",
    adjustScore: +1,
  },
  {
    pattern: /wiper/i,
    signal: 'neutral',
    note: "Wiper replacement is basic maintenance.",
    adjustScore: 0,
  },
];

export function evaluateCascade(
  description: string,
  mileage?: number,
  make?: string,
): CascadeResult {
  const lowerMake = make?.toLowerCase() || '';

  for (const rule of RULES) {
    if (!rule.pattern.test(description)) continue;

    // Make-specific filter
    if (rule.makeFilter && !rule.makeFilter.includes(lowerMake)) continue;

    // High mileage override
    if (rule.highMileageOverride && mileage && mileage > rule.highMileageOverride.mileage) {
      return {
        signal: rule.highMileageOverride.signal,
        note: rule.highMileageOverride.note,
        adjustScore: rule.highMileageOverride.adjustScore,
      };
    }

    return {
      signal: rule.signal,
      note: rule.note,
      adjustScore: rule.adjustScore,
    };
  }

  // Default: unknown service, neutral
  return {
    signal: 'neutral',
    note: "Standard service item.",
    adjustScore: 0,
  };
}

export function evaluateAllCascades(
  items: { description: string }[],
  mileage?: number,
  make?: string,
): {
  results: (CascadeResult & { description: string })[];
  totalAdjust: number;
  hasSellSignal: boolean;
  cascadeCount: number;
  summary: string;
} {
  const results = items.map(item => ({
    ...evaluateCascade(item.description, mileage, make),
    description: item.description,
  }));

  const totalAdjust = results.reduce((sum, r) => sum + r.adjustScore, 0);
  const hasSellSignal = results.some(r => r.signal === 'sell_signal');
  const cascadeCount = results.filter(r => r.signal === 'cascade').length;
  const sellSignals = results.filter(r => r.signal === 'sell_signal');
  const cascades = results.filter(r => r.signal === 'cascade');

  let summary: string;
  if (hasSellSignal) {
    summary = `⚠️ ${sellSignals[0].description} is a strong sell signal. ${sellSignals[0].note}`;
  } else if (cascadeCount >= 2) {
    summary = `Multiple cascade-risk repairs (${cascades.map(c => c.description).join(', ')}). When these pile up, more follow.`;
  } else if (cascadeCount === 1) {
    summary = `${cascades[0].description} has cascade risk: ${cascades[0].note}`;
  } else if (totalAdjust > 0) {
    summary = "These are mostly standard maintenance items. No red flags.";
  } else {
    summary = "No unusual mechanical patterns detected.";
  }

  return { results, totalAdjust, hasSellSignal, cascadeCount, summary };
}
