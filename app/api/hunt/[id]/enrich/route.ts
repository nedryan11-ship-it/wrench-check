// app/api/hunt/[id]/enrich/route.ts
// POST — triggers the background enrichment pipeline for a vehicle.
// Called automatically by stream route after insert (fire-and-forget).
// Can also be called manually via UI "Re-enrich" button.

import { NextResponse } from "next/server";
import { runEnrichment } from "@/lib/enrichment/runEnrichment";

export const maxDuration = 60; // Allow up to 60s for vision + NHTSA

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const vehicleId = (await params).id;
  if (!vehicleId) {
    return NextResponse.json({ error: "Vehicle ID required" }, { status: 400 });
  }

  // Run enrichment — this is the long-running part
  await runEnrichment(vehicleId);

  return NextResponse.json({ success: true, vehicleId });
}
