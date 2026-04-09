import { supabaseAdmin as supabase } from "@/lib/supabase";
import { NextResponse } from "next/server";

export async function POST(req: Request) {
  try {
    const { caseId, serviceName, update } = await req.json();

    const { data: c } = await supabase.from("cases").select("report").eq("id", caseId).single();
    if (!c) return NextResponse.json({ error: "Missing case" }, { status: 404 });

    let report = c.report;
    if (typeof report === "string") report = JSON.parse(report);

    let ws = report.workspace_state || {};
    if (!ws[serviceName]) ws[serviceName] = { decision: null, step: 1 };

    ws[serviceName] = { ...ws[serviceName], ...update };
    report.workspace_state = ws;

    const { error } = await supabase.from("cases").update({ report }).eq("id", caseId);
    if (error) throw error;

    return NextResponse.json({ success: true, workspace_state: ws });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
