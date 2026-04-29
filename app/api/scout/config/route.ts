// app/api/scout/config/route.ts
// CRUD for scout search configurations

import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";

export async function GET() {
  const { data, error } = await supabaseAdmin
    .from("scout_configs")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ configs: data ?? [] });
}

export async function POST(req: Request) {
  const body = await req.json();
  const { label, make, model, year_min, year_max, price_max, mileage_max, radius_miles, sources } = body;

  if (!make) return NextResponse.json({ error: "make is required" }, { status: 400 });

  const { data, error } = await supabaseAdmin
    .from("scout_configs")
    .insert({
      label: label || `${make}${model ? " " + model : ""} Scout`,
      make: make.toLowerCase().trim(),
      model: model?.toLowerCase().trim() || null,
      year_min: year_min || null,
      year_max: year_max || null,
      price_max: price_max || null,
      mileage_max: mileage_max || null,
      radius_miles: radius_miles || 500,
      sources: sources || ["cars.com", "bat"],
      is_active: true,
    })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ config: data });
}

export async function DELETE(req: Request) {
  const body = await req.json();
  const { id } = body;
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  const { error } = await supabaseAdmin
    .from("scout_configs")
    .update({ is_active: false })
    .eq("id", id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ success: true });
}
