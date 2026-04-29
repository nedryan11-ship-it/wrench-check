// app/api/advisor/sessions/[id]/messages/route.ts
// GET  — fetch all messages for a session
// POST — append a message to a session

import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: sessionId } = await params;

  const { data, error } = await supabaseAdmin
    .from("advisor_messages")
    .select("id, role, content, files, created_at")
    .eq("session_id", sessionId)
    .order("created_at", { ascending: true });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ messages: data ?? [] });
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: sessionId } = await params;
  const body = await req.json();
  const { role, content, files } = body;

  if (!role || !content) {
    return NextResponse.json({ error: "role and content required" }, { status: 400 });
  }

  const { data, error } = await supabaseAdmin
    .from("advisor_messages")
    .insert({
      session_id: sessionId,
      role,
      content,
      files: files || null,
    })
    .select("id, role, content, created_at")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Touch the session's updated_at
  await supabaseAdmin
    .from("advisor_sessions")
    .update({ updated_at: new Date().toISOString() })
    .eq("id", sessionId);

  return NextResponse.json({ message: data });
}
