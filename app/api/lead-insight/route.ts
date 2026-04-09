import { NextResponse } from 'next/server';
import OpenAI from 'openai';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function POST(req: Request) {
  try {
    const { vehicle, serviceId, serviceName } = await req.json();

    if (!vehicle || !serviceName) {
      return NextResponse.json({ insight: "" });
    }

    // Build the prompt requesting exactly what the user wants.
    const prompt = `You are a Master Automotive Technician with 25+ years of experience across all major platforms.
Provide an "Expert Insight" regarding the service: "${serviceName}" for the vehicle: "${vehicle}".

CRITICAL RULE:
If the vehicle is an "Audi", tailor your insight to highly specific well-known Audi platform failures. If it's specifically a B7 S4, mention the timing chains and steering racks.
If the vehicle is NOT an Audi (e.g. a Toyota Land Cruiser), provide an equally specific known-failure insight for THAT exact vehicle.

Keep your total response to 2 to 3 punchy sentences. Make the user feel like you know their exact car's dark secrets.`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.7,
      max_tokens: 150,
    });

    const insight = completion.choices[0].message.content?.trim() || "";

    return NextResponse.json({ insight });
  } catch (error: any) {
    console.error("Lead Insight Gen Error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
