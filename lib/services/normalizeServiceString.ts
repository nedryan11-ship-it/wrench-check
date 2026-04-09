// lib/services/normalizeServiceString.ts
//
// Text normalization before any service string matching.
// Applied to both the input string AND each keyword in the registry
// so comparisons are always on the same normalized form.

/**
 * Normalize a raw service string for deterministic matching.
 *
 * Steps (in order):
 *  1. Lowercase
 *  2. Replace & → "and"
 *  3. Replace / and - → space
 *  4. Remove remaining punctuation except whitespace
 *  5. Collapse multiple spaces
 *  6. Trim
 *
 * Examples:
 *  "Replace Engine Oil & Filter"   → "replace engine oil and filter"
 *  "Change - Engine oil"           → "change engine oil"
 *  "Flush/replace - Coolant"       → "flush replace coolant"
 *  "Power Steering Flush"          → "power steering flush"
 *  "LOF"                           → "lof"
 */
export function normalizeServiceString(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[\/\-]/g, " ")
    .replace(/[^\w\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Pre-normalize an array of keywords (done once at import time for performance).
 * Returns [normalizedKeyword, originalKeyword] pairs.
 */
export function normalizeKeywords(keywords: string[]): [string, string][] {
  return keywords.map(k => [normalizeServiceString(k), k]);
}
