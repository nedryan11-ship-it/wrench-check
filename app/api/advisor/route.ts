// app/api/advisor/route.ts
// Unified AI Advisor — single streaming endpoint that replaces Navigator, 
// Morning Brief, Analyze Rankings, Scout Chat, and Criteria Panel.
// Full context: entire Board state, buyer profile, historical vehicles, conversation memory.

import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import OpenAI from "openai";
import { classifySellerIntel } from "@/lib/sellerIntelligence";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const TODAY = new Date().toLocaleDateString("en-US", {
  weekday: "long", month: "long", day: "numeric", year: "numeric",
});

function fmt$(n: number) { return `$${n.toLocaleString()}`; }

// ── Build compact vehicle summary for context injection ─────────────────────
function buildVehicleSummary(v: any, rank?: number): string {
  const prefix = rank != null ? `#${rank}: ` : "";
  const price = v.price ? fmt$(v.price) : "no price";
  const mkt = v.market_mid ? `(mkt ${fmt$(v.market_mid)})` : "";
  const mi = v.mileage ? `${v.mileage.toLocaleString()} mi` : "? mi";
  const acc = v.has_accident === false ? "✅ clean" : v.has_accident === true ? "⚠️ accident" : "? history";
  const owners = v.owner_count ? `${v.owner_count} owner${v.owner_count > 1 ? "s" : ""}` : "";
  const loc = v.location || "";

  // Price velocity
  let velocity = "";
  const ph: {price:number;date:string}[] = Array.isArray(v.price_history) ? v.price_history : [];
  if (v.initial_price && v.price && v.initial_price > v.price) {
    const drop = v.initial_price - v.price;
    const days = ph.length >= 1 ? Math.max(1, Math.round((Date.now() - new Date(ph[0].date).getTime()) / 86400000)) : null;
    const rate = days ? Math.round(drop / days) : null;
    velocity = `↓${fmt$(drop)} total${rate ? ` ($${rate}/day)` : ""}${days ? ` over ${days}d` : ""}`;
  } else if (ph.length >= 1) {
    const days = Math.round((Date.now() - new Date(ph[0].date).getTime()) / 86400000);
    if (days > 14) velocity = `${days}d listed, no drops`;
  }

  // Delta to market
  let delta = "";
  if (v.price && v.market_mid) {
    const d = v.market_mid - v.price;
    delta = d > 0 ? `${fmt$(d)} below mkt` : `${fmt$(Math.abs(d))} above mkt`;
  }

  // Notes
  const notes = v.notes ? ` [user note: "${v.notes}"]` : "";
  
  // Seller
  const seller = v.seller_name ? ` | ${v.seller_name}` : "";

  const parts = [
    `${prefix}${v.year} ${v.make} ${v.model}${v.trim ? " " + v.trim : ""}`,
    `${price} ${mkt} ${delta}`, mi, acc, owners, loc, velocity, seller,
  ].filter(Boolean);
  
  return parts.join(" | ") + notes;
}

// ── Deep dossier for a single vehicle (Navigator-level detail) ──────────────
function buildDeepDossier(v: any): string {
  const lines: string[] = [`\n═══ DEEP DOSSIER: ${v.year} ${v.make} ${v.model}${v.trim ? " " + v.trim : ""} ═══`];
  
  lines.push(`Asking: ${v.price ? fmt$(v.price) : "unknown"} | Mileage: ${v.mileage ? v.mileage.toLocaleString() + " mi" : "unknown"}`);
  lines.push(`Market Mid: ${v.market_mid ? fmt$(v.market_mid) : "not fetched"}`);
  if (v.price && v.market_mid) {
    const d = v.market_mid - v.price;
    lines.push(`vs Market: ${d > 0 ? fmt$(d) + " BELOW median" : fmt$(Math.abs(d)) + " ABOVE median"}`);
  }
  lines.push(`Score: ${v.adjusted_score || v.score || "unscored"}/100 | Tier: ${v.tier_label || v.tier || "unknown"} | Confidence: ${v.confidence_pct || 25}%`);
  lines.push(`Accidents: ${v.has_accident === false ? "CLEAN" : v.has_accident === true ? "ACCIDENT REPORTED ⚠️" : "UNKNOWN"}`);
  lines.push(`Owners: ${v.owner_count || "unknown"} | Location: ${v.location || "unknown"} | Seller: ${v.seller_name || "unknown"}`);
  if (v.gem_price_target) lines.push(`Gem Price Target: ${fmt$(v.gem_price_target)}`);
  if (v.notes) lines.push(`User Notes: "${v.notes}"`);

  // ── AI Audit Data ──
  let rawAiData: any = null;
  const rawStr = v.description?.split("__WRENCH_AUDIT_JSON__")?.[1];
  if (rawStr) { try { rawAiData = JSON.parse(rawStr); } catch {} }
  const mi = rawAiData?.modelInsights || rawAiData;
  
  if (mi) {
    const watchouts = mi?.watchouts || rawAiData?.watchouts || [];
    const exposures = mi?.majorExposures || rawAiData?.majorExposures || [];
    const tco = mi?.tco || rawAiData?.tco || null;
    const narrative = rawAiData?.vehicleNarrative || mi?.vehicleNarrative || null;
    const expertTake = mi?.expertTake || rawAiData?.expertTake || null;
    
    if (narrative) lines.push(`\nNarrative: "${narrative}"`);
    if (expertTake) lines.push(`Expert Take: ${expertTake}`);
    if (tco?.year1Low) {
      lines.push(`\nTCO: Year 1: ${fmt$(tco.year1Low)}–${fmt$(tco.year1High)}${tco.year3Low ? ` | 3-Year: ${fmt$(tco.year3Low)}–${fmt$(tco.year3High)}` : ""}`);
    }
    if (watchouts.length > 0) {
      lines.push(`\nModel Risks at this mileage:`);
      watchouts.slice(0, 5).forEach((w: any) => {
        lines.push(`  • ${w.text || w}${w.estimatedCost ? " (~" + fmt$(w.estimatedCost) + ")" : ""}`);
      });
    }
    if (exposures.length > 0) {
      lines.push(`Major Cost Exposures:`);
      exposures.slice(0, 4).forEach((e: any) => {
        lines.push(`  • ${e.name}: ${fmt$(e.costLow)}–${fmt$(e.costHigh)} [${e.urgency}] — ${e.note}`);
      });
    }
  }

  // ── Seller Intelligence ──
  const sellerIntel = classifySellerIntel({
    sellerType: v.seller_type || null, sellerName: v.seller_name || null,
    listingUrl: v.listing_url || null, daysOnMarket: v.days_on_market || null,
  });
  if (sellerIntel.profile !== "unknown") {
    lines.push(`\nSeller: ${sellerIntel.label} | Motivation: ${sellerIntel.motivationRead}`);
    lines.push(`Negotiation: ${sellerIntel.negotiationApproach}`);
  }

  // ── Price Velocity (detailed) ──
  const ph: {price:number;date:string}[] = Array.isArray(v.price_history) ? v.price_history : [];
  if (ph.length >= 2 && v.initial_price) {
    const totalDrop = v.initial_price - (v.price || v.initial_price);
    const daysSince = Math.round((Date.now() - new Date(ph[0].date).getTime()) / 86400000);
    lines.push(`\nPrice History: Started ${fmt$(v.initial_price)} → Now ${fmt$(v.price)} (${totalDrop > 0 ? "↓" + fmt$(totalDrop) : "no change"} over ${daysSince}d)`);
    if (ph.length > 2) {
      lines.push(`Price timeline:`);
      ph.forEach((p) => lines.push(`  ${new Date(p.date).toLocaleDateString()}: ${fmt$(p.price)}`));
    }
  }

  // ── CarFax Data (THE KEY FIX) ──
  const cfx = v.carfax_data;
  if (cfx && typeof cfx === "object" && Object.keys(cfx).length > 0) {
    lines.push(`\n=== CARFAX REPORT ===`);
    lines.push(`VIN: ${cfx.vin || "?"} | Title: ${cfx.clean_title ? "CLEAN" : cfx.salvage ? "SALVAGE ⚠️" : "?"}`);
    lines.push(`Owners: ${cfx.owner_count || "?"} | Accidents: ${cfx.total_accidents ?? "?"} | Service Records: ${cfx.service_records || "?"}`);
    if (cfx.last_odometer) lines.push(`Last Odometer: ${cfx.last_odometer.toLocaleString()} mi (${cfx.last_odometer_date || "?"})`);
    if (cfx.state_history?.length) lines.push(`State History: ${cfx.state_history.join(" → ")}`);
    if (cfx.summary) lines.push(`CarFax Summary: ${cfx.summary}`);
    
    // Accidents detail
    if (cfx.accidents?.length > 0) {
      lines.push(`\nAccident Details:`);
      cfx.accidents.forEach((a: any) => {
        lines.push(`  ⚠️ ${a.date}: ${a.type} — ${a.severity}${a.airbag ? " (AIRBAG DEPLOYED)" : ""}`);
      });
    }
    
    // SERVICE HISTORY LINE ITEMS — this is what was missing
    if (cfx.service_history?.length > 0) {
      lines.push(`\n=== FULL SERVICE HISTORY (${cfx.service_history.length} records) ===`);
      cfx.service_history.forEach((s: any) => {
        const mi = s.mileage ? `${s.mileage.toLocaleString()} mi` : "? mi";
        const loc = s.location ? ` @ ${s.location}` : "";
        lines.push(`  ${s.date} | ${mi} | ${s.description} [${s.service_type}]${loc}`);
      });
    }
    
    // Ownership history
    if (cfx.ownership_history?.length > 0) {
      lines.push(`\nOwnership Timeline:`);
      cfx.ownership_history.forEach((o: any) => {
        lines.push(`  Owner #${o.owner_number}: ${o.start_date || "?"} → ${o.end_date || "current"} | ${o.state || "?"} | ${o.type || "?"}`);
      });
    }
  } else {
    lines.push(`\n📎 No CarFax on file — history unverified.`);
  }

  // ── Photo Intel ──
  if (v.photo_intel?.condition) {
    lines.push(`\nPhotos: condition=${v.photo_intel.condition}`);
    if (v.photo_intel.redFlags?.length) lines.push(`  Red flags: ${v.photo_intel.redFlags.join(", ")}`);
    if (v.photo_intel.positives?.length) lines.push(`  Positives: ${v.photo_intel.positives.slice(0,3).join(", ")}`);
  }

  // ── Documents ──
  const docs: any[] = Array.isArray(v.documents) ? v.documents : [];
  const hasPpi = docs.find((d) => d.type === "ppi");
  if (hasPpi) lines.push(`🔧 PPI on file — debt: ${fmt$(hasPpi.maintenanceDebt || 0)}`);
  else lines.push(`🔧 No PPI on file`);

  return lines.join("\n");
}

// ── Detect which vehicle the user is asking about ───────────────────────────
function matchVehicle(message: string, vehicles: any[]): any | null {
  if (!message) return null;
  const msg = message.toLowerCase();
  
  let bestMatch: any = null;
  let bestScore = 0;
  
  for (const v of vehicles) {
    let score = 0;
    const year = String(v.year || "");
    const model = (v.model || "").toLowerCase();
    const trim = (v.trim || "").toLowerCase();
    const make = (v.make || "").toLowerCase();
    const loc = (v.location || "").toLowerCase();
    const seller = (v.seller_name || "").toLowerCase();
    
    // Year match
    if (year && msg.includes(year)) score += 3;
    // Model match
    if (model && msg.includes(model)) score += 2;
    // Trim match (e.g. "heritage")
    if (trim && msg.includes(trim)) score += 4;
    // Make match
    if (make && msg.includes(make)) score += 1;
    // Location match (city/state)
    if (loc) {
      const parts = loc.split(/[,\s]+/).filter(Boolean);
      for (const p of parts) {
        if (p.length > 2 && msg.includes(p.toLowerCase())) { score += 3; break; }
      }
    }
    // Seller name match
    if (seller && seller.length > 3 && msg.includes(seller)) score += 3;
    // "#1" or "top pick" or "my first" → rank 1
    if (/\b(#1|number one|top pick|first pick|my first)\b/.test(msg) && v.status === "focus") score += 2;
    // Mileage mention
    if (v.mileage) {
      const mStr = v.mileage.toLocaleString();
      const mShort = Math.round(v.mileage / 1000) + "k";
      if (msg.includes(mStr) || msg.includes(mShort)) score += 2;
    }
    // Any mention of carfax/service + a vehicle with carfax data → boost
    if (/carfax|service|maintenance|history|record/i.test(msg) && v.carfax_data && Object.keys(v.carfax_data).length > 0) {
      score += 2;
    }
    
    if (score > bestScore) { bestScore = score; bestMatch = v; }
  }
  
  return bestScore >= 2 ? bestMatch : null;
}

// ── Build full Board context for system prompt ──────────────────────────────
async function buildBoardContext(userMessage: string, history?: Array<{role: string; content: string}>): Promise<string> {
  const { data: vehicles } = await supabaseAdmin
    .from("watchlist_vehicles")
    .select("*")
    .not("status", "eq", "passed")
    .order("created_at", { ascending: false });

  const { data: leads } = await supabaseAdmin
    .from("scout_leads")
    .select("*")
    .eq("status", "new")
    .order("created_at", { ascending: false })
    .limit(10);

  const { data: removed } = await supabaseAdmin
    .from("watchlist_vehicles")
    .select("id, year, make, model, price, mileage, status, notes, updated_at")
    .eq("status", "passed")
    .order("updated_at", { ascending: false })
    .limit(10);

  const lines: string[] = [];
  const allVehicles = vehicles || [];
  const focus = allVehicles.filter((v: any) => v.status === "focus");
  const watching = allVehicles.filter((v: any) => v.status === "watching" || (!v.status));

  // ── Detect which vehicle user is asking about → inject deep dossier ──
  // Check current message first, then scan last 3 user messages from history
  // so follow-up questions ("what about the 86k service?") keep context
  let targetVehicle = matchVehicle(userMessage, allVehicles);
  if (!targetVehicle && Array.isArray(history)) {
    const recentUserMsgs = history
      .filter(m => m.role === 'user' && m.content)
      .slice(-3)
      .reverse();
    for (const msg of recentUserMsgs) {
      targetVehicle = matchVehicle(msg.content, allVehicles);
      if (targetVehicle) break;
    }
  }
  if (targetVehicle) {
    lines.push(buildDeepDossier(targetVehicle));
    lines.push(`\n(Deep dossier injected for the vehicle above. All other vehicles shown as summaries.)\n`);
  }

  // ── FOCUS section (thin summaries, skip target if already shown deep) ──
  if (focus.length > 0) {
    lines.push(`\n═══ FOCUS (${focus.length} vehicles — buyer's priority order) ═══`);
    focus.forEach((v: any, i: number) => {
      if (targetVehicle && v.id === targetVehicle.id) {
        lines.push(`#${i+1}: ⬆ SEE DEEP DOSSIER ABOVE`);
      } else {
        lines.push(buildVehicleSummary(v, i + 1));
      }
    });
  }

  if (watching.length > 0) {
    lines.push(`\n═══ WATCHING (${watching.length}) ═══`);
    watching.forEach((v: any) => {
      if (targetVehicle && v.id === targetVehicle.id) {
        lines.push(`⬆ SEE DEEP DOSSIER ABOVE`);
      } else {
        lines.push(buildVehicleSummary(v));
      }
    });
  }

  const scoutLeads = leads || [];
  if (scoutLeads.length > 0) {
    lines.push(`\n═══ INBOX (${scoutLeads.length} new) ═══`);
    scoutLeads.forEach((l: any) => {
      const ri = l.raw_intel || {};
      const trim = l.trim ? ` ${l.trim}` : "";
      const dom = ri.dom_active ? ` | ${ri.dom_active}d listed` : "";
      const dealer = ri.dealer_name ? ` | ${ri.dealer_name}` : "";
      const title = ri.carfax_clean_title === true ? " | ✅ clean title" : "";
      const owner = ri.carfax_1_owner === true ? " | 1-owner" : "";
      const score = l.shadow_score ? ` | score: ${l.shadow_score}` : "";
      lines.push(`🆕 ${l.year} ${l.make} ${l.model}${trim} — ${l.price ? fmt$(l.price) : "?"} | ${l.mileage ? l.mileage.toLocaleString() + " mi" : "? mi"} | ${l.location || "?"}${dom}${dealer}${title}${owner}${score}`);
    });
  }

  const removedVehicles = removed || [];
  if (removedVehicles.length > 0) {
    lines.push(`\n═══ REMOVED ═══`);
    removedVehicles.forEach((v: any) => {
      lines.push(`❌ ${v.year} ${v.make} ${v.model} — ${v.price ? fmt$(v.price) : ""} | "${v.notes || "no reason"}"`);
    });
  }

  return lines.join("\n");
}

// ── System prompt ───────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are WrenchCheck's Advisor — a single, persistent AI broker for a buyer actively shopping for a 2018-2021 Toyota Land Cruiser. Today is ${TODAY}.

You are the buyer's broker. You know everything: every car they're tracking, every car they passed on and why, their preferences, their budget, the market. You're one person, one conversation — they come to you for everything.

━━━━━━━━━━━━━━━━━━━━━━━━
YOUR ROLE
━━━━━━━━━━━━━━━━━━━━━━━━

You replace six separate tools with one brain:
- Per-car analysis (Navigator) → you already know every car on their board
- Morning briefing → you open with what's changed since they were last here
- Ranking analysis → they say "analyze my rankings" and you challenge their order
- Search configuration → they say "run the scout" or "find me more like the Heritage"
- Preference capture → they say "I want Terra interior" and you remember it
- TCO/market intel → they ask and you deliver, for any car on their board

━━━━━━━━━━━━━━━━━━━━━━━━
FORMATTING RULES (CRITICAL)
━━━━━━━━━━━━━━━━━━━━━━━━

Your responses must be visually structured and scannable:

1. Use markdown **bold** for emphasis and key terms
2. Use markdown headers (##) for major section breaks
3. Use emoji section headers: 🧠 🔥 💰 🚨 🏁 💬 🔍 📊 ⚙️
4. Use "---" for horizontal rules between major sections
5. Use ✅ for positives, ⚠️ for warnings, ❌ for deal-breakers
6. Use 👉 for key takeaways, 💥 for final price recommendations
7. Short lines — NEVER dense paragraphs. One idea per line.
8. Leave blank lines between sections for breathing room
9. When comparing vehicles, use 1️⃣ 2️⃣ 3️⃣ numbered format

━━━━━━━━━━━━━━━━━━━━━━━━
VOICE
━━━━━━━━━━━━━━━━━━━━━━━━

- Sharp, direct, opinionated. "Not even close" / "Only if priced aggressively" / "I'd walk."
- Specific always: "$69K–71K" not "low 70s". "90k timing belt: $800–1,200" not "maintenance costs."
- You're their friend who knows cars, not a chatbot writing a report.
- Don't open with filler ("Great question!", "So", "Well", "Absolutely"). Jump straight to the insight.
- Absorb everything they say. If they mention Terra interior once, you remember it forever.

━━━━━━━━━━━━━━━━━━━━━━━━
KNOWLEDGE (Land Cruiser 200-series)
━━━━━━━━━━━━━━━━━━━━━━━━

- Timing belt + water pump at 90k: $800–1,200 dealer, $500–700 indie
- Rear diff fluid every 30k: ~$150 · Front diff + transfer case: ~$200
- Knuckle repack service: $600–900 if neglected
- 4x4 actuator: ~$400 failure mode · KDSS: $1,500+ if leaking
- Secondary air injection system: ~$300–500
- Brakes all 4 corners: $800–1,200

Market:
- 200-series peaked $80–100k (2021-22 COVID), now $65–90k
- 2021 Heritage Edition: $75–95k, highest demand
- BaT is the gold standard for sold comps
- Clean 1-owner under 60k mi = full premium
- Each accident: -$3–8k · Each extra owner: -$2–4k
- Rust belt (OH/MI/PA/NY/IL): -$3–5k vs Sun Belt
- LC200 production ended 2021. Finite supply. Floor holding at $65k clean.

━━━━━━━━━━━━━━━━━━━━━━━━
ON FIRST MESSAGE (opening the conversation)
━━━━━━━━━━━━━━━━━━━━━━━━

If the buyer opens with no specific question, give a morning check-in:
- What's changed since last time (price drops, new leads, stale listings)
- One sharp observation about their current #1 pick
- One proactive suggestion (e.g. "the 2019 in CO has been sitting 30d — call now")

Format it as: "🧠 Morning Check-in — [Date]"

━━━━━━━━━━━━━━━━━━━━━━━━
ON SPECIFIC CAR QUESTIONS
━━━━━━━━━━━━━━━━━━━━━━━━

ADAPTIVE RESPONSE LENGTH:
- Simple question ("how long has it been listed?") → sharp 2-3 line answer
- Targeted question ("what should I offer?") → focused section, 5-8 lines
- Open-ended ("tell me about the Heritage" / "analyze this car") → full brief

Full brief format (ONLY for open-ended car analysis):
1. 🧠 **The Truck** — quick profile with ✅/⚠️/❌
2. 🔥 **My Take** — verdict, sharp and direct
3. ⚙️ **Maintenance Reality** — items due at this mileage with $ amounts
4. 🚨 **The Hidden Insight** — one non-obvious thing
5. 💰 **Price Reality** — what it's worth and what to offer
6. 🏁 **What I'd Do** — next 24 hours

Do NOT use the full brief format for every question. Match depth to the ask.

━━━━━━━━━━━━━━━━━━━━━━━━
ON COMPARISONS
━━━━━━━━━━━━━━━━━━━━━━━━

When comparing vehicles, use the numbered format:
1️⃣ [car] — ✅/⚠️ bullet points
2️⃣ [car] — ✅/⚠️ bullet points

Then: 🔥 Brutal Ranking with 🥇 🥈 🥉
Then: 🚨 The Hidden Insight
Then: 💰 Price sanity check for each

━━━━━━━━━━━━━━━━━━━━━━━━
ON TCO QUESTIONS
━━━━━━━━━━━━━━━━━━━━━━━━

📊 Year 1 → Year 2 → Year 3 breakdown with specific items and costs.
End with: 💥 Total 3-Year Cost: $XX,XXX · True Cost Per Mile: $X.XX

━━━━━━━━━━━━━━━━━━━━━━━━
WHAT YOU CAN REFERENCE
━━━━━━━━━━━━━━━━━━━━━━━━

You have the buyer's FULL Board state injected below. You can reference:
- Any car by year/model/location shorthand (e.g. "the Heritage", "the CO 2019")
- Their Focus ranking order (it's their priority — challenge it if warranted)
- Removed cars and why they were removed
- Inbox leads and whether they match buyer criteria
- Price velocity and seller motivation signals

When the buyer asks about a SPECIFIC vehicle, you get a DEEP DOSSIER injected including:
- Full CarFax service history (every line item with date, mileage, description, location)
- AI audit data (watchouts, cost exposures, TCO estimates)
- Seller intelligence (motivation, negotiation approach)
- Photo condition intel
- Price velocity timeline

CRITICAL: When the buyer asks about a specific service record (e.g. "the 86,500 mile service"), 
look in the FULL SERVICE HISTORY section of the deep dossier. Reference the EXACT line item — 
date, mileage, what was done, where. Then give your opinion on whether the service was adequate,
what else should have been done at that mileage, and what it tells you about the owner.

If there is NO CarFax on file, say so explicitly and explain what that means for risk.

━━━━━━━━━━━━━━━━━━━━━━━━
NEVER DO
━━━━━━━━━━━━━━━━━━━━━━━━

- Never write dense paragraphs
- Never say "it really depends"
- Never repeat data back — get to the INSIGHT
- Never be generic — every sentence specific to THIS buyer's board
- Never forget what the buyer told you in previous messages
- Never make up service records. Only reference data from the ACTUAL injected dossier.
- Never give generic maintenance advice when you have specific CarFax data — USE THE DATA.`;

// ── POST handler ────────────────────────────────────────────────────────────
export async function POST(req: Request) {
  const body = await req.json();
  const {
    message,       // current user message (empty string on first open)
    history,       // previous messages in this session [{role, content}]
    buyerProfile,  // { interior_color, budget_ceiling, max_mileage, ... }
    files,         // optional: [{ name, type, dataUrl }] — images or PDFs
  } = body;

  // Build full board context — detects which vehicle user is asking about
  // and injects deep dossier (CarFax, AI audit, seller intel) for that vehicle
  const boardContext = await buildBoardContext(message || "", history);

  // Build buyer profile context
  const profileEntries = Object.entries(buyerProfile || {}).filter(([, v]) => v);
  const profileContext = profileEntries.length > 0
    ? `\n\n═══ BUYER PROFILE ═══\n` +
      profileEntries.map(([k, v]) => `  • ${(k as string).replace(/_/g, " ")}: ${v}`).join("\n") +
      `\nApply these preferences naturally. If a car conflicts, flag it.`
    : "";

  const messages: any[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "system", content: `═══ CURRENT BOARD STATE (live data) ═══\n${boardContext}${profileContext}` },
  ];

  // Replay conversation history
  if (Array.isArray(history)) {
    for (const msg of history) {
      messages.push({ role: msg.role, content: msg.content });
    }
  }

  // Add current message — with file attachments if present
  const fileAttachments: Array<{ name: string; type: string; dataUrl: string }> = Array.isArray(files) ? files : [];
  
  if (message || fileAttachments.length > 0) {
    if (fileAttachments.length > 0) {
      // Build multimodal content parts for gpt-4o vision
      const contentParts: any[] = [];
      
      for (const file of fileAttachments) {
        if (file.type.startsWith('image/')) {
          // Images: send as vision content
          contentParts.push({
            type: "image_url",
            image_url: { url: file.dataUrl, detail: "high" },
          });
        } else if (file.type === 'application/pdf') {
          // PDFs: extract text and inject as context
          try {
            const base64Data = file.dataUrl.split(',')[1];
            const pdfBuffer = Buffer.from(base64Data, 'base64');
            const pdfParse = (await import('pdf-parse')).default;
            const parsed = await pdfParse(pdfBuffer);
            const pdfText = parsed.text?.slice(0, 15000) || '[PDF could not be parsed]';
            contentParts.push({
              type: "text",
              text: `═══ UPLOADED PDF: ${file.name} ═══\n${pdfText}\n═══ END PDF ═══`,
            });
          } catch (e) {
            contentParts.push({
              type: "text",
              text: `[Failed to parse PDF: ${file.name}]`,
            });
          }
        }
      }
      
      // Add the user's text message
      if (message) {
        contentParts.push({ type: "text", text: message });
      } else {
        contentParts.push({ type: "text", text: "Please analyze the attached file(s)." });
      }
      
      messages.push({ role: "user", content: contentParts });
    } else {
      messages.push({ role: "user", content: message });
    }
  } else if (!history || history.length === 0) {
    // First open — trigger morning check-in
    messages.push({
      role: "user",
      content: "I just opened WrenchCheck. Give me your morning check-in — what's changed, what should I focus on, any new leads worth my time? Be specific to my actual board.",
    });
  }

  // ── Stream ────────────────────────────────────────────────────────────────
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        const completion = await openai.chat.completions.create({
          model: "gpt-4o",
          messages,
          stream: true,
          temperature: 0.72,
          max_tokens: 3500,
        });

        for await (const chunk of completion) {
          const delta = chunk.choices[0]?.delta?.content ?? "";
          if (delta) {
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify({ type: "delta", content: delta })}\n\n`)
            );
          }
        }

        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ type: "done" })}\n\n`)
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
