// app/api/market-estimate/route.ts
//
// Lightweight market value estimation for a given vehicle.
// Called client-side (non-blocking) — never runs during audit processing.
// MVP: AI estimation. Production: replace with KBB / Edmunds / NADA API.

import { NextResponse } from "next/server";
import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function POST(req: Request) {
  try {
    const { year, make, model, trim, mileage } = await req.json();
    if (!year || !make || !model) {
      return NextResponse.json({ error: "year, make, model required" }, { status: 400 });
    }

    const vehicle = [year, make, model, trim].filter(Boolean).join(" ");
    const mileageStr = mileage ? `${Number(mileage).toLocaleString()} miles` : "unknown mileage";

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{
        role: "user",
        content: `What is the current US private-party market value range for a ${vehicle} with ${mileageStr} in average condition?

Return ONLY this JSON (no markdown, no extra text):
{"low": <integer>, "high": <integer>, "confidence": "low"|"medium"|"high"}

Base this on realistic current used car market prices. Be conservative — buyers use this for negotiation.`,
      }],
      temperature: 0.1,
      max_tokens: 80,
    });

    const raw = completion.choices[0].message.content?.trim() ?? "{}";
    // Strip markdown fences if model wraps it anyway
    const cleaned = raw.replace(/^```[a-z]*\n?/, "").replace(/```$/, "").trim();
    const parsed = JSON.parse(cleaned);

    if (!parsed.low || !parsed.high) {
      return NextResponse.json({ error: "Invalid estimate returned" }, { status: 502 });
    }

    return NextResponse.json({
      low: Math.round(parsed.low / 100) * 100,
      high: Math.round(parsed.high / 100) * 100,
      confidence: parsed.confidence ?? "low",
      vehicle,
    });
  } catch (err) {
    console.error("[market-estimate]", err);
    return NextResponse.json({ error: "Estimation failed" }, { status: 500 });
  }
}
