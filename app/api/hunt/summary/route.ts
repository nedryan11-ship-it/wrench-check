import { NextResponse } from "next/server";
import OpenAI from "openai";

export const dynamic = "force-dynamic";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function POST(req: Request) {
  try {
    const { vehicles } = await req.json();
    if (!Array.isArray(vehicles) || vehicles.length === 0) {
      return NextResponse.json({ error: "No vehicles" }, { status: 400 });
    }

    // Build a concise vehicle digest for the prompt
    const digest = vehicles
      .slice(0, 12) // cap at 12 to keep prompt tight
      .map((v: any, i: number) => {
        const score = v.adjusted_score ?? v.score ?? null;
        const gap = v.gem_price_target && v.price ? v.price - v.gem_price_target : null;
        const priceVelocity = (() => {
          const ph: { price: number; date: string }[] = Array.isArray(v.price_history) ? v.price_history : [];
          if (ph.length >= 2 && v.initial_price && v.initial_price > v.price) {
            return `dropped $${(v.initial_price - v.price).toLocaleString()} from ask`;
          }
          return null;
        })();

        return [
          `#${i + 1}: ${v.year} ${v.make} ${v.model}${v.trim ? ' ' + v.trim : ''}`,
          `  Price: $${v.price?.toLocaleString() ?? 'unknown'} | Mileage: ${v.mileage?.toLocaleString() ?? 'unknown'} mi`,
          score ? `  WrenchScore: ${score}/100 | Tier: ${v.tier ?? 'watch'}` : `  Score: pending`,
          v.market_mid ? `  Market mid: $${v.market_mid.toLocaleString()}` : '',
          v.has_accident === true ? `  ⚠ Accident reported` : v.has_accident === false ? `  ✓ Clean history` : '',
          gap && gap > 0 ? `  ${gap <= 1500 ? '🟢' : gap <= 5000 ? '🎯' : '⏳'} $${gap.toLocaleString()} from gem price` : (gap !== null && gap <= 0 ? `  💎 At or below gem price` : ''),
          priceVelocity ? `  📉 ${priceVelocity}` : '',
          v.seller_name ? `  Seller: ${v.seller_name}` : '',
        ].filter(Boolean).join('\n');
      })
      .join('\n\n');

    const gemCount = vehicles.filter((v: any) => (v.adjusted_score ?? v.score ?? 0) >= 78).length;
    const activeOfferCount = vehicles.filter((v: any) => {
      const gap = v.gem_price_target && v.price ? v.price - v.gem_price_target : null;
      return gap !== null && gap > 0 && gap <= 5000;
    }).length;
    const priceDropCount = vehicles.filter((v: any) => v.initial_price && v.price && v.initial_price > v.price).length;

    const systemPrompt = `You are WrenchCheck, an elite car-buying intelligence system. You speak like a sharp, experienced car analyst giving a friend a morning briefing — direct, confident, numbers-first. You never use markdown formatting (no asterisks, no bold, no headers). You write in plain prose bullets only. Each bullet is one punchy sentence with a specific number or fact. No filler words. No category labels like "Urgency Signals:" — just the insight itself.`;

    const userPrompt = `Review this watchlist of ${vehicles.length} cars and give me a 4–5 bullet morning briefing. Plain text only — no asterisks, bold, or markdown of any kind.

Rules:
- Lead with the single best opportunity and exactly why (price vs market, clean history, etc.)
- Call out any real urgency (price drop, auction ending, rare find)
- Name the one car closest to an actionable offer today, and what to offer
- Flag the weakest car on the list (accident, mileage, overpriced vs market) in one blunt sentence
- End with one specific action the user should take today — car name, action, number

Context: ${gemCount} gem-tier, ${activeOfferCount} in offer range, ${priceDropCount} with price drops.

Watchlist:
${digest}

Write 4–5 bullets. Each starts with •. No markdown. Be specific — use car names, exact prices, exact gaps.`;

    const stream = await openai.chat.completions.create({
      model: "gpt-4o",
      stream: true,
      max_tokens: 350,
      temperature: 0.7,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    });

    const encoder = new TextEncoder();
    const readable = new ReadableStream({
      async start(controller) {
        try {
          for await (const chunk of stream) {
            const delta = chunk.choices[0]?.delta?.content ?? "";
            if (delta) {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "delta", content: delta })}\n\n`));
            }
          }
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "done" })}\n\n`));
        } finally {
          controller.close();
        }
      },
    });

    return new Response(readable, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
