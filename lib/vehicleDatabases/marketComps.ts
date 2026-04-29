/**
 * marketComps.ts
 * Fetches live retail market pricing by scraping Cars.com search results
 * via Firecrawl. Returns count, price range, and median asking price for
 * a given Year/Make/Model/mileage band. Runs once per YMMT group per Hunt session.
 */

export interface MarketComps {
  yearMakeModel: string;       // "2019 Toyota Land Cruiser"
  count: number;               // how many listings found
  priceMin: number;
  priceMax: number;
  priceMed: number;            // median asking price
  mileageBandLabel: string;    // "50k–100k miles"
  fetchedAt: string;
}

// ── Build a Cars.com search URL ────────────────────────────────────────────────
function slugify(s: string) {
  return s.toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "");
}

function carsComUrl(make: string, model: string, year: number, mileage?: number | null): string {
  const makeSlug  = slugify(make);
  const modelSlug = `${makeSlug}-${slugify(model)}`;

  // Mileage band: ±40k of the car's actual mileage, capped at 200k
  const mileMax = mileage ? Math.min(Math.round((mileage + 40000) / 10000) * 10000, 200000) : 150000;
  const mileMin = mileage ? Math.max(Math.round((mileage - 40000) / 10000) * 10000, 0)      : 0;

  const params = new URLSearchParams({
    [`makes[]`]:          makeSlug,
    [`models[]`]:         modelSlug,
    year_min:             String(year),
    year_max:             String(year),
    mileage_max:          String(mileMax),
    mileage_min:          String(mileMin),
    stock_type:           "all",
    maximum_distance:     "all",
    sort:                 "best_match_desc",
  });

  return `https://www.cars.com/shopping/results/?${params.toString()}`;
}

// ── Extract prices from Firecrawl markdown ─────────────────────────────────────
function parsePricesFromMarkdown(markdown: string): number[] {
  // Match patterns like $74,440 or $74440 or 74,440 in a vehicle-listing context
  const matches = markdown.matchAll(/\$\s*([\d]{2,3},?\d{3})/g);
  const prices: number[] = [];
  for (const m of matches) {
    const val = parseInt(m[1].replace(/,/g, ""), 10);
    // Filter to reasonable used car prices: $5k–$250k
    if (val >= 5000 && val <= 250000) {
      prices.push(val);
    }
  }
  return prices;
}

function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round((sorted[mid - 1] + sorted[mid]) / 2)
    : sorted[mid];
}

// ── Main export ────────────────────────────────────────────────────────────────
export async function fetchMarketComps(
  make: string,
  model: string,
  year: number,
  mileage?: number | null,
): Promise<MarketComps | null> {
  if (!process.env.FIRECRAWL_API_KEY) {
    console.warn("[marketComps] FIRECRAWL_API_KEY not set, skipping");
    return null;
  }
  if (!make || !model || !year) return null;

  const url = carsComUrl(make, model, year, mileage);
  const ymm = `${year} ${make} ${model}`;

  try {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 18000);

    const res = await fetch("https://api.firecrawl.dev/v1/scrape", {
      method: "POST",
      signal: abort.signal,
      headers: {
        "Content-Type":  "application/json",
        "Authorization": `Bearer ${process.env.FIRECRAWL_API_KEY}`,
      },
      body: JSON.stringify({
        url,
        formats:     ["markdown"],
        // Only get the first page — we just need a sample of prices
        onlyMainContent: true,
      }),
    });

    clearTimeout(timer);

    if (!res.ok) {
      console.warn(`[marketComps] Firecrawl HTTP ${res.status} for ${ymm}`);
      return null;
    }

    const data     = await res.json();
    const markdown = data?.data?.markdown ?? data?.markdown ?? "";

    if (!markdown) {
      console.warn("[marketComps] Empty markdown response for", ymm);
      return null;
    }

    const prices = parsePricesFromMarkdown(markdown);
    if (prices.length < 2) {
      console.warn(`[marketComps] Not enough prices found for ${ymm}: ${prices.length}`);
      return null;
    }

    const mileMax   = mileage ? Math.min(mileage + 40000, 200000) : 150000;
    const mileMin   = mileage ? Math.max(mileage - 40000, 0) : 0;
    const bandLabel = `${Math.round(mileMin / 1000)}k–${Math.round(mileMax / 1000)}k miles`;

    const result: MarketComps = {
      yearMakeModel: ymm,
      count:         prices.length,
      priceMin:      Math.min(...prices),
      priceMax:      Math.max(...prices),
      priceMed:      median(prices),
      mileageBandLabel: bandLabel,
      fetchedAt:     new Date().toISOString(),
    };

    console.log(`[marketComps] ${ymm}: ${prices.length} listings, med=$${result.priceMed.toLocaleString()}, range=$${result.priceMin.toLocaleString()}–$${result.priceMax.toLocaleString()}`);
    return result;

  } catch (err) {
    console.warn(`[marketComps] Failed for ${ymm}:`, (err as Error).message);
    return null;
  }
}
