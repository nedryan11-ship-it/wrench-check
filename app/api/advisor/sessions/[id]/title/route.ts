// app/api/advisor/sessions/[id]/title/route.ts
// POST — auto-generate a title for a session based on the first few messages

import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: sessionId } = await params;

  // Get first 4 messages from the session
  const { data: messages } = await supabaseAdmin
    .from("advisor_messages")
    .select("role, content")
    .eq("session_id", sessionId)
    .order("created_at", { ascending: true })
    .limit(4);

  if (!messages || messages.length < 2) {
    return NextResponse.json({ title: "New conversation" });
  }

  const transcript = messages
    .map((m: any) => `${m.role}: ${m.content.slice(0, 200)}`)
    .join("\n");

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: "Generate a short title (3-6 words) for this car-buying advisor conversation. No quotes, no punctuation at the end. Examples: 'Heritage Edition CarFax Review', 'Comparing Top 3 Picks', 'Bay City Offer Strategy'",
        },
        { role: "user", content: transcript },
      ],
      max_tokens: 20,
      temperature: 0.3,
    });

    const title = completion.choices[0]?.message?.content?.trim() || "Advisor Chat";

    // Save the title
    await supabaseAdmin
      .from("advisor_sessions")
      .update({ title })
      .eq("id", sessionId);

    return NextResponse.json({ title });
  } catch {
    return NextResponse.json({ title: "Advisor Chat" });
  }
}
