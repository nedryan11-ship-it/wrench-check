import { NextResponse } from "next/server";
import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function POST(req: Request) {
  try {
    const { service, vehicle, price, typical_range, shop } = await req.json();

    const typical_min = typical_range?.min ?? "unknown";
    const typical_max = typical_range?.max ?? "unknown";
    const shop_name = shop?.name ?? "unknown";

    const prompt = `You are a car repair advisor. Answer concisely.

Vehicle: ${vehicle}
Service: ${service}
Price: $${price} (market range: $${typical_min}–$${typical_max})
Shop: ${shop_name}

Return ONLY valid JSON:
{
  "quick_take": "1-2 sentence decision: do now, verify first, or safe to wait.",
  "worst_case": "What realistically happens if ignored (be specific, not scary).",
  "when_it_matters": ["condition 1", "condition 2"],
  "why_shops_recommend": ["reason 1", "reason 2"],
  "what_id_do": "Clear 1-sentence recommendation.",
  "what_to_say": "Short script to send to the shop."
}`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
      temperature: 0.2,
      max_tokens: 500,
    });

    const intelligence = JSON.parse(completion.choices[0].message.content || "{}");
    return NextResponse.json({ intelligence });
  } catch (err: any) {
    console.error("[/api/service-explanation]", err);
    return NextResponse.json({ intelligence: null }, { status: 500 });
  }
}
