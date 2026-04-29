// Quick test: which step is hanging?
import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";

export async function POST() {
  console.log("[scout-test] Step 1: route reached");
  
  try {
    const MC_KEY = process.env.MARKETCHECK_API_KEY!;
    const MC_SECRET = process.env.MARKETCHECK_API_SECRET!;
    console.log("[scout-test] Step 2: keys =", MC_KEY?.slice(0,8), MC_SECRET?.slice(0,8));
    
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    
    const url = `https://api.marketcheck.com/v2/search/car/active?api_key=${MC_KEY}&api_secret=${MC_SECRET}&year=2021&make=Toyota&model=Land+Cruiser&rows=3`;
    console.log("[scout-test] Step 3: fetching...");
    const res = await fetch(url, { cache: "no-store", signal: controller.signal });
    clearTimeout(timer);
    console.log("[scout-test] Step 4: HTTP", res.status);
    
    const data = await res.json();
    console.log("[scout-test] Step 5: listings =", data.listings?.length);
    
    console.log("[scout-test] Step 6: querying supabase...");
    const { data: leads, error } = await supabaseAdmin.from("scout_leads").select("id").limit(1);
    console.log("[scout-test] Step 7: supabase done, leads =", leads?.length, "err =", error?.message);
    
    return NextResponse.json({ ok: true, listings: data.listings?.length, supabase: !error });
  } catch(e: any) {
    console.error("[scout-test] FAILED:", e.message);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
