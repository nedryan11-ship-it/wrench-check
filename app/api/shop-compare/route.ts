import { NextResponse } from "next/server";
import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function searchPlaces(query: string, location: string) {
  const key = process.env.GOOGLE_PLACES_API_KEY;
  if (!key) return [];
  const url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(`${query} near ${location}`)}&key=${key}`;
  const res = await fetch(url);
  const data = await res.json();
  if (data.status !== "OK") return [];
  return (data.results || []).slice(0, 6).map((p: any) => ({
    name: p.name,
    rating: p.rating ?? null,
    review_count: p.user_ratings_total ?? null,
    address: p.formatted_address || p.vicinity || null,
    place_id: p.place_id,
  }));
}

export async function POST(req: Request) {
  try {
    const { query, location, vehicle, currentShop, services } = await req.json();
    if (!query || !location) return NextResponse.json({ error: "Missing query or location" }, { status: 400 });

    // Fetch shops from Places API
    const shops = await searchPlaces(query, location);
    if (shops.length === 0) return NextResponse.json({ comparison: null, message: "No shops found" });

    // Filter out the current shop
    const filtered = shops.filter((s: any) => !currentShop || !s.name.toLowerCase().includes(currentShop.toLowerCase().slice(0, 5)));

    // Use gpt-4o-mini to rank + annotate
    const shopsJson = JSON.stringify(filtered.slice(0, 5), null, 2);
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `You are an automotive advisor ranking alternative repair shops for a customer.
Return ONLY valid JSON with this exact shape:
{
  "ranked": [
    {
      "place_id": "...",
      "why": "one sentence: what makes this shop stand out for this job",
      "tradeoff": "one short phrase about any downside (optional, can be null)",
      "best": true/false  (mark exactly one as true — your top pick)
    }
  ],
  "decision_summary": "one sentence starting with the best shop name, explaining why you'd start there"
}

Ranking criteria (weight them in order):
1. Rating ≥ 4.5 strongly preferred
2. High review count (200+) signals consistency
3. Specialization fit for vehicle: ${vehicle || "unknown"}
4. Relevant to these services: ${(services || []).join(", ") || "general repair"}

Be direct and opinionated. Pick a clear winner.`,
        },
        {
          role: "user",
          content: `Here are the candidate shops:\n${shopsJson}`,
        },
      ],
      response_format: { type: "json_object" },
      temperature: 0.2,
      max_tokens: 600,
    });

    const parsed = JSON.parse(completion.choices[0].message.content || "{}");

    return NextResponse.json({
      comparison: {
        shops: filtered.slice(0, 4),
        ranked: parsed.ranked || [],
        decision_summary: parsed.decision_summary || "",
      },
    });

  } catch (err: any) {
    console.error("shop-compare error:", err);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
