// app/api/case/[id]/route.ts
// Case data API — server-side admin client bypasses RLS.
// Handles READ (GET, includes messages) and vehicle UPDATE (PATCH).

import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";

/** GET /api/case/[id] — load case + messages */
export async function GET(
  _req: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  if (!id) return NextResponse.json({ error: "Missing case ID" }, { status: 400 });

  const [caseRes, msgRes] = await Promise.all([
    supabaseAdmin.from("cases").select("*").eq("id", id).single(),
    supabaseAdmin.from("messages").select("*").eq("case_id", id).order("created_at", { ascending: true }),
  ]);

  if (caseRes.error || !caseRes.data) {
    return NextResponse.json({ error: "Case not found" }, { status: 404 });
  }

  return NextResponse.json({
    case: caseRes.data,
    messages: msgRes.data ?? [],
  });
}

/** PATCH /api/case/[id] — update vehicle info or other allowed fields */
export async function PATCH(
  req: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  if (!id) return NextResponse.json({ error: "Missing case ID" }, { status: 400 });

  try {
    const body = await req.json();
    const allowed = ["vehicle_year", "vehicle_make", "vehicle_model", "status", "shop_name"];
    const updates = Object.fromEntries(
      Object.entries(body).filter(([k]) => allowed.includes(k))
    );

    const { error } = await supabaseAdmin.from("cases").update(updates).eq("id", id);
    if (error) throw error;
    return NextResponse.json({ success: true });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
