import { NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase";
import { generateCaseReport } from "@/lib/logic";

export async function GET() {
  const { data: cases } = await supabase.from("cases").select("id").order("created_at", { ascending: false }).limit(1);
  if (!cases || cases.length === 0) return NextResponse.json({ error: "No cases found" });
  
  const report = await generateCaseReport(cases[0].id);
  return NextResponse.json(report, { status: 200 });
}
