import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { extractPdfText } from "@/lib/pdfParser";
import OpenAI from "openai";

const oai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// POST /api/hunt/[id]/carfax — upload a CarFax PDF and extract structured data
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = (await params).id;
  if (!id) return NextResponse.json({ error: "Missing ID" }, { status: 400 });

  try {
    const formData = await req.formData();
    const file = formData.get("file") as File | null;
    if (!file) return NextResponse.json({ error: "No file uploaded" }, { status: 400 });

    const buffer = Buffer.from(await file.arrayBuffer());
    const rawText = await extractPdfText(buffer, file.name);

    if (!rawText || rawText.trim().length < 50) {
      return NextResponse.json(
        { error: "Could not extract text from PDF. Try a text-based CarFax PDF (not a scanned image)." },
        { status: 422 }
      );
    }

    // Truncate to avoid hitting context limits (CarFax PDFs can be long)
    const truncated = rawText.slice(0, 15000);

    const completion = await oai.chat.completions.create({
      model: "gpt-4o",
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `You are a CarFax report parser. Extract ALL structured data from the raw text of a CarFax report.
Return a JSON object with these exact keys (use null if not found):
{
  "vin": string,
  "owner_count": number,
  "clean_title": boolean,
  "salvage": boolean,
  "lemon_law": boolean,
  "odometer_rollback": boolean,
  "total_accidents": number,
  "airbag_deployed": boolean,
  "frame_damage": boolean,
  "fire_damage": boolean,
  "hail_damage": boolean,
  "flood_damage": boolean,
  "last_odometer": number,
  "last_odometer_date": string (ISO date),
  "service_records": number (count of service records),
  "first_sale_date": string (ISO date),
  "state_history": string[] (list of states where car was registered),
  "accidents": [{ "date": string, "type": string, "severity": string, "airbag": boolean }],
  "service_history": [{ "date": string, "mileage": number|null, "description": string, "service_type": string, "location": string|null }],
  "ownership_history": [{ "owner_number": number, "start_date": string|null, "end_date": string|null, "state": string|null, "type": string|null }],
  "recall_count": number,
  "recalls_open": number,
  "summary": string (2 sentence plain-english summary of key risks and positives)
}

CRITICAL: For "service_history", extract EVERY individual service record / maintenance event from the report.
For each record include:
- date: when the service happened
- mileage: odometer reading at the time (null if not listed)
- description: exactly what was done (e.g. "Oil and filter changed", "Timing belt replaced", "Brake pads replaced", "Multi-point inspection")
- service_type: one of "maintenance", "repair", "inspection", "recall", "registration", "sale"
- location: where the service was performed (dealer name / shop name / city+state)

Do NOT skip any service records. The buyer needs the complete service timeline to make an $80K purchase decision.`,
        },
        {
          role: "user",
          content: `CarFax Report Text:\n\n${truncated}`,
        },
      ],
      max_tokens: 2500,
    });

    let parsed: any = {};
    try {
      parsed = JSON.parse(completion.choices[0].message.content || "{}");
    } catch {
      return NextResponse.json({ error: "Failed to parse AI response" }, { status: 500 });
    }

    // Store in DB
    const { error: updateErr } = await supabaseAdmin
      .from("watchlist_vehicles")
      .update({
        carfax_data: parsed,
        // Sync key fields directly to columns for filtering/scoring
        owner_count: parsed.owner_count ?? undefined,
        has_accident: parsed.total_accidents != null ? parsed.total_accidents > 0 : undefined,
      })
      .eq("id", id);

    if (updateErr) {
      console.error("[carfax] DB update error:", updateErr);
      // Don't fail — still return the data
    }

    return NextResponse.json({ success: true, carfax: parsed });
  } catch (err: any) {
    console.error("[carfax] error:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

// GET /api/hunt/[id]/carfax — fetch stored CarFax data
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = (await params).id;
  if (!id) return NextResponse.json({ error: "Missing ID" }, { status: 400 });

  const { data, error } = await supabaseAdmin
    .from("watchlist_vehicles")
    .select("carfax_data")
    .eq("id", id)
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ carfax: data.carfax_data ?? {} });
}
