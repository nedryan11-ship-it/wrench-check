// lib/maintenanceDebt/extract.ts
// Extracts structured vehicle identity + service history from raw text.
// Uses gpt-4o-mini in a single call — no OCR dependency.
// Caller passes pre-converted text (from PDF, image, or paste).

import OpenAI from "openai";
import type { ServiceHistoryEvent, VehicleIdentity } from "./types";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const DEV = process.env.NODE_ENV === "development";

interface ExtractionResult {
  vehicle: VehicleIdentity;
  events: ServiceHistoryEvent[];
}

const SYSTEM_PROMPT = `You are a vehicle service history extraction engine.

Extract structured data from vehicle history reports (Carfax, Autocheck, service receipts, or raw text).

Return ONLY valid JSON. No prose, no markdown, no explanation.

OUTPUT FORMAT:
{
  "vehicle": {
    "vin": "<17-char VIN or null>",
    "year": <number or null>,
    "make": "<string or null>",
    "model": "<string or null>",
    "trim": "<string or null>",
    "currentMileage": <number or null>,
    "mileageSource": "header" | "latest_event" | "unknown"
  },
  "events": [
    {
      "rawDescription": "<exact text from report>",
      "date": "<YYYY-MM-DD or null>",
      "mileage": <number or null>
    }
  ]
}

RULES:
- Preserve rawDescription exactly as it appears in the source text
- currentMileage: prefer an explicit "Current Mileage" field in the report header.
  If not present, use the highest mileage found in any service event.
  Set mileageSource accordingly: "header" or "latest_event"
- VIN: extract only 17-character VINs. If invalid length or absent, return null
- Include every distinct service event found — do not deduplicate
- If a field is genuinely absent, return null (not empty string)
- Dates: convert to ISO format if possible`;

export async function extractFromText(
  text: string,
  source: ServiceHistoryEvent["source"] = "unknown"
): Promise<ExtractionResult> {
  const fallback: ExtractionResult = {
    vehicle: { mileageConfidence: "estimated" },
    events: [],
  };

  if (!text?.trim()) return fallback;

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: `Extract service history from this document:\n\n${text.slice(0, 20000)}` },
      ],
      response_format: { type: "json_object" },
      temperature: 0.1,
      max_tokens: 4000,
    });

    const raw = response.choices[0].message.content ?? "{}";
    const parsed = JSON.parse(raw);

    if (DEV) {
      console.log(`[extract] source=${source} events=${parsed.events?.length ?? 0} vin=${parsed.vehicle?.vin ?? "none"}`);
    }

    // Build VehicleIdentity
    const v = parsed.vehicle ?? {};
    const vehicle: VehicleIdentity = {
      vin: v.vin ?? null,
      year: v.year ?? null,
      make: v.make ?? null,
      model: v.model ?? null,
      trim: v.trim ?? null,
      currentMileage: v.currentMileage ?? null,
      mileageConfidence: v.mileageSource === "header" ? "confirmed" : "estimated",
    };

    // Build ServiceHistoryEvent[]
    const events: ServiceHistoryEvent[] = (parsed.events ?? []).map(
      (e: { rawDescription?: string; date?: string; mileage?: number }) => ({
        id: crypto.randomUUID(),
        source,
        rawDescription: e.rawDescription ?? "",
        date: e.date ?? null,
        mileage: typeof e.mileage === "number" ? e.mileage : null,
      })
    );

    return { vehicle, events };
  } catch (err) {
    console.error("[extract] error:", err);
    return fallback;
  }
}
