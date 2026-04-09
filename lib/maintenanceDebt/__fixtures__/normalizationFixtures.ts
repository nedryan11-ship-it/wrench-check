// lib/maintenanceDebt/__fixtures__/normalizationFixtures.ts
// Static test fixture: raw description → expected NormalizedServiceEvent output.
// Use this to validate prompt quality and catch regressions if the prompt changes.

export interface NormalizationFixture {
  rawDescription: string;
  expectedCanonical: string | "unknown";
  expectedConfidence: "high" | "medium" | "low";
  notes?: string;
}

export const NORMALIZATION_FIXTURES: NormalizationFixture[] = [
  // ── High confidence — direct matches ──────────────────────────────────────
  {
    rawDescription: "Oil and filter changed",
    expectedCanonical: "Change - Engine oil",
    expectedConfidence: "high",
  },
  {
    rawDescription: "Engine oil change performed",
    expectedCanonical: "Change - Engine oil",
    expectedConfidence: "high",
  },
  {
    rawDescription: "Brake fluid flush and fill",
    expectedCanonical: "Flush/replace - Brake fluid",
    expectedConfidence: "high",
  },
  {
    rawDescription: "Spark plug replacement",
    expectedCanonical: "Replace - Spark plugs",
    expectedConfidence: "high",
  },
  {
    rawDescription: "Coolant system flushed and refilled",
    expectedCanonical: "Flush/replace - Coolant",
    expectedConfidence: "high",
  },
  {
    rawDescription: "Cabin air filter replaced",
    expectedCanonical: "Replace - Cabin air filter",
    expectedConfidence: "high",
  },
  {
    rawDescription: "Engine air filter replaced",
    expectedCanonical: "Replace - Air filter",
    expectedConfidence: "high",
  },
  {
    rawDescription: "Timing belt replaced",
    expectedCanonical: "Replace - Timing belt",
    expectedConfidence: "high",
  },
  {
    rawDescription: "Power steering fluid flushed",
    expectedCanonical: "Flush/replace - Power steering fluid",
    expectedConfidence: "high",
  },

  // ── Medium confidence — reasonable inference ───────────────────────────────
  {
    rawDescription: "Transmission service",
    expectedCanonical: "Change - Automatic transmission fluid",
    expectedConfidence: "medium",
    notes: "Could be drain/fill or full flush — medium not high",
  },
  {
    rawDescription: "Drive belt replaced",
    expectedCanonical: "Replace - Drive belt",
    expectedConfidence: "medium",
    notes: "Could be serpentine or accessory belt",
  },
  {
    rawDescription: "Differential service performed",
    expectedCanonical: "Change - Differential fluid",
    expectedConfidence: "medium",
  },
  {
    rawDescription: "Transfer case fluid change",
    expectedCanonical: "Change - Transfer case fluid",
    expectedConfidence: "medium",
  },

  // ── Low confidence — vague or grouped ─────────────────────────────────────
  {
    rawDescription: "60k service performed",
    expectedCanonical: "unknown",
    expectedConfidence: "low",
    notes: "Groups many services — cannot confirm any single one specifically",
  },
  {
    rawDescription: "Maintenance service completed",
    expectedCanonical: "unknown",
    expectedConfidence: "low",
  },

  // ── Unknown — completely uninterpretable ──────────────────────────────────
  {
    rawDescription: "Vehicle serviced",
    expectedCanonical: "unknown",
    expectedConfidence: "low",
    notes: "Dealer vague entry — must never clear any specific service",
  },
  {
    rawDescription: "Maintenance inspection completed",
    expectedCanonical: "unknown",
    expectedConfidence: "low",
  },
  {
    rawDescription: "Recommended maintenance performed",
    expectedCanonical: "unknown",
    expectedConfidence: "low",
  },
  {
    rawDescription: "Pre-delivery inspection",
    expectedCanonical: "unknown",
    expectedConfidence: "low",
    notes: "Not a maintenance service",
  },
];
