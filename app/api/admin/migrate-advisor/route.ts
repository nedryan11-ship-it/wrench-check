// app/api/admin/migrate-advisor/route.ts
// One-time migration endpoint for advisor sessions tables
// GET /api/admin/migrate-advisor

import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";

export async function GET() {
  const results: string[] = [];

  // Check if advisor_sessions exists
  const { error: checkSessions } = await supabaseAdmin
    .from("advisor_sessions")
    .select("id")
    .limit(1);

  if (checkSessions?.code === "42P01" || checkSessions?.message?.includes("not found")) {
    results.push("⚠️ advisor_sessions table not found. Please run the following SQL in your Supabase SQL Editor:");
    results.push("");
    results.push("  https://supabase.com/dashboard/project/_/sql");
    results.push("");
  } else {
    results.push("✅ advisor_sessions exists");
  }

  // Check if advisor_messages exists
  const { error: checkMessages } = await supabaseAdmin
    .from("advisor_messages")
    .select("id")
    .limit(1);

  if (checkMessages?.code === "42P01" || checkMessages?.message?.includes("not found")) {
    results.push("⚠️ advisor_messages table not found.");
  } else {
    results.push("✅ advisor_messages exists");
  }

  // If any missing, try creating via rpc (may not work without the function)
  const needsMigration = results.some(r => r.includes("⚠️"));

  return NextResponse.json({
    status: results,
    needsMigration,
    sql: needsMigration ? `
-- Run this in your Supabase SQL Editor:
CREATE TABLE IF NOT EXISTS advisor_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text DEFAULT 'New conversation',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  summary text,
  vehicle_refs text[],
  is_active boolean DEFAULT true
);

CREATE TABLE IF NOT EXISTS advisor_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid REFERENCES advisor_sessions(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('user', 'assistant')),
  content text NOT NULL,
  files jsonb,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_advisor_messages_session ON advisor_messages(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_advisor_sessions_active ON advisor_sessions(is_active, updated_at DESC);

ALTER TABLE advisor_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE advisor_messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY allow_all_sessions ON advisor_sessions FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY allow_all_messages ON advisor_messages FOR ALL USING (true) WITH CHECK (true);
    `.trim() : "No migration needed.",
  });
}
