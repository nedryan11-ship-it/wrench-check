// lib/maintenanceDebt/verdict.ts
// Confidence-aware verdict classification.
//
// KEY PRINCIPLE: Missing ≠ Overdue.
// When schedule is AI-estimated, "not in records" means "unknown", not "neglected".
// Only fire aggressive verdicts when we have VDB-confirmed data + clear evidence.

import type { MaintenanceDebtItem } from "./types";

const UPCOMING_WINDOW_MILES = 10_000;

export type Verdict =
  | "strong_buy"           // clean history, evidence confirmed
  | "reasonable_buy"       // 1–2 gaps, manageable cost — default middle state
  | "proceed_caution"      // missing services, verify before buying
  | "high_risk"            // serious confirmed gaps with safety relevance
  | "walk_away"            // rare: reserved for confirmed structural failures
  | "clean"                // legacy alias → strong_buy in UI
  | "light_catch_up"       // legacy alias → reasonable_buy in UI
  | "maintenance_debt_risk"// legacy alias → proceed_caution in UI
  | "incomplete";          // no schedule available

interface VerdictInput {
  debtItems: MaintenanceDebtItem[];
  debtEstimateLow?: number | null;
  debtEstimateHigh?: number | null;
  /** Confidence of the overall result — affects aggressiveness */
  confidence?: "low" | "medium" | "high";
  /** Where the OEM schedule came from — drives weak-signal detection */
  scheduleSource?: "vehicle_databases" | "ai_estimated" | "none";
}

export function computeVerdict({
  debtItems,
  debtEstimateLow,
  debtEstimateHigh,
  confidence = "medium",
  scheduleSource = "ai_estimated",
}: VerdictInput): Verdict {
  const overdueItems = debtItems.filter(
    (i) => i.status === "overdue" || i.status === "due_now"
  );
  const overdueCount = overdueItems.length;
  const highSevCount = overdueItems.filter((i) => i.severity === "high").length;
  const estimate = debtEstimateHigh ?? debtEstimateLow ?? 0;

  // Weak signal: AI-estimated schedule OR low confidence.
  // These results cannot accurately distinguish "neglected" from "unrecorded".
  const isWeakSignal =
    scheduleSource !== "vehicle_databases" || confidence === "low";

  // No overdue items → positive result
  if (overdueCount === 0) {
    return scheduleSource === "vehicle_databases" && confidence !== "low"
      ? "strong_buy"
      : "reasonable_buy";
  }

  // High risk: only fire with strong signal (VDB + confirmed data) + serious debt
  // Never auto-trigger for AI-estimated results — those are "unknown", not "neglected"
  if (
    !isWeakSignal &&
    highSevCount >= 2 &&
    overdueCount >= 4 &&
    estimate > 1_500
  ) {
    return "high_risk";
  }

  // Proceed with caution: meaningful gaps BUT data quality is uncertain
  // This replaces "high_risk" for the vast majority of AI-estimated results
  if (overdueCount >= 3 || estimate >= 700) {
    return "proceed_caution";
  }

  // Reasonable buy: 1–2 items, manageable cost
  return "reasonable_buy";
}

export function verdictLabel(verdict: Verdict): string {
  switch (verdict) {
    case "strong_buy":
    case "clean":
      return "Strong Buy";
    case "reasonable_buy":
    case "light_catch_up":
      return "Reasonable Buy";
    case "proceed_caution":
    case "maintenance_debt_risk":
      return "Proceed with Caution";
    case "high_risk":
      return "High Risk";
    case "walk_away":
      return "Walk Away";
    case "incomplete":
      return "Incomplete Analysis";
  }
}

export function verdictColor(verdict: Verdict): string {
  switch (verdict) {
    case "strong_buy":
    case "clean":
      return "#16A34A";
    case "reasonable_buy":
    case "light_catch_up":
      return "#D97706";
    case "proceed_caution":
    case "maintenance_debt_risk":
      return "#C2410C";
    case "high_risk":
    case "walk_away":
      return "#DC2626";
    case "incomplete":
      return "#7C3AED";
  }
}

export { UPCOMING_WINDOW_MILES };
