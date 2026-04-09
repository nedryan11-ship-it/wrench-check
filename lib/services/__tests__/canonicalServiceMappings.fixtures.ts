// lib/services/__tests__/canonicalServiceMappings.fixtures.ts
//
// Test fixtures for the canonical service mapping system.
// Run with: npx ts-node -e "require('./lib/services/__tests__/canonicalServiceMappings.fixtures')"
// Or wire into your test framework of choice.

import { mapToCanonicalService } from "../mapToCanonicalService";
import type { ServiceSourceType } from "../mapToCanonicalService";

type Fixture = {
  input: string;
  sourceType: ServiceSourceType;
  expectedCanonical: string;
  expectedMinConfidence: "high" | "medium" | "low";
  note?: string;
};

export const MAPPING_FIXTURES: Fixture[] = [
  // ── Oil service ─────────────────────────────────────────────────────────────
  { input: "Change - Engine oil",            sourceType: "pricing",  expectedCanonical: "engine_oil_change",             expectedMinConfidence: "high" },
  { input: "Replace Engine Oil & Filter",    sourceType: "schedule", expectedCanonical: "engine_oil_change",             expectedMinConfidence: "high" },
  { input: "Oil service",                    sourceType: "history",  expectedCanonical: "engine_oil_change",             expectedMinConfidence: "high" },
  { input: "LOF",                            sourceType: "history",  expectedCanonical: "engine_oil_change",             expectedMinConfidence: "high" },
  { input: "lube oil filter",                sourceType: "history",  expectedCanonical: "engine_oil_change",             expectedMinConfidence: "high" },
  { input: "Full synthetic oil and filter",  sourceType: "history",  expectedCanonical: "engine_oil_change",             expectedMinConfidence: "medium" },

  // ── Coolant ─────────────────────────────────────────────────────────────────
  { input: "Flush/replace - Coolant",        sourceType: "pricing",  expectedCanonical: "coolant_service",               expectedMinConfidence: "high" },
  { input: "Replace Engine Coolant",         sourceType: "schedule", expectedCanonical: "coolant_service",               expectedMinConfidence: "high" },
  { input: "Coolant flush",                  sourceType: "history",  expectedCanonical: "coolant_service",               expectedMinConfidence: "high" },
  { input: "Antifreeze flush",               sourceType: "history",  expectedCanonical: "coolant_service",               expectedMinConfidence: "medium" },

  // ── Brake fluid ─────────────────────────────────────────────────────────────
  { input: "Brake fluid flush",              sourceType: "history",  expectedCanonical: "brake_fluid_service",           expectedMinConfidence: "high" },
  { input: "Replace brake fluid",            sourceType: "schedule", expectedCanonical: "brake_fluid_service",           expectedMinConfidence: "high" },
  { input: "DOT4 brake fluid service",       sourceType: "quote",    expectedCanonical: "brake_fluid_service",           expectedMinConfidence: "medium" },

  // ── Transmission ─────────────────────────────────────────────────────────────
  { input: "Transmission service",           sourceType: "history",  expectedCanonical: "transmission_fluid_service",    expectedMinConfidence: "high" },
  { input: "Manual transmission gear oil change", sourceType: "quote", expectedCanonical: "transmission_fluid_service", expectedMinConfidence: "medium" },
  { input: "CVT fluid service",              sourceType: "history",  expectedCanonical: "transmission_fluid_service",    expectedMinConfidence: "medium" },
  { input: "Replace automatic transaxle",    sourceType: "schedule", expectedCanonical: "transmission_fluid_service",    expectedMinConfidence: "high" },

  // ── Differential / axle ──────────────────────────────────────────────────────
  { input: "Differential service",           sourceType: "history",  expectedCanonical: "axle_fluid_service",            expectedMinConfidence: "high" },
  { input: "Replace Front Axle Fluid",       sourceType: "schedule", expectedCanonical: "axle_fluid_service",            expectedMinConfidence: "high" },
  { input: "Inspect - Front differential fluid", sourceType: "pricing", expectedCanonical: "axle_fluid_service",         expectedMinConfidence: "medium" },

  // ── Transfer case ─────────────────────────────────────────────────────────────
  { input: "Transfer case fluid",            sourceType: "history",  expectedCanonical: "transfer_case_fluid_service",   expectedMinConfidence: "high" },
  { input: "Inspect - Transfer case fluid",  sourceType: "pricing",  expectedCanonical: "transfer_case_fluid_service",   expectedMinConfidence: "medium" },

  // ── Spark plugs ───────────────────────────────────────────────────────────────
  { input: "Spark plugs replaced",           sourceType: "history",  expectedCanonical: "spark_plug_replacement",        expectedMinConfidence: "high" },
  { input: "Replace - Spark plugs",          sourceType: "pricing",  expectedCanonical: "spark_plug_replacement",        expectedMinConfidence: "high" },
  { input: "Tune up",                        sourceType: "history",  expectedCanonical: "spark_plug_replacement",        expectedMinConfidence: "medium" },

  // ── Belts ─────────────────────────────────────────────────────────────────────
  { input: "Drive belt replaced",            sourceType: "history",  expectedCanonical: "serpentine_belt_replacement",   expectedMinConfidence: "high" },
  { input: "Serpentine belt replacement",    sourceType: "history",  expectedCanonical: "serpentine_belt_replacement",   expectedMinConfidence: "high" },
  { input: "Timing belt",                    sourceType: "history",  expectedCanonical: "timing_belt_service",           expectedMinConfidence: "high" },

  // ── Filters ───────────────────────────────────────────────────────────────────
  { input: "Replace - Air filter",           sourceType: "pricing",  expectedCanonical: "air_filter_replacement",        expectedMinConfidence: "high" },
  { input: "Replace Air Cleaner Element",    sourceType: "schedule", expectedCanonical: "air_filter_replacement",        expectedMinConfidence: "high" },
  { input: "Cabin filter",                   sourceType: "history",  expectedCanonical: "cabin_filter_replacement",      expectedMinConfidence: "high" },
  { input: "Replace Cabin Air Filter",       sourceType: "schedule", expectedCanonical: "cabin_filter_replacement",      expectedMinConfidence: "high" },

  // ── Misc services ─────────────────────────────────────────────────────────────
  { input: "Power steering fluid service - CHF11S", sourceType: "quote", expectedCanonical: "power_steering_fluid_service", expectedMinConfidence: "medium" },
  { input: "Rotate Tires",                   sourceType: "schedule", expectedCanonical: "tire_rotation",                 expectedMinConfidence: "high" },
  { input: "Rotate - Wheels & tires",        sourceType: "pricing",  expectedCanonical: "tire_rotation",                 expectedMinConfidence: "high" },
  { input: "Battery replacement",            sourceType: "history",  expectedCanonical: "battery_replacement",           expectedMinConfidence: "high" },
  { input: "Fuel filter replacement",        sourceType: "history",  expectedCanonical: "fuel_filter_replacement",       expectedMinConfidence: "high" },

  // ── Ambiguous / unknown ───────────────────────────────────────────────────────
  { input: "Vehicle serviced",               sourceType: "history",  expectedCanonical: "unknown_service",               expectedMinConfidence: "low",   note: "Vague — must not claim specific service" },
  { input: "Recommended maintenance performed", sourceType: "history", expectedCanonical: "unknown_service",             expectedMinConfidence: "low",   note: "Vague — must return unknown" },
  { input: "60k service completed",          sourceType: "history",  expectedCanonical: "unknown_service",               expectedMinConfidence: "low",   note: "Ambiguous — 60k could mean many services" },
  { input: "Major service",                  sourceType: "history",  expectedCanonical: "unknown_service",               expectedMinConfidence: "low",   note: "Vague — must not overclaim" },
];

// ─── Simple runner (not a test framework — just validation output) ─────────────

const CONFIDENCE_RANK = { high: 2, medium: 1, low: 0 };

export function runMappingFixtures(): void {
  let passed = 0;
  let failed = 0;

  console.log("\n=== Canonical Service Mapping Fixture Results ===\n");

  for (const fixture of MAPPING_FIXTURES) {
    const result = mapToCanonicalService({
      rawText: fixture.input,
      sourceType: fixture.sourceType,
    });

    const canonicalOk = result.canonicalService === fixture.expectedCanonical;
    const confidenceOk = CONFIDENCE_RANK[result.confidence] >= CONFIDENCE_RANK[fixture.expectedMinConfidence];
    const ok = canonicalOk && confidenceOk;

    if (ok) {
      passed++;
      console.log(`✅ "${fixture.input}" → ${result.canonicalService} (${result.confidence})`);
    } else {
      failed++;
      console.log(`❌ "${fixture.input}"`);
      if (!canonicalOk) console.log(`   canonical: got "${result.canonicalService}", expected "${fixture.expectedCanonical}"`);
      if (!confidenceOk) console.log(`   confidence: got "${result.confidence}", expected >="${fixture.expectedMinConfidence}"`);
      if (fixture.note) console.log(`   note: ${fixture.note}`);
    }
  }

  console.log(`\n${passed}/${passed + failed} passed\n`);
}
