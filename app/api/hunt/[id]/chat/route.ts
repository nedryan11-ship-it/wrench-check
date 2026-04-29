import { NextRequest } from "next/server";
import OpenAI from "openai";

export const runtime = "nodejs";
export const maxDuration = 60;

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function buildSystemPrompt(comparison: any): string {
  const { cars = [], winner, winnerReason, auditSummaries = [] } = comparison;

  const carSummaries = cars.map((car: any, i: number) => {
    const audit = auditSummaries[car.fileIndex] ?? null;
    const insights = audit?.auditResult?.modelInsights ?? null;
    return [
      `--- Car ${i + 1}: ${car.vehicleName || "Unknown"} (Rank #${car.rank}) ---`,
      `Mileage: ${car.mileage ? car.mileage.toLocaleString() + " miles" : "unknown"}`,
      `Asking price: ${car.askingPrice ? "$" + car.askingPrice.toLocaleString() : "unknown"}`,
      `Fair value gap: ${car.priceGapDollars != null ? (car.priceGapDollars > 0 ? "+" : "") + "$" + Math.abs(car.priceGapDollars).toLocaleString() + " vs fair value" : "unknown"}`,
      car.isSaltBelt ? "Location: Salt-belt state (rust risk)" : car.location ? `Location: ${car.location}` : "",
      car.maintenanceDebt > 0 ? `Maintenance debt: $${car.maintenanceDebt.toLocaleString()}` : "",
      insights?.reliabilityTier ? `Reliability: ${insights.reliabilityTier}` : "",
      insights?.controversyIndex != null ? `Risk index: ${insights.controversyIndex}/10` : "",
      insights?.expertTake ? `Expert take: ${insights.expertTake}` : "",
      insights?.vehicleNarrative ? `Narrative: ${insights.vehicleNarrative}` : "",
      insights?.ownershipOutlook ? `Outlook: ${insights.ownershipOutlook}` : "",
      insights?.avgAnnualCost ? `Avg annual cost: $${insights.avgAnnualCost.toLocaleString()}` : "",
      insights?.tco ? `TCO year 1: $${insights.tco.year1Low?.toLocaleString()}–$${insights.tco.year1High?.toLocaleString()}, year 3: $${insights.tco.year3Low?.toLocaleString()}–$${insights.tco.year3High?.toLocaleString()}` : "",
      insights?.watchouts?.length ? `Watchouts: ${insights.watchouts.map((w: any) => w.text.split(" – ")[0]).join("; ")}` : "",
      insights?.majorExposures?.length ? `Major exposures: ${insights.majorExposures.map((e: any) => `${e.name} ($${e.costLow.toLocaleString()}–$${e.costHigh.toLocaleString()}, ${e.urgency})`).join("; ")}` : "",
      insights?.yearFeatures?.length ? `Year-specific features: ${insights.yearFeatures.join("; ")}` : "",
      insights?.trimNotes ? `Trim: ${insights.trimNotes}` : "",
      car.rankReason ? `Rank reason: ${car.rankReason}` : "",
    ].filter(Boolean).join("\n");
  }).join("\n\n");

  return `You are WrenchCheck, an expert automotive advisor embedded in a multi-car comparison tool.

The user is comparing these cars:

${carSummaries}

Overall verdict: ${winner || "Analysis in progress"} — ${winnerReason || ""}

INSTRUCTIONS:
- You have full context on all cars above. Answer questions specifically using this data.
- Be direct, opinionated, and honest — like a trusted mechanic friend who is also a finance-savvy advisor.
- When asked to "draft a negotiation email", write an actual ready-to-send email using the specific data.
- When comparing cars, reference specific numbers (mileage, price gap, TCO, risk index).
- Never say "I don't have enough information" if the data is above. Use it.
- Keep responses concise but complete. Bullet lists are great for comparisons.
- If genuinely asked something outside your data (e.g., a car not in the comparison), say so briefly and redirect.
- Use plain text — no markdown headers, no asterisks. Use numbered lists and line breaks for structure.`;
}

export async function POST(req: NextRequest) {
  try {
    const { message, history, comparison } = await req.json();

    if (!message || !comparison) {
      return new Response("Missing required fields", { status: 400 });
    }

    const systemPrompt = buildSystemPrompt(comparison);

    // Build message array for OpenAI
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: "system", content: systemPrompt },
      // Include last 8 messages of history for context
      ...((history ?? []) as { role: string; content: string }[])
        .slice(-8)
        .map(m => ({ role: m.role as "user" | "assistant", content: m.content })),
    ];

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        try {
          const completion = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages,
            max_tokens: 900,
            temperature: 0.4,
            stream: true,
          });

          for await (const chunk of completion) {
            const text = chunk.choices[0]?.delta?.content ?? "";
            if (text) {
              controller.enqueue(encoder.encode(`data: ${text}\n\n`));
            }
          }
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        } catch (err) {
          console.error("[hunt/chat] stream error:", err);
          controller.enqueue(encoder.encode("data: Sorry, something went wrong.\n\n"));
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
  } catch (err) {
    console.error("[hunt/chat] error:", err);
    return new Response("Internal server error", { status: 500 });
  }
}
