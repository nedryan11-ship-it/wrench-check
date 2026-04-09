// lib/maintenance/serviceAgeUtils.ts
//
// Utility functions for computing vehicle and service age.
// Used by the time-based detection engine.

/**
 * Compute vehicle age in months from model year to current date.
 * Treats the vehicle as first registered on Jan 1 of its model year.
 */
export function vehicleAgeMonths(vehicleYear: number, currentDate: Date = new Date()): number {
  const firstJan = new Date(vehicleYear, 0, 1);
  const diffMs = currentDate.getTime() - firstJan.getTime();
  return Math.max(0, Math.floor(diffMs / (1000 * 60 * 60 * 24 * 30.44)));
}

/**
 * Compute months elapsed since a service date string (ISO 8601 or "YYYY-MM-DD").
 * Returns null if the date is invalid or in the future.
 */
export function monthsSinceDate(
  dateStr: string,
  currentDate: Date = new Date()
): number | null {
  const parsed = new Date(dateStr);
  if (isNaN(parsed.getTime())) return null;
  const diffMs = currentDate.getTime() - parsed.getTime();
  if (diffMs < 0) return null; // date is in the future
  return Math.floor(diffMs / (1000 * 60 * 60 * 24 * 30.44));
}

/**
 * Find the most recent valid date string from a list of service events.
 * Returns null if no events have parsable dates.
 */
export function mostRecentServiceDate(dates: (string | null | undefined)[]): string | null {
  const valid = dates
    .filter((d): d is string => Boolean(d))
    .map(d => ({ raw: d, parsed: new Date(d) }))
    .filter(({ parsed }) => !isNaN(parsed.getTime()))
    .sort((a, b) => b.parsed.getTime() - a.parsed.getTime());

  return valid[0]?.raw ?? null;
}

/**
 * Determine whether a date string is parseable and roughly plausible
 * (between 1980 and 5 years from now).
 */
export function isPlausibleServiceDate(dateStr: string | null | undefined): boolean {
  if (!dateStr) return false;
  const parsed = new Date(dateStr);
  if (isNaN(parsed.getTime())) return false;
  const year = parsed.getFullYear();
  return year >= 1980 && year <= new Date().getFullYear() + 5;
}
