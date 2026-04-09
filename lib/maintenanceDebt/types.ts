// lib/maintenanceDebt/types.ts
// Core data models for the Maintenance Debt Audit engine.
// Raw VehicleDatabases API shapes never appear here — only internal types.

import type { CanonicalService } from "@/lib/services/canonicalServices";

// ─── Vehicle ──────────────────────────────────────────────────────────────────

export type VehicleIdentity = {
  vin?: string | null;
  year?: number | null;
  make?: string | null;
  model?: string | null;
  trim?: string | null;
  currentMileage?: number | null;
  /** "confirmed" = extracted directly from report header.
   *  "estimated" = inferred from max(service event mileages). UI should ask user to verify. */
  mileageConfidence?: "confirmed" | "estimated";
};

// ─── Raw history (from extraction layer) ─────────────────────────────────────

export type ServiceHistoryEvent = {
  id: string;
  source: "carfax" | "autocheck" | "receipt" | "manual" | "unknown";
  rawDescription: string;
  date?: string | null;
  mileage?: number | null;
};

// ─── Normalized history (from normalization layer) ───────────────────────────

export type NormalizedServiceEvent = {
  id: string;
  /** Canonical service key — join surface for comparison and pricing */
  canonicalService: CanonicalService;
  confidence: "high" | "medium" | "low";
  rawDescription: string;
  date?: string | null;
  mileage?: number | null;
  /** The exact raw text that triggered this mapping */
  mappedFrom: string;
};

// ─── OEM maintenance schedule ─────────────────────────────────────────────────
// Extended to support both mileage-based and time-based detection.

export type MaintenanceScheduleItem = {
  /** Canonical service key — universal join key across schedule, pricing, history */
  canonicalService: CanonicalService;
  /** Human-readable label for display */
  displayName: string;
  /** Mileage checkpoint at which this service is due */
  dueMileage?: number | null;
  /** How many miles between service intervals (derived from VDB schedule pattern) */
  intervalMiles?: number | null;
  /** How many months between service intervals (from time-based rules) */
  intervalMonths?: number | null;
  /** First time this service is due by month (vehicle age) */
  firstDueMonths?: number | null;
  severity: "low" | "medium" | "high";
  source: "vehicle_databases" | "ai_estimated";
};

// ─── Pricing (from VehicleDatabases repair estimates) ────────────────────────

export type ServiceCostEstimate = {
  canonicalService: CanonicalService;
  estimateLow?: number | null;
  estimateHigh?: number | null;
  source: "vehicle_databases";
};

// ─── Debt item (output of comparison engine) ─────────────────────────────────

export type MaintenanceDebtItem = {
  canonicalService: CanonicalService;
  displayName: string;
  status: "done" | "due_now" | "overdue" | "upcoming" | "unknown";
  /** Whether this was flagged by mileage-based or time-based logic (or both) */
  detectionMethod: "mileage" | "time" | "both" | "unknown";
  dueMileage?: number | null;
  currentMileage?: number | null;
  overdueMiles?: number | null;
  /** Months overdue (from time-based detection) */
  overdueMonths?: number | null;
  /** Last confirmed service date (ISO string) */
  lastServiceDate?: string | null;
  /** true only when confidence >= "medium" and canonicalService matches */
  evidenceFound: boolean;
  matchingHistoryEventIds: string[];
  estimatedCostLow?: number | null;
  estimatedCostHigh?: number | null;
  severity: "low" | "medium" | "high";
  reasoning: string;
};

// ─── Final audit result ───────────────────────────────────────────────────────

export type MaintenanceDebtAuditResult = {
  vehicle: VehicleIdentity;
  extractedHistory: ServiceHistoryEvent[];
  normalizedHistory: NormalizedServiceEvent[];
  schedule: MaintenanceScheduleItem[];
  /** Items that are overdue or due now — the "debt" */
  debtItems: MaintenanceDebtItem[];
  /** Items with evidenceFound = true */
  completedItems: MaintenanceDebtItem[];
  /** Items due within 10,000 miles of current mileage but not yet overdue */
  upcomingItems: MaintenanceDebtItem[];
  /** Sum of estimatedCostLow for overdue + due_now items with pricing */
  debtEstimateLow?: number | null;
  /** Sum of estimatedCostHigh for overdue + due_now items with pricing */
  debtEstimateHigh?: number | null;
  verdict: "strong_buy" | "reasonable_buy" | "proceed_caution" | "high_risk" | "walk_away" | "clean" | "light_catch_up" | "maintenance_debt_risk" | "incomplete";
  summary: string;
  /** How reliable is this result overall */
  confidence: "low" | "medium" | "high";
  /** Where the OEM schedule came from — drives the AI-estimated banner in UI */
  scheduleSource: "vehicle_databases" | "ai_estimated" | "none";
  /** Optional: asking price provided by the user for deal quality computation */
  askingPrice?: number | null;
  /** AI-estimated market value range */
  marketValueEstimate?: { low: number; high: number; confidence: "low" | "medium" | "high" } | null;
};

// ─── Input types for comparison engine ───────────────────────────────────────

export type CompareEngineInput = {
  vehicle: VehicleIdentity;
  normalizedHistory: NormalizedServiceEvent[];
  schedule: MaintenanceScheduleItem[];
  /** Keyed by CanonicalService key */
  repairEstimates: Record<string, ServiceCostEstimate>;
};

// Re-export CanonicalService for convenience
export type { CanonicalService };
