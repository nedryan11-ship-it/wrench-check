// app/api/vehicle-watchouts/route.ts
//
// Vehicle Intelligence — Known Platform Watchouts
//
// UPGRADED: Each watchout now includes:
//   - relatedCanonicalServices: which canonical service covers this issue
//   - evidenceStatus: whether that service is present/missing/ambiguous in the estimate
//   - insight: user-facing decision-aware sentence
//   - negotiationRelevance: how much this affects the deal
//
// The modal and inline card UIs read these new fields directly.
// Existing card structure is preserved — only depth is added.

import { NextResponse } from "next/server";
import OpenAI from "openai";
import { mapToCanonicalService } from "@/lib/services/mapToCanonicalService";
import { CANONICAL_SERVICE_BY_KEY } from "@/lib/services/canonicalServices";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ─── Types ────────────────────────────────────────────────────────────────────

export type EvidenceStatus = "present" | "missing" | "ambiguous" | "not_yet_relevant";

export type EnhancedWatchOut = {
  title: string;
  description: string;
  severity: "Safety Critical" | "High Cost" | "Maintenance Quirks";
  /** Canonical service IDs from the registry that address this issue */
  relatedCanonicalServices: string[];
  evidenceStatus: EvidenceStatus;
  /** User-facing insight line — ties platform risk to this specific estimate */
  insight: string;
  negotiationRelevance: "high" | "medium" | "low";
};

export type VehicleWatchoutsResponse = {
  watchOuts: EnhancedWatchOut[];
  /** Legacy field — kept for backward compat with chat context */
  related_service_note: string;
  /** Summary of evidence gaps across all watchouts */
  evidenceSummary: {
    missingCount: number;
    presentCount: number;
    negotiationAngle: string | null;
  };
};

// ─── Canonical service ID list for the prompt ─────────────────────────────────

const CANONICAL_IDS = Array.from(CANONICAL_SERVICE_BY_KEY.keys()).join(", ");

// ─── Route ────────────────────────────────────────────────────────────────────

export async function POST(req: Request) {
  try {
    const { vehicle, services, mileage } = await req.json();

    if (!vehicle) {
      return NextResponse.json({ error: "Vehicle string is required" }, { status: 400 });
    }

    const servicesList =
      services && services.length > 0 ? services.join(", ") : "No services provided.";
    const mileageContext = mileage ? `Current mileage: ${Number(mileage).toLocaleString()} miles.` : "";

    // ── Step 1: Get platform watchouts with canonical service mapping ──────────

    const prompt = `You are a highly experienced Master Technician specializing in the ${vehicle}.
${mileageContext}

Provide 3-5 critical "Mechanical Watch Outs" for this exact vehicle platform.
Focus on high-cost failures, specific engine/transmission quirks, and well-known platform issues.

CURRENT SERVICES ON THE USER'S ESTIMATE:
${servicesList}

CANONICAL SERVICE IDs (map relatedCanonicalServices to these exact IDs only):
${CANONICAL_IDS}

OUTPUT FORMAT (STRICT JSON — no other keys):
{
  "watchOuts": [
    {
      "title": "Short title (e.g. Timing Chain Tensioner Failure)",
      "description": "1-2 sentence explanation of why it matters for this specific platform",
      "severity": "Safety Critical" | "High Cost" | "Maintenance Quirks",
      "relatedCanonicalServices": ["canonical_id_1", "canonical_id_2"],
      "mileageThreshold": null | number (miles at which this becomes relevant — null if always relevant)
    }
  ],
  "related_service_note": "1-2 sentence summary of how the current estimate services relate to these watchouts."
}

RULES:
- relatedCanonicalServices MUST use only IDs from the canonical list above
- If a watchout has no direct maintenance service (e.g. a design flaw), use an empty array []
- mileageThreshold: e.g. timing belt at 90000, coolant at 60000. Use null if always relevant.
- Be platform-specific. Reference actual known failure modes for this vehicle.`;

    const response = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
      temperature: 0.2,
    });

    const raw = response.choices[0].message.content ?? "{}";
    const parsed = JSON.parse(raw);

    // ── Step 2: Map submitted services to canonical keys ──────────────────────

    const submittedCanonicalKeys = new Set<string>(
      (services ?? []).map((svc: string) =>
        mapToCanonicalService({ rawText: svc, sourceType: "pricing" }).canonicalService
      )
    );
    submittedCanonicalKeys.delete("unknown_service");

    // ── Step 3: Cross-reference each watchout ─────────────────────────────────

    const currentMileage = mileage ? Number(mileage) : null;
    let presentCount = 0;
    let missingCount = 0;

    const enhancedWatchOuts: EnhancedWatchOut[] = (parsed.watchOuts ?? []).map((w: any) => {
      const relatedIds: string[] = Array.isArray(w.relatedCanonicalServices)
        ? w.relatedCanonicalServices.filter((id: string) => CANONICAL_SERVICE_BY_KEY.has(id as any))
        : [];

      const threshold = w.mileageThreshold ? Number(w.mileageThreshold) : null;

      // Not yet relevant if mileage is well below threshold
      const notYetRelevant =
        threshold !== null &&
        currentMileage !== null &&
        currentMileage < threshold * 0.8;

      // Check if any related canonical service appears in submitted services
      const hasEvidence = relatedIds.some(id => submittedCanonicalKeys.has(id));
      const hasRelatedServices = relatedIds.length > 0;

      let evidenceStatus: EvidenceStatus;
      let insight: string;
      let negotiationRelevance: "high" | "medium" | "low";

      if (notYetRelevant) {
        evidenceStatus = "not_yet_relevant";
        insight = `Known platform issue — not yet a concern at ${currentMileage?.toLocaleString()} miles, but monitor after ${threshold?.toLocaleString()} miles.`;
        negotiationRelevance = "low";
      } else if (!hasRelatedServices) {
        // Design flaw or issue with no maintenance mitigation
        evidenceStatus = "ambiguous";
        insight = "Known design characteristic — no specific maintenance can prevent this, but awareness helps prioritize inspection.";
        negotiationRelevance = "medium";
      } else if (hasEvidence) {
        evidenceStatus = "present";
        insight = `This is a known issue — and the related service is included in the current estimate. Confirm the scope addresses it.`;
        negotiationRelevance = "medium";
        presentCount++;
      } else {
        evidenceStatus = "missing";
        insight = `Known issue with documented failure history — no related service appears in this estimate. Worth verifying before approving.`;
        negotiationRelevance = w.severity?.includes("Critical") ? "high" : "medium";
        missingCount++;
      }

      return {
        title: w.title ?? "Unknown Issue",
        description: w.description ?? "",
        severity: w.severity ?? "Maintenance Quirks",
        relatedCanonicalServices: relatedIds,
        evidenceStatus,
        insight,
        negotiationRelevance,
      };
    });

    // ── Step 4: Build evidence summary ────────────────────────────────────────

    const negotiationAngle =
      missingCount >= 2
        ? `${missingCount} known platform issues have no related service in this estimate. That's leverage.`
        : missingCount === 1
        ? "One known platform concern isn't addressed in this estimate — worth asking the shop about."
        : null;

    const result: VehicleWatchoutsResponse = {
      watchOuts: enhancedWatchOuts,
      related_service_note: parsed.related_service_note ?? "",
      evidenceSummary: {
        missingCount,
        presentCount,
        negotiationAngle,
      },
    };

    return NextResponse.json(result);

  } catch (error) {
    console.error("WatchOuts Engine Error:", error);
    return NextResponse.json({ error: "Failed to generate vehicle profile" }, { status: 500 });
  }
}
