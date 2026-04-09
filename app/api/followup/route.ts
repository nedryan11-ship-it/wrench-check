import { NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase";
import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function POST(req: Request) {
  try {
    const { case_id, item, followUp, shopContext } = await req.json();

    if (!item || !followUp?.notes?.trim()) {
      return NextResponse.json({ error: "Missing item or user input" }, { status: 400 });
    }

    const itemName = item.normalized_name === "Uncategorized Service" || item.normalized_name === "Unclassified Service"
      ? item.raw_text
      : item.normalized_name;

    const shopGrade = shopContext?.shop_grade || "B";
    const premiumOk = shopContext?.quality_premium_allowed || false;
    const priceHigh = item.market_range?.high || 0;
    const priceDelta = priceHigh > 0 ? Math.round(item.price - priceHigh) : 0;
    const aboveMarket = item.price_position === "above_market";

    const prompt = `You are a calm, knowledgeable advisor helping someone decide whether to approve a car repair.

Here is the full context:

Service: ${itemName}
Quoted price: $${item.price}${aboveMarket && priceDelta > 0 ? ` (+$${priceDelta} above the typical $${item.market_range?.low}–$${priceHigh} range)` : priceHigh > 0 ? ` (within the typical $${item.market_range?.low}–$${priceHigh} range)` : ""}
Original urgency: ${item.urgency || "unknown"}
Shop grade: ${shopGrade}${premiumOk ? " (premium pricing is justified at this shop)" : ""}
Original flag reason: ${item.flag_reason || "above market pricing or unclear necessity"}

The user spoke to the shop. Here is what they said:
"${followUp.notes.trim()}"

Your job:
1. Read what they said carefully and infer:
   - Is this based on a real finding (leak, visible wear, measurement) or just a routine mileage recommendation?
   - How serious does it sound? (low / medium / high)
   - Is there a real consequence to waiting, or is it safe to delay?
   - Was the shop's explanation clear and specific, or vague?

2. Return a verdict and plain-English recommendation.

Rules:
- If there's a clear physical finding (leak, visible damage, measured wear) and high urgency — lean toward approving
- If it's mileage-based or vague — lean toward waiting or getting a second opinion
- If the shop couldn't explain it clearly — recommend a second opinion
- Be direct. Don't hedge.
- Speak like a trusted advisor, not a diagnostic system.

Return valid JSON only (no markdown fences):
{
  "verdict": "approve" | "wait" | "second_opinion",
  "recommendation": "One plain-English sentence — what you'd actually do",
  "explanation": "2 sentences grounded in exactly what they described. Do not use generic advice.",
  "next_step": "One specific, actionable sentence.",
  "inferred_severity": "low" | "medium" | "high",
  "inferred_basis": "real_finding" | "mileage" | "unclear"
}`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
      temperature: 0.3,
      max_tokens: 350,
    });

    const parsed = JSON.parse(completion.choices[0].message.content || "{}");

    const result = {
      verdict: parsed.verdict || "second_opinion",
      recommendation: parsed.recommendation || "More context needed before deciding.",
      confidence: parsed.inferred_severity === "high" ? "high" : parsed.inferred_severity === "low" ? "high" : "medium",
      explanation: parsed.explanation || "",
      next_step: parsed.next_step || "Ask the shop for one more specific detail.",
      inferred_severity: parsed.inferred_severity,
      inferred_basis: parsed.inferred_basis,
    };

    // Persist to Supabase (non-fatal if fails)
    if (case_id) {
      try {
        await supabase.from("service_followups").upsert({
          case_id,
          line_item_id: item.id || null,
          free_text_response: followUp.notes,
          updated_recommendation: result.recommendation,
          updated_confidence: result.confidence,
          updated_explanation: result.explanation,
          next_step: result.next_step,
          verdict: result.verdict,
        }, { onConflict: "case_id,line_item_id" });
      } catch (dbErr) {
        console.warn("[FOLLOWUP API] DB write failed (non-fatal):", dbErr);
      }
    }

    return NextResponse.json(result);

  } catch (err) {
    console.error("[FOLLOWUP API]", err);
    return NextResponse.json({ error: "Failed to evaluate follow-up" }, { status: 500 });
  }
}
