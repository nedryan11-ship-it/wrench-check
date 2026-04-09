// lib/maintenanceDebt/compareEngine.ts
// Pure comparison function — no API calls, no side effects.
// Takes pre-fetched/normalized data and produces a MaintenanceDebtAuditResult.
//
// Evaluation order for each service:
//   1. Mileage-based: is a checkpoint due at or below current mileage?
//   2. Time-based: is this a time-sensitive service? Evaluate by age/date.
//   3. Merge: take the "worse" of the two verdicts (conservative).

import type {
  CompareEngineInput,
  MaintenanceDebtAuditResult,
  MaintenanceDebtItem,
  MaintenanceScheduleItem,
  NormalizedServiceEvent,
  ServiceCostEstimate,
  CanonicalService,
} from "./types";
import { computeVerdict, UPCOMING_WINDOW_MILES } from "./verdict";
import {
  evaluateTimeBasedServiceStatus,
  worseStatus,
  TIME_RULES,
  type TimeBasedStatus,
} from "@/lib/maintenance/timeBasedRules";

// ─── Matching logic ───────────────────────────────────────────────────────────

/**
 * Find normalized history events that match a canonical service.
 * Only "high" or "medium" confidence events count as evidence.
 * Low confidence / "unknown_service" events NEVER satisfy a schedule item.
 */
function findMatches(
  canonicalService: CanonicalService,
  normalizedHistory: NormalizedServiceEvent[],
  dueMileage: number | null | undefined
): NormalizedServiceEvent[] {
  return normalizedHistory.filter((event) => {
    if (event.confidence === "low" || event.canonicalService === "unknown_service") {
      return false;
    }
    if (event.canonicalService !== canonicalService) {
      return false;
    }
    // Event mileage must be at or before the due mileage (with 2k mile tolerance)
    if (dueMileage != null && event.mileage != null && event.mileage > dueMileage + 2000) {
      return false;
    }
    return true;
  });
}

/**
 * For a recurring service (e.g., air filter at 15k, 30k, 45k...),
 * find the LAST checkpoint that is at or below currentMileage.
 */
function getLastDueCheckpoint(
  canonicalService: CanonicalService,
  schedule: MaintenanceScheduleItem[],
  currentMileage: number
): MaintenanceScheduleItem | null {
  const relevant = schedule
    .filter(
      (s) =>
        s.canonicalService === canonicalService &&
        s.dueMileage != null &&
        s.dueMileage <= currentMileage
    )
    .sort((a, b) => (b.dueMileage ?? 0) - (a.dueMileage ?? 0));
  return relevant[0] ?? null;
}

/**
 * Find the next upcoming checkpoint for a service (just over currentMileage).
 */
function getNextUpcomingCheckpoint(
  canonicalService: CanonicalService,
  schedule: MaintenanceScheduleItem[],
  currentMileage: number
): MaintenanceScheduleItem | null {
  const upcoming = schedule
    .filter(
      (s) =>
        s.canonicalService === canonicalService &&
        s.dueMileage != null &&
        s.dueMileage > currentMileage &&
        s.dueMileage <= currentMileage + UPCOMING_WINDOW_MILES
    )
    .sort((a, b) => (a.dueMileage ?? 0) - (b.dueMileage ?? 0));
  return upcoming[0] ?? null;
}

// ─── Reasoning strings ────────────────────────────────────────────────────────

function buildMileageReasoning(
  displayName: string,
  status: MaintenanceDebtItem["status"],
  dueMileage: number | null | undefined,
  currentMileage: number | null | undefined,
  overdueMiles: number | null | undefined,
  matchCount: number
): string {
  const due = dueMileage ? dueMileage.toLocaleString() : "unknown";
  const current = currentMileage ? currentMileage.toLocaleString() : "unknown";

  switch (status) {
    case "done":
      return `${matchCount === 1 ? "1 matching record" : `${matchCount} matching records`} found in service history for ${displayName} at or before ${due} miles.`;
    case "overdue":
      // KEY: "no record of" not "overdue" — absence of record ≠ confirmed neglect
      return `No record of ${displayName} found in the provided service history. Based on mileage, this service was likely due by ${due} miles — worth verifying before purchase.`;
    case "due_now":
      return `No record of ${displayName} found. Based on the OEM schedule and current mileage (${current} mi), this service appears due now — worth confirming.`;
    case "upcoming":
      return `${displayName} is coming due at ${due} miles. Not yet required at ${current} miles.`;
    case "unknown":
      return `No record of ${displayName} found. Service history doesn't confirm or deny whether this was completed — consider asking the seller for documentation.`;
    default:
      return `No clear documentation found for ${displayName} in the provided service records.`;
  }
}

// ─── Status merging ───────────────────────────────────────────────────────────

function mergeStatuses(
  mileageStatus: MaintenanceDebtItem["status"],
  timeStatus: TimeBasedStatus | null
): MaintenanceDebtItem["status"] {
  if (!timeStatus) return mileageStatus;
  // Take the worse of the two — never let low-mileage mask time-based debt
  return worseStatus(
    mileageStatus as TimeBasedStatus,
    timeStatus
  ) as MaintenanceDebtItem["status"];
}

function mergeDetectionMethod(
  hasMileage: boolean,
  hasTime: boolean,
  timeChanged: boolean
): MaintenanceDebtItem["detectionMethod"] {
  if (hasMileage && hasTime && timeChanged) return "both";
  if (hasTime && timeChanged) return "time";
  if (hasMileage) return "mileage";
  return "unknown";
}

// ─── Core comparison function ─────────────────────────────────────────────────

export function compareHistoryToSchedule({
  vehicle,
  normalizedHistory,
  schedule,
  repairEstimates,
}: CompareEngineInput): MaintenanceDebtAuditResult {
  const currentMileage = vehicle.currentMileage ?? null;
  const vehicleYear = vehicle.year ?? null;
  const currentDate = new Date();

  const debtItems: MaintenanceDebtItem[] = [];
  const completedItems: MaintenanceDebtItem[] = [];
  const upcomingItems: MaintenanceDebtItem[] = [];

  // Deduplicate: process each unique canonicalService once
  const uniqueServices = [...new Set(schedule.map((s) => s.canonicalService))];

  for (const canonicalService of uniqueServices) {
    const allCheckpoints = schedule.filter((s) => s.canonicalService === canonicalService);
    const firstCheckpoint = allCheckpoints[0];

    const displayName = firstCheckpoint.displayName;
    const severity = firstCheckpoint.severity;
    const pricing: ServiceCostEstimate | undefined = repairEstimates[canonicalService];
    const estimatedCostLow = pricing?.estimateLow ?? null;
    const estimatedCostHigh = pricing?.estimateHigh ?? null;
    const isTimeSensitive = Boolean(TIME_RULES[canonicalService]);

    // ── Layer 1: PPI Check (Precedence) ──────────────────────────────────────
    // If we have an inspection report finding for this service, it overrides
    // mileage/time based estimates because it is a direct observation of condition.
    const ppiEvent = normalizedHistory.find(h => h.canonicalService === canonicalService && h.is_ppi);
    
    if (ppiEvent) {
      const ppiStatus = ppiEvent.ppi_is_good ? "done" : "overdue";
      const ppiReasoning = ppiEvent.ppi_is_good
        ? `Condition confirmed: Professional inspection found ${displayName} to be in good condition.`
        : `Immediate attention needed: Professional inspection confirmed ${displayName} requires replacement or service.`;

      const ppiItem: MaintenanceDebtItem = {
        canonicalService,
        displayName,
        status: ppiStatus,
        detectionMethod: "unknown", // It's physical inspection
        dueMileage: ppiEvent.mileage ?? null,
        currentMileage,
        overdueMiles: null,
        overdueMonths: null,
        lastServiceDate: ppiEvent.date ?? null,
        evidenceFound: true,
        matchingHistoryEventIds: [ppiEvent.id],
        estimatedCostLow: ppiStatus === "overdue" ? estimatedCostLow : null,
        estimatedCostHigh: ppiStatus === "overdue" ? estimatedCostHigh : null,
        severity,
        reasoning: ppiReasoning,
      };

      if (ppiStatus === "done") completedItems.push(ppiItem);
      else debtItems.push(ppiItem);
      continue; // Skip mileage/time dance for this service
    }

    // ── Mileage-based evaluation ──────────────────────────────────────────────

    let mileageStatus: MaintenanceDebtItem["status"] = "unknown";
    let lastDueCheckpoint: MaintenanceScheduleItem | null = null;
    let matchingEvents: NormalizedServiceEvent[] = [];
    let overdueMiles: number | null = null;
    let evidenceFound = false;
    let mileageReasoning = "";
    let hasMileageData = false;

    if (currentMileage != null) {
      hasMileageData = true;
      lastDueCheckpoint = getLastDueCheckpoint(canonicalService, schedule, currentMileage);

      if (lastDueCheckpoint) {
        matchingEvents = findMatches(canonicalService, normalizedHistory, lastDueCheckpoint.dueMileage);
        evidenceFound = matchingEvents.length > 0;
        overdueMiles = !evidenceFound ? currentMileage - (lastDueCheckpoint.dueMileage ?? 0) : null;

        if (evidenceFound) {
          mileageStatus = "done";
        } else if (overdueMiles != null && overdueMiles > 5000) {
          mileageStatus = "overdue";
        } else if (overdueMiles != null && overdueMiles >= 0) {
          mileageStatus = "due_now";
        } else {
          mileageStatus = "unknown";
        }

        mileageReasoning = buildMileageReasoning(
          displayName, mileageStatus, lastDueCheckpoint.dueMileage,
          currentMileage, overdueMiles, matchingEvents.length
        );
      } else {
        // No checkpoint at/below currentMileage — check upcoming window
        const nextUpcoming = getNextUpcomingCheckpoint(canonicalService, schedule, currentMileage);
        if (nextUpcoming) {
          const upcomingItem: MaintenanceDebtItem = {
            canonicalService,
            displayName,
            status: "upcoming",
            detectionMethod: "mileage",
            dueMileage: nextUpcoming.dueMileage,
            currentMileage,
            overdueMiles: null,
            overdueMonths: null,
            lastServiceDate: null,
            evidenceFound: false,
            matchingHistoryEventIds: [],
            estimatedCostLow: null,
            estimatedCostHigh: null,
            severity,
            reasoning: buildMileageReasoning(displayName, "upcoming", nextUpcoming.dueMileage, currentMileage, null, 0),
          };
          upcomingItems.push(upcomingItem);
          continue;
        }
        // No upcoming checkpoint either — fall through to time-based only
        mileageStatus = "unknown";
        // Still try to find any matches (no mileage constraint)
        matchingEvents = findMatches(canonicalService, normalizedHistory, null);
        evidenceFound = matchingEvents.length > 0;
        mileageReasoning = `Current mileage doesn't yet require ${displayName} based on the OEM schedule.`;
      }
    } else {
      // No mileage — find any matching events for time-based use
      matchingEvents = findMatches(canonicalService, normalizedHistory, null);
      evidenceFound = matchingEvents.length > 0;
      mileageReasoning = `Mileage unknown — cannot assess whether ${displayName} is due. Worth verifying with the seller.`;
    }

    // ── Time-based evaluation ─────────────────────────────────────────────────

    let timeEval: ReturnType<typeof evaluateTimeBasedServiceStatus> = null;
    let overdueMonths: number | null = null;
    let lastServiceDate: string | null = null;

    if (isTimeSensitive && vehicleYear != null) {
      timeEval = evaluateTimeBasedServiceStatus({
        vehicleYear,
        currentDate,
        canonicalService,
        matchingHistoryEvents: matchingEvents,
      });

      if (timeEval) {
        overdueMonths = timeEval.monthsOverdue != null && timeEval.monthsOverdue > 0
          ? timeEval.monthsOverdue
          : null;
        lastServiceDate = timeEval.lastServiceDate ?? null;
      }
    }

    // ── Merge mileage + time results ──────────────────────────────────────────

    const finalStatus = mergeStatuses(mileageStatus, timeEval?.status ?? null);
    const mileageChangedByTime = finalStatus !== mileageStatus;
    const detectionMethod = mergeDetectionMethod(hasMileageData, isTimeSensitive, mileageChangedByTime);

    // Compose reasoning — if time-based changed the result, surface the time reasoning
    const reasoning = mileageChangedByTime && timeEval
      ? timeEval.reasoning
      : mileageReasoning;

    const item: MaintenanceDebtItem = {
      canonicalService,
      displayName,
      status: finalStatus,
      detectionMethod,
      dueMileage: lastDueCheckpoint?.dueMileage ?? null,
      currentMileage,
      overdueMiles,
      overdueMonths,
      lastServiceDate,
      evidenceFound,
      matchingHistoryEventIds: matchingEvents.map((m) => m.id),
      estimatedCostLow: finalStatus !== "done" ? estimatedCostLow : null,
      estimatedCostHigh: finalStatus !== "done" ? estimatedCostHigh : null,
      severity,
      reasoning,
    };

    if (finalStatus === "done") {
      completedItems.push(item);
    } else if (finalStatus === "upcoming") {
      upcomingItems.push(item);
    } else {
      debtItems.push(item);
    }
  }

  // ── Sort debt items: severity first, then worst overdue ───────────────────

  const severityScore = { high: 3, medium: 2, low: 1 };
  debtItems.sort((a, b) => {
    const diff = severityScore[b.severity] - severityScore[a.severity];
    if (diff !== 0) return diff;
    // Time-based items surface before mileage-only unknowns
    if (a.status === "overdue" && b.status !== "overdue") return -1;
    if (b.status === "overdue" && a.status !== "overdue") return 1;
    return (b.overdueMiles ?? b.overdueMonths ?? 0) - (a.overdueMiles ?? a.overdueMonths ?? 0);
  });

  // ── Totals ────────────────────────────────────────────────────────────────

  const priced = debtItems.filter(
    (i) => (i.status === "overdue" || i.status === "due_now") && i.estimatedCostLow != null
  );
  const debtEstimateLow = priced.length > 0
    ? priced.reduce((sum, i) => sum + (i.estimatedCostLow ?? 0), 0)
    : null;
  const debtEstimateHigh = priced.length > 0
    ? priced.reduce((sum, i) => sum + (i.estimatedCostHigh ?? i.estimatedCostLow ?? 0), 0)
    : null;

  const verdict = computeVerdict({ debtItems, debtEstimateLow, debtEstimateHigh });

  const overdueCount = debtItems.filter(
    (i) => i.status === "overdue" || i.status === "due_now"
  ).length;
  const timeBasedCount = debtItems.filter(i => i.detectionMethod === "time" || i.detectionMethod === "both").length;

  const summary = overdueCount === 0
    ? "Service history appears complete for the current mileage and vehicle age."
    : [
        `${overdueCount} service${overdueCount > 1 ? "s have" : " has"} no documentation in the provided records.`,
        timeBasedCount > 0 ? `${timeBasedCount} ${timeBasedCount === 1 ? "is" : "are"} flagged by vehicle age, not just mileage.` : "",
        debtEstimateLow != null ? `Estimated catch-up if services are needed: $${debtEstimateLow.toFixed(0)}–$${(debtEstimateHigh ?? debtEstimateLow).toFixed(0)}.` : "",
      ].filter(Boolean).join(" ");

  return {
    vehicle,
    extractedHistory: [],  // populated by orchestration layer
    normalizedHistory,
    schedule,
    debtItems,
    completedItems,
    upcomingItems,
    debtEstimateLow,
    debtEstimateHigh,
    verdict,
    summary,
    confidence: "medium",        // overwritten by route.ts
    scheduleSource: "none",      // overwritten by route.ts
  };
}
