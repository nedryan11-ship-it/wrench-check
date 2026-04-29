import OpenAI from "openai";

export interface ListingIntel {
  title: string | null;
  year: number | null;
  make: string | null;
  model: string | null;
  trim: string | null;
  mileage: number | null;
  price: number | null;
  location: string | null;
  ownerCount: number | null;
  hasAccident: boolean | null;
  description: string | null;
  auctionEndDate: string | null;
  sellerType: 'dealer' | 'private' | 'auction' | null;
  sellerName: string | null;    // Actual name: "EchoPark Automotive", "John D.", "Bring a Trailer"
  daysOnMarket: number | null;  // Days listing has been live on source platform
}

// ─── Shared GPT extraction (used by both Jina and Firecrawl paths) ─────────────
async function extractWithGPT(url: string, markdown: string): Promise<ListingIntel> {
  const empty: ListingIntel = {
    title: null, year: null, make: null, model: null, trim: null,
    mileage: null, price: null, location: null,
    ownerCount: null, hasAccident: null, description: null, auctionEndDate: null,
    sellerType: null, sellerName: null, daysOnMarket: null
  };

  const today = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const completion = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [
      {
        role: "system",
        content: `You are an automotive data extractor. Today's date is ${today}. Extract vehicle listing details from the provided markdown. Output JSON ONLY, exactly matching this structure: { title: string|null, year: number|null, make: string|null, model: string|null, trim: string|null, mileage: number|null, price: number|null, location: string|null, ownerCount: number|null, hasAccident: boolean|null, description: string|null, auctionEndDate: string|null, sellerType: string|null, sellerName: string|null, daysOnMarket: number|null }. Keep description concise (1-2 sentences). For accident, true if reported/damaged, false if clean.

CRITICAL LOCATION RULE: For national dealers (Carvana, EchoPark, Hertz, etc.), the markdown often shows "Pickup closest to X" or "Delivery to Y" based on the scraping server's IP. **IGNORE** shipping destinations, delivery hubs, or localized user greeting headers. Search the deeper text specifically for the EXACT physical dealership or storage lot where the vehicle is currently sitting. For example, if it says "EchoPark Automotive Denver" in the footer, the location is Denver. ALWAYS return "City, ST" format (e.g. "Denver, CO"). If you cannot definitively prove the physical parking lot location, return null rather than a fake proxy shipping destination.

CRITICAL AUCTION RULE: Only provide auctionEndDate if the site is a dedicated auction platform (e.g. Bring a Trailer, Cars & Bids, tow yard). NEVER extract an auction end date for standard dealerships (Carvana, EchoPark, local dealers) or standard fixed-price / Buy-It-Now listings, even if the text mentions a "sale end date" or generic countdown. If it is a true auction, return the FULL date with the year anchored to today's calendar. Otherwise, return null.

For sellerType: return "dealer", "private", "auction", or null.

For sellerName: return the actual business or person name of the seller. Examples: "EchoPark Automotive", "Carvana", "BMW of Denver", "John Smith", "Bring a Trailer", "Dickensheet & Associates". Return null if not clearly identifiable.

For daysOnMarket: extract the number of days this specific listing has been live on the platform. Look for phrases like "Listed 18 days ago", "Posted 3 weeks ago", "Active since March 15", etc. Convert weeks/months to days. Return null if not found.`
      },
      {
        role: "user",
        content: `URL: ${url}\n\n${markdown.slice(0, 15000)}`
      }
    ],
    response_format: { type: "json_object" },
    temperature: 0,
  });

  const raw = JSON.parse(completion.choices[0].message.content ?? "{}");

  return {
    title:       raw.title       || null,
    year:        typeof raw.year      === "number" && raw.year > 1970 ? raw.year : null,
    make:        raw.make        || null,
    model:       raw.model       || null,
    trim:        raw.trim        || null,
    mileage:     typeof raw.mileage   === "number" && raw.mileage > 0 ? Math.round(raw.mileage) : null,
    price:       typeof raw.price === "number" && raw.price > 0 ? Math.round(raw.price) : null,
    location:    raw.location    || null,
    description: raw.description || null,
    ownerCount:  typeof raw.ownerCount === "number" ? raw.ownerCount : null,
    hasAccident: typeof raw.hasAccident === "boolean" ? raw.hasAccident : null,
    auctionEndDate: raw.auctionEndDate || null,
    sellerType: ['dealer','private','auction'].includes(raw.sellerType) ? raw.sellerType : null,
    sellerName: raw.sellerName || null,
    daysOnMarket: typeof raw.daysOnMarket === "number" && raw.daysOnMarket >= 0 ? Math.round(raw.daysOnMarket) : null,
  };
}

// ─── Tier 1: Jina Reader (fast, free, handles BaT / Cars.com / CarGurus) ──────
async function scrapeWithJina(url: string): Promise<string | null> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 20000);
  try {
    const res = await fetch(`https://r.jina.ai/${url}`, {
      method: "GET",
      signal: abort.signal,
      headers: { "Accept": "text/plain", "X-Return-Format": "markdown" }
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const md = await res.text();
    return md.length >= 200 ? md : null;
  } catch {
    clearTimeout(timer);
    return null;
  }
}

// ─── Tier 2: Firecrawl (headless Chrome — handles JS-rendered dealer sites) ───
async function scrapeWithFirecrawl(url: string): Promise<string | null> {
  if (!process.env.FIRECRAWL_API_KEY) return null;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 25000);
  try {
    const res = await fetch("https://api.firecrawl.dev/v1/scrape", {
      method: "POST",
      signal: abort.signal,
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.FIRECRAWL_API_KEY}`,
      },
      body: JSON.stringify({ url, formats: ["markdown"], onlyMainContent: true }),
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const data = await res.json();
    const md: string = data?.data?.markdown ?? data?.markdown ?? "";
    return md.length >= 200 ? md : null;
  } catch {
    clearTimeout(timer);
    return null;
  }
}

// ─── Main export ───────────────────────────────────────────────────────────────
export async function scrapeListingUrlFast(url: string): Promise<ListingIntel> {
  const empty: ListingIntel = {
    title: null, year: null, make: null, model: null, trim: null,
    mileage: null, price: null, location: null,
    ownerCount: null, hasAccident: null, description: null, auctionEndDate: null,
    sellerType: null, sellerName: null, daysOnMarket: null,
  };
  if (!url || !process.env.OPENAI_API_KEY) return empty;

  try {
    // ── Tier 1: Jina (fast path) ──────────────────────────────────────────────
    let markdown = await scrapeWithJina(url);
    let scraper = "Jina";

    if (markdown) {
      const intel = await extractWithGPT(url, markdown);
      if (intel.year && intel.make) {
        console.log(`[fastScrape] Jina+GPT → ${url.slice(0, 60)}: ${intel.year} ${intel.make} ${intel.model} | ${intel.mileage}mi | $${intel.price} | ${intel.location}`);
        return intel;
      }
      console.log(`[fastScrape] Jina got markdown but GPT found no vehicle — falling back to Firecrawl for ${url.slice(0, 60)}`);
    } else {
      console.log(`[fastScrape] Jina returned no content — falling back to Firecrawl for ${url.slice(0, 60)}`);
    }

    // ── Tier 2: Firecrawl (headless Chrome — JS-rendered dealer pages) ────────
    markdown = await scrapeWithFirecrawl(url);
    scraper = "Firecrawl";

    if (markdown) {
      const intel = await extractWithGPT(url, markdown);
      if (intel.year && intel.make) {
        console.log(`[fastScrape] Firecrawl+GPT → ${url.slice(0, 60)}: ${intel.year} ${intel.make} ${intel.model} | ${intel.mileage}mi | $${intel.price}`);
        return intel;
      }
    }

    // Both tiers failed
    console.warn(`[fastScrape] Both Jina and Firecrawl failed to extract vehicle data from ${url.slice(0, 60)}`);
    return empty;

  } catch (e) {
    console.warn(`[fastScrape] Fatal error for ${url.slice(0, 60)}:`, (e as Error).message);
    return empty;
  }
}
