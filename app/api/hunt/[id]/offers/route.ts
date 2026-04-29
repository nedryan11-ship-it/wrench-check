import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";

// GET /api/hunt/[id]/offers — fetch offer log
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = (await params).id;
  if (!id) return NextResponse.json({ error: "Missing ID" }, { status: 400 });

  const { data, error } = await supabaseAdmin
    .from("watchlist_vehicles")
    .select("offer_log, notes")
    .eq("id", id)
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ offer_log: data.offer_log ?? [], notes: data.notes ?? "" });
}

// POST /api/hunt/[id]/offers — add a new offer entry
// Body: { amount: number, outcome: "pending"|"countered"|"accepted"|"rejected", note?: string }
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = (await params).id;
  if (!id) return NextResponse.json({ error: "Missing ID" }, { status: 400 });

  const body = await req.json();
  const { amount, outcome = "pending", note = "" } = body;

  if (!amount || typeof amount !== "number") {
    return NextResponse.json({ error: "amount (number) required" }, { status: 400 });
  }

  // Fetch existing log
  const { data: current, error: fetchErr } = await supabaseAdmin
    .from("watchlist_vehicles")
    .select("offer_log")
    .eq("id", id)
    .single();

  if (fetchErr) return NextResponse.json({ error: fetchErr.message }, { status: 500 });

  const existing: any[] = Array.isArray(current.offer_log) ? current.offer_log : [];
  const newEntry = {
    id: `${Date.now()}`,
    amount,
    outcome,
    note,
    date: new Date().toISOString(),
  };
  const updated = [...existing, newEntry];

  const { error: updateErr } = await supabaseAdmin
    .from("watchlist_vehicles")
    .update({ offer_log: updated })
    .eq("id", id);

  if (updateErr) return NextResponse.json({ error: updateErr.message }, { status: 500 });
  return NextResponse.json({ success: true, entry: newEntry, offer_log: updated });
}

// PATCH /api/hunt/[id]/offers — update an existing entry OR update notes
// Body: { entry_id: string, outcome: string } OR { notes: string }
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = (await params).id;
  if (!id) return NextResponse.json({ error: "Missing ID" }, { status: 400 });

  const body = await req.json();

  // Notes update
  if (typeof body.notes === "string") {
    const { error } = await supabaseAdmin
      .from("watchlist_vehicles")
      .update({ notes: body.notes })
      .eq("id", id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ success: true });
  }

  // Mileage update (from inline edit in card header)
  if (typeof body.mileage === "number") {
    const { error } = await supabaseAdmin
      .from("watchlist_vehicles")
      .update({ mileage: body.mileage })
      .eq("id", id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ success: true });
  }

  // Price update (manual correction or Advisor-driven)
  if (typeof body.price === "number") {
    const { error } = await supabaseAdmin
      .from("watchlist_vehicles")
      .update({ price: body.price })
      .eq("id", id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ success: true });
  }

  // Location update
  if (typeof body.location === "string") {
    const { error } = await supabaseAdmin
      .from("watchlist_vehicles")
      .update({ location: body.location })
      .eq("id", id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ success: true });
  }

  // Accident history update
  if (typeof body.has_accident === "boolean") {
    const { error } = await supabaseAdmin
      .from("watchlist_vehicles")
      .update({ has_accident: body.has_accident })
      .eq("id", id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ success: true });
  }

  // Owner count update
  if (typeof body.owner_count === "number") {
    const { error } = await supabaseAdmin
      .from("watchlist_vehicles")
      .update({ owner_count: body.owner_count })
      .eq("id", id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ success: true });
  }

  // Multi-field update (from Advisor write-back or bulk edit)
  if (body.fields && typeof body.fields === "object") {
    const allowed = ["price", "mileage", "location", "has_accident", "owner_count", "notes", "gem_price_target"];
    const updates: Record<string, any> = {};
    for (const [key, val] of Object.entries(body.fields)) {
      if (allowed.includes(key) && val !== undefined && val !== null) {
        updates[key] = val;
      }
    }
    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ error: "No valid fields to update" }, { status: 400 });
    }
    const { error } = await supabaseAdmin
      .from("watchlist_vehicles")
      .update(updates)
      .eq("id", id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ success: true, updated: Object.keys(updates) });
  }

  // Offer outcome update
  const { entry_id, outcome } = body;
  if (!entry_id || !outcome) {
    return NextResponse.json({ error: "entry_id and outcome required" }, { status: 400 });
  }

  const { data: current, error: fetchErr } = await supabaseAdmin
    .from("watchlist_vehicles")
    .select("offer_log")
    .eq("id", id)
    .single();

  if (fetchErr) return NextResponse.json({ error: fetchErr.message }, { status: 500 });

  const updated = (current.offer_log ?? []).map((e: any) =>
    e.id === entry_id ? { ...e, outcome, updated_at: new Date().toISOString() } : e
  );

  const { error } = await supabaseAdmin
    .from("watchlist_vehicles")
    .update({ offer_log: updated })
    .eq("id", id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ success: true, offer_log: updated });
}

// DELETE /api/hunt/[id]/offers?entry_id=xxx — remove one offer entry
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = (await params).id;
  const entry_id = new URL(req.url).searchParams.get("entry_id");
  if (!id || !entry_id) return NextResponse.json({ error: "Missing params" }, { status: 400 });

  const { data: current, error: fetchErr } = await supabaseAdmin
    .from("watchlist_vehicles")
    .select("offer_log")
    .eq("id", id)
    .single();

  if (fetchErr) return NextResponse.json({ error: fetchErr.message }, { status: 500 });

  const updated = (current.offer_log ?? []).filter((e: any) => e.id !== entry_id);

  const { error } = await supabaseAdmin
    .from("watchlist_vehicles")
    .update({ offer_log: updated })
    .eq("id", id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ success: true, offer_log: updated });
}
