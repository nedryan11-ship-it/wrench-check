// lib/enrichment/runEnrichment.ts
// Core enrichment function — runs after a vehicle is inserted into the DB.
// Called fire-and-forget from the stream route. Also exposed via POST /api/hunt/[id]/enrich.
//
// Pipeline:
//  1. Extract photo URLs from the listing page (Firecrawl)
//  2. Run GPT-4o vision → mechanical area assessment + grade
//  3. Fetch NHTSA recalls for extracted VIN
//  4. Build VIN intelligence (known model issues)
//  5. Compute final enriched confidence_pct
//  6. Write all results back to watchlist_vehicles

import { supabaseAdmin } from "@/lib/supabase";
import { analyzeListingPhotos } from "@/lib/comparison/analyzePhotos";
import { buildVinIntelligence } from "@/lib/vehicleDatabases/vinIntelligence";

// ── Photo URL extraction from Firecrawl markdown ──────────────────────────────
function extractPhotoUrls(markdown: string): string[] {
  const urls: string[] = [];
  const mdImgs = [
    ...markdown.matchAll(
      /!\[.*?\]\((https?:\/\/[^\)]+\.(?:jpe?g|png|webp)(?:\?[^\)]*)?)\)/gi
    ),
  ];
  for (const m of mdImgs) urls.push(m[1]);
  const srcImgs = [
    ...markdown.matchAll(
      /src=["'](https?:\/\/[^\s"']+\.(?:jpe?g|png|webp)(?:\?[^\s"']*)?)/gi
    ),
  ];
  for (const m of srcImgs) urls.push(m[1]);
  return [...new Set(urls)]
    .filter((u) => u.length > 40 && !/logo|icon|avatar|badge|spinner/i.test(u))
    .slice(0, 8);
}

// ── Fetch listing markdown via Firecrawl ──────────────────────────────────────
async function fetchMarkdown(url: string): Promise<string | null> {
  if (!process.env.FIRECRAWL_API_KEY) return null;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 25000);
  try {
    const res = await fetch("https://api.firecrawl.dev/v1/scrape", {
      method: "POST",
      signal: abort.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.FIRECRAWL_API_KEY}`,
      },
      body: JSON.stringify({ url, formats: ["markdown"], onlyMainContent: false }),
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const data = await res.json();
    return data?.data?.markdown ?? data?.markdown ?? null;
  } catch {
    clearTimeout(timer);
    return null;
  }
}

// ── Extract VIN from markdown or listing page ─────────────────────────────────
function extractVin(markdown: string): string | null {
  // Standard VIN: 17 chars, no I, O, Q  (ISO 3779)
  const vinPattern = /\b([A-HJ-NPR-Z0-9]{17})\b/g;
  const matches = [...markdown.matchAll(vinPattern)];
  if (matches.length > 0) {
    // Prefer matches that appear near "VIN" keyword
    for (const m of matches) {
      const idx = m.index ?? 0;
      const context = markdown.slice(Math.max(0, idx - 30), idx + 20).toLowerCase();
      if (/vin|vehicle.?id|serial/i.test(context)) return m[1];
    }
    return matches[0][1]; // fallback to first VIN-like string
  }
  return null;
}

// ── Confidence computation ────────────────────────────────────────────────────
function computeEnrichedConfidence(p: {
  vin: string | null;
  recallCount: number;
  hasPhotos: boolean;
  photoGrade: string | null;
  engineBayVisible: boolean;
  undercarriageVisible: boolean;
  marketMid: number | null;
  hasCarfax: boolean;
  hasPpi: boolean;
}): number {
  let pct = 25; // base "AI estimated"
  if (p.marketMid) pct += 15;
  if (p.vin) pct += 5;
  if (p.hasPhotos) pct += 10;
  if (p.engineBayVisible) pct += 5;
  if (p.undercarriageVisible) pct += 5;
  if (p.photoGrade && ["A", "B+", "B"].includes(p.photoGrade)) pct += 5;
  if (p.hasCarfax) pct += 20;
  if (p.hasPpi) pct += 10;
  return Math.min(pct, 90); // max 90 without physical PPI
}

// ── Main enrichment function ──────────────────────────────────────────────────
export async function runEnrichment(vehicleId: string): Promise<void> {
  // Mark as in-progress immediately
  await supabaseAdmin
    .from("watchlist_vehicles")
    .update({ enrichment_status: "pending" })
    .eq("id", vehicleId);

  try {
    const { data: vehicle, error } = await supabaseAdmin
      .from("watchlist_vehicles")
      .select("*")
      .eq("id", vehicleId)
      .single();

    if (error || !vehicle) {
      await supabaseAdmin
        .from("watchlist_vehicles")
        .update({ enrichment_status: "failed" })
        .eq("id", vehicleId);
      return;
    }

    // Skip if no listing URL (manual entries)
    if (!vehicle.listing_url || vehicle.listing_url.startsWith("manual_")) {
      await supabaseAdmin
        .from("watchlist_vehicles")
        .update({ enrichment_status: "manual" })
        .eq("id", vehicleId);
      return;
    }

    // ── Step 1: Fetch listing markdown ──────────────────────────────────────
    const markdown = await fetchMarkdown(vehicle.listing_url);
    if (!markdown) {
      await supabaseAdmin
        .from("watchlist_vehicles")
        .update({ enrichment_status: "failed" })
        .eq("id", vehicleId);
      return;
    }

    // ── Step 2: Extract VIN ────────────────────────────────────────────────
    const extractedVin = vehicle.vin || extractVin(markdown);

    // ── Step 3: Photo URLs + Vision analysis ──────────────────────────────
    const photoUrls = extractPhotoUrls(markdown);
    let photoIntel: any = vehicle.photo_intel || null;
    let photoReport = null;

    if (photoUrls.length > 0) {
      photoReport = await analyzeListingPhotos(photoUrls);
      if (photoReport) {
        const gradeToCondition = (g: string) =>
          ["A", "B+"].includes(g) ? "clean" : ["B", "C+"].includes(g) ? "fair" : "flag";

        photoIntel = {
          // Legacy fields
          condition: gradeToCondition(photoReport.grade),
          summary: photoReport.gradeLabel,
          flags: photoReport.redFlags,
          // Rich new fields
          grade: photoReport.grade,
          gradeLabel: photoReport.gradeLabel,
          exterior: photoReport.exterior,
          interior: photoReport.interior,
          engineBay: photoReport.engineBay,
          undercarriage: photoReport.undercarriage,
          suspension: photoReport.suspension,
          redFlags: photoReport.redFlags,
          positives: photoReport.positives,
          mileageConsistency: photoReport.mileageConsistency,
          sellerContext: photoReport.sellerContext,
          backgroundNotes: photoReport.backgroundNotes,
          mechanicalCoverage: photoReport.mechanicalCoverage,
          missingAreas: photoReport.missingAreas,
          mechanicalFlags: photoReport.mechanicalFlags,
          // Collage
          photoUrls: photoUrls.slice(0, 6),
          photoCount: photoUrls.length,
          analyzedAt: new Date().toISOString(),
        };
      }
    }

    // ── Step 4: VIN Intelligence (NHTSA + known issues) ────────────────────
    let recalls: any[] = [];
    let vinIntel = null;
    if (vehicle.year && vehicle.make && vehicle.model) {
      vinIntel = await buildVinIntelligence(
        extractedVin,
        vehicle.year,
        vehicle.make,
        vehicle.model
      );
      recalls = vinIntel?.recalls ?? [];
    }

    // ── Step 5: Recompute confidence ───────────────────────────────────────
    const docs: any[] = Array.isArray(vehicle.documents) ? vehicle.documents : [];
    const hasCarfax = docs.some((d: any) => ["carfax", "autocheck"].includes(d.type));
    const hasPpi = docs.some((d: any) => d.type === "ppi");

    const newConfidence = computeEnrichedConfidence({
      vin: extractedVin,
      recallCount: recalls.length,
      hasPhotos: photoUrls.length > 0,
      photoGrade: photoReport?.grade ?? null,
      engineBayVisible: photoReport?.mechanicalCoverage?.engineBayVisible ?? false,
      undercarriageVisible: photoReport?.mechanicalCoverage?.undercarriageVisible ?? false,
      marketMid: vehicle.market_mid,
      hasCarfax,
      hasPpi,
    });

    // ── Step 6: Write enriched data back ───────────────────────────────────
    const updates: Record<string, any> = {
      enrichment_status: "complete",
      enriched_at: new Date().toISOString(),
      confidence_pct: newConfidence,
    };
    if (extractedVin) updates.vin = extractedVin;
    if (photoIntel) updates.photo_intel = photoIntel;
    if (recalls.length > 0) updates.recalls = recalls;

    await supabaseAdmin
      .from("watchlist_vehicles")
      .update(updates)
      .eq("id", vehicleId);

    console.log(
      `[enrich] ✅ ${vehicle.year} ${vehicle.make} ${vehicle.model} — ` +
      `VIN: ${extractedVin || "not found"}, ` +
      `photos: ${photoUrls.length}, ` +
      `grade: ${photoReport?.grade || "n/a"}, ` +
      `recalls: ${recalls.length}, ` +
      `confidence: ${newConfidence}%`
    );
  } catch (err) {
    console.error("[enrich] ❌ failed:", err);
    await supabaseAdmin
      .from("watchlist_vehicles")
      .update({ enrichment_status: "failed" })
      .eq("id", vehicleId);
  }
}
