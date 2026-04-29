// lib/vehicleDatabases/vinIntelligence.ts
// VIN validation, NHTSA recall lookup, and hardcoded model-year critical issues.
// Sources: NHTSA complaints database, TSBs, class action settlements, owner forums.

export interface VinIntelligence {
  recalls: { component: string; summary: string; consequence: string }[];
  recallCount: number;
  knownIssues: KnownIssue[];
  riskLevel: "low" | "medium" | "high";
  vinValid: boolean;
}

export interface KnownIssue {
  issue: string;
  severity: "high" | "medium" | "low";
  estimatedCost: number;
  source?: string; // "NHTSA TSB" | "Class Action" | "Forum Pattern"
}

// ── Hardcoded model-year critical issues ──────────────────────────────────────
// Key format: "make:model" OR "make:model:yearStart-yearEnd"
// make/model in lowercase. Matched by contains logic (partial match ok).
const MODEL_KNOWN_ISSUES: Record<string, KnownIssue[]> = {
  // ── LEXUS ──────────────────────────────────────────────────────────────────
  "lexus:rx 350:2016-2021": [
    { issue: "Remote Touch infotainment pad failure (LCD/digitizer separation)", severity: "medium", estimatedCost: 850, source: "Forum Pattern" },
    { issue: "2GR-FKS oil consumption (check at every oil change)", severity: "medium", estimatedCost: 600, source: "NHTSA Complaints" },
  ],
  "lexus:rx 350": [
    { issue: "Water pump failure at 80–120k mi (3.5L V6)", severity: "medium", estimatedCost: 950 },
    { issue: "Brake actuator replacement (ABS VSC pump noise)", severity: "medium", estimatedCost: 2800, source: "NHTSA TSB" },
  ],
  "lexus:rx 300": [
    { issue: "Sludge-prone 3.0L V6 (1MZ-FE) if not changed every 3–5k", severity: "high", estimatedCost: 5000 },
  ],
  // ── TOYOTA ─────────────────────────────────────────────────────────────────
  "toyota:4runner:2003-2009": [
    { issue: "Frame perforation rust (Toyota settled $3.4B class action)", severity: "high", estimatedCost: 0, source: "Class Action" },
    { issue: "Rear trailing arm bracket rust-through", severity: "high", estimatedCost: 3500 },
    { issue: "Rusted-out spare tire carrier mount", severity: "medium", estimatedCost: 600 },
  ],
  "toyota:4runner": [
    { issue: "Rear differential fluid neglect leading to gear wear", severity: "medium", estimatedCost: 300 },
    { issue: "Lower ball joint wear (inspect at 80k+)", severity: "medium", estimatedCost: 700 },
  ],
  "toyota:land cruiser:2003-2007": [
    { issue: "Head gasket failure on 4.7L 2UZ-FE V8 (150k+ mi)", severity: "high", estimatedCost: 5500 },
    { issue: "Air injection system rust-out (P0491/P0492)", severity: "medium", estimatedCost: 750 },
  ],
  "toyota:land cruiser:2008-2021": [
    { issue: "Front differential oil leak (pinion seal)", severity: "medium", estimatedCost: 600 },
    { issue: "Rear air suspension compressor failure", severity: "medium", estimatedCost: 1800 },
  ],
  "toyota:highlander:2014-2019": [
    { issue: "2GR-FE oil sludge syndrome (5k oil changes mandatory)", severity: "high", estimatedCost: 5000 },
  ],
  "toyota:prius:2004-2010": [
    { issue: "Gen2 hybrid battery degradation (replace ~$2k)", severity: "high", estimatedCost: 2200 },
    { issue: "Oxygen sensor and catalytic converter failure at high mileage", severity: "medium", estimatedCost: 1200 },
  ],
  // ── CHEVROLET ──────────────────────────────────────────────────────────────
  "chevrolet:tahoe:2014-2019": [
    { issue: "AFM/DoD lifter failure (Active Fuel Management L83/L86)", severity: "high", estimatedCost: 8000, source: "Class Action" },
    { issue: "8L90 transmission shudder (torque converter fluid)", severity: "high", estimatedCost: 3500 },
    { issue: "AC evaporator leak (behind dash)", severity: "medium", estimatedCost: 1400 },
    { issue: "Transfer case fluid contamination", severity: "medium", estimatedCost: 800 },
  ],
  "chevrolet:tahoe:2020-2024": [
    { issue: "10-speed transmission hesitation at low speeds (TSB available)", severity: "low", estimatedCost: 0, source: "NHTSA TSB" },
    { issue: "IRS rear suspension bushing wear (new platform)", severity: "medium", estimatedCost: 1200 },
    { issue: "5.3L L84 AFM still present in base trims", severity: "high", estimatedCost: 8000 },
  ],
  "chevrolet:suburban:2014-2019": [
    { issue: "AFM/DoD lifter failure (same L83 engine as Tahoe)", severity: "high", estimatedCost: 8000, source: "Class Action" },
    { issue: "Differential fluid service neglect on all 4 corners", severity: "medium", estimatedCost: 400 },
  ],
  "chevrolet:silverado:2014-2019": [
    { issue: "AFM lifter failure (Gen V V8 — extremely common)", severity: "high", estimatedCost: 8000, source: "Class Action" },
  ],
  // ── FORD ───────────────────────────────────────────────────────────────────
  "ford:expedition:2018-2024": [
    { issue: "3.5L EcoBoost timing chain stretch/rattle (60k+ mi)", severity: "high", estimatedCost: 4500 },
    { issue: "10R80 transmission shudder at low speed", severity: "medium", estimatedCost: 1800 },
    { issue: "Panoramic moonroof glass shattering (NHTSA investigation)", severity: "medium", estimatedCost: 1200, source: "NHTSA" },
  ],
  "ford:f-150:2018-2024": [
    { issue: "10R80 10-speed transmission hesitation (very common)", severity: "medium", estimatedCost: 1500 },
    { issue: "3.5L EcoBoost Phase 2 — better than Phase 1 but still monitor chain", severity: "low", estimatedCost: 1200 },
  ],
  "ford:f-150:2011-2017": [
    { issue: "3.5L EcoBoost Phase 1 timing chain (85k+ mi)", severity: "high", estimatedCost: 4000 },
    { issue: "Spark plug blow-out on 6.2L V8", severity: "medium", estimatedCost: 800 },
  ],
  // ── HYUNDAI / KIA ──────────────────────────────────────────────────────────
  "hyundai:santa fe:2019-2022": [
    { issue: "Theta II 2.5T GDI engine seizure (NHTSA recall active)", severity: "high", estimatedCost: 12000, source: "Class Action" },
    { issue: "Dual-clutch DCT judder on cold starts (software TSB)", severity: "low", estimatedCost: 0, source: "NHTSA TSB" },
  ],
  "hyundai:santa fe:2013-2018": [
    { issue: "Theta II 2.4L GDI engine seize (recall — verify completion)", severity: "high", estimatedCost: 12000, source: "NHTSA Recall" },
  ],
  "hyundai:tucson:2016-2021": [
    { issue: "2.0L/2.4L GDI Theta II engine seize recall", severity: "high", estimatedCost: 12000, source: "NHTSA Recall" },
  ],
  "kia:sorento:2015-2020": [
    { issue: "Theta II engine recall (same as Hyundai Santa Fe)", severity: "high", estimatedCost: 12000, source: "NHTSA Recall" },
  ],
  // ── LINCOLN ────────────────────────────────────────────────────────────────
  "lincoln:corsair:2020-2024": [
    { issue: "1.5L/2.0L EcoBoost intake valve carbon buildup (GDI)", severity: "medium", estimatedCost: 700 },
    { issue: "PHEV battery module degradation (Corsair Grand Touring)", severity: "high", estimatedCost: 14000 },
    { issue: "Panoramic moonroof noise/wind leak", severity: "low", estimatedCost: 400 },
  ],
  "lincoln:navigator:2018-2023": [
    { issue: "3.5L EcoBoost Phase 2 timing chain (monitor oil change intervals)", severity: "medium", estimatedCost: 2000 },
    { issue: "Air suspension compressor failure (known on all Navigator trims)", severity: "high", estimatedCost: 2500 },
  ],
  // ── GMC ────────────────────────────────────────────────────────────────────
  "gmc:yukon:2014-2019": [
    { issue: "AFM/DoD lifter failure (same GM L83/L86 V8)", severity: "high", estimatedCost: 8000, source: "Class Action" },
    { issue: "8-speed shudder (same 8L90 as Tahoe)", severity: "high", estimatedCost: 3500 },
  ],
  "gmc:sierra:2014-2019": [
    { issue: "AFM lifter collapse (5.3L Gen V — widespread)", severity: "high", estimatedCost: 8000, source: "Class Action" },
  ],
  // ── HONDA ──────────────────────────────────────────────────────────────────
  "honda:pilot:2016-2019": [
    { issue: "9-speed transmission jerking/hunting in gears (very common)", severity: "high", estimatedCost: 4500 },
    { issue: "I-VTM4 AWD fluid service neglect", severity: "medium", estimatedCost: 300 },
  ],
  "honda:passport:2019-2024": [
    { issue: "9 & 10-speed ZF transmission judder (same ZF unit as Pilot)", severity: "medium", estimatedCost: 2000 },
  ],
  "honda:odyssey:2018-2021": [
    { issue: "9-speed ZF transmission shudder", severity: "high", estimatedCost: 4500 },
    { issue: "Sliding door motor failure", severity: "medium", estimatedCost: 700 },
  ],
  // ── DODGE / RAM ────────────────────────────────────────────────────────────
  "ram:1500:2019-2023": [
    { issue: "8-speed ZF8HP eTorque belt-starter wear in mild hybrid", severity: "medium", estimatedCost: 1200 },
    { issue: "Panoramic sunroof wind noise (TSB)", severity: "low", estimatedCost: 0, source: "NHTSA TSB" },
    { issue: "Active exhaust valve failure (5.7L HEMI)", severity: "low", estimatedCost: 400 },
  ],
  "dodge:durango:2014-2020": [
    { issue: "5.7L HEMI MDS lifter failure (same AFM variant as GM)", severity: "high", estimatedCost: 6000 },
    { issue: "Front differential leaks (AWD models)", severity: "medium", estimatedCost: 500 },
  ],
};

export function getModelKnownIssues(year: number, make: string, model: string): KnownIssue[] {
  const makeKey = make.toLowerCase().trim();
  const modelKey = model.toLowerCase().trim();
  const issues: KnownIssue[] = [];
  const seen = new Set<string>();

  for (const [key, vals] of Object.entries(MODEL_KNOWN_ISSUES)) {
    const parts = key.split(":");
    if (parts.length < 2) continue;

    const km = parts[0].trim();
    const kmod = parts[1].trim();
    const kyears = parts[2]; // optional "2015-2019"

    // Make must match exactly
    if (km !== makeKey) continue;

    // Model: partial match in either direction
    const modelMatches =
      modelKey.includes(kmod) ||
      kmod.includes(modelKey.split(" ")[0]) ||
      modelKey.split(" ")[0].includes(kmod.split(" ")[0]);
    if (!modelMatches) continue;

    // Year range filter
    if (kyears) {
      const [yStart, yEnd] = kyears.split("-").map(Number);
      if (year < yStart || year > yEnd) continue;
    }

    for (const v of vals) {
      if (!seen.has(v.issue)) {
        seen.add(v.issue);
        issues.push(v);
      }
    }
  }

  return issues;
}

export async function fetchNhtsaRecalls(
  vin: string
): Promise<VinIntelligence["recalls"]> {
  if (!vin || vin.length !== 17) return [];
  try {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 8000);
    const res = await fetch(
      `https://api.nhtsa.gov/recalls/recallsByVehicle?vin=${encodeURIComponent(vin)}&format=json`,
      { signal: abort.signal }
    );
    clearTimeout(timer);
    if (!res.ok) return [];
    const data = await res.json();
    const results: any[] = data?.results || data?.Results || [];
    return results.slice(0, 6).map((r: any) => ({
      component: r.Component || r.component || "Unknown component",
      summary: (r.Summary || r.summary || "").slice(0, 200),
      consequence: (r.Consequence || r.consequence || "").slice(0, 150),
    }));
  } catch {
    return [];
  }
}

export async function buildVinIntelligence(
  vin: string | null,
  year: number,
  make: string,
  model: string
): Promise<VinIntelligence> {
  const knownIssues = getModelKnownIssues(year, make, model);
  const recalls = vin ? await fetchNhtsaRecalls(vin) : [];

  const highCount = knownIssues.filter((i) => i.severity === "high").length;
  const riskLevel: VinIntelligence["riskLevel"] =
    highCount >= 2 || recalls.length >= 3
      ? "high"
      : highCount >= 1 || recalls.length >= 1
      ? "medium"
      : "low";

  return {
    recalls,
    recallCount: recalls.length,
    knownIssues,
    riskLevel,
    vinValid: !!(vin && vin.length === 17 && /^[A-HJ-NPR-Z0-9]{17}$/.test(vin)),
  };
}
