import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";

// PATCH: update radar status (focus | watching)
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const id = (await params).id;
  if (!id) return NextResponse.json({ error: "Missing ID" }, { status: 400 });

  const body = await request.json();
  const { status } = body;

  if (!["focus", "watching"].includes(status)) {
    return NextResponse.json({ error: "status must be 'focus' or 'watching'" }, { status: 400 });
  }

  const { error } = await supabaseAdmin
    .from("watchlist_vehicles")
    .update({ status })
    .eq("id", id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ success: true });
}

// DELETE: hard delete — vehicle is gone permanently
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const id = (await params).id;
  if (!id) return NextResponse.json({ error: "Missing ID" }, { status: 400 });

  const { error } = await supabaseAdmin
    .from("watchlist_vehicles")
    .delete()
    .eq("id", id);

  if (error) {
    console.error(`[DELETE /hunt/${id}] error:`, error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
