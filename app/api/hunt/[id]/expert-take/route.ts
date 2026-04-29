// app/api/hunt/[id]/expert-take/route.ts
// Generates a high-quality Expert Take using GPT-4o with full vehicle context.
// Called on card expand when the stored take is missing or fallback.
// Also called with force=true to regenerate regardless.

import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import OpenAI from "openai";
import { fetchMarketComps } from "@/lib/vehicleDatabases/marketComps";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const FALLBACK_PATTERNS = /^analysis complete|^review physical|^no issues|^looks good|evaluated by our AI/i;

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const vehicleId = (await params).id;
  const body = await req.json().catch(() => ({}));
  const forceRegen = body?.force === true;

  const { data: v, error } = await supabaseAdmin
    .from("watchlist_vehicles")
    .select("*")
    .eq("id", vehicleId)
    .single();

  if (error || !v) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Parse packed audit JSON
  let aiData: any = null;
  const rawStr = v.description?.split("__WRENCH_AUDIT_JSON__")?.[1];
  if (rawStr) { try { aiData = JSON.parse(rawStr); } catch {} }

  const mi = aiData?.modelInsights || aiData;
  const existingTake: string = mi?.expertTake || aiData?.expertTake || aiData?.verdict || "";

  // Skip regen if the existing take is already good, unless forced
  if (!forceRegen && existingTake && existingTake.length > 80 && !FALLBACK_PATTERNS.test(existingTake.trim())) {
    return NextResponse.json({ expertTake: existingTake, regenerated: false });
  }

  // ── Build rich context for GPT-4o ──────────────────────────────────────────
  const watchouts: any[] = mi?.watchouts || aiData?.watchouts || [];
  const repairs: any[] = mi?.majorExposures || aiData?.majorExposures || aiData?.repairs || [];
  const tco = mi?.tco || aiData?.tco || null;
  const reliabilityTier: string = mi?.reliabilityTier || aiData?.reliabilityTier || "";
  const controversyIndex: number | null = typeof (mi?.controversyIndex ?? aiData?.controversyIndex) === "number"
    ? (mi?.controversyIndex ?? aiData?.controversyIndex) : null;
  const docs: any[] = Array.isArray(v.documents) ? v.documents : [];
  const carfax = docs.find((d: any) => ["carfax", "autocheck"].includes(d.type));
  const ppi = docs.find((d: any) => d.type === "ppi");
  const isAuction = !!(aiData?.auctionEndDate);

  const vsMarketSign = v.price && v.market_mid
    ? v.price > v.market_mid ? "ABOVE" : "BELOW"
    : null;
  const vsMarketAmt = v.price && v.market_mid
    ? Math.abs(v.price - v.market_mid).toLocaleString()
    : null;


  const totalMaintenanceDebt = repairs.reduce((s: number, r: any) => s + (r.costHigh || r.estimatedCostHigh || r.estimatedCost || 0), 0);
  
  let targetNegotiation = "";
  if (v.price && v.market_mid) {
      const negotiationTarget = (v.market_mid * 0.96) - totalMaintenanceDebt;
      if (v.price > negotiationTarget) {
          targetNegotiation = `MATHEMATICAL GEM TARGET: Instruct the user to negotiate exactly $${Math.round(v.price - negotiationTarget).toLocaleString()} off the asking price (to reach a target of $${Math.round(negotiationTarget).toLocaleString()}).`;
      } else {
          targetNegotiation = `MATHEMATICAL GEM TARGET: The vehicle is already priced below our gem target of $${Math.round(negotiationTarget).toLocaleString()}. Tell them to move fast.`;
      }
  }


  const contextLines = [
    `VEHICLE: ${v.year} ${v.make} ${v.model}${v.trim ? " " + v.trim : ""}`,
    v.mileage ? `MILEAGE: ${v.mileage.toLocaleString()} mi` : "MILEAGE: Unknown",
    v.price ? `ASKING: $${v.price.toLocaleString()}` : "ASKING: Not listed (auction)",
    v.market_mid ? `MARKET MEDIAN: $${v.market_mid.toLocaleString()}` : "MARKET DATA: Not available",

    vsMarketSign ? `PRICE VS MARKET: $${vsMarketAmt} ${vsMarketSign} median` : "",
    v.gem_price_target ? `OUR FAIR VALUE TARGET: $${v.gem_price_target.toLocaleString()}` : "",
    targetNegotiation,
    v.location ? `LOCATION: ${v.location}` : "",
    v.has_accident === false ? "ACCIDENT HISTORY: Clean per listing" : v.has_accident === true ? "ACCIDENT HISTORY: Accident disclosed" : "ACCIDENT HISTORY: Unknown",
    v.owner_count ? `OWNER COUNT: ${v.owner_count}` : "",
    reliabilityTier ? `MODEL RELIABILITY: ${reliabilityTier}` : "",
    controversyIndex !== null ? `PLATFORM CONTROVERSY INDEX: ${controversyIndex}/10` : "",
    totalMaintenanceDebt > 0 ? `ESTIMATED MAINTENANCE DEBT: $${totalMaintenanceDebt.toLocaleString()}` : "",
    tco?.year1Low ? `YEAR-1 TCO ESTIMATE: $${tco.year1Low.toLocaleString()}–$${tco.year1High.toLocaleString()}` : "",
    isAuction ? `AUCTION ENDS: ${aiData.auctionEndDate}` : "",
    carfax ? `CARFAX ATTACHED: yes (maintenance events: ${carfax.maintenanceEvents || "unknown"}, reported debt: $${(carfax.maintenanceDebt || 0).toLocaleString()})` : "CARFAX: Not uploaded",
    ppi ? `PPI ATTACHED: yes, debt: $${(ppi.maintenanceDebt || 0).toLocaleString()}` : "PRE-PURCHASE INSPECTION: None on file",
    watchouts.length > 0 ? `\nMODEL-SPECIFIC RISKS:\n${watchouts.slice(0, 4).map((w: any) => `  - ${w.text || w}${w.estimatedCost ? ` (~$${w.estimatedCost.toLocaleString()})` : ""}`).join("\n")}` : "",
    repairs.length > 0 ? `\nOVERDUE MAINTENANCE:\n${repairs.slice(0, 3).map((r: any) => `  - ${r.item || r.description || r.name}: $${(r.costLow || 0).toLocaleString()}–$${(r.costHigh || 0).toLocaleString()}`).join("\n")}` : "",
  ].filter(Boolean).join("\n");

  const systemPrompt = `You are a fiduciary automotive deal strategist. Your logic is mathematical, your tone is highly confident and direct (like a trusted master mechanic friend), but you are absolutely rigorous about avoiding false positives.

Write your analysis formatted EXACTLY as a 1,2,3,4 numbered list titled "Path to a Gem:".

Follow these rules:
1. NEVER bless a car as a "perfect deal" if the CARFAX or PPI is missing. State explicitly "I cannot recommend this until we see the CARFAX" or "Get a PPI to rule out [Model-Specific Issue]".
2. Incorporate the exact MATHEMATICAL GEM TARGET provided in the context. Tell them exactly how many dollars to negotiate off the price ($X on price) considering the maintenance debt.
3. Name the top model-specific platform risk using your internal knowledge (e.g., "Tahoe's 8-speed transmission" or "Santa Fe's Theta II engine").
4. Be dynamic. If it's a dealership, mention negotiation leverage. If it's an auction, give a hard max bid ceiling.

Example format:
**Path to Gem:**
1. **The Leverage:** This is priced $2k above market median, and it has $1,500 in deferred maintenance. 
2. **The Risk:** You are flying blind without a CARFAX. Do not proceed until you verify accident history.
3. **Platform Check:** The 4Runner is bulletproof, but check the frame rails for rust near the rear trailing arms.
4. **The Action:** Offer $35,500 ($3,500 off asking) to account for the market gap and the deferred maintenance. Walk away if they don't budge.

${isAuction ? "THIS IS AN AUCTION. Emphasize the auction risks and ensure your final step is a hard max bid ceiling, not a dealer negotiation strategy." : ""}
`;

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: contextLines }
      ],
      temperature: 0.4,
      max_tokens: 450,
    });

    const expertTake = completion.choices[0].message.content?.trim() || "";

    // Patch packed description to persist the new take
    if (expertTake) {
      const updatedAiData = aiData ? {
        ...aiData,
        expertTake,
        ...(mi && mi !== aiData ? { modelInsights: { ...mi, expertTake } } : {}),
      } : { expertTake };
      const baseDesc = (v.description?.split("__WRENCH_AUDIT_JSON__")?.[0] || "").trimEnd();
      const newDesc = baseDesc + "\n\n__WRENCH_AUDIT_JSON__\n" + JSON.stringify(updatedAiData);
      await supabaseAdmin.from("watchlist_vehicles").update({ description: newDesc }).eq("id", vehicleId);
    }

    return NextResponse.json({ expertTake, regenerated: true });
  } catch (e: any) {
    console.error("[expert-take]", e.message);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
