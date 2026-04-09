// lib/maintenance/__tests__/timeBasedRules.fixtures.ts
//
// Test fixtures for time-based maintenance detection.
// Covers: old low-mileage vehicles, high-mileage newer vehicles,
// documented services, vague history, incomplete dates.

import { evaluateTimeBasedServiceStatus } from "../timeBasedRules";
import type { NormalizedServiceEvent } from "@/lib/maintenanceDebt/types";

const TODAY = new Date("2025-04-01");

function makeEvent(overrides: Partial<NormalizedServiceEvent> = {}): NormalizedServiceEvent {
  return {
    id: "evt-1",
    canonicalService: "coolant_service",
    confidence: "high",
    rawDescription: "coolant flush",
    mappedFrom: "coolant flush",
    ...overrides,
  };
}

// ─── Fixture scenarios ────────────────────────────────────────────────────────

export function runTimeBasedFixtures(): void {
  console.log("\n=== Time-Based Detection Fixture Results ===\n");
  let passed = 0;
  let failed = 0;

  function check(
    label: string,
    args: Parameters<typeof evaluateTimeBasedServiceStatus>[0],
    expectedStatus: string,
    expectedMinConfidence: "high" | "medium" | "low"
  ) {
    const result = evaluateTimeBasedServiceStatus({ ...args, currentDate: TODAY });
    const confidenceRank = { high: 2, medium: 1, low: 0 };

    const statusOk = result?.status === expectedStatus;
    const confidenceOk = result
      ? confidenceRank[result.confidence] >= confidenceRank[expectedMinConfidence]
      : false;

    if (statusOk && confidenceOk) {
      passed++;
      console.log(`✅ ${label} → ${result?.status} (${result?.confidence})`);
      if (result?.reasoning) console.log(`   "${result.reasoning}"`);
    } else {
      failed++;
      console.log(`❌ ${label}`);
      if (!statusOk) console.log(`   status: got "${result?.status}", expected "${expectedStatus}"`);
      if (!confidenceOk) console.log(`   confidence: got "${result?.confidence}", expected >="${expectedMinConfidence}"`);
      if (result?.reasoning) console.log(`   reasoning: "${result.reasoning}"`);
    }
  }

  // ── A. Old low-mileage vehicle — should flag time-based maintenance ──────────

  check(
    "Coolant: 10yr old car, no documented service",
    { vehicleYear: 2015, canonicalService: "coolant_service", matchingHistoryEvents: [] },
    "overdue",
    "medium"
    // 10 years old, first due at 30 months, overdue by ~90 months
  );

  check(
    "Brake fluid: 7yr old car, no documented service",
    { vehicleYear: 2018, canonicalService: "brake_fluid_service", matchingHistoryEvents: [] },
    "overdue",
    "medium"
    // 7 years old, interval 24 months, overdue by multiple cycles
  );

  check(
    "Battery: 6yr old car, no documented replacement",
    { vehicleYear: 2019, canonicalService: "battery_replacement", matchingHistoryEvents: [] },
    "overdue",
    "medium"
    // 6 years old, first due at 48 months
  );

  // ── B. High-mileage, newer vehicle — may be due or upcoming ──────────────────

  check(
    "Serpentine belt: 4yr old car, no service record",
    { vehicleYear: 2021, canonicalService: "serpentine_belt_replacement", matchingHistoryEvents: [] },
    "upcoming",
    "medium"
    // 4 years old, first due at 60 months — not yet
  );

  check(
    "Transfer case fluid: 3yr old car, no service",
    { vehicleYear: 2022, canonicalService: "transfer_case_fluid_service", matchingHistoryEvents: [] },
    "upcoming",
    "medium"
    // 3 years old (~36 months), right at threshold — upcoming
  );

  // ── C. Clear documented service with date — should mark done ─────────────────

  check(
    "Coolant: documented 18 months ago (within 30mo interval)",
    {
      vehicleYear: 2015,
      canonicalService: "coolant_service",
      matchingHistoryEvents: [makeEvent({ date: "2023-10-01" })], // ~18 months ago
    },
    "done",
    "high"
  );

  check(
    "Brake fluid: documented 12 months ago (within 24mo interval)",
    {
      vehicleYear: 2018,
      canonicalService: "brake_fluid_service",
      matchingHistoryEvents: [makeEvent({ canonicalService: "brake_fluid_service", date: "2024-04-01" })],
    },
    "done",
    "high"
  );

  // ── D. Documented but overdue by time ─────────────────────────────────────────

  check(
    "Coolant: last documented 40 months ago (past 30mo interval)",
    {
      vehicleYear: 2015,
      canonicalService: "coolant_service",
      matchingHistoryEvents: [makeEvent({ date: "2021-12-01" })], // ~40 months ago
    },
    "overdue",
    "high"
  );

  // ── E. Events with no parseable dates — should return unknown ─────────────────

  check(
    "Coolant: service found but no date",
    {
      vehicleYear: 2015,
      canonicalService: "coolant_service",
      matchingHistoryEvents: [makeEvent({ date: null })],
    },
    "unknown",
    "low"
  );

  // ── F. Service with no time rule — should return null ────────────────────────

  const noRuleResult = evaluateTimeBasedServiceStatus({
    vehicleYear: 2015,
    currentDate: TODAY,
    canonicalService: "tire_rotation",
    matchingHistoryEvents: [],
  });
  const noRuleOk = noRuleResult === null;
  if (noRuleOk) {
    passed++;
    console.log("✅ Tire rotation (no time rule) → null (correctly skipped)");
  } else {
    failed++;
    console.log(`❌ Tire rotation should return null, got: ${JSON.stringify(noRuleResult)}`);
  }

  console.log(`\n${passed}/${passed + failed} passed\n`);
}
