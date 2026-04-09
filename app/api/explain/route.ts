import { NextResponse } from "next/server";
import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export interface ServiceExplanation {
  name: string;
  what: string;
  why_recommended: string;
  when_necessary: string;
  key_question: string;
  ways_to_save: string[];
}

export async function POST(req: Request) {
  try {
    const { items, vehicle } = await req.json();
    if (!items?.length) return NextResponse.json({ explanations: {} });

    const vehicleStr = vehicle || "a car";
    const itemList = items
      .map((item: { name: string; price: number; tier: string }, i: number) =>
        `${i + 1}. "${item.name}" — $${item.price} (${item.tier === "red" ? "flagged - significantly above market" : "yellow - worth confirming"})`
      )
      .join("\n");

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `You are an expert automotive advisor writing plain-language explanations of car repair services.
For each service, return a JSON object with this exact shape:
{
  "explanations": {
    "[service name exactly as given]": {
      "what": "1-2 sentences: what this service actually does or replaces. Plain language, no jargon.",
      "why_recommended": "1 sentence: the most common reason shops recommend this, including mileage intervals when relevant.",
      "when_necessary": "1 sentence: the real signal that makes this urgent vs. safely deferrable. Be specific.",
      "key_question": "1 sentence: the most useful thing to ask the shop before deciding.",
      "ways_to_save": ["tip 1", "tip 2", "tip 3"]
    }
  }
}

For ways_to_save, provide exactly 3 short, actionable tips. Examples: negotiating the price, bundling with other work, using OEM vs aftermarket, deferring safely, asking for a discount if paying cash, etc.

Rules:
- Be direct and honest. If something is often unnecessary, say so calmly.
- Write for someone who knows nothing about cars but is smart.
- Do not use the words "crucial," "essential," "critical," or "important."
- Tailor all content to ${vehicleStr}.
- Return ONLY valid JSON.`,
        },
        {
          role: "user",
          content: `Write explanations for these services on ${vehicleStr}:\n${itemList}`,
        },
      ],
      response_format: { type: "json_object" },
      temperature: 0.3,
      max_tokens: 1600,
    });

    const parsed = JSON.parse(completion.choices[0].message.content || "{}");
    return NextResponse.json({ explanations: parsed.explanations || {} });
  } catch (err: any) {
    console.error("[/api/explain]", err);
    return NextResponse.json({ explanations: {} });
  }
}
