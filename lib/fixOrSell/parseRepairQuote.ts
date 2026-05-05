// lib/fixOrSell/parseRepairQuote.ts
// Extracts structured repair items from raw text (PDF, image OCR, or pasted text).
// Returns line items with costs, categories, and optionally the vehicle info.

import OpenAI from "openai";
import type { ParsedRepairItem, RepairCategory } from "./engine";

export interface ParsedRepairQuote {
  shopName: string | null;
  items: ParsedRepairItem[];
  totalCost: number;
  vehicleFromQuote: {
    year?: number;
    make?: string;
    model?: string;
    trim?: string;
    mileage?: number;
    vin?: string;
  } | null;
  rawItemCount: number;
}

const CATEGORY_KEYWORDS: Record<RepairCategory, RegExp> = {
  routine: /oil change|oil filter|air filter|cabin filter|brake pad|brake rotor|brake fluid|fluid flush|coolant|transmission fluid|power steering|wiper|tire rotation|alignment|spark plug|belt|serpentine|valve adjustment/i,
  drivetrain: /engine|transmission|rebuild|torque converter|head gasket|timing chain|timing belt|turbo|supercharger|differential|transfer case|clutch|flywheel|cv joint|cv axle|driveshaft|motor mount/i,
  safety: /brake caliper|brake line|abs|airbag|seatbelt|steering rack|tie rod|ball joint|control arm|wheel bearing|suspension|strut|shock|stabilizer|sway bar/i,
  electrical: /battery|alternator|starter|wiring|fuse|sensor|ecu|module|relay|ignition|coil pack/i,
  body: /paint|body|bumper|fender|door|windshield|window|mirror|headlight|taillight|rust|undercoat/i,
  other: /diagnostic|inspection|shop supplies|misc|labor|disposal|tax|fee/i,
};

function classifyCategory(description: string): RepairCategory {
  for (const [cat, regex] of Object.entries(CATEGORY_KEYWORDS)) {
    if (regex.test(description)) return cat as RepairCategory;
  }
  return 'other';
}

export async function parseRepairQuote(text: string): Promise<ParsedRepairQuote> {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const prompt = `You are parsing a vehicle repair estimate / quote. Extract every line item with its cost.

INPUT TEXT:
${text.slice(0, 6000)}

Respond ONLY with this JSON (no markdown):
{
  "shopName": "<shop name or null>",
  "vehicle": {
    "year": <number or null>,
    "make": "<string or null>",
    "model": "<string or null>",
    "trim": "<string or null>",
    "mileage": <number or null>,
    "vin": "<string or null>"
  },
  "items": [
    {"description": "<service/part description>", "cost": <number, dollars>}
  ],
  "totalCost": <number — use the document's total if shown, otherwise sum items>
}

Rules:
- Extract EVERY priced line item from the estimate
- Combine parts + labor for the same service into one line
- If a line says "Labor: $X" with no service name, attach it to the previous service
- Shop supplies, disposal fees, and taxes → include as separate items
- If no vehicle info is found, set vehicle to null
- Costs must be numbers (not strings). $1,234.56 → 1234.56
- If the text doesn't look like a repair estimate, return items: [] and totalCost: 0`;

  try {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 20000);

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 2000,
      temperature: 0.1,
      response_format: { type: "json_object" },
    }, { signal: abort.signal });

    clearTimeout(timer);

    const raw = JSON.parse(completion.choices[0].message.content ?? "{}");

    const items: ParsedRepairItem[] = (raw.items || []).map((item: any) => ({
      description: item.description || "Unknown service",
      cost: typeof item.cost === "number" ? item.cost : parseFloat(item.cost) || 0,
      category: classifyCategory(item.description || ""),
      fairPriceRange: null,
      isFair: null,
    }));

    const totalCost = typeof raw.totalCost === "number"
      ? raw.totalCost
      : items.reduce((sum, i) => sum + i.cost, 0);

    const vehicle = raw.vehicle && (raw.vehicle.year || raw.vehicle.make || raw.vehicle.vin)
      ? {
          year: raw.vehicle.year || undefined,
          make: raw.vehicle.make || undefined,
          model: raw.vehicle.model || undefined,
          trim: raw.vehicle.trim || undefined,
          mileage: raw.vehicle.mileage || undefined,
          vin: raw.vehicle.vin || undefined,
        }
      : null;

    console.log(`[parseRepairQuote] Extracted ${items.length} items, total=$${totalCost.toLocaleString()}, shop=${raw.shopName || 'unknown'}, vehicle=${vehicle ? `${vehicle.year} ${vehicle.make} ${vehicle.model}` : 'not found'}`);

    return {
      shopName: raw.shopName || null,
      items,
      totalCost,
      vehicleFromQuote: vehicle,
      rawItemCount: items.length,
    };
  } catch (err) {
    console.error("[parseRepairQuote] Failed:", (err as Error).message);
    return {
      shopName: null,
      items: [],
      totalCost: 0,
      vehicleFromQuote: null,
      rawItemCount: 0,
    };
  }
}

// ── Fair price estimation (enriches parsed items) ────────────────────────────

export async function enrichWithFairPrices(
  items: ParsedRepairItem[],
  vehicleDesc: string,
): Promise<ParsedRepairItem[]> {
  if (items.length === 0) return items;

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const itemList = items.map((item, i) =>
    `${i + 1}. ${item.description} — quoted $${item.cost.toFixed(2)}`
  ).join("\n");

  const prompt = `For each repair item below on a ${vehicleDesc}, provide a fair price range.

${itemList}

Respond ONLY with JSON:
{
  "items": [
    {"index": 1, "fairLow": <number>, "fairHigh": <number>, "isFair": <boolean — true if quoted price is within fair range>}
  ]
}

Rules:
- Use national average shop rates ($120-150/hr labor)
- Include both parts and labor in fair range
- Be generous — ±20% is "fair"
- Shop supplies and taxes are always "fair"
- Base prices on the specific vehicle (${vehicleDesc})`;

  try {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 15000);

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 1000,
      temperature: 0.1,
      response_format: { type: "json_object" },
    }, { signal: abort.signal });

    clearTimeout(timer);

    const raw = JSON.parse(completion.choices[0].message.content ?? "{}");
    const priceData = raw.items || [];

    return items.map((item, i) => {
      const match = priceData.find((p: any) => p.index === i + 1);
      if (!match) return item;
      return {
        ...item,
        fairPriceRange: { low: match.fairLow, high: match.fairHigh },
        isFair: match.isFair ?? (item.cost <= match.fairHigh * 1.1),
      };
    });
  } catch {
    console.warn("[enrichWithFairPrices] Failed — returning items without fair prices");
    return items;
  }
}
