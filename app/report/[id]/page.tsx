import { createClient } from '@supabase/supabase-js';
import { notFound } from 'next/navigation';

export const revalidate = 60; // Cache for 60 seconds

export default async function ReportPage({ params }: { params: { id: string } }) {
  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
  
  const { data, error } = await supabase
    .from('fos_reports')
    .select('*')
    .eq('id', params.id)
    .single();

  if (error || !data) {
    return notFound();
  }

  const v = data.report_data.verdict;
  const vc = v.confidenceNote;
  const BRAND = "#00236F";
  const RED = "#DC2626";
  const GREEN = "#16A34A";
  const AMBER = "#D97706";
  const dc = (v.decision === 'likely_fix' || v.decision === 'leaning_fix') ? GREEN : (v.decision === 'likely_sell' || v.decision === 'leaning_sell') ? RED : AMBER;

  return (
    <div style={{ fontFamily: "system-ui, sans-serif", padding: 20, maxWidth: 600, margin: "0 auto", color: "#334155" }}>
      <div style={{ textAlign: "center", marginBottom: 30 }}>
        <h1 style={{ margin: 0, color: BRAND, fontStyle: "italic", fontWeight: 900, letterSpacing: "-0.05em" }}>WRENCHCHECK</h1>
        <p style={{ margin: "4px 0 0", fontSize: 13, fontWeight: 700, color: "#64748B", textTransform: "uppercase", letterSpacing: "0.05em" }}>Fix or Sell Report</p>
      </div>

      <div style={{ background: "#fff", border: "1px solid #E2E8F0", borderRadius: 16, padding: 24, boxShadow: "0 4px 20px rgba(0,0,0,0.03)" }}>
        <div style={{ marginBottom: 20, paddingBottom: 16, borderBottom: "1px solid #F1F5F9" }}>
          <h2 style={{ fontSize: 16, margin: "0 0 4px", fontWeight: 800 }}>{data.vehicle_desc}</h2>
          <p style={{ fontSize: 13, color: "#64748B", margin: 0 }}>Quoted Repair: <span style={{ fontWeight: 800, color: RED }}>${Math.round(data.repair_cost).toLocaleString()}</span></p>
        </div>

        <h3 style={{ fontSize: 24, fontWeight: 900, color: dc, letterSpacing: "-0.03em", margin: "0 0 12px", lineHeight: 1.2 }}>
          {v.headline}
        </h3>
        <p style={{ fontSize: 14, color: "#334155", lineHeight: 1.75, margin: "0 0 16px" }}>{v.explanation}</p>

        <div style={{ display: "flex", gap: 16, padding: "12px 16px", background: "#F8FAFC", borderRadius: 12, flexWrap: "wrap" }}>
          <div><span style={{ fontSize: 10, fontWeight: 700, color: "#94A3B8", textTransform: "uppercase", letterSpacing: "0.05em", display: "block" }}>Fixed Value</span><span style={{ fontSize: 15, fontWeight: 800, color: "#334155" }}>~${Math.round(data.vehicle_value).toLocaleString()}</span></div>
          {data.as_is_value > 0 && (
            <div><span style={{ fontSize: 10, fontWeight: 700, color: "#94A3B8", textTransform: "uppercase", letterSpacing: "0.05em", display: "block" }}>As-Is Value</span><span style={{ fontSize: 15, fontWeight: 800, color: "#334155" }}>~${Math.round(data.as_is_value).toLocaleString()}</span></div>
          )}
          {data.repair_roi && (
            <div><span style={{ fontSize: 10, fontWeight: 700, color: "#94A3B8", textTransform: "uppercase", letterSpacing: "0.05em", display: "block" }}>Repair ROI</span><span style={{ fontSize: 15, fontWeight: 800, color: dc }}>+{Math.round(data.repair_roi)}%</span></div>
          )}
        </div>

        {v.recommendation && (
          <p style={{ fontSize: 13, fontWeight: 600, color: "#0D1C2E", margin: "16px 0 0", padding: "12px 16px", background: `${dc}08`, borderRadius: 10, lineHeight: 1.6 }}>{v.recommendation}</p>
        )}

        <div style={{ marginTop: 30, textAlign: "center" }}>
          <a href="/fix-or-sell" style={{ display: "inline-block", background: BRAND, color: "#fff", textDecoration: "none", padding: "12px 24px", borderRadius: 99, fontSize: 14, fontWeight: 800 }}>Run your own quote →</a>
        </div>
      </div>
    </div>
  );
}
