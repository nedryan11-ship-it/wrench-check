import { NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase";
import { ingestEstimate, ingestUrl, detectSourceType, type NormalizedExtraction } from "@/lib/ingest";
import { normalizeCaseLineItems } from "@/lib/logic";

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function createCase(): Promise<string> {
  const { data, error } = await supabase
    .from("cases")
    .insert({ status: "pending" })
    .select()
    .single();
  if (error || !data) throw new Error("Failed to create case: " + (error?.message || "no data"));
  return data.id;
}

async function saveExtraction(caseId: string, extraction: NormalizedExtraction) {
  // Update case record
  await supabase.from("cases").update({
    shop_name: extraction.shop_name,
    vehicle_year: String(extraction.vehicle_info?.year || ""),
    vehicle_make: String(extraction.vehicle_info?.make || ""),
    vehicle_model: String(extraction.vehicle_info?.model || ""),
    status: "processing",
  }).eq("id", caseId);

  // Save line items
  const items = extraction.line_items.filter((li) => li.description?.trim());
  if (items.length > 0) {
    await supabase.from("line_items").insert(
      items.map((li) => ({
        case_id: caseId,
        raw_text: li.description,
        price: li.price ?? 0,
      }))
    );
  }
}

// ─── Route handler ────────────────────────────────────────────────────────────

export async function POST(req: Request) {
  const contentType = req.headers.get("content-type") || "";

  // ── Mode 1: URL submission (JSON body) ─────────────────────────────────────
  if (contentType.includes("application/json")) {
    const body = await req.json();

    // URL ingestion
    if (body.url) {
      const url = body.url.trim();
      if (!url.startsWith("http://") && !url.startsWith("https://")) {
        return NextResponse.json({ error: "Please enter a valid URL starting with http:// or https://" }, { status: 400 });
      }
      try {
        const caseId = body.case_id || await createCase();
        const extraction = await ingestUrl(url);
        if (extraction.error) return NextResponse.json({ error: extraction.error }, { status: 422 });
        await saveExtraction(caseId, extraction);
        await normalizeCaseLineItems(caseId);
        return NextResponse.json({ case_id: caseId, source_type: extraction.source_type, shop_name: extraction.shop_name, item_count: extraction.line_items.length });
      } catch (err: any) {
        return NextResponse.json({ error: err.message }, { status: 422 });
      }
    }

    // Text ingestion
    if (body.text) {
      const text = body.text.trim();
      if (text.length < 20) return NextResponse.json({ error: "Pasted text is too short. Please paste the full estimate." }, { status: 400 });
      try {
        const caseId = body.case_id || await createCase();
        const extraction = await ingestEstimate({ type: "text", text });
        if (extraction.error) return NextResponse.json({ error: extraction.error }, { status: 422 });
        
        // If NO items found in line_items, but we have observations, use them as line items
        if (extraction.line_items.length === 0 && extraction.observations.length > 0) {
           extraction.line_items = extraction.observations.map(obs => ({ description: obs, price: 0 }));
        }

        if (extraction.line_items.length === 0) {
          return NextResponse.json({ error: "No service items found in the pasted text. Please paste the full estimate including prices." }, { status: 422 });
        }
        await saveExtraction(caseId, extraction);
        await normalizeCaseLineItems(caseId);
        return NextResponse.json({ case_id: caseId, source_type: extraction.source_type, shop_name: extraction.shop_name, item_count: extraction.line_items.length });
      } catch (err: any) {
        return NextResponse.json({ error: err.message }, { status: 422 });
      }
    }

    return NextResponse.json({ error: "Provide a 'url' or 'text' field." }, { status: 400 });
  }

  // ── Mode 2: File upload (multipart/form-data) ──────────────────────────────
  if (contentType.includes("multipart/form-data")) {
    let file: File | null = null;
    try {
      const formData = await req.formData();
      file = formData.get("file") as File | null;
    } catch {
      return NextResponse.json({ error: "Failed to parse uploaded file." }, { status: 400 });
    }

    if (!file) return NextResponse.json({ error: "No file uploaded." }, { status: 400 });

    const mimeType = file.type || "";
    const sourceKind = detectSourceType(file.name, mimeType);

    if (sourceKind === "unknown") {
      return NextResponse.json({
        error: `Unsupported file type "${file.name}". Please upload a PNG, JPG, WEBP, or PDF.`,
      }, { status: 400 });
    }

    if (file.size > 20 * 1024 * 1024) {
      return NextResponse.json({ error: "File is too large (max 20 MB)." }, { status: 400 });
    }

    try {
      const buffer = Buffer.from(await file.arrayBuffer());
      const caseId = await createCase();

      // Also upload to Supabase storage for posterity
      const safeName = file.name.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9.-]/g, "");
      const filePath = `${caseId}/${Date.now()}-${safeName}`;
      await supabase.storage.from("estimates").upload(filePath, buffer, { contentType: mimeType });
      await supabase.from("uploads").insert({ case_id: caseId, file_url: filePath });

      const extraction = await ingestEstimate(
        sourceKind === "pdf"
          ? { type: "pdf", buffer }
          : { type: "image", buffer, mimeType }
      );

      if (extraction.error) return NextResponse.json({ error: extraction.error }, { status: 422 });
      console.log("=== SERVICES_BEFORE_FILTER:", extraction.line_items.length, "line items,", extraction.observations.length, "observations ===" );

      // Promote observations to line items if no priced items
      if (extraction.line_items.length === 0 && extraction.observations.length > 0) {
        console.log("[ingest] Promoting observations to line items (no priced items found)");
        extraction.line_items = extraction.observations.map(obs => ({ description: obs, price: 0 }));
      }
      
      console.log("=== SERVICES_AFTER_FILTER:", extraction.line_items.length, "items ===");

      if (extraction.line_items.length === 0) {
        // Return case_id anyway so user can manually add services — don't hard-block
        await supabase.from("cases").update({ status: "partial" }).eq("id", caseId);
        return NextResponse.json({ 
          case_id: caseId, 
          warning: "We couldn't fully extract this estimate — you can add services manually.",
          item_count: 0,
          confidence: "low"
        });
      }

      await saveExtraction(caseId, extraction);
      await normalizeCaseLineItems(caseId);

      return NextResponse.json({
        case_id: caseId,
        source_type: extraction.source_type,
        shop_name: extraction.shop_name,
        item_count: extraction.line_items.length,
        confidence: extraction.confidence,
      });

    } catch (err: any) {
      console.error("[/api/ingest] file error:", err);
      return NextResponse.json({ error: err.message || "Failed to process file." }, { status: 500 });
    }
  }

  return NextResponse.json({ error: "Unsupported content type." }, { status: 415 });
}
