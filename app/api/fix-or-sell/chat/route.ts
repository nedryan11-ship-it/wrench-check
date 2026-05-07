import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const SYSTEM_PROMPT = `You are a straight-talking automotive service advisor embedded in a tool called WrenchCheck.
Your role is to help a car owner decide whether to FIX their current vehicle or SELL it, based on a recent repair quote.

CRITICAL RULES:
1. NEVER contradict the system's current recommendation. Your job is to explain, reinforce, and guide.
2. NEVER introduce pricing estimates or vehicle values that are not in the context. If you don't know the exact value, say so.
3. Remember: The user ALREADY OWNS this car. Do not talk to them as if they are buying it.
4. Give a clear stance in every response (yes/no/it depends + why).
5. Be concise: 2–4 sentences max unless the user asks for detail.
6. Reference specific numbers from the context when available (e.g. "spending $5,500 on a $21,000 vehicle").
7. **Address the ROI Contradiction:** If the Repair ROI is positive (e.g., +26%), acknowledge that fixing the car before selling it might yield a small immediate profit. BUT explain why the engine still recommended selling (e.g., the risk of the transmission repair snowballing into other issues vs taking the safe cash now).
8. If the user uploads a photo of the vehicle, evaluate its condition (rust, paint, interior, mods). Adjust the vehicle's As-Is or Fixed Value up or down based on what you see, and explain your reasoning clearly to the user.
9. **Critical Questions:** If the user hasn't clarified, naturally weave in questions about their situation to tighten your advice:
   - "How long have you owned the car?" (A trusted, long-term ownership history lowers risk compared to a recent purchase).
   - "Is it currently drivable?" (Urgency and rental costs change the ROI of fixing).
   **DO NOT repeat these questions if you have already asked them or if the user has already answered them.**
10. Use plain English — no jargon.

Tone: calm, confident, empathetic, slightly direct. Like a knowledgeable friend who is a master mechanic.`;

function buildContextMessage(ctx: Record<string, any>): string {
  const lines = [
    `=== FIX OR SELL CONTEXT ===`,
    `Vehicle: ${ctx.vehicle}`,
    `Repair Quote Total: $${Number(ctx.repairCost).toLocaleString()}`,
    `Estimated Vehicle Value: $${Number(ctx.vehicleValue).toLocaleString()}`,
    `Repair-to-Value Ratio: ${ctx.repairRatio}%`,
    `Current System Verdict: "${ctx.verdictLabel}" — DO NOT contradict this.`,
    `System Explanation: ${ctx.explanation}`,
    `Reliability Tier: ${ctx.reliabilityTier || 'Unknown'}`,
    ctx.ownershipOutlook ? `Ownership Outlook: ${ctx.ownershipOutlook}` : '',
    `Quoted Items: ${ctx.repairItems}`,
    `Archetype: ${ctx.archetypeLabel || 'Unknown'}`,
    `=== END CONTEXT ===`,
  ].filter(Boolean);

  return lines.join("\n");
}

export async function POST(req: NextRequest) {
  try {
    const { messages, context } = await req.json();

    if (!messages || !Array.isArray(messages)) {
      return NextResponse.json({ error: "Invalid messages" }, { status: 400 });
    }

    const systemMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: "system", content: SYSTEM_PROMPT },
    ];

    if (context && typeof context === "object") {
      systemMessages.push({
        role: "system",
        content: buildContextMessage(context),
      });
    }

    const oaiMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      ...systemMessages,
      ...messages.map((m: any) => {
        if (m.imageBase64) {
          return {
            role: m.role as "user",
            content: [
              { type: "text", text: m.content || "Here is a photo of the vehicle." },
              { type: "image_url", image_url: { url: m.imageBase64, detail: "high" } }
            ]
          };
        }
        return {
          role: m.role as "user" | "assistant",
          content: m.content,
        };
      }),
    ];

    const hasImage = messages.some((m: any) => !!m.imageBase64);

    const completion = await openai.chat.completions.create({
      model: hasImage ? "gpt-4o" : "gpt-4o-mini",
      messages: oaiMessages,
      max_tokens: 400,
      temperature: 0.4,
    }, { signal: AbortSignal.timeout(12000) });

    const reply = completion.choices[0]?.message?.content ?? "I couldn't process that. Try rephrasing.";

    return NextResponse.json({ reply });

  } catch (err: unknown) {
    console.error("[fix-sell-chat] error:", err);
    const isTimeout = err instanceof Error && err.name === "AbortError";
    return NextResponse.json(
      { reply: isTimeout ? "Taking too long — try again in a moment." : "Something went wrong. Please try again." },
      { status: isTimeout ? 504 : 500 }
    );
  }
}
