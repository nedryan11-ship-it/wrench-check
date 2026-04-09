// lib/services/canonicalServices.ts
//
// Canonical service registry — the single source of truth for all service identity.
// Used by: Maintenance Debt Audit, Repair Quote Audit, Pricing, Negotiation, Chat.
//
// Every raw service string from any source (VDB schedule, VDB pricing, CARFAX,
// shop receipts, user text) must map to a CanonicalService before entering
// any downstream logic.

// ─── Canonical service enum ───────────────────────────────────────────────────

export type CanonicalService =
  // Fluids
  | "engine_oil_change"
  | "transmission_fluid_service"
  | "brake_fluid_service"
  | "power_steering_fluid_service"
  // Drivetrain
  | "axle_fluid_service"          // front OR rear differential
  | "transfer_case_fluid_service"
  | "propeller_shaft_service"     // lubrication + bolt retorque
  // Cooling
  | "coolant_service"
  | "water_pump_replacement"
  // Ignition
  | "spark_plug_replacement"
  // Filters
  | "air_filter_replacement"
  | "cabin_filter_replacement"
  | "fuel_filter_replacement"
  // Belts
  | "serpentine_belt_replacement"
  | "timing_belt_service"
  // Brakes
  | "brake_pad_replacement"
  | "brake_inspection"
  // Wheels
  | "tire_rotation"
  // Electrical
  | "battery_replacement"
  // Catch-all
  | "unknown_service";

// ─── Service category ─────────────────────────────────────────────────────────

export type CanonicalServiceCategory =
  | "fluids"
  | "ignition"
  | "belts"
  | "filters"
  | "brakes"
  | "cooling"
  | "drivetrain"
  | "electrical"
  | "other";

// ─── Service definition ───────────────────────────────────────────────────────

export type CanonicalServiceDefinition = {
  key: CanonicalService;
  displayName: string;
  category: CanonicalServiceCategory;
  /**
   * Human-readable common names. Used as LLM context and general-purpose matching.
   * Examples: "oil change", "LOF", "engine oil service"
   */
  aliases: string[];
  /**
   * Keywords found in VDB maintenance *schedule* strings.
   * Normalized (lowercase, punctuation removed). Longer = more specific.
   * Examples: "replace engine oil and filter", "engine oil change"
   */
  scheduleKeywords: string[];
  /**
   * Keywords found in VDB *repair estimate* type strings.
   * Normalized. Examples: "change engine oil", "replace oil filter"
   */
  pricingKeywords: string[];
  /**
   * Keywords found in shop receipts, CARFAX records, user-pasted history.
   * Examples: "oil and filter change", "full synthetic", "lof"
   */
  shopKeywords: string[];
};

// ─── Registry ─────────────────────────────────────────────────────────────────
// Ordered most → least specific for intent.
// 25 services covering ~95% of real-world maintenance activity.

export const CANONICAL_SERVICE_REGISTRY: CanonicalServiceDefinition[] = [
  // ── Fluids ────────────────────────────────────────────────────────────────

  {
    key: "engine_oil_change",
    displayName: "Engine Oil & Filter Change",
    category: "fluids",
    aliases: ["oil change", "lof", "lube oil filter", "oil service", "engine oil service"],
    scheduleKeywords: [
      "replace engine oil and filter",
      "engine oil and filter",
      "engine oil filter",
      "replace engine oil",
      "engine oil change",
    ],
    pricingKeywords: [
      "change engine oil",
      "replace oil filter",
      "engine oil service",
      "oil and filter change",
    ],
    shopKeywords: [
      "oil and filter change",
      "full synthetic oil",
      "synthetic oil service",
      "conventional oil service",
      "oil change service",
      "oil service",
      "oil and filter",
      "oil change",
      "lof",
      "lube oil filter",
      "engine oil",
    ],
  },

  {
    key: "transmission_fluid_service",
    displayName: "Transmission Fluid Service",
    category: "fluids",
    aliases: ["transmission service", "transmission fluid", "trans fluid", "cvt fluid"],
    scheduleKeywords: [
      "replace automatic transaxle",
      "transaxle fluid",
      "transmission fluid",
      "cvt fluid",
      "automatic transmission fluid",
    ],
    pricingKeywords: [
      "automatic transmission fluid",
      "transmission fluid service",
      "transaxle fluid",
      "cvt fluid",
    ],
    shopKeywords: [
      "transmission drain and fill",
      "automatic transmission service",
      "cvt fluid service",
      "transmission fluid change",
      "transmission service",
      "trans fluid",
      "transmission fluid",
      "gear oil change",
      "manual transmission",
    ],
  },

  {
    key: "brake_fluid_service",
    displayName: "Brake Fluid Flush",
    category: "brakes",
    aliases: ["brake fluid flush", "brake fluid service", "brake bleed"],
    scheduleKeywords: [
      "replace brake fluid",
      "brake fluid",
    ],
    pricingKeywords: [
      "replace brake fluid",
      "brake fluid flush",
      "brake fluid",
    ],
    shopKeywords: [
      "brake fluid flush",
      "brake fluid service",
      "brake fluid change",
      "brake bleed",
      "dot3 fluid",
      "dot4 fluid",
      "brake fluid",
    ],
  },

  {
    key: "power_steering_fluid_service",
    displayName: "Power Steering Fluid Service",
    category: "fluids",
    aliases: ["power steering flush", "power steering service", "ps fluid service"],
    scheduleKeywords: [
      "power steering fluid",
      "steering fluid",
      "replace power steering",
    ],
    pricingKeywords: [
      "power steering fluid",
      "steering fluid service",
      "power steering service",
    ],
    shopKeywords: [
      "power steering flush",
      "power steering service",
      "power steering fluid change",
      "ps fluid",
      "chf11s",
      "power steering fluid",
      "steering fluid",
    ],
  },

  // ── Drivetrain ────────────────────────────────────────────────────────────

  {
    key: "axle_fluid_service",
    displayName: "Axle / Differential Fluid Service",
    category: "drivetrain",
    aliases: ["differential service", "diff service", "axle fluid", "differential fluid"],
    scheduleKeywords: [
      "replace front axle fluid",
      "replace rear axle fluid",
      "front axle fluid",
      "rear axle fluid",
      "axle fluid",
      "differential fluid",
    ],
    pricingKeywords: [
      "front differential fluid",
      "rear differential fluid",
      "differential fluid",
      "axle fluid",
    ],
    shopKeywords: [
      "differential drain and fill",
      "front differential service",
      "rear differential service",
      "differential service",
      "diff fluid",
      "axle fluid service",
      "front diff",
      "rear diff",
      "differential",
    ],
  },

  {
    key: "transfer_case_fluid_service",
    displayName: "Transfer Case Fluid Service",
    category: "drivetrain",
    aliases: ["transfer case service", "transfer case fluid", "4wd fluid"],
    scheduleKeywords: [
      "replace transfer case fluid",
      "transfer case fluid",
      "transfer case",
    ],
    pricingKeywords: [
      "replace transfer case fluid",
      "transfer case fluid",
      "transfer case service",
    ],
    shopKeywords: [
      "transfer case fluid change",
      "transfer case service",
      "4wd fluid service",
      "4x4 fluid service",
      "transfer case fluid",
      "transfer case",
    ],
  },

  {
    key: "propeller_shaft_service",
    displayName: "Propeller Shaft Service",
    category: "drivetrain",
    aliases: ["propeller shaft", "driveshaft service", "propshaft lubrication"],
    scheduleKeywords: [
      "lubricate propeller shaft",
      "retorque propeller shaft",
      "propeller shaft",
    ],
    pricingKeywords: [
      "lubricate propeller shaft pilot bearing",
      "torque propeller shaft flange",
      "propeller shaft",
    ],
    shopKeywords: [
      "driveshaft lubrication",
      "propeller shaft service",
      "u joint lubrication",
      "propshaft service",
      "propeller shaft",
    ],
  },

  // ── Cooling ───────────────────────────────────────────────────────────────

  {
    key: "coolant_service",
    displayName: "Coolant / Antifreeze Service",
    category: "cooling",
    aliases: ["coolant flush", "coolant service", "antifreeze service", "cooling system flush"],
    scheduleKeywords: [
      "replace engine coolant",
      "flush replace coolant",
      "engine coolant",
      "coolant",
    ],
    pricingKeywords: [
      "flush replace coolant",
      "coolant flush",
      "engine coolant",
      "coolant",
    ],
    shopKeywords: [
      "cooling system flush",
      "coolant exchange",
      "coolant flush",
      "antifreeze flush",
      "coolant service",
      "antifreeze service",
      "radiator flush",
      "coolant",
      "antifreeze",
    ],
  },

  {
    key: "water_pump_replacement",
    displayName: "Water Pump Replacement",
    category: "cooling",
    aliases: ["water pump", "water pump replacement"],
    scheduleKeywords: ["replace water pump", "water pump"],
    pricingKeywords: ["water pump replacement", "replace water pump", "water pump"],
    shopKeywords: ["water pump replacement", "water pump replaced", "water pump", "waterpump"],
  },

  // ── Ignition ──────────────────────────────────────────────────────────────

  {
    key: "spark_plug_replacement",
    displayName: "Spark Plug Replacement",
    category: "ignition",
    aliases: ["spark plugs", "spark plug replacement", "tuneup"],
    scheduleKeywords: ["replace spark plugs", "spark plugs"],
    pricingKeywords: ["replace spark plugs", "spark plugs"],
    shopKeywords: [
      "spark plug replacement",
      "spark plugs replaced",
      "spark plugs",
      "plugs replaced",
      "tune up",
      "tune-up",
      "iridium plugs",
    ],
  },

  // ── Filters ───────────────────────────────────────────────────────────────

  {
    key: "air_filter_replacement",
    displayName: "Engine Air Filter Replacement",
    category: "filters",
    aliases: ["air filter", "engine air filter", "air cleaner"],
    scheduleKeywords: [
      "replace air cleaner element",
      "inspect air cleaner element",
      "air cleaner element",
      "replace air filter",
      "air filter",
    ],
    pricingKeywords: ["replace air filter", "air filter"],
    shopKeywords: [
      "engine air filter replacement",
      "engine air filter",
      "air filter change",
      "air filter replacement",
      "air cleaner replacement",
      "air filter",
    ],
  },

  {
    key: "cabin_filter_replacement",
    displayName: "Cabin Air Filter Replacement",
    category: "filters",
    aliases: ["cabin filter", "cabin air filter", "pollen filter", "hvac filter"],
    scheduleKeywords: [
      "replace cabin air filter",
      "clean cabin air filter",
      "cabin air filter",
    ],
    pricingKeywords: [
      "replace cabin air filter",
      "clean cabin air filter",
      "cabin air filter",
    ],
    shopKeywords: [
      "cabin air filter replacement",
      "cabin filter replacement",
      "cabin air filter",
      "pollen filter",
      "hvac filter",
      "interior air filter",
      "cabin filter",
    ],
  },

  {
    key: "fuel_filter_replacement",
    displayName: "Fuel Filter Replacement",
    category: "filters",
    aliases: ["fuel filter", "fuel filter replacement"],
    scheduleKeywords: ["replace fuel filter", "fuel filter"],
    pricingKeywords: ["replace fuel filter", "fuel filter"],
    shopKeywords: [
      "fuel filter replacement",
      "fuel filter change",
      "fuel filter",
    ],
  },

  // ── Belts ─────────────────────────────────────────────────────────────────

  {
    key: "serpentine_belt_replacement",
    displayName: "Drive / Serpentine Belt Replacement",
    category: "belts",
    aliases: ["drive belt", "serpentine belt", "accessory belt", "fan belt"],
    scheduleKeywords: [
      "replace drive belts",
      "inspect drive belts",
      "drive belt",
      "serpentine belt",
      "accessory belt",
    ],
    pricingKeywords: [
      "replace drive belts",
      "inspect drive belts",
      "drive belt",
    ],
    shopKeywords: [
      "serpentine belt replacement",
      "drive belt replacement",
      "belt replacement",
      "accessory belt replacement",
      "serpentine belt",
      "drive belt",
      "fan belt",
      "v belt",
    ],
  },

  {
    key: "timing_belt_service",
    displayName: "Timing Belt / Chain Service",
    category: "belts",
    aliases: ["timing belt", "timing chain", "timing kit"],
    scheduleKeywords: ["replace timing belt", "timing belt", "timing chain"],
    pricingKeywords: ["timing belt replacement", "timing belt", "timing chain"],
    shopKeywords: [
      "timing belt replacement",
      "timing chain service",
      "timing kit",
      "timing belt",
      "timing chain",
      "cam belt",
    ],
  },

  // ── Brakes ────────────────────────────────────────────────────────────────

  {
    key: "brake_pad_replacement",
    displayName: "Brake Pad / Shoe Replacement",
    category: "brakes",
    aliases: ["brake pads", "brake service", "brake pad replacement"],
    scheduleKeywords: ["replace brake pads", "brake pads", "brake linings"],
    pricingKeywords: [
      "replace brake pads linings",
      "brake pads",
      "brake shoes",
    ],
    shopKeywords: [
      "brake pad replacement",
      "brake pads replaced",
      "front brake pads",
      "rear brake pads",
      "brake service",
      "pads replaced",
      "brake pads",
      "brake shoes",
    ],
  },

  {
    key: "brake_inspection",
    displayName: "Brake System Inspection",
    category: "brakes",
    aliases: ["brake inspection", "brake check"],
    scheduleKeywords: [
      "inspect brake system",
      "inspect brake line",
      "brake inspection",
    ],
    pricingKeywords: [
      "inspect brake pads linings discs",
      "inspect brake lines hoses",
      "inspect brake",
    ],
    shopKeywords: [
      "brake inspection",
      "brake system inspection",
      "brake check",
      "brake systems checked",
    ],
  },

  // ── Wheels ────────────────────────────────────────────────────────────────

  {
    key: "tire_rotation",
    displayName: "Tire Rotation",
    category: "other",
    aliases: ["tire rotation", "rotate tires", "wheel rotation"],
    scheduleKeywords: ["rotate tires"],
    pricingKeywords: ["rotate wheels and tires", "wheel rotation", "rotate wheels"],
    shopKeywords: [
      "tire rotation",
      "rotate tires",
      "tire rotate",
      "wheel rotation",
      "rotation",
    ],
  },

  // ── Electrical ────────────────────────────────────────────────────────────

  {
    key: "battery_replacement",
    displayName: "Battery Replacement",
    category: "electrical",
    aliases: ["battery replacement", "battery service", "new battery"],
    scheduleKeywords: ["replace battery", "battery replacement", "battery"],
    pricingKeywords: ["battery replacement", "replace battery", "battery"],
    shopKeywords: [
      "battery replacement",
      "battery replaced",
      "battery installed",
      "battery change",
      "new battery",
      "battery",
    ],
  },

  // ── Catch-all ─────────────────────────────────────────────────────────────

  {
    key: "unknown_service",
    displayName: "Unknown Service",
    category: "other",
    aliases: [],
    scheduleKeywords: [],
    pricingKeywords: [],
    shopKeywords: [],
  },
];

// ─── Fast lookup by key ────────────────────────────────────────────────────────

export const CANONICAL_SERVICE_BY_KEY = new Map<CanonicalService, CanonicalServiceDefinition>(
  CANONICAL_SERVICE_REGISTRY.map(def => [def.key, def])
);
