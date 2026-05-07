"use client";
import { useState, useRef, useCallback, useEffect } from "react";
import ReactMarkdown from 'react-markdown';

type Step = "input" | "vehicle" | "loading" | "verdict";


export default function FixOrSellPage() {
  const [step, setStep] = useState<Step>("input");

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
  const [horizon, setHorizon] = useState("");

  // Partial quote (from step 1 when vehicle is missing)
  const [partialQuote, setPartialQuote] = useState<any>(null);
  const [rawText, setRawText] = useState("");

  // Result
  const [result, setResult] = useState<any>(null);

  const [chatOpen, setChatOpen] = useState(false);
  const [chatMessages, setChatMessages] = useState<{role:string;content:string;imageBase64?:string}[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [chatImage, setChatImage] = useState<string | null>(null);
  const [chatLoading, setChatLoading] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const chatContainerRef = useRef<HTMLDivElement>(null);

  // Auto-scroll chat to bottom
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chatMessages, chatLoading]);

  // Auto-scroll to chat when verdict loads
  useEffect(() => {
    if (step === "verdict") {
      setTimeout(() => {
        chatContainerRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      }, 300);
    }
  }, [step]);

  // Session Persistence
  useEffect(() => {
    const saved = localStorage.getItem('wrenchcheck_session');
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        if (parsed.result) setResult(parsed.result);
        if (parsed.chatMessages) setChatMessages(parsed.chatMessages);
        if (parsed.step && parsed.step !== "input" && parsed.step !== "loading") setStep(parsed.step);
      } catch (e) {}
    }
  }, []);

  useEffect(() => {
    if (step === "verdict") {
      localStorage.setItem('wrenchcheck_session', JSON.stringify({ step, result, chatMessages }));
    } else if (step === "input") {
      localStorage.removeItem('wrenchcheck_session');
    }
  }, [step, result, chatMessages]);

  // -- Submit repair quote --------------------------------------------------
  const submit = useCallback(async (overrideFiles?: File[]) => {
    setError(null);
    const f = overrideFiles ?? files;
    const hasFile = f.length > 0;
    const hasText = textInput.trim().length >= 15;
    if (!hasFile && !hasText) return;

    setStep("loading");
    try {
      let res: Response;
      if (hasFile) {
        const fd = new FormData();
        fd.append("file", f[0]);
        if (horizon) fd.append("horizon", horizon);
        if (hasText) fd.append("context", textInput.trim());
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
  }, [files, textInput, horizon]);

  // -- Submit with vehicle info ---------------------------------------------
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

  // -- Chat -----------------------------------------------------------------
  const handleChatImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      setChatImage(event.target?.result as string);
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  };

  const sendChat = useCallback(async () => {
    if ((!chatInput.trim() && !chatImage) || chatLoading) return;
    const userMsg = { role: "user", content: chatInput.trim(), imageBase64: chatImage || undefined };
    const msgs = [...chatMessages, userMsg];
    setChatMessages(msgs);
    setChatInput("");
    setChatImage(null);
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
        archetypeLabel: v?.archetypeLabel,
      };
      const res = await fetch("/api/fix-or-sell/chat", {
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
    if (d === 'likely_fix') return "We'd fix this one.";
    if (d === 'leaning_fix') return "This is probably worth fixing.";
    if (d === 'likely_sell') return "You're probably better off selling.";
    if (d === 'leaning_sell') return "Selling might be the smarter move.";
    if (d === 'needs_context') return "We need a bit more info.";
    return "This one's a close call.";
  };

  return (
    <div style={{ minHeight: "100vh", background: "#F8F9FF", fontFamily: "'Inter', system-ui, sans-serif" }}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap');
        * { box-sizing: border-box; }
        .fos-btn { transition: all 0.15s; cursor: pointer; border: none; }
        .fos-btn:hover { opacity: 0.9; transform: translateY(-1px); }
        .fos-card { background: #fff; border-radius: 20px; border: 1px solid #E2E8F0; box-shadow: 0 8px 32px rgba(0,0,0,0.06); }
        details summary::-webkit-details-marker { display: none; }
        details summary { user-select: none; }
        details summary:hover { background: #F8FAFC; }
        @keyframes spin { to { transform: rotate(360deg); } }
        .chat-msg p { margin: 0 0 8px 0; }
        .chat-msg p:last-child { margin: 0; }
        .chat-msg ul, .chat-msg ol { margin: 0 0 8px 0; padding-left: 20px; }
        .chat-msg strong { font-weight: 700; }
        @media (max-width: 640px) {
          .fos-ratio-grid { flex-direction: column !important; gap: 8px !important; }
          .fos-ratio-grid > div { width: 100% !important; justify-content: space-between !important; display: flex !important; }
        }
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

        {/* -- INPUT STEP ------------------------------------------------ */}
        {step === "input" && (<>
          <div style={{ textAlign: "center", marginBottom: 32 }}>
            <p style={{ fontSize: 10, fontWeight: 900, letterSpacing: "0.3em", color: `${BRAND}66`, textTransform: "uppercase", marginBottom: 8 }}>FIX OR SELL ADVISOR</p>
            <h2 style={{ fontSize: 36, fontWeight: 900, color: "#0D1C2E", letterSpacing: "-0.04em", lineHeight: 1.1, margin: 0 }}>
              Got a repair quote?<br /><span style={{ color: BRAND }}>Let&apos;s figure this out.</span>
            </h2>
            <p style={{ fontSize: 14, color: "#64748B", marginTop: 12 }}>Upload an invoice, paste a quote, or just describe what you were told.</p>
          </div>

          {error && <div style={{ background: "#FEF2F2", border: "1px solid #FECACA", borderRadius: 12, padding: "12px 16px", marginBottom: 16, fontSize: 13, color: "#DC2626", fontWeight: 600 }}>{error}</div>}

          <div
            className="fos-card"
            onDragOver={e => { e.preventDefault(); setDrag(true); }}
            onDragLeave={() => setDrag(false)}
            onDrop={e => { e.preventDefault(); setDrag(false); const f = Array.from(e.dataTransfer.files); if (f.length) { setFiles(f); } }}
            style={{ overflow: "hidden", border: drag ? `2px solid ${BRAND}` : "1px solid #E2E8F0", transition: "border 0.2s" }}
          >
            {/* Attached file preview */}
            {files.length > 0 && (
              <div style={{ padding: "10px 20px", background: "#F8FAFC", borderBottom: "1px solid #E2E8F0", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontSize: 16 }}>📎</span>
                  <span style={{ fontSize: 12, fontWeight: 700, color: "#334155" }}>{files[0].name}</span>
                  <span style={{ fontSize: 10, color: "#94A3B8" }}>({(files[0].size / 1024).toFixed(0)} KB)</span>
                </div>
                <button onClick={() => setFiles([])} style={{ background: "none", border: "none", fontSize: 14, color: "#94A3B8", cursor: "pointer", padding: "2px 6px" }}>✕</button>
              </div>
            )}

            {/* Main input area */}
            <div style={{ padding: "16px 20px" }}>
              <textarea
                value={textInput}
                onChange={e => setTextInput(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); } }}
                rows={3}
                placeholder={drag ? "Drop your file here..." : "Describe your repair quote, paste it, or drop a file..."}
                style={{ width: "100%", border: "none", outline: "none", fontSize: 15, lineHeight: 1.6, resize: "none", color: "#0D1C2E", background: "transparent", fontFamily: "'Inter', system-ui, sans-serif" }}
              />
            </div>

            {/* Bottom toolbar */}
            <div style={{ padding: "10px 20px", borderTop: "1px solid #F1F5F9", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                {/* Attach button */}
                <button
                  onClick={() => fileRef.current?.click()}
                  style={{ width: 32, height: 32, borderRadius: 8, border: "1px solid #E2E8F0", background: "#F8FAFC", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", fontSize: 15 }}
                  title="Attach photo, screenshot, or PDF"
                >📎</button>
                <input ref={fileRef} type="file" accept="image/*,application/pdf" style={{ display: "none" }} onChange={e => { const f = Array.from(e.target.files || []); if (f.length) setFiles(f); }} />
              </div>

              {/* Submit */}
              <button
                className="fos-btn"
                onClick={() => submit()}
                disabled={files.length === 0 && textInput.trim().length < 15}
                style={{ width: 36, height: 36, borderRadius: 99, background: (files.length > 0 || textInput.trim().length >= 15) ? BRAND : "#E2E8F0", display: "flex", alignItems: "center", justifyContent: "center", cursor: (files.length > 0 || textInput.trim().length >= 15) ? "pointer" : "default", transition: "all 0.15s" }}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={files.length > 0 || textInput.trim().length >= 15 ? "#fff" : "#94A3B8"} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>
              </button>
            </div>
          </div>
        </>)}

        {/* -- VEHICLE STEP ---------------------------------------------- */}
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

        {/* -- LOADING --------------------------------------------------- */}
        {step === "loading" && (
          <div style={{ textAlign: "center", paddingTop: 80 }}>
            <div style={{ width: 56, height: 56, margin: "0 auto 20px", border: `3px solid #E2E8F0`, borderTopColor: BRAND, borderRadius: "50%", animation: "spin 1s linear infinite" }} />
            <p style={{ fontSize: 10, fontWeight: 900, letterSpacing: "0.3em", color: `${BRAND}66`, textTransform: "uppercase", marginBottom: 8 }}>WRENCHCHECK</p>
            <h3 style={{ fontSize: 20, fontWeight: 900, color: "#0D1C2E" }}>Analyzing your repair quote…</h3>
            <p style={{ fontSize: 13, color: "#94A3B8", marginTop: 8 }}>Checking vehicle value, repair costs, and reliability profile</p>
          </div>
        )}

        {/* -- VERDICT (Advisor Mode) -------------------------------- */}
        {step === "verdict" && result && (() => {
          const v = result.verdict;
          const dc = decisionColor(v.decision);
          const se = result.sellEstimates;
          const comps = result.comps || [];
          const ai = result.archetypeInfo;
          const vc = result.valuationConfidence;

          return (<>
            {/* -- ZONE 1: THE ANSWER -------------------------------- */}
            <div className="fos-card" style={{ padding: "28px 28px 24px", borderLeft: `4px solid ${dc}` }}>
              {/* Vehicle identity */}
              <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20 }}>
                <div style={{ width: 40, height: 40, borderRadius: 10, background: "#F1F5F9", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20, flexShrink: 0 }}>🚗</div>
                <div>
                  <p style={{ fontSize: 15, fontWeight: 800, color: "#0D1C2E", margin: 0 }}>{result.vehicle?.desc || `${result.vehicle?.year} ${result.vehicle?.make} ${result.vehicle?.model}`}</p>
                  <p style={{ fontSize: 11, color: "#64748B", margin: "2px 0 0", fontWeight: 500 }}>
                    {result.vehicle?.mileage ? `${Number(result.vehicle.mileage).toLocaleString()} miles` : ""}
                    {v.repairCost ? ` · $${Math.round(v.repairCost).toLocaleString()} repair` : ""}
                  </p>
                </div>
              </div>

              {/* Verdict */}
              <h2 style={{ fontSize: 24, fontWeight: 900, color: dc, letterSpacing: "-0.03em", margin: "0 0 12px", lineHeight: 1.2 }}>{decisionLabel(v.decision)}</h2>

              {/* Explanation with numbers woven in */}
              <p style={{ fontSize: 14, color: "#334155", lineHeight: 1.75, margin: "0 0 16px" }}>{v.explanation}</p>

              {/* Key numbers — inline row */}
              <div className="fos-ratio-grid" style={{ display: "flex", gap: 16, padding: "12px 16px", background: "#F8FAFC", borderRadius: 12, flexWrap: "wrap" }}>
                <div><span style={{ fontSize: 10, fontWeight: 700, color: "#94A3B8", textTransform: "uppercase", letterSpacing: "0.05em" }}>Fixed Value </span><span style={{ fontSize: 15, fontWeight: 800, color: "#334155" }}>~${Math.round(v.vehicleValue || 0).toLocaleString()}</span></div>
                {v.asIsValue && (
                  <div><span style={{ fontSize: 10, fontWeight: 700, color: "#94A3B8", textTransform: "uppercase", letterSpacing: "0.05em" }}>As-Is Value </span><span style={{ fontSize: 15, fontWeight: 800, color: "#334155" }}>~${Math.round(v.asIsValue).toLocaleString()}</span></div>
                )}
                <div><span style={{ fontSize: 10, fontWeight: 700, color: "#94A3B8", textTransform: "uppercase", letterSpacing: "0.05em" }}>Repair </span><span style={{ fontSize: 15, fontWeight: 800, color: dc }}>${Math.round(v.repairCost || 0).toLocaleString()}</span></div>
                {v.repairROI ? (
                  <div><span style={{ fontSize: 10, fontWeight: 700, color: "#94A3B8", textTransform: "uppercase", letterSpacing: "0.05em" }}>Repair ROI </span><span style={{ fontSize: 15, fontWeight: 800, color: dc }}>+{Math.round(v.repairROI)}%</span></div>
                ) : (
                  <div><span style={{ fontSize: 10, fontWeight: 700, color: "#94A3B8", textTransform: "uppercase", letterSpacing: "0.05em" }}>Ratio </span><span style={{ fontSize: 15, fontWeight: 800, color: dc }}>{v.repairRatio}%</span></div>
                )}
              </div>

              {/* Valuation caveat inline */}
              {vc && vc.confidence === 'low' && (
                <p style={{ fontSize: 12, color: AMBER, margin: "12px 0 0", fontWeight: 600, lineHeight: 1.5 }}>⚠️ {vc.note}</p>
              )}

              {/* Recommendation */}
              {v.recommendation && (
                <p style={{ fontSize: 13, fontWeight: 600, color: "#0D1C2E", margin: "14px 0 0", padding: "10px 14px", background: `${dc}08`, borderRadius: 10, lineHeight: 1.6 }}>{v.recommendation}</p>
              )}
            </div>


            {/* -- ZONE 2: THE CONVERSATION ------------------------ */}
            <div ref={chatContainerRef} className="fos-card" style={{ marginTop: 16, overflow: "hidden", border: `2px solid ${BRAND}20` }}>
              <div style={{ padding: 16 }}>
                {chatMessages.length === 0 && (
                  <div style={{ marginBottom: 14 }}>
                    {v.whatCouldChange?.length > 0 && (
                      <p style={{ fontSize: 12, fontWeight: 600, color: "#475569", margin: "0 0 10px", lineHeight: 1.5 }}>A few things that could change this recommendation:</p>
                    )}
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                      {(v.followUpQuestions || v.whatCouldChange || []).map((q: string) => (
                        <button key={q} onClick={() => { setChatInput(q); }} style={{ padding: "7px 14px", fontSize: 12, fontWeight: 600, border: "1px solid #E2E8F0", borderRadius: 99, background: "#F8FAFC", color: "#475569", cursor: "pointer", transition: "all 0.15s" }}>{q}</button>
                      ))}
                    </div>
                  </div>
                )}
                <div style={{ maxHeight: 400, overflowY: "auto", marginBottom: chatMessages.length ? 12 : 0 }}>
                  {chatMessages.map((m, i) => (
                    <div key={i} style={{ marginBottom: 8, textAlign: m.role === "user" ? "right" : "left" }}>
                      <div className="chat-msg" style={{ display: "inline-block", padding: "8px 14px", borderRadius: 14, fontSize: 13, lineHeight: 1.5, maxWidth: "85%", background: m.role === "user" ? BRAND : "#F1F5F9", color: m.role === "user" ? "#fff" : "#334155", textAlign: "left" }}>
                        {m.imageBase64 && <img src={m.imageBase64} style={{ maxWidth: "100%", maxHeight: 200, borderRadius: 8, marginBottom: m.content ? 8 : 0, display: "block" }} />}
                        {m.content && <ReactMarkdown>{m.content}</ReactMarkdown>}
                      </div>
                    </div>
                  ))}
                  {chatLoading && <div style={{ fontSize: 12, color: "#94A3B8" }}>Thinking...</div>}
                  <div ref={chatEndRef} />
                </div>
                
                {chatImage && (
                  <div style={{ marginBottom: 8, display: "inline-block", position: "relative" }}>
                    <img src={chatImage} style={{ height: 60, borderRadius: 8, objectFit: "cover", border: "1px solid #E2E8F0" }} />
                    <button onClick={() => setChatImage(null)} style={{ position: "absolute", top: -6, right: -6, background: RED, color: "#fff", border: "none", borderRadius: "50%", width: 20, height: 20, fontSize: 10, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>✕</button>
                  </div>
                )}
                
                <div style={{ display: "flex", gap: 8 }}>
                  <label style={{ cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", width: 42, height: 42, background: "#F1F5F9", borderRadius: 10, border: "1px solid #E2E8F0", color: "#64748B", flexShrink: 0, transition: "all 0.15s" }} className="fos-btn">
                    <input type="file" accept="image/*" style={{ display: "none" }} onChange={handleChatImageUpload} />
                    📷
                  </label>
                  <input value={chatInput} onChange={e => setChatInput(e.target.value)} onKeyDown={e => e.key === "Enter" && sendChat()} placeholder="Ask about this or upload a photo..." style={{ flex: 1, border: "1px solid #E2E8F0", borderRadius: 10, padding: "10px 14px", fontSize: 13, outline: "none", minWidth: 0 }} />
                  <button className="fos-btn" onClick={sendChat} disabled={(!chatInput.trim() && !chatImage) || chatLoading} style={{ padding: "10px 18px", background: BRAND, color: "#fff", borderRadius: 10, fontSize: 12, fontWeight: 700, opacity: (!chatInput.trim() && !chatImage) ? 0.4 : 1 }}>Send</button>
                </div>
              </div>
            </div>

            {/* -- ZONE 3: SUPPORTING DETAIL (collapsible) -------- */}
            <div style={{ marginTop: 24 }}>
              <p style={{ fontSize: 10, fontWeight: 800, letterSpacing: "0.12em", color: "#94A3B8", textTransform: "uppercase", margin: "0 0 10px" }}>Supporting detail</p>

              {/* Sell channels */}
              {se?.estimates?.length > 0 && (
                <details className="fos-card" style={{ marginBottom: 8, overflow: "hidden" }}>
                  <summary style={{ padding: "14px 24px", cursor: "pointer", fontSize: 13, fontWeight: 700, color: "#334155", listStyle: "none", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span>💰 If you sell — what to expect</span>
                    <span style={{ fontSize: 12, color: "#94A3B8" }}>{se.estimates.filter((c:any) => c.available !== false).length} channels</span>
                  </summary>
                  <div style={{ borderTop: "1px solid #E2E8F0" }}>
                    {se.disclaimer && <p style={{ fontSize: 10, color: "#94A3B8", padding: "8px 24px 0", margin: 0, lineHeight: 1.4 }}>{se.disclaimer}</p>}
                    {se.estimates.map((ch: any, i: number) => (
                      <div key={i} style={{ padding: "10px 24px", borderBottom: i < se.estimates.length - 1 ? "1px solid #F1F5F9" : "none", display: "flex", justifyContent: "space-between", alignItems: "center", opacity: ch.available === false ? 0.5 : 1 }}>
                        <div>
                          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                            <span style={{ fontSize: 13 }}>{ch.emoji}</span>
                            <span style={{ fontSize: 12, fontWeight: 700, color: "#0D1C2E" }}>{ch.label}</span>
                            {ch.available !== false && ch.channel === se.bestChannel && <span style={{ fontSize: 8, fontWeight: 800, background: "#DCFCE7", color: GREEN, padding: "2px 6px", borderRadius: 4, textTransform: "uppercase" }}>Best price</span>}
                            {ch.available === false && <span style={{ fontSize: 8, fontWeight: 800, background: "#FEE2E2", color: RED, padding: "2px 6px", borderRadius: 4, textTransform: "uppercase" }}>N/A</span>}
                          </div>
                          <p style={{ fontSize: 10, color: "#94A3B8", margin: "2px 0 0" }}>{ch.note}</p>
                        </div>
                        {ch.available !== false && <div style={{ textAlign: "right", whiteSpace: "nowrap" }}><p style={{ fontSize: 14, fontWeight: 800, color: "#0D1C2E", margin: 0 }}>${ch.low?.toLocaleString()}–${ch.high?.toLocaleString()}</p><p style={{ fontSize: 9, color: "#94A3B8", margin: 0 }}>{ch.timeframe}</p></div>}
                      </div>
                    ))}
                  </div>
                </details>
              )}

              {/* Quote breakdown */}
              {v.tieredItems?.length > 0 && (
                <details className="fos-card" style={{ marginBottom: 8, overflow: "hidden" }}>
                  <summary style={{ padding: "14px 24px", cursor: "pointer", fontSize: 13, fontWeight: 700, color: "#334155", listStyle: "none", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span>🔧 Quote breakdown</span>
                    <span style={{ fontSize: 12, color: "#94A3B8" }}>${Math.round(v.repairCost || 0).toLocaleString()} total</span>
                  </summary>
                  <div style={{ borderTop: "1px solid #E2E8F0" }}>
                    {v.tieredItems.map((item: any, i: number) => {
                      const cascade = v.cascadeItems?.[i];
                      const signalColor = cascade?.signal === 'sell_signal' ? RED : cascade?.signal === 'cascade' ? AMBER : cascade?.signal === 'one_time_fix' ? GREEN : null;
                      return (
                        <div key={i} style={{ padding: "10px 24px", borderBottom: i < v.tieredItems.length - 1 ? "1px solid #F1F5F9" : "none" }}>
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                              <span style={{ fontSize: 12 }}>{item.isFair === false ? "⚠️" : "✅"}</span>
                              <span style={{ fontSize: 12, fontWeight: 600, color: "#334155" }}>{item.description}</span>
                            </div>
                            <span style={{ fontSize: 12, fontWeight: 700, color: item.isFair === false ? RED : "#334155" }}>${Math.round(item.cost).toLocaleString()}</span>
                          </div>
                          {cascade && cascade.signal !== 'neutral' && <p style={{ fontSize: 11, color: signalColor || "#64748B", margin: "3px 0 0 20px", lineHeight: 1.4 }}>{cascade.note}</p>}
                        </div>
                      );
                    })}
                  </div>
                </details>
              )}

              {/* Comps */}
              {comps.length > 0 && (
                <details className="fos-card" style={{ marginBottom: 8, overflow: "hidden" }}>
                  <summary style={{ padding: "14px 24px", cursor: "pointer", fontSize: 13, fontWeight: 700, color: "#334155", listStyle: "none", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span>📊 Similar vehicles for sale</span>
                    <span style={{ fontSize: 12, color: "#94A3B8" }}>{comps.length} listings</span>
                  </summary>
                  <div style={{ borderTop: "1px solid #E2E8F0" }}>
                    <p style={{ fontSize: 10, color: AMBER, padding: "8px 24px 0", margin: 0, fontWeight: 600 }}>⚠️ These are running vehicles — yours would sell for less with the current repair needed.</p>
                    {comps.map((c: any, i: number) => (
                      <div key={i} style={{ padding: "10px 24px", borderBottom: i < comps.length - 1 ? "1px solid #F1F5F9" : "none", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <div><p style={{ fontSize: 12, fontWeight: 600, color: "#334155", margin: 0 }}>{c.heading?.slice(0, 40)}</p><p style={{ fontSize: 10, color: "#94A3B8", margin: "2px 0 0" }}>{c.miles?.toLocaleString()} mi · {c.city}, {c.state}</p></div>
                        <p style={{ fontSize: 13, fontWeight: 800, color: "#0D1C2E", margin: 0 }}>${c.price?.toLocaleString()}</p>
                      </div>
                    ))}
                  </div>
                </details>
              )}

              {/* Replacement risk */}
              {v.replacementRisk && (
                <details className="fos-card" style={{ marginBottom: 8, overflow: "hidden" }}>
                  <summary style={{ padding: "14px 24px", cursor: "pointer", fontSize: 13, fontWeight: 700, color: "#334155", listStyle: "none" }}>⚠️ What replacing this vehicle actually looks like</summary>
                  <div style={{ borderTop: "1px solid #E2E8F0", padding: "12px 24px" }}>
                    <p style={{ fontSize: 12, fontWeight: 600, color: "#475569", lineHeight: 1.6, margin: "0 0 8px" }}>{v.replacementRisk.summary}</p>
                    <ul style={{ margin: 0, paddingLeft: 18, listStyle: "disc" }}>
                      {v.replacementRisk.factors.map((f: string, i: number) => <li key={i} style={{ fontSize: 11, color: "#64748B", lineHeight: 1.6 }}>{f}</li>)}
                    </ul>
                  </div>
                </details>
              )}
            </div>

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
