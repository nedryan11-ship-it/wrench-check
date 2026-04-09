// lib/vehicleDatabases/repairEstimates.ts
// Fetches raw repair cost data from VehicleDatabases and normalizes into
// a canonical-keyed map using the shared service registry.
//
// Key: VDB repair type strings are mapped to CanonicalService keys via
// mapToCanonicalService("pricing") — same canonical surface used by the
// maintenance schedule and history normalization layers.
//
// When multiple VDB strings map to the same canonical (e.g. oil + filter),
// their costs are SUMMED for accurate total service cost.

import type { ServiceCostEstimate } from "../maintenanceDebt/types";
import { getCached, setCached, vdbGet, REPAIR_TTL_MS, DEV } from "./client";
import { mapToCanonicalService } from "@/lib/services/mapToCanonicalService";
import type { CanonicalService } from "@/lib/services/canonicalServices";

// ─── Raw VDB types ────────────────────────────────────────────────────────────

interface VdbCostEntry {
  type: string;
  total_cost: number;
  currency: string;
}

interface VdbLaborEntry extends VdbCostEntry {
  time_required_hours: number;
  hourly_rate: number;
}

interface VdbCheckpointItem {
  parts: VdbCostEntry[];
  labor: VdbLaborEntry[];
  total: VdbCostEntry[];
}

interface VdbRepairCheckpoint {
  mileage: string;
  items: VdbCheckpointItem[];
}

interface VdbRepairData {
  year: number;
  make: string;
  model: string;
  trim?: string;
  data: VdbRepairCheckpoint[];
}

// ─── Normalization ────────────────────────────────────────────────────────────

/**
 * Build a canonical-keyed cost map from raw VDB repair data.
 *
 * Strategy:
 *   - Map each VDB type string to a CanonicalService via mapToCanonicalService("pricing")
 *   - Within a checkpoint: SUM costs for same canonical (oil + filter → one service total)
 *   - Across checkpoints: take MAX (worst-case catch-up estimate)
 *   - Skip inspection-only labor (zero cost, not meaningful for debt estimates)
 */
function normalizeRepairEstimates(
  data: VdbRepairData
): Record<string, ServiceCostEstimate> {

  const rawCostByService: Record<string, number> = {};

  for (const checkpoint of data.data) {
    const checkpointCosts: Record<string, number> = {};

    for (const item of checkpoint.items) {
      // Parts
      for (const part of item.parts) {
        if (part.total_cost <= 0) continue;
        const { canonicalService } = mapToCanonicalService({
          rawText: part.type,
          sourceType: "pricing",
        });
        if (canonicalService === "unknown_service") continue;
        checkpointCosts[canonicalService] = (checkpointCosts[canonicalService] ?? 0) + part.total_cost;
      }

      // Labor — skip pure inspections
      for (const labor of item.labor) {
        if (labor.type.toLowerCase().startsWith("inspect")) continue;
        if (labor.total_cost <= 0) continue;
        const { canonicalService } = mapToCanonicalService({
          rawText: labor.type,
          sourceType: "pricing",
        });
        if (canonicalService === "unknown_service") continue;
        checkpointCosts[canonicalService] = (checkpointCosts[canonicalService] ?? 0) + labor.total_cost;
      }
    }

    // Merge into global — MAX across checkpoints
    for (const [canonical, cost] of Object.entries(checkpointCosts)) {
      rawCostByService[canonical] = Math.max(rawCostByService[canonical] ?? 0, cost);
    }
  }

  // Build output — raw VDB base costs (pricingEngine.ts applies structured multipliers)
  const result: Record<string, ServiceCostEstimate> = {};
  for (const [canonical, rawCost] of Object.entries(rawCostByService)) {
    result[canonical] = {
      canonicalService: canonical as CanonicalService,
      estimateLow: Math.round(rawCost),
      estimateHigh: Math.round(rawCost * 1.2),
      source: "vehicle_databases",
    };
  }

  if (DEV) {
    console.log(`[VDB repair] canonical services priced: ${Object.keys(result).join(", ")}`);
  }

  return result;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function getRepairEstimateMap({
  vin,
}: {
  vin: string;
}): Promise<Record<string, ServiceCostEstimate> | null> {
  const normalizedVin = vin.trim().toUpperCase();
  const cacheKey = `repair:${normalizedVin}`;

  const cached = await getCached<Record<string, ServiceCostEstimate>>(cacheKey, REPAIR_TTL_MS);
  if (cached) return cached;

  const data = await vdbGet<VdbRepairData>(`/repair-estimates/${normalizedVin}`);
  if (!data) return null;

  const estimateMap = normalizeRepairEstimates(data);

  if (DEV) {
    const count = Object.keys(estimateMap).length;
    console.log(`[VDB repair] VIN ...${normalizedVin.slice(-6)} → ${count} canonical services priced`);
  }

  await setCached(cacheKey, estimateMap);
  return estimateMap;
}
