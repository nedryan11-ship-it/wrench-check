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
  mapToCanonicalServiceWithFallback,
} from "@/lib/services/mapToCanonicalService";
import type { CanonicalService } from "@/lib/services/canonicalServices";

const DEV = process.env.NODE_ENV === "development";
const USE_LLM_FALLBACK = process.env.OPENAI_API_KEY !== undefined;

// ─── Public export ────────────────────────────────────────────────────────────

export async function normalizeServiceHistory(
  events: ServiceHistoryEvent[]
): Promise<NormalizedServiceEvent[]> {
  if (events.length === 0) return [];

  const normalized: NormalizedServiceEvent[] = [];

  // Run all events through deterministic mapper first (synchronous, fast)
  const deterministicResults = events.map((event) => ({
    event,
    result: mapToCanonicalService({
      rawText: event.rawDescription,
      sourceType: "history",
    }),
  }));

  if (DEV) {
    const unknownCount = deterministicResults.filter(
      r => r.result.canonicalService === "unknown_service"
    ).length;
    console.log(
      `[normalize] ${events.length} events → ${events.length - unknownCount} deterministic, ${unknownCount} fallback`
    );
  }

  // Identify events needing LLM fallback
  const needsFallback = deterministicResults.filter(
    r => r.result.canonicalService === "unknown_service"
  );

  // Fetch LLM fallback results in parallel (only for unknowns)
  const llmResults = new Map<string, Awaited<ReturnType<typeof mapToCanonicalServiceWithFallback>>>();
  if (USE_LLM_FALLBACK && needsFallback.length > 0) {
    const llmPromises = needsFallback.map(async ({ event }) => {
      const result = await mapToCanonicalServiceWithFallback({
        rawText: event.rawDescription,
        sourceType: "history",
      });
      llmResults.set(event.id, result);
    });
    await Promise.allSettled(llmPromises);
  }

  // Build final normalized events
  for (const { event, result } of deterministicResults) {
    let finalResult = result;

    // Use LLM result if available and it improved on unknown
    if (result.canonicalService === "unknown_service") {
      const llm = llmResults.get(event.id);
      if (llm && llm.canonicalService !== "unknown_service") {
        finalResult = llm;
      }
    }

    normalized.push({
      id: crypto.randomUUID(),
      canonicalService: finalResult.canonicalService as CanonicalService,
      confidence: finalResult.confidence,
      rawDescription: event.rawDescription,
      date: event.date ?? null,
      mileage: event.mileage ?? null,
      mappedFrom: finalResult.matchedAlias ?? event.rawDescription,
    });
  }

  if (DEV) {
    const highCount = normalized.filter(n => n.confidence === "high").length;
    const unknownCount = normalized.filter(n => n.canonicalService === "unknown_service").length;
    console.log(`[normalize] result: ${highCount} high-confidence, ${unknownCount} unknown`);
  }

  return normalized;
}
