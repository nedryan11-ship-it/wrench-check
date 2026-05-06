// lib/fixOrSell/vehicleArchetypes.ts
// Hardcoded vehicle archetype classification.
// NOT LLM — deterministic lookup table.
//
// 5 archetypes:
//   commodity         — Depreciates predictably. High-mileage drivetrain work = death sentence.
//   reliable_appliance — Holds value through reliability, not desirability. Fix-friendly.
//   enthusiast        — Collector/durable platform. Condition > mileage. Rebuilds = investment.
//   luxury_depreciator — Rapid depreciation. Repair ratio looks fine but forward value collapse is the trap.
//   truck_work        — Utilitarian value holders. Repair makes sense because replacements are $50k+.

export type VehicleArchetype =
  | 'commodity'
  | 'reliable_appliance'
  | 'enthusiast'
  | 'luxury_depreciator'
  | 'truck_work';

export interface ArchetypeResult {
  archetype: VehicleArchetype;
  label: string;
  emoji: string;
  description: string;
  /** If true, condition capture should be requested before showing verdict */
  needsCondition: boolean;
  /** Forward annual depreciation rate estimate (% of current value lost per year) */
  annualDepreciationPct: number;
  /** Sell channels that DON'T apply for this archetype */
  excludedChannels: string[];
  /** Specialty sell channels to add */
  specialtyChannels: { label: string; emoji: string; note: string }[];
}

// ── Archetype profiles ──────────────────────────────────────────────────────

const PROFILES: Record<VehicleArchetype, Omit<ArchetypeResult, 'archetype'>> = {
  commodity: {
    label: 'Commodity Vehicle',
    emoji: '🚗',
    description: 'Standard mass-market vehicle. Value follows predictable depreciation curves.',
    needsCondition: false,
    annualDepreciationPct: 12,
    excludedChannels: [],
    specialtyChannels: [],
  },
  reliable_appliance: {
    label: 'Reliable Long-Term Appliance',
    emoji: '🔋',
    description: 'Known for longevity and low ownership costs. These cars run well past 200k miles with basic maintenance.',
    needsCondition: false,
    annualDepreciationPct: 8,
    excludedChannels: [],
    specialtyChannels: [],
  },
  enthusiast: {
    label: 'Enthusiast / Collector Vehicle',
    emoji: '🏔️',
    description: 'Holds or appreciates in value. Condition matters more than mileage. Drivetrain rebuilds are restoration investments.',
    needsCondition: true,
    annualDepreciationPct: 2,  // many appreciate
    excludedChannels: ['instant_offer'],
    specialtyChannels: [
      { label: 'Bring a Trailer / Cars & Bids', emoji: '🏆', note: 'Online enthusiast auctions. Higher prices but requires good photos & documentation.' },
      { label: 'Model-Specific Forums (IH8MUD, etc)', emoji: '🌐', note: 'Community knows the value. Informed buyers, fair prices, fast sales.' },
    ],
  },
  luxury_depreciator: {
    label: 'Luxury Depreciator',
    emoji: '📉',
    description: 'Premium brand with steep depreciation. Repair costs stay high while value drops fast — the "value trap."',
    needsCondition: false,
    annualDepreciationPct: 20,
    excludedChannels: [],
    specialtyChannels: [],
  },
  truck_work: {
    label: 'Truck / Work Vehicle',
    emoji: '🛻',
    description: 'Utilitarian value holder. Replacement cost is $45-65k+ new, so repairs almost always pencil out.',
    needsCondition: false,
    annualDepreciationPct: 7,
    excludedChannels: [],
    specialtyChannels: [],
  },
};

// ── Lookup table ─────────────────────────────────────────────────────────────
// Key: make (lowercase). Value: array of model rules.

interface ModelRule {
  model: RegExp;
  archetype: VehicleArchetype;
  minYear?: number;
  maxYear?: number;
  /** Only match specific trims (regex on full vehicle desc) */
  trimFilter?: RegExp;
}

const RULES: Record<string, ModelRule[]> = {
  // ── Toyota ──────────────────────────────────────────────────────────────
  toyota: [
    { model: /land cruiser/i, archetype: 'enthusiast' },
    { model: /4runner/i, archetype: 'enthusiast' },
    { model: /fj\s*cruiser/i, archetype: 'enthusiast' },
    { model: /tacoma/i, archetype: 'truck_work' },
    { model: /tundra/i, archetype: 'truck_work' },
    { model: /supra/i, archetype: 'enthusiast' },
    { model: /camry/i, archetype: 'reliable_appliance' },
    { model: /corolla/i, archetype: 'reliable_appliance' },
    { model: /rav4/i, archetype: 'reliable_appliance' },
    { model: /highlander/i, archetype: 'reliable_appliance' },
    { model: /prius/i, archetype: 'reliable_appliance' },
    { model: /sienna/i, archetype: 'reliable_appliance' },
    { model: /avalon/i, archetype: 'reliable_appliance' },
  ],

  // ── Lexus ───────────────────────────────────────────────────────────────
  lexus: [
    { model: /lx/i, archetype: 'enthusiast' },
    { model: /gx/i, archetype: 'enthusiast' },
    { model: /ls/i, archetype: 'luxury_depreciator' },
    { model: /es/i, archetype: 'reliable_appliance' },
    { model: /rx/i, archetype: 'reliable_appliance' },
    { model: /nx/i, archetype: 'reliable_appliance' },
    { model: /is/i, archetype: 'reliable_appliance' },
    { model: /lc/i, archetype: 'enthusiast' },
  ],

  // ── Honda ───────────────────────────────────────────────────────────────
  honda: [
    { model: /civic/i, archetype: 'reliable_appliance' },
    { model: /accord/i, archetype: 'reliable_appliance' },
    { model: /cr-?v/i, archetype: 'reliable_appliance' },
    { model: /pilot/i, archetype: 'reliable_appliance' },
    { model: /odyssey/i, archetype: 'reliable_appliance' },
    { model: /hr-?v/i, archetype: 'reliable_appliance' },
    { model: /ridgeline/i, archetype: 'truck_work' },
    { model: /s2000/i, archetype: 'enthusiast' },
    { model: /nsx/i, archetype: 'enthusiast' },
    { model: /civic type.?r/i, archetype: 'enthusiast' },
  ],

  // ── Subaru ──────────────────────────────────────────────────────────────
  subaru: [
    { model: /outback/i, archetype: 'reliable_appliance' },
    { model: /forester/i, archetype: 'reliable_appliance' },
    { model: /crosstrek/i, archetype: 'reliable_appliance' },
    { model: /wrx/i, archetype: 'enthusiast' },
    { model: /sti/i, archetype: 'enthusiast' },
    { model: /brz/i, archetype: 'enthusiast' },
  ],

  // ── Ford ────────────────────────────────────────────────────────────────
  ford: [
    { model: /f.?150/i, archetype: 'truck_work' },
    { model: /f.?250/i, archetype: 'truck_work' },
    { model: /f.?350/i, archetype: 'truck_work' },
    { model: /ranger/i, archetype: 'truck_work' },
    { model: /bronco/i, maxYear: 1996, archetype: 'enthusiast' },
    { model: /bronco/i, minYear: 2021, archetype: 'enthusiast' },
    { model: /mustang/i, archetype: 'enthusiast' },
    { model: /mustang/i, trimFilter: /ecoboost|v6/i, archetype: 'commodity' },
    { model: /gt/i, archetype: 'enthusiast' },
    { model: /raptor/i, archetype: 'enthusiast' },
    { model: /fusion/i, archetype: 'commodity' },
    { model: /escape/i, archetype: 'commodity' },
    { model: /explorer/i, archetype: 'commodity' },
    { model: /edge/i, archetype: 'commodity' },
    { model: /expedition/i, archetype: 'truck_work' },
  ],

  // ── Chevrolet ───────────────────────────────────────────────────────────
  chevrolet: [
    { model: /silverado/i, archetype: 'truck_work' },
    { model: /colorado/i, archetype: 'truck_work' },
    { model: /tahoe/i, archetype: 'truck_work' },
    { model: /suburban/i, archetype: 'truck_work' },
    { model: /corvette/i, archetype: 'enthusiast' },
    { model: /camaro/i, archetype: 'enthusiast' },
    { model: /camaro/i, trimFilter: /ls|lt/i, archetype: 'commodity' },
    { model: /malibu/i, archetype: 'commodity' },
    { model: /cruze/i, archetype: 'commodity' },
    { model: /equinox/i, archetype: 'commodity' },
    { model: /traverse/i, archetype: 'commodity' },
    { model: /blazer/i, maxYear: 2004, archetype: 'enthusiast' },
  ],

  // ── GMC ─────────────────────────────────────────────────────────────────
  gmc: [
    { model: /sierra/i, archetype: 'truck_work' },
    { model: /canyon/i, archetype: 'truck_work' },
    { model: /yukon/i, archetype: 'truck_work' },
  ],

  // ── Ram / Dodge ─────────────────────────────────────────────────────────
  ram: [
    { model: /1500/i, archetype: 'truck_work' },
    { model: /2500/i, archetype: 'truck_work' },
    { model: /3500/i, archetype: 'truck_work' },
  ],
  dodge: [
    { model: /ram/i, archetype: 'truck_work' },
    { model: /challenger/i, archetype: 'enthusiast' },
    { model: /charger/i, trimFilter: /srt|hellcat|scat/i, archetype: 'enthusiast' },
    { model: /charger/i, archetype: 'commodity' },
    { model: /durango/i, archetype: 'commodity' },
  ],

  // ── Jeep ────────────────────────────────────────────────────────────────
  jeep: [
    { model: /wrangler/i, archetype: 'enthusiast' },
    { model: /gladiator/i, archetype: 'enthusiast' },
    { model: /cherokee/i, maxYear: 2001, archetype: 'enthusiast' }, // XJ
    { model: /grand cherokee/i, archetype: 'commodity' },
    { model: /cherokee/i, minYear: 2014, archetype: 'commodity' }, // KL
    { model: /compass/i, archetype: 'commodity' },
    { model: /renegade/i, archetype: 'commodity' },
  ],

  // ── Nissan ──────────────────────────────────────────────────────────────
  nissan: [
    { model: /altima/i, archetype: 'commodity' },
    { model: /sentra/i, archetype: 'commodity' },
    { model: /rogue/i, archetype: 'commodity' },
    { model: /pathfinder/i, archetype: 'commodity' },
    { model: /titan/i, archetype: 'truck_work' },
    { model: /frontier/i, archetype: 'truck_work' },
    { model: /370z|350z|300zx/i, archetype: 'enthusiast' },
    { model: /gt-?r/i, archetype: 'enthusiast' },
  ],

  // ── BMW ─────────────────────────────────────────────────────────────────
  bmw: [
    { model: /m3/i, archetype: 'enthusiast' },
    { model: /m4/i, archetype: 'enthusiast' },
    { model: /m5/i, archetype: 'enthusiast' },
    { model: /m2/i, archetype: 'enthusiast' },
    { model: /z4/i, archetype: 'enthusiast' },
    { model: /3.series|320|328|330|335|340/i, archetype: 'luxury_depreciator' },
    { model: /5.series|525|528|530|535|540|550/i, archetype: 'luxury_depreciator' },
    { model: /7.series|740|745|750|760/i, archetype: 'luxury_depreciator' },
    { model: /x3/i, archetype: 'luxury_depreciator' },
    { model: /x5/i, archetype: 'luxury_depreciator' },
    { model: /x7/i, archetype: 'luxury_depreciator' },
  ],

  // ── Mercedes ────────────────────────────────────────────────────────────
  'mercedes-benz': [
    { model: /g.?(class|wagon|500|550|63)/i, archetype: 'enthusiast' },
    { model: /amg.?gt/i, archetype: 'enthusiast' },
    { model: /c.?(class|180|200|250|300|350|400|43|63)/i, archetype: 'luxury_depreciator' },
    { model: /e.?(class|250|300|350|400|450|53|63)/i, archetype: 'luxury_depreciator' },
    { model: /s.?(class|450|500|550|560|580|600|63|65)/i, archetype: 'luxury_depreciator' },
    { model: /gl[abces]/i, archetype: 'luxury_depreciator' },
    { model: /gle/i, archetype: 'luxury_depreciator' },
    { model: /gls/i, archetype: 'luxury_depreciator' },
  ],
  mercedes: [
    { model: /g.?(class|wagon|500|550|63)/i, archetype: 'enthusiast' },
    { model: /amg/i, archetype: 'enthusiast' },
    { model: /./i, archetype: 'luxury_depreciator' }, // catch-all
  ],

  // ── Audi ────────────────────────────────────────────────────────────────
  audi: [
    { model: /r8/i, archetype: 'enthusiast' },
    { model: /rs/i, archetype: 'enthusiast' },
    { model: /tt.?rs/i, archetype: 'enthusiast' },
    { model: /a[34568]/i, archetype: 'luxury_depreciator' },
    { model: /q[3578]/i, archetype: 'luxury_depreciator' },
    { model: /e-?tron/i, archetype: 'luxury_depreciator' },
  ],

  // ── Porsche ─────────────────────────────────────────────────────────────
  porsche: [
    { model: /911/i, archetype: 'enthusiast' },
    { model: /cayman|boxster|718/i, archetype: 'enthusiast' },
    { model: /gt[234]/i, archetype: 'enthusiast' },
    { model: /cayenne/i, archetype: 'luxury_depreciator' },
    { model: /macan/i, archetype: 'luxury_depreciator' },
    { model: /panamera/i, archetype: 'luxury_depreciator' },
    { model: /taycan/i, archetype: 'luxury_depreciator' },
  ],

  // ── Land Rover ──────────────────────────────────────────────────────────
  'land rover': [
    { model: /defender/i, archetype: 'enthusiast' },
    { model: /range rover/i, archetype: 'luxury_depreciator' },
    { model: /discovery/i, archetype: 'luxury_depreciator' },
    { model: /evoque/i, archetype: 'luxury_depreciator' },
    { model: /sport/i, archetype: 'luxury_depreciator' },
  ],

  // ── Volvo ───────────────────────────────────────────────────────────────
  volvo: [
    { model: /240|740|940/i, archetype: 'enthusiast' },
    { model: /./i, archetype: 'luxury_depreciator' },
  ],

  // ── Mazda ───────────────────────────────────────────────────────────────
  mazda: [
    { model: /miata|mx-?5/i, archetype: 'enthusiast' },
    { model: /rx-?[78]/i, archetype: 'enthusiast' },
    { model: /mazda\s*3|mazda3/i, archetype: 'reliable_appliance' },
    { model: /cx-?5/i, archetype: 'reliable_appliance' },
    { model: /cx-?9/i, archetype: 'reliable_appliance' },
    { model: /cx-?30/i, archetype: 'reliable_appliance' },
  ],

  // ── Hyundai / Kia ──────────────────────────────────────────────────────
  hyundai: [
    { model: /elantra/i, archetype: 'commodity' },
    { model: /sonata/i, archetype: 'commodity' },
    { model: /tucson/i, archetype: 'commodity' },
    { model: /santa fe/i, archetype: 'commodity' },
    { model: /palisade/i, archetype: 'commodity' },
    { model: /genesis/i, archetype: 'luxury_depreciator' },
  ],
  kia: [
    { model: /forte/i, archetype: 'commodity' },
    { model: /optima|k5/i, archetype: 'commodity' },
    { model: /sorento/i, archetype: 'commodity' },
    { model: /telluride/i, archetype: 'reliable_appliance' },
    { model: /sportage/i, archetype: 'commodity' },
    { model: /stinger/i, archetype: 'enthusiast' },
  ],

  // ── Genesis ─────────────────────────────────────────────────────────────
  genesis: [
    { model: /./i, archetype: 'luxury_depreciator' },
  ],

  // ── Infiniti / Acura ───────────────────────────────────────────────────
  infiniti: [
    { model: /./i, archetype: 'luxury_depreciator' },
  ],
  acura: [
    { model: /nsx/i, archetype: 'enthusiast' },
    { model: /integra/i, archetype: 'enthusiast' },
    { model: /rdx/i, archetype: 'reliable_appliance' },
    { model: /mdx/i, archetype: 'reliable_appliance' },
    { model: /tlx/i, archetype: 'reliable_appliance' },
  ],

  // ── Tesla ───────────────────────────────────────────────────────────────
  tesla: [
    { model: /model s/i, archetype: 'luxury_depreciator' },
    { model: /model x/i, archetype: 'luxury_depreciator' },
    { model: /model 3/i, archetype: 'reliable_appliance' },
    { model: /model y/i, archetype: 'reliable_appliance' },
  ],

  // ── VW ──────────────────────────────────────────────────────────────────
  volkswagen: [
    { model: /gti/i, archetype: 'enthusiast' },
    { model: /golf.?r/i, archetype: 'enthusiast' },
    { model: /jetta/i, archetype: 'commodity' },
    { model: /tiguan/i, archetype: 'commodity' },
    { model: /atlas/i, archetype: 'commodity' },
    { model: /passat/i, archetype: 'commodity' },
  ],
};

// ── Classification function ──────────────────────────────────────────────────

export function classifyVehicle(
  make?: string,
  model?: string,
  year?: number,
  vehicleDesc?: string,
): ArchetypeResult {
  const lowerMake = (make || '').toLowerCase().trim();
  const modelStr = model || '';
  const desc = vehicleDesc || '';

  const makeRules = RULES[lowerMake];
  if (makeRules) {
    for (const rule of makeRules) {
      if (!rule.model.test(modelStr) && !rule.model.test(desc)) continue;
      if (rule.minYear && year && year < rule.minYear) continue;
      if (rule.maxYear && year && year > rule.maxYear) continue;
      if (rule.trimFilter && !rule.trimFilter.test(desc)) continue;

      // Age-based channel exclusion: CarMax/Carvana won't buy >20yr old cars
      const currentYear = new Date().getFullYear();
      const vehicleAge = year ? currentYear - year : 0;
      const profile = PROFILES[rule.archetype];
      const excludedChannels = [...profile.excludedChannels];
      if (vehicleAge > 20 && !excludedChannels.includes('instant_offer')) {
        excludedChannels.push('instant_offer');
      }

      return {
        archetype: rule.archetype,
        ...profile,
        excludedChannels,
      };
    }
  }

  // Default: commodity, with age-based channel exclusion
  const currentYear = new Date().getFullYear();
  const vehicleAge = year ? currentYear - year : 0;
  const excluded = vehicleAge > 20 ? ['instant_offer'] : [];

  return {
    archetype: 'commodity',
    ...PROFILES.commodity,
    excludedChannels: excluded,
  };
}

// ── Decision thresholds by archetype ─────────────────────────────────────────
// Used by the engine to determine fix/sell/borderline boundaries.

export interface ArchetypeThresholds {
  /** Ratio below which we confidently say FIX */
  fixCeiling: number;
  /** Ratio above which we confidently say SELL */
  sellFloor: number;
  /** Cascade sell signals still apply? */
  cascadeSellSignals: boolean;
  /** Weight given to forward depreciation in the decision */
  depreciationWeight: number;
}

export function getArchetypeThresholds(archetype: VehicleArchetype): ArchetypeThresholds {
  switch (archetype) {
    case 'commodity':
      return { fixCeiling: 0.15, sellFloor: 0.45, cascadeSellSignals: true, depreciationWeight: 0.5 };
    case 'reliable_appliance':
      return { fixCeiling: 0.25, sellFloor: 0.55, cascadeSellSignals: true, depreciationWeight: 0.3 };
    case 'enthusiast':
      return { fixCeiling: 0.40, sellFloor: 0.75, cascadeSellSignals: false, depreciationWeight: 0.0 };
    case 'luxury_depreciator':
      return { fixCeiling: 0.12, sellFloor: 0.35, cascadeSellSignals: true, depreciationWeight: 1.0 };
    case 'truck_work':
      return { fixCeiling: 0.30, sellFloor: 0.55, cascadeSellSignals: true, depreciationWeight: 0.2 };
  }
}

// ── Valuation confidence ─────────────────────────────────────────────────────

export type ValuationConfidence = 'high' | 'medium' | 'low';

export function assessValuationConfidence(
  archetype: VehicleArchetype,
  compCount: number,
  valueSource: string,
  hasConditionInput: boolean,
): { confidence: ValuationConfidence; note: string; shouldGateVerdict: boolean } {
  // Enthusiast vehicles with no condition input = always low confidence
  if (archetype === 'enthusiast' && !hasConditionInput && compCount < 5) {
    return {
      confidence: 'low',
      note: `For enthusiast vehicles like this, condition is everything. Without knowing the body, interior, and mechanical state, any value estimate is a rough guess.`,
      shouldGateVerdict: true,
    };
  }

  if (compCount >= 5) {
    return {
      confidence: 'high',
      note: `Value based on ${compCount} comparable active listings.`,
      shouldGateVerdict: false,
    };
  }

  if (compCount >= 2) {
    return {
      confidence: 'medium',
      note: `Based on ${compCount} comparable listings. Value estimate is reasonable but could vary ±15%.`,
      shouldGateVerdict: false,
    };
  }

  if (valueSource === 'ai_estimated' || compCount < 2) {
    return {
      confidence: 'low',
      note: `Few or no comparable listings found. Value is AI-estimated and could be significantly off.`,
      shouldGateVerdict: archetype === 'enthusiast',
    };
  }

  return {
    confidence: 'medium',
    note: 'Value estimate based on available market data.',
    shouldGateVerdict: false,
  };
}
