// app/api/extract-listing-price/route.ts
// Server-side listing URL parser — extracts asking price without any API key.
// Strategy (in order):
//   1. JSON-LD structured data (works on CarGurus, AutoTrader, Cars.com, Carvana)
//   2. Open Graph / meta price tags
//   3. Common HTML price patterns (regex fallback)

import { NextRequest, NextResponse } from "next/server";

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

function extractFromJsonLd(html: string): number | null {
  // Find all JSON-LD blocks
  const scriptMatches = html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
  for (const match of scriptMatches) {
    try {
      const data = JSON.parse(match[1]);
      // Car listing schema: Vehicle or Product with offers
      const checkObj = (obj: any): number | null => {
        if (!obj || typeof obj !== "object") return null;
        // Direct price field
        if (obj.price && !isNaN(Number(obj.price))) {
          const p = Number(obj.price);
          if (p > 1000 && p < 500000) return Math.round(p);
        }
        // offers.price
        if (obj.offers?.price && !isNaN(Number(obj.offers.price))) {
          const p = Number(obj.offers.price);
          if (p > 1000 && p < 500000) return Math.round(p);
        }
        // offers array
        if (Array.isArray(obj.offers)) {
          for (const offer of obj.offers) {
            const p = checkObj(offer);
            if (p) return p;
          }
        }
        // @graph array (common in schema.org)
        if (Array.isArray(obj["@graph"])) {
          for (const node of obj["@graph"]) {
            const p = checkObj(node);
            if (p) return p;
          }
        }
        return null;
      };
      const result = checkObj(data);
      if (result) return result;
    } catch { /* invalid JSON, skip */ }
  }
  return null;
}

function extractFromMeta(html: string): number | null {
  // og:price:amount, product:price:amount, etc.
  const patterns = [
    /property=["'](?:og:price:amount|product:price:amount)["'][^>]+content=["']([0-9,. ]+)["']/i,
    /content=["']([0-9,. ]+)["'][^>]+property=["'](?:og:price:amount|product:price:amount)["']/i,
    /name=["']price["'][^>]+content=["']([0-9,. ]+)["']/i,
  ];
  for (const pattern of patterns) {
    const m = html.match(pattern);
    if (m) {
      const p = parseFloat(m[1].replace(/,/g, "").trim());
      if (!isNaN(p) && p > 1000 && p < 500000) return Math.round(p);
    }
  }
  return null;
}

function extractFromHtml(html: string): number | null {
  // Site-specific patterns for major listing sites
  // CarGurus: data-cg-ft="srp-listing-blade-price"  or "price":"42000"
  // AutoTrader: "listingPrice":42000 or "price":42000
  const jsonPatterns = [
    /"listingPrice"\s*:\s*([0-9]+)/,
    /"askingPrice"\s*:\s*([0-9]+)/,
    /"vehiclePrice"\s*:\s*([0-9]+)/,
    /"displayPrice"\s*:\s*"?([0-9,]+)"?/,
    /"price"\s*:\s*([0-9]{4,6})\b/,        // price between 4-6 digits (1000–999999)
  ];
  for (const pattern of jsonPatterns) {
    const m = html.match(pattern);
    if (m) {
      const p = parseInt(m[1].replace(/,/g, ""), 10);
      if (!isNaN(p) && p > 1000 && p < 500000) return p;
    }
  }
  return null;
}

export async function POST(req: NextRequest) {
  try {
    const { url } = await req.json();
    if (!url || typeof url !== "string") {
      return NextResponse.json({ error: "URL required" }, { status: 400 });
    }

    // Basic URL validation
    let parsed: URL;
    try { parsed = new URL(url); } catch {
      return NextResponse.json({ error: "Invalid URL" }, { status: 400 });
    }

    // Only allow known car listing domains
    const allowedDomains = [
      "autotrader.com", "cargurus.com", "cars.com", "carvana.com",
      "carmax.com", "vroom.com", "truecar.com", "edmunds.com",
      "facebook.com", "craigslist.org", "ebay.com",
    ];
    const hostname = parsed.hostname.replace(/^www\./, "");
    const isAllowed = allowedDomains.some(d => hostname === d || hostname.endsWith("." + d));
    if (!isAllowed) {
      return NextResponse.json({ error: "Unsupported listing site", hostname }, { status: 422 });
    }

    // Fetch with timeout
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    let html: string;
    try {
      const res = await fetch(url, { headers: HEADERS, signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) {
        return NextResponse.json({ error: `Site returned ${res.status}` }, { status: 422 });
      }
      html = await res.text();
    } catch (err) {
      clearTimeout(timer);
      const msg = err instanceof Error ? err.message : String(err);
      return NextResponse.json({ error: `Fetch failed: ${msg}` }, { status: 422 });
    }

    // Try extraction methods in order
    const price = extractFromJsonLd(html) ?? extractFromMeta(html) ?? extractFromHtml(html);

    if (price) {
      console.log(`[extract-listing-price] ${hostname} → $${price.toLocaleString()}`);
      return NextResponse.json({ price, source: hostname });
    }

    return NextResponse.json({ error: "Price not found on this page", price: null }, { status: 422 });

  } catch (err) {
    console.error("[extract-listing-price]", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
