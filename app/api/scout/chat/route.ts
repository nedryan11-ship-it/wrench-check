// app/api/scout/chat/route.ts
// Scout Intent Chat — conversational replacement for the scout config modal.
// Understands fuzzy intent ("depreciation queens", "reliable SUV under $20k"),
// maps to concrete makes/models, and produces a confirmed scout config.
// Uses gpt-4o for maximum understanding quality.

import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import OpenAI from "openai";

export const maxDuration = 60;

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const TODAY = new Date().toLocaleDateString("en-US", {
  weekday: "long", month: "long", day: "numeric", year: "numeric",
});

const SYSTEM_PROMPT = `You are WrenchCheck's Scout AI — an expert automotive market analyst helping a buyer configure a hyper-targeted vehicle search. Today is ${TODAY}.

YOUR JOB:
1. Understand what the user is hunting (make/model, budget, use case, geography, timeline)
2. Map fuzzy intent to concrete vehicle targets with smart defaults
3. Present a confirmed scout configuration they approve before activating

SMART DEFAULTS — INFER THESE, NEVER ASK:
- Rust: For any vehicle over 5 years old, ALWAYS exclude rust-belt states by default (Ohio, Michigan, New York, Pennsylvania, Illinois, Indiana, Minnesota, Wisconsin). Prefer CO, AZ, TX, NV, CA, FL. Never ask the user about rust preference.
- Owner count: Always prefer 1–2 owners in the prioritization. Never ask the user about this.
- Maintenance records: Always prefer documented service history. Never ask about this.
- Condition: Always infer "clean title, no accidents" as default unless user signals otherwise (e.g. "project", "cheap", "parts car").
- Mileage: If no mileage preference stated, set smart defaults based on model/year — older enthusiast vehicles get higher tolerance (e.g. Land Cruiser: 180k OK, 2022 Civic: 60k OK).

WHAT TO ASK (keep it to 1–2 questions max):
- Budget (if not stated)
- Use case or geography IF it meaningfully changes the search strategy
- Nothing else — be decisive and configure intelligently

UNDERSTANDING INTENT:
- "depreciation queens" → Mercedes S-Class W222/W221, Range Rover L405/L322, Porsche Cayenne 958/957, BMW 7-series
- "reliable daily under $20k" → Toyota Camry/RAV4, Honda CR-V/Accord, Mazda CX-5  
- "best SUV for off-road" → Land Cruiser, 4Runner, Wrangler, Bronco
- "overlander" → Land Cruiser 100/200/80, FJ Cruiser, Tacoma TRD Pro
- "track toy" → BRZ/86, Miata, E46 M3, Cayman
- Always pick the RIGHT generation — e.g. Land Cruiser 100-series (1998–2007) is the enthusiast pick

GEOGRAPHY LOGIC:
- Common/popular models (RAV4, Camry, F-150): search LOCAL first (300mi) — plenty of supply
- Rare/enthusiast/specialty (Land Cruiser 100, Porsche 928, EV6): search NATIONWIDE — better to ship than overpay locally
- Always factor rust-free state benefit > small price premium

MULTIPLE SCOUTS:
- A user can have multiple active scouts running simultaneously (e.g. "Land Cruiser Hunt" + "Cheap Daily Backup")
- Each scout gets a distinct label and runs independently
- When producing a config, always give it a memorable, specific label

Once you have enough info (budget + make/model/era), produce a SCOUT SUMMARY CARD in this EXACT format:

---SCOUT_SUMMARY---
{
  "label": "Land Cruiser Hunt",
  "targets": [{"make": "toyota", "model": "land cruiser", "yearMin": 2003, "yearMax": 2007}],
  "priceMax": 25000,
  "mileageMax": 200000,
  "geography": "nationwide",
  "prioritize": ["rust-free state", "1-owner", "documented service history", "clean title"],
  "sources": ["cars.com", "bat", "carsandbids", "ih8mud", "marketcheck"],
  "summary": "Hunting 2003–2007 Land Cruisers nationwide under $25k. Prioritizing CO, AZ, TX, NV — no rust-belt units. Shipping is on the table from any rust-free state. Will flag 1-owner, clean history, and sub-18k/yr mileage pace.",
  "shippingConsideration": true
}
---END_SUMMARY---

After the JSON block, add: "Ready to activate? This scout will scan Cars.com, Bring a Trailer, Cars & Bids, ih8mud classifieds, and dealer inventory every 30 minutes — and only surface leads that pass the depth threshold. You won't see junk."

RULES:
- Only produce SCOUT_SUMMARY when you have budget + target vehicle
- Never ask more than 1–2 questions per response
- geography: "local" (300mi) | "regional" (500mi) | "nationwide"  
- sources ALWAYS includes all channels: ["cars.com", "bat", "carsandbids", "ih8mud", "marketcheck"] — these are our data sources, not user choices`;

export async function POST(req: Request) {
  const body = await req.json();
  const { message, history = [] }: { message: string; history: any[] } = body;

  const messages: any[] = [
    { role: "system", content: SYSTEM_PROMPT },
    ...history,
    { role: "user", content: message },
  ];

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let fullResponse = "";
      try {
        const completion = await openai.chat.completions.create({
          model: "gpt-4o",
          messages,
          stream: true,
          temperature: 0.5,
          max_tokens: 1000,
        });

        for await (const chunk of completion) {
          const delta = chunk.choices[0]?.delta?.content ?? "";
          if (delta) {
            fullResponse += delta;
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify({ type: "delta", content: delta })}\n\n`)
            );
          }
        }

        // Check if the response contains a scout summary to auto-save
        const summaryMatch = fullResponse.match(/---SCOUT_SUMMARY---\s*([\s\S]*?)---END_SUMMARY---/);
        let savedConfig = null;
        if (summaryMatch) {
          try {
            const cfg = JSON.parse(summaryMatch[1].trim());
            // Save each target as a scout config
            for (const target of (cfg.targets || [])) {
              const { data } = await supabaseAdmin
                .from("scout_configs")
                .insert({
                  label: cfg.label || `${target.make} ${target.model || ""} Scout`.trim(),
                  make: target.make,
                  model: target.model || null,
                  year_min: target.yearMin || null,
                  year_max: target.yearMax || null,
                  price_max: cfg.priceMax || null,
                  mileage_max: cfg.mileageMax || null,
                  radius_miles: cfg.geography === "local" ? 300 : cfg.geography === "regional" ? 500 : 5000,
                  sources: ["cars.com", "bat", "carsandbids", "ih8mud", "marketcheck"],
                  is_active: false, // User must confirm before activating
                })
                .select()
                .single();
              if (data) savedConfig = data;
            }
          } catch (e) {
            console.error("[scout/chat] Failed to parse/save config:", e);
          }
        }

        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ type: "done", fullResponse, savedConfig })}\n\n`)
        );
      } catch (err: any) {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ type: "error", message: err.message })}\n\n`)
        );
      } finally {
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
}

// Activate a pending scout config
export async function PATCH(req: Request) {
  const { id } = await req.json();
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  const { data, error } = await supabaseAdmin
    .from("scout_configs")
    .update({ is_active: true })
    .eq("id", id)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ config: data });
}
