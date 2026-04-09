// lib/vehicleDatabases/maintenance.ts
// Fetches OEM maintenance schedule from VehicleDatabases and normalizes
// the checkpoint-grouped response into flat MaintenanceScheduleItem[].
//
// VDB response shape:
//   { maintenance: [{ mileage: { miles: 15000 }, service_items: ["Replace Air Cleaner Element", ...] }] }
//
// Normalization: each (mileage checkpoint, service_item) pair → one MaintenanceScheduleItem
// canonicalService = the exact VDB service_items string (join key with repair estimates)

import type { MaintenanceScheduleItem } from "../maintenanceDebt/types";
import { getCached, setCached, vdbGet, MAINTENANCE_TTL_MS, DEV } from "./client";
import { mapToCanonicalService } from "@/lib/services/mapToCanonicalService";
import { TIME_RULES } from "@/lib/maintenance/timeBasedRules";

// ─── Raw VDB response types (internal only) ───────────────────────────────────

interface VdbMaintenanceCheckpoint {
  mileage: { miles: number; km: number };
  service_items: string[];
}

interface VdbMaintenanceData {
  vin: string;
  year: number;
  make: string;
  model: string;
  trim?: string;
  maintenance: VdbMaintenanceCheckpoint[];
}

// ─── Severity heuristic ───────────────────────────────────────────────────────
// VDB doesn't return severity — assign based on service type keywords.

function inferSeverity(service: string): "low" | "medium" | "high" {
  const s = service.toLowerCase();

  if (
    s.includes("timing belt") ||
    s.includes("timing chain") ||
    s.includes("transmission fluid") ||
    s.includes("transaxle") ||
    s.includes("spark plug") ||
    s.includes("coolant") ||
    s.includes("differential")
  ) {
    return "high";
  }

  if (
    s.includes("brake fluid") ||
    s.includes("brake") ||
    s.includes("power steering") ||
    s.includes("drive belt") ||
    s.includes("valve clearance") ||
    s.includes("fuel filter") ||
    s.includes("engine oil")
  ) {
    return "medium";
  }

  // Filters, inspections, tire rotations
  return "low";
}

// ─── Normalize VDB response → MaintenanceScheduleItem[] ──────────────────────

function normalizeMaintenanceResponse(data: VdbMaintenanceData): MaintenanceScheduleItem[] {
  const items: MaintenanceScheduleItem[] = [];

  for (const checkpoint of data.maintenance) {
    const dueMileage = checkpoint.mileage.miles;

    for (const serviceItem of checkpoint.service_items) {
      const { canonicalService, confidence } = mapToCanonicalService({
        rawText: serviceItem,
        sourceType: "schedule",
      });

      // Skip items we can't map AND items that are low-confidence inspection noise
      if (canonicalService === "unknown_service" && confidence === "low") continue;

      // Enrich with time-based rule if available
      const timeRule = TIME_RULES[canonicalService];

      items.push({
        canonicalService,
        displayName: serviceItem,   // keep original VDB string for human display
        dueMileage,
        intervalMonths: timeRule?.intervalMonths ?? null,
        firstDueMonths: timeRule?.firstDueMonths ?? null,
        severity: inferSeverity(serviceItem),
        source: "vehicle_databases",
      });
    }
  }

  return items;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Fetch OEM maintenance schedule for a VIN.
 * Returns null if API is unavailable — caller handles graceful degradation.
 */
export async function getMaintenanceSchedule({
  vin,
}: {
  vin: string;
}): Promise<MaintenanceScheduleItem[] | null> {
  const normalizedVin = vin.trim().toUpperCase();
  const cacheKey = `maintenance:${normalizedVin}`;

  // Check cache first
  const cached = await getCached<MaintenanceScheduleItem[]>(cacheKey, MAINTENANCE_TTL_MS);
  if (cached) return cached;

  // Fetch from VDB
  const data = await vdbGet<VdbMaintenanceData>(`/vehicle-maintenance/v4/${normalizedVin}`);
  if (!data) return null;

  const items = normalizeMaintenanceResponse(data);

  if (DEV) {
    console.log(`[VDB maintenance] VIN ...${normalizedVin.slice(-6)} → ${items.length} schedule items`);
  }

  await setCached(cacheKey, items);
  return items;
}
