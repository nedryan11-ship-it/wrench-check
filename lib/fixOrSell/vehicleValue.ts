// lib/fixOrSell/vehicleValue.ts
// Reusable vehicle value estimation for Fix or Sell engine.
//
// Strategy:
//   1. Marketcheck VIN-based prediction (best)
//   2. Marketcheck active listings segment median (good — same as scout engine)
//   3. GPT-4o-mini fallback (okay)
//
// Returns a private-party-adjusted value (what you'd actually get selling).

import OpenAI from "openai";

export interface VehicleValueEstimate {
  value: number;           // midpoint — "your car is worth roughly $X"
  rangeLow: number;
  rangeHigh: number;
  source: 'marketcheck' | 'marketcheck_listings' | 'ai_estimated';
  confidence: 'high' | 'medium' | 'low';
  compCount?: number;      // how many listings informed this
  methodology: string;     // human-readable explanation
}

interface VehicleInput {
  year: number;
  make: string;
  model: string;
  trim?: string;
  mileage: number;
  vin?: string;
}

// ── Private party discount ───────────────────────────────────────────────────
// Dealer listing prices are ~15-20% above what a private seller gets.
// Trade-in is even lower (~25-30% below listing). We use private party as the
// reference because that's the comparison point for "should I fix or sell."
const PRIVATE_PARTY_DISCOUNT = 0.83; // 17% below dealer listing

// ── 1. Marketcheck VIN-based prediction ──────────────────────────────────────

async function tryMarketcheckPredict(input: VehicleInput): Promise<VehicleValueEstimate | null> {
  const mcKey = process.env.MARKETCHECK_API_KEY;
  const mcSecret = process.env.MARKETCHECK_API_SECRET;
  if (!mcKey || !input.vin || input.vin.length !== 17) return null;

  try {
    const url = new URL("https://api.marketcheck.com/v2/predict/car/us/marketcheck_price");
    url.searchParams.set("api_key", mcKey);
    if (mcSecret) url.searchParams.set("api_secret", mcSecret);
    url.searchParams.set("vin", input.vin);
    url.searchParams.set("miles", String(input.mileage));
    url.searchParams.set("dealer_type", "franchise");
    url.searchParams.set("zip", "80218"); // Denver default
    url.searchParams.set("radius", "150");

    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 5000);
    const res = await fetch(url.toString(), { signal: abort.signal });
    clearTimeout(timer);

    if (!res.ok) return null;

    const data = await res.json();
    const dealerPrice: number | undefined = data?.marketcheck_price ?? data?.price ?? data?.predicted_price;
    if (!dealerPrice || dealerPrice <= 0) return null;

    // Apply private party discount
    const ppValue = Math.round(dealerPrice * PRIVATE_PARTY_DISCOUNT / 500) * 500;
    const low = Math.round(ppValue * 0.90 / 500) * 500;
    const high = Math.round(ppValue * 1.10 / 500) * 500;

    console.log(`[vehicleValue] Marketcheck predict: dealer=$${dealerPrice.toLocaleString()} → private=$${ppValue.toLocaleString()} (${low}-${high})`);

    return {
      value: ppValue,
      rangeLow: low,
      rangeHigh: high,
      source: 'marketcheck',
      confidence: 'high',
      methodology: `Based on Marketcheck VIN pricing for ${input.vin}, adjusted to private party value.`,
    };
  } catch {
    return null;
  }
}

// ── 2. Marketcheck active listings median ────────────────────────────────────

async function tryMarketcheckListings(input: VehicleInput): Promise<VehicleValueEstimate | null> {
  const mcKey = process.env.MARKETCHECK_API_KEY;
  const mcSecret = process.env.MARKETCHECK_API_SECRET;
  if (!mcKey) return null;

  // Model name normalization (same as scout engine)
  const MC_MODEL_MAP: Record<string, string> = {
    'lx 570': 'LX', 'lx600': 'LX', 'lx 600': 'LX',
    'gx 460': 'GX', 'gx460': 'GX', 'gx 550': 'GX',
    'rx 350': 'RX', 'land cruiser': 'Land Cruiser',
    '4runner': '4Runner', '4 runner': '4Runner',
  };
  const rawModel = input.model.toLowerCase().trim();
  const mcModel = MC_MODEL_MAP[rawModel]
    || rawModel.replace(/\s+\d{3,}$/, '').split(" ").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");

  try {
    const params = new URLSearchParams({
      api_key: mcKey,
      ...(mcSecret ? { api_secret: mcSecret } : {}),
      year: String(input.year),
      make: input.make.charAt(0).toUpperCase() + input.make.slice(1).toLowerCase(),
      model: mcModel,
      rows: "50",
      start: "0",
    });

    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 8000);
    const res = await fetch(`https://api.marketcheck.com/v2/search/car/active?${params}`, { signal: abort.signal });
    clearTimeout(timer);

    if (!res.ok) return null;
    const data = await res.json();
    const listings = data.listings || [];
    if (listings.length < 2) return null;

    // Filter to similar mileage band (±30k)
    const mileMin = Math.max(0, input.mileage - 30000);
    const mileMax = input.mileage + 30000;
    let prices = listings
      .filter((l: any) => l.miles >= mileMin && l.miles <= mileMax && l.price > 0)
      .map((l: any) => l.price);

    // If not enough in mileage band, use all
    if (prices.length < 3) {
      prices = listings.filter((l: any) => l.price > 0).map((l: any) => l.price);
    }

    if (prices.length < 2) return null;

    prices.sort((a: number, b: number) => a - b);
    const mid = Math.floor(prices.length / 2);
    const dealerMedian = prices.length % 2 ? prices[mid] : Math.round((prices[mid - 1] + prices[mid]) / 2);

    // Private party adjustment
    const ppValue = Math.round(dealerMedian * PRIVATE_PARTY_DISCOUNT / 500) * 500;
    const low = Math.round(ppValue * 0.88 / 500) * 500;
    const high = Math.round(ppValue * 1.12 / 500) * 500;

    console.log(`[vehicleValue] Marketcheck listings: ${prices.length} comps, dealer median=$${dealerMedian.toLocaleString()} → private=$${ppValue.toLocaleString()}`);

    return {
      value: ppValue,
      rangeLow: low,
      rangeHigh: high,
      source: 'marketcheck_listings',
      confidence: prices.length >= 5 ? 'high' : 'medium',
      compCount: prices.length,
      methodology: `Based on ${prices.length} similar ${input.year} ${input.make} ${input.model} listings, adjusted to private party value.`,
    };
  } catch {
    return null;
  }
}

// ── 3. GPT fallback ──────────────────────────────────────────────────────────

async function tryGptEstimate(input: VehicleInput): Promise<VehicleValueEstimate | null> {
  const desc = [input.year, input.make, input.model, input.trim].filter(Boolean).join(" ");

  try {
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 12000);

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{
        role: "user",
        content: `What is the current PRIVATE PARTY market value for a ${desc} with ${input.mileage.toLocaleString()} miles in the US?\n\nRespond with ONLY JSON:\n{"low": <number>, "high": <number>}\n\nUse realistic 2024-2025 private party values. Round to nearest $500. This is what the OWNER would get selling privately, NOT dealer retail.`,
      }],
      max_tokens: 80,
      temperature: 0.1,
      response_format: { type: "json_object" },
    }, { signal: abort.signal });

    clearTimeout(timer);

    const raw = JSON.parse(completion.choices[0].message.content ?? "{}");
    if (typeof raw.low !== "number" || typeof raw.high !== "number") return null;

    const value = Math.round((raw.low + raw.high) / 2 / 500) * 500;
    console.log(`[vehicleValue] GPT estimate: ${desc} → $${raw.low.toLocaleString()}-$${raw.high.toLocaleString()}`);

    return {
      value,
      rangeLow: raw.low,
      rangeHigh: raw.high,
      source: 'ai_estimated',
      confidence: 'low',
      methodology: `AI estimate for a ${desc} with ${input.mileage.toLocaleString()} miles. Actual value may vary ±15%.`,
    };
  } catch {
    return null;
  }
}

// ── Main export ──────────────────────────────────────────────────────────────

export async function estimateVehicleValue(input: VehicleInput): Promise<VehicleValueEstimate | null> {
  console.log(`[vehicleValue] Estimating value for ${input.year} ${input.make} ${input.model} @ ${input.mileage.toLocaleString()}mi`);

  // Try sources in order of quality
  const vinEstimate = await tryMarketcheckPredict(input);
  if (vinEstimate) return vinEstimate;

  const listingEstimate = await tryMarketcheckListings(input);
  if (listingEstimate) return listingEstimate;

  const gptEstimate = await tryGptEstimate(input);
  if (gptEstimate) return gptEstimate;

  console.warn(`[vehicleValue] All sources failed for ${input.year} ${input.make} ${input.model}`);
  return null;
}
