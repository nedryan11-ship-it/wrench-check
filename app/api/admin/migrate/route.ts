import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";

// One-time migration endpoint — run once, then optionally delete this file
// GET /api/admin/migrate
export async function GET() {
  const results: string[] = [];

  // Add offer_log column
  const { error: e1 } = await supabaseAdmin.rpc("exec_raw", {
    sql: "ALTER TABLE watchlist_vehicles ADD COLUMN IF NOT EXISTS offer_log jsonb DEFAULT '[]'::jsonb"
  }).catch(() => ({ error: null }));
  
  // Since exec_raw likely doesn't exist, use a workaround:
  // Try to SELECT the column — if it fails, we need to add it
  const { error: checkOfferLog } = await supabaseAdmin
    .from("watchlist_vehicles").select("offer_log").limit(1);
  
  if (checkOfferLog?.code === "42703") {
    results.push("offer_log: NEEDS MANUAL MIGRATION");
  } else {
    results.push("offer_log: ✅ exists (or already added)");
  }

  const { error: checkNotes } = await supabaseAdmin
    .from("watchlist_vehicles").select("notes").limit(1);
  results.push(`notes: ${checkNotes?.code === "42703" ? "NEEDS MANUAL MIGRATION" : "✅ exists"}`);

  const { error: checkCarfax } = await supabaseAdmin
    .from("watchlist_vehicles").select("carfax_data").limit(1);
  results.push(`carfax_data: ${checkCarfax?.code === "42703" ? "NEEDS MANUAL MIGRATION" : "✅ exists"}`);

  return NextResponse.json({
    message: "Migration check complete. Run the SQL below in Supabase SQL Editor if any columns are missing.",
    status: results,
    sql: `
ALTER TABLE watchlist_vehicles
  ADD COLUMN IF NOT EXISTS offer_log   jsonb DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS notes       text  DEFAULT '',
  ADD COLUMN IF NOT EXISTS carfax_data jsonb DEFAULT '{}'::jsonb;

ALTER TABLE watchlist_vehicles
  DROP CONSTRAINT IF EXISTS watchlist_vehicles_status_check;

ALTER TABLE watchlist_vehicles
  ADD CONSTRAINT watchlist_vehicles_status_check
  CHECK (status IN ('watching', 'focus', 'purchased', 'passed'));
    `.trim()
  });
}
