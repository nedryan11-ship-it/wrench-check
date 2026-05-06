"use client";
import { useState, useRef, useCallback } from "react";

type Step = "input" | "vehicle" | "loading" | "verdict";
type Horizon = "<1yr" | "1-3yr" | "3+yr";

export default function FixOrSellPage() {
  const [step, setStep] = useState<Step>("input");
  const [tab, setTab] = useState<"file" | "text" | "describe">("file");
  const [files, setFiles] = useState<File[]>([]);
  const [textInput, setTextInput] = useState("");
  const [drag, setDrag] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // Vehicle form (shown if quote doesn't contain vehicle info)
  const [vYear, setVYear] = useState("");
  const [vMake, setVMake] = useState("");
  const [vModel, setVModel] = useState("");
  const [vMileage, setVMileage] = useState("");
  const [horizon, setHorizon] = useState<Horizon | "">("");

  // Partial quote (from step 1 when vehicle is missing)
  const [partialQuote, setPartialQuote] = useState<any>(null);
  const [rawText, setRawText] = useState("");

  // Result
  const [result, setResult] = useState<any>(null);

  // Chat
  const [chatOpen, setChatOpen] = useState(false);
  const [chatMessages, setChatMessages] = useState<{role:string;content:string}[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [chatLoading, setChatLoading] = useState(false);

  // ── Submit repair quote ──────────────────────────────────────────────────
  const submit = useCallback(async (overrideFiles?: File[]) => {
    setError(null);
    const f = overrideFiles ?? files;
    if (tab === "file" && f.length === 0) return;
    if ((tab === "text" || tab === "describe") && textInput.trim().length < 15) return;

    setStep("loading");
    try {
      let res: Response;
      if (tab === "file" && f.length > 0) {
        const fd = new FormData();
        fd.append("file", f[0]);
        if (horizon) fd.append("horizon", horizon);
        res = await fetch("/api/fix-or-sell", { method: "POST", body: fd });
      } else {
        res = await fetch("/api/fix-or-sell", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: textInput.trim(), horizon: horizon || undefined }),
        });
        setRawText(textInput.trim());
      }
      const data = await res.json();
      if (data.error) { setError(data.error); setStep("input"); return; }
      if (data.needsVehicle) { setPartialQuote(data.quote); setStep("vehicle"); return; }
      setResult(data);
      setStep("verdict");
    } catch { setError("Something went wrong. Please try again."); setStep("input"); }
  }, [files, textInput, tab, horizon]);

  // ── Submit with vehicle info ─────────────────────────────────────────────
  const submitWithVehicle = useCallback(async () => {
    if (!vYear || !vMake || !vModel || !vMileage) { setError("Please fill in all vehicle fields."); return; }
    setError(null);
    setStep("loading");
    try {
      const items = partialQuote?.items || [];
      const itemText = items.map((i:any) => `${i.description} — $${i.cost}`).join("\n");
      const text = rawText || `Shop: ${partialQuote?.shopName || "Unknown"}\n${itemText}\nTotal: $${partialQuote?.totalCost || 0}`;
      const res = await fetch("/api/fix-or-sell", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text,
          vehicle: { year: parseInt(vYear), make: vMake, model: vModel, mileage: parseInt(vMileage) },
          horizon: horizon || undefined,
        }),
      });
      const data = await res.json();
      if (data.error) { setError(data.error); setStep("vehicle"); return; }
      setResult(data);
      setStep("verdict");
    } catch { setError("Something went wrong."); setStep("vehicle"); }
  }, [vYear, vMake, vModel, vMileage, partialQuote, rawText, horizon]);

  // ── Chat ─────────────────────────────────────────────────────────────────
  const sendChat = useCallback(async () => {
    if (!chatInput.trim() || chatLoading) return;
    const userMsg = { role: "user", content: chatInput.trim() };
    const msgs = [...chatMessages, userMsg];
    setChatMessages(msgs);
    setChatInput("");
    setChatLoading(true);
    try {
      const v = result?.verdict;
      const context = {
        vehicle: result?.vehicle?.desc,
        mileage: result?.vehicle?.mileage,
        verdictLabel: v?.decision?.toUpperCase(),
        whatIdDo: v?.recommendation,
        mode: "fix_or_sell",
        repairCost: v?.repairCost,
        vehicleValue: v?.vehicleValue,
        repairRatio: v?.repairRatio,
        forwardCost12mo: v?.forwardCost12mo,
        explanation: v?.explanation,
        reliabilityTier: result?.modelIntel?.reliabilityTier,
        ownershipOutlook: result?.modelIntel?.ownershipOutlook,
        repairItems: result?.quote?.items?.map((i:any) => `${i.description}: $${i.cost} (${i.isFair === false ? 'overpriced' : 'fair'})`).join(", "),
      };
      const res = await fetch("/api/audit-chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: msgs, context }),
      });
      const data = await res.json();
      setChatMessages([...msgs, { role: "assistant", content: data.reply }]);
    } catch { setChatMessages([...msgs, { role: "assistant", content: "Something went wrong — try again." }]); }
    finally { setChatLoading(false); }
  }, [chatInput, chatMessages, chatLoading, result]);

  const BRAND = "#00236F";
  const GREEN = "#16A34A";
  const RED = "#DC2626";
  const AMBER = "#D97706";
  const BLUE = "#0369A1";

  const decisionColor = (d: string) => {
    if (d === 'likely_fix' || d === 'leaning_fix') return GREEN;
    if (d === 'likely_sell' || d === 'leaning_sell') return RED;
    if (d === 'needs_context') return BLUE;
    return AMBER;
  };
  const decisionEmoji = (d: string) => {
    if (d === 'likely_fix') return "🟢";
    if (d === 'leaning_fix') return "🟢";
    if (d === 'likely_sell') return "🔴";
    if (d === 'leaning_sell') return "🟠";
    if (d === 'needs_context') return "🔵";
    return "🟡";
  };
  const decisionLabel = (d: string) => {
    if (d === 'likely_fix') return "LIKELY WORTH FIXING";
    if (d === 'leaning_fix') return "LEANING FIX";
    if (d === 'likely_sell') return "LIKELY BETTER TO SELL";
    if (d === 'leaning_sell') return "LEANING SELL";
    if (d === 'needs_context') return "NEED MORE CONTEXT";
    return "BORDERLINE";
  };
  const confBadge = (c: string) => ({
    bg: c === 'high' ? '#DCFCE7' : c === 'medium' ? '#FEF3C7' : '#FEE2E2',
    color: c === 'high' ? GREEN : c === 'medium' ? AMBER : RED,
    label: c === 'high' ? 'High confidence' : c === 'medium' ? 'Medium confidence' : 'Low confidence',
  });

  return (
    <div style={{ minHeight: "100vh", background: "#F8F9FF", fontFamily: "'Inter', system-ui, sans-serif" }}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap');
        * { box-sizing: border-box; }
        .fos-btn { transition: all 0.15s; cursor: pointer; border: none; }
        .fos-btn:hover { opacity: 0.9; transform: translateY(-1px); }
        .fos-card { background: #fff; border-radius: 20px; border: 1px solid #E2E8F0; box-shadow: 0 8px 32px rgba(0,0,0,0.06); }
        @keyframes spin { to { transform: rotate(360deg); } }
      `}</style>

      {/* Header */}
      <header style={{ position: "fixed", top: 0, width: "100%", zIndex: 50, background: "rgba(255,255,255,0.85)", backdropFilter: "blur(20px)", borderBottom: "1px solid #E2E8F0", height: 56, display: "flex", alignItems: "center" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "0 32px", width: "100%", maxWidth: 800, margin: "0 auto" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ width: 30, height: 30, background: BRAND, borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontSize: 16, fontWeight: 900 }}>🔧</div>
            <span style={{ fontSize: 16, fontWeight: 800, letterSpacing: "-0.03em", color: BRAND, fontStyle: "italic", textTransform: "uppercase" }}>WrenchCheck</span>
          </div>
        </div>
      </header>

      <main style={{ paddingTop: 88, paddingBottom: 80, maxWidth: 640, margin: "0 auto", padding: "88px 20px 80px" }}>

        {/* ── INPUT STEP ──────────────────────────────────────────────── */}
        {step === "input" && (<>
          <div style={{ textAlign: "center", marginBottom: 32 }}>
            <p style={{ fontSize: 10, fontWeight: 900, letterSpacing: "0.3em", color: `${BRAND}66`, textTransform: "uppercase", marginBottom: 8 }}>FIX OR SELL</p>
            <h2 style={{ fontSize: 40, fontWeight: 900, color: "#0D1C2E", letterSpacing: "-0.04em", lineHeight: 1.05, margin: 0 }}>
              Got a repair quote?<br /><span style={{ color: BRAND }}>We'll tell you what to do.</span>
            </h2>
            <p style={{ fontSize: 14, color: "#64748B", marginTop: 12 }}>Drop your estimate — we'll analyze it and give you a clear answer.</p>
          </div>

          {error && <div style={{ background: "#FEF2F2", border: "1px solid #FECACA", borderRadius: 12, padding: "12px 16px", marginBottom: 16, fontSize: 13, color: "#DC2626", fontWeight: 600 }}>{error}</div>}

          <div className="fos-card" style={{ overflow: "hidden" }}>
            {/* Tabs */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", borderBottom: "1px solid #E2E8F0" }}>
              {([["file", "📄 Upload"], ["text", "✏️ Type"], ["describe", "💬 Describe"]] as const).map(([t, label]) => (
                <button key={t} onClick={() => setTab(t as any)} style={{ padding: "14px 12px", background: tab === t ? "#EFF4FF40" : "transparent", border: "none", borderBottom: tab === t ? `2px solid ${BRAND}` : "2px solid transparent", cursor: "pointer", fontSize: 11, fontWeight: 800, letterSpacing: "0.08em", textTransform: "uppercase", color: tab === t ? BRAND : "#94A3B8" }}>
                  {label}
                </button>
              ))}
            </div>

            <div style={{ padding: 24 }}>
              {tab === "file" && (
                <div
                  onClick={() => fileRef.current?.click()}
                  onDragOver={e => { e.preventDefault(); setDrag(true); }}
                  onDragLeave={() => setDrag(false)}
                  onDrop={e => { e.preventDefault(); setDrag(false); const f = Array.from(e.dataTransfer.files); if (f.length) { setFiles(f); submit(f); } }}
                  style={{ border: `2px dashed ${drag ? BRAND : files.length ? GREEN : "#CBD5E1"}`, borderRadius: 16, padding: 40, textAlign: "center", cursor: "pointer", transition: "all 0.2s", background: drag ? "#EFF4FF60" : files.length ? "#F0FDF440" : "transparent" }}
                >
                  <input ref={fileRef} type="file" accept="image/*,application/pdf" style={{ display: "none" }} onChange={e => { const f = Array.from(e.target.files || []); if (f.length) { setFiles(f); submit(f); } }} />
                  {files.length ? (
                    <div><div style={{ fontSize: 28, marginBottom: 8 }}>✅</div><p style={{ fontWeight: 700, fontSize: 14, color: "#0D1C2E" }}>{files[0].name}</p></div>
                  ) : (
                    <div><div style={{ fontSize: 28, marginBottom: 8 }}>📄</div><p style={{ fontWeight: 700, fontSize: 14, color: "#0D1C2E" }}>Drop your repair quote here</p><p style={{ fontSize: 12, color: "#94A3B8", marginTop: 4 }}>Photo, screenshot, or PDF</p></div>
                  )}
                </div>
              )}

              {tab === "text" && (<>
                <textarea value={textInput} onChange={e => setTextInput(e.target.value)} rows={8} placeholder={"Front brake pads + rotors — $680\nTransmission fluid flush — $320\nA/C compressor — $1,450\nTotal: $2,450"} style={{ width: "100%", border: "1px solid #E2E8F0", borderRadius: 12, padding: "12px 16px", fontSize: 14, fontFamily: "monospace", lineHeight: 1.6, resize: "none", outline: "none" }} />
                <button className="fos-btn" onClick={() => submit()} disabled={textInput.trim().length < 15} style={{ width: "100%", marginTop: 12, padding: "14px 20px", background: BRAND, color: "#fff", borderRadius: 14, fontSize: 13, fontWeight: 800, opacity: textInput.trim().length < 15 ? 0.4 : 1 }}>
                  ⚡ Analyze My Quote
                </button>
              </>)}

              {tab === "describe" && (<>
                <p style={{ fontSize: 12, color: "#64748B", margin: "0 0 12px" }}>Got a quote over the phone? Just describe it naturally.</p>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 12 }}>
                  {["They quoted me $4,200 for a transmission rebuild on my 2014 Altima with 142k miles", "My mechanic said brakes and rotors all around plus ball joints — about $2,100 for a 2020 F-150"].map(ex => (
                    <button key={ex} onClick={() => { setTextInput(ex); setTab("text"); }} style={{ padding: "6px 10px", fontSize: 10, fontWeight: 600, border: "1px solid #E2E8F0", borderRadius: 99, background: "#F8FAFC", color: "#475569", cursor: "pointer", textAlign: "left" }}>{ex.slice(0, 60)}…</button>
                  ))}
                </div>
                <textarea value={textInput} onChange={e => setTextInput(e.target.value)} rows={5} placeholder={"My mechanic quoted me $3,500 for a transmission rebuild on my 2008 Toyota Land Cruiser with 164,000 miles..."} style={{ width: "100%", border: "1px solid #E2E8F0", borderRadius: 12, padding: "12px 16px", fontSize: 14, lineHeight: 1.6, resize: "none", outline: "none" }} />
                <button className="fos-btn" onClick={() => submit()} disabled={textInput.trim().length < 15} style={{ width: "100%", marginTop: 12, padding: "14px 20px", background: BRAND, color: "#fff", borderRadius: 14, fontSize: 13, fontWeight: 800, opacity: textInput.trim().length < 15 ? 0.4 : 1 }}>
                  ⚡ Analyze My Quote
                </button>
              </>)}
            </div>

            {/* Ownership horizon */}
            <div style={{ borderTop: "1px solid #E2E8F0", padding: "14px 24px", display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: "#64748B", whiteSpace: "nowrap" }}>How long will you keep it?</span>
              {([["<1yr","< 1 year"],["1-3yr","1–3 years"],["3+yr","3+ years"]] as const).map(([val, label]) => (
                <button key={val} onClick={() => setHorizon(horizon === val ? "" : val)} style={{ padding: "4px 12px", borderRadius: 99, fontSize: 11, fontWeight: 700, border: `1px solid ${horizon === val ? BRAND : "#E2E8F0"}`, background: horizon === val ? "#EFF4FF" : "transparent", color: horizon === val ? BRAND : "#94A3B8", cursor: "pointer" }}>
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div style={{ marginTop: 16, display: "flex", justifyContent: "center", gap: 8 }}>
            {["Photo", "PDF", "Screenshot", "Typed text"].map(f => (
              <span key={f} style={{ fontSize: 10, fontWeight: 700, color: "#94A3B8", background: "#fff", border: "1px solid #E2E8F0", padding: "3px 10px", borderRadius: 99 }}>{f}</span>
            ))}
          </div>
        </>)}

        {/* ── VEHICLE STEP ────────────────────────────────────────────── */}
        {step === "vehicle" && (<>
          <div style={{ textAlign: "center", marginBottom: 24 }}>
            <p style={{ fontSize: 10, fontWeight: 900, letterSpacing: "0.3em", color: `${BRAND}66`, textTransform: "uppercase", marginBottom: 8 }}>ONE MORE THING</p>
            <h2 style={{ fontSize: 28, fontWeight: 900, color: "#0D1C2E", letterSpacing: "-0.03em", margin: 0 }}>What car is this for?</h2>
            <p style={{ fontSize: 13, color: "#64748B", marginTop: 8 }}>We found {partialQuote?.items?.length || 0} items totaling ${partialQuote?.totalCost?.toLocaleString() || "?"} but need your vehicle to calculate the verdict.</p>
          </div>

          {error && <div style={{ background: "#FEF2F2", border: "1px solid #FECACA", borderRadius: 12, padding: "12px 16px", marginBottom: 16, fontSize: 13, color: RED, fontWeight: 600 }}>{error}</div>}

          <div className="fos-card" style={{ padding: 24 }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              {[["Year", vYear, setVYear, "2018"], ["Make", vMake, setVMake, "Honda"], ["Model", vModel, setVModel, "Accord"], ["Mileage", vMileage, setVMileage, "87000"]].map(([label, val, setter, ph]: any) => (
                <div key={label}>
                  <label style={{ fontSize: 10, fontWeight: 800, color: "#94A3B8", letterSpacing: "0.1em", textTransform: "uppercase", display: "block", marginBottom: 4 }}>{label}</label>
                  <input value={val} onChange={e => setter(e.target.value)} placeholder={ph} style={{ width: "100%", border: "1px solid #E2E8F0", borderRadius: 10, padding: "10px 14px", fontSize: 14, fontWeight: 600, outline: "none" }} />
                </div>
              ))}
            </div>
            <button className="fos-btn" onClick={submitWithVehicle} style={{ width: "100%", marginTop: 20, padding: "14px", background: BRAND, color: "#fff", borderRadius: 14, fontSize: 13, fontWeight: 800 }}>
              ⚡ Get My Verdict
            </button>
          </div>
        </>)}

        {/* ── LOADING ─────────────────────────────────────────────────── */}
        {step === "loading" && (
          <div style={{ textAlign: "center", paddingTop: 80 }}>
            <div style={{ width: 56, height: 56, margin: "0 auto 20px", border: `3px solid #E2E8F0`, borderTopColor: BRAND, borderRadius: "50%", animation: "spin 1s linear infinite" }} />
            <p style={{ fontSize: 10, fontWeight: 900, letterSpacing: "0.3em", color: `${BRAND}66`, textTransform: "uppercase", marginBottom: 8 }}>WRENCHCHECK</p>
            <h3 style={{ fontSize: 20, fontWeight: 900, color: "#0D1C2E" }}>Analyzing your repair quote…</h3>
            <p style={{ fontSize: 13, color: "#94A3B8", marginTop: 8 }}>Checking vehicle value, repair costs, and reliability profile</p>
          </div>
        )}

        {/* ── VERDICT (Advisor Mode) ──────────────────────────────── */}
        {step === "verdict" && result && (() => {
          const v = result.verdict;
          const dc = decisionColor(v.decision);
          const se = result.sellEstimates;
          const comps = result.comps || [];
          const ai = result.archetypeInfo;
          const vc = result.valuationConfidence;
          const isNonCommodity = ai && ai.archetype !== 'commodity';
          const cb = confBadge(v.confidence);

          return (<>
            {/* Archetype badge */}
            {isNonCommodity && ai && (
              <div style={{ textAlign: "center", marginBottom: 8 }}>
                <span style={{ display: "inline-block", padding: "4px 14px", background: "#EFF6FF", border: "1px solid #BFDBFE", borderRadius: 99, fontSize: 11, fontWeight: 800, color: "#1E40AF", letterSpacing: "0.05em" }}>
                  {ai.emoji} {ai.label.toUpperCase()}
                </span>
              </div>
            )}

            {/* Vehicle Profile */}
            <div className="fos-card" style={{ padding: "16px 24px", marginBottom: 12, display: "flex", alignItems: "center", gap: 16 }}>
              <div style={{ width: 48, height: 48, borderRadius: 12, background: "#F1F5F9", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 24, flexShrink: 0 }}>🚗</div>
              <div style={{ flex: 1 }}>
                <p style={{ fontSize: 16, fontWeight: 800, color: "#0D1C2E", margin: 0 }}>{result.vehicle?.desc || `${result.vehicle?.year} ${result.vehicle?.make} ${result.vehicle?.model}`}</p>
                <div style={{ display: "flex", gap: 12, marginTop: 4, flexWrap: "wrap" }}>
                  {result.vehicle?.mileage && <span style={{ fontSize: 11, fontWeight: 600, color: "#64748B" }}>📏 {Number(result.vehicle.mileage).toLocaleString()} mi</span>}
                  {ai && <span style={{ fontSize: 11, fontWeight: 600, color: "#64748B" }}>{ai.emoji} {ai.label}</span>}
                  {vc && <span style={{ fontSize: 11, fontWeight: 600, color: vc.confidence === 'low' ? AMBER : "#64748B" }}>📊 Value conf: {vc.confidence}</span>}
                </div>
              </div>
            </div>

            {/* Headline card */}
            <div className="fos-card" style={{ padding: "32px 28px", textAlign: "center", borderLeft: `4px solid ${dc}` }}>
              <div style={{ fontSize: 40, marginBottom: 8 }}>{decisionEmoji(v.decision)}</div>
              <h2 style={{ fontSize: 26, fontWeight: 900, color: dc, letterSpacing: "-0.03em", margin: "0 0 6px" }}>{decisionLabel(v.decision)}</h2>
              <p style={{ fontSize: 14, fontWeight: 600, color: "#475569", margin: "0 0 10px" }}>{v.headline}</p>
              <span style={{ display: "inline-block", padding: "4px 12px", background: cb.bg, color: cb.color, borderRadius: 99, fontSize: 10, fontWeight: 800, letterSpacing: "0.05em", textTransform: "uppercase" }}>
                {cb.label}
              </span>
            </div>

            {/* Subheadline */}
            <div className="fos-card" style={{ padding: "14px 24px", marginTop: 12, background: "#F8FAFC", borderColor: "#E2E8F0" }}>
              <p style={{ fontSize: 12, color: "#64748B", lineHeight: 1.6, margin: 0, textAlign: "center", fontStyle: "italic" }}>{v.subheadline}</p>
            </div>

            {/* Key numbers */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, marginTop: 16 }}>
              {[
                ["VEHICLE VALUE", `~$${Math.round(v.vehicleValue || 0).toLocaleString()}`, "#64748B"],
                ["REPAIR COST", `$${Math.round(v.repairCost || 0).toLocaleString()}`, dc],
                ["REPAIR RATIO", `${v.repairRatio}%`, dc],
              ].map(([label, val, color]) => (
                <div key={label as string} className="fos-card" style={{ padding: "16px 12px", textAlign: "center" }}>
                  <p style={{ fontSize: 9, fontWeight: 800, letterSpacing: "0.12em", color: "#94A3B8", margin: "0 0 4px", textTransform: "uppercase" }}>{label}</p>
                  <p style={{ fontSize: 22, fontWeight: 900, color: color as string, margin: 0, letterSpacing: "-0.02em" }}>{val}</p>
                </div>
              ))}
            </div>

            {/* Valuation confidence warning */}
            {vc && vc.confidence === 'low' && (
              <div className="fos-card" style={{ padding: "14px 24px", marginTop: 16, background: "#FEF3C7", borderColor: "#FDE68A" }}>
                <p style={{ fontSize: 10, fontWeight: 900, letterSpacing: "0.12em", color: AMBER, margin: "0 0 4px", textTransform: "uppercase" }}>⚠️ LIMITED VALUATION DATA</p>
                <p style={{ fontSize: 12, fontWeight: 600, color: "#92400E", lineHeight: 1.5, margin: 0 }}>{vc.note}</p>
              </div>
            )}

            {/* Explanation */}
            <div className="fos-card" style={{ padding: "20px 24px", marginTop: 16 }}>
              <p style={{ fontSize: 14, color: "#334155", lineHeight: 1.7, margin: 0 }}>{v.explanation}</p>
            </div>

            {/* Initial Recommendation */}
            <div className="fos-card" style={{ padding: "20px 24px", marginTop: 16, background: `${dc}08`, borderColor: `${dc}30` }}>
              <p style={{ fontSize: 10, fontWeight: 900, letterSpacing: "0.12em", color: dc, margin: "0 0 6px", textTransform: "uppercase" }}>INITIAL RECOMMENDATION</p>
              <p style={{ fontSize: 14, fontWeight: 600, color: "#0D1C2E", lineHeight: 1.6, margin: 0 }}>{v.recommendation}</p>
            </div>

            {/* WHAT COULD CHANGE */}
            {v.whatCouldChange?.length > 0 && (
              <div className="fos-card" style={{ padding: "20px 24px", marginTop: 16, background: "#F0F9FF", borderColor: "#BAE6FD" }}>
                <p style={{ fontSize: 10, fontWeight: 900, letterSpacing: "0.12em", color: BLUE, margin: "0 0 10px", textTransform: "uppercase" }}>🔄 WHAT COULD CHANGE THIS RECOMMENDATION</p>
                <ul style={{ margin: 0, paddingLeft: 0, listStyle: "none" }}>
                  {v.whatCouldChange.map((f: string, i: number) => (
                    <li key={i} style={{ fontSize: 13, fontWeight: 500, color: "#334155", lineHeight: 1.7, padding: "3px 0", paddingLeft: 18, position: "relative" }}>
                      <span style={{ position: "absolute", left: 0, color: BLUE, fontWeight: 800 }}>•</span>
                      {f}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* ── CHAT (PRIMARY CTA — right after recommendation) ─────── */}
            <div className="fos-card" style={{ marginTop: 20, overflow: "hidden", border: `2px solid ${BRAND}30` }}>
              <div style={{ padding: "16px 24px", background: `${BRAND}06`, borderBottom: "1px solid #E2E8F0" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontSize: 20 }}>💬</span>
                  <div>
                    <p style={{ fontSize: 14, fontWeight: 800, color: BRAND, margin: 0 }}>Let&apos;s talk through this</p>
                    <p style={{ fontSize: 11, color: "#64748B", margin: "2px 0 0" }}>Share more context to refine your recommendation.</p>
                  </div>
                </div>
              </div>
              <div style={{ padding: 16 }}>
                {chatMessages.length === 0 && v.followUpQuestions?.length > 0 && (
                  <div style={{ marginBottom: 14 }}>
                    <p style={{ fontSize: 11, fontWeight: 700, color: "#64748B", margin: "0 0 8px" }}>Questions that could refine this recommendation:</p>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                      {v.followUpQuestions.map((q: string) => (
                        <button key={q} onClick={() => setChatInput(q)} style={{ padding: "6px 12px", fontSize: 11, fontWeight: 600, border: "1px solid #E2E8F0", borderRadius: 99, background: "#F8FAFC", color: "#475569", cursor: "pointer" }}>{q}</button>
                      ))}
                    </div>
                  </div>
                )}
                <div style={{ maxHeight: 400, overflowY: "auto", marginBottom: 12 }}>
                  {chatMessages.map((m, i) => (
                    <div key={i} style={{ marginBottom: 8, textAlign: m.role === "user" ? "right" : "left" }}>
                      <span style={{ display: "inline-block", padding: "8px 14px", borderRadius: 14, fontSize: 13, lineHeight: 1.5, maxWidth: "85%", background: m.role === "user" ? BRAND : "#F1F5F9", color: m.role === "user" ? "#fff" : "#334155", whiteSpace: "pre-wrap" }}>{m.content}</span>
                    </div>
                  ))}
                  {chatLoading && <div style={{ fontSize: 12, color: "#94A3B8" }}>Thinking...</div>}
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <input value={chatInput} onChange={e => setChatInput(e.target.value)} onKeyDown={e => e.key === "Enter" && sendChat()} placeholder="Ask anything about this decision..." style={{ flex: 1, border: "1px solid #E2E8F0", borderRadius: 10, padding: "10px 14px", fontSize: 13, outline: "none" }} />
                  <button className="fos-btn" onClick={sendChat} disabled={!chatInput.trim() || chatLoading} style={{ padding: "10px 18px", background: BRAND, color: "#fff", borderRadius: 10, fontSize: 12, fontWeight: 700, opacity: !chatInput.trim() ? 0.4 : 1 }}>Send</button>
                </div>
              </div>
            </div>

            {/* Negotiate */}
            {v.negotiated && (
              <div className="fos-card" style={{ padding: "16px 24px", marginTop: 16, background: "#FFFBEB", borderColor: "#FDE68A" }}>
                <p style={{ fontSize: 10, fontWeight: 900, letterSpacing: "0.12em", color: AMBER, margin: "0 0 6px", textTransform: "uppercase" }}>💰 NEGOTIATE FIRST</p>
                <p style={{ fontSize: 13, fontWeight: 600, color: "#92400E", lineHeight: 1.6, margin: 0 }}>{v.negotiated.note}</p>
              </div>
            )}

            {/* Mechanical intelligence */}
            {v.cascadeSummary && !v.cascadeSummary.includes("No unusual") && !v.cascadeSummary.includes("standard maintenance") && (
              <div className="fos-card" style={{ padding: "16px 24px", marginTop: 16, background: isNonCommodity ? "#F0F9FF" : v.cascadeItems?.some((c:any) => c.signal === 'sell_signal') ? "#FEF2F2" : "#F0F9FF", borderColor: isNonCommodity ? "#BAE6FD" : v.cascadeItems?.some((c:any) => c.signal === 'sell_signal') ? "#FECACA" : "#BAE6FD" }}>
                <p style={{ fontSize: 10, fontWeight: 900, letterSpacing: "0.12em", color: isNonCommodity ? "#0369A1" : v.cascadeItems?.some((c:any) => c.signal === 'sell_signal') ? RED : "#0369A1", margin: "0 0 6px", textTransform: "uppercase" }}>{ai?.emoji || "🔍"} MECHANICAL INTELLIGENCE</p>
                <p style={{ fontSize: 13, fontWeight: 600, color: "#334155", lineHeight: 1.6, margin: 0 }}>{v.cascadeSummary}</p>
              </div>
            )}

            {/* REPLACEMENT RISK */}
            {v.replacementRisk && (
              <div className="fos-card" style={{ padding: "20px 24px", marginTop: 16, background: "#FEFCE8", borderColor: "#FDE68A" }}>
                <p style={{ fontSize: 10, fontWeight: 900, letterSpacing: "0.12em", color: "#A16207", margin: "0 0 8px", textTransform: "uppercase" }}>⚠️ REPLACEMENT REALITY CHECK</p>
                <p style={{ fontSize: 13, fontWeight: 600, color: "#713F12", lineHeight: 1.6, margin: "0 0 10px" }}>{v.replacementRisk.summary}</p>
                <ul style={{ margin: 0, paddingLeft: 0, listStyle: "none" }}>
                  {v.replacementRisk.factors.map((f: string, i: number) => (
                    <li key={i} style={{ fontSize: 12, color: "#92400E", lineHeight: 1.6, padding: "2px 0", paddingLeft: 18, position: "relative" }}>
                      <span style={{ position: "absolute", left: 0 }}>•</span>{f}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* QUOTE BREAKDOWN (Tiered) */}
            {v.tieredItems?.length > 0 && (
              <div className="fos-card" style={{ marginTop: 16, overflow: "hidden" }}>
                <div style={{ padding: "14px 24px", borderBottom: "1px solid #E2E8F0" }}>
                  <p style={{ fontSize: 10, fontWeight: 900, letterSpacing: "0.12em", color: "#94A3B8", margin: 0, textTransform: "uppercase" }}>QUOTE BREAKDOWN</p>
                </div>
                {v.tieredItems.map((item: any, i: number) => {
                  const cascade = v.cascadeItems?.[i];
                  const signalColor = cascade?.signal === 'sell_signal' ? RED : cascade?.signal === 'cascade' ? AMBER : cascade?.signal === 'watch' ? AMBER : cascade?.signal === 'one_time_fix' ? GREEN : null;
                  const tierColor = item.tier === 'decision_driving' ? '#DC2626' : item.tier === 'cosmetic' ? '#94A3B8' : '#64748B';
                  return (
                    <div key={i} style={{ padding: "10px 24px", borderBottom: i < v.tieredItems.length - 1 ? "1px solid #F1F5F9" : "none" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                          <span style={{ fontSize: 13 }}>{item.isFair === false ? "⚠️" : "✅"}</span>
                          <span style={{ fontSize: 13, fontWeight: 600, color: "#334155" }}>{item.description}</span>
                          <span style={{ fontSize: 8, fontWeight: 800, padding: "2px 6px", borderRadius: 4, background: `${tierColor}15`, color: tierColor, textTransform: "uppercase", letterSpacing: "0.05em" }}>{item.tierLabel}</span>
                        </div>
                        <div style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                          <span style={{ fontSize: 13, fontWeight: 700, color: item.isFair === false ? RED : "#334155" }}>${Math.round(item.cost).toLocaleString()}</span>
                          {item.fairPriceRange && (
                            <span style={{ fontSize: 10, color: "#94A3B8", marginLeft: 6 }}>
                              (fair: ${item.fairPriceRange.low}–${item.fairPriceRange.high})
                            </span>
                          )}
                        </div>
                      </div>
                      {cascade && cascade.signal !== 'neutral' && (
                        <p style={{ fontSize: 11, color: signalColor || "#64748B", margin: "4px 0 0 21px", lineHeight: 1.4 }}>{cascade.note}</p>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {/* SELL CHANNELS */}
            {se?.estimates?.length > 0 && (
              <div className="fos-card" style={{ marginTop: 16, overflow: "hidden" }}>
                <div style={{ padding: "14px 24px", borderBottom: "1px solid #E2E8F0" }}>
                  <p style={{ fontSize: 10, fontWeight: 900, letterSpacing: "0.12em", color: "#94A3B8", margin: 0, textTransform: "uppercase" }}>IF YOU SELL — WHAT TO EXPECT (AS-IS)</p>
                  {se.disclaimer && <p style={{ fontSize: 10, color: "#94A3B8", margin: "4px 0 0", lineHeight: 1.4 }}>{se.disclaimer}</p>}
                </div>
                {se.estimates.map((ch: any, i: number) => (
                  <div key={i} style={{ padding: "12px 24px", borderBottom: i < se.estimates.length - 1 ? "1px solid #F1F5F9" : "none", display: "flex", justifyContent: "space-between", alignItems: "center", opacity: ch.available === false ? 0.5 : 1 }}>
                    <div>
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <span style={{ fontSize: 14 }}>{ch.emoji}</span>
                        <span style={{ fontSize: 13, fontWeight: 700, color: "#0D1C2E" }}>{ch.label}</span>
                        {ch.available !== false && ch.channel === se.bestChannel && (
                          <span style={{ fontSize: 9, fontWeight: 800, background: "#DCFCE7", color: GREEN, padding: "2px 6px", borderRadius: 4, textTransform: "uppercase" }}>Best price</span>
                        )}
                        {ch.available === false && (
                          <span style={{ fontSize: 9, fontWeight: 800, background: "#FEE2E2", color: RED, padding: "2px 6px", borderRadius: 4, textTransform: "uppercase" }}>N/A</span>
                        )}
                      </div>
                      <p style={{ fontSize: 11, color: "#94A3B8", margin: "2px 0 0", lineHeight: 1.3 }}>{ch.note}</p>
                    </div>
                    {ch.available !== false && (
                      <div style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                        <p style={{ fontSize: 15, fontWeight: 800, color: "#0D1C2E", margin: 0 }}>${ch.low?.toLocaleString()}–${ch.high?.toLocaleString()}</p>
                        <p style={{ fontSize: 10, color: "#94A3B8", margin: 0 }}>{ch.timeframe} · {ch.effort} effort</p>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* MARKET COMPS */}
            {comps.length > 0 && (
              <div className="fos-card" style={{ marginTop: 16, overflow: "hidden" }}>
                <div style={{ padding: "14px 24px", borderBottom: "1px solid #E2E8F0" }}>
                  <p style={{ fontSize: 10, fontWeight: 900, letterSpacing: "0.12em", color: "#94A3B8", margin: 0, textTransform: "uppercase" }}>COMPARABLE LISTINGS ({comps.length})</p>
                </div>
                {comps.map((c: any, i: number) => (
                  <div key={i} style={{ padding: "10px 24px", borderBottom: i < comps.length - 1 ? "1px solid #F1F5F9" : "none", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <div>
                      <p style={{ fontSize: 12, fontWeight: 600, color: "#334155", margin: 0 }}>{c.heading?.slice(0, 40)}</p>
                      <p style={{ fontSize: 10, color: "#94A3B8", margin: "2px 0 0" }}>{c.miles?.toLocaleString()} mi · {c.city}, {c.state}</p>
                    </div>
                    <p style={{ fontSize: 14, fontWeight: 800, color: "#0D1C2E", margin: 0 }}>${c.price?.toLocaleString()}</p>
                  </div>
                ))}
              </div>
            )}

            <p style={{ fontSize: 11, color: "#94A3B8", textAlign: "center", marginTop: 12 }}>{v.confidenceNote}</p>

            {/* Start over */}
            <div style={{ textAlign: "center", marginTop: 24 }}>
              <button onClick={() => { setStep("input"); setResult(null); setFiles([]); setTextInput(""); setError(null); setChatMessages([]); setChatOpen(false); }} style={{ fontSize: 12, fontWeight: 700, color: "#94A3B8", background: "transparent", border: "none", cursor: "pointer" }}>
                ← Analyze another quote
              </button>
            </div>
          </>);
        })()}


      </main>
    </div>
  );
}
