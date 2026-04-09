// lib/services/mapToCanonicalService.ts
//
// Deterministic canonical service mapping function.
// Maps any raw service string from any source to a CanonicalService key.
//
// Matching order (highest → lowest confidence):
//   1. Exact alias match              → "high"
//   2. Input contains keyword         → "medium"
//   3. Keyword contains input (short) → "low"
//   4. No match                       → "unknown_service", "low"
//
// LLM fallback: only called when result is "unknown_service"
// (separate async function — deterministic sync path runs first always)

import {
  CANONICAL_SERVICE_REGISTRY,
  type CanonicalService,
  type CanonicalServiceDefinition,
} from "./canonicalServices";
import { normalizeServiceString } from "./normalizeServiceString";

// ─── Types ────────────────────────────────────────────────────────────────────

export type ServiceSourceType = "schedule" | "pricing" | "history" | "quote";

export type CanonicalMapResult = {
  canonicalService: CanonicalService;
  confidence: "high" | "medium" | "low";
  matchedAlias?: string;
  reasoning?: string;
};

// ─── Keyword selection by source ──────────────────────────────────────────────

function getKeywordsForSource(
  def: CanonicalServiceDefinition,
  source: ServiceSourceType
): string[] {
  // Primary keywords first, aliases as fallback — all normalized below
  switch (source) {
    case "schedule":
      return [...def.scheduleKeywords, ...def.aliases];
    case "pricing":
      return [...def.pricingKeywords, ...def.aliases];
    case "history":
      return [...def.shopKeywords, ...def.aliases];
    case "quote":
      // Quote items can use shop OR pricing vocabulary
      return [...def.shopKeywords, ...def.pricingKeywords, ...def.aliases];
  }
}

// ─── Pre-normalized keyword cache ─────────────────────────────────────────────
// Built once at module load — avoids re-normalizing on every call.

type NormalizedKeywordEntry = {
  normalizedKw: string;
  originalKw: string;
  def: CanonicalServiceDefinition;
  source: ServiceSourceType;
};

const keywordCacheBySource = new Map<ServiceSourceType, NormalizedKeywordEntry[]>();

const ALL_SOURCES: ServiceSourceType[] = ["schedule", "pricing", "history", "quote"];

for (const source of ALL_SOURCES) {
  const entries: NormalizedKeywordEntry[] = [];

  for (const def of CANONICAL_SERVICE_REGISTRY) {
    if (def.key === "unknown_service") continue; // skip catch-all
    const keywords = getKeywordsForSource(def, source);

    for (const kw of keywords) {
      const normalizedKw = normalizeServiceString(kw);
      if (normalizedKw.length < 3) continue; // skip trivially short keywords
      entries.push({ normalizedKw, originalKw: kw, def, source });
    }
  }

  // Sort by keyword length DESC — longer keywords get priority (more specific)
  entries.sort((a, b) => b.normalizedKw.length - a.normalizedKw.length);
  keywordCacheBySource.set(source, entries);
}

// ─── Core deterministic mapping function ─────────────────────────────────────

/**
 * Map a raw service string to a canonical service key.
 * Synchronous and deterministic — no LLM calls.
 *
 * @param rawText    - Any raw service string from VDB, shop receipt, CARFAX, etc.
 * @param sourceType - Where the string came from (affects which keyword set is used)
 * @returns          - { canonicalService, confidence, matchedAlias, reasoning }
 */
export function mapToCanonicalService(input: {
  rawText: string;
  sourceType: ServiceSourceType;
}): CanonicalMapResult {
  const { rawText, sourceType } = input;
  const normalized = normalizeServiceString(rawText);

  if (!normalized || normalized.length < 2) {
    return { canonicalService: "unknown_service", confidence: "low", reasoning: "Input too short to classify." };
  }

  const entries = keywordCacheBySource.get(sourceType) ?? [];

  // ── Pass 1: Exact match ─────────────────────────────────────────────────────
  for (const { normalizedKw, originalKw, def } of entries) {
    if (normalized === normalizedKw) {
      return {
        canonicalService: def.key,
        confidence: "high",
        matchedAlias: originalKw,
        reasoning: `Exact match: "${originalKw}"`,
      };
    }
  }

  // ── Pass 2: Input contains keyword (keyword is substring of input) ──────────
  // e.g. "Change - Engine oil and filter service" contains "change engine oil"
  for (const { normalizedKw, originalKw, def } of entries) {
    if (normalized.includes(normalizedKw)) {
      return {
        canonicalService: def.key,
        confidence: "medium",
        matchedAlias: originalKw,
        reasoning: `Keyword match: "${originalKw}" found in "${rawText}"`,
      };
    }
  }

  // ── Pass 3: Keyword contains input (input is a short/general term) ──────────
  // e.g. input "transmission" matches keyword "transmission fluid service"
  // Only applied for inputs > 5 chars to avoid spurious matches on short words
  if (normalized.length > 5) {
    for (const { normalizedKw, originalKw, def } of entries) {
      if (normalizedKw.includes(normalized)) {
        return {
          canonicalService: def.key,
          confidence: "low",
          matchedAlias: originalKw,
          reasoning: `Partial match: "${rawText}" is contained in keyword "${originalKw}"`,
        };
      }
    }
  }

  // ── No match ────────────────────────────────────────────────────────────────
  return {
    canonicalService: "unknown_service",
    confidence: "low",
    reasoning: `No canonical mapping found for "${rawText}" (source: ${sourceType})`,
  };
}

// ─── Async variant with LLM fallback ─────────────────────────────────────────

/**
 * Same as mapToCanonicalService but falls back to OpenAI when unknown_service is returned.
 * Use this for history/quote processing where free-form text is likely.
 * Do NOT use for schedule/pricing — registry should cover those exhaustively.
 */
export async function mapToCanonicalServiceWithFallback(input: {
  rawText: string;
  sourceType: ServiceSourceType;
}): Promise<CanonicalMapResult> {
  const result = mapToCanonicalService(input);

  // Only hit LLM if completely unknown — respect the trust principle
  if (result.canonicalService !== "unknown_service") return result;

  return await llmFallbackMap(input);
}

// ─── LLM fallback ────────────────────────────────────────────────────────────

async function llmFallbackMap(input: {
  rawText: string;
  sourceType: ServiceSourceType;
}): Promise<CanonicalMapResult> {
  const { rawText } = input;

  // Build canonical key list for the prompt
  const validKeys = CANONICAL_SERVICE_REGISTRY
    .filter(d => d.key !== "unknown_service")
    .map(d => `${d.key} (${d.displayName})`)
    .join(", ");

  try {
    const { default: OpenAI } = await import("openai");
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{
        role: "user",
        content: `Map this vehicle service description to the best canonical service key.

Input: "${rawText}"

Valid canonical keys: ${validKeys}

Return ONLY a JSON object: { "key": "canonical_key", "confidence": "high|medium|low", "reasoning": "brief explanation" }

If none fit, use "unknown_service". Be conservative — trust matters more than coverage.`,
      }],
      max_tokens: 150,
      temperature: 0,
      response_format: { type: "json_object" },
    });

    const raw = completion.choices[0].message.content ?? "{}";
    const parsed = JSON.parse(raw) as { key?: string; confidence?: string; reasoning?: string };

    const key = parsed.key as CanonicalService | undefined;
    const confidence = (parsed.confidence as "high" | "medium" | "low") ?? "low";

    if (key && key !== "unknown_service") {
      return {
        canonicalService: key,
        confidence,
        reasoning: parsed.reasoning ?? "LLM-mapped",
      };
    }
  } catch (err) {
    console.warn("[mapToCanonicalService] LLM fallback failed:", err);
  }

  return {
    canonicalService: "unknown_service",
    confidence: "low",
    reasoning: "Could not map to a known service type.",
  };
}

// ─── Batch helper ─────────────────────────────────────────────────────────────

/**
 * Map an array of raw strings to canonical services.
 * Synchronous — no LLM. Use for high-throughput schedule/pricing normalization.
 */
export function batchMapToCanonical(
  items: Array<{ rawText: string; sourceType: ServiceSourceType }>
): CanonicalMapResult[] {
  return items.map(item => mapToCanonicalService(item));
}
