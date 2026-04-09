// lib/maintenanceDebt/__fixtures__/scenarios.ts
// 4 mocked test scenarios for the comparison engine.
// No API calls — all data is static JSON.
// Run with: npx ts-node lib/maintenanceDebt/__fixtures__/scenarios.ts

import { compareHistoryToSchedule } from "../compareEngine";
import type {
  CompareEngineInput,
  MaintenanceScheduleItem,
  NormalizedServiceEvent,
  ServiceCostEstimate,
  VehicleIdentity,
} from "../types";

// ─── Shared Helpers ───────────────────────────────────────────────────────────

const HONDA_CIVIC_SCHEDULE: MaintenanceScheduleItem[] = [
  { canonicalService: "engine_oil_change" as import("@/lib/services/canonicalServices").CanonicalService, displayName: "Engine Oil Change", dueMileage: 10000, severity: "medium", source: "vehicle_databases" },
  { canonicalService: "engine_oil_change" as import("@/lib/services/canonicalServices").CanonicalService, displayName: "Engine Oil Change", dueMileage: 20000, severity: "medium", source: "vehicle_databases" },
  { canonicalService: "engine_oil_change" as import("@/lib/services/canonicalServices").CanonicalService, displayName: "Engine Oil Change", dueMileage: 30000, severity: "medium", source: "vehicle_databases" },
  { canonicalService: "engine_oil_change" as import("@/lib/services/canonicalServices").CanonicalService, displayName: "Engine Oil Change", dueMileage: 40000, severity: "medium", source: "vehicle_databases" },
  { canonicalService: "engine_oil_change" as import("@/lib/services/canonicalServices").CanonicalService, displayName: "Engine Oil Change", dueMileage: 50000, severity: "medium", source: "vehicle_databases" },
  { canonicalService: "engine_oil_change" as import("@/lib/services/canonicalServices").CanonicalService, displayName: "Engine Oil Change", dueMileage: 60000, severity: "medium", source: "vehicle_databases" },
  { canonicalService: "engine_oil_change" as import("@/lib/services/canonicalServices").CanonicalService, displayName: "Engine Oil Change", dueMileage: 70000, severity: "medium", source: "vehicle_databases" },
  { canonicalService: "air_filter_replacement" as import("@/lib/services/canonicalServices").CanonicalService, displayName: "Air Filter Replacement", dueMileage: 30000, severity: "low", source: "vehicle_databases" },
  { canonicalService: "air_filter_replacement" as import("@/lib/services/canonicalServices").CanonicalService, displayName: "Air Filter Replacement", dueMileage: 60000, severity: "low", source: "vehicle_databases" },
  { canonicalService: "cabin_filter_replacement" as import("@/lib/services/canonicalServices").CanonicalService, displayName: "Cabin Air Filter", dueMileage: 30000, severity: "low", source: "vehicle_databases" },
  { canonicalService: "cabin_filter_replacement" as import("@/lib/services/canonicalServices").CanonicalService, displayName: "Cabin Air Filter", dueMileage: 60000, severity: "low", source: "vehicle_databases" },
  { canonicalService: "transmission_fluid_service" as import("@/lib/services/canonicalServices").CanonicalService, displayName: "Transmission Fluid", dueMileage: 60000, severity: "high", source: "vehicle_databases" },
  { canonicalService: "brake_fluid_service" as import("@/lib/services/canonicalServices").CanonicalService, displayName: "Brake Fluid Flush", dueMileage: 45000, severity: "medium", source: "vehicle_databases" },
  { canonicalService: "spark_plug_replacement" as import("@/lib/services/canonicalServices").CanonicalService, displayName: "Spark Plugs", dueMileage: 60000, severity: "high", source: "vehicle_databases" },
];

const BASIC_ESTIMATES: Record<string, ServiceCostEstimate> = {
  "Change - Engine oil": { canonicalService: "engine_oil_change" as import("@/lib/services/canonicalServices").CanonicalService, estimateLow: 50, estimateHigh: 80, source: "vehicle_databases" },
  "Replace - Air filter": { canonicalService: "air_filter_replacement" as import("@/lib/services/canonicalServices").CanonicalService, estimateLow: 36, estimateHigh: 60, source: "vehicle_databases" },
  "Replace - Cabin air filter": { canonicalService: "cabin_filter_replacement" as import("@/lib/services/canonicalServices").CanonicalService, estimateLow: 36, estimateHigh: 55, source: "vehicle_databases" },
  "Change - Automatic transmission fluid": { canonicalService: "transmission_fluid_service" as import("@/lib/services/canonicalServices").CanonicalService, estimateLow: 73, estimateHigh: 120, source: "vehicle_databases" },
  "Flush/replace - Brake fluid": { canonicalService: "brake_fluid_service" as import("@/lib/services/canonicalServices").CanonicalService, estimateLow: 50, estimateHigh: 80, source: "vehicle_databases" },
  "Replace - Spark plugs": { canonicalService: "spark_plug_replacement" as import("@/lib/services/canonicalServices").CanonicalService, estimateLow: 129, estimateHigh: 200, source: "vehicle_databases" },
};

// ─── Scenario 1: Clean history ────────────────────────────────────────────────

const SCENARIO_1_VEHICLE: VehicleIdentity = {
  vin: "2HGFE2F20NH507968",
  year: 2022,
  make: "Honda",
  model: "Civic",
  trim: "LX",
  currentMileage: 45000,
  mileageConfidence: "confirmed",
};

const SCENARIO_1_HISTORY: NormalizedServiceEvent[] = [
  { id: "e1", canonicalService: "engine_oil_change" as import("@/lib/services/canonicalServices").CanonicalService, confidence: "high", rawDescription: "Oil and filter changed", mappedFrom: "Oil and filter changed", mileage: 10000 },
  { id: "e2", canonicalService: "engine_oil_change" as import("@/lib/services/canonicalServices").CanonicalService, confidence: "high", rawDescription: "Oil and filter changed", mappedFrom: "Oil and filter changed", mileage: 20000 },
  { id: "e3", canonicalService: "engine_oil_change" as import("@/lib/services/canonicalServices").CanonicalService, confidence: "high", rawDescription: "Oil and filter changed", mappedFrom: "Oil and filter changed", mileage: 30000 },
  { id: "e4", canonicalService: "air_filter_replacement" as import("@/lib/services/canonicalServices").CanonicalService, confidence: "high", rawDescription: "Air filter replaced", mappedFrom: "Air filter replaced", mileage: 30000 },
  { id: "e5", canonicalService: "cabin_filter_replacement" as import("@/lib/services/canonicalServices").CanonicalService, confidence: "high", rawDescription: "Cabin air filter replaced", mappedFrom: "Cabin air filter replaced", mileage: 30000 },
  { id: "e6", canonicalService: "engine_oil_change" as import("@/lib/services/canonicalServices").CanonicalService, confidence: "high", rawDescription: "Oil and filter changed", mappedFrom: "Oil and filter changed", mileage: 40000 },
  { id: "e7", canonicalService: "brake_fluid_service" as import("@/lib/services/canonicalServices").CanonicalService, confidence: "high", rawDescription: "Brake fluid flush", mappedFrom: "Brake fluid flush", mileage: 45000 },
];

// ─── Scenario 2: Partially missing ────────────────────────────────────────────

const SCENARIO_2_VEHICLE: VehicleIdentity = {
  vin: "4T1BF1FK5JU123456",
  year: 2018,
  make: "Toyota",
  model: "Camry",
  currentMileage: 72000,
  mileageConfidence: "confirmed",
};

const SCENARIO_2_HISTORY: NormalizedServiceEvent[] = [
  { id: "e1", canonicalService: "engine_oil_change" as import("@/lib/services/canonicalServices").CanonicalService, confidence: "high", rawDescription: "Oil change", mappedFrom: "Oil change", mileage: 15000 },
  { id: "e2", canonicalService: "engine_oil_change" as import("@/lib/services/canonicalServices").CanonicalService, confidence: "high", rawDescription: "Oil change", mappedFrom: "Oil change", mileage: 30000 },
  { id: "e3", canonicalService: "engine_oil_change" as import("@/lib/services/canonicalServices").CanonicalService, confidence: "high", rawDescription: "Oil change", mappedFrom: "Oil change", mileage: 45000 },
  { id: "e4", canonicalService: "engine_oil_change" as import("@/lib/services/canonicalServices").CanonicalService, confidence: "high", rawDescription: "Oil change", mappedFrom: "Oil change", mileage: 60000 },
  { id: "e5", canonicalService: "air_filter_replacement" as import("@/lib/services/canonicalServices").CanonicalService, confidence: "high", rawDescription: "Air filter replaced", mappedFrom: "Air filter replaced", mileage: 30000 },
  { id: "e6", canonicalService: "air_filter_replacement" as import("@/lib/services/canonicalServices").CanonicalService, confidence: "high", rawDescription: "Air filter replaced", mappedFrom: "Air filter replaced", mileage: 60000 },
  // Missing: transmission fluid, brake fluid, spark plugs
];

// ─── Scenario 3: Heavily overdue ──────────────────────────────────────────────

const SCENARIO_3_VEHICLE: VehicleIdentity = {
  vin: "5J6RM4H59GL123456",
  year: 2015,
  make: "Honda",
  model: "CR-V",
  currentMileage: 115000,
  mileageConfidence: "confirmed",
};

const SCENARIO_3_HISTORY: NormalizedServiceEvent[] = [
  { id: "e1", canonicalService: "engine_oil_change" as import("@/lib/services/canonicalServices").CanonicalService, confidence: "high", rawDescription: "Oil change", mappedFrom: "Oil change", mileage: 20000 },
  { id: "e2", canonicalService: "engine_oil_change" as import("@/lib/services/canonicalServices").CanonicalService, confidence: "high", rawDescription: "Oil change", mappedFrom: "Oil change", mileage: 40000 },
  { id: "e3", canonicalService: "engine_oil_change" as import("@/lib/services/canonicalServices").CanonicalService, confidence: "high", rawDescription: "Oil change", mappedFrom: "Oil change", mileage: 60000 },
  // No spark plugs, no brake fluid, no transmission fluid, no air filter replacements at correct intervals
];

// ─── Scenario 4: Ambiguous history ───────────────────────────────────────────

const SCENARIO_4_VEHICLE: VehicleIdentity = {
  vin: "1FMCU9J9XKUA12345",
  year: 2019,
  make: "Ford",
  model: "Escape",
  currentMileage: 88000,
  mileageConfidence: "estimated",
};

const SCENARIO_4_HISTORY: NormalizedServiceEvent[] = [
  { id: "e1", canonicalService: "unknown_service" as import("@/lib/services/canonicalServices").CanonicalService, confidence: "low", rawDescription: "Vehicle serviced", mappedFrom: "Vehicle serviced", mileage: 15000 },
  { id: "e2", canonicalService: "unknown_service" as import("@/lib/services/canonicalServices").CanonicalService, confidence: "low", rawDescription: "Maintenance inspection completed", mappedFrom: "Maintenance inspection completed", mileage: 30000 },
  { id: "e3", canonicalService: "unknown_service" as import("@/lib/services/canonicalServices").CanonicalService, confidence: "low", rawDescription: "Recommended maintenance performed", mappedFrom: "Recommended maintenance performed", mileage: 47000 },
  { id: "e4", canonicalService: "unknown_service" as import("@/lib/services/canonicalServices").CanonicalService, confidence: "low", rawDescription: "Vehicle serviced", mappedFrom: "Vehicle serviced", mileage: 60000 },
  { id: "e5", canonicalService: "unknown_service" as import("@/lib/services/canonicalServices").CanonicalService, confidence: "low", rawDescription: "Vehicle serviced", mappedFrom: "Vehicle serviced", mileage: 75000 },
];

// ─── Runner ───────────────────────────────────────────────────────────────────

function runScenario(label: string, input: CompareEngineInput) {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`SCENARIO: ${label}`);
  console.log("=".repeat(60));
  const result = compareHistoryToSchedule(input);
  console.log(`Verdict:        ${result.verdict}`);
  console.log(`Summary:        ${result.summary}`);
  console.log(`Debt low:       $${result.debtEstimateLow ?? "n/a"}`);
  console.log(`Debt high:      $${result.debtEstimateHigh ?? "n/a"}`);
  console.log(`Debt items:     ${result.debtItems.length}`);
  console.log(`Completed:      ${result.completedItems.length}`);
  console.log(`Upcoming:       ${result.upcomingItems.length}`);
  console.log("\nDebt Items:");
  result.debtItems.forEach((item) => {
    console.log(`  [${item.status.toUpperCase()}] ${item.displayName} — ${item.reasoning}`);
  });
}

// Only run when called directly
if (require.main === module) {
  runScenario("1. Clean History (2022 Honda Civic, 45k)", {
    vehicle: SCENARIO_1_VEHICLE,
    normalizedHistory: SCENARIO_1_HISTORY,
    schedule: HONDA_CIVIC_SCHEDULE,
    repairEstimates: BASIC_ESTIMATES,
  });

  runScenario("2. Partially Missing (2018 Toyota Camry, 72k)", {
    vehicle: SCENARIO_2_VEHICLE,
    normalizedHistory: SCENARIO_2_HISTORY,
    schedule: HONDA_CIVIC_SCHEDULE,
    repairEstimates: BASIC_ESTIMATES,
  });

  runScenario("3. Heavily Overdue (2015 Honda CR-V, 115k)", {
    vehicle: SCENARIO_3_VEHICLE,
    normalizedHistory: SCENARIO_3_HISTORY,
    schedule: HONDA_CIVIC_SCHEDULE,
    repairEstimates: BASIC_ESTIMATES,
  });

  runScenario("4. Ambiguous History (2019 Ford Escape, 88k)", {
    vehicle: SCENARIO_4_VEHICLE,
    normalizedHistory: SCENARIO_4_HISTORY,
    schedule: HONDA_CIVIC_SCHEDULE,
    repairEstimates: BASIC_ESTIMATES,
  });
}

export { SCENARIO_1_VEHICLE, SCENARIO_1_HISTORY, SCENARIO_2_VEHICLE, SCENARIO_2_HISTORY, SCENARIO_3_VEHICLE, SCENARIO_3_HISTORY, SCENARIO_4_VEHICLE, SCENARIO_4_HISTORY, HONDA_CIVIC_SCHEDULE, BASIC_ESTIMATES };
