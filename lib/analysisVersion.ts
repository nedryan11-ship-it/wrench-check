/** Central place to track the analysis version.
 *
 * Increment CURRENT_ANALYSIS_VERSION when:
 * - Major recommendation logic changes (grading thresholds, pricing interpretation)
 * - AI prompt rewrites that would invalidate prior advice
 * - New decision rules added to the engine
 *
 * Do NOT increment for UI-only changes or copy tweaks.
 */
export const CURRENT_ANALYSIS_VERSION = 2;
