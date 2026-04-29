import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// POST /api/hunt/analyze-watchlist
// Receives the full ranked list + buyer profile → challenges the ordering conversationally
export async function POST(req: Request) {
  const body = await req.json();
  const {
    rankedIds,       // string[] — vehicle IDs in user-defined order
    buyerProfile,    // { interior_color?, max_mileage?, year_range?, notes? }
    userReply,       // optional — user's response to a previous challenge
    history,         // optional — previous conversation in this analysis session
  } = body;

  if (!rankedIds || rankedIds.length === 0) {
    return NextResponse.json({ error: "No vehicles provided" }, { status: 400 });
  }

  // Fetch all vehicle data for ranked IDs
  const { data: vehicles, error } = await supabaseAdmin
    .from("watchlist_vehicles")
    .select("id, title, year, make, model, mileage, price, market_mid, has_accident, owner_count, score, confidence_pct, tier, location, days_on_market, status, initial_price, notes, carfax_data")
    .in("id", rankedIds);

  if (error || !vehicles) {
    return NextResponse.json({ error: error?.message || "Failed to fetch vehicles" }, { status: 500 });
  }

  // Sort by user-defined rank
  const vehicleMap: Record<string, any> = {};
  vehicles.forEach(v => { vehicleMap[v.id] = v; });
  const ranked = rankedIds.map((id: string) => vehicleMap[id]).filter(Boolean);

  // Build vehicle summary for each ranked car
  function summarize(v: any, rank: number): string {
    const price = v.price ? `$${v.price.toLocaleString()}` : "unknown price";
    const mkt = v.market_mid ? `(market mid $${v.market_mid.toLocaleString()})` : "";
    const mi = v.mileage ? `${v.mileage.toLocaleString()} mi` : "unknown mileage";
    const acc = v.has_accident === false ? "clean history" : v.has_accident === true ? "ACCIDENT REPORTED" : "unknown history";
    const owners = v.owner_count ? `${v.owner_count} owner${v.owner_count > 1 ? 's' : ''}` : "unknown owners";
    const dom = v.days_on_market ? `${v.days_on_market}d on market` : "";
    const loc = v.location || "";
    const carfax = v.carfax_data && Object.keys(v.carfax_data).length > 0
      ? `CarFax: ${v.carfax_data.owners ?? '?'} owners, ${v.carfax_data.accidents ?? '?'} accidents, title: ${v.carfax_data.clean_title ?? 'unknown'}`
      : "No CarFax uploaded";
    const notes = v.notes ? `User notes: "${v.notes}"` : "";
    const score = v.score ? `WrenchScore ${v.score}/100` : "unscored";
    const delta = v.price && v.market_mid
      ? v.price < v.market_mid
        ? `$${(v.market_mid - v.price).toLocaleString()} below market`
        : `$${(v.price - v.market_mid).toLocaleString()} above market`
      : "";
    return `#${rank}: ${v.year} ${v.make} ${v.model} — ${price} ${mkt} ${delta} | ${mi} | ${acc} | ${owners} | ${dom} ${loc} | ${score} | ${carfax} ${notes}`.trim();
  }

  const rankedSummary = ranked.map((v: any, i: number) => summarize(v, i + 1)).join("\n");

  const profileLines = Object.entries(buyerProfile || {})
    .filter(([, v]) => v)
    .map(([k, v]) => `  • ${k.replace(/_/g, " ")}: ${v}`)
    .join("\n");

  const systemPrompt = `You are a sharp, direct automotive analyst reviewing a car buyer's ranked watchlist.
Your job: challenge their ordering based on the data. Be a second opinion, not a cheerleader.

━━━━━━━━━━━━━━━━━━━━━━━━
FORMATTING (follow exactly)
━━━━━━━━━━━━━━━━━━━━━━━━

Use this visual structure:
- Emoji section headers: 🧠 🔥 🚨 💬
- Use "⸻" between major sections
- Use ✅ for positives, ⚠️ for warnings, ❌ for deal-breakers
- Use 👉 for key takeaways
- Short lines — never dense paragraphs
- Use 💥 for the sharpest point

Example format:

🧠 Your Ranking

1️⃣ [car] — ✅ clean ⚠️ high miles
2️⃣ [car] — ⚠️ accident ✅ great price

⸻

🔥 Where I'd Push Back

[Specific challenge with numbers]

👉 [One pointed question]

━━━━━━━━━━━━━━━━━━━━━━━━
RULES
━━━━━━━━━━━━━━━━━━━━━━━━

- Reference actual numbers: price, mileage, accident history, CarFax, market delta
- Identify 1-2 most surprising ranking decisions. Don't critique everything.
- Ask one pointed question at the end. The answer reveals their priorities.
- Never generic. Every sentence specific to THIS list.
- If their ordering makes sense, say so — then find one thing to probe.

On follow-up: absorb what they tell you. Either agree and shift to a new question, or push back with the math.`;

  const contextMsg = `BUYER'S RANKED WATCHLIST (their priority order, #1 = highest priority):
${rankedSummary}

${profileLines ? `BUYER PROFILE / STATED PREFERENCES:\n${profileLines}` : "No buyer profile on file."}`;

  const messages: any[] = [
    { role: "system", content: systemPrompt },
    { role: "system", content: contextMsg },
  ];

  // Add conversation history if this is a follow-up
  if (Array.isArray(history) && history.length > 0) {
    messages.push(...history);
  }

  // Add current user message
  if (userReply) {
    messages.push({ role: "user", content: userReply });
  }

  // Stream the response
  const stream = await openai.chat.completions.create({
    model: "gpt-4o",
    messages,
    stream: true,
    max_tokens: 1500,
    temperature: 0.7,
  });

  const encoder = new TextEncoder();
  const readable = new ReadableStream({
    async start(controller) {
      for await (const chunk of stream) {
        const text = chunk.choices[0]?.delta?.content || "";
        if (text) controller.enqueue(encoder.encode(text));
      }
      controller.close();
    },
  });

  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
    },
  });
}
