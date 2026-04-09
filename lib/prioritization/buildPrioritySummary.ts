// lib/prioritization/buildPrioritySummary.ts
//
// Synthesizes scored services into a concise, decisive output.
// Drives: advisor chat opening, summary card, next-best-action UI.
//
// Produces max 3 top items — not a full list.
// Produces: summary (2 sentences), nextBestAction (1 sentence), doneState (1 sentence).

import {
  scoreService,
  type ServiceInput,
  type VehicleIntelligence,
  type Context,
  type ScoreBreakdown,
} from "./scoreService";

// ─── Output type ──────────────────────────────────────────────────────────────

export type PriorityOutputItem = {
  serviceId: string;
  canonicalService: string;
  displayName: string;
  score: number;
  priority: "high" | "medium" | "low";
  reason: string;
};

export type PriorityOutput = {
  topItems: PriorityOutputItem[];
  summary: string;
  nextBestAction: string;
  doneState: string;
};

// ─── Reason generation ────────────────────────────────────────────────────────

function buildItemReason(service: ServiceInput, breakdown: ScoreBreakdown): string {
  const reasons = breakdown.scoreReasons;

  if (reasons.length === 0) {
    // Fallback based on urgency
    if (service.urgency === "high") return "High-priority service — should not be deferred.";
    if (service.urgency === "medium") return "Worth addressing soon.";
    return "Can wait but should be tracked.";
  }

  // Lead with the highest-signal reason
  if (reasons.some(r => r.includes("known issue") || r.includes("known risk"))) {
    return reasons.find(r => r.includes("known"))!;
  }
  if (reasons.some(r => r.includes("Overdue"))) {
    const pricingReason = reasons.find(r => r.includes("market"));
    return pricingReason
      ? `Overdue and ${pricingReason.toLowerCase()}`
      : "Overdue based on time or mileage — needs attention.";
  }
  if (reasons.some(r => r.includes("market"))) {
    return reasons.find(r => r.includes("market"))!;
  }

  return reasons[0];
}

// ─── Summary generation ───────────────────────────────────────────────────────

function buildSummary(
  topItems: PriorityOutputItem[],
  allServices: ServiceInput[],
  context: Context
): string {
  const highCount = topItems.filter(i => i.priority === "high").length;
  const hasOverdue = allServices.some(s => s.timeStatus === "overdue");
  const hasOverprice = allServices.some(s => {
    if (s.priceDelta != null && s.marketMin != null && s.marketMin > 0) {
      return s.priceDelta / s.marketMin >= 0.10;
    }
    return false;
  });

  if (allServices.length === 0 || topItems.length === 0) {
    return "We need more information to make a confident recommendation. Confirm vehicle details or upload a service history document.";
  }

  if (highCount === 0 && !hasOverdue && !hasOverprice) {
    return "Nothing stands out as urgent. Pricing and timing look reasonable for this vehicle.";
  }

  const parts: string[] = [];

  if (hasOverdue) {
    const overdueCount = allServices.filter(s => s.timeStatus === "overdue").length;
    parts.push(`${overdueCount === 1 ? "One service appears" : `${overdueCount} services appear`} overdue based on age or mileage`);
  }

  if (hasOverprice) {
    parts.push("at least one service is priced above market rate");
  }

  const intro = parts.length > 0
    ? `${parts.join(" and ")}.`
    : `${highCount} high-priority item${highCount > 1 ? "s" : ""} found.`;

  const ageNote = context.vehicleAgeYears && context.vehicleAgeYears > 8
    ? " Given the vehicle's age, some deferred maintenance may be expected."
    : "";

  return `${intro}${ageNote}`.trim();
}

// ─── Next best action generation ──────────────────────────────────────────────

function buildNextBestAction(
  topItems: PriorityOutputItem[],
  allServices: ServiceInput[]
): string {
  if (allServices.length === 0 || topItems.length === 0) {
    return "Confirm vehicle details or upload a service history document.";
  }

  const topHigh = topItems.find(i => i.priority === "high");

  if (!topHigh) {
    return "No urgent items — proceed if you're comfortable with the price and timeline.";
  }

  const service = allServices.find(s => s.id === topHigh.serviceId);

  if (service?.timeStatus === "overdue") {
    return `Address the ${topHigh.displayName || topHigh.canonicalService.replace(/_/g, " ")} first — it appears overdue and should not be deferred.`;
  }

  if (topHigh.reason.toLowerCase().includes("market")) {
    return `Get a second quote on the ${topHigh.displayName || topHigh.canonicalService.replace(/_/g, " ")} before approving — pricing looks above market.`;
  }

  if (topHigh.reason.toLowerCase().includes("known")) {
    return `Ask the shop to specifically inspect the ${topHigh.displayName || topHigh.canonicalService.replace(/_/g, " ")} — this is a known issue area for this vehicle.`;
  }

  return `Focus on the ${topHigh.displayName || topHigh.canonicalService.replace(/_/g, " ")} first — it has the highest priority score.`;
}

// ─── Done-state generation ────────────────────────────────────────────────────

function buildDoneState(
  topItems: PriorityOutputItem[],
  allServices: ServiceInput[]
): string {
  if (allServices.length === 0 || topItems.length === 0) {
    return "You're done when you have enough information to make a decision.";
  }

  const hasHigh = topItems.some(i => i.priority === "high");
  const hasOverprice = allServices.some(s => {
    if (s.priceDelta != null && s.marketMin != null && s.marketMin > 0) {
      return s.priceDelta / s.marketMin >= 0.10;
    }
    return false;
  });

  if (!hasHigh && !hasOverprice) {
    return "You're done — proceed if you're satisfied with the timing and price.";
  }

  if (hasOverprice && !hasHigh) {
    return "You're done once you've confirmed fair pricing or obtained a second quote.";
  }

  if (hasHigh) {
    return "You're done once you've confirmed the overdue service is addressed or negotiated into the deal.";
  }

  return "You're done once you've addressed the flagged items or made an informed decision to defer them.";
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Score, rank, and synthesize services into a decisive priority output.
 *
 * @param services      - Input services from maintenance audit or quote audit
 * @param intelligence  - Optional vehicle-specific watchouts
 * @param context       - Optional vehicle context (age, mileage)
 * @returns             - topItems (max 3), summary, nextBestAction, doneState
 */
export function buildPrioritySummary(
  services: ServiceInput[],
  intelligence: VehicleIntelligence | null = null,
  context: Context = {}
): PriorityOutput {
  // Edge case: no data
  if (services.length === 0) {
    return {
      topItems: [],
      summary: "We need more information to make a confident recommendation. Confirm vehicle details or service history.",
      nextBestAction: "Confirm vehicle details or upload a service history document.",
      doneState: "You're done when you have enough information to make a decision.",
    };
  }

  // Score all services
  const scored = services.map(service => {
    const breakdown = scoreService(service, intelligence, context);
    return { service, breakdown };
  });

  // Sort by score descending
  scored.sort((a, b) => b.breakdown.totalScore - a.breakdown.totalScore);

  // Take top 3 (not medium/low noise)
  const top3 = scored.slice(0, 3);

  const topItems: PriorityOutputItem[] = top3.map(({ service, breakdown }) => ({
    serviceId: service.id,
    canonicalService: service.canonicalService,
    displayName: service.displayName ?? service.canonicalService.replace(/_/g, " "),
    score: breakdown.totalScore,
    priority: breakdown.priority,
    reason: buildItemReason(service, breakdown),
  }));

  const summary = buildSummary(topItems, services, context);
  const nextBestAction = buildNextBestAction(topItems, services);
  const doneState = buildDoneState(topItems, services);

  return { topItems, summary, nextBestAction, doneState };
}

// ─── Adapter: Maintenance Debt Items → ServiceInput ───────────────────────────
// Convenience adapter so the maintenance audit can use this without manual mapping.

import type { MaintenanceDebtItem } from "@/lib/maintenanceDebt/types";

export function debtItemsToServiceInputs(items: MaintenanceDebtItem[]): ServiceInput[] {
  return items
    .filter(i => i.status !== "done" && i.status !== "upcoming")
    .map(item => ({
      id: item.canonicalService,
      canonicalService: item.canonicalService,
      displayName: item.displayName,
      urgency: item.severity,
      timeStatus: item.status === "overdue" ? "overdue"
        : item.status === "due_now" ? "due_now"
        : item.status === "unknown" ? "unknown"
        : "current",
      price: item.estimatedCostLow ?? undefined,
      confidence: item.evidenceFound ? "high" : "low",
    }));
}
