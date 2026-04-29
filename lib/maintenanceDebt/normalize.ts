// lib/maintenanceDebt/normalize.ts
// Maps raw ServiceHistoryEvent[] descriptions to canonical service keys.
//
// Pipeline:
//   1. Deterministic: mapToCanonicalService("history") from the shared registry
//   2. LLM fallback: only for events that return "unknown_service" from step 1
//
// Key invariant:
//   confidence "low" or canonicalService "unknown_service" → evidenceFound = false in compareEngine.
//   The system must NEVER claim a service was done based on vague text.

import type { NormalizedServiceEvent, ServiceHistoryEvent } from "./types";
import {
  mapToCanonicalService,
  batchMapToCanonicalWithFallback,
} from "@/lib/services/mapToCanonicalService";
import type { CanonicalService } from "@/lib/services/canonicalServices";

const DEV = process.env.NODE_ENV === "development";
const USE_LLM_FALLBACK = process.env.OPENAI_API_KEY !== undefined;

// ─── Public export ────────────────────────────────────────────────────────────

export async function normalizeServiceHistory(
  events: ServiceHistoryEvent[]
): Promise<NormalizedServiceEvent[]> {
  if (events.length === 0) return [];

  if (DEV) {
    console.log(`[normalize] processing ${events.length} events...`);
  }

  // Map everything in one batch (Step 1 deterministic, Step 2 batched LLM)
  const results = await batchMapToCanonicalWithFallback(
    events.map(e => e.rawDescription),
    "history"
  );

  // Build final normalized events
  const normalized = events.map((event, i) => {
    const res = results[i];
    return {
      id: crypto.randomUUID(),
      canonicalService: res.canonicalService as CanonicalService,
      confidence: res.confidence,
      rawDescription: event.rawDescription,
      date: event.date ?? null,
      mileage: event.mileage ?? null,
      mappedFrom: res.matchedAlias ?? event.rawDescription,
      is_ppi: event.is_ppi,
      ppi_is_good: event.ppi_is_good,
    };
  });

  if (DEV) {
    const highCount = normalized.filter(n => n.confidence === "high").length;
    const unknownCount = normalized.filter(n => n.canonicalService === "unknown_service").length;
    console.log(`[normalize] result: ${highCount} high-confidence, ${unknownCount} unknown`);
  }

  return normalized;
}
