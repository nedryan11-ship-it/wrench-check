import { NextResponse } from "next/server";

// GET /api/market/bat-comps?make=toyota&model=land+cruiser&yearStart=2018&yearEnd=2021
// Fetches recent sold auction results from Bring a Trailer for a given vehicle.
// Results are cached 24h via revalidate.

export const revalidate = 86400; // cache 24 hours

interface BaTResult {
  title: string;
  sold_price: number | null;
  bid_count: number | null;
  date: string;
  url: string;
  mileage: number | null;
  year: number | null;
  no_reserve: boolean;
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const make = searchParams.get("make") || "toyota";
  const model = searchParams.get("model") || "land cruiser";
  const yearStart = parseInt(searchParams.get("yearStart") || "2018");
  const yearEnd = parseInt(searchParams.get("yearEnd") || "2021");

  try {
    // BaT's public search endpoint for completed auctions
    const query = encodeURIComponent(`${make} ${model}`);
    const batUrl = `https://bringatrailer.com/wp-json/bringatrailer/1.0/data/listings?taxonomies={"pa_listing-tags":["sold"]}&search=${query}&numberOfResults=24&page=0`;
    
    const res = await fetch(batUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; WrenchCheck/1.0; research bot)",
        "Accept": "application/json",
      },
      next: { revalidate: 86400 },
    });

    if (!res.ok) {
      // Fallback: scrape the public results page HTML
      return fetchBaTHtml(make, model, yearStart, yearEnd);
    }

    const data = await res.json();
    const listings: any[] = data?.results || data?.listings || [];

    const results: BaTResult[] = listings
      .filter((l: any) => {
        const title = (l.title || l.post_title || "").toLowerCase();
        return title.includes(model.toLowerCase());
      })
      .map((l: any) => {
        const title = l.title || l.post_title || "";
        const yearMatch = title.match(/\b(19|20)\d{2}\b/);
        const year = yearMatch ? parseInt(yearMatch[0]) : null;
        const mileageMatch = (l.subtitle || title).match(/([\d,]+)\s*(?:k\s*)?miles?/i);
        const mileage = mileageMatch
          ? parseInt(mileageMatch[1].replace(/,/g, "")) * (mileageMatch[0].includes("k") ? 1000 : 1)
          : null;

        return {
          title,
          sold_price: l.sold_price ? parseInt(String(l.sold_price).replace(/\D/g, "")) : null,
          bid_count: l.bid_count ?? null,
          date: l.sold_date || l.date || "",
          url: l.url || l.permalink || "",
          mileage,
          year,
          no_reserve: !!(l.no_reserve || (l.title || "").toLowerCase().includes("no reserve")),
        };
      })
      .filter((r) => r.year === null || (r.year >= yearStart && r.year <= yearEnd))
      .filter((r) => r.sold_price !== null)
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
      .slice(0, 12);

    if (results.length === 0) {
      return fetchBaTHtml(make, model, yearStart, yearEnd);
    }

    const prices = results.map((r) => r.sold_price!).filter(Boolean);
    const stats = prices.length > 0 ? {
      count: prices.length,
      median: prices.sort((a, b) => a - b)[Math.floor(prices.length / 2)],
      low: Math.min(...prices),
      high: Math.max(...prices),
      avg: Math.round(prices.reduce((a, b) => a + b, 0) / prices.length),
    } : null;

    return NextResponse.json({ source: "bat_api", results, stats });
  } catch (err: any) {
    return fetchBaTHtml(make, model, yearStart, yearEnd);
  }
}

// Fallback: scrape BaT results page for sold comps
async function fetchBaTHtml(make: string, model: string, yearStart: number, yearEnd: number) {
  try {
    const modelSlug = model.toLowerCase().replace(/\s+/g, "-");
    const batPageUrl = `https://bringatrailer.com/${modelSlug.includes("land") ? "toyota/land-cruiser" : modelSlug}/`;

    const res = await fetch(batPageUrl, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; research)" },
    });

    if (!res.ok) throw new Error(`BaT page fetch failed: ${res.status}`);

    const html = await res.text();

    // Parse sold listings from the HTML
    const soldPattern = /data-listing-id="(\d+)"[^>]*>[^<]*<[^>]+class="[^"]*listing-card[^"]*"[^>]*>[^<]*<a[^>]+href="(https:\/\/bringatrailer\.com\/listing\/[^"]+)"[^>]*>[^<]*<img[^>]+alt="([^"]+)"/g;
    const pricePattern = /Sold for \$([\d,]+)/g;

    const soldMatches = [...html.matchAll(/Sold for \$([\d,]+)/g)];
    const titleMatches = [...html.matchAll(/class="listing-card-title[^"]*"[^>]*>([^<]+)</g)];
    const urlMatches = [...html.matchAll(/href="(https:\/\/bringatrailer\.com\/listing\/[^"]+)"/g)];
    const dateMatches = [...html.matchAll(/(\w+ \d+, 20\d{2})/g)];

    const results: BaTResult[] = soldMatches.slice(0, 10).map((m, i) => ({
      title: titleMatches[i]?.[1]?.trim() || `${make} ${model}`,
      sold_price: parseInt(m[1].replace(/,/g, "")),
      bid_count: null,
      date: dateMatches[i]?.[1] || "",
      url: urlMatches[i]?.[1] || batPageUrl,
      mileage: null,
      year: null,
      no_reserve: false,
    })).filter((r) => r.sold_price > 0);

    const prices = results.map((r) => r.sold_price!).filter(Boolean);
    const stats = prices.length > 0 ? {
      count: prices.length,
      median: prices.sort((a, b) => a - b)[Math.floor(prices.length / 2)],
      low: Math.min(...prices),
      high: Math.max(...prices),
      avg: Math.round(prices.reduce((a, b) => a + b, 0) / prices.length),
    } : null;

    return NextResponse.json({ source: "bat_html", results, stats, page: batPageUrl });
  } catch (err: any) {
    // Return static fallback data for Land Cruiser 200-series (from known market data)
    const fallbackStats = {
      count: 0,
      median: 75000,
      low: 62000,
      high: 94000,
      avg: 77000,
      note: "Estimated from market knowledge — live BaT data unavailable",
    };
    return NextResponse.json({
      source: "fallback_estimate",
      results: [],
      stats: fallbackStats,
      error: err.message,
    });
  }
}
