import { NextResponse } from "next/server";
import OpenAI from "openai";
import { supabaseAdmin as supabase } from "@/lib/supabase";

// ─── Model config ─────────────────────────────────────────────────────────────
const ADVISOR_MODEL = "gpt-4o";
const DEV = process.env.NODE_ENV === "development";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ─── Types ────────────────────────────────────────────────────────────────────
export interface ServicePayload {
  id: string;
  name: string;
  price?: number | null;
  marketMin?: number | null;
  marketMax?: number | null;
  deltaLabel?: string | null;
  status?: string;
  decision?: string;
  analysis?: {
    quickTake?: string;
    worstCase?: string;
    whenItMatters?: string[];
    whyShopsRecommend?: string[];
    whatIdDo?: string;
    whatToSay?: string;
  };
}

export interface AdvisorRequest {
  case_id: string;
  conversation: Array<{ role: "user" | "assistant"; content: string }>;
  vehicle?: { year?: string; make?: string; model?: string; trim?: string };
  vehicle_intelligence?: {
    known_watchouts?: string[];
    related_current_services?: string[];
  };
  shop?: {
    name?: string;
    rating?: number;
    grade?: string;
    summary?: string;
    specialization?: string;
  };
  services: ServicePayload[];
  current_focus_service_id?: string | null;
  user_goal?: "decide" | "negotiate" | "pressure_test" | "understand_service" | "shop_around" | null;
  // ── Maintenance Buyer Mode ─────────────────────────────────────────────────
  mode?: "maintenance_buyer";
  maintenanceContext?: {
    verdict: string;
    debtEstimateLow?: number | null;
    debtEstimateHigh?: number | null;
    debtItems: Array<{
      displayName: string;
      status: string;
      overdueMiles?: number | null;
      severity: string;
      reasoning: string;
      estimatedCostLow?: number | null;
      estimatedCostHigh?: number | null;
    }>;
  };
}

export type NegotiationLevel = "easy_ask" | "clarify" | "price_match" | "bundle" | "walk_away";

export interface AdvisorResponse {
  mode: "advisor";
  current_step: "VERIFY" | "STRATEGY" | "ACTION";  // which decision phase the user is in
  headline: string;
  recommendation: string;
  reasoning: string[];
  next_step: string;
  done_when: string;   // completion condition — when is this step "done"
  shop_script: string;
  follow_up_options: string[];
}

export interface NegotiationResponse {
  mode: "negotiation";
  headline: string;
  negotiation_level: NegotiationLevel;
  recommendation: string;
  reasoning: string[];
  shop_script: string;
  backup_script: string;
  follow_up_options: string[];
  leverage_score?: number;     // 0–1 how much negotiation leverage user has
}

export type StructuredResponse = AdvisorResponse | NegotiationResponse;

// ─── Fallback response (section 9) ────────────────────────────────────────────
const FALLBACK_RESPONSE: AdvisorResponse = {
  mode: "advisor",
  current_step: "VERIFY",
  headline: "Let's take a closer look",
  recommendation: "Ask the shop what triggered this recommendation.",
  reasoning: ["Details are unclear from the estimate"],
  next_step: "Ask the shop what specifically made this necessary right now.",
  done_when: "Once they explain what triggered the recommendation, you'll know whether to proceed.",
  shop_script: "Can you explain what specifically made this necessary right now?",
  follow_up_options: ["What should I do next?", "What do I say to the shop?", "Can I wait on this?"],
};

// ─── Negotiation detection ────────────────────────────────────────────────────
function isNegotiationGoal(goal?: string | null, lastMsg?: string): boolean {
  if (goal === "negotiate") return true;
  if (!lastMsg) return false;
  const lc = lastMsg.toLowerCase();
  return (
    lc.includes("negotiat") ||
    lc.includes("what should i say") ||
    lc.includes("can i get") ||
    lc.includes("come down") ||
    lc.includes("push back") ||
    lc.includes("overpriced") ||
    lc.includes("price match") ||
    lc.includes("too expensive") ||
    lc.includes("lower the price") ||
    lc.includes("discount") ||
    lc.includes("script") ||
    (goal === "pressure_test")
  );
}

// ─── Negotiation level selection (5-level ladder) ─────────────────────────────
function selectNegotiationLevel(services: ServicePayload[], lastMsg: string): NegotiationLevel {
  const lc = lastMsg.toLowerCase();

  if (lc.includes("walk away") || lc.includes("leave") || lc.includes("second opinion") || lc.includes("elsewhere")) return "walk_away";

  const activeServices = services.filter(s => s.status !== "hidden");
  const multiService = activeServices.length > 1;
  if (lc.includes("bundle") || (multiService && (lc.includes("both") || lc.includes("together") || lc.includes("labor")))) return "bundle";

  const hasAboveMarket = activeServices.some(s => {
    const high = s.marketMax ?? 0;
    return high > 0 && (s.price ?? 0) > high * 1.2;
  });
  if (hasAboveMarket && (lc.includes("price") || lc.includes("market") || lc.includes("cheaper"))) return "price_match";

  const hasUnclear = activeServices.some(s => s.decision === "verify" || s.decision === "reconsider");
  if (hasUnclear || lc.includes("why") || lc.includes("necessary") || lc.includes("needed") || lc.includes("triggered")) return "clarify";

  return "easy_ask";
}

// ─── Context block builder ────────────────────────────────────────────────────
function buildContextBlock(payload: AdvisorRequest): string {
  const { vehicle, shop, services, vehicle_intelligence, current_focus_service_id } = payload;

  const vehicleStr = vehicle
    ? [vehicle.year, vehicle.make, vehicle.model, vehicle.trim].filter(Boolean).join(" ") || "Unknown vehicle"
    : "Unknown vehicle";

  const shopLine = shop
    ? `${shop.name || "Unknown"} | Grade: ${shop.grade || "?"} | Rating: ${shop.rating ?? "?"}/5${shop.summary ? ` | ${shop.summary}` : ""}`
    : "Unknown shop";

  const serviceLines = services.length
    ? services.map(s => {
        const priceStr = s.price != null ? `$${s.price.toFixed(2)}` : "price unknown";
        const market = (s.marketMin && s.marketMax) ? `market $${s.marketMin}–$${s.marketMax}` : "no market data";
        const badge = s.deltaLabel ?? "—";
        const urgency = s.decision ?? s.status ?? "unknown";
        const focus = s.id === current_focus_service_id ? " [FOCUS]" : "";
        const qt = s.analysis?.quickTake ? `\n    take: "${s.analysis.quickTake}"` : "";
        const wid = s.analysis?.whatIdDo ? `\n    action: "${s.analysis.whatIdDo}"` : "";
        const wts = s.analysis?.whatToSay ? `\n    script: "${s.analysis.whatToSay}"` : "";
        return `  • ${s.name}${focus}: ${priceStr} (${badge}, ${market}, urgency: ${urgency})${qt}${wid}${wts}`;
      }).join("\n")
    : "  No services on file.";

  const watchouts = vehicle_intelligence?.known_watchouts?.length
    ? `\nKnown platform risks:\n${vehicle_intelligence.known_watchouts.map(w => `  • ${w}`).join("\n")}`
    : "";

  const related = vehicle_intelligence?.related_current_services?.length
    ? `\nPlatform notes on current services:\n${vehicle_intelligence.related_current_services.map(r => `  • ${r}`).join("\n")}`
    : "";

  return `VEHICLE: ${vehicleStr}
SHOP: ${shopLine}

SERVICES:
${serviceLines}${watchouts}${related}`;
}

// ─── System prompt builder ────────────────────────────────────────────────────
function buildSystemPrompt(
  payload: AdvisorRequest,
  negotiationMode: boolean,
  negotiationLevel?: NegotiationLevel
): string {
  const contextBlock = buildContextBlock(payload);

  const sharedRules = `
RESPONSE RULES (STRICT):
1. Start with a recommendation — never hedge with "it depends"
2. Include 1–3 reasons, all specific to this estimate
3. Always suggest a concrete next step
4. Include a script when the user can act on it
5. Never output generic car advice
6. Always reference specific service names and dollar amounts
7. Be concise — 2–5 sentence equivalent per field
8. Be decisive

CRITICAL — NO UI DUPLICATION:
9. The user's screen ALREADY shows: pricing deltas, market ranges, "verify/reconsider" decision labels, and service explanations.
   Do NOT repeat: "this service is overpriced", "this is above market", "you should verify this", or any information already visible in the service cards.
   Build on what they see — add strategy, sequencing, and prioritization ACROSS services.
10. Chat is the STRATEGIC layer. Service cards handle per-service detail.
    Chat must answer: What matters most right now? What should I do next? What is the smartest sequence?
11. Never produce a bulleted re-explanation of a single service. Instead, compare options, prioritize, and coach the user's next move.

SERVICE REASONING (apply per service):
- overpriced + no symptoms → challenge the recommendation, high leverage
- fair price + routine → low urgency, defer safely
- tied to known vehicle platform failure → increase urgency
- unclear necessity + above market → maximum negotiation leverage

VEHICLE INTELLIGENCE:
If Audi/BMW/Porsche/Mercedes: reference known platform failure patterns.
Always use exact dollar amounts from the estimate — never guess or approximate.

TONE:
- Calm, direct, confident
- Like a financially sharp car-savvy friend
- No filler ("great question", "certainly", "of course")
- Do NOT explain your JSON format`;

  const levelDescriptions = {
    easy_ask: "LEVEL 1 — EASY ASK: suggest coupons, discounts, or fee removal. Low confrontation.",
    clarify: "LEVEL 2 — CLARIFY: ask what triggered this recommendation, is it symptom-based or routine, request labor breakdown.",
    price_match: "LEVEL 3 — PRICE MATCH: compare to market range, request price adjustment. Include a specific dollar target.",
    bundle: "LEVEL 4 — BUNDLE: combine services to reduce overlapping labor cost. Identify which services share lift time.",
    walk_away: "LEVEL 5 — WALK AWAY: recommend second opinion, provide polite exit language, suggest what to search for.",
  };

  if (negotiationMode) {
    const levelGuidance = negotiationLevel ? levelDescriptions[negotiationLevel] : levelDescriptions.clarify;

    return `You are the WrenchCheck Strategic Advisor — a financially sharp automotive expert who helps users negotiate car repair estimates.

ESTIMATE CONTEXT:
${contextBlock}

NEGOTIATION STRATEGY:
${levelGuidance}

Output ONLY valid JSON matching this exact schema:
{
  "mode": "negotiation",
  "headline": "concise framing of the negotiation situation (1 sentence)",
  "negotiation_level": "${negotiationLevel || "clarify"}",
  "recommendation": "clear strategy — what to do and why (2-3 sentences)",
  "reasoning": ["specific reason 1", "specific reason 2"],
  "shop_script": "primary verbatim script — exact words to say or text to the shop",
  "backup_script": "alternative script if they push back or say no",
  "follow_up_options": ["next action 1", "next action 2", "next action 3"],
  "leverage_score": 0.0
}

leverage_score: 0.0–1.0. High score = strong negotiation position (above market + unclear necessity). Low = fair price, genuine issue.
Scripts must be verbatim quotable. Use specific dollar amounts. Reference service names.
Backup script should escalate or pivot if primary script fails.
${sharedRules}

Output ONLY valid JSON. No markdown. No explanation outside the JSON.`;
  }

  return `You are the WrenchCheck Decision Engine.

Your job is to guide the user through a repair decision from uncertainty to closure. The user should always know: (1) what matters most right now, (2) what the next step is, (3) when they are done.

Your role is not to explain everything. Your role is to move the user forward.

ESTIMATE CONTEXT:
${contextBlock}

DECISION FRAMEWORK — always use one of these three steps:
- VERIFY: Is this actually needed? Is it symptom-based or interval? Is there enough evidence?
- STRATEGY: Is now the right time? Is price fair? Can it wait? Is there leverage?
- ACTION: What should the user say or do right now? What exact message?

RESPONSE BEHAVIOR:
- Always anchor the user to ONE current step (VERIFY / STRATEGY / ACTION)
- Always define a clear next action — one concrete thing to do now
- Always define completion — when is this step "done for now"
- Handle ONE service at a time unless the user asks to compare or prioritize
- The page already shows pricing deltas, market ranges, and decision labels. Do NOT restate them. Build on them.
- When the user feels anxious: reduce complexity, narrow focus, remind them what is NOT urgent
- Take a position. Be slightly opinionated. Never list options without picking one.

COMPLETION LANGUAGE EXAMPLES:
- "Once they confirm whether there are symptoms, you'll know whether this is necessary."
- "If they can't justify the service beyond mileage, you're done — you can safely defer it."
- "You're done once you know whether the recommendation is symptom-based or just preventive."

DO NOT:
- give educational mini-essays
- restate price deltas or market ranges already visible in the UI
- provide options without a recommendation
- leave the user without a next move
- leave the user without a completion condition

Output ONLY valid JSON matching this exact schema:
{
  "mode": "advisor",
  "current_step": "VERIFY" | "STRATEGY" | "ACTION",
  "headline": "short punchy summary of the situation (1 sentence)",
  "recommendation": "the main point — what matters most and why (2-3 sentences, builds on visible UI, does not repeat it)",
  "reasoning": ["specific reason 1", "specific reason 2"],
  "next_step": "one concrete action the user should take right now (1 sentence)",
  "done_when": "one sentence describing what 'done for now' looks like",
  "shop_script": "verbatim message the user can send to the shop, or empty string",
  "follow_up_options": ["What should I do next?", "What do I say to the shop?", "Can I wait on this?"]
}

TONE: Calm, direct, confident. Like a financially sharp car-savvy friend. No filler. No hedging. 3-6 sentences total in recommendation + reasoning.

Output ONLY valid JSON. No markdown. No explanation outside the JSON.`;
}

// ─── Maintenance Buyer System Prompt ─────────────────────────────────────────
function buildMaintenanceBuyerPrompt(payload: AdvisorRequest): string {
  const mx = payload.maintenanceContext;
  const vehicle = payload.vehicle;
  const vehicleStr = vehicle
    ? [vehicle.year, vehicle.make, vehicle.model, vehicle.trim].filter(Boolean).join(" ")
    : "Unknown vehicle";

  const verdictLabel = ({
    clean: "Clean",
    light_catch_up: "Light Catch-Up",
    maintenance_debt_risk: "Maintenance Debt Risk",
    high_risk: "High Risk — consider walking away",
  } as Record<string, string>)[mx?.verdict ?? ""] ?? mx?.verdict ?? "unknown";

  const debtRange = mx?.debtEstimateLow != null
    ? `$${mx.debtEstimateLow.toFixed(0)}–$${(mx.debtEstimateHigh ?? mx.debtEstimateLow).toFixed(0)}`
    : "unknown";

  const debtItemLines = (mx?.debtItems ?? []).slice(0, 8).map((item) => {
    const cost = item.estimatedCostLow != null
      ? ` (~$${item.estimatedCostLow}–$${item.estimatedCostHigh ?? item.estimatedCostLow})`
      : "";
    const overdue = item.overdueMiles ? ` — ${item.overdueMiles.toLocaleString()} miles overdue` : "";
    return `  • [${item.status.toUpperCase()} | ${item.severity}] ${item.displayName}${overdue}${cost}: ${item.reasoning}`;
  }).join("\n");

  return `You are the WrenchCheck Buying Advisor.

You help used-car buyers understand maintenance debt in a vehicle's service history before they purchase.
Your job is to guide the user from uncertainty to a clear purchase decision.

VEHICLE: ${vehicleStr}
VERDICT: ${verdictLabel}
ESTIMATED MAINTENANCE DEBT: ${debtRange}

OVERDUE / MISSING SERVICES:
${debtItemLines || "  None detected."}

DECISION FRAMEWORK — always anchor to one of these phases:
- EVALUATE: Is this car worth buying at asking price given the maintenance state?
- NEGOTIATE: What price reduction does this debt justify? What should the buyer say?
- DECIDE: Buy, buy with conditions, or walk away?

RESPONSE RULES:
1. Start with the most important insight — never hedge with "it depends"
2. Answer one of: "Would you buy it?", "How much to negotiate?", "What to ask the seller?", "How worried should I be?"
3. Reference the specific overdue services and dollar amounts from context above
4. Sound like a financially sharp buying advisor — not a mechanic
5. Be concise and decisive
6. Never repeat what's already visible in the service list

Output ONLY valid JSON matching this exact schema:
{
  "mode": "advisor",
  "current_step": "EVALUATE" | "NEGOTIATE" | "DECIDE",
  "headline": "short framing of the buying situation (1 sentence)",
  "recommendation": "main point — what matters most for this purchase decision (2-3 sentences)",
  "reasoning": ["specific reason 1", "specific reason 2"],
  "next_step": "one concrete action the buyer should take now",
  "done_when": "what does a clear decision look like",
  "shop_script": "exact words/questions to ask the seller or dealer (or empty string)",
  "follow_up_options": ["Would you buy this car?", "How much should I knock off the price?", "What should I ask the seller?"]
}

Output ONLY valid JSON. No markdown. No explanation outside the JSON.`;
}

// ─── JSON parse with retry + genericness check (section 9) ───────────────────
const GENERIC_SIGNALS = [
  "i'd recommend", "it depends on", "consider consulting",
  "generally speaking", "in general", "one thing to note",
  "as with any", "every vehicle is different",
];

function isGeneric(structured: StructuredResponse, services: ServicePayload[]): boolean {
  const text = (structured.recommendation + " " + (structured.reasoning ?? []).join(" ")).toLowerCase();
  // Fail if no service name appears in the response
  const hasServiceRef = services.some(s => text.includes(s.name.toLowerCase().split(" ")[0]));
  // Fail if a known filler phrase appears
  const hasFiller = GENERIC_SIGNALS.some(g => text.includes(g));
  return !hasServiceRef || hasFiller;
}

async function parseWithRetry(
  messagesPayload: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
  services: ServicePayload[],
  retries = 1
): Promise<{ structured: StructuredResponse; retryCount: number; raw: string }> {
  let lastRaw = "";
  for (let attempt = 0; attempt <= retries; attempt++) {
    const completion = await openai.chat.completions.create({
      model: ADVISOR_MODEL,
      messages: messagesPayload,
      response_format: { type: "json_object" },
      temperature: attempt === 0 ? 0.2 : 0.0,
      max_tokens: 650,
    });
    lastRaw = completion.choices[0].message.content ?? "{}";
    try {
      const parsed = JSON.parse(lastRaw) as StructuredResponse;
      // Validate mode field exists
      if (parsed.mode === "advisor" || parsed.mode === "negotiation") {
        // Genericness check — retry once if response ignores context (section 9)
        if (attempt === 0 && services.length > 0 && isGeneric(parsed, services)) {
          if (DEV) console.warn("[advisor-chat] Generic response detected on attempt 1, retrying at temp 0...");
          continue;
        }
        if (DEV && attempt > 0) console.log(`[advisor-chat] Succeeded on retry attempt ${attempt}`);
        return { structured: parsed, retryCount: attempt, raw: lastRaw };
      }
      if (DEV) console.warn(`[advisor-chat] Attempt ${attempt + 1}: mode field missing or invalid`);
    } catch {
      if (DEV) console.error(`[advisor-chat] Attempt ${attempt + 1}: JSON parse failed, raw:`, lastRaw.slice(0, 200));
    }
  }
  if (DEV) console.warn("[advisor-chat] All retries exhausted, using fallback");
  return { structured: FALLBACK_RESPONSE, retryCount: retries + 1, raw: lastRaw };
}

// ─── Plain text fallback for Supabase persistence ─────────────────────────────
function toPlainText(s: StructuredResponse): string {
  if (s.mode === "advisor") {
    return [s.headline, s.recommendation, ...(s.reasoning || []), s.next_step, s.shop_script ? `"${s.shop_script}"` : ""]
      .filter(Boolean).join("\n\n");
  }
  return [s.headline, s.recommendation, ...(s.reasoning || []), s.shop_script ? `"${s.shop_script}"` : ""]
    .filter(Boolean).join("\n\n");
}

// ─── Route handler ────────────────────────────────────────────────────────────
export async function POST(req: Request) {
  try {
    const body: AdvisorRequest = await req.json();
    const { case_id, conversation, services } = body;

    if (!case_id || !conversation || !Array.isArray(conversation)) {
      return NextResponse.json({ error: "Missing required fields: case_id, conversation" }, { status: 400 });
    }

    const lastUserMsg = [...conversation].reverse().find(m => m.role === "user")?.content ?? "";
    const isBootMessage = lastUserMsg.startsWith("__BOOT__") || lastUserMsg.includes("Give me a quick summary");

    if (DEV) {
      console.log("[advisor-chat] Request:", {
        case_id,
        mode: body.mode,
        vehicle: body.vehicle,
        shop: body.shop,
        serviceCount: services.length,
        user_goal: body.user_goal,
        lastUserMsg: lastUserMsg.slice(0, 120),
      });
    }

    // Persist user message (skip boot synthetics)
    if (lastUserMsg && !isBootMessage) {
      await supabase.from("messages").insert({ case_id, role: "user", content: lastUserMsg });
    }

    // ── Maintenance Buyer Mode ────────────────────────────────────────────────
    if (body.mode === "maintenance_buyer") {
      const systemPrompt = buildMaintenanceBuyerPrompt(body);
      const conversationHistory = conversation
        .filter(m => !m.content.startsWith("__BOOT__"))
        .slice(-12)
        .map(m => ({ role: m.role as "user" | "assistant", content: m.content }));

      const { structured, raw } = await parseWithRetry(
        [{ role: "system", content: systemPrompt }, ...conversationHistory],
        [],
        1
      );

      if (DEV) console.log("[advisor-chat] maintenance_buyer response:", raw.slice(0, 300));

      const reply = toPlainText(structured);
      if (reply && !isBootMessage) {
        await supabase.from("messages").insert({ case_id, role: "assistant", content: reply });
      }

      return NextResponse.json({ structured, reply, mode: "maintenance_buyer", model: ADVISOR_MODEL });
    }

    // Determine mode + level
    const negotiationMode = isNegotiationGoal(body.user_goal, lastUserMsg);
    const negotiationLevel = negotiationMode ? selectNegotiationLevel(services, lastUserMsg) : undefined;

    const systemPrompt = buildSystemPrompt(body, negotiationMode, negotiationLevel);

    // Build message history (exclude boot markers and keep last 12)
    const conversationHistory = conversation
      .filter(m => !m.content.startsWith("__BOOT__"))
      .slice(-12)
      .map(m => ({ role: m.role as "user" | "assistant", content: m.content }));

    const messagesPayload: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      { role: "system", content: systemPrompt },
      ...conversationHistory,
    ];

    // Parse with retry (section 9) — includes genericness check
    const { structured, retryCount, raw } = await parseWithRetry(messagesPayload, body.services, 1);

    if (DEV) {
      console.log("[advisor-chat] Response:", {
        model: ADVISOR_MODEL,
        mode: structured.mode,
        retryCount,
        raw: raw.slice(0, 300),
        parsed: structured,
      });
    }

    const reply = toPlainText(structured);

    // Persist to Supabase
    if (reply && !isBootMessage) {
      await supabase.from("messages").insert({ case_id, role: "assistant", content: reply });
    }

    return NextResponse.json({
      structured,
      reply,
      mode: negotiationMode ? "negotiation" : "advisor",
      model: ADVISOR_MODEL,
    });
  } catch (err: any) {
    console.error("[advisor-chat] Fatal error:", err?.message ?? err);
    return NextResponse.json({
      structured: FALLBACK_RESPONSE,
      reply: FALLBACK_RESPONSE.recommendation,
      mode: "advisor",
      error: "Advisor unavailable",
    }, { status: 500 });
  }
}
