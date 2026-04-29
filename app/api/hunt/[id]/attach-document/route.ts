// app/api/hunt/[id]/attach-document/route.ts
// Accepts a CARFAX / AutoCheck / PPI file, runs it through the maintenance audit
// pipeline, then adjusts the vehicle's WrenchScore and confidence_pct in Supabase.

import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";

// ── Confidence calculation ────────────────────────────────────────────────────
function computeConfidence(v: {
  market_mid?: number | null;
  documents?: any[];
  photo_intel?: any;
}): number {
  let pct = 25; // base: listing scraped
  if (v.market_mid) pct += 20; // market comps fetched
  if (v.documents?.some((d: any) => ["carfax", "autocheck"].includes(d.type))) pct += 25;
  if (v.photo_intel?.condition) pct += 15; // photos scanned
  if (v.documents?.some((d: any) => d.type === "ppi")) pct += 15; // PPI uploaded
  return Math.min(pct, 100);
}

// ── Score adjustment from CARFAX data ────────────────────────────────────────
function computeScoreAdjustment(
  baseScore: number,
  docType: string,
  extractedData: {
    maintenanceDebt?: number;
    hasAccident?: boolean;
    listingHadAccident?: boolean;
  }
): number {
  let adj = baseScore;
  const { maintenanceDebt = 0, hasAccident, listingHadAccident } = extractedData;

  if (docType === "carfax" || docType === "autocheck") {
    // Hidden accident not in listing → fraud signal → big penalty
    if (hasAccident && !listingHadAccident) adj = Math.max(0, adj - 12);

    // Maintenance debt bands
    if (maintenanceDebt < 500) adj = Math.min(100, adj + 5);
    else if (maintenanceDebt > 2000) adj = Math.max(0, adj - 8);
    // $500–$2000 = no change, already estimated in base score
  }

  if (docType === "ppi") {
    // PPI with conditions: trust the explicit data
    if (hasAccident) adj = Math.max(0, adj - 5);
    if (maintenanceDebt < 300) adj = Math.min(100, adj + 3);
    else if (maintenanceDebt > 3000) adj = Math.max(0, adj - 10);
  }

  return Math.round(adj);
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const vehicleId = (await params).id;
  if (!vehicleId) {
    return NextResponse.json({ error: "Missing vehicle ID" }, { status: 400 });
  }

  let docType = "carfax";
  let file: File | null = null;

  try {
    const formData = await req.formData();
    file = formData.get("file") as File | null;
    docType = (formData.get("docType") as string) || "carfax";
  } catch {
    return NextResponse.json({ error: "Invalid form data" }, { status: 400 });
  }

  if (!file) {
    return NextResponse.json({ error: "No file provided" }, { status: 400 });
  }

  if (file.size > 20 * 1024 * 1024) {
    return NextResponse.json({ error: "File too large (max 20 MB)" }, { status: 400 });
  }

  // ── Fetch the current vehicle ─────────────────────────────────────────────
  const { data: vehicle, error: fetchErr } = await supabaseAdmin
    .from("watchlist_vehicles")
    .select("*")
    .eq("id", vehicleId)
    .single();

  if (fetchErr || !vehicle) {
    return NextResponse.json({ error: "Vehicle not found" }, { status: 404 });
  }

  // ── Run the file through the maintenance audit pipeline ───────────────────
  // We call our own maintenance-audit API endpoint to avoid duplicating OCR code
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || "http://localhost:3000";

  const uploadForm = new FormData();
  uploadForm.append("file", file);

  // Include vehicle context so the pipeline knows what it's auditing
  const vehicleHint = [vehicle.year, vehicle.make, vehicle.model, vehicle.trim]
    .filter(Boolean)
    .join(" ");
  if (vehicleHint) {
    uploadForm.append(
      "vehicleOverride",
      JSON.stringify({
        year: vehicle.year,
        make: vehicle.make,
        model: vehicle.model,
        trim: vehicle.trim,
      })
    );
  }

  let extractedData: {
    maintenanceDebt: number;
    hasAccident: boolean;
    maintenanceEvents: number;
    vehicleNarrative: string;
    rawAuditResult: any;
  } = {
    maintenanceDebt: 0,
    hasAccident: false,
    maintenanceEvents: 0,
    vehicleNarrative: "",
    rawAuditResult: null,
  };

  try {
    const auditRes = await fetch(`${baseUrl}/api/maintenance-audit`, {
      method: "POST",
      body: uploadForm,
    });

    // The maintenance-audit endpoint returns SSE — drain and grab the complete event
    if (auditRes.headers.get("content-type")?.includes("text/event-stream") && auditRes.body) {
      const reader = auditRes.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      let finalPayload: any = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const parts = buf.split("\n\n");
        buf = parts.pop() ?? "";
        for (const part of parts) {
          if (!part.startsWith("data: ")) continue;
          try {
            const evt = JSON.parse(part.slice(6));
            if (evt.type === "complete") finalPayload = evt;
          } catch {}
        }
      }

      if (finalPayload?.success && finalPayload?.result) {
        const result = finalPayload.result;
        const repairs: any[] = result.repairs || result.majorExposures || [];
        const totalDebt = repairs.reduce(
          (sum: number, r: any) => sum + (r.costHigh || r.estimatedCostHigh || 0),
          0
        );
        extractedData = {
          maintenanceDebt: totalDebt,
          hasAccident: result.hasAccident ?? false,
          maintenanceEvents: (result.serviceHistory?.length || result.events?.length || 0),
          vehicleNarrative: result.vehicleNarrative || "",
          rawAuditResult: result,
        };
      }
    }
  } catch (err) {
    console.error("[attach-document] Audit pipeline error:", err);
    // Continue — store the doc as attached even if extraction partially failed
  }

  // ── Update vehicle row ────────────────────────────────────────────────────
  const existingDocs: any[] = Array.isArray(vehicle.documents) ? vehicle.documents : [];

  // Remove previous doc of same type (replace, not stack)
  const filteredDocs = existingDocs.filter((d: any) => d.type !== docType);

  const newDoc = {
    type: docType,
    uploadedAt: new Date().toISOString(),
    fileName: file.name,
    maintenanceDebt: extractedData.maintenanceDebt,
    maintenanceEvents: extractedData.maintenanceEvents,
    hasAccident: extractedData.hasAccident,
    vehicleNarrative: extractedData.vehicleNarrative,
  };

  const updatedDocs = [...filteredDocs, newDoc];

  const adjustedScore = computeScoreAdjustment(vehicle.score || 50, docType, {
    maintenanceDebt: extractedData.maintenanceDebt,
    hasAccident: extractedData.hasAccident,
    listingHadAccident: vehicle.has_accident ?? false,
  });

  const newConfidence = computeConfidence({
    market_mid: vehicle.market_mid,
    documents: updatedDocs,
    photo_intel: vehicle.photo_intel,
  });

  const { data: updated, error: updateErr } = await supabaseAdmin
    .from("watchlist_vehicles")
    .update({
      documents: updatedDocs,
      adjusted_score: adjustedScore,
      confidence_pct: newConfidence,
    })
    .eq("id", vehicleId)
    .select()
    .single();

  if (updateErr) {
    console.error("[attach-document] DB update error:", updateErr);
    return NextResponse.json({ error: updateErr.message }, { status: 500 });
  }

  return NextResponse.json({
    success: true,
    vehicle: updated,
    doc: newDoc,
    adjustedScore,
    confidencePct: newConfidence,
    scoreDelta: adjustedScore - (vehicle.score || 50),
  });
}

// ── DELETE — remove a document from a vehicle ─────────────────────────────────
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const vehicleId = (await params).id;
  let docType = "carfax";
  try {
    const body = await req.json();
    docType = body.docType || "carfax";
  } catch {}

  const { data: vehicle, error: fetchErr } = await supabaseAdmin
    .from("watchlist_vehicles")
    .select("*")
    .eq("id", vehicleId)
    .single();

  if (fetchErr || !vehicle) {
    return NextResponse.json({ error: "Vehicle not found" }, { status: 404 });
  }

  const updatedDocs = (vehicle.documents || []).filter((d: any) => d.type !== docType);
  const newConfidence = computeConfidence({
    market_mid: vehicle.market_mid,
    documents: updatedDocs,
    photo_intel: vehicle.photo_intel,
  });

  const { data: updated, error: updateErr } = await supabaseAdmin
    .from("watchlist_vehicles")
    .update({ documents: updatedDocs, confidence_pct: newConfidence, adjusted_score: null })
    .eq("id", vehicleId)
    .select()
    .single();

  if (updateErr) return NextResponse.json({ error: updateErr.message }, { status: 500 });
  return NextResponse.json({ success: true, vehicle: updated });
}
