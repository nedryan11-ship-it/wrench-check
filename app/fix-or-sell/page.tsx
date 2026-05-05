"use client";
import { useState, useRef, useCallback } from "react";

type Step = "input" | "vehicle" | "loading" | "verdict";
type Horizon = "<1yr" | "1-3yr" | "3+yr";

export default function FixOrSellPage() {
  const [step, setStep] = useState<Step>("input");
  const [tab, setTab] = useState<"file" | "text">("file");
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
    if (tab === "text" && textInput.trim().length < 15) return;

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

  const decisionColor = (d: string) => d === "fix" ? GREEN : d === "sell" ? RED : AMBER;
  const decisionEmoji = (d: string) => d === "fix" ? "🟢" : d === "sell" ? "🔴" : "🟡";
  const decisionLabel = (d: string) => d === "fix" ? "FIX IT" : d === "sell" ? "SELL" : "CLOSE CALL";

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
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", borderBottom: "1px solid #E2E8F0" }}>
              {(["file", "text"] as const).map(t => (
                <button key={t} onClick={() => setTab(t)} style={{ padding: "14px 12px", background: tab === t ? "#EFF4FF40" : "transparent", border: "none", borderBottom: tab === t ? `2px solid ${BRAND}` : "2px solid transparent", cursor: "pointer", fontSize: 11, fontWeight: 800, letterSpacing: "0.1em", textTransform: "uppercase", color: tab === t ? BRAND : "#94A3B8" }}>
                  {t === "file" ? "📄 Upload file" : "✏️ Type / paste"}
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

        {/* ── VERDICT ─────────────────────────────────────────────────── */}
        {step === "verdict" && result && (() => {
          const v = result.verdict;
          const dc = decisionColor(v.decision);
          return (<>
            {/* Headline card */}
            <div className="fos-card" style={{ padding: "32px 28px", textAlign: "center", borderLeft: `4px solid ${dc}` }}>
              <div style={{ fontSize: 40, marginBottom: 8 }}>{decisionEmoji(v.decision)}</div>
              <h2 style={{ fontSize: 32, fontWeight: 900, color: dc, letterSpacing: "-0.03em", margin: "0 0 6px" }}>{decisionLabel(v.decision)}</h2>
              <p style={{ fontSize: 15, fontWeight: 600, color: "#475569", margin: 0 }}>{v.headline}</p>
            </div>

            {/* Key numbers */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, marginTop: 16 }}>
              {[
                ["CAR VALUE", `~$${v.vehicleValue?.toLocaleString()}`, "#64748B"],
                ["REPAIR COST", `$${v.repairCost?.toLocaleString()}`, dc],
                ["REPAIR RATIO", `${v.repairRatio}%`, dc],
              ].map(([label, val, color]) => (
                <div key={label as string} className="fos-card" style={{ padding: "16px 12px", textAlign: "center" }}>
                  <p style={{ fontSize: 9, fontWeight: 800, letterSpacing: "0.12em", color: "#94A3B8", margin: "0 0 4px", textTransform: "uppercase" }}>{label}</p>
                  <p style={{ fontSize: 22, fontWeight: 900, color: color as string, margin: 0, letterSpacing: "-0.02em" }}>{val}</p>
                </div>
              ))}
            </div>

            {/* Explanation */}
            <div className="fos-card" style={{ padding: "20px 24px", marginTop: 16 }}>
              <p style={{ fontSize: 14, color: "#334155", lineHeight: 1.7, margin: 0 }}>{v.explanation}</p>
            </div>

            {/* What I'd Do */}
            <div className="fos-card" style={{ padding: "20px 24px", marginTop: 16, background: `${dc}08`, borderColor: `${dc}30` }}>
              <p style={{ fontSize: 10, fontWeight: 900, letterSpacing: "0.12em", color: dc, margin: "0 0 6px", textTransform: "uppercase" }}>WHAT I'D DO</p>
              <p style={{ fontSize: 14, fontWeight: 600, color: "#0D1C2E", lineHeight: 1.6, margin: 0 }}>{v.recommendation}</p>
            </div>

            {/* Quote breakdown */}
            {result.quote?.items?.length > 0 && (
              <div className="fos-card" style={{ marginTop: 16, overflow: "hidden" }}>
                <div style={{ padding: "14px 24px", borderBottom: "1px solid #E2E8F0" }}>
                  <p style={{ fontSize: 10, fontWeight: 900, letterSpacing: "0.12em", color: "#94A3B8", margin: 0, textTransform: "uppercase" }}>QUOTE BREAKDOWN</p>
                </div>
                {result.quote.items.map((item: any, i: number) => (
                  <div key={i} style={{ padding: "10px 24px", borderBottom: i < result.quote.items.length - 1 ? "1px solid #F1F5F9" : "none", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ fontSize: 13 }}>{item.isFair === false ? "⚠️" : "✅"}</span>
                      <span style={{ fontSize: 13, fontWeight: 600, color: "#334155" }}>{item.description}</span>
                    </div>
                    <div style={{ textAlign: "right" }}>
                      <span style={{ fontSize: 13, fontWeight: 700, color: item.isFair === false ? RED : "#334155" }}>${item.cost?.toLocaleString()}</span>
                      {item.fairPriceRange && (
                        <span style={{ fontSize: 10, color: "#94A3B8", marginLeft: 6 }}>
                          (fair: ${item.fairPriceRange.low}–${item.fairPriceRange.high})
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Confidence note */}
            <p style={{ fontSize: 11, color: "#94A3B8", textAlign: "center", marginTop: 12 }}>{v.confidenceNote}</p>

            {/* Chat */}
            <div className="fos-card" style={{ marginTop: 20, overflow: "hidden" }}>
              <button onClick={() => setChatOpen(!chatOpen)} style={{ width: "100%", padding: "14px 24px", border: "none", background: "transparent", cursor: "pointer", display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 18 }}>💬</span>
                <span style={{ fontSize: 13, fontWeight: 700, color: BRAND }}>Have questions? Ask the advisor.</span>
                <span style={{ marginLeft: "auto", fontSize: 12, color: "#94A3B8" }}>{chatOpen ? "▲" : "▼"}</span>
              </button>
              {chatOpen && (
                <div style={{ borderTop: "1px solid #E2E8F0", padding: 16 }}>
                  {chatMessages.length === 0 && (
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 12 }}>
                      {["What if I keep it 2 more years?", "Is the repair price fair?", "What else might break soon?"].map(q => (
                        <button key={q} onClick={() => { setChatInput(q); }} style={{ padding: "6px 12px", fontSize: 11, fontWeight: 600, border: "1px solid #E2E8F0", borderRadius: 99, background: "#F8FAFC", color: "#475569", cursor: "pointer" }}>{q}</button>
                      ))}
                    </div>
                  )}
                  <div style={{ maxHeight: 300, overflowY: "auto", marginBottom: 12 }}>
                    {chatMessages.map((m, i) => (
                      <div key={i} style={{ marginBottom: 8, textAlign: m.role === "user" ? "right" : "left" }}>
                        <span style={{ display: "inline-block", padding: "8px 14px", borderRadius: 14, fontSize: 13, lineHeight: 1.5, maxWidth: "85%", background: m.role === "user" ? BRAND : "#F1F5F9", color: m.role === "user" ? "#fff" : "#334155" }}>{m.content}</span>
                      </div>
                    ))}
                    {chatLoading && <div style={{ fontSize: 12, color: "#94A3B8" }}>Thinking...</div>}
                  </div>
                  <div style={{ display: "flex", gap: 8 }}>
                    <input value={chatInput} onChange={e => setChatInput(e.target.value)} onKeyDown={e => e.key === "Enter" && sendChat()} placeholder="Ask anything about this repair..." style={{ flex: 1, border: "1px solid #E2E8F0", borderRadius: 10, padding: "10px 14px", fontSize: 13, outline: "none" }} />
                    <button className="fos-btn" onClick={sendChat} disabled={!chatInput.trim() || chatLoading} style={{ padding: "10px 18px", background: BRAND, color: "#fff", borderRadius: 10, fontSize: 12, fontWeight: 700, opacity: !chatInput.trim() ? 0.4 : 1 }}>Send</button>
                  </div>
                </div>
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
