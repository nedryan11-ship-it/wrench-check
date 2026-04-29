// app/api/scout/leads/route.ts
// GET  ?status=active → new + watching leads (inbox view)
// GET  ?status=<single> → exact match
// PATCH id + status → update lead status (watching | starred | dismissed | added)
// DELETE ?config_id=<id> → reset all dismissed leads to new (Refresh Scout)

import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";

const VALID_STATUSES = ["new", "watching", "starred", "added", "dismissed"];

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const status = searchParams.get("status") || "new";

  let query = supabaseAdmin
    .from("scout_leads")
    .select("*, scout_configs(label, make, model)")
    .order("shadow_score", { ascending: false })
    .order("discovered_at", { ascending: false })
    .limit(100);

  if (status === "active") {
    // inbox view: new + watching
    query = query.in("status", ["new", "watching"]);
  } else {
    query = query.eq("status", status);
  }

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ leads: data ?? [] });
}

export async function PATCH(req: Request) {
  const body = await req.json();
  const { id, status } = body;

  if (!id || !VALID_STATUSES.includes(status)) {
    return NextResponse.json({ error: "id and valid status required" }, { status: 400 });
  }

  const { data, error } = await supabaseAdmin
    .from("scout_leads")
    .update({ status })
    .eq("id", id)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ lead: data });
}

// Reset dismissed leads → new so they surface again in inbox
export async function DELETE(req: Request) {
  const { searchParams } = new URL(req.url);
  const configId = searchParams.get("config_id");

  let query = supabaseAdmin
    .from("scout_leads")
    .update({ status: "new" })
    .eq("status", "dismissed");

  if (configId) query = query.eq("scout_config_id", configId);

  const { error, count } = await (query as any).select("id", { count: "exact", head: true });
  const { error: updateErr } = await supabaseAdmin
    .from("scout_leads")
    .update({ status: "new" })
    .eq("status", "dismissed");

  if (updateErr) return NextResponse.json({ error: updateErr.message }, { status: 500 });
  return NextResponse.json({ ok: true, reset: count ?? "all" });
}
