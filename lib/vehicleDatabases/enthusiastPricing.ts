import OpenAI from "openai";

export type EnthusiastPricingResult = {
  low: number;
  high: number;
  confidence: "low" | "medium" | "high";
  source: "enthusiast_auction";
  marketNote: string;
};

export async function fetchBaTPricingContext(
  year: number,
  make: string,
  model: string
): Promise<EnthusiastPricingResult | null> {
  const query = `"Bring a Trailer" OR "Cars and Bids" sold ${year} ${make} ${model}`;

  try {
    // 1. Search recent auction data via Firecrawl
    const fcRes = await fetch("https://api.firecrawl.dev/v1/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.FIRECRAWL_API_KEY}`,
      },
      body: JSON.stringify({ query, limit: 6 }),
    });

    if (!fcRes.ok) {
      console.warn("[enthusiastPricing] Firecrawl search failed:", fcRes.status);
      return null;
    }

    const { data: searchResults } = await fcRes.json();
    if (!searchResults || searchResults.length === 0) return null;

    const contextStr = searchResults
      .map((r: any) => `URL: ${r.url}\nExcerpt: ${r.description}`)
      .join("\n\n");

    // 2. Feed search snippets to GPT-4o-mini for structured extraction
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const prompt = `You are an expert appraiser of enthusiast/specialty vehicles.
Based on the following recent auction search results from Bring a Trailer and Cars & Bids, determine the fair market asking price range representing a typical "Good" to "Excellent" condition driver for a ${year} ${make} ${model}.

Exclude extreme outliers (like a 10-mile museum car or a destroyed salvage shell). Focus on solid driver-quality examples.

Context from auction sites:
${contextStr}

Respond ONLY with this JSON structure:
{
  "low": <number>, 
  "high": <number>,
  "confidence": "low" | "medium" | "high",
  "marketNote": "<One sentence explaining the market (e.g. 'Driver-quality examples average $25k, while pristine manual coupes push $45k on Bring a Trailer').>"
}`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 150,
      temperature: 0.1,
      response_format: { type: "json_object" },
    });

    const raw = JSON.parse(completion.choices[0].message.content ?? "{}");

    if (typeof raw.low === "number" && typeof raw.high === "number") {
      console.log(`[enthusiastPricing] ${year} ${make} ${model} -> $${raw.low} - $${raw.high} (BaT context)`);
      return {
        low: raw.low,
        high: raw.high,
        confidence: raw.confidence ?? "medium",
        source: "enthusiast_auction",
        marketNote: raw.marketNote ?? "Based on recent enthusiast auctions.",
      };
    }

    return null;
  } catch (err) {
    console.warn(`[enthusiastPricing] Failed for ${year} ${make} ${model}:`, err);
    return null;
  }
}
