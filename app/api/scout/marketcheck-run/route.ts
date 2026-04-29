// app/api/scout/marketcheck-run/route.ts
// On-demand Marketcheck scout — fetches all active 2020-2021 Land Cruiser listings,
// scores each, then:
//   • Brand-new listings → INSERT as "new"
//   • dismissed / watching / new leads → UPSERT with fresh price + score (dismissed resets to "new")
//   • added / starred leads → SKIP permanently (already in Radar)
//   • In watchlist_vehicles → SKIP (already in Radar)
//
// Uses Node's native https module to avoid Next.js fetch() patching that can
// block the event loop in development.

import { NextResponse } from "next/server";
import https from "https";
import { supabaseAdmin } from "@/lib/supabase";
import { computeWrenchScore } from "@/lib/comparison/wrenchScore";
import { computeTransitFromDenver } from "@/lib/scout/searchBuilders";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

const MC_KEY    = process.env.MARKETCHECK_API_KEY!;
const MC_SECRET = process.env.MARKETCHECK_API_SECRET!;
const SCOUT_LABEL = "2020–2021 Toyota Land Cruiser";

// ── Use native https to bypass Next.js fetch patching ─────────────────────────
function httpsGet(url: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error("Invalid JSON from Marketcheck")); }
      });
    });
    req.on("error", reject);
    req.setTimeout(15_000, () => {
      req.destroy();
      reject(new Error("Marketcheck request timed out after 15s"));
    });
  });
}

async function fetchMCListings(year: number): Promise<any[]> {
  const params = new URLSearchParams({
    api_key: MC_KEY,
    api_secret: MC_SECRET,
    year: String(year),
    make: "Toyota",
    model: "Land Cruiser",
    rows: "100",
    start: "0",
  });
  const url = `https://api.marketcheck.com/v2/search/car/active?${params}`;
  console.log(`[marketcheck-run] fetching year=${year}...`);
  try {
    const data = await httpsGet(url);
    if (data.error) {
      console.error(`[marketcheck-run] API error year=${year}:`, data.error);
      return [];
    }
    const listings = data.listings ?? [];
    console.log(`[marketcheck-run] year=${year} → ${listings.length} listings`);
    return listings;
  } catch (err: any) {
    console.error(`[marketcheck-run] fetch failed year=${year}:`, err.message);
    return [];
  }
}

function median(prices: number[]): number {
  if (!prices.length) return 0;
  const sorted = [...prices].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

export async function POST() {
  console.log("[marketcheck-run] POST received");
  try {
    // ── 1. Fetch all 2020 + 2021 Land Cruisers ──────────────────────────────
    const [listings2020, listings2021] = await Promise.all([
      fetchMCListings(2020),
      fetchMCListings(2021),
    ]);
    const all = [...listings2020, ...listings2021];
    console.log(`[marketcheck-run] total listings: ${all.length}`);

    if (all.length === 0) {
      return NextResponse.json({ error: "No listings returned from Marketcheck" }, { status: 502 });
    }

    // ── 2. Compute segment medians (year+trim) for like-for-like comps ──────────
    // Pool median is meaningless when comparing Heritage Edition to Base.
    // Group by year+trim, compute median within each segment.
    const segments = new Map<string, number[]>();
    const yearSegments = new Map<number, number[]>();
    const allPrices: number[] = [];
    
    for (const l of all) {
      const p = l.price;
      if (typeof p !== "number" || p <= 0) continue;
      allPrices.push(p);
      
      const yr = l.build?.year ?? 0;
      const tr = (l.build?.trim || "Base").toLowerCase().trim();
      const segKey = `${yr}|${tr}`;
      
      if (!segments.has(segKey)) segments.set(segKey, []);
      segments.get(segKey)!.push(p);
      
      if (!yearSegments.has(yr)) yearSegments.set(yr, []);
      yearSegments.get(yr)!.push(p);
    }
    
    const poolMedian = median(allPrices);
    console.log(`[marketcheck-run] pool median: $${poolMedian.toLocaleString()} (${allPrices.length} listings)`);
    console.log(`[marketcheck-run] segments: ${[...segments.entries()].map(([k,v]) => `${k}: $${median(v).toLocaleString()} (${v.length})`).join(', ')}`);
    
    // Helper: get the best market comp for a specific listing
    function getSegmentMedian(year: number, trim: string): { median: number; count: number; label: string } {
      const tr = (trim || "Base").toLowerCase().trim();
      const segKey = `${year}|${tr}`;
      const segPrices = segments.get(segKey);
      
      // Prefer exact year+trim segment (3+ comps for confidence)
      if (segPrices && segPrices.length >= 2) {
        const trimLabel = trim || "Base";
        return { median: median(segPrices), count: segPrices.length, label: `${year} ${trimLabel}` };
      }
      
      // Fall back to year-only segment
      const yearPrices = yearSegments.get(year);
      if (yearPrices && yearPrices.length >= 2) {
        return { median: median(yearPrices), count: yearPrices.length, label: `${year} all trims` };
      }
      
      // Last resort: full pool
      return { median: poolMedian, count: allPrices.length, label: `all 2020-2021` };
    }

    // ── 3. Get or create scout_config ───────────────────────────────────────
    let configId: string;
    const { data: existing } = await supabaseAdmin
      .from("scout_configs")
      .select("id")
      .eq("label", SCOUT_LABEL)
      .single();

    if (existing?.id) {
      configId = existing.id;
      await supabaseAdmin
        .from("scout_configs")
        .update({ last_run_at: new Date().toISOString(), is_active: true })
        .eq("id", configId);
    } else {
      const { data: created, error: createErr } = await supabaseAdmin
        .from("scout_configs")
        .insert({
          label: SCOUT_LABEL,
          make: "toyota",
          model: "land cruiser",
          year_min: 2020,
          year_max: 2021,
          sources: ["marketcheck"],
          is_active: true,
          last_run_at: new Date().toISOString(),
        })
        .select("id")
        .single();
      if (createErr || !created) {
        return NextResponse.json({ error: `scout_config error: ${createErr?.message}` }, { status: 500 });
      }
      configId = created.id;
    }

    // ── 4. Load skip lists and existing leads for upsert ────────────────────
    // Hard-skip: already in the user's Radar watchlist
    const { data: radarVehicles } = await supabaseAdmin
      .from("watchlist_vehicles")
      .select("vin, listing_url");
    const radarVins = new Set<string>((radarVehicles ?? []).map((v: any) => v.vin).filter(Boolean));
    const radarUrls = new Set<string>((radarVehicles ?? []).map((v: any) => v.listing_url).filter(Boolean));

    // Load all existing scout leads so we can classify them
    const { data: existingLeads } = await supabaseAdmin
      .from("scout_leads")
      .select("id, vin, listing_url, status");

    // Hard-skip: starred or added (user already took a positive action)
    const addedVins = new Set<string>();
    const addedUrls = new Set<string>();
    // Soft-skip: existing leads eligible for upsert (new / watching / dismissed)
    const existingByVin = new Map<string, any>();
    const existingByUrl = new Map<string, any>();

    for (const lead of existingLeads ?? []) {
      if (lead.status === "added" || lead.status === "starred") {
        if (lead.vin)         addedVins.add(lead.vin);
        if (lead.listing_url) addedUrls.add(lead.listing_url);
      } else {
        // new / watching / dismissed — eligible for upsert with fresh data
        if (lead.vin)         existingByVin.set(lead.vin, lead);
        if (lead.listing_url) existingByUrl.set(lead.listing_url, lead);
      }
    }

    // ── 5. Score each listing → insert new or upsert existing ───────────────
    const toInsert: any[] = [];
    const toUpsert: Array<{ id: string; fields: any }> = [];
    let skipped = 0;

    for (const listing of all) {
      const vin        = listing.vin;
      const listingUrl = listing.vdp_url;
      const build      = listing.build ?? {};

      if (!listingUrl) { skipped++; continue; }

      // Hard skip: in Radar already
      if (radarUrls.has(listingUrl) || (vin && radarVins.has(vin))) { skipped++; continue; }
      // Hard skip: starred or added
      if (addedUrls.has(listingUrl) || (vin && addedVins.has(vin))) { skipped++; continue; }

      const price: number | null   = listing.price ?? null;
      const mileage: number | null = listing.ref_miles ?? listing.miles ?? null;
      const year: number  = build.year  ?? 0;
      const make: string  = build.make  ?? "Toyota";
      const model: string = build.model ?? "Land Cruiser";
      const trim: string  = build.trim  ?? "";
      const dealer        = listing.dealer ?? {};
      const location      = [dealer.city, dealer.state].filter(Boolean).join(", ") || null;

      // carfax_clean_title: true = confirmed clean, false = just means "no CarFax data reported"
      // Only flag accident if CarFax explicitly says NOT clean AND we have positive confirmation
      const hasAccident = listing.carfax_clean_title === true ? false : null;
      const ownerCount  = listing.carfax_1_owner === true ? 1 : null;
      const photos: string[] = listing.media?.photo_links?.slice(0, 6) ?? [];

      if (!price || price <= 0) { skipped++; continue; }

      // Get like-for-like market comp for this specific year+trim
      const segComp = getSegmentMedian(year, trim);

      const ws = computeWrenchScore({
        year, make, model,
        mileage: mileage ?? 0,
        askingPrice: price,
        marketMid: segComp.median,
        marketComps: segComp.median ? { priceMed: segComp.median } : undefined,
        hasAccident, ownerCount, location,
        isSaltBelt: false, documents: [],
        tcoYear1High: segComp.median ? Math.round(segComp.median * 0.07) : 5000,
        maintenanceDebt: 0,
        reliabilityTier: "excellent",
      });

      if (ws.score < 30) { skipped++; continue; }

      const transit = computeTransitFromDenver(location);

      const freshFields = {
        scout_config_id: configId,
        vin, listing_url: listingUrl,
        title: `${year} ${make} ${model}${trim ? ` ${trim}` : ""}`,
        year, make, model, trim, mileage, price, location,
        shadow_score: ws.score,
        shadow_tier: ws.tier,
        transit_level: transit.level,
        transit_label: transit.label,
        gem_price_target: ws.gemPriceTarget,
        market_mid: segComp.median,
        raw_intel: {
          hasAccident, ownerCount, photos,
          carfax_clean_title: listing.carfax_clean_title,
          carfax_1_owner: listing.carfax_1_owner,
          exterior_color: listing.exterior_color,
          seller_type: listing.seller_type,
          dealer_name: dealer.name,
          dealer_phone: dealer.phone,
          source_site: dealer.website ?? listing.source,
          dom_active: listing.dom_active,
          comp_segment: segComp.label,
          comp_count: segComp.count,
        },
      };

      // Check if we already have this lead in a soft-skip status
      const existingLead = (vin && existingByVin.get(vin)) || existingByUrl.get(listingUrl);

      if (existingLead) {
        toUpsert.push({
          id: existingLead.id,
          fields: {
            ...freshFields,
            // dismissed → new (listing is still active, show it again)
            // watching → keep watching (price change detected)
            // new → stay new
            status: existingLead.status === "dismissed" ? "new" : existingLead.status,
          },
        });
      } else {
        // Brand new listing we've never seen
        toInsert.push({
          ...freshFields,
          status: "new",
          discovered_at: new Date().toISOString(),
        });
      }
    }

    // ── 6. Batch insert new leads ────────────────────────────────────────────
    let inserted = 0;
    if (toInsert.length > 0) {
      const { error: batchErr } = await supabaseAdmin.from("scout_leads").insert(toInsert);
      if (batchErr) console.error("[marketcheck-run] insert error:", batchErr.message);
      else inserted = toInsert.length;
    }

    // ── 7. Update existing leads with fresh price/score ──────────────────────
    let refreshed = 0;
    for (const { id, fields } of toUpsert) {
      const { error } = await supabaseAdmin.from("scout_leads").update(fields).eq("id", id);
      if (!error) refreshed++;
    }

    console.log(`[marketcheck-run] done: inserted=${inserted} refreshed=${refreshed} skipped=${skipped}`);
    return NextResponse.json({
      success: true,
      total_found: all.length,
      market_mid: poolMedian,
      inserted,
      refreshed,
      skipped,
      message: `Found ${all.length} Land Cruisers nationally. ${inserted} new · ${refreshed} refreshed. Market median: $${marketMid.toLocaleString()}.`,
    });

  } catch (err: any) {
    console.error("[marketcheck-run] unhandled error:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
