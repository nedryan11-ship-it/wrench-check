import { NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase";
import { ingestEstimate, detectSourceType } from "@/lib/ingest";
import { normalizeCaseLineItems } from "@/lib/logic";

// ─── Regex fallback ─────────────────────────────────────────────────────────
// If vision returns nothing, try to extract services from raw text patterns
function regexFallbackExtract(rawText: string): Array<{ description: string; price: number }> {
  const items: Array<{ description: string; price: number }> = [];
  // Match lines like: "Brake Pad Replacement .......... $189.00" or "Engine Oil Change - $89.99"
  const priceLineRegex = /^(.+?)[\s\-\.]{2,}?\$?([\d,]+\.?\d{0,2})\s*$/gm;
  let match;
  while ((match = priceLineRegex.exec(rawText)) !== null) {
    const description = match[1].trim();
    const price = parseFloat(match[2].replace(",", ""));
    if (description.length > 3 && price > 0) {
      items.push({ description, price });
    }
  }
  return items;
}

export async function POST(req: Request) {
  try {
    const formData = await req.formData();
    const files = formData.getAll("files") as File[];

    if (!files || files.length === 0) {
      return NextResponse.json({ error: "No files uploaded." }, { status: 400 });
    }

    if (files.length > 15) {
      return NextResponse.json({ error: "Maximum of 15 files allowed per scan." }, { status: 400 });
    }

    // Create case upfront
    const { data: caseData, error: caseErr } = await supabase
      .from("cases")
      .insert({ status: "pending" })
      .select()
      .single();

    if (caseErr || !caseData) throw new Error("Failed to create case.");
    const caseId = caseData.id;

    // Aggregated results across all files
    let shopName: string | null = null;
    let vehicleInfo: any = {};
    const allLineItems: Array<{ description: string; price: number }> = [];
    let overallConfidence: "high" | "medium" | "low" = "high";

    // Process each file
    for (const file of files) {
      const mimeType = file.type || "";
      const sourceKind = detectSourceType(file.name, mimeType);

      if (sourceKind === "unknown") {
        console.warn(`[upload-init] Skipping unsupported file: ${file.name}`);
        continue;
      }

      const safeName = file.name.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9.-]/g, "");
      const filePath = `${caseId}/${Date.now()}-${safeName}`;
      const buffer = Buffer.from(await file.arrayBuffer());

      // Upload to storage for reference
      await supabase.storage.from("estimates").upload(filePath, buffer, { contentType: mimeType });
      await supabase.from("uploads").insert({ case_id: caseId, file_url: filePath });

      // Run extraction
      console.log(`[upload-init] Extracting from: ${file.name} (${sourceKind})`);
      let extraction;
      try {
        extraction = await ingestEstimate(
          sourceKind === "pdf"
            ? { type: "pdf", buffer }
            : { type: "image", buffer, mimeType }
        );
      } catch (extractErr: any) {
        console.error(`[upload-init] Extraction failed for ${file.name}:`, extractErr.message);
        overallConfidence = "low";
        continue;
      }

      console.log("=== RAW_EXTRACTION_RESULT ===");
      console.log("Shop:", extraction.shop_name);
      console.log("Vehicle:", JSON.stringify(extraction.vehicle_info));
      console.log("Line items before filter:", JSON.stringify(extraction.line_items));
      console.log("Observations:", JSON.stringify(extraction.observations));
      console.log("Confidence:", extraction.confidence);
      console.log("============================");

      if (!shopName && extraction.shop_name) shopName = extraction.shop_name;
      if (!vehicleInfo.year && extraction.vehicle_info?.year) vehicleInfo = extraction.vehicle_info;
      if (extraction.confidence === "low") overallConfidence = "low";
      else if (extraction.confidence === "medium" && overallConfidence === "high") overallConfidence = "medium";

      // Merge line items
      if (extraction.line_items.length > 0) {
        allLineItems.push(...extraction.line_items);
        console.log(`[upload-init] Added ${extraction.line_items.length} line items from ${file.name}`);
      }

      // Fallback: promote observations to line items if no priced items found
      if (extraction.line_items.length === 0 && extraction.observations.length > 0) {
        console.log(`[upload-init] No line items — promoting ${extraction.observations.length} observations`);
        extraction.observations.forEach((obs) => {
          allLineItems.push({ description: obs, price: 0 });
        });
      }

      // Fallback: regex extraction from raw_text
      if (extraction.line_items.length === 0 && extraction.raw_text && extraction.raw_text.length > 50) {
        const regexItems = regexFallbackExtract(extraction.raw_text);
        console.log(`[upload-init] Regex fallback found ${regexItems.length} items`);
        allLineItems.push(...regexItems);
      }
    }

    console.log(`=== SERVICES_AFTER_FILTER: ${allLineItems.length} total items ===`);

    // Update case record
    await supabase.from("cases").update({
      shop_name: shopName || "Unknown Shop",
      vehicle_year: String(vehicleInfo.year || ""),
      vehicle_make: String(vehicleInfo.make || ""),
      vehicle_model: String(vehicleInfo.model || ""),
      status: "processing",
    }).eq("id", caseId);

    // Insert line items (even if empty — audit page handles no-service state)
    if (allLineItems.length > 0) {
      const itemsToInsert = allLineItems
        .filter((li) => li.description?.trim())
        .map((li) => ({
          case_id: caseId,
          raw_text: li.description,
          price: li.price ?? 0,
        }));

      if (itemsToInsert.length > 0) {
        const { error: insertErr } = await supabase.from("line_items").insert(itemsToInsert);
        if (insertErr) {
          console.error("[upload-init] line_items insert failed:", insertErr);
        }
      }
    }

    // Run normalization
    try {
      await normalizeCaseLineItems(caseId);
    } catch (normErr) {
      console.error("[upload-init] normalization failed (non-fatal):", normErr);
    }

    return NextResponse.json({
      case_id: caseId,
      item_count: allLineItems.length,
      shop_name: shopName,
      confidence: overallConfidence,
    });

  } catch (err: any) {
    console.error("[/api/upload-init] error:", err);
    return NextResponse.json({ error: err.message || "Failed to initiate scan." }, { status: 500 });
  }
}
