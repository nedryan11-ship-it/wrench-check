// app/api/advisor/sessions/route.ts
// GET    — list all sessions (most recent first)
// POST   — create a new session
// PATCH  — update session (title, summary)

import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";

export async function GET() {
  const { data, error } = await supabaseAdmin
    .from("advisor_sessions")
    .select("id, title, created_at, updated_at, summary, vehicle_refs, is_active")
    .eq("is_active", true)
    .order("updated_at", { ascending: false })
    .limit(50);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ sessions: data ?? [] });
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const title = body.title || "New conversation";

  const { data, error } = await supabaseAdmin
    .from("advisor_sessions")
    .insert({ title })
    .select("id, title, created_at, updated_at")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ session: data });
}

export async function PATCH(req: Request) {
  const body = await req.json();
  const { id, title, summary, vehicle_refs, is_active } = body;

  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  const updates: any = { updated_at: new Date().toISOString() };
  if (title !== undefined) updates.title = title;
  if (summary !== undefined) updates.summary = summary;
  if (vehicle_refs !== undefined) updates.vehicle_refs = vehicle_refs;
  if (is_active !== undefined) updates.is_active = is_active;

  const { data, error } = await supabaseAdmin
    .from("advisor_sessions")
    .update(updates)
    .eq("id", id)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ session: data });
}
