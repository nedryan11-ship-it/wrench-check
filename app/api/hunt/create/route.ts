import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";

export async function POST() {
  try {
    // We provision a new workspace using the primary cases table to ensure DB persistence.
    const { data: caseData, error } = await supabaseAdmin
      .from("cases")
      .insert({
        status: "pending",
        vehicle_make: "Hunt Workspace",
        shop_name: "Multi-Car Comparison"
      })
      .select("id")
      .single();

    if (error || !caseData) {
      console.error("DB INSERT ERROR:", error);
      throw new Error("Failed to provision: " + (error?.message || "Unknown db error"));
    }

    // Define initial empty comparison state
    const initialData = {
      headline: "The Hunt Begins",
      winner: "Awaiting Contenders",
      winnerReason: "Drop your first car into the gauntlet to start the evaluation.",
      tcoComparison: "",
      bottomLine: "Every car is a gamble. Let's find your gem.",
      isSameCar: false,
      cars: []
    };

    // Store the JSON state in the 'messages' table which we know exists
    await supabaseAdmin.from("messages").insert({
      case_id: caseData.id,
      role: "system",
      content: JSON.stringify(initialData)
    });

    return NextResponse.json({ sessionId: caseData.id, redirectUrl: `/hunt/${caseData.id}` });
  } catch (err: any) {
    console.error("[hunt/create] error:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
