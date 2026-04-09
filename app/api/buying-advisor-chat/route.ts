// app/api/buying-advisor-chat/route.ts
//
// Buying Advisor Chat — dedicated route for the Maintenance Debt Audit experience.
//
// This is NOT the same as the invoice chat (/api/chat).
// This advisor is a buyer advocate for pre-purchase vehicle decisions.
//
// Two call paths:
//   1. Opening (conversation.length === 0): orient the buyer proactively
//   2. Conversation: respond to buyer questions, always with VERIFY → STRATEGY → ACTION → DONE

import { NextResponse } from "next/server";
import OpenAI from "openai";
import {
  buildBuyingAdvisorSystemPrompt,
  buildOpeningPrompt,
} from "@/lib/buyingAdvisor/buildSystemPrompt";
import type { BuyingAdvisorChatContext, BuyingAdvisorResponse } from "@/lib/buyingAdvisor/types";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ─── Model config ─────────────────────────────────────────────────────────────
// Single source of truth — no silent mixing.
const ADVISOR_MODEL    = "gpt-4o" as const;   // all buyer-facing responses
const EXTRACTION_MODEL = "gpt-4o-mini" as const; // background phase/goal extraction

// ─── Route ───────────────────────────────────────────────────────────────────

export async function POST(req: Request) {
  try {
    const body: { context: BuyingAdvisorChatContext; userMessage?: string } = await req.json();
    const { context, userMessage } = body;

    if (!context) {
      return NextResponse.json({ error: "Missing context" }, { status: 400 });
    }

    const isOpening = !userMessage || context.conversation.length === 0;
    const systemPrompt = buildBuyingAdvisorSystemPrompt(context);

    // ── Build messages payload ────────────────────────────────────────────────

    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      { role: "system", content: systemPrompt },
    ];

    if (isOpening) {
      // Synthesize a first-turn prompt that forces orientation
      messages.push({ role: "user", content: buildOpeningPrompt(context) });
    } else {
      // Replay conversation history, then append new user message
      for (const turn of context.conversation) {
        messages.push({ role: turn.role, content: turn.content });
      }
      messages.push({ role: "user", content: userMessage! });
    }

    // ── Advisor response (gpt-5.4) ────────────────────────────────────────────

    const completion = await openai.chat.completions.create({
      model: ADVISOR_MODEL,
      messages,
      temperature: 0.3,
      max_tokens: 400,
    });

    const reply = completion.choices[0].message.content?.trim()
      ?? "I wasn't able to generate a response — please try again.";

    // ── Background: infer phase + goal (gpt-4o-mini, non-blocking) ───────────
    // Runs in parallel with response being sent.
    // Used by the UI to update quick-reply suggestions and context.

    const extractionPromise = !isOpening
      ? openai.chat.completions.create({
          model: EXTRACTION_MODEL,  // background classification — not user-facing
          messages: [
            {
              role: "system",
              content: `You classify the current state of a used-car buying conversation.

Return ONLY this JSON shape:
{
  "inferredGoal": "decide" | "negotiate" | "understand_risk" | "ask_seller" | "walk_away_check" | null,
  "phase": "orient" | "verify" | "strategy" | "action" | "done"
}

inferredGoal: what the buyer is trying to accomplish right now.
phase: what stage of the VERIFY → STRATEGY → ACTION → DONE framework the conversation is in.

Be conservative — if unclear, return null for inferredGoal.`,
            },
            {
              role: "user",
              content: `Buyer said: "${userMessage}"\nAdvisor replied: "${reply}"`,
            },
          ],
          response_format: { type: "json_object" },
          temperature: 0,
          max_tokens: 100,
        })
      : null;

    // ── Resolve extraction (non-fatal) ────────────────────────────────────────

    let inferredGoal: BuyingAdvisorResponse["inferredGoal"] = undefined;
    let phase: BuyingAdvisorResponse["phase"] = isOpening ? "orient" : undefined;

    if (extractionPromise) {
      try {
        const extraction = await extractionPromise;
        const parsed = JSON.parse(extraction.choices[0].message.content ?? "{}");
        inferredGoal = parsed.inferredGoal ?? undefined;
        phase = parsed.phase ?? undefined;
      } catch {
        // Non-fatal — advisor reply is already captured
      }
    }

    return NextResponse.json({
      reply,
      inferredGoal,
      phase,
    } satisfies BuyingAdvisorResponse);

  } catch (error: unknown) {
    console.error("[buying-advisor-chat] error:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
