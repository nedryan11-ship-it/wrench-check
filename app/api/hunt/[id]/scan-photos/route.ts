// app/api/hunt/[id]/scan-photos/route.ts
// Extracts photo URLs from listing via Firecrawl, runs GPT-4o vision for
// structured condition assessment (grade A-D), stores photos + insights in photo_intel.

import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { analyzeListingPhotos } from "@/lib/comparison/analyzePhotos";

// Inlined confidence computation (no cross-route imports allowed in Next.js)
function computeConfidence(v: {
  market_mid?: number | null;
  documents?: any[];
  photo_intel?: any;
}): number {
  let pct = 25;
  if (v.market_mid) pct += 20;
  if (v.documents?.some((d: any) => ["carfax", "autocheck"].includes(d.type))) pct += 25;
  if (v.photo_intel?.condition) pct += 15;
  if (v.documents?.some((d: any) => d.type === "ppi")) pct += 15;
  return Math.min(pct, 100);
}

// ── Extract image URLs from Firecrawl markdown ─────────────────────────────────
function extractPhotoUrls(markdown: string): string[] {
  const urls: string[] = [];
  const mdImgs = [...markdown.matchAll(/!\[.*?\]\((https?:\/\/[^\)]+\.(?:jpe?g|png|webp)(?:\?[^\)]*)?)\)/gi)];
  for (const m of mdImgs) urls.push(m[1]);
  const srcImgs = [...markdown.matchAll(/src=["'](https?:\/\/[^\s"']+\.(?:jpe?g|png|webp)(?:\?[^\s"']*)?)/gi)];
  for (const m of srcImgs) urls.push(m[1]);
  // Filter out icons/logos, deduplicate
  const deduped = [...new Set(urls)].filter(u => u.length > 40 && !/logo|icon|avatar|badge|thumb\.gif/i.test(u));
  return deduped.slice(0, 8); // keep up to 8 for collage
}

// ── Fetch listing markdown via Firecrawl ───────────────────────────────────────
async function fetchListingMarkdown(url: string): Promise<string | null> {
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

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const vehicleId = (await params).id;

  const { data: vehicle, error } = await supabaseAdmin
    .from("watchlist_vehicles")
    .select("*")
    .eq("id", vehicleId)
    .single();

  if (error || !vehicle) {
    return NextResponse.json({ error: "Vehicle not found" }, { status: 404 });
  }

  if (!vehicle.listing_url || vehicle.listing_url.startsWith("manual_")) {
    return NextResponse.json({ error: "No listing URL to scan" }, { status: 400 });
  }

  // ── Step 1: Fetch listing markdown ────────────────────────────────────────
  const markdown = await fetchListingMarkdown(vehicle.listing_url);
  if (!markdown) {
    return NextResponse.json({ error: "Could not fetch listing page for photo extraction" }, { status: 422 });
  }

  const photoUrls = extractPhotoUrls(markdown);
  if (photoUrls.length === 0) {
    return NextResponse.json({ error: "No photos found on listing page" }, { status: 422 });
  }

  console.log(`[scan-photos] Found ${photoUrls.length} photos for ${vehicle.year} ${vehicle.make} ${vehicle.model}`);

  // ── Step 2: Rich GPT-4o Vision analysis ──────────────────────────────────
  const report = await analyzeListingPhotos(photoUrls);

  // Map letter grade to simple condition bucket (backwards compat)
  const gradeToCondition = (grade: string) => {
    if (["A", "B+"].includes(grade)) return "clean";
    if (["B", "C+"].includes(grade)) return "fair";
    return "flag";
  };

  const photoIntel = {
    // Legacy fields for backwards compat with existing UI
    condition: report ? gradeToCondition(report.grade) : "fair",
    summary: report?.gradeLabel || "Photos analyzed.",
    flags: report?.redFlags || [],
    // Rich new fields
    grade: report?.grade || null,
    gradeLabel: report?.gradeLabel || null,
    exterior: report?.exterior || null,
    interior: report?.interior || null,
    engineBay: report?.engineBay || null,
    redFlags: report?.redFlags || [],
    positives: report?.positives || [],
    mileageConsistency: report?.mileageConsistency || "unverifiable",
    sellerContext: report?.sellerContext || "unknown",
    backgroundNotes: report?.backgroundNotes || null,
    // Photo URLs for collage display
    photoUrls: photoUrls.slice(0, 6),
    photoCount: photoUrls.length,
    analyzedAt: new Date().toISOString(),
  };

  // ── Step 3: Recompute confidence + score adjustment ───────────────────────
  const docs: any[] = Array.isArray(vehicle.documents) ? vehicle.documents : [];
  const newConfidence = computeConfidence({
    market_mid: vehicle.market_mid,
    documents: docs,
    photo_intel: photoIntel,
  });

  // Grade-based score delta: A=+5, B+=+3, B=+1, C+=-2, C=-5, D=-10
  const currentScore = vehicle.adjusted_score || vehicle.score || 50;
  const gradeAdj: Record<string, number> = { "A": +5, "B+": +3, "B": +1, "C+": -2, "C": -5, "D": -10 };
  const adj = gradeAdj[report?.grade || "B"] ?? 0;
  const newAdjustedScore = Math.max(0, Math.min(100, currentScore + adj));

  const { data: updated, error: updateErr } = await supabaseAdmin
    .from("watchlist_vehicles")
    .update({
      photo_intel: photoIntel,
      confidence_pct: newConfidence,
      adjusted_score: newAdjustedScore,
    })
    .eq("id", vehicleId)
    .select()
    .single();

  if (updateErr) {
    return NextResponse.json({ error: updateErr.message }, { status: 500 });
  }

  return NextResponse.json({
    success: true,
    vehicle: updated,
    photoIntel,
    confidencePct: newConfidence,
    adjustedScore: newAdjustedScore,
    photoCount: photoUrls.length,
  });
}
