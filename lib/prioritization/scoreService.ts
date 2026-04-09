// lib/prioritization/scoreService.ts
//
// Deterministic priority scoring for individual services.
// Works across both Repair Quote Audit and Maintenance Debt Audit.
//
// Score range: 0–100
//   A. Urgency    (0–40)
//   B. Time       (0–25)
//   C. Pricing    (0–20)
//   D. Vehicle    (0–15)

import type { CanonicalService } from "@/lib/services/canonicalServices";

// ─── Input types ──────────────────────────────────────────────────────────────

export type ServiceInput = {
  id: string;
  canonicalService: CanonicalService | string;
  displayName?: string;
  /** Severity from maintenance schedule or quote assessment */
  urgency: "low" | "medium" | "high";
  /** Time-based status from maintenance debt or quote necessity check */
  timeStatus?: "current" | "due_now" | "overdue" | "unknown";
  /** Quoted price or estimated miss cost */
  price?: number | null;
  marketMin?: number | null;
  marketMax?: number | null;
  /** Positive = overpriced, negative = below market */
  priceDelta?: number | null;
  confidence?: "high" | "medium" | "low";
};

export type VehicleIntelligence = {
  knownWatchouts: Array<{
    issue: string;
    severity: "low" | "medium" | "high";
    relatedServices: string[];
  }>;
};

export type Context = {
  vehicleAgeYears?: number;
  mileage?: number;
  numberOfServices?: number;
};

// ─── Score breakdown ──────────────────────────────────────────────────────────

export type ScoreBreakdown = {
  urgencyScore: number;
  timeScore: number;
  pricingScore: number;
  vehicleRiskScore: number;
  totalScore: number;
  priority: "high" | "medium" | "low";
  scoreReasons: string[];
};

// ─── Scoring functions ────────────────────────────────────────────────────────

function scoreUrgency(urgency: ServiceInput["urgency"]): { score: number; reason: string | null } {
  switch (urgency) {
    case "high":   return { score: 40, reason: "High urgency service" };
    case "medium": return { score: 25, reason: null };
    case "low":    return { score: 10, reason: null };
  }
}

function scoreTime(timeStatus: ServiceInput["timeStatus"]): { score: number; reason: string | null } {
  switch (timeStatus) {
    case "overdue":  return { score: 25, reason: "Overdue based on time or mileage" };
    case "due_now":  return { score: 15, reason: "Due now" };
    case "current":  return { score: 5,  reason: null };
    case "unknown":  return { score: 10, reason: "Service timing is uncertain" };
    default:         return { score: 0,  reason: null };
  }
}

function scorePricing(input: ServiceInput): { score: number; reason: string | null } {
  // Use priceDelta if provided; otherwise compute from price vs market range
  let overageRatio: number | null = null;

  if (input.priceDelta != null && input.marketMin != null && input.marketMin > 0) {
    overageRatio = input.priceDelta / input.marketMin;
  } else if (
    input.price != null &&
    input.marketMax != null &&
    input.price > input.marketMax
  ) {
    overageRatio = (input.price - input.marketMax) / input.marketMax;
  }

  if (overageRatio === null) return { score: 5, reason: null }; // no pricing data → neutral

  if (overageRatio >= 0.30) return { score: 20, reason: "Price is significantly above market rate" };
  if (overageRatio >= 0.10) return { score: 15, reason: "Price is moderately above market rate" };
  if (overageRatio >= 0)    return { score: 5,  reason: null };
  return { score: 2, reason: null }; // below market
}

function scoreVehicleRisk(
  canonicalService: string,
  intelligence: VehicleIntelligence | null
): { score: number; reason: string | null } {
  if (!intelligence || intelligence.knownWatchouts.length === 0) {
    return { score: 0, reason: null };
  }

  for (const watchout of intelligence.knownWatchouts) {
    const related = watchout.relatedServices.some(
      s => s.toLowerCase() === canonicalService.toLowerCase()
    );
    if (!related) continue;

    switch (watchout.severity) {
      case "high":   return { score: 15, reason: `Related to known issue: ${watchout.issue}` };
      case "medium": return { score: 10, reason: `Connected to known risk: ${watchout.issue}` };
      case "low":    return { score: 5,  reason: null };
    }
  }

  return { score: 0, reason: null };
}

// ─── Main scoring export ──────────────────────────────────────────────────────

export function scoreService(
  service: ServiceInput,
  intelligence: VehicleIntelligence | null = null,
  context: Context = {}
): ScoreBreakdown {
  void context; // reserved for future weight adjustments (e.g. high-mileage vehicle)

  const urgency   = scoreUrgency(service.urgency);
  const time      = scoreTime(service.timeStatus);
  const pricing   = scorePricing(service);
  const vehicle   = scoreVehicleRisk(service.canonicalService, intelligence);

  const totalScore = Math.min(
    100,
    urgency.score + time.score + pricing.score + vehicle.score
  );

  const priority: "high" | "medium" | "low" =
    totalScore >= 70 ? "high" :
    totalScore >= 40 ? "medium" :
    "low";

  const scoreReasons = [
    urgency.reason,
    time.reason,
    pricing.reason,
    vehicle.reason,
  ].filter((r): r is string => r !== null);

  return {
    urgencyScore: urgency.score,
    timeScore: time.score,
    pricingScore: pricing.score,
    vehicleRiskScore: vehicle.score,
    totalScore,
    priority,
    scoreReasons,
  };
}
