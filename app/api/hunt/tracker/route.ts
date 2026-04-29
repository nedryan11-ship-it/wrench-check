import { supabaseAdmin } from "@/lib/supabase";
import { NextResponse } from "next/server";
import { scrapeListingUrlFast } from "@/lib/vehicleDatabases/fastScrape";

export const dynamic = "force-dynamic";

// GET: return only active radar vehicles (focus + watching), never passed/deleted
export async function GET() {
  const { data, error } = await supabaseAdmin
    .from("watchlist_vehicles")
    .select("*")
    .not("status", "eq", "passed")   // exclude soft-deletes
    .order("created_at", { ascending: false });

  if (error) {
    if (error.code === "42P01") {
      return NextResponse.json({ error: "SCHEMA_MISSING", message: "Please run garage_schema.sql" }, { status: 500 });
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ vehicles: data });
}

export async function POST(req: Request) {
  try {
    const { url } = await req.json();
    if (!url) return NextResponse.json({ error: "Missing URL" }, { status: 400 });

    const intel = await scrapeListingUrlFast(url);
    if (!intel.year || !intel.make) {
      return NextResponse.json({ error: "Failed to extract core vehicle data from listing." }, { status: 400 });
    }

    const { data, error } = await supabaseAdmin.from("watchlist_vehicles").insert({
      listing_url: url,
      title: intel.title,
      year: intel.year,
      make: intel.make,
      model: intel.model,
      trim: intel.trim,
      mileage: intel.mileage,
      price: intel.price,
      initial_price: intel.price,
      lowest_price: intel.price,
      location: intel.location,
      description: intel.description,
      owner_count: intel.ownerCount,
      has_accident: intel.hasAccident,
      seller_name: intel.sellerName,
      days_on_market: intel.daysOnMarket,
      status: "focus",   // default to focus for manually-added vehicles
      price_history: intel.price ? [{ price: intel.price, date: new Date().toISOString() }] : [],
    }).select().single();

    if (error) {
      if (error.code === "23505") return NextResponse.json({ error: "Vehicle already in garage", vehicle: data }, { status: 409 });
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ vehicle: data });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

// PATCH: update radar status (focus | watching)
export async function PATCH(req: Request) {
  try {
    const body = await req.json();
    const { id, status, sort_order } = body;
    if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });

    const updates: any = {};
    if (status && ["focus", "watching"].includes(status)) updates.status = status;
    if (typeof sort_order === "number") updates.sort_order = sort_order;

    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ error: "No valid fields to update" }, { status: 400 });
    }

    const { error } = await supabaseAdmin
      .from("watchlist_vehicles")
      .update(updates)
      .eq("id", id);

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ success: true });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  try {
    const { id } = await req.json();
    if (!id) return NextResponse.json({ error: "Missing ID" }, { status: 400 });

    const { error } = await supabaseAdmin.from("watchlist_vehicles").delete().eq("id", id);
    if (error) throw error;

    return NextResponse.json({ success: true });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
