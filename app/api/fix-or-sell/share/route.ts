import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

const supabase = createClient(supabaseUrl, supabaseKey);

export async function POST(req: NextRequest) {
  try {
    const { reportData } = await req.json();

    if (!reportData || !reportData.verdict) {
      return NextResponse.json({ error: "Invalid report data" }, { status: 400 });
    }

    const { data, error } = await supabase
      .from('fos_reports')
      .insert([
        {
          vehicle_desc: reportData.vehicle?.desc || "Unknown Vehicle",
          repair_cost: reportData.verdict.repairCost,
          vehicle_value: reportData.verdict.vehicleValue,
          as_is_value: reportData.verdict.asIsValue || 0,
          repair_roi: reportData.verdict.repairROI || null,
          decision: reportData.verdict.decision,
          report_data: reportData,
        }
      ])
      .select('id')
      .single();

    if (error) throw error;

    return NextResponse.json({ id: data.id });
  } catch (err: any) {
    console.error("[fix-or-sell-share]", err);
    return NextResponse.json({ error: "Failed to generate share link" }, { status: 500 });
  }
}
