// app/api/hunt/[id]/navigator/route.ts
// Streaming AI Deal Navigator — immediate opinionated verdict, no hedging.
// Auto-detects user preferences from conversation history.

import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import OpenAI from "openai";
import { classifySellerIntel } from "@/lib/sellerIntelligence";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function fmt$(n: number) {
  return `$${n.toLocaleString()}`;
}

function buildVehicleContext(v: any): string {
  const docs: any[] = Array.isArray(v.documents) ? v.documents : [];
  const carfax = docs.find((d) => d.type === "carfax" || d.type === "autocheck");
  const ppi    = docs.find((d) => d.type === "ppi");

  let rawAiData: any = null;
  const rawStr = v.description?.split("__WRENCH_AUDIT_JSON__")?.[1];
  if (rawStr) { try { rawAiData = JSON.parse(rawStr); } catch {} }

  const mi = rawAiData?.modelInsights || rawAiData;
  const watchouts:  any[] = mi?.watchouts      || rawAiData?.watchouts      || [];
  const exposures:  any[] = mi?.majorExposures || rawAiData?.majorExposures || [];
  const goodBuyIf:  any[] = mi?.goodBuyIf      || [];
  const badBuyIf:   any[] = mi?.badBuyIf       || [];
  const tco         = mi?.tco || rawAiData?.tco || null;
  const narrative   = rawAiData?.vehicleNarrative || mi?.vehicleNarrative || null;
  const expertTake  = mi?.expertTake || rawAiData?.expertTake || null;
  const ownershipOutlook = mi?.ownershipOutlook || null;
  const controversyIndex = typeof (mi?.controversyIndex ?? rawAiData?.controversyIndex) === 'number'
    ? (mi?.controversyIndex ?? rawAiData?.controversyIndex) : null;

  // Detect listing type
  const url = (v.listing_url || "").toLowerCase();
  const rawDesc = v.description || "";
  const cleanDesc = rawDesc.split("__WRENCH_AUDIT_JSON__")[0].toLowerCase();
  const isAuction = url.includes("copart") || url.includes("iaai") || url.includes("bringatrailer") || url.includes("carsandbids") ||
    url.includes("manheim") || cleanDesc.includes("tow yard") || cleanDesc.includes("tow auction") ||
    cleanDesc.includes("auction") || !!rawAiData?.auctionEndDate;
  const isTowYard = cleanDesc.includes("tow yard") || cleanDesc.includes("impound") || url.includes("towyard") || url.includes("dickensheet");
  const isBaT = url.includes("bringatrailer") || url.includes("carsandbids");

  const age = v.year ? Math.max(0, 2026 - v.year) : null;
  const carProfile = (age !== null && age <= 3) || (v.mileage !== null && v.mileage <= 35000) ? "new"
    : (age !== null && age <= 7) || (v.mileage !== null && v.mileage <= 80000) ? "mid"
    : "seasoned";

  const lines: string[] = [
    `=== VEHICLE DOSSIER ===`,
    `Vehicle: ${v.year} ${v.make} ${v.model}${v.trim ? " " + v.trim : ""}`,
    `Car Profile: ${carProfile.toUpperCase()} (${carProfile === "new" ? "≤3yrs/35k mi — price & seller type matter most" : carProfile === "mid" ? "3–7yrs/35k–80k mi — CARFAX starts mattering" : "7+ yrs or 80k+ mi — history verification is critical"})`,
    `Listing type: ${isTowYard ? "TOW YARD AUCTION" : isBaT ? "ENTHUSIAST AUCTION (BaT/C&B)" : isAuction ? "AUCTION" : "DEALER/PRIVATE LISTING"}`,
    `Mileage: ${v.mileage ? v.mileage.toLocaleString() + " mi" : "UNKNOWN — major risk factor"}`,
    `Asking Price: ${v.price ? fmt$(v.price) : "unknown"}`,
    `Location: ${v.location || "unknown"}`,
    `WrenchScore: ${v.adjusted_score || v.score || "unscored"} / 100 → Tier: ${v.tier_label || v.tier || "unknown"}`,
    `Score confidence: ${v.confidence_pct || 25}% (${v.confidence_pct >= 85 ? "verified" : v.confidence_pct >= 70 ? "medium — some data missing" : "LOW — score is estimated, not verified"})`,
    `Market Median: ${v.market_mid ? fmt$(v.market_mid) : "not fetched"}`,
    v.price && v.market_mid
      ? `vs Market: ${v.price > v.market_mid
          ? fmt$(v.price - v.market_mid) + " ABOVE median (overpriced vs comparables)"
          : fmt$(v.market_mid - v.price) + " BELOW median (underpriced)"}`
      : "",
    v.has_accident === false ? "Accident History: CLEAN" : v.has_accident === true ? "Accident History: ACCIDENT REPORTED ⚠️" : "Accident History: UNKNOWN",
    v.owner_count ? `Owners: ${v.owner_count}` : "Owners: unknown",
    `Gem Price Target: ${v.gem_price_target ? fmt$(v.gem_price_target) : "not computed"}`,
    rawAiData?.auctionEndDate ? `Auction End: ${rawAiData.auctionEndDate}` : "",
  ].filter(Boolean);

  if (narrative) lines.push(`\nListing narrative (AI assessment): "${narrative}"`);
  if (expertTake) lines.push(`\nModel-expert take (pre-computed): ${expertTake}`);
  if (ownershipOutlook) lines.push(`Ownership outlook: ${ownershipOutlook}`);
  if (controversyIndex !== null) lines.push(`Controversy index: ${controversyIndex}/10 (${controversyIndex >= 8 ? "HIGH — polarizing ownership" : controversyIndex >= 5 ? "MODERATE" : "low risk profile"})`);

  if (tco?.year1Low) {
    lines.push(`\nTCO estimates:`);
    lines.push(`  Year 1: ${fmt$(tco.year1Low)}–${fmt$(tco.year1High)}`);
    if (tco.year3Low) lines.push(`  3-Year: ${fmt$(tco.year3Low)}–${fmt$(tco.year3High)}`);
  }

  if (watchouts.length > 0) {
    lines.push(`\nModel-specific risks (calibrated to this mileage):`);
    watchouts.slice(0, 4).forEach((w: any) => {
      lines.push(`  • ${w.text || w}${w.estimatedCost ? " (~" + fmt$(w.estimatedCost) + ")" : ""}`);
    });
  }

  if (exposures.length > 0) {
    lines.push(`\nMajor cost exposures:`);
    exposures.slice(0, 3).forEach((e: any) => {
      lines.push(`  • ${e.name}: ${fmt$(e.costLow)}–${fmt$(e.costHigh)} [${e.urgency}] — ${e.note}`);
    });
  }

  if (goodBuyIf.length > 0) lines.push(`\nGood buy if: ${goodBuyIf.slice(0,2).join(" / ")}`);
  if (badBuyIf.length > 0)  lines.push(`Bad buy if: ${badBuyIf.slice(0,2).join(" / ")}`);

  // ── Seller Intelligence ─────────────────────────────────────────────────────
  const sellerIntel = classifySellerIntel({
    sellerType: v.seller_type || null,
    sellerName: v.seller_name || null,
    listingUrl: v.listing_url || null,
    daysOnMarket: v.days_on_market || null,
  });
  if (sellerIntel.profile !== 'unknown') {
    lines.push(`\n=== SELLER INTELLIGENCE ===`);
    lines.push(`Seller profile: ${sellerIntel.label}${v.seller_name ? ` — ${v.seller_name}` : ''}`);
    lines.push(`Motivation read: ${sellerIntel.motivationRead}`);
    lines.push(`Negotiation approach: ${sellerIntel.negotiationApproach}`);
    if (sellerIntel.daysOnMarketSignal) lines.push(`Days on market: ${sellerIntel.daysOnMarketSignal}`);
    if (sellerIntel.redFlags.length) lines.push(`Watch out for: ${sellerIntel.redFlags.slice(0,2).join('; ')}`);
  }

  // ── Price Velocity ──────────────────────────────────────────────────────────
  const priceHistory: {price: number; date: string}[] = Array.isArray(v.price_history) ? v.price_history : [];
  if (priceHistory.length >= 2 && v.initial_price) {
    const totalDrop = v.initial_price - (v.price || v.initial_price);
    const daysSinceAdded = Math.round((Date.now() - new Date(priceHistory[0].date).getTime()) / 86400000);
    const recentEntry = priceHistory[priceHistory.length - 1];
    const previousEntry = priceHistory[priceHistory.length - 2];
    const recentDrop = previousEntry.price - recentEntry.price;
    const daysSinceLastDrop = Math.round((Date.now() - new Date(recentEntry.date).getTime()) / 86400000);
    lines.push(`\n=== PRICE VELOCITY ===`);
    lines.push(`Starting price: ${fmt$(v.initial_price)}`);
    lines.push(`Current price: ${fmt$(v.price || v.initial_price)}`);
    if (totalDrop > 0) {
      lines.push(`Total dropped: ${fmt$(totalDrop)} over ${daysSinceAdded} days`);
      if (recentDrop > 0) lines.push(`Most recent drop: ${fmt$(recentDrop)} (${daysSinceLastDrop} days ago)`);
    } else {
      lines.push(`Price unchanged for ${daysSinceAdded}+ days`);
    }
  }

  lines.push(`\n=== DOSSIER STATUS ===`);
  if (carfax) {
    lines.push(`✅ CARFAX/AutoCheck attached — debt: ${fmt$(carfax.maintenanceDebt || 0)}, ${carfax.maintenanceEvents || 0} events`);
    if (carfax.hasAccident) lines.push(`⚠️ CARFAX confirms accident — factor this into any offer`);
    if (carfax.vehicleNarrative) lines.push(`CARFAX narrative: ${carfax.vehicleNarrative}`);
  } else {
    lines.push(`📎 No CARFAX — score is estimated. History completely unknown.`);
  }
  if (v.photo_intel?.condition) {
    lines.push(`📸 Photos scanned: condition=${v.photo_intel.condition}`);
    if (v.photo_intel.redFlags?.length) lines.push(`   Red flags: ${v.photo_intel.redFlags.join(", ")}`);
    if (v.photo_intel.positives?.length) lines.push(`   Positives: ${v.photo_intel.positives.slice(0,3).join(", ")}`);
  } else {
    lines.push(`📸 Photos not scanned`);
  }
  if (ppi) {
    lines.push(`🔧 PPI attached — debt: ${fmt$(ppi.maintenanceDebt || 0)}`);
  } else {
    lines.push(`🔧 No pre-purchase inspection on file`);
  }

  return lines.join("\n");
}

// Detect user preferences/persona from conversation history
function extractUserPreferences(history: any[]): string {
  if (!history.length) return "";
  const allText = history.filter(m => m.role === "user").map(m => m.content).join(" ").toLowerCase();
  const prefs: string[] = [];

  if (/daily|commute|reliable|dependable|everyday/i.test(allText)) prefs.push("daily driver / reliability focus");
  if (/weekend|track|sport|performance|fun|toy/i.test(allText)) prefs.push("weekend/performance use case");
  if (/offroad|4x4|trail|overlook|camping|overland/i.test(allText)) prefs.push("off-road / adventure use");
  if (/flip|resell|invest|profit|arbitrage/i.test(allText)) prefs.push("investor/flipper mindset — prioritize resale delta");
  if (/project|restore|wrench|garage|build|swap/i.test(allText)) prefs.push("DIY mechanic / project car buyer — higher mechanical risk tolerance");
  if (/budget|tight|afford|cheap|under|stretch/i.test(allText)) prefs.push("budget-constrained — value/risk math is paramount");
  if (/\$\d{4,}|\d{4,}\s*budget/i.test(allText)) {
    const m = allText.match(/\$?(\d{4,})\s*(budget|max|limit|ceiling)?/);
    if (m) prefs.push(`stated budget ~$${parseInt(m[1]).toLocaleString()}`);
  }
  if (/family|kids|car seat|safe|minivan|suv/i.test(allText)) prefs.push("family vehicle priorities — safety and reliability weight high");
  if (/not\s+mechanically|can.t wrench|no garage|dealer only|not a mechanic/i.test(allText)) prefs.push("non-mechanical — needs turn-key, no deferred maintenance");
  if (/cash|no financing|pay cash|paying cash/i.test(allText)) prefs.push("cash buyer — negotiate without financing contingency");
  if (/financ|loan|monthly|payment|apr|rate/i.test(allText)) prefs.push("financing — monthly payment sensitivity matters");
  if (/tow|haul|trailer|truck|payload/i.test(allText)) prefs.push("towing/hauling use case");
  if (/first car|new driver|just got|learning/i.test(allText)) prefs.push("potentially first-time buyer — explain things more");
  if (/hurry|asap|need.*(soon|now|week|quickly)|move fast/i.test(allText)) prefs.push("time-pressured — can't wait for perfect deal");
  if (/need.*(soon|asap|now|week)/i.test(allText)) prefs.push("time-sensitive — needs car soon");

  if (!prefs.length) return "";
  return `\n=== DETECTED USER PREFERENCES (from conversation) ===\n${prefs.map(p => `  • ${p}`).join("\n")}\nTailor all advice to this buyer profile. Do NOT repeat canned advice that doesn't match their stated situation.`;
}

const TODAY = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });

const SYSTEM_PROMPT = `You are WrenchCheck's Deal Navigator. Today is ${TODAY}.

You are an expert automotive analyst. Part ex-dealer, part ASE mechanic, part market strategist. You give real opinions backed by real numbers.

━━━━━━━━━━━━━━━━━━━━━━━━
FORMATTING RULES (CRITICAL — follow exactly)
━━━━━━━━━━━━━━━━━━━━━━━━

Your responses must be visually structured and scannable. Use this formatting:

1. Use emoji section headers like: 🧠 🔥 💰 🚨 🏁 💬 🔍 📊 ⚙️
2. Use "⸻" (horizontal rule) between major sections  
3. Use ✅ for positives, ⚠️ for warnings, ❌ for deal-breakers
4. Use 👉 for key takeaways
5. Bold important numbers and verdicts by putting them on their own line
6. Use short lines — NEVER write dense paragraphs. One idea per line.
7. Leave blank lines between sections for breathing room
8. Use "💥" for final price recommendations

Example of the FORMAT (not content) you should follow:

⸻

🧠 The Truck

✅ No accidents
✅ 1 owner  
⚠️ High mileage (~18.6k/yr)

👉 This is the clean, premium, but high-mile truck

⸻

🔥 My Take (no fluff)

[Sharp, direct verdict in 1-2 lines]

Why:
• [specific reason with numbers]
• [specific reason with numbers]

⸻

🚨 The Hidden Insight

[One non-obvious observation that reframes the decision]

⸻

💰 Price Reality

Listed at $73K

👉 Worth:

💥 $69K–71K

[Why — specific reasoning]

⸻

━━━━━━━━━━━━━━━━━━━━━━━━
VOICE & PERSONALITY
━━━━━━━━━━━━━━━━━━━━━━━━

- You are sharp, direct, and opinionated. Say "I'd walk" not "there are some concerns."
- Use "Not even close" / "Only if priced aggressively" / "This is a pass" type language
- Never hedge. If data is missing, say what you'd need and give your best guess with the caveat.
- Specific always: "$69K–71K" not "low 70s". "90k timing belt service: $800–1,200" not "maintenance costs."
- You're talking to a friend who asked for your honest take, not writing a report.
- Never start with "I", "So", "Great question", or "First". Jump straight to the insight.

━━━━━━━━━━━━━━━━━━━━━━━━
KNOWLEDGE (use it — be specific)
━━━━━━━━━━━━━━━━━━━━━━━━

Land Cruiser 200-series (2008-2021):
- Timing belt + water pump at 90k: $800–1,200 dealer, $500–700 independent
- Rear differential fluid every 30k: ~$150
- Front diff + transfer case fluids: ~$200
- Knuckle repack service: $600–900 if neglected (check for grease leaking from front axle)
- 4x4 actuator: ~$400 failure mode
- KDSS hydraulic system (if equipped): check for leaks, $1,500+ to repair
- 3rd row seat latch recall — verify completion
- Common issue: secondary air injection system failure (~$300–500)
- Brake pads + rotors (all 4 corners): $800–1,200

Market knowledge:
- 200-series peaked at $80–100k during 2021-2022 COVID shortage
- Now settling $65–90k depending on year/mileage/condition
- 2021 Heritage Edition: $75–95k, highest demand trim
- BaT is the gold standard for sold comps
- Key price drivers: single owner, under 60k mi, Toyota dealer service history, no rust, no accidents = full premium
- Each accident report drops value $3–8k. Each additional owner: $2–4k.
- Rust belt history (OH/MI/PA/NY/IL): $3–5k discount vs. Sun Belt
- LC200 production ended 2021. Supply is finite. Price floor holding above $65k for clean examples.

Geographic signals (apply automatically, never ask):
- CO/AZ/NV/TX/CA = rust-free bonus
- OH/MI/PA/NY/IL/WI/MN = rust-belt flag → price discount

━━━━━━━━━━━━━━━━━━━━━━━━
ON FIRST MESSAGE (no user question)
━━━━━━━━━━━━━━━━━━━━━━━━

Give your FULL opening brief. Use the structured format above. Include ALL of these sections:

1. 🧠 The Truck — quick profile with ✅/⚠️/❌ bullet points
2. 🔥 My Take — your verdict, sharp and direct
3. ⚙️ Maintenance Reality — specific items due at this mileage with dollar amounts
4. 🚨 The Hidden Insight — one non-obvious thing the buyer should know
5. 💰 Price Reality — what it's worth and what to offer
6. 🏁 What I'd Do — the concrete next step in the next 24 hours
7. 💬 Offer at end: "If you want, I can: [2-3 specific things you can help with]"

Do NOT hold back. Give the complete picture in one response.

━━━━━━━━━━━━━━━━━━━━━━━━
ON TCO / OWNERSHIP COST QUESTIONS
━━━━━━━━━━━━━━━━━━━━━━━━

When the buyer provides annual mileage, give a structured year-by-year breakdown:

📊 Year 1 (current mi → projected): items due + cost
📊 Year 2 (projected): items due + cost  
📊 Year 3 (projected): items due + cost

End with:
💥 Total 3-Year Ownership Cost: $XX,XXX
💥 True Cost Per Mile: $X.XX

━━━━━━━━━━━━━━━━━━━━━━━━
ON MARKET TRENDS
━━━━━━━━━━━━━━━━━━━━━━━━

Reference specific BaT auction results. Use your knowledge of actual sold prices. Structure the response visually with a timeline and clear price anchors.

━━━━━━━━━━━━━━━━━━━━━━━━
ON FOLLOW-UP MESSAGES
━━━━━━━━━━━━━━━━━━━━━━━━

Keep the same visual formatting. Stay sharp and direct. Don't repeat what you've already said.
If comparing multiple vehicles, use the numbered format with emoji headers for each truck.

━━━━━━━━━━━━━━━━━━━━━━━━
NEVER DO
━━━━━━━━━━━━━━━━━━━━━━━━

- Never write dense paragraphs
- Never start with "I" or "So" or "First" or "Great question"
- Never say "it really depends" — give your best read
- Never repeat the car's specs back. Get to the INSIGHT.
- Never use [Verdict]: / [Math]: / [Action]: labels
- Never be generic. Every sentence must be specific to THIS car.`;

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const vehicleId = (await params).id;

  const { data: vehicle, error } = await supabaseAdmin
    .from("watchlist_vehicles")
    .select("*")
    .eq("id", vehicleId)
    .single();

  if (error || !vehicle) {
    return NextResponse.json({ error: "Vehicle not found" }, { status: 404 });
  }

  const body = await req.json();
  const userMessage:    string = body.message || "";
  const existingHistory: any[] = body.history || [];
  const buyerProfile: Record<string, string> = body.buyerProfile || {};

  const vehicleContext = buildVehicleContext(vehicle);
  const userPrefs      = extractUserPreferences(existingHistory);

  // Build buyer profile context string
  const profileEntries = Object.entries(buyerProfile).filter(([, v]) => v);
  const profileContext = profileEntries.length > 0
    ? `\n\n=== BUYER PROFILE (user-stated preferences — factor into all advice) ===\n` +
      profileEntries.map(([k, v]) => `  • ${k.replace(/_/g, ' ')}: ${v}`).join('\n') +
      `\nApply these preferences naturally — don't re-list them back, just use them. ` +
      `If this car conflicts with a stated preference (e.g. wrong interior color), flag it briefly.`
    : '';

  const messages: any[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "system", content: vehicleContext + userPrefs + profileContext },
  ];

  // Replay existing chat history
  for (const msg of existingHistory) {
    messages.push({ role: msg.role, content: msg.content });
  }

  // First open — give immediate full analysis primed with specific car context
  if (!userMessage && existingHistory.length === 0) {
    const yearMakeModel = [vehicle.year, vehicle.make, vehicle.model, vehicle.trim].filter(Boolean).join(' ');
    const priceStr = vehicle.price ? `Listed at $${vehicle.price.toLocaleString()}.` : '';
    const mileStr = vehicle.mileage ? `${vehicle.mileage.toLocaleString()} miles.` : '';
    messages.push({
      role: "user",
      content: `I'm looking at this ${yearMakeModel}. ${priceStr} ${mileStr} What's your real take? I need: (1) your verdict and what you'd actually offer, (2) the specific maintenance items due at this mileage with dollar estimates — not generic "check fluids" but actual service intervals, (3) your read on how long it's been sitting and what that tells you, and (4) the one thing that would make you walk.`,
    });
  } else if (userMessage) {
    messages.push({ role: "user", content: userMessage });
  }

  // ── Stream the response ───────────────────────────────────────────────────
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let fullResponse = "";
      try {
        const completion = await openai.chat.completions.create({
          model: "gpt-4o",
          messages,
          stream: true,
          temperature: 0.72,
          max_tokens: 3000,
        });

        for await (const chunk of completion) {
          const delta = chunk.choices[0]?.delta?.content ?? "";
          if (delta) {
            fullResponse += delta;
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify({ type: "delta", content: delta })}\n\n`)
            );
          }
        }

        // Persist the new messages to deal_chat
        const existingChat: any[] = Array.isArray(vehicle.deal_chat) ? vehicle.deal_chat : [];
        const newMessages = [
          ...(userMessage ? [{ role: "user", content: userMessage }] : []),
          { role: "assistant", content: fullResponse },
        ];

        await supabaseAdmin
          .from("watchlist_vehicles")
          .update({ deal_chat: [...existingChat, ...newMessages] })
          .eq("id", vehicleId);

        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ type: "done", fullResponse })}\n\n`)
        );
      } catch (err: any) {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ type: "error", message: err.message })}\n\n`)
        );
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    },
  });
}
