import { NextRequest, NextResponse } from "next/server";
import { openai } from "@ai-sdk/openai";
import { streamText } from "ai";
import { z } from "zod";

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
    const { messages, context, data } = await req.json();
    const imageBase64 = data?.imageBase64;

    if (!messages || !Array.isArray(messages)) {
      return NextResponse.json({ error: "Invalid messages" }, { status: 400 });
    }

    const systemPrompt = [
      SYSTEM_PROMPT,
      context && typeof context === "object" ? buildContextMessage(context) : ""
    ].filter(Boolean).join("\n\n");

    // Map messages for Vercel AI SDK
    const aiMessages = messages.map((m: any) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    }));

    // If an image is passed in the body, attach it to the very last message
    if (imageBase64) {
      const lastMsg = aiMessages[aiMessages.length - 1];
      if (lastMsg && lastMsg.role === 'user') {
        lastMsg.content = [
          { type: "text", text: lastMsg.content || "Here is a photo of the vehicle." },
          { type: "image", image: imageBase64.split(',')[1] || imageBase64 } // Vercel AI SDK expects just the base64 string, not the data:image prefix
        ] as any;
      }
    }

    const hasImage = !!imageBase64 || messages.some((m: any) => !!m.imageBase64);

    const result = streamText({
      model: hasImage ? openai("gpt-4o") : openai("gpt-4o-mini"),
      system: systemPrompt,
      messages: aiMessages,
      maxTokens: 500,
      temperature: 0.4,
      tools: {
        updateRepairCost: {
          description: "Update the total repair cost dynamically when the user finds a cheaper option, gets a competitive quote, or successfully negotiates a lower price with the mechanic.",
          parameters: z.object({
            newCost: z.number().describe("The newly negotiated or adjusted repair cost in dollars.")
          }),
          execute: async ({ newCost }) => {
            return {
              updatedCost: newCost,
              message: `Repair cost successfully updated to $${newCost}. The UI should now reflect this new ROI.`
            };
          }
        }
      }
    });

    return result.toDataStreamResponse();

  } catch (err: unknown) {
    console.error("[fix-sell-chat] error:", err);
    return NextResponse.json({ error: "Something went wrong." }, { status: 500 });
  }
}
