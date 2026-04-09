// lib/maintenance/timeBasedRules.ts
//
// Time-based maintenance detection engine.
// Evaluates services that have a meaningful interval in months — not just mileage.
//
// Integrates with the existing compareEngine:
//   - compareEngine handles mileage-based logic
//   - this module handles time-based logic
//   - compareEngine merges both, taking the "worse" outcome
//
// Key product rule: a 10-year-old car with 45k miles may still be overdue
// for coolant, brake fluid, belt, and battery — based on age alone.

import type { CanonicalService } from "@/lib/services/canonicalServices";
import type { NormalizedServiceEvent } from "@/lib/maintenanceDebt/types";
import {
  vehicleAgeMonths,
  monthsSinceDate,
  mostRecentServiceDate,
  isPlausibleServiceDate,
} from "./serviceAgeUtils";

// ─── Time rule definition ─────────────────────────────────────────────────────

export type TimeRule = {
  /** How often this service should be done in months */
  intervalMonths: number;
  /** When this service is first expected (months after vehicle manufacture) */
  firstDueMonths: number;
  /** Window before threshold where status changes to "due_now" (months) */
  toleranceMonths: number;
};

// ─── Time-sensitive service rules ─────────────────────────────────────────────
// These are the services where AGE is a primary or co-primary trigger.
// All others are considered mileage-primary.

export const TIME_RULES: Partial<Record<CanonicalService, TimeRule>> = {
  coolant_service: {
    intervalMonths: 30,       // Toyota: 30 months / 30k miles (whichever first)
    firstDueMonths: 30,
    toleranceMonths: 3,
  },
  brake_fluid_service: {
    intervalMonths: 24,       // Most OEMs: 2 years regardless of mileage
    firstDueMonths: 24,
    toleranceMonths: 2,
  },
  battery_replacement: {
    intervalMonths: 48,       // Typical battery life: 3–5 years
    firstDueMonths: 48,
    toleranceMonths: 6,
  },
  serpentine_belt_replacement: {
    intervalMonths: 60,       // 5 years or 60k (many OEMs visual-inspect annually)
    firstDueMonths: 60,
    toleranceMonths: 6,
  },
  timing_belt_service: {
    intervalMonths: 84,       // 7 years or 60k–100k miles
    firstDueMonths: 60,
    toleranceMonths: 6,
  },
  axle_fluid_service: {
    intervalMonths: 36,       // 3 years or 30k miles
    firstDueMonths: 36,
    toleranceMonths: 3,
  },
  transfer_case_fluid_service: {
    intervalMonths: 36,
    firstDueMonths: 36,
    toleranceMonths: 3,
  },
  power_steering_fluid_service: {
    intervalMonths: 36,
    firstDueMonths: 36,
    toleranceMonths: 3,
  },
  transmission_fluid_service: {
    intervalMonths: 36,       // Conservative — many OEMs say 30k/2–3 years
    firstDueMonths: 36,
    toleranceMonths: 3,
  },
};

// ─── Status type ──────────────────────────────────────────────────────────────

export type TimeBasedStatus = "done" | "due_now" | "overdue" | "upcoming" | "unknown";

export type TimeBasedEvalResult = {
  status: TimeBasedStatus;
  confidence: "high" | "medium" | "low";
  reasoning: string;
  /** Months overdue (positive = overdue, negative = still ok) */
  monthsOverdue?: number;
  lastServiceDate?: string;
};

// ─── Core evaluation function ─────────────────────────────────────────────────

/**
 * Evaluate time-based status for a single maintenance service.
 * Returns null if service has no time rule (mileage-only service).
 *
 * @param vehicleYear           - Model year (e.g. 2014)
 * @param currentDate           - Today's date
 * @param canonicalService      - The service being evaluated
 * @param matchingHistoryEvents - Normalized history events that matched this service
 */
export function evaluateTimeBasedServiceStatus({
  vehicleYear,
  currentDate = new Date(),
  canonicalService,
  matchingHistoryEvents,
}: {
  vehicleYear: number;
  currentDate?: Date;
  canonicalService: CanonicalService;
  matchingHistoryEvents: NormalizedServiceEvent[];
}): TimeBasedEvalResult | null {
  const rule = TIME_RULES[canonicalService];
  if (!rule) return null; // Not a time-sensitive service

  const { intervalMonths, firstDueMonths, toleranceMonths } = rule;
  const ageMonths = vehicleAgeMonths(vehicleYear, currentDate);

  // ── Case A: Matching events WITH plausible dates ────────────────────────────
  const datesFromEvents = matchingHistoryEvents
    .map(e => e.date)
    .filter(isPlausibleServiceDate);

  const lastDate = mostRecentServiceDate(datesFromEvents);

  if (lastDate) {
    const elapsed = monthsSinceDate(lastDate, currentDate);
    if (elapsed === null) {
      return {
        status: "unknown",
        confidence: "low",
        reasoning: "Service date was found but could not be parsed reliably.",
        lastServiceDate: lastDate,
      };
    }

    const overdue = elapsed - intervalMonths;
    const monthsOverdue = overdue;

    if (elapsed < intervalMonths - toleranceMonths) {
      return {
        status: "done",
        confidence: "high",
        reasoning: `Last documented ${elapsed} months ago — within the ${intervalMonths}-month service interval.`,
        lastServiceDate: lastDate,
        monthsOverdue: monthsOverdue,
      };
    }

    if (elapsed < intervalMonths) {
      return {
        status: "due_now",
        confidence: "high",
        reasoning: `Last documented ${elapsed} months ago — within ${toleranceMonths} months of the ${intervalMonths}-month service interval. Due now.`,
        lastServiceDate: lastDate,
        monthsOverdue: monthsOverdue,
      };
    }

    return {
      status: "overdue",
      confidence: "high",
      reasoning: `Last documented ${elapsed} months ago — overdue by ~${overdue} months based on the ${intervalMonths}-month service interval.`,
      lastServiceDate: lastDate,
      monthsOverdue: monthsOverdue,
    };
  }

  // ── Case B: Matching events WITHOUT parsable dates ──────────────────────────
  if (matchingHistoryEvents.length > 0) {
    // Evidence found but can't confirm timing
    return {
      status: "unknown",
      confidence: "low",
      reasoning: `A service match was found in history but no date was available to confirm timing. Cannot verify if current.`,
    };
  }

  // ── Case C: No matching events — use vehicle age as proxy ──────────────────
  if (ageMonths < firstDueMonths) {
    return {
      status: "upcoming",
      confidence: "medium",
      reasoning: `This vehicle is ~${Math.round(ageMonths / 12 * 10) / 10} years old — this service may not be due yet based on age alone (typically first due at ${Math.round(firstDueMonths / 12)} years).`,
    };
  }

  const overdueByAge = ageMonths - firstDueMonths;
  const cyclesOverdue = Math.floor(overdueByAge / intervalMonths);

  if (ageMonths < firstDueMonths + intervalMonths) {
    const yearsOld = (ageMonths / 12).toFixed(1);
    return {
      status: "due_now",
      confidence: "medium",
      reasoning: `No documented ${friendlyName(canonicalService)} was found in the available history. This vehicle is ${yearsOld} years old — this service is typically expected by now.`,
      monthsOverdue: overdueByAge,
    };
  }

  // More than one full cycle overdue
  const yearsOld = (ageMonths / 12).toFixed(1);
  const overdueYears = (overdueByAge / 12).toFixed(1);
  return {
    status: "overdue",
    confidence: "medium",
    reasoning: `No documented ${friendlyName(canonicalService)} was found. This vehicle is ${yearsOld} years old and this service is typically due every ${Math.round(intervalMonths / 12)} years — likely overdue by ~${overdueYears} years based on age. ${cyclesOverdue > 1 ? "May have been skipped multiple times." : ""}`.trim(),
    monthsOverdue: overdueByAge,
  };
}

// ─── Helper ───────────────────────────────────────────────────────────────────

function friendlyName(service: CanonicalService): string {
  return service
    .replace(/_/g, " ")
    .replace(/\b\w/g, l => l.toUpperCase());
}

// ─── Status severity ordering ─────────────────────────────────────────────────
// Used by compareEngine to take the "worse" of mileage vs. time verdicts.

const STATUS_RANK: Record<TimeBasedStatus, number> = {
  overdue:  4,
  due_now:  3,
  upcoming: 2,
  unknown:  1,
  done:     0,
};

/**
 * Return the "worse" of two statuses.
 * Mileage-based and time-based results are merged by taking the worse outcome.
 */
export function worseStatus(
  a: TimeBasedStatus,
  b: TimeBasedStatus
): TimeBasedStatus {
  return STATUS_RANK[a] >= STATUS_RANK[b] ? a : b;
}
