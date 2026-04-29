import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import type { ComparisonResult } from "@/lib/comparison/types";
import { runAuditPipeline } from "@/lib/maintenanceDebt/pipeline";
import { extractPdfText } from "@/lib/pdfParser";
import { synthesizeComparison } from "@/lib/comparison/synthesize";

export const runtime = "nodejs";
export const maxDuration = 90;

/**
 * POST /api/hunt/[id]/reaudit
 * Re-runs the full modelInsights AI pipeline for a single car in a Hunt workspace.
 * Accepts FormData with:
 *   - carFileIndex: the fileIndex of the car to re-audit
 *   - pdf[]: optional PDF files to incorporate (Carfax, service records)
 *
 * Streams SSE progress and writes the updated ComparisonResult back to Supabase.
 */
export async function POST(
  req: Request,
  context: { params: Promise<{ id: string }> | { id: string } }
) {
  const params    = await context.params;
  const sessionId = params.id;

  const formData    = await req.formData();
  const fileIndex   = parseInt(formData.get("carFileIndex") as string ?? "0", 10);
  const pdfs        = formData.getAll("pdf") as File[];

  const encoder = new TextEncoder();
  const stream  = new ReadableStream({
    async start(controller) {
      const send = (data: any) => {
        try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`)); } catch {}
      };

      try {
        send({ type: "progress", message: "Loading workspace...", pct: 5 });

        // ── Load workspace ──────────────────────────────────────────────────────
        const { data: msgs, error } = await supabaseAdmin
          .from("messages").select("content")
          .eq("case_id", sessionId).eq("role", "system")
          .order("created_at", { ascending: false }).limit(1);

        if (error || !msgs?.length) throw new Error("Workspace not found");

        let existing: ComparisonResult | null = null;
        try { existing = JSON.parse(msgs[0].content); } catch {}
        if (!existing) throw new Error("Could not parse workspace data");

        const targetCar = existing.cars.find(c => (c as any).fileIndex === fileIndex);
        if (!targetCar) throw new Error(`Car with fileIndex ${fileIndex} not found`);

        const currentSummary = existing.auditSummaries?.[fileIndex] as any;
        const currentVehicle = currentSummary?.auditResult?.vehicle ?? {};

        send({ type: "progress", message: `Re-auditing ${targetCar.vehicleName}...`, pct: 20 });

        // ── Extract PDF text from vault uploads ─────────────────────────────────
        let pdfText = "";
        if (pdfs.length > 0) {
          send({ type: "progress", message: "Processing documents...", pct: 30 });
          const pdfPromises = pdfs.map(f => f.arrayBuffer().then(buf => extractPdfText(Buffer.from(buf))));
          const texts = await Promise.allSettled(pdfPromises);
          pdfText = texts
            .filter(r => r.status === "fulfilled")
            .map((r: any) => r.value)
            .join("\n\n")
            .trim();
        }

        // ── Build combined text ─────────────────────────────────────────────────
        const listingParts: string[] = [];
        if (currentVehicle.year)           listingParts.push(`Year: ${currentVehicle.year}`);
        if (currentVehicle.make)           listingParts.push(`Make: ${currentVehicle.make}`);
        if (currentVehicle.model)          listingParts.push(`Model: ${currentVehicle.model}`);
        if (currentVehicle.trim)           listingParts.push(`Trim: ${currentVehicle.trim}`);
        if (currentVehicle.currentMileage) listingParts.push(`Mileage: ${currentVehicle.currentMileage.toLocaleString()} miles`);
        if (targetCar.askingPrice)         listingParts.push(`Asking Price: $${targetCar.askingPrice.toLocaleString()}`);
        if (targetCar.location)            listingParts.push(`Location: ${targetCar.location}`);

        const baseText  = listingParts.join("\n");
        const finalText = pdfText ? `${baseText}\n\n${pdfText}` : baseText;

        // ── Build peer context from the OTHER cars ──────────────────────────────
        const peers = existing.cars
          .filter(c => (c as any).fileIndex !== fileIndex)
          .map(c => {
            const miStr = c.mileage ? `${c.mileage.toLocaleString()} miles` : "unknown miles";
            const prStr = c.askingPrice ? `$${c.askingPrice.toLocaleString()}` : "unknown price";
            return `- ${c.vehicleName}: ${miStr}, ${prStr}${c.location ? ` (${c.location})` : ""}`;
          });
        const peerContext = peers.length > 0 ? peers.join("\n") : null;

        send({ type: "progress", message: "Running AI analysis...", pct: 45 });

        // ── Re-run the audit pipeline ───────────────────────────────────────────
        const auditResultRaw = await runAuditPipeline({
          text: finalText.trim(),
          vehicleOverride: {
            year:           currentVehicle.year,
            make:           currentVehicle.make,
            model:          currentVehicle.model,
            trim:           currentVehicle.trim,
            currentMileage: currentVehicle.currentMileage,
            vin:            currentVehicle.vin,
          },
          send:         () => {},
          skipSchedule: true,
          peerContext,
        });

        const newResult = (auditResultRaw as any)?.result ?? null;
        if (targetCar.askingPrice && newResult) newResult.askingPrice = targetCar.askingPrice;

        send({ type: "progress", message: "Updating rankings...", pct: 75 });

        // ── Patch the auditSummaries in place ───────────────────────────────────
        const updatedSummaries = [...(existing.auditSummaries ?? [])];
        updatedSummaries[fileIndex] = {
          ...(updatedSummaries[fileIndex] ?? {}),
          auditResult: newResult,
          verdict:     newResult?.verdict ?? "updated",
        };

        // ── Re-synthesize if there are 2+ cars ─────────────────────────────────
        let updatedSynthesis: any = existing;
        if (existing.cars.length >= 2) {
          const allResults = updatedSummaries.map(s => (s as any)?.auditResult ?? {});
          const allLocations = existing.cars.map(c => c.location ?? null);
          updatedSynthesis = await synthesizeComparison(
            allResults,
            existing.cars.map(() => null),
            existing.cars.map(c => c.listingUrl),
            existing.cars.map(c => c.listingNotes ?? ""),
            existing.cars.map(c => c.photoCount ?? 0),
            allLocations,
          );
        }

        const updatedComparison: ComparisonResult = {
          ...existing,
          ...updatedSynthesis,
          sessionId,
          auditSummaries: updatedSummaries,
        };

        // ── Save ────────────────────────────────────────────────────────────────
        await supabaseAdmin.from("messages").insert({
          case_id: sessionId,
          role:    "system",
          content: JSON.stringify(updatedComparison),
        });

        send({ type: "complete", comparison: updatedComparison, pct: 100 });
        controller.close();

      } catch (err: any) {
        console.error("[hunt/reaudit]", err);
        send({ type: "error", message: err.message ?? "Re-audit failed" });
        controller.close();
      }
    },
  });

  return new NextResponse(stream, {
    headers: {
      "Content-Type":  "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection":    "keep-alive",
    },
  });
}
