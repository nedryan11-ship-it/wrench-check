// app/api/maintenance-audit/route.ts
// Orchestration endpoint for Maintenance Debt Audit.
//
// Pipeline:
//   extract → normalize → VDB schedule → [AI fallback] → repairEstimates → compareEngine

export const maxDuration = 120; // Allow up to 2 min for large PDFs (Vercel/Next.js)

import { NextResponse } from "next/server";
import type { ServiceHistoryEvent, VehicleIdentity } from "@/lib/maintenanceDebt/types";
import { extractFromText } from "@/lib/maintenanceDebt/extract";
import { normalizeServiceHistory } from "@/lib/maintenanceDebt/normalize";
import { compareHistoryToSchedule } from "@/lib/maintenanceDebt/compareEngine";
import { getMaintenanceSchedule } from "@/lib/vehicleDatabases/maintenance";
import { getRepairEstimateMap } from "@/lib/vehicleDatabases/repairEstimates";
import { estimateScheduleFromYMMT } from "@/lib/maintenanceDebt/estimateSchedule";
import { applyPricingToDebtItems, aggregateDebt, type PricingContext } from "@/lib/maintenanceDebt/pricingEngine";
import { computeVerdict } from "@/lib/maintenanceDebt/verdict";

// ─── File text extraction ─────────────────────────────────────────────────────

async function extractTextFromFile(file: File): Promise<string> {
  const buffer = Buffer.from(await file.arrayBuffer());
  const mimeType = file.type || "";
  const ext = file.name.split(".").pop()?.toLowerCase();

  if (ext === "pdf" || mimeType === "application/pdf") {
    // ── Stage 1: pdf-parse (fast, no cost) ──────────────────────────────
    try {
      const pdfParseMod = await import("pdf-parse");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const pdfParse: (buf: Buffer) => Promise<{ text: string }> = (pdfParseMod as any).default ?? pdfParseMod;
      const result = await Promise.race([
        pdfParse(buffer),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("pdf-parse timeout after 8s")), 8000)
        ),
      ]);
      const text = result.text?.trim() || "";
      if (text.length > 500) {
        console.log("[maintenance-audit] pdf-parse OK:", text.length, "chars");
        return text;
      }
      console.log("[maintenance-audit] pdf-parse insufficient (", text.length, "chars) — falling back to AI");
    } catch (e) {
      console.warn("[maintenance-audit] pdf-parse threw:", (e as Error).message);
    }

    // ── Stage 2: OpenAI Responses API (native PDF support, handles CARFAX encoding) ─
    try {
      const { default: OpenAI } = await import("openai");
      const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
      const base64 = buffer.toString("base64");

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const response = await (openai.responses as any).create({
        model: "gpt-4o",
        input: [{
          role: "user",
          content: [
            {
              type: "input_file",
              filename: file.name || "vehicle-history.pdf",
              file_data: `data:application/pdf;base64,${base64}`,
            },
            {
              type: "input_text",
              text: [
                "Extract ALL text from this vehicle service history document exactly as it appears.",
                "Include: VIN, year, make, model, current mileage, and every service event with date, mileage, and description.",
                "Return only the raw extracted text. Do not summarize or reformat.",
              ].join(" "),
            },
          ],
        }],
      });

      const extracted: string = response.output_text ?? "";
      console.log("[maintenance-audit] OpenAI PDF extraction:", extracted.length, "chars");
      return extracted;
    } catch (e) {
      console.error("[maintenance-audit] OpenAI PDF extraction failed:", (e as Error).message);
      return "";
    }
  }

  if (["image/png", "image/jpeg", "image/webp"].includes(mimeType)) {
    const { default: OpenAI } = await import("openai");
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const base64 = buffer.toString("base64");
    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "Extract ALL text from this vehicle service history document. Return the raw text content only — no summaries, no formatting changes." },
          { type: "image_url", image_url: { url: `data:${mimeType};base64,${base64}`, detail: "high" } },
        ],
      }],
      max_tokens: 2000,
    });
    return completion.choices[0].message.content ?? "";
  }

  return "";
}

// ─── Route handler ────────────────────────────────────────────────────────────

export async function POST(req: Request) {
  const contentType = req.headers.get("content-type") || "";

  // File upload path
  if (contentType.includes("multipart/form-data")) {
    let file: File | null = null;
    let vehicleOverride: Partial<VehicleIdentity> | undefined;
    try {
      const formData = await req.formData();
      file = formData.get("file") as File | null;
      const overrideStr = formData.get("vehicleOverride") as string | null;
      if (overrideStr) vehicleOverride = JSON.parse(overrideStr);
    } catch {
      return NextResponse.json({ success: false, error: "Failed to parse upload." }, { status: 400 });
    }

    if (!file) return NextResponse.json({ success: false, error: "No file uploaded." }, { status: 400 });
    if (file.size > 20 * 1024 * 1024) return NextResponse.json({ success: false, error: "File too large (max 20 MB)." }, { status: 400 });

    // ── Extract vehicle identity from filename (CARFAX always encodes VIN in filename) ──
    // e.g. "CARFAX Vehicle History Report for this 2016 TOYOTA LAND CRUISER_ JTMCY7AJ4G4047265.pdf"
    const filenameVin = file.name.match(/\b([A-HJ-NPR-Z0-9]{17})\b/i)?.[1]?.toUpperCase() ?? null;
    const filenameYear = (() => {
      const m = file.name.match(/\b(19|20)\d{2}\b/);
      return m ? parseInt(m[0], 10) : null;
    })();
    const filenameMake = (() => {
      const makes = ["toyota","honda","ford","chevrolet","gmc","dodge","jeep","bmw","mercedes","audi","volkswagen","hyundai","kia","nissan","subaru","mazda","lexus","acura","infiniti","cadillac","buick","lincoln","volvo","ram","chrysler","mitsubishi","porsche"];
      const lower = file.name.toLowerCase();
      return makes.find(m => lower.includes(m)) ?? null;
    })();

    // Merge filename-derived identity into vehicleOverride (don't overwrite explicit user overrides)
    const filenameOverride: Partial<VehicleIdentity> = {};
    if (filenameVin)  filenameOverride.vin = filenameVin;
    if (filenameYear) filenameOverride.year = filenameYear;
    if (filenameMake) filenameOverride.make = filenameMake.charAt(0).toUpperCase() + filenameMake.slice(1);

    const mergedVehicleOverride = Object.keys(filenameOverride).length > 0
      ? { ...filenameOverride, ...vehicleOverride }  // explicit overrides win
      : vehicleOverride;

    if (filenameVin) console.log("[maintenance-audit] VIN from filename:", filenameVin);

    const extractedText = await extractTextFromFile(file);
    const source = file.name.toLowerCase().includes("carfax") ? "carfax"
      : file.name.toLowerCase().includes("autocheck") ? "autocheck"
      : "receipt";

    return runAuditPipeline({ text: extractedText, source, vehicleOverride: mergedVehicleOverride });
  }

  // JSON path (pasted text or manual entry)
  try {
    const body = await req.json();
    const {
      text,
      source = "unknown",
      vehicleOverride,
      historyOverride,
      pricingContext,
    }: {
      text?: string;
      source?: ServiceHistoryEvent["source"];
      vehicleOverride?: Partial<VehicleIdentity>;
      historyOverride?: ServiceHistoryEvent[];
      pricingContext?: PricingContext;
    } = body;

    return runAuditPipeline({ text, source, vehicleOverride, historyOverride, pricingContext });
  } catch (error) {
    console.error("[maintenance-audit] error:", error);
    return NextResponse.json({ success: false, error: "Audit failed. Please try again." }, { status: 500 });
  }
}

// ─── Shared pipeline ──────────────────────────────────────────────────────────

async function runAuditPipeline({
  text,
  source = "unknown",
  vehicleOverride,
  historyOverride,
  pricingContext = {},
}: {
  text?: string;
  source?: ServiceHistoryEvent["source"];
  vehicleOverride?: Partial<VehicleIdentity>;
  historyOverride?: ServiceHistoryEvent[];
  pricingContext?: PricingContext;
}) {
  try {
    let { vehicle, events } = text
      ? await extractFromText(text, source)
      : { vehicle: {} as VehicleIdentity, events: [] };

    // Apply manual overrides
    if (vehicleOverride) vehicle = { ...vehicle, ...vehicleOverride };
    if (historyOverride && historyOverride.length > 0) events = [...events, ...historyOverride];

    // Normalize history
    const normalizedHistory = await normalizeServiceHistory(events);

    // ── Schedule fetch with fallback ──────────────────────────────────────────
    // Primary: VDB (requires valid 17-char VIN)
    // Fallback: AI-estimated from YMMT (make + model sufficient)
    // Guard:    scheduleSource = "none" → verdict = "incomplete", never "clean"

    type ScheduleSource = "vehicle_databases" | "ai_estimated" | "none";
    let scheduleSource: ScheduleSource = "none";
    let schedule: import("@/lib/maintenanceDebt/types").MaintenanceScheduleItem[] = [];
    let repairEstimates: Record<string, import("@/lib/maintenanceDebt/types").ServiceCostEstimate> = {};

    const vin = vehicle.vin;
    if (vin && vin.length === 17) {
      const [vdbSchedule, vdbEstimates] = await Promise.all([
        getMaintenanceSchedule({ vin }),
        getRepairEstimateMap({ vin }).then((m) => m ?? {}),
      ]);

      if (vdbSchedule && vdbSchedule.length > 0) {
        schedule = vdbSchedule;
        repairEstimates = vdbEstimates;
        scheduleSource = "vehicle_databases";
      }
    }

    // AI fallback when VDB missed or no VIN
    if (scheduleSource === "none" && (vehicle.make || vehicle.model || vehicle.year)) {
      console.log("[maintenance-audit] VDB miss → AI schedule fallback");
      const aiSchedule = await estimateScheduleFromYMMT(vehicle);
      if (aiSchedule.length > 0) {
        schedule = aiSchedule;
        scheduleSource = "ai_estimated";
      }
    }

    if (scheduleSource === "none") {
      console.warn("[maintenance-audit] No schedule — vehicle identity insufficient for fallback");
    }

    // Compare
    const result = compareHistoryToSchedule({
      vehicle,
      normalizedHistory,
      schedule,
      repairEstimates,
    });

    // Apply structured pricing to all debt items
    // This replaces raw VDB cost attachment with region/vehicle/shop-adjusted estimates
    result.debtItems = await applyPricingToDebtItems(
      repairEstimates,
      result.debtItems,
      vehicle,
      pricingContext
    );

    // Re-aggregate debt totals after pricing is applied
    const { debtEstimateLow, debtEstimateHigh } = aggregateDebt(result.debtItems);
    result.debtEstimateLow = debtEstimateLow;
    result.debtEstimateHigh = debtEstimateHigh;

    // Rule: NEVER return "clean" when no schedule was available
    if (scheduleSource === "none") {
      result.verdict = "incomplete";
      result.summary = "We couldn't retrieve an OEM maintenance schedule for this vehicle. Provide a VIN or Year/Make/Model for a complete analysis.";
    }

    // Compute confidence
    const hasVin = Boolean(vin && vin.length === 17);
    const mileageConfirmed = vehicle.mileageConfidence === "confirmed";
    const highConfidenceEvents = normalizedHistory.filter(e => e.confidence === "high").length;
    const totalEvents = normalizedHistory.length;

    let confidence: "low" | "medium" | "high";
    if (scheduleSource === "vehicle_databases" && hasVin && mileageConfirmed) {
      confidence = "high";
    } else if (scheduleSource !== "none" && (hasVin || mileageConfirmed)) {
      confidence = "medium";
    } else if (totalEvents > 0 && highConfidenceEvents / totalEvents > 0.6) {
      confidence = "medium";
    } else {
      confidence = "low";
    }

    // Attach required fields from spec
    result.scheduleSource = scheduleSource;
    result.confidence = confidence;
    result.extractedHistory = events;

    // Recalibrate verdict with confidence + scheduleSource context.
    // This prevents AI-estimated results from firing "high_risk" aggressively.
    // (compareEngine computes an initial verdict without confidence context.)
    if (scheduleSource !== "none") {
      result.verdict = computeVerdict({
        debtItems: result.debtItems,
        debtEstimateLow: result.debtEstimateLow,
        debtEstimateHigh: result.debtEstimateHigh,
        confidence,
        scheduleSource,
      });
    }

    return NextResponse.json({
      success: true,
      result,
      meta: {
        scheduleSource,
        hasSchedule: scheduleSource !== "none",
        hasPricing: Object.keys(repairEstimates).length > 0,
        eventCount: events.length,
        normalizedCount: normalizedHistory.length,
      },
    });

  } catch (error) {
    console.error("[maintenance-audit] pipeline error:", error);
    return NextResponse.json({ success: false, error: "Audit failed. Please try again." }, { status: 500 });
  }
}
