// lib/maintenanceDebt/estimateSchedule.ts
//
// AI-generated OEM maintenance schedule fallback.
// Called when VehicleDatabases returns null (no VIN or unsupported vehicle).
// Output is labeled source: "ai_estimated" on every item.
// Never throws — returns [] on failure so the audit can continue.

import OpenAI from "openai";
import type { MaintenanceScheduleItem, VehicleIdentity } from "./types";
import { mapToCanonicalService } from "@/lib/services/mapToCanonicalService";
import { TIME_RULES } from "@/lib/maintenance/timeBasedRules";

// ─── Severity heuristic (mirrors maintenance.ts) ──────────────────────────────

function inferSeverity(service: string): "low" | "medium" | "high" {
  const s = service.toLowerCase();
  if (
    s.includes("timing belt") || s.includes("timing chain") ||
    s.includes("transmission fluid") || s.includes("transaxle") ||
    s.includes("spark plug") || s.includes("coolant") ||
    s.includes("differential") || s.includes("transfer case") ||
    s.includes("axle fluid")
  ) return "high";
  if (
    s.includes("brake fluid") || s.includes("brake") ||
    s.includes("power steering") || s.includes("drive belt") ||
    s.includes("valve clearance") || s.includes("fuel filter") ||
    s.includes("engine oil")
  ) return "medium";
  return "low";
}

// ─── Raw shape returned by GPT ────────────────────────────────────────────────

interface GptCheckpoint {
  checkpoint_miles: number;
  service_items: string[];
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Generate an AI-estimated OEM maintenance schedule for a vehicle.
 * Called when VDB returns null.
 *
 * @returns MaintenanceScheduleItem[] with source: "ai_estimated"
 *          Returns [] if OpenAI is unavailable — caller handles gracefully.
 */
export async function estimateScheduleFromYMMT(
  vehicle: Partial<VehicleIdentity>
): Promise<MaintenanceScheduleItem[]> {
  const { year, make, model, trim, currentMileage } = vehicle;

  if (!make || !model) {
    // Can't generate a meaningful schedule without at least make + model
    return [];
  }

  const vehicleDesc = [year, make, model, trim].filter(Boolean).join(" ");
  const upTo = Math.max((currentMileage ?? 0) + 30_000, 90_000);

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const prompt = `You are an automotive maintenance expert. Generate a comprehensive OEM maintenance schedule for a ${vehicleDesc}.

Return ONLY a JSON array. Each element has:
- "checkpoint_miles": number (the mileage at which services are due)
- "service_items": string[] (exact standard OEM service names)

Rules:
- Cover all checkpoints from 5,000 miles up to ${upTo.toLocaleString()} miles
- Use standard OEM service terminology (e.g. "Replace Engine Oil & Filter", "Replace Coolant", "Inspect Brake System")
- Include all services a responsible owner should have done at each checkpoint
- Be realistic and complete — do not oversimplify
- For trucks/SUVs include differential fluid, transfer case fluid, propeller shaft lubrication
- No markdown, no explanation — raw JSON array only

Example format:
[
  { "checkpoint_miles": 5000, "service_items": ["Replace Engine Oil & Filter", "Rotate Tires"] },
  { "checkpoint_miles": 30000, "service_items": ["Replace Coolant", "Replace Brake Fluid"] }
]`;

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 2000,
      temperature: 0.1, // low temperature for deterministic service names
      response_format: { type: "json_object" },
    });

    const raw = completion.choices[0].message.content ?? "{}";

    // GPT may return { "schedule": [...] } or just [...] wrapped in an object
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      console.warn("[estimateSchedule] JSON parse failed");
      return [];
    }

    // Unwrap if needed
    let checkpoints: GptCheckpoint[] = [];
    if (Array.isArray(parsed)) {
      checkpoints = parsed as GptCheckpoint[];
    } else if (parsed && typeof parsed === "object") {
      const obj = parsed as Record<string, unknown>;
      const key = Object.keys(obj).find(k => Array.isArray(obj[k]));
      if (key) checkpoints = obj[key] as GptCheckpoint[];
    }

    const items: MaintenanceScheduleItem[] = [];
    for (const checkpoint of checkpoints) {
      if (!checkpoint.checkpoint_miles || !Array.isArray(checkpoint.service_items)) continue;
      for (const svc of checkpoint.service_items) {
        if (typeof svc !== "string") continue;
        const { canonicalService } = mapToCanonicalService({
          rawText: svc,
          sourceType: "schedule",
        });
        const timeRule = TIME_RULES[canonicalService];
        items.push({
          canonicalService,
          displayName: svc,
          dueMileage: checkpoint.checkpoint_miles,
          intervalMonths: timeRule?.intervalMonths ?? null,
          firstDueMonths: timeRule?.firstDueMonths ?? null,
          severity: inferSeverity(svc),
          source: "ai_estimated",
        });
      }
    }

    console.log(`[estimateSchedule] ${vehicleDesc} → ${items.length} AI-estimated schedule items`);
    return items;

  } catch (err) {
    console.warn("[estimateSchedule] OpenAI call failed:", err);
    return [];
  }
}
