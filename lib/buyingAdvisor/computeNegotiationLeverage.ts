// lib/buyingAdvisor/computeNegotiationLeverage.ts
//
// Derives negotiation leverage from the audit result.
// Feeding into BuyingAdvisorChatContext.negotiationLeverage.

import type { MaintenanceDebtAuditResult } from "@/lib/maintenanceDebt/types";

export type NegotiationLeverage = {
  level: "low" | "moderate" | "strong";
  reasons: string[];
};

export function computeNegotiationLeverage(
  result: MaintenanceDebtAuditResult
): NegotiationLeverage {
  const debtLow = result.debtEstimateLow ?? 0;
  const debtHigh = result.debtEstimateHigh ?? debtLow;
  const overdueCount = result.debtItems.filter(
    i => i.status === "overdue" || i.status === "due_now"
  ).length;
  const hasHighSeverity = result.debtItems.some(
    i => i.severity === "high" && i.status !== "done"
  );
  const timeBasedCount = result.debtItems.filter(
    i => i.detectionMethod === "time" || i.detectionMethod === "both"
  ).length;
  const highConfidenceEvents = result.normalizedHistory.filter(
    e => e.confidence === "high" || e.confidence === "medium"
  ).length;
  const historyIsPoor = highConfidenceEvents < 3;
  const isIncomplete = result.verdict === "incomplete";

  const reasons: string[] = [];
  let score = 0;

  // Debt estimate value
  if (debtLow >= 2000) {
    score += 3;
    reasons.push(`Estimated $${debtLow.toLocaleString()}–$${debtHigh.toLocaleString()} in catch-up maintenance`);
  } else if (debtLow >= 1000) {
    score += 2;
    reasons.push(`Estimated ~$${debtLow.toLocaleString()} in deferred maintenance`);
  } else if (debtLow >= 400) {
    score += 1;
    reasons.push(`Roughly $${debtLow.toLocaleString()} in likely maintenance costs`);
  }

  // Overdue count
  if (overdueCount >= 4) {
    score += 2;
    reasons.push(`${overdueCount} services missing or overdue`);
  } else if (overdueCount >= 2) {
    score += 1;
    reasons.push(`${overdueCount} services missing or overdue`);
  }

  // Time-based gaps (not visible from mileage alone)
  if (timeBasedCount >= 2) {
    score += 1;
    reasons.push(`${timeBasedCount} time-based service gaps not apparent from mileage`);
  }

  // High severity
  if (hasHighSeverity) {
    score += 1;
    reasons.push("At least one high-severity service is undocumented");
  }

  // Poor history
  if (historyIsPoor || isIncomplete) {
    score += 1;
    reasons.push("Service history is sparse or difficult to verify");
  }

  const level: NegotiationLeverage["level"] =
    score >= 5 ? "strong" :
    score >= 2 ? "moderate" :
    "low";

  if (reasons.length === 0) {
    reasons.push("Maintenance record looks reasonably complete — leverage is limited");
  }

  return { level, reasons };
}
