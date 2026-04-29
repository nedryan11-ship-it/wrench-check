// lib/maintenanceDebt/verdict.ts
// Confidence-aware verdict classification.
//
// KEY PRINCIPLE: Maintenance cost alone ≠ risk.
// Missing records ≠ Overdue. Routine gaps ≠ Walk Away.
// Verdicts must feel proportional and grounded in real-world impact.

import type { MaintenanceDebtItem } from "./types";

const UPCOMING_WINDOW_MILES = 10_000;

export type Verdict =
  | "strong_buy"           // clean history, confirmed records
  | "good_buy"             // minor gaps, well-maintained overall
  | "buy_if_priced_right"  // routine maintenance gaps — default middle state
  | "proceed_caution"      // multiple gaps or safety-adjacent items, verify first
  | "pass"                 // serious confirmed drivetrain/safety issues
  | "reasonable_buy"       // legacy alias → good_buy
  | "clean"                // legacy alias → strong_buy
  | "light_catch_up"       // legacy alias → buy_if_priced_right
  | "maintenance_debt_risk"// legacy alias → proceed_caution
  | "high_risk"            // legacy alias → proceed_caution
  | "walk_away"            // legacy alias → pass
  | "incomplete";          // no schedule available

interface VerdictInput {
  debtItems: MaintenanceDebtItem[];
  debtEstimateLow?: number | null;
  debtEstimateHigh?: number | null;
  confidence?: "low" | "medium" | "high";
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
  // Use midpoint of estimate range for calibration
  const estimateMid = debtEstimateHigh != null && debtEstimateLow != null
    ? (debtEstimateLow + debtEstimateHigh) / 2
    : (debtEstimateHigh ?? debtEstimateLow ?? 0);

  const isWeakSignal =
    scheduleSource !== "vehicle_databases" || confidence === "low";

  // ── No overdue items → positive result ────────────────────────────────────
  if (overdueCount === 0) {
    return scheduleSource === "vehicle_databases" && confidence !== "low"
      ? "strong_buy"
      : "good_buy";
  }

  // ── Pass: only for confirmed serious drivetrain/safety failures ───────────
  // Requires: strong signal + multiple high-severity items + significant cost
  if (
    !isWeakSignal &&
    highSevCount >= 3 &&
    overdueCount >= 5 &&
    estimateMid > 3_000
  ) {
    return "pass";
  }

  // ── Proceed with caution: meaningful confirmed gaps ────────────────────────
  // Only when: strong signal + multiple high-sev + $2k+ cost
  if (
    !isWeakSignal &&
    highSevCount >= 2 &&
    estimateMid >= 2_000
  ) {
    return "proceed_caution";
  }

  // ── Buy if priced right: routine maintenance gaps (default middle) ─────────
  // $300–$1,999 routine catch-up, or AI-estimated data with multiple gaps
  if (overdueCount >= 2 || estimateMid >= 300) {
    return "buy_if_priced_right";
  }

  // ── Good buy: single minor item, low cost ─────────────────────────────────
  return "good_buy";
}

export function verdictLabel(verdict: Verdict): string {
  switch (verdict) {
    case "strong_buy":
    case "clean":
      return "Strong Buy";
    case "good_buy":
    case "reasonable_buy":
    case "light_catch_up":
      return "Good Buy";
    case "buy_if_priced_right":
      return "Buy if Priced Right";
    case "proceed_caution":
    case "maintenance_debt_risk":
    case "high_risk":
      return "Proceed with Caution";
    case "pass":
    case "walk_away":
      return "Pass";
    case "incomplete":
      return "Incomplete Analysis";
  }
}

export function verdictColor(verdict: Verdict): string {
  switch (verdict) {
    case "strong_buy":
    case "clean":
      return "#16A34A";  // green
    case "good_buy":
    case "reasonable_buy":
    case "light_catch_up":
      return "#2563EB";  // blue — positive signal
    case "buy_if_priced_right":
      return "#D97706";  // amber — neutral, factor it in
    case "proceed_caution":
    case "maintenance_debt_risk":
    case "high_risk":
      return "#C2410C";  // orange-red — caution but not panic
    case "pass":
    case "walk_away":
      return "#DC2626";  // red — reserved for genuine problems
    case "incomplete":
      return "#7C3AED";  // purple
  }
}

export { UPCOMING_WINDOW_MILES };
