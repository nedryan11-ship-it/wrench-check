// lib/vehicleDatabases/_sandbox.ts
// Manual test script for VehicleDatabases integration.
// Run with: npx ts-node -r tsconfig-paths/register lib/vehicleDatabases/_sandbox.ts
//
// Requires: VEHICLEDATABASES_API_KEY in environment
// Test VIN: 2HGFE2F20NH507968 (2022 Honda Civic LX) — known good from VDB docs

import { getMaintenanceSchedule } from "./maintenance";
import { getRepairEstimateMap } from "./repairEstimates";

const TEST_VIN = "2HGFE2F20NH507968";

async function main() {
  console.log(`\nVehicleDatabases Sandbox Test — VIN: ${TEST_VIN}\n${"─".repeat(60)}\n`);

  // ── Test 1: Maintenance Schedule ──────────────────────────────────────────
  console.log("TEST 1: Maintenance Schedule Fetch + Normalization");
  const schedule = await getMaintenanceSchedule({ vin: TEST_VIN });

  if (!schedule) {
    console.error("  ✗ Maintenance schedule fetch failed — check API key and VIN");
  } else {
    console.log(`  ✓ ${schedule.length} schedule items returned`);

    // Show unique services
    const unique = [...new Set(schedule.map((s) => s.canonicalService))];
    console.log(`  ✓ ${unique.length} unique service types`);

    // Show sample items
    console.log("\n  Sample MaintenanceScheduleItem[]:");
    schedule.slice(0, 5).forEach((item) => {
      console.log(`    [${(item.dueMileage ?? 0).toLocaleString()} mi] ${item.displayName} (severity: ${item.severity})`);
    });

    // Show a specific high-severity service
    const txFluid = schedule.find((s) => s.canonicalService.includes("transmission"));
    if (txFluid) {
      console.log(`\n  Transmission fluid item:`);
      console.log(JSON.stringify(txFluid, null, 4));
    }
  }

  console.log(`\n${"─".repeat(60)}\n`);

  // ── Test 2: Repair Estimates ──────────────────────────────────────────────
  console.log("TEST 2: Repair Estimate Fetch + Normalization");
  const estimates = await getRepairEstimateMap({ vin: TEST_VIN });

  if (!estimates) {
    console.error("  ✗ Repair estimates fetch failed — check API key and VIN");
  } else {
    const count = Object.keys(estimates).length;
    console.log(`  ✓ ${count} service cost estimates returned`);

    // Show a few sample estimates
    const sampleKeys = Object.keys(estimates).slice(0, 5);
    console.log("\n  Sample ServiceCostEstimate:");
    sampleKeys.forEach((key) => {
      const est = estimates[key];
      console.log(`    ${key}: $${est.estimateLow}–$${est.estimateHigh}`);
    });

    // Show transmission fluid specifically
    const txKey = Object.keys(estimates).find((k) => k.includes("transmission"));
    if (txKey) {
      console.log(`\n  Transmission fluid estimate:`);
      console.log(JSON.stringify(estimates[txKey], null, 4));
    }
  }

  console.log(`\n${"─".repeat(60)}\n`);

  // ── Test 3: Join — maintenance + pricing aligned? ─────────────────────────
  if (schedule && estimates) {
    console.log("TEST 3: Maintenance ↔ Pricing Join Check");
    const scheduleServices = [...new Set(schedule.map((s) => s.canonicalService))];
    const pricedServices = new Set(Object.keys(estimates));

    const matched = scheduleServices.filter((s) => pricedServices.has(s));
    const unmatched = scheduleServices.filter((s) => !pricedServices.has(s));

    console.log(`  ✓ ${matched.length}/${scheduleServices.length} schedule services have pricing`);
    if (unmatched.length > 0) {
      console.log(`  ⚠ No pricing for: ${unmatched.join(", ")}`);
    }
  }

  console.log("\nDone.");
}

main().catch(console.error);
