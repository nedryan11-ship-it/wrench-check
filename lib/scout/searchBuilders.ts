// lib/scout/searchBuilders.ts
// Builds search URLs for tier-1 sources and parses listing URLs from results.
// Sources: Cars.com (Jina-accessible), BaT RSS feed (free, no scraping), CarGurus.
// NOT included: AutoTrader (blocks Jina), FB Marketplace, Craigslist (need proxy infra).

export interface ScoutConfig {
  id: string;
  make: string;
  model?: string | null;
  year_min?: number | null;
  year_max?: number | null;
  price_max?: number | null;
  mileage_max?: number | null;
  radius_miles?: number | null;
  sources: string[];
}

// ── Transit Effort: Denver CO 80220 (Hilltop) as origin ───────────────────────
/** Returns transit level 1–5 + labels based on listing location string. */
export function computeTransitFromDenver(location: string | null): {
  level: number;
  label: string;
  emoji: string;
  flyEstimate: string | null;
  driveHours: string | null;
  shipEstimate: string | null;
} {
  if (!location) return { level: 3, label: "Unknown", emoji: "❓", flyEstimate: null, driveHours: null, shipEstimate: null };

  const loc = location.toLowerCase();

  // Level 1 — Local (CO)
  if (/\bco\b|colorado/.test(loc)) {
    return { level: 1, label: "Local", emoji: "🟢", flyEstimate: null, driveHours: "1–4 hr drive", shipEstimate: null };
  }
  // Level 2 — Short Haul (nearby states, 4–8 hr drive)
  if (/\bwy\b|wyoming|nebraska|\bne\b|kansas|\bks\b|new mexico|\bnm\b|\but\b|utah|\baz\b|arizona/.test(loc)) {
    return { level: 2, label: "Short Haul", emoji: "🟡", flyEstimate: null, driveHours: "4–8 hr drive", shipEstimate: "~$650 shipped" };
  }
  // Level 3 — Mid-Haul (1 day drive or cheap flight)
  if (/texas|\btx\b|montana|\bmt\b|south dakota|\bsd\b|idaho|\bid\b|nevada|\bnv\b|oklahoma|\bok\b/.test(loc)) {
    return { level: 3, label: "Mid-Haul", emoji: "🟠", flyEstimate: "Fly ~$180–280", driveHours: "8–14 hr drive", shipEstimate: "~$900 shipped" };
  }
  // Level 4 — Long Haul (flight strongly recommended)
  if (/california|\bca\b|oregon|\bor\b|washington|\bwa\b|minnesota|\bmn\b|iowa|\bia\b|missouri|\bmo\b|arkansas|\bar\b|louisiana|\bla\b/.test(loc)) {
    return { level: 4, label: "Long Haul", emoji: "🔴", flyEstimate: "Fly ~$250–400 + rental", driveHours: "15–24 hr drive", shipEstimate: "~$1,100 shipped" };
  }
  // Level 5 — Cross Country
  return { level: 5, label: "Cross Country", emoji: "🔴", flyEstimate: "Fly ~$300–550", driveHours: "24–36 hr drive", shipEstimate: "~$1,400–1,800 shipped" };
}

// ── Cars.com search URL builder ────────────────────────────────────────────────
export function buildCarsDotComUrl(config: ScoutConfig): string {
  const base = "https://www.cars.com/shopping/results/";
  const params = new URLSearchParams();
  params.set("stock_type", "used");
  params.set("zip", "80220"); // Denver/Hilltop
  params.set("maximum_distance", String(config.radius_miles ?? 500));

  if (config.make) {
    const makeSlug = config.make.toLowerCase().replace(/\s+/g, "-");
    params.set("makes[]", makeSlug);
    if (config.model) {
      const modelSlug = config.model.toLowerCase().replace(/\s+/g, "-");
      params.set("models[]", `${makeSlug}-${modelSlug}`);
    }
  }
  if (config.year_min) params.set("list_price_min", "");
  if (config.year_max) params.set("maximum_year", String(config.year_max));
  if (config.year_min) params.set("minimum_year", String(config.year_min));
  if (config.price_max) params.set("price_max", String(config.price_max));
  if (config.mileage_max) params.set("maximum_mileage", String(config.mileage_max));
  params.set("sort", "best_match_desc");
  params.set("per_page", "20");

  return `${base}?${params.toString()}`;
}

// ── CarGurus search URL builder ────────────────────────────────────────────────
export function buildCarGurusUrl(config: ScoutConfig): string {
  const params = new URLSearchParams();
  if (config.make) params.set("filterByName", `${config.make} ${config.model ?? ""}`.trim());
  if (config.price_max) params.set("maxPrice", String(config.price_max));
  if (config.year_min) params.set("startYear", String(config.year_min));
  if (config.year_max) params.set("endYear", String(config.year_max));
  if (config.mileage_max) params.set("maxMileage", String(config.mileage_max));
  params.set("zip", "80220");
  params.set("distance", String(config.radius_miles ?? 500));
  return `https://www.cargurus.com/Cars/new/nl#listing=searchResults;zip=80220;${params.toString()}`;
}

// ── Bring a Trailer RSS parser ─────────────────────────────────────────────────
// BaT has a public RSS feed — no scraping needed, no API key required.
export async function fetchBaTLeads(config: ScoutConfig): Promise<{ url: string; title: string; price: number | null }[]> {
  try {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 10000);
    const res = await fetch("https://bringatrailer.com/feed/", { signal: abort.signal });
    clearTimeout(timer);
    if (!res.ok) return [];
    const xml = await res.text();

    // Parse items from RSS XML
    const items: { url: string; title: string; price: number | null }[] = [];
    const itemMatches = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)];

    for (const m of itemMatches) {
      const itemXml = m[1];
      const titleMatch = itemXml.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/) || itemXml.match(/<title>(.*?)<\/title>/);
      const linkMatch = itemXml.match(/<link>(.*?)<\/link>/);
      const descMatch = itemXml.match(/<description><!\[CDATA\[(.*?)\]\]><\/description>/);

      if (!titleMatch || !linkMatch) continue;
      const title = titleMatch[1].trim();
      const url = linkMatch[1].trim();

      // Filter by make/model from config
      const titleLower = title.toLowerCase();
      const makeMatch = config.make && titleLower.includes(config.make.toLowerCase());
      const modelMatch = !config.model || titleLower.includes((config.model || "").toLowerCase());

      if (!makeMatch || !modelMatch) continue;

      // Try to extract price from description
      let price: number | null = null;
      const prDesc = descMatch?.[1] ?? "";
      const priceMatch = prDesc.match(/\$([0-9,]+)/);
      if (priceMatch) {
        price = parseInt(priceMatch[1].replace(/,/g, ""), 10) || null;
      }
      if (config.price_max && price && price > config.price_max) continue;

      items.push({ url, title, price });
    }

    return items.slice(0, 10);
  } catch {
    return [];
  }
}

// ── Extract listing URLs from scraped search result markdown ──────────────────
export function extractListingUrls(markdown: string, source: "cars.com" | "cargurus"): string[] {
  const patterns: Record<string, RegExp> = {
    "cars.com": /https?:\/\/www\.cars\.com\/vehicledetail\/[a-zA-Z0-9\-]+\//g,
    "cargurus": /https?:\/\/www\.cargurus\.com\/Cars\/new\/nl#listing=[a-zA-Z0-9]+/g,
  };
  const pattern = patterns[source];
  if (!pattern) return [];
  const matches = [...markdown.matchAll(new RegExp(pattern.source, pattern.flags))];
  return [...new Set(matches.map((m) => m[0]))].slice(0, 15);
}

// ── Jina-based markdown fetch ─────────────────────────────────────────────────
export async function fetchSearchMarkdown(url: string): Promise<string | null> {
  if (!process.env.FIRECRAWL_API_KEY) {
    // Fallback: Jina reader
    try {
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), 20000);
      const res = await fetch(`https://r.jina.ai/${url}`, {
        signal: abort.signal,
        headers: { Accept: "text/plain", "X-Return-Format": "text" },
      });
      clearTimeout(timer);
      return res.ok ? await res.text() : null;
    } catch {
      return null;
    }
  }

  // Firecrawl preferred
  try {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 20000);
    const res = await fetch("https://api.firecrawl.dev/v1/scrape", {
      method: "POST",
      signal: abort.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.FIRECRAWL_API_KEY}`,
      },
      body: JSON.stringify({ url, formats: ["markdown"], onlyMainContent: true }),
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const data = await res.json();
    return data?.data?.markdown ?? null;
  } catch {
    return null;
  }
}

// ── Cars & Bids RSS parser ────────────────────────────────────────────────────
// CarsAndBids.com has a public RSS feed — same approach as BaT.
export async function fetchCarsAndBidsLeads(config: ScoutConfig): Promise<{ url: string; title: string; price: number | null }[]> {
  try {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 10000);
    const res = await fetch("https://carsandbids.com/rss/", { signal: abort.signal });
    clearTimeout(timer);
    if (!res.ok) {
      // Fallback: try their auctions page via Jina
      return await fetchCarsAndBidsViaJina(config);
    }
    const xml = await res.text();
    return parseCarsAndBidsRss(xml, config);
  } catch {
    // Fallback to Jina scrape
    return await fetchCarsAndBidsViaJina(config);
  }
}

function parseCarsAndBidsRss(xml: string, config: ScoutConfig): { url: string; title: string; price: number | null }[] {
  const items: { url: string; title: string; price: number | null }[] = [];
  const itemMatches = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)];

  for (const m of itemMatches) {
    const itemXml = m[1];
    const titleMatch = itemXml.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/) || itemXml.match(/<title>(.*?)<\/title>/);
    const linkMatch = itemXml.match(/<link>(.*?)<\/link>/);
    const descMatch = itemXml.match(/<description><!\[CDATA\[(.*?)\]\]><\/description>/);

    if (!titleMatch || !linkMatch) continue;
    const title = titleMatch[1].trim();
    const url = linkMatch[1].trim();

    // Filter by make/model
    const titleLower = title.toLowerCase();
    const makeMatch = config.make && titleLower.includes(config.make.toLowerCase());
    const modelMatch = !config.model || titleLower.includes((config.model || "").toLowerCase());
    if (!makeMatch || !modelMatch) continue;

    // Year filter
    const yearMatch = title.match(/\b(19|20)\d{2}\b/);
    if (yearMatch) {
      const yr = parseInt(yearMatch[0], 10);
      if (config.year_min && yr < config.year_min) continue;
      if (config.year_max && yr > config.year_max) continue;
    }

    // Price extraction
    let price: number | null = null;
    const prDesc = descMatch?.[1] ?? "";
    const priceMatch = prDesc.match(/\$([0-9,]+)/);
    if (priceMatch) {
      price = parseInt(priceMatch[1].replace(/,/g, ""), 10) || null;
    }
    if (config.price_max && price && price > config.price_max) continue;

    items.push({ url, title, price });
  }
  return items.slice(0, 10);
}

async function fetchCarsAndBidsViaJina(config: ScoutConfig): Promise<{ url: string; title: string; price: number | null }[]> {
  try {
    const searchTerm = `${config.make} ${config.model || ""}`.trim().toLowerCase();
    const md = await fetchSearchMarkdown(`https://carsandbids.com/search?q=${encodeURIComponent(searchTerm)}`);
    if (!md) return [];

    const items: { url: string; title: string; price: number | null }[] = [];
    // Extract auction URLs from markdown
    const urlMatches = [...md.matchAll(/https?:\/\/carsandbids\.com\/auctions\/[a-zA-Z0-9\-]+/g)];
    const uniqueUrls = [...new Set(urlMatches.map(m => m[0]))];

    for (const url of uniqueUrls.slice(0, 10)) {
      // Extract title from the surrounding markdown context
      const idx = md.indexOf(url);
      const context = md.slice(Math.max(0, idx - 200), idx + 10);
      const titleMatch = context.match(/\[(.*?)\]/);
      const title = titleMatch?.[1] ?? url.split("/").pop()?.replace(/-/g, " ") ?? "";

      // Filter by make/model
      const titleLower = title.toLowerCase();
      if (!titleLower.includes(config.make.toLowerCase())) continue;
      if (config.model && !titleLower.includes(config.model.toLowerCase())) continue;

      // Price extraction
      let price: number | null = null;
      const priceMatch = context.match(/\$([0-9,]+)/);
      if (priceMatch) price = parseInt(priceMatch[1].replace(/,/g, ""), 10) || null;

      items.push({ url, title, price });
    }
    return items;
  } catch {
    return [];
  }
}

// ── ih8mud Classifieds scraper ─────────────────────────────────────────────────
// Scrapes the ih8mud.com forum classifieds via Jina/Firecrawl.
// Forum structure: each Land Cruiser generation has its own classifieds subforum.
const IH8MUD_FORUMS: Record<string, string> = {
  "100": "https://forum.ih8mud.com/forums/100-series-classifieds.7/",
  "200": "https://forum.ih8mud.com/forums/200-series-classifieds.160/",
  "80":  "https://forum.ih8mud.com/forums/80-series-classifieds.6/",
  "lx":  "https://forum.ih8mud.com/forums/lx-470-lx-570-classifieds.113/",
};

export async function fetchIh8mudLeads(config: ScoutConfig): Promise<{ url: string; title: string; price: number | null }[]> {
  // Determine which forum(s) to scrape based on year range
  const forumUrls: string[] = [];
  const yearMin = config.year_min ?? 1990;
  const yearMax = config.year_max ?? 2025;
  const model = (config.model || "").toLowerCase();

  // Map year ranges to series
  if (model.includes("land cruiser") || model.includes("lc")) {
    if (yearMax >= 2008) forumUrls.push(IH8MUD_FORUMS["200"]);
    if ((yearMin <= 2007 && yearMax >= 1998) || !config.year_min) forumUrls.push(IH8MUD_FORUMS["100"]);
    if (yearMin <= 1997 && yearMax >= 1990) forumUrls.push(IH8MUD_FORUMS["80"]);
  }
  if (model.includes("lx")) {
    forumUrls.push(IH8MUD_FORUMS["lx"]);
  }
  // Default: scrape 100 and 200 series
  if (forumUrls.length === 0) {
    forumUrls.push(IH8MUD_FORUMS["200"], IH8MUD_FORUMS["100"]);
  }

  const allLeads: { url: string; title: string; price: number | null }[] = [];

  for (const forumUrl of forumUrls) {
    try {
      const md = await fetchSearchMarkdown(forumUrl);
      if (!md) continue;

      // Parse thread links from the forum page markdown
      // ih8mud thread URLs look like: https://forum.ih8mud.com/threads/some-title.12345/
      const threadMatches = [...md.matchAll(/https?:\/\/forum\.ih8mud\.com\/threads\/[a-zA-Z0-9\-]+\.\d+\//g)];
      const uniqueUrls = [...new Set(threadMatches.map(m => m[0]))];

      for (const threadUrl of uniqueUrls.slice(0, 8)) {
        // Extract title context from markdown
        const idx = md.indexOf(threadUrl);
        const context = md.slice(Math.max(0, idx - 300), idx + 50);

        // Try to extract title from markdown link syntax [title](url)
        const titleMatch = context.match(/\[([^\]]{10,})\]\s*\(/);
        const title = titleMatch?.[1] ?? threadUrl.split("/threads/")[1]?.replace(/\.\d+\/$/, "").replace(/-/g, " ") ?? "";
        const titleLower = title.toLowerCase();

        // Filter: must mention "sale", "selling", "fs", or contain a price
        const isSale = /\b(fs|for sale|sell|selling|wts|price drop)\b/i.test(titleLower);
        const hasPrice = /\$\s?[0-9,]+/.test(title) || /\$\s?[0-9,]+/.test(context);
        if (!isSale && !hasPrice) continue;

        // Skip obvious non-sales (WTB, ISO, trade)
        if (/\b(wtb|want to buy|iso|looking for|trade only)\b/i.test(titleLower)) continue;

        // Year filter
        const yearMatch = title.match(/\b(19|20)\d{2}\b/);
        if (yearMatch) {
          const yr = parseInt(yearMatch[0], 10);
          if (config.year_min && yr < config.year_min) continue;
          if (config.year_max && yr > config.year_max) continue;
        }

        // Price extraction
        let price: number | null = null;
        const priceMatch = (title + " " + context).match(/\$\s?([0-9,]+)/);
        if (priceMatch) {
          price = parseInt(priceMatch[1].replace(/,/g, ""), 10) || null;
        }
        if (config.price_max && price && price > config.price_max) continue;

        allLeads.push({ url: threadUrl, title: title.slice(0, 120), price });
      }
    } catch (e) {
      console.warn(`[scout] ih8mud scrape failed for ${forumUrl}:`, e);
    }
  }

  return allLeads;
}
