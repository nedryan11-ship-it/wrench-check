// lib/maintenanceDebt/pricingEngine.ts
//
// Structured pricing layer for maintenance debt estimates.
//
// Pipeline:
//   1. VDB repair estimates (keyed by canonical via serviceMappings) — primary source
//   2. Structured adjustments (region, vehicle class, shop type)
//   3. OpenAI fallback for any canonical service with no VDB pricing
//
// Output: canonical service → { low, high } adjusted cost range

import OpenAI from "openai";
import type { ServiceCostEstimate, MaintenanceDebtItem, VehicleIdentity } from "./types";

// ─── Adjustment config ────────────────────────────────────────────────────────

// VDB uses a $55/hr base labor rate — far below real-world rates.
// These multipliers bring raw VDB numbers to realistic shop-rate ranges.

const REGION_MULTIPLIER: Record<string, number> = {
  high:   3.5,   // Denver, SF, NYC, Seattle, LA
  medium: 3.0,   // National average
  low:    2.5,   // Rural / low-cost markets
};

const VEHICLE_CLASS_FACTOR: Record<string, number> = {
  luxury:   1.25,  // European, Japanese luxury (Land Cruiser, Lexus, BMW, Mercedes)
  standard: 1.00,  // Mid-range domestic / import
  economy:  0.85,  // Budget-tier vehicles
};

const SHOP_TYPE_FACTOR: Record<string, number> = {
  dealer:      1.40,  // Franchised dealers run highest labor rates
  independent: 1.00,  // Independent shop baseline
  chain:       0.90,  // Quick-lube/chain shops (lower for routine services)
};

// ─── Vehicle class heuristic ──────────────────────────────────────────────────

const LUXURY_MAKES = new Set([
  "acura", "bentley", "bmw", "cadillac", "ferrari", "genesis", "infiniti",
  "jaguar", "lamborghini", "land rover", "lexus", "lincoln", "maserati",
  "mbw", "mercedes", "mercedes-benz", "porsche", "rolls-royce", "volvo",
]);

const LUXURY_MODELS = new Set([
  "land cruiser", "gx", "lx", "4runner trd pro", "tundra trd pro",
  "f-250", "f-350", "ram 2500", "ram 3500", "sierra denali", "silverado high country",
]);

function inferVehicleClass(vehicle: Partial<VehicleIdentity>): "luxury" | "standard" | "economy" {
  const make = (vehicle.make ?? "").toLowerCase();
  const model = (vehicle.model ?? "").toLowerCase();

  if (LUXURY_MAKES.has(make)) return "luxury";
  if (LUXURY_MODELS.has(model)) return "luxury";
  if (make === "toyota" && (model.includes("land cruiser") || model.includes("sequoia") || model.includes("tundra"))) return "luxury";

  return "standard";
}

// ─── Public context type ──────────────────────────────────────────────────────

export interface PricingContext {
  region?: "high" | "medium" | "low";
  shopType?: "dealer" | "independent" | "chain";
  vehicleClass?: "luxury" | "standard" | "economy";
}

// ─── Apply adjustments to a raw VDB cost ─────────────────────────────────────

function adjustCost(
  rawCost: number,
  context: Required<PricingContext>
): { low: number; high: number } {
  const regionMult = REGION_MULTIPLIER[context.region];
  const vehicleFactor = VEHICLE_CLASS_FACTOR[context.vehicleClass];
  const shopFactor = SHOP_TYPE_FACTOR[context.shopType];

  const adjusted = rawCost * regionMult * vehicleFactor;
  // Low = independent shop rate, High = dealer rate (always show the range)
  const low = Math.round(adjusted * SHOP_TYPE_FACTOR.independent);
  const high = Math.round(adjusted * SHOP_TYPE_FACTOR.dealer);

  // Ignore shopFactor in the range — always show independent-to-dealer spread
  return { low, high };

  void shopFactor; // context.shopType used for display, not calculation here
}

// ─── AI fallback for missing pricing ─────────────────────────────────────────

async function estimatePricingFromAI(
  services: string[],
  vehicle: Partial<VehicleIdentity>,
  context: Required<PricingContext>
): Promise<Record<string, { low: number; high: number }>> {
  if (services.length === 0) return {};

  const vehicleDesc = [vehicle.year, vehicle.make, vehicle.model].filter(Boolean).join(" ");
  const regionDesc = context.region === "high" ? "high cost-of-living metro" : context.region === "low" ? "rural / low-cost" : "average US";
  const shopDesc = context.shopType === "dealer" ? "dealer" : context.shopType === "chain" ? "chain shop" : "independent shop";

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const prompt = `Estimate realistic shop prices for the following maintenance services on a ${vehicleDesc || "vehicle"}.
Region: ${regionDesc} market.
Shop type: ${shopDesc}.

Return ONLY a JSON object where keys are the service names and values are objects with { "low": number, "high": number } representing the realistic price range in USD including parts and labor.

Services to estimate:
${services.map(s => `- ${s}`).join("\n")}

Example format: { "Replace Engine Oil & Filter": { "low": 75, "high": 140 } }`;

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 800,
      temperature: 0.1,
      response_format: { type: "json_object" },
    });

    const raw = completion.choices[0].message.content ?? "{}";
    const parsed = JSON.parse(raw) as Record<string, { low: number; high: number }>;
    return parsed;
  } catch {
    return {};
  }
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Apply structured pricing adjustments to VDB estimates.
 * Falls back to OpenAI for any service with no VDB coverage.
 *
 * @param vdbEstimates   - Already canonical-keyed map from repairEstimates.ts
 * @param debtItems      - Items needing pricing (overdue + due_now)
 * @param vehicle        - For vehicle class inference
 * @param context        - Optional region / shopType overrides
 * @returns              - Updated debtItems with adjusted estimatedCostLow/High
 */
export async function applyPricingToDebtItems(
  vdbEstimates: Record<string, ServiceCostEstimate>,
  debtItems: MaintenanceDebtItem[],
  vehicle: Partial<VehicleIdentity>,
  context: PricingContext = {}
): Promise<MaintenanceDebtItem[]> {

  // Resolve context defaults
  const resolvedContext: Required<PricingContext> = {
    region: context.region ?? "medium",
    shopType: context.shopType ?? "independent",
    vehicleClass: context.vehicleClass ?? inferVehicleClass(vehicle),
  };

  const needsAIFallback: string[] = [];
  const priced: MaintenanceDebtItem[] = [];

  for (const item of debtItems) {
    const vdb = vdbEstimates[item.canonicalService];

    if (vdb?.estimateLow != null) {
      // VDB has a raw estimate — apply structured adjustment
      const adjusted = adjustCost(vdb.estimateLow, resolvedContext);
      priced.push({
        ...item,
        estimatedCostLow: adjusted.low,
        estimatedCostHigh: adjusted.high,
      });
    } else {
      // No VDB pricing — queue for AI fallback
      needsAIFallback.push(item.canonicalService);
      priced.push(item); // will be updated after AI call
    }
  }

  // AI fallback for missing prices
  if (needsAIFallback.length > 0) {
    const aiPrices = await estimatePricingFromAI(
      needsAIFallback,
      vehicle,
      resolvedContext
    );

    for (const item of priced) {
      if (item.estimatedCostLow == null && aiPrices[item.canonicalService]) {
        const ai = aiPrices[item.canonicalService];
        // Assign with a small premium over VDB AI estimates to be conservative
        item.estimatedCostLow = ai.low ?? null;
        item.estimatedCostHigh = ai.high ?? null;
      }
    }
  }

  return priced;
}

// ─── Helper: aggregate total debt from priced items ────────────────────────────

export function aggregateDebt(items: MaintenanceDebtItem[]): {
  debtEstimateLow: number | null;
  debtEstimateHigh: number | null;
} {
  const itemsWithPricing = items.filter(
    i => (i.status === "overdue" || i.status === "due_now") && i.estimatedCostLow != null
  );

  if (itemsWithPricing.length === 0) return { debtEstimateLow: null, debtEstimateHigh: null };

  const low = itemsWithPricing.reduce((s, i) => s + (i.estimatedCostLow ?? 0), 0);
  const high = itemsWithPricing.reduce((s, i) => s + (i.estimatedCostHigh ?? i.estimatedCostLow ?? 0), 0);

  return {
    debtEstimateLow: Math.round(low),
    debtEstimateHigh: Math.round(high),
  };
}


