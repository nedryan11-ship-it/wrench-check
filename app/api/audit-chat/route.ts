// app/api/audit-chat/route.ts
// Decision Advisor chat endpoint.
// Role: buying decision coach — opinionated, concise, action-oriented.
// Grounded in the specific audit context passed by the frontend.
// Never uses its own training data for market pricing — always defers to computed context.

import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const SYSTEM_PROMPT = `You are a straight-talking automotive buying advisor embedded in a maintenance audit tool called WrenchCheck.

Your role is DECISION COACH — not a summarizer, not a generic assistant.

CRITICAL RULES (non-negotiable):
1. NEVER contradict the system verdict or the "What I'd Do" recommendation shown in the audit. Your job is to explain, reinforce, and guide — not override.
2. NEVER introduce pricing estimates that are not in the AUDIT CONTEXT. If the context has market data, use those exact numbers. If not, say "the audit doesn't have pricing data for this — check local listings."
3. NEVER say "don't buy" if the verdict is "Good Buy" or "Strong Buy". NEVER say "buy it" if the verdict is "Overpriced" or "Proceed with Caution".

Mode behavior (check ctx.mode):
- "price_driven" (newer, clean car): Lead with price analysis. Don't dwell on maintenance details unless asked.
- "maintenance_driven" (older/high-debt car): Lead with risk and leverage. Price second.
- "mixed": Balance both.

Negotiation guidance:
- Only give negotiation scripts when there's real leverage (maintenance debt > $200 OR overpriced)
- If no leverage: say "No strong negotiation edge — focus on verifying condition and move at asking if it checks out"
- Give specific dollar targets from the audit, not ranges like "negotiate 10-15%"

General rules:
- Give a clear stance in every response (yes/no/it depends + why)
- Be concise: 2–4 sentences max unless the user asks for detail
- Reference specific numbers from the audit context when available
- For "would you buy this" questions: answer directly with the What I'd Do recommendation
- For risk questions: be honest about severity without being alarmist
- Never repeat what the UI already shows — add context, not recaps
- Never hedge with "it depends on your situation" without adding a concrete opinion
- Use plain English — no jargon

Tone: calm, confident, slightly direct. Like a knowledgeable friend who also happens to be a mechanic and a negotiator.`;

const RISK_ON_PROMPT = `You are a straight-talking used car advisor in WrenchCheck, operating in RISK ON mode.

The user has told you they want this specific type of car. Do NOT question that choice or suggest alternatives.
Your job: help them buy the BEST EXAMPLE of this car, understand exactly what they're signing up for, and set realistic expectations.

RISK ON rules:
1. Accept the premise fully. No "have you considered a more reliable car" — ever.
2. Lead with CONDITIONS FOR SUCCESS: what has to be true for this to work well for them.
3. Be honest about costs and failure modes — but frame them as "here's what you need to prepare for" not "here's why not to buy."
4. Give specific advice: which examples to avoid (mileage, owner type, service history), which shops specialize in this model, what to budget.
5. If they ask "should I buy this specific one" — answer based on the audit data. Rank its specific history vs. what a good example looks like.
6. Never hedge with "it depends" — give a concrete opinion.

Conditions for success structure (use this when relevant):
- Budget: "This works if you have $X/yr set aside"
- Situation: "This works if it's not your only car" (if reliability tier is poor/below_avg)
- Maintenance: "Find a good indie specialist before you buy"
- Deal quality: "This specific example is [good/average/below avg] based on its history"

Tone: like a mentor who owns the same car and wants you to succeed with it. Direct, specific, no generic disclaimers.`;

function buildContextMessage(ctx: Record<string, unknown>): string {
  const mv = ctx.marketRange as { low: number; high: number; mid: number; isEstimated: boolean; source?: string } | undefined;
  const deal = ctx.dealClassification as { label: string; mood: string; explanation?: string } | null | undefined;
  const offer = ctx.offerRange as { low: number; high: number } | null | undefined;
  const overdue = (ctx.overdueItems as { name: string; status: string; riskLevel?: string; fullCost?: number; pricingImpact?: number }[] | undefined) ?? [];
  const watchouts = (ctx.watchouts as { issue: string; estimatedCost: number }[] | undefined) ?? [];
  const upcoming = (ctx.upcomingServices as { name: string; dueMileage?: number; cost: number }[] | undefined) ?? [];

  const lines: string[] = [
    `=== AUDIT CONTEXT — use these values, do not substitute your own ===`,

    // Vehicle
    `Vehicle: ${ctx.vehicle}${ctx.mileage ? `, ${Number(ctx.mileage).toLocaleString()} miles` : ""}${ctx.vin ? ` (VIN: ${ctx.vin})` : ""}`,

    // Condition (always available)
    `Condition assessment: ${ctx.conditionLabel}`,
    Array.isArray(ctx.conditionBullets) && (ctx.conditionBullets as string[]).length > 0
      ? `Condition signals: ${(ctx.conditionBullets as string[]).join(" · ")}`
      : "",

    // Mode + Verdict (FINAL — chat cannot override)
    `Report mode: ${ctx.mode ?? "mixed"} — ${ctx.mode === "price_driven" ? "newer/clean car, lead with price" : ctx.mode === "maintenance_driven" ? "older/high-debt, lead with maintenance risk" : "balanced"}`,
    `Current verdict shown to user: "${ctx.verdictLabel}" — DO NOT contradict this`,
    ctx.whatIdDo ? `Recommendation ("What I'd Do"): "${ctx.whatIdDo}" — reinforce, never override` : "",

    // Market pricing
    mv
      ? `Market range (${mv.source === "marketcheck" ? "MarketCheck live data" : "AI estimate"}): $${mv.low.toLocaleString()}–$${mv.high.toLocaleString()} (mid ~$${mv.mid.toLocaleString()})`
      : "",
    ctx.priceGapSummary ? `Price gap shown to user: "${ctx.priceGapSummary}"` : "",
    ctx.adjustedFairValue ? `Adjusted for this car's maintenance: $${Number(ctx.adjustedFairValue).toLocaleString()}` : "",
    ctx.pricingImpact && Number(ctx.pricingImpact) > 0
      ? `Maintenance price impact: -$${Number(ctx.pricingImpact).toLocaleString()} (${ctx.impactTier})`
      : "No maintenance price deduction applied.",
    `Pricing confidence: ${ctx.confidence}`,

    // Asking price & deal (only if price entered)
    ctx.askingPrice
      ? `Asking price: $${Number(ctx.askingPrice).toLocaleString()}`
      : "No asking price entered. Pricing recommendation not yet unlocked.",
    deal ? `Deal classification: ${deal.label} — ${deal.explanation ?? ""}` : "",
    offer && offer.low !== offer.high
      ? `Suggested offer: $${offer.low.toLocaleString()}–$${offer.high.toLocaleString()}`
      : offer ? `Suggested offer: $${offer.low.toLocaleString()}` : "",

    // Maintenance items with risk levels
    overdue.length > 0
      ? `Overdue/due-now maintenance:\n${overdue.map(i =>
          `  - ${i.name} [${i.riskLevel ?? "unknown"} risk] · ~$${i.fullCost?.toLocaleString() ?? "?"} to fix · $${i.pricingImpact?.toLocaleString() ?? "?"} price impact`
        ).join("\n")}`
      : "No overdue maintenance items.",
    ctx.conditionDebt && Number(ctx.conditionDebt) > 0
      ? `Total deferred work (full cost, for negotiation): ~$${Number(ctx.conditionDebt).toLocaleString()}`
      : "",

    // Model intelligence
    watchouts.length > 0
      ? `Known model risks (probabilistic, verify at inspection):\n${watchouts.map(w =>
          `  - ${w.issue} (~$${w.estimatedCost?.toLocaleString() ?? "?"} if needed)`
        ).join("\n")}`
      : "",
    ctx.expertTake ? `Model-specific expert note: ${ctx.expertTake}` : "",
    ctx.ownershipOutlook ? `Ownership outlook: ${ctx.ownershipOutlook}` : "",
    upcoming.length > 0
      ? `Upcoming services: ${upcoming.map(s => `${s.name} (~$${s.cost?.toLocaleString()}${s.dueMileage ? ` at ${s.dueMileage.toLocaleString()} mi` : ""})`).join(", ")}`
      : "",

    `=== END CONTEXT ===`,
  ].filter(Boolean);

  return lines.join("\n");
}


export async function POST(req: NextRequest) {
  try {
    const { messages, context, riskOnMode } = await req.json();

    if (!messages || !Array.isArray(messages)) {
      return NextResponse.json({ error: "Invalid messages" }, { status: 400 });
    }

    const systemMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: "system", content: riskOnMode ? RISK_ON_PROMPT : SYSTEM_PROMPT },
    ];

    // Inject audit context as a grounding system message — locks LLM to the UI's computed numbers
    if (context && typeof context === "object") {
      systemMessages.push({
        role: "system",
        content: buildContextMessage(context as Record<string, unknown>),
      });
    }

    const oaiMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      ...systemMessages,
      ...messages.map((m: { role: string; content: string }) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      })),
    ];

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: oaiMessages,
      max_tokens: 300,
      temperature: 0.4, // lower = more deterministic, less likely to hallucinate numbers
    }, { signal: AbortSignal.timeout(12000) });

    const reply = completion.choices[0]?.message?.content ?? "I couldn't process that. Try rephrasing.";

    return NextResponse.json({ reply });

  } catch (err: unknown) {
    console.error("[audit-chat] error:", err);
    const isTimeout = err instanceof Error && err.name === "AbortError";
    return NextResponse.json(
      { reply: isTimeout ? "Taking too long — try again in a moment." : "Something went wrong. Please try again." },
      { status: isTimeout ? 504 : 500 }
    );
  }
}
