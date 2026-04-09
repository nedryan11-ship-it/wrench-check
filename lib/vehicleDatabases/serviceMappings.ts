// lib/vehicleDatabases/serviceMappings.ts
//
// Bidirectional mapping between VDB repair API strings and canonical maintenance schedule strings.
//
// Problem: VDB maintenance schedule returns "Replace Engine Oil & Filter"
//          VDB repair estimates returns "Change - Engine oil" + "Replace - Oil filter" (two entries)
//          These never match by equality — this layer bridges them.
//
// Strategy:
//   VDB repair type → canonical service name (matching maintenance schedule strings)
//   Multiple VDB repair strings can map to the same canonical (costs are summed)

// ─── VDB Repair Type → Canonical Service Name ─────────────────────────────────
// Keys:   VDB repair estimate "type" field (exact string)
// Values: Canonical service name as returned by VDB maintenance schedule

export const VDB_REPAIR_TO_CANONICAL: Record<string, string> = {
  // Oil service — two VDB entries merged into one canonical
  "Change - Engine oil":                                  "Replace Engine Oil & Filter",
  "Replace - Oil filter":                                 "Replace Engine Oil & Filter",

  // Coolant
  "Flush/replace - Coolant":                             "Replace Engine Coolant",
  "Inspect - Coolant":                                   "Inspect Engine Coolant",

  // Air filters
  "Replace - Air filter":                                "Replace Air Cleaner Element",
  "Inspect - Air filter":                                "Inspect Air Cleaner Element",
  "Replace - Cabin air filter":                          "Replace Cabin Air Filter",
  "Clean - Cabin air filter":                            "Clean Cabin Air Filter",

  // Spark plugs
  "Replace - Spark plugs":                               "Replace Spark Plugs",

  // Tires / wheels
  "Rotate - Wheels & tires":                            "Rotate Tires",

  // Propeller shaft / drivetrain
  "Lubricate - Propeller shaft, pilot bearing & universal joints": "Lubricate Propeller Shaft",
  "Torque - Propeller shaft flange bolts":              "Retorque Propeller Shaft Bolts",

  // Brakes
  "Inspect - Brake pads, linings, discs/drums":         "Inspect Brake System",
  "Inspect - Brake lines, hoses & connections":         "Inspect Brake Line\\hose Connections",
  "Replace - Brake fluid":                              "Replace Brake Fluid",

  // Steering / suspension
  "Inspect - Ball joints & dust covers":                "Inspect Ball Joint & Dust Covers",
  "Inspect - Steering linkage":                         "Inspect Steering Linkage & Boots",
  "Inspect - Steering gearbox":                         "Inspect Steering System",

  // Drivetrain fluids
  "Inspect - Front differential fluid":                 "Inspect Front Axle Fluid",
  "Replace - Front differential fluid":                 "Replace Front Axle Fluid",
  "Inspect - Rear differential fluid":                  "Inspect Rear Axle Fluid",
  "Replace - Rear differential fluid":                  "Replace Rear Axle Fluid",
  "Inspect - Transfer case fluid":                      "Inspect Transfer Case Fluid",
  "Replace - Transfer case fluid":                      "Replace Transfer Case Fluid",
  "Inspect - Automatic transmission fluid":             "Inspect Automatic Transaxle (CVT) Fluid",
  "Replace - Automatic transmission fluid":             "Replace Automatic Transaxle (CVT) Fluid",

  // Drive belt / timing
  "Inspect - Drive belt(s)":                            "Inspect Drive Belts",
  "Replace - Drive belt(s)":                            "Replace Drive Belts",
  "Inspect - Timing belt":                              "Replace Timing Belt",

  // Exhaust / cooling system
  "Inspect - Exhaust system":                           "Inspect Exhaust Pipes & Mounts",
  "Inspect - Radiator core & AC condenser":             "Inspect Radiator & Condenser",

  // Fuel system
  "Inspect - Fuel system":                              "Inspect Fuel System",
  "Inspect - Fuel filler cap":                          "Inspect Fuel Filler Cap",
  "Replace - Fuel filter":                              "Replace Fuel Filter",

  // General / misc
  "Inspect - Fluid levels":                             "Inspect Fluid Levels",
  "Inspect - Floor mats":                               "Check Driver's Floor Mat",
  "Inspect - Windshield wiper blades/inserts":          "Inspect Wiper Blades",
  "Inspect boots & seals - Drive shaft":                "Inspect Driveshaft Boots",
  "Inspect boots & seals - Steering":                   "Inspect Steering Linkage & Boots",

  // Engine
  "Inspect - Engine":                                   "Inspect Engine",
  "Inspect - Idle speed":                               "Inspect Idle Speed",
  "Replace - PCV valve":                                "Replace PCV Valve",
};

// ─── Reverse lookup: Canonical → [VDB Repair Types] ──────────────────────────
// Auto-generated from the forward map above.

export const CANONICAL_TO_VDB_REPAIR: Record<string, string[]> = (() => {
  const reverse: Record<string, string[]> = {};
  for (const [vdbType, canonical] of Object.entries(VDB_REPAIR_TO_CANONICAL)) {
    if (!reverse[canonical]) reverse[canonical] = [];
    reverse[canonical].push(vdbType);
  }
  return reverse;
})();

// ─── Fuzzy canonical lookup ───────────────────────────────────────────────────
// When an exact match isn't found, try keyword-based matching.
// Returns the best canonical match or null.

export function fuzzyCanonicalMatch(vdbRepairType: string): string | null {
  const lower = vdbRepairType.toLowerCase();

  // Direct lookup first
  if (VDB_REPAIR_TO_CANONICAL[vdbRepairType]) {
    return VDB_REPAIR_TO_CANONICAL[vdbRepairType];
  }

  // Keyword fallbacks
  if (lower.includes("engine oil") || lower.includes("oil change")) return "Replace Engine Oil & Filter";
  if (lower.includes("oil filter")) return "Replace Engine Oil & Filter";
  if (lower.includes("coolant") && lower.includes("flush")) return "Replace Engine Coolant";
  if (lower.includes("coolant")) return "Inspect Engine Coolant";
  if (lower.includes("cabin air")) return lower.includes("replace") ? "Replace Cabin Air Filter" : "Clean Cabin Air Filter";
  if (lower.includes("air filter") || lower.includes("air cleaner")) return "Replace Air Cleaner Element";
  if (lower.includes("spark plug")) return "Replace Spark Plugs";
  if (lower.includes("tire") || lower.includes("wheel rotation")) return "Rotate Tires";
  if (lower.includes("brake fluid")) return "Replace Brake Fluid";
  if (lower.includes("brake")) return "Inspect Brake System";
  if (lower.includes("transmission") || lower.includes("transaxle")) return "Inspect Automatic Transaxle (CVT) Fluid";
  if (lower.includes("differential") && lower.includes("front")) return "Inspect Front Axle Fluid";
  if (lower.includes("differential") && lower.includes("rear")) return "Inspect Rear Axle Fluid";
  if (lower.includes("transfer case")) return "Inspect Transfer Case Fluid";
  if (lower.includes("timing belt")) return "Replace Timing Belt";
  if (lower.includes("drive belt")) return lower.includes("replace") ? "Replace Drive Belts" : "Inspect Drive Belts";
  if (lower.includes("fuel filter")) return "Replace Fuel Filter";
  if (lower.includes("spark")) return "Replace Spark Plugs";

  return null;
}
