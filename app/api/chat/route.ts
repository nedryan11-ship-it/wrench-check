import { NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase";
import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ─── Model config ─────────────────────────────────────────────────────────────
// ADVISOR_MODEL: all user-visible advisor / buyer-decision responses.
// EXTRACTION_MODEL: background JSON parsing only — never user-facing.
const ADVISOR_MODEL    = "gpt-4o" as const;
const EXTRACTION_MODEL = "gpt-4o-mini" as const;

// ─── Google Places tool ─────────────────────────────────────────────────────
async function searchShops(query: string, location: string): Promise<string> {
  const key = process.env.GOOGLE_PLACES_API_KEY;
  if (!key) return JSON.stringify({ error: "Places API key not configured" });
  const url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(`${query} near ${location}`)}&key=${key}`;
  try {
    const res = await fetch(url);
    const data = await res.json();
    if (data.status !== "OK" && data.status !== "ZERO_RESULTS") return JSON.stringify({ error: data.status });
    const results = (data.results || []).slice(0, 4).map((p: any) => ({
      name: p.name, rating: p.rating || null,
      review_count: p.user_ratings_total || null,
      address: p.formatted_address || p.vicinity || null,
      place_id: p.place_id,
    }));
    return JSON.stringify(results.length ? results : { message: "No shops found." });
  } catch {
    return JSON.stringify({ error: "Failed to reach Places API" });
  }
}

const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "search_shops",
      description: "Search for auto repair shops near a location. Use whenever user asks about alternatives, other mechanics, or where else to take their car.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: 'Shop type, e.g. "auto repair shop", "BMW specialist"' },
          location: { type: "string", description: 'City or zip code. Ask user if unknown.' },
        },
        required: ["query", "location"],
      },
    },
  },
];

// ─── Route handler ──────────────────────────────────────────────────────────
export async function POST(req: Request) {
  try {
    const { case_id, user_message, report, followUps, cleared_before, analysis_version } = await req.json();
    if (!case_id || !user_message) return NextResponse.json({ error: "Missing required fields" }, { status: 400 });

    // 1. Save user message
    await supabase.from("messages").insert({ case_id, role: "user", content: user_message });

    // 2. Fetch history
    const { data: caseData } = await supabase.from("cases").select("*").eq("id", case_id).single();
    let histQuery = supabase.from("messages").select("*").eq("case_id", case_id).order("created_at", { ascending: true });
    if (cleared_before) histQuery = histQuery.gt("created_at", cleared_before);
    const { data: history } = await histQuery;

    // 3. Build context from either rich format or legacy report
    const richCtx = (typeof report === "object" && report?.services) ? report : null;

    const vehicle = richCtx?.vehicle ||
      (caseData ? `${caseData.vehicle_year || ""} ${caseData.vehicle_make || ""} ${caseData.vehicle_model || ""}`.trim() : "Unknown vehicle") ||
      "Unknown vehicle";

    const shopCity = caseData?.shop_city || caseData?.shop_address || null;
    const shopName = richCtx?.shop?.name || caseData?.shop_name || "Unknown shop";
    const shopGrade = richCtx?.shop?.grade || "?";
    const shopRating = richCtx?.shop?.rating || "?";

    const buildLines = (items: any[], tier: string) =>
      (items || []).map((item: any) => {
        const high = item.market_range?.high || 0;
        const delta = high > 0 ? Math.round(item.price - high) : 0;
        const deltaStr = delta > 0 ? `$${delta} above typical` : delta < 0 ? `$${Math.abs(delta)} below typical` : "at market";
        const rec = tier === "red" ? "Needs pushback" : tier === "yellow" ? "Worth confirming" : "Looks fair";
        const urgency = item.urgency === "High" ? "urgent" : item.urgency === "Low" ? "not urgent" : "moderate";
        return `  • ${item.normalized_name !== "Uncategorized Service" ? item.normalized_name : item.raw_text}: $${item.price} (${deltaStr}) | typical $${item.market_range?.low || "?"}–$${high || "?"} | ${urgency} | ${rec}`;
      }).join("\n");

    // Build service summary from rich context
    const serviceLines = richCtx?.services?.length
      ? richCtx.services.map((s: any) => {
          const delta = s.delta ?? 0;
          const deltaStr = delta > 20 ? `$${delta} OVER MARKET 🔴` : delta < -20 ? `below market 🔵` : `fair price 🟢`;
          const market = (s.marketLow && s.marketHigh) ? `market $${s.marketLow}–$${s.marketHigh}` : "no market data";
          const qt = s.quickTake ? ` | insight: "${s.quickTake}"` : "";
          return `  • ${s.name}: $${s.price} (${deltaStr}, ${market}, urgency: ${s.decision})${qt}`;
        }).join("\n")
      : buildLines(report?.red || [], "red") + "\n" + buildLines(report?.yellow || [], "yellow") + "\n" + buildLines(report?.green || [], "green");

    const followUpLines = followUps && Object.keys(followUps).length > 0
      ? Object.values(followUps).filter((fu: any) => fu.input?.notes?.trim() || fu.result)
          .map((fu: any) => {
            const l = [`  • ${fu.itemName}:`];
            if (fu.input?.notes?.trim()) l.push(`    - Notes: "${fu.input.notes.trim()}"`);
            if (fu.result) l.push(`    - Prior verdict: ${fu.result.verdict}`);
            return l.join("\n");
          }).join("\n")
      : null;

    // Build vehicle watchout intelligence block from enhanced watchout data
    const rawWatchouts: any[] = richCtx?.vehicleWatchouts ?? richCtx?.vehicle_intelligence?.known_watchouts ?? [];
    const negotiationAngle = richCtx?.vehicle_intelligence?.negotiationAngle ?? null;

    const watchoutBlock = rawWatchouts.length > 0
      ? `## VEHICLE PLATFORM INTELLIGENCE — ${vehicle}
The following are known issues for this exact platform. Use them to guide your advice.

${rawWatchouts.slice(0, 4).map((w: any) => {
        const sev = (w.severity ?? "").toLowerCase().includes("critical") ? "SAFETY CRITICAL"
          : (w.severity ?? "").toLowerCase().includes("high") || (w.relevance === "high") ? "HIGH"
          : "MEDIUM";
        const ev = w.evidenceStatus ?? w.relevance ?? "unknown";
        const evLabel = ev === "present" ? "✅ service IS in estimate"
          : ev === "missing" ? "❌ NO supporting service in estimate — elevated concern"
          : ev === "not_yet_relevant" ? "⏳ not yet relevant at this mileage"
          : ev === "missing_evidence" ? "❌ NO supporting service in estimate — elevated concern"
          : "⚠️ ambiguous — verify";
        const insight = w.insight ?? "";
        return `  • [${sev}] ${w.issue ?? w.title}: ${w.description ?? ""}
    Evidence: ${evLabel}
    ${insight ? `Insight: ${insight}` : ""}`;
      }).join("\n")}
${negotiationAngle ? `\nLEVERAGE: ${negotiationAngle}` : ""}

RULES FOR USING THIS:
- If severity is HIGH and evidence is MISSING → explicitly name the issue and treat as real risk
- If severity is HIGH and evidence is PRESENT → acknowledge it's addressed, reduce alarm
- If not yet relevant → mention it's something to monitor, not a current concern
- Reference 1–2 watchouts max per response — do not dump all of them
- Connect watchouts directly to services on the estimate when relevant`
      : `## VEHICLE PLATFORM INTELLIGENCE
No platform-specific watchout data available. Rely on estimate context only.`;


    const systemPrompt = `You are the WrenchCheck Strategic Advisor — decisive, specific, financially protective.

Your ONLY job: move the user from uncertainty to a clear next action.

## ESTIMATE CONTEXT
Vehicle: ${vehicle}
Shop: ${shopName} | Grade: ${shopGrade} | Rating: ${shopRating}/5 | Location: ${shopCity || "Unknown"}

## SERVICES ON ESTIMATE
${serviceLines || "No services on file."}

${followUpLines ? `\nPreviously confirmed with shop:\n${followUpLines}` : ""}

${watchoutBlock}

## RESPONSE RULES — STRICT
1. **2–4 sentences MAX**. Never longer.
2. **Start with a clear opinion** — not "it depends"
3. **Reference specific service names and dollar amounts** from the estimate above
4. **End with a specific next action** the user can take right now
5. **NO**: generic advice, restating the question, explaining how cars work
6. **YES**: specific numbers, specific service names, specific watchout-informed action
7. **When a HIGH-severity watchout has missing evidence**: name the issue explicitly and elevate concern
8. **When evidence IS present for a watchout**: reduce alarm, confirm the scope covers it

## DECISION TREE (internal — don't narrate)
VERIFY → STRATEGY → ACTION

## COPY-PASTE SCRIPTS
When user asks what to say: give exact verbatim words in quotes.

## EXAMPLE STYLE (match exactly)
"I wouldn't rush into both.

The transmission service is low urgency at a fair price — you can defer.

The power steering is priced $96 above market and the necessity is unclear.

Ask them: 'Can you confirm what you found — contamination, or is this mileage-based?'"
`;


    // 4. Build messages
    const messagesPayload: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      { role: "system", content: systemPrompt },
      ...(history || []).filter((m: any) => m.role !== "system").map((m: any) => ({ role: m.role as "user" | "assistant", content: m.content })),
    ];

    // 5. Conversational call (with tool loop)
    let completion = await openai.chat.completions.create({
      model: ADVISOR_MODEL,
      messages: messagesPayload,
      tools,
      tool_choice: "auto",
      temperature: 0.25,
      max_tokens: 350,
    });

    let responseMessage = completion.choices[0].message;

    while (responseMessage.tool_calls && responseMessage.tool_calls.length > 0) {
      messagesPayload.push(responseMessage as OpenAI.Chat.Completions.ChatCompletionMessageParam);
      for (const toolCall of responseMessage.tool_calls) {
        if (!("function" in toolCall)) continue;
        let result = "";
        if (toolCall.function.name === "search_shops") {
          const args = JSON.parse(toolCall.function.arguments);
          result = await searchShops(args.query, args.location);
        } else {
          result = JSON.stringify({ error: `Unknown tool: ${toolCall.function.name}` });
        }
        messagesPayload.push({ role: "tool", tool_call_id: toolCall.id, content: result });
      }
      completion = await openai.chat.completions.create({
        model: ADVISOR_MODEL, messages: messagesPayload, tools, tool_choice: "auto", temperature: 0.25, max_tokens: 350,
      });
      responseMessage = completion.choices[0].message;
    }

    const reply = responseMessage.content?.trim() || "I wasn't able to generate a response — please try again.";

    // 6. Card state extraction (fast, structured, runs in parallel with save)
    const flaggedServices = [
      ...buildLines(report?.red || [], "red").split("\n").filter(Boolean),
      ...buildLines(report?.yellow || [], "yellow").split("\n").filter(Boolean),
    ].join("\n");

    const [saveResult, extractionResult] = await Promise.all([
      supabase.from("messages").insert({ case_id, role: "assistant", content: reply }),
      openai.chat.completions.create({
        model: EXTRACTION_MODEL,  // background card-state extraction — not user-facing
        messages: [
          {
            role: "system",
            content: `You extract a structured card update from a car repair advisor conversation.
Return JSON with this exact shape:
{
  "card_update": null | {
    "state": "pause" | "proceed" | "wait" | "reconsider",
    "headline": string,
    "subheadline": string,
    "reasoning": string,
    "whatIdDo": string,
    "nextBestAction": string
  }
}

State definitions:
- pause: still needs more clarity before deciding
- proceed: real finding, leak, safety issue — this needs attention now
- wait: mileage-based, routine, not urgent — safe to postpone
- reconsider: vague explanation, couldn't justify, suspicious — do not approve yet

Return null for card_update if the message is a greeting, general question, or doesn't contain new decision-relevant info from the shop.

Flagged services context:
${flaggedServices || "No flagged services."}`,
          },
          { role: "user", content: `User said: "${user_message}"\nAdvisor replied: "${reply}"` },
        ],
        response_format: { type: "json_object" },
        temperature: 0,
        max_tokens: 300,
      }),
    ]);

    let card_update = null;
    try {
      const extracted = JSON.parse(extractionResult.choices[0].message.content || "{}");
      card_update = extracted.card_update || null;
    } catch { /* non-fatal */ }

    return NextResponse.json({ reply, card_update });

  } catch (error: any) {
    console.error("Chat API Error:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
