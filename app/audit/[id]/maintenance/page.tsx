"use client";

import React, { useState, useEffect, useRef } from "react";
import { ChevronDown, ChevronUp, Send, Check, AlertTriangle, Shield, MessageSquare } from "lucide-react";
import { useRouter } from "next/navigation";

// ─── Typing dots ─────────────────────────────────────────────────────────────
const TypingDots = () => (
  <div style={{ display: "flex", gap: 4, padding: "10px 14px", background: "#F1F5F9", borderRadius: 14, width: "fit-content" }}>
    {[0, 1, 2].map((i) => (
      <div key={i} style={{ width: 5, height: 5, borderRadius: "50%", background: "#94A3B8", animation: "wrenchDot 1.4s infinite ease-in-out both", animationDelay: `${i * 0.16}s` }} />
    ))}
  </div>
);

// ─── Status dot ──────────────────────────────────────────────────────────────
const SDot = ({ status }: { status: string }) => {
  const c = status === "done" ? "#16A34A" : status === "upcoming" ? "#B45309" : (status === "overdue" || status === "due_now") ? "#B91C1C" : "#94A3B8";
  return <div style={{ width: 8, height: 8, borderRadius: "50%", background: c, flexShrink: 0, marginTop: 5 }} />;
};

// ─── Tooltip (desktop only) ───────────────────────────────────────────────────
const Tooltip = ({ tip, children }: { tip: string; children: React.ReactNode }) => {
  const [show, setShow] = useState(false);
  return (
    <div style={{ position: "relative", display: "inline-flex" }}
      onMouseEnter={() => setShow(true)} onMouseLeave={() => setShow(false)}>
      {children}
      {show && (
        <div style={{
          position: "absolute", bottom: "calc(100% + 8px)", left: "50%", transform: "translateX(-50%)",
          background: "#0F172A", color: "#F8FAFC", fontSize: 12, fontWeight: 500, lineHeight: 1.5,
          padding: "8px 12px", borderRadius: 10, zIndex: 999,
          boxShadow: "0 8px 24px rgba(0,0,0,0.18)", pointerEvents: "none", maxWidth: 260,
          whiteSpace: "normal", textAlign: "left",
        }}>
          {tip}
          <div style={{ position: "absolute", top: "100%", left: "50%", transform: "translateX(-50%)", width: 0, height: 0, borderLeft: "6px solid transparent", borderRight: "6px solid transparent", borderTop: "6px solid #0F172A" }} />
        </div>
      )}
    </div>
  );
};

// ─── Inline Detail (progressive disclosure) ───────────────────────────────────
const InlineDetail = ({ description, interval, cost, why }: { description?: string; interval?: string; cost?: string; why?: string }) => {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ marginTop: 4 }}>
      <button onClick={() => setOpen(!open)}
        style={{ background: "none", border: "none", padding: 0, fontSize: 12, color: "#4F46E5", fontWeight: 600, cursor: "pointer" }}>
        {open ? "Hide details" : "Why?"}
      </button>
      {open && (
        <div style={{ marginTop: 8, padding: "10px 12px", background: "#F8FAFC", border: "1px solid #E2E8F0", borderRadius: 8, fontSize: 13, color: "#475569", lineHeight: 1.5 }}>
          {description && <div style={{ marginBottom: 6 }}><strong style={{ color: "#0F172A" }}>What:</strong> {description}</div>}
          {why && <div style={{ marginBottom: 6 }}><strong style={{ color: "#0F172A" }}>Why:</strong> {why}</div>}
          {cost && <div><strong style={{ color: "#0F172A" }}>Typical cost:</strong> {cost}</div>}
        </div>
      )}
    </div>
  );
};

// ─── Main ─────────────────────────────────────────────────────────────────────
export default function MaintenanceAuditPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = React.use(params);
  const router = useRouter();

  const [result, setResult] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [askingPriceInput, setAskingPriceInput] = useState("");
  const [askingPrice, setAskingPrice] = useState<number | null>(null);
  const [ledger, setLedger] = useState<Record<string, boolean>>({});
  const [isMobile, setIsMobile] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [chatOpen, setChatOpen] = useState(false);
  const [chatInput, setChatInput] = useState("");
  const [messages, setMessages] = useState<{ role: string; content: string; isRiskOnPrompt?: boolean }[]>([]);
  const [chatLoading, setChatLoading] = useState(false);
  const [riskOnMode, setRiskOnMode] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const chatBarRef = useRef<HTMLDivElement>(null);
  const [chatBarH, setChatBarH] = useState(76);
  // URL extraction
  const [listingUrl, setListingUrl] = useState("");
  const [urlLoading, setUrlLoading] = useState(false);
  const [urlStatus, setUrlStatus] = useState<{ ok: boolean; msg: string } | null>(null);
  // Price sanity warning
  const [priceWarning, setPriceWarning] = useState<string | null>(null);

  useEffect(() => {
    const handleResize = () => setIsMobile(window.innerWidth < 1024);
    handleResize();
    window.addEventListener("resize", handleResize);
    try {
      const raw = sessionStorage.getItem("maintenance_audit_result");
      if (!raw) return;
      const data = JSON.parse(raw);
      setResult(data);
      // Pre-populate asking price if entered on upload form — formatted with commas
      if (data.askingPrice) {
        const formatted = parseInt(String(data.askingPrice), 10).toLocaleString("en-US");
        setAskingPriceInput(formatted);
        setAskingPrice(data.askingPrice);
      }
      const od = (data.debtItems || []).filter((i: any) => i.status === "overdue" || i.status === "due_now");
      const total = od.reduce((s: number, i: any) => s + Math.round(((i.estimatedCostLow || 0) + (i.estimatedCostHigh || 0)) / 2), 0);
      const init: Record<string, boolean> = {};
      od.forEach((i: any) => { init[i.canonicalService] = true; });
      setLedger(init);

      // Risk On auto-detection
      const controversyIndex = data.modelInsights?.controversyIndex ?? 3;
      const carName = `${data.vehicle?.year} ${data.vehicle?.make} ${data.vehicle?.model}`;
      const isHighControversy = controversyIndex >= 6;

      if (isHighControversy) {
        // Soft opener with two-button choice — don't push the "bad idea" narrative
        setMessages([{
          role: "assistant",
          content: `I see you're looking at the ${carName}. I can go two directions with you:\n\n**Help you decide** — I'll give you an honest view of whether this makes sense for your situation, including alternatives.\n\n**Help you buy this well** — I'll assume you want this car and focus entirely on which example is worth buying, what to budget, and what to watch for.\n\nWhich would be more useful?`,
          isRiskOnPrompt: true,
        }]);
      } else {
        const opener = od.length === 0
          ? `Audit complete for your ${carName}. No overdue maintenance found — ask me anything.`
          : `Audit complete for your ${carName}. Found ${od.length} gap${od.length > 1 ? "s" : ""} — ~$${total.toLocaleString()} in deferred work. What can I help clarify?`;
        setMessages([{ role: "assistant", content: opener }]);
      }
    } catch { /* noop */ }
    finally { setLoading(false); }
    return () => window.removeEventListener("resize", handleResize);
  }, [id]);

  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]);

  useEffect(() => {
    if (!chatBarRef.current) return;
    const ro = new ResizeObserver(() => { if (chatBarRef.current) setChatBarH(chatBarRef.current.offsetHeight); });
    ro.observe(chatBarRef.current);
    return () => ro.disconnect();
  }, [chatOpen]);

  const sendMessage = async (preset?: string) => {
    const text = preset || chatInput;
    if (!text.trim()) return;
    const next = [...messages, { role: "user", content: text }];
    setMessages(next); setChatInput(""); setChatLoading(true); setChatOpen(true);
    try {
      // Full UI brain state — chat must have zero daylight from what the UI shows
      const context = {
        // Vehicle
        vehicle: vehicleLabel,
        mileage: vehicle.currentMileage,
        vin: vehicle.vin ?? null,

        // Condition (price-independent)
        conditionLabel: conditionCfg.label,      // "Solid condition" / "Minor gaps found" / "Notable gaps found"
        conditionBullets: whyBullets,            // the 3 bullets shown under the verdict

        // Verdict (price-dependent if available, otherwise condition-only)
        verdictLabel: vCfg.label,               // "Strong Buy" / "Good Buy" / "Solid condition" etc.
        rawVerdict: result?.verdict,

        // Pricing
        mode,  // price_driven | maintenance_driven | mixed
        priceGapSummary: priceGap?.text ?? null,
        marketRange: { low: mv.low, high: mv.high, mid: marketMid, isEstimated: mv.source !== "marketcheck", source: mv.source ?? "ai_estimated" },
        marketRangeDisplay,  // natural format: ~$38k–$42k
        adjustedFairValue: fairTargetMid,
        pricingImpact,
        impactTier,
        askingPrice: askingPrice ?? null,
        dealClassification: deal ? { label: deal.label, mood: deal.mood, explanation: (deal as any).explain } : null,
        offerRange: askingPrice ? { low: offerLow, high: offerHigh } : null,
        confidence: confidence.level,

        // Recommendation — chat must ONLY reinforce this, never contradict
        whatIdDo,
        verdictIsFinal: true,  // signal: chat cannot override system verdict

        // Maintenance
        conditionDebt,
        pricingImpactDollars: pricingImpact,
        overdueItems: riskAdjustedItems.map((i: any) => ({
          name: i.displayName,
          status: i.status,
          riskLevel: i.riskLevel,
          fullCost: i.mid,
          pricingImpact: i.impact,
          multiplier: Math.round(i.multiplier * 100) + "%",
        })),

        // Model intelligence
        watchouts: watchoutItems.slice(0, 3).map((w: any) => ({
          issue: w.text?.split("–")[0]?.trim(),
          estimatedCost: w.estimatedCost,
        })),
        expertTake: modelInsights?.expertTake ?? null,
        ownershipOutlook: modelInsights?.ownershipOutlook ?? null,
        upcomingServices: (modelInsights?.namedUpcoming ?? []).map((s: any) => ({
          name: s.name,
          dueMileage: s.dueMileage,
          cost: s.estimatedCost,
        })),
      };
      const res = await fetch("/api/audit-chat", { method: "POST", body: JSON.stringify({ messages: next, auditId: id, context, riskOnMode }), headers: { "Content-Type": "application/json" } });
      const d = await res.json();
      setMessages([...next, { role: "assistant", content: d.reply }]);
    } catch { /* noop */ }
    finally { setChatLoading(false); }
  };


  // ─── Extract price from listing URL ─────────────────────────────────────────
  const extractListingPrice = async (url: string) => {
    if (!url.startsWith("http")) return;
    setUrlLoading(true); setUrlStatus(null);
    try {
      const res = await fetch("/api/extract-listing-price", {
        method: "POST",
        body: JSON.stringify({ url }),
        headers: { "Content-Type": "application/json" },
      });
      const d = await res.json();
      if (d.price) {
        const formatted = parseInt(d.price, 10).toLocaleString("en-US");
        setAskingPriceInput(formatted);
        setAskingPrice(d.price);
        setUrlStatus({ ok: true, msg: `✓ $${d.price.toLocaleString()} from ${d.source}` });
      } else {
        setUrlStatus({ ok: false, msg: "Couldn't read price — enter it manually below" });
      }
    } catch {
      setUrlStatus({ ok: false, msg: "Fetch failed — enter price manually" });
    } finally { setUrlLoading(false); }
  };

  const applyPrice = () => {
    const p = parseFloat(askingPriceInput.replace(/[^0-9.,]/g, "").replace(/,/g, ""));
    if (!isNaN(p) && p > 0) {
      setAskingPrice(p);
      // Sanity check against AI market estimate (rough bounds only)
      // mv is computed later in render, but result.marketValueEstimate may be available
      const mvRaw = result?.marketValueEstimate;
      if (mvRaw) {
        const sanityLow = mvRaw.low * 0.45;
        const sanityHigh = mvRaw.high * 2.5;
        if (p < sanityLow) {
          setPriceWarning(`That seems very low for a ${result?.vehicle?.year ?? ""} ${result?.vehicle?.make ?? ""}. Double-check the price.`);
        } else if (p > sanityHigh) {
          setPriceWarning(`That seems high — is $${p.toLocaleString()} the asking price, not the MSRP?`);
        } else {
          setPriceWarning(null);
        }
      } else {
        setPriceWarning(null);
      }
    }
  };

  const copyText = (text: string, key: string) => {
    navigator.clipboard.writeText(text);
    setCopied(key);
    setTimeout(() => setCopied(null), 2000);
  };

  // ─── Loading / empty states ────────────────────────────────────────────────
  if (loading) return (
    <div style={{ minHeight: "100vh", background: "#F8FAFC", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 20 }}>
      <div style={{ position: "relative", width: 60, height: 60 }}>
        <div style={{ position: "absolute", inset: 0, border: "2px solid #E2E8F0", borderRadius: "50%" }} />
        <div style={{ position: "absolute", inset: 0, border: "2px solid #4F46E5", borderRadius: "50%", borderTopColor: "transparent", animation: "spin 1s linear infinite" }} />
        <Shield style={{ position: "absolute", top: "50%", left: "50%", transform: "translate(-50%,-50%)" }} color="#4F46E5" size={20} />
      </div>
      <p style={{ color: "#64748B", fontSize: 14, margin: 0 }}>Analyzing your vehicle…</p>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );

  if (!result) return (
    <div style={{ minHeight: "100vh", background: "#F8FAFC", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ textAlign: "center" }}>
        <p style={{ color: "#64748B", fontSize: 15, marginBottom: 16 }}>No audit result found.</p>
        <button onClick={() => router.push("/")} style={{ color: "#4F46E5", background: "none", border: "none", cursor: "pointer", fontSize: 14 }}>← Go back</button>
      </div>
    </div>
  );

  // ─── Derived data ──────────────────────────────────────────────────────────
  const vehicle = result.vehicle;
  const vehicleLabel = `${vehicle.year} ${vehicle.make} ${vehicle.model}`;
  const allItems: any[] = result.debtItems || [];
  const overdue: any[] = allItems.filter(i => i.status === "overdue" || i.status === "due_now");
  const rawHistory: any[] = result.extractedHistory || [];
  const matchedIds = new Set<string>(allItems.flatMap((i: any) => i.matchingHistoryEventIds || []));
  const modelInsights: any = result.modelInsights || null;
  const carfaxSignals: any = result.carfaxSignals || null;

  const conditionDebt = overdue.reduce((s, i) => {
    return s + Math.round(((i.estimatedCostLow || 0) + (i.estimatedCostHigh || 0)) / 2);
  }, 0);

  // Risk-weighted pricing impact: severity x timing multiplier.
  // conditionDebt = full cost (used for negotiation talking points).
  // pricingImpact = market-relevant discount (not all deferred work justifies 1:1 reduction).
  const riskAdjustedItems = overdue.map(item => {
    const mid = Math.round(((item.estimatedCostLow||0)+(item.estimatedCostHigh||0))/2);
    const isNow = item.status === "due_now";
    const sev = (item.severity || "low") as string;
    const multiplier =
      sev === "high"   ? (isNow ? 0.95 : 0.82) :
      sev === "medium" ? (isNow ? 0.70 : 0.55) :
                         (isNow ? 0.45 : 0.30);
    const riskLevel: "High" | "Medium" | "Low" = sev === "high" ? "High" : sev === "medium" ? "Medium" : "Low";
    return { ...item, mid, multiplier, impact: Math.round(mid * multiplier), riskLevel };
  });
  const pricingImpact = riskAdjustedItems.reduce((s, i) => s + i.impact, 0);
  const impactTier = pricingImpact >= 1000 ? "major" : pricingImpact >= 300 ? "moderate" : "minor";

  const mvRaw = result.marketValueEstimate;
  const mv = mvRaw ?? (() => {
    const age = new Date().getFullYear() - (vehicle.year ?? 2015);
    const base = Math.max(4000, 35000 * Math.pow(0.85, age) - Math.max(0, (vehicle.currentMileage ?? 80000) - 50000) * 0.04);
    return { low: Math.round(base * 0.88 / 100) * 100, high: Math.round(base * 1.12 / 100) * 100 };
  })();
  const mvIsEst = true; // always true until we have a real market data API (VehicleDatabases returns 403)

  const marketMid = Math.round((mv.low + mv.high) / 2);
  const marketRange = mv.high - mv.low;
  // fairTargetMid uses risk-weighted pricingImpact, not full conditionDebt
  const fairTargetMid = Math.max(Math.round(marketMid - pricingImpact), mv.low);
  const fairTargetLow = Math.max(Math.round(fairTargetMid - 600), Math.round(mv.low * 0.9));
  const fairTargetHigh = Math.max(Math.round(fairTargetMid + 200), fairTargetLow + 500);

  // Price positioning: anchored to actual market range, not estimated mid
  const pricePosition = (p: number | null) => {
    if (!p) return null;
    if (p < mv.low * 0.93)             return { label: "Great Buy",   color: "#15803D", mood: "strong", explain: "Priced materially below market — strong deal if condition checks out." };
    if (p <= mv.low + marketRange * 0.5) return { label: "Good Buy",   color: "#16A34A", mood: "low",    explain: "Within market range on the lower end — a good deal, not unusually cheap." };
    if (p <= mv.high)                  return { label: "Fair Deal",   color: "#1D4ED8", mood: "mid",    explain: "Mid-to-upper market range — fair if the car is in good condition." };
    return                               { label: "Overpriced",   color: "#B91C1C", mood: "over",   explain: "Above market range — negotiate or walk." };
  };
  const deal = pricePosition(askingPrice);

  let offerLow = fairTargetLow;
  let offerHigh = fairTargetHigh;
  if (askingPrice) {
    if (deal?.mood === "strong" || deal?.mood === "low") {
      offerLow = askingPrice; offerHigh = askingPrice;
    } else {
      offerHigh = Math.min(fairTargetHigh, askingPrice - 100);
      offerLow = Math.min(fairTargetLow, offerHigh - 500);
    }
  }

  // ─── Condition assessment (price-independent) ────────────────────────────
  const highItems = overdue.filter(i => i.severity === "high");
  const conditionScore = highItems.length > 0 ? 2 : overdue.length > 0 ? 1 : 0;
  const conditionCfg = [
    { label: "Solid condition",    accent: "#15803D", bg: "#F0FDF4",
      bridge: overdue.length === 0
        ? "Looks like a solid car — now add the asking price to see if it's a good deal."
        : "Mostly solid — now add the asking price to see how the gaps affect the deal." },
    { label: "Minor gaps found",   accent: "#B45309", bg: "#FFFBEB",
      bridge: "Some maintenance gaps found — add the asking price to quantify the impact on your offer." },
    { label: "Notable gaps found", accent: "#C2410C", bg: "#FFF7ED",
      bridge: "Notable gaps — add the asking price to see how much to negotiate." },
  ][conditionScore];

  // ─── Number formatters ───────────────────────────────────────────────────
  const fmtK = (n: number) => n >= 10000 ? `$${Math.round(n / 1000)}k` : `$${Math.round(n / 100) * 100}`;

  // ─── Mode classification ─────────────────────────────────────────────────
  // Determines which "lens" dominates the report: price, maintenance, or both.
  const mode: "price_driven" | "maintenance_driven" | "mixed" = (() => {
    const age = new Date().getFullYear() - (vehicle.year ?? 2015);
    const mileage = vehicle.currentMileage ?? 0;
    const highRisk = overdue.filter((i: any) => i.severity === "high").length;
    if (age <= 3 && mileage < 35000 && conditionDebt < 500 && highRisk === 0) return "price_driven";
    if (age >= 7 || mileage > 85000 || conditionDebt > 1500 || highRisk >= 2) return "maintenance_driven";
    return "mixed";
  })();

  // ─── Verdict: mode × price ─────────────────────────────────────────────────────
  // Spec rule 3: Risky car → "Proceed with Caution" or worse
  //              Clean + overpriced → "Buy if Priced Right" (not "Overpriced")
  //              Clean + fairly priced → "Good Buy"
  //              Clean + underpriced → "Strong Buy"
  const v = result.verdict as string;
  const vCfg = (() => {
    if (!askingPrice) return conditionCfg;

    const isRisky = mode === "maintenance_driven";
    const isClean = mode === "price_driven";

    // Underpriced always good regardless of condition
    if (deal?.mood === "strong") return isClean || overdue.length === 0
      ? { label: "Strong Buy",           accent: "#15803D", bg: "#F0FDF4", bridge: "" }
      : { label: "Good Deal — Buy",       accent: "#15803D", bg: "#F0FDF4", bridge: "" };

    // Overpriced: escalate severity based on condition
    if (deal?.mood === "over") return isRisky
      ? { label: "Proceed with Caution",  accent: "#B91C1C", bg: "#FEF2F2", bridge: "" }
      : { label: "Buy if Priced Right",   accent: "#B45309", bg: "#FFFBEB", bridge: "" };

    // Fairly priced (low or mid market)
    if (isRisky) return { label: "Proceed with Caution",  accent: "#B91C1C", bg: "#FEF2F2", bridge: "" };
    if (isClean) return { label: "Good Buy",               accent: "#1D4ED8", bg: "#EFF6FF", bridge: "" };

    // Mixed: let maintenance verdict decide
    if (overdue.length === 0) return { label: "Good Buy",               accent: "#1D4ED8", bg: "#EFF6FF", bridge: "" };
    return                           { label: "Buy if Priced Right",    accent: "#B45309", bg: "#FFFBEB", bridge: "" };
  })();

  const reinforcingSentence = !askingPrice
    ? conditionCfg.bridge
    : vCfg.label === "Strong Buy"            ? "This is a well-maintained example priced below market — better than most."
    : vCfg.label === "Good Deal — Buy"       ? "Priced below market despite some service gaps — good value if condition checks out."
    : vCfg.label === "Good Buy"              ? "Solid car, fair price. Buy at asking and move on."
    : vCfg.label === "Buy if Priced Right"   ? "Good car with maintenance gaps or above market — negotiate the gap before committing."
    : vCfg.label === "Proceed with Caution"  ? "Notable risk here — either the price is above market, the maintenance debt is high, or both."
    :                                          "Solid car with consistent service.";

  // Service quality bullets — quality first, not raw count
  const whyBullets: string[] = [];
  const dealerRecords = rawHistory.filter((h: any) => /dealer|dealership|service center/i.test(h.rawDescription || ""));
  const hasConsistentHistory = rawHistory.length >= 4;
  if (dealerRecords.length > 1) whyBullets.push("Consistent dealer service history on file");
  else if (dealerRecords.length === 1) whyBullets.push("At least one dealer service record on file");
  else if (hasConsistentHistory) whyBullets.push("Service history documented across multiple sources");
  else if (rawHistory.length > 0) whyBullets.push("Some service records available");
  else whyBullets.push("Limited service documentation — ask seller for records");
  if (overdue.length === 0)  whyBullets.push("No overdue maintenance");
  else                       whyBullets.push(`${overdue.length} maintenance gap${overdue.length > 1 ? "s" : ""} — factor into offer`);
  if (highItems.length === 0) whyBullets.push("No high-severity mechanical concerns");
  else whyBullets.push(`${highItems.length} high-severity item${highItems.length > 1 ? "s" : ""} flagged`);

  const matters: any[] = [];
  if (overdue.length > 0) {
    const top = overdue[0];
    const rest = overdue.slice(1);
    matters.push({
      prefix: "Action needed",
      headline: top.displayName,
      subline: rest.length > 0 ? `+ ${rest.length} more overdue item${rest.length > 1 ? "s" : ""}` : "Catch up before buying",
      cost: `~$${Math.round(((top.estimatedCostLow||0)+(top.estimatedCostHigh||0))/2).toLocaleString()}`,
      details: { description: top.description, why: "Deferred maintenance causes accelerated wear and potential failure.", cost: `$${(top.estimatedCostLow||0).toLocaleString()}–$${(top.estimatedCostHigh||0).toLocaleString()}` },
      askQ: `How serious is the ${top.displayName} being overdue?`,
    });
  }
  const namedUpcoming = modelInsights?.namedUpcoming || [];
  if (namedUpcoming.length > 0) {
    const up = namedUpcoming[0];
    matters.push({
      prefix: "Likely next",
      headline: up.name,
      subline: "Due soon based on mileage",
      cost: `~$${up.estimatedCost?.toLocaleString()}`,
      details: { description: `Scheduled ${up.name} service.`, cost: `~$${up.estimatedCost?.toLocaleString()}` },
      askQ: `How urgent is the upcoming ${up.name}?`,
    });
  }

  // Spec rule 9: direct, no hedging, mode-aware
  const whatIdDo = (() => {
    if (!askingPrice) {
      if (mode === "maintenance_driven")
        return `Enter asking price. This car has ~${fmtK(conditionDebt)} in maintenance debt — use ~${fmtK(fairTargetLow)} as your target.`;
      if (mode === "price_driven")
        return `Enter asking price. Clean history — compare against market mid of ~${fmtK(marketMid)} to know if it's worth it.`;
      return conditionDebt > 0
        ? `Enter asking price. Maintenance gaps suggest targeting around ~${fmtK(fairTargetMid)}.`
        : `Enter asking price. Clean history — anything near market mid (~${fmtK(marketMid)}) is a fair deal.`;
    }
    if (deal?.mood === "strong")
      return `Buy at asking — priced below market. Don't negotiate, just verify condition and move.`;
    if (deal?.mood === "low" && mode !== "maintenance_driven")
      return `Buy at asking — fairly priced${overdue.length === 0 ? " with clean history" : ""}. No meaningful negotiation edge.`;
    if (deal?.mood === "mid" && mode === "price_driven")
      return `Fair price, clean car. Buy at asking or nudge by $500–$1k max — don’t lose it over noise.`;
    if (deal?.mood === "mid" && conditionDebt > 0)
      return `Fair price but ~${fmtK(conditionDebt)} in deferred work. Ask for $${(Math.round(conditionDebt * 0.6 / 500) * 500).toLocaleString()} off or walk.`;
    if (deal?.mood === "over" && mode !== "maintenance_driven")
      return `Overpriced — target ~${fmtK(offerLow)} or walk. ${conditionDebt > 0 ? `Use the ~${fmtK(conditionDebt)} maintenance gap as leverage.` : "Market data is your leverage."}`;
    if (deal?.mood === "over" && mode === "maintenance_driven")
      return `Overpriced AND high maintenance risk — hard pass unless they come down to ~${fmtK(offerLow)} and you’re prepared to spend more.`;
    if (mode === "maintenance_driven")
      return `High maintenance risk — negotiate to ~${fmtK(fairTargetMid)} or avoid. Don’t pay full price with this history.`;
    return conditionCfg.bridge;
  })();


  const outlookLine = modelInsights?.ownershipOutlook || `~$${Math.round((conditionDebt + 800) * 0.8).toLocaleString()}–$${Math.round((conditionDebt + 1200) * 1.2).toLocaleString()} likely in the next 12–18 months`;
  const scoreIdx = Math.min(conditionDebt < 500 ? 0 : conditionDebt < 1200 ? 1 : conditionDebt < 2500 ? 2 : 3, 3);
  const profile = {
    label: ["Low maintenance expected", "Moderate upkeep expected", "Higher near-term costs", "Elevated repair risk"][scoreIdx],
    color: ["#15803D", "#B45309", "#C2410C", "#B91C1C"][scoreIdx],
  };

  const marketRangeDisplay = `~${fmtK(mv.low)}–${fmtK(mv.high)}`;

  // ─── Explicit price gap — the most important output ──────────────────────
  const priceGap = askingPrice && marketMid > 0 ? (() => {
    const diff = askingPrice - marketMid;
    const absDiff = Math.abs(diff);
    const pct = absDiff / marketMid;
    if (pct < 0.04) return { text: "About right — within market range", detail: `vs. ~${fmtK(marketMid)} market mid`, mood: "fair" as const, color: "#1D4ED8" };
    const rounded = Math.round(absDiff / 500) * 500;
    if (diff > 0) return { text: `Overpaying by ~${fmtK(rounded)}`, detail: `vs. ~${fmtK(marketMid)} market mid`, mood: "over" as const, color: "#B91C1C" };
    return { text: `Below market by ~${fmtK(rounded)}`, detail: `vs. ~${fmtK(marketMid)} market mid`, mood: "under" as const, color: "#15803D" };
  })() : null;

  const generatePitch = (isLong: boolean) => {
    const selected = overdue.filter(i => ledger[i.canonicalService]);
    const debt = selected.reduce((s, i) => s + Math.round(((i.estimatedCostLow || 0) + (i.estimatedCostHigh || 0)) / 2), 0);
    if (isLong) {
      if (debt > 0) return `Hi — I've reviewed the ${vehicleLabel}'s service history. There are ${selected.length} past-due item${selected.length > 1 ? "s" : ""}: ${selected.map(i => i.displayName).join(", ")} — estimated ~$${debt.toLocaleString()} to address. Given that, I'd like to offer $${offerLow.toLocaleString()}. Does that work?`;
      return `Hi — I've reviewed the ${vehicleLabel}. Based on the clean service history and current market data, I'd like to offer $${offerLow.toLocaleString()}. Let me know if that works.`;
    }
    return debt > 0
      ? `I'm interested in the ${vehicleLabel}. Service records show ~$${debt.toLocaleString()} in deferred work. Can we do $${offerLow.toLocaleString()}?`
      : `I'm interested in the ${vehicleLabel}. Is there flexibility on the price? I'd like to be at $${offerLow.toLocaleString()}.`;
  };

  const stoplightOrder: Record<string, number> = { due_now: 0, overdue: 1, upcoming: 2, unknown: 3, done: 4 };
  const sortedItems = [...allItems].sort((a, b) => (stoplightOrder[a.status] ?? 5) - (stoplightOrder[b.status] ?? 5));
  const statusCfg: Record<string, { label: string; color: string }> = {
    done:    { label: "Verified",  color: "#15803D" },
    upcoming:{ label: "Upcoming",  color: "#B45309" },
    overdue: { label: "Overdue",   color: "#B91C1C" },
    due_now: { label: "Due Now",   color: "#B91C1C" },
    unknown: { label: "Unknown",   color: "#94A3B8" },
  };

  // ─── Design tokens ─────────────────────────────────────────────────────────
  const BG = "#F8FAFC"; const SURFACE = "#FFFFFF"; const SURFACE2 = "#F1F5F9";
  const BORDER = "#E2E8F0"; const TEXT1 = "#0F172A"; const TEXT2 = "#475569"; const TEXT3 = "#94A3B8";
  const W = 1140; const SIDEBAR_W = 396; const PX = isMobile ? 20 : 32;

  // ─── Pricing confidence (derived from real signals) ──────────────────────
  // We're honest: if the value is estimated (no real comps), we say so.
  const confidence = (() => {
    // High only when we have real market data — estimated data is never High
    if (!mvIsEst) return {
      level: "Medium" as const, color: "#B45309",
      note: "Based on comparable market data — verify with local listings for your trim.",
    };
    const isLuxury = /bmw|mercedes|benz|audi|porsche|lexus|acura|infiniti|cadillac|volvo|land rover|jaguar/i.test(vehicle.make || "");
    const age = new Date().getFullYear() - (vehicle.year || 2015);
    const isOldOrRare = age > 12 || isLuxury;
    if (isOldOrRare) return {
      level: "Low" as const, color: "#B91C1C",
      note: "Limited comparable data — treat as rough estimate. Verify with local listings.",
    };
    return {
      level: "Medium" as const, color: "#B45309",
      note: "Based on available listings — pricing may vary by trim and condition.",
    };
  })();

  // ─── Sub-components ────────────────────────────────────────────────────────
  function CollapseRow({ label, sublabel, badge, children }: { label: string; sublabel?: string; badge?: string | null; children: React.ReactNode }) {
    const [open, setOpen] = useState(false);
    return (
      <div style={{ borderTop: `1px solid ${BORDER}` }}>
        <button onClick={() => setOpen(o => !o)} style={{ width: "100%", display: "flex", justifyContent: "space-between", alignItems: "center", padding: "18px 0", background: "none", border: "none", cursor: "pointer", textAlign: "left" }}>
          <div>
            <div style={{ fontSize: 12, fontWeight: 700, color: TEXT2, textTransform: "uppercase", letterSpacing: "0.06em" }}>{label}</div>
            {sublabel && <div style={{ fontSize: 12, color: TEXT3, marginTop: 2 }}>{sublabel}</div>}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {badge && <span style={{ fontSize: 11, fontWeight: 700, color: TEXT3, background: SURFACE2, padding: "2px 8px", borderRadius: 8 }}>{badge}</span>}
            {open ? <ChevronUp size={15} color={TEXT3} /> : <ChevronDown size={15} color={TEXT3} />}
          </div>
        </button>
        {open && <div style={{ paddingBottom: 24 }}>{children}</div>}
      </div>
    );
  }

  // ─── "Why this price?" — two-bucket model ───────────────────────────────────
  // Bucket 1: Known maintenance — deterministic, included in price adjustment
  // Bucket 2: Model watchouts — probabilistic, shown for awareness only
  const watchoutItems: any[] = (modelInsights?.watchouts || []).filter((w: any) => w.estimatedCost > 0);

  function WhyThisPrice() {
    const [open, setOpen] = useState(false);
    return (
      <div style={{ borderTop: `1px solid ${BORDER}`, paddingTop: 10, marginTop: 4 }}>
        <button onClick={() => setOpen(o => !o)}
          style={{ background: "none", border: "none", cursor: "pointer", fontSize: 12, fontWeight: 700, color: "#4F46E5", padding: "4px 0", display: "flex", alignItems: "center", gap: 5, fontFamily: "inherit" }}>
          <span style={{ fontSize: 10 }}>{open ? "▾" : "▸"}</span> Why this price?
        </button>
        {open && (
          <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 8, fontSize: 12, color: TEXT2, lineHeight: 1.55 }}>

            {/* Baseline */}
            <div style={{ padding: "10px 12px", background: SURFACE2, borderRadius: 10 }}>
              <div style={{ fontWeight: 700, color: TEXT1, marginBottom: 3 }}>Market baseline</div>
              <div>Similar {vehicleLabel} listings: <strong>${mv.low.toLocaleString()} – ${mv.high.toLocaleString()}</strong></div>
              <div style={{ color: TEXT3, marginTop: 2 }}>{mv.source === "enthusiast_auction" ? "Enthusiast / Auction pricing." : mvIsEst ? "Estimated — no live data. Verify with local listings." : "Based on comparable sales."} Mid-market ~${marketMid.toLocaleString()}.</div>
              {(mv as any)?.marketNote && (
                <div style={{ marginTop: 6, padding: "8px", background: "#EFF6FF", border: "1px solid #BFDBFE", borderRadius: 8, fontSize: 11, color: "#1E3A8A", fontStyle: "italic" }}>
                  {(mv as any).marketNote}
                </div>
              )}
            </div>

            {/* Bucket 1: Known maintenance deductions */}
            {riskAdjustedItems.length > 0 ? (
              <div style={{ padding: "10px 12px", background: SURFACE2, borderRadius: 10 }}>
                <div style={{ fontWeight: 700, color: TEXT1, marginBottom: 2 }}>Deferred maintenance — <em>included in price</em></div>
                <div style={{ color: TEXT3, fontSize: 11, marginBottom: 8 }}>These are confirmed gaps. A {Math.round(riskAdjustedItems[0]?.multiplier * 100) || 80}% weight applied — sellers won’t give you dollar-for-dollar, but it’s a real lever.</div>
                {riskAdjustedItems.map((item, i) => {
                  const rc = item.riskLevel === "High" ? "#B91C1C" : item.riskLevel === "Medium" ? "#B45309" : "#64748B";
                  return (
                    <div key={i} style={{ display: "flex", justifyContent: "space-between", gap: 8, paddingBottom: 5, marginBottom: 5, borderBottom: i < riskAdjustedItems.length - 1 ? `1px solid ${BORDER}` : "none" }}>
                      <div style={{ flex: 1 }}>
                        <span style={{ fontWeight: 600, color: TEXT1 }}>{item.displayName}</span>
                        <span style={{ marginLeft: 6, fontSize: 10, fontWeight: 700, color: rc, background: rc + "15", padding: "1px 6px", borderRadius: 4 }}>{item.riskLevel.toUpperCase()}</span>
                        <div style={{ color: TEXT3, fontSize: 11 }}>~${item.mid.toLocaleString()} to fix · {Math.round(item.multiplier * 100)}% weight</div>
                      </div>
                      <span style={{ fontWeight: 700, color: "#B91C1C", flexShrink: 0 }}>-${item.impact.toLocaleString()}</span>
                    </div>
                  );
                })}
                <div style={{ display: "flex", justifyContent: "space-between", fontWeight: 700, color: TEXT1, paddingTop: 6, borderTop: `1px solid ${BORDER}` }}>
                  <span>Price adjustment</span>
                  <span style={{ color: "#B91C1C" }}>-${pricingImpact.toLocaleString()}</span>
                </div>
              </div>
            ) : (
              <div style={{ padding: "10px 12px", background: "#F0FDF4", border: "1px solid #86EFAC", borderRadius: 10 }}>
                <div style={{ fontWeight: 700, color: "#15803D", marginBottom: 2 }}>No maintenance deductions</div>
                <div style={{ color: "#166534" }}>Service history is current — no price penalty applied.</div>
              </div>
            )}

            {/* Bucket 2: Model watchouts — probabilistic, NOT in price */}
            {watchoutItems.length > 0 && (
              <div style={{ padding: "10px 12px", background: "#FFFBEB", border: "1px solid #FDE68A", borderRadius: 10 }}>
                <div style={{ fontWeight: 700, color: "#92400E", marginBottom: 2 }}>Known model risks — <em>not in price</em></div>
                <div style={{ color: "#92400E", fontSize: 11, marginBottom: 8 }}>These are probabilistic — common on this model, but not guaranteed on this car. Verify at inspection before factoring into your offer.</div>
                {watchoutItems.slice(0, 3).map((w: any, i: number) => (
                  <div key={i} style={{ display: "flex", justifyContent: "space-between", gap: 8, paddingBottom: 5, marginBottom: 5, borderBottom: i < Math.min(watchoutItems.length, 3) - 1 ? `1px solid #FDE68A` : "none" }}>
                    <div style={{ flex: 1, color: "#78350F", fontSize: 12 }}>{w.text.split("–")[0].trim()}</div>
                    <span style={{ fontWeight: 600, color: "#B45309", flexShrink: 0, fontSize: 11 }}>~${(w.estimatedCost || 0).toLocaleString()} if needed</span>
                  </div>
                ))}
                <div style={{ fontSize: 11, color: "#92400E", fontStyle: "italic", marginTop: 4 }}>Ask the seller about service history for these items specifically.</div>
              </div>
            )}

            {/* Adjusted result */}
            <div style={{ padding: "10px 12px", background: "#EEF2FF", border: "1px solid #C7D2FE", borderRadius: 10 }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontWeight: 700, color: "#3730A3", fontSize: 13 }}>
                <span>Adjusted for this car</span>
                <span>${fairTargetMid.toLocaleString()}</span>
              </div>
              <div style={{ fontSize: 11, color: "#4338CA", marginTop: 3 }}>
                {pricingImpact > 0
                  ? `$${marketMid.toLocaleString()} market mid − $${pricingImpact.toLocaleString()} confirmed maintenance = $${fairTargetMid.toLocaleString()}`
                  : "No deduction — maintenance appears current."}
              </div>
            </div>

            {/* Uncertainty note */}
            <div style={{ fontSize: 11, color: TEXT3, fontStyle: "italic" }}>
              Pricing varies by trim, options, and local market. Use as a starting point, not a guarantee.
            </div>

            {/* Negotiation message when overpriced */}
            {askingPrice && deal?.mood === "over" && (
              <div style={{ padding: "10px 12px", background: SURFACE2, borderRadius: 10, borderLeft: "3px solid #4F46E5" }}>
                <div style={{ fontWeight: 700, color: TEXT2, marginBottom: 4, fontSize: 11, letterSpacing: "0.05em" }}>USE THIS TO NEGOTIATE</div>
                <div style={{ fontStyle: "italic", color: TEXT2, lineHeight: 1.6 }}>
                  “{vehicleLabel} comps are ${mv.low.toLocaleString()}–${mv.high.toLocaleString()}. There’s also ~${Math.round(conditionDebt).toLocaleString()} in deferred work. I’d like to be at ${offerLow.toLocaleString()}.”
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  // ─── Sidebar: Pricing card ─────────────────────────────────────────────────
  const PricingCard = () => !askingPrice ? (
    // ── LOCKED STATE: No price entered ──────────────────────────────────────
    <div style={{ background: SURFACE, border: `2px solid ${BORDER}`, borderRadius: 20, padding: "24px", boxShadow: "0 8px 32px rgba(0,0,0,0.06)" }}>
      {/* Market range — visible for context */}
      <div style={{ marginBottom: 20 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: TEXT3, letterSpacing: "0.08em", marginBottom: 6 }}>MARKET RANGE</div>
        <Tooltip tip="Typical private party sale price range for comparable vehicles in good condition.">
          <div style={{ fontSize: 30, fontWeight: 900, color: TEXT1, letterSpacing: "-0.03em", cursor: "default", borderBottom: "1px dashed #CBD5E1", display: "inline-block" }}>
            ${mv.low.toLocaleString()} – ${mv.high.toLocaleString()}
          </div>
        </Tooltip>
        <div style={{ fontSize: 12, color: TEXT3, marginTop: 4 }}>
          {mv?.source === "enthusiast_auction" ? "Live auction data · Bring a Trailer" : mv?.source === "marketcheck" ? "Live market data · MarketCheck" : "AI estimate"} — enter your asking price below for deal analysis
        </div>
      </div>

      {/* Listing URL extractor */}
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: TEXT3, letterSpacing: "0.06em", marginBottom: 6 }}>HAVE A LISTING LINK?</div>
        <div style={{ display: "flex", gap: 6 }}>
          <input
            value={listingUrl}
            onChange={e => { setListingUrl(e.target.value); setUrlStatus(null); }}
            onKeyDown={e => e.key === "Enter" && extractListingPrice(listingUrl)}
            onPaste={e => {
              const pasted = e.clipboardData.getData("text").trim();
              if (pasted.startsWith("http")) {
                e.preventDefault();
                setListingUrl(pasted);
                extractListingPrice(pasted);
              }
            }}
            placeholder="Paste AutoTrader / CarGurus URL"
            style={{ flex: 1, padding: "9px 12px", background: SURFACE2, border: `1px solid ${BORDER}`, borderRadius: 10, fontSize: 12, color: TEXT1 }}
          />
          <button
            onClick={() => extractListingPrice(listingUrl)}
            disabled={urlLoading || !listingUrl.startsWith("http")}
            style={{ padding: "0 12px", background: urlLoading ? SURFACE2 : "#0F172A", border: "none", borderRadius: 10, color: urlLoading ? TEXT3 : "#fff", fontSize: 12, fontWeight: 700, cursor: "pointer", flexShrink: 0, opacity: (!listingUrl.startsWith("http") && !urlLoading) ? 0.4 : 1 }}>
            {urlLoading ? "Reading..." : "Get Price"}
          </button>
        </div>
        {urlStatus && (
          <div style={{ marginTop: 6, fontSize: 12, fontWeight: 600, color: urlStatus.ok ? "#15803D" : "#B45309" }}>
            {urlStatus.msg}
          </div>
        )}
      </div>

      {/* Divider */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
        <div style={{ flex: 1, height: 1, background: BORDER }} />
        <span style={{ fontSize: 11, color: TEXT3, fontWeight: 600 }}>OR ENTER MANUALLY</span>
        <div style={{ flex: 1, height: 1, background: BORDER }} />
      </div>

      {/* Price input — hero CTA */}
      <div style={{ marginTop: 4 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: TEXT2, letterSpacing: "0.06em", marginBottom: 8 }}>WHAT'S THE ASKING PRICE?</div>
        <div style={{ position: "relative", marginBottom: 10 }}>
          <span style={{ position: "absolute", left: 16, top: "50%", transform: "translateY(-50%)", color: TEXT2, fontSize: 22, fontWeight: 800, pointerEvents: "none" }}>$</span>
          <input
            className="price-input"
            value={askingPriceInput}
            inputMode="numeric"
            onChange={e => {
              const digits = e.target.value.replace(/[^0-9]/g, "");
              setAskingPriceInput(digits ? parseInt(digits, 10).toLocaleString("en-US") : "");
            }}
            onBlur={applyPrice}
            onKeyDown={e => e.key === "Enter" && applyPrice()}
            placeholder="e.g. 42,000"
            style={{ width: "100%", padding: "16px 16px 16px 42px", background: SURFACE, border: `2px solid #4F46E5`, borderRadius: 14, fontSize: 22, fontWeight: 800, color: TEXT1, boxSizing: "border-box", transition: "border-color 0.15s, box-shadow 0.15s" }}
          />
        </div>
        <button onClick={applyPrice}
          style={{ width: "100%", padding: "14px", background: "#4F46E5", border: "none", borderRadius: 12, color: "#fff", fontWeight: 700, cursor: "pointer", fontSize: 15, letterSpacing: "0.01em" }}>
          Analyze Deal →
        </button>
        <div style={{ fontSize: 11, color: TEXT3, marginTop: 8, textAlign: "center" }}>The one number only you know</div>
        {priceWarning && (
          <div style={{ marginTop: 10, padding: "10px 12px", background: "#FFFBEB", border: "1px solid #FDE68A", borderRadius: 10, fontSize: 12, fontWeight: 600, color: "#92400E" }}>
            ⚠ {priceWarning}
          </div>
        )}
      </div>
    </div>
  ) : (
    // ── UNLOCKED: Price entered ──────────────────────────────────────────────
    <div style={{ background: SURFACE, border: `2px solid ${conditionCfg.accent}33`, borderRadius: 20, padding: "24px", boxShadow: "0 8px 32px rgba(0,0,0,0.06)" }}>

      {/* Two-tier pricing header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          {/* Tier 1: market mid */}
          <div style={{ marginBottom: 10, paddingBottom: 10, borderBottom: `1px solid ${BORDER}` }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: TEXT3, letterSpacing: "0.08em", marginBottom: 2 }}>ESTIMATED MARKET</div>
            <div style={{ fontSize: 20, fontWeight: 700, color: TEXT3, letterSpacing: "-0.02em" }}>{marketRangeDisplay}</div>
            <div style={{ fontSize: 11, color: TEXT3 }}>mid ~{fmtK(marketMid)} · <em>{mv.source === "enthusiast_auction" ? "Bring a Trailer" : mv.source === "marketcheck" ? "MarketCheck" : "AI estimate"}</em></div>
          </div>
          {/* Tier 2: adjusted for this car */}
          <div style={{ marginBottom: 8 }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: conditionCfg.accent, letterSpacing: "0.08em", marginBottom: 2 }}>ADJUSTED FOR THIS CAR</div>
            <Tooltip tip={pricingImpact > 0
              ? `Market mid $${marketMid.toLocaleString()} minus $${pricingImpact.toLocaleString()} in risk-weighted maintenance = $${fairTargetMid.toLocaleString()}.`
              : `No maintenance adjustment — service history is current.`}>
              <div style={{ fontSize: 34, fontWeight: 900, color: TEXT1, letterSpacing: "-0.04em", cursor: "default" }}>
                ${fairTargetMid.toLocaleString()}
              </div>
            </Tooltip>
            <div style={{ fontSize: 11, marginTop: 2, color: pricingImpact > 0 ? "#B91C1C" : "#15803D" }}>
              {pricingImpact > 0
                ? `↓ $${pricingImpact.toLocaleString()} maintenance impact · your car, not the avg listing`
                : "No adjustment — maintenance is current"}
            </div>
          </div>
          {/* Confidence */}
          <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: "0.06em", color: confidence.color }}>
            CONFIDENCE: {confidence.level.toUpperCase()}
          </div>
          <div style={{ fontSize: 11, color: TEXT3, marginTop: 2, lineHeight: 1.4, marginBottom: 4 }}>{confidence.note}</div>
        </div>
        {deal && (
          <div style={{ background: deal.color + "15", border: `1px solid ${deal.color}40`, borderRadius: 10, padding: "5px 10px", fontSize: 11, fontWeight: 800, color: deal.color, letterSpacing: "0.06em", flexShrink: 0, marginLeft: 10 }}>
            {deal.label.toUpperCase()}
          </div>
        )}
      </div>

      {/* Why this price? */}
      <WhyThisPrice />

      {/* Recommendation block */}
      <div style={{ padding: "14px 16px", background: vCfg.bg, borderRadius: 14, marginBottom: 12, marginTop: 16, border: `1px solid ${vCfg.accent}22` }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: vCfg.accent, marginBottom: 6, letterSpacing: "0.06em" }}>RECOMMENDATION</div>
        <div style={{ fontSize: 15, fontWeight: 700, color: TEXT1, lineHeight: 1.45 }}>
          {deal?.mood === "strong" && `✓ Buy at asking ($${askingPrice?.toLocaleString()}) — below market`}
          {deal?.mood === "low" && (impactTier === "minor"
            ? `✓ Buy at asking — fairly priced and well-maintained`
            : `✓ Buy at asking, but verify the flagged items first`)}
          {deal?.mood === "mid" && (impactTier === "major"
            ? `Negotiate down — maintenance gaps reduce value meaningfully`
            : impactTier === "moderate"
            ? `Fair price — ask for a modest reduction`
            : `Fair price — no strong negotiation edge`)}
          {deal?.mood === "over" && `Negotiate to $${offerLow.toLocaleString()} – $${offerHigh.toLocaleString()} or walk`}
          {!deal && `Enter asking price to unlock recommendation`}
        </div>
      </div>

      {/* Position explanation */}
      {deal && (
        <div style={{ background: deal.mood === "over" ? "#FEF2F2" : deal.mood === "mid" ? "#EFF6FF" : "#F0FDF4", border: `1px solid ${deal.mood === "over" ? "#FECACA" : deal.mood === "mid" ? "#BFDBFE" : "#86EFAC"}`, borderRadius: 10, padding: "10px 14px", marginBottom: 14 }}>
          <span style={{ fontSize: 13, color: deal.color, fontWeight: 600 }}>{(deal as any).explain}</span>
        </div>
      )}

      {/* Asking price — editable */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", paddingTop: 14, borderTop: `1px solid ${BORDER}` }}>
        <span style={{ fontSize: 12, color: TEXT3, fontWeight: 600 }}>Asking Price</span>
        <div style={{ position: "relative" }}>
          <span style={{ position: "absolute", left: 8, top: "50%", transform: "translateY(-50%)", color: TEXT3, fontSize: 13, fontWeight: 700 }}>$</span>
          <input
            className="price-input-sm"
            value={askingPriceInput}
            inputMode="numeric"
            onChange={e => {
              const digits = e.target.value.replace(/[^0-9]/g, "");
              setAskingPriceInput(digits ? parseInt(digits, 10).toLocaleString("en-US") : "");
            }}
            onBlur={applyPrice}
            onKeyDown={e => e.key === "Enter" && applyPrice()}
            placeholder="enter price"
            style={{ width: 120, padding: "7px 8px 7px 20px", background: SURFACE2, border: `1px solid ${BORDER}`, borderRadius: 8, fontSize: 13, fontWeight: 700 }}
          />
        </div>
      </div>
    </div>
  );

  // ─── Render ────────────────────────────────────────────────────────────────
  return (
    <div style={{ minHeight: "100vh", background: BG, fontFamily: "'Inter', -apple-system, sans-serif", color: TEXT1, paddingBottom: chatBarH + 32 }}>
      <style>{`
        * { box-sizing: border-box; }
        input:focus { outline: none; }
        @keyframes wrenchDot { 0%,100%{opacity:.3;transform:translateY(0)} 50%{opacity:1;transform:translateY(-4px)} }
        @keyframes slideUp { from { opacity:0; transform:translateY(8px); } to { opacity:1; transform:translateY(0); } }
        .slide-up { animation: slideUp 0.18s ease forwards; }
        button { font-family: inherit; }
        .ask-btn { opacity: 0; transition: opacity 0.15s; }
        .ask-row:hover .ask-btn { opacity: 1; }
        .price-input:focus { outline: none; border-color: #4F46E5 !important; box-shadow: 0 0 0 3px rgba(79,70,229,0.12); }
        .price-input-sm:focus { outline: none; border-color: #4F46E5 !important; }
      `}</style>

      <div style={{ maxWidth: W, margin: "0 auto", padding: `40px ${PX}px 0` }}>

        {/* Page header */}
        <div style={{ marginBottom: 40, paddingBottom: 32, borderBottom: `1px solid ${BORDER}` }}>
          <div style={{ fontSize: 11, color: TEXT3, fontWeight: 800, letterSpacing: "0.2em", marginBottom: 10 }}>WRENCHCHECK AUDIT</div>
          <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap", marginBottom: 8 }}>
            <h1 style={{ fontSize: isMobile ? 30 : 46, fontWeight: 900, color: TEXT1, margin: 0, letterSpacing: "-0.04em" }}>{vehicleLabel}</h1>
            {vehicle.currentMileage && <span style={{ fontSize: 18, color: TEXT2, fontWeight: 500 }}>{vehicle.currentMileage.toLocaleString()} mi</span>}
          </div>
          {vehicle.vin && (
            <div style={{ display: "inline-flex", alignItems: "center", gap: 10, background: SURFACE2, border: `1px solid ${BORDER}`, borderRadius: 8, padding: "5px 12px" }}>
              <span style={{ fontSize: 12, color: TEXT3, fontFamily: "monospace" }}>VIN: {vehicle.vin}</span>
              <button onClick={() => copyText(vehicle.vin, "vin")} style={{ background: "none", border: "none", color: "#4F46E5", fontSize: 11, fontWeight: 700, cursor: "pointer", padding: 0 }}>
                {copied === "vin" ? "✓ Copied" : "Copy"}
              </button>
            </div>
          )}
        </div>

        {/* Two-column layout */}
        <div style={{ display: "flex", flexDirection: isMobile ? "column" : "row", gap: 48, alignItems: "flex-start" }}>

          {/* ── LEFT: Analysis ─────────────────────────────────────────────── */}
          <div style={{ flex: 1, minWidth: 0 }}>

            {/* 1. Verdict + Primary Action */}
            <div style={{ marginBottom: 52 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: vCfg.accent, letterSpacing: "0.1em", marginBottom: 10 }}>THE VERDICT</div>
              <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, marginBottom: 14 }}>
                <Tooltip tip="Based on maintenance records, service history completeness, and model-specific risk data.">
                  <h2 style={{ fontSize: 36, fontWeight: 800, color: vCfg.accent, margin: 0, cursor: "default", borderBottom: "2px dashed " + vCfg.accent + "44", paddingBottom: 2 }}>{vCfg.label}</h2>
                </Tooltip>
                <button
                  onClick={() => sendMessage(`Is this a good deal overall? What's the most important thing I should know?`)}
                  style={{ flexShrink: 0, marginTop: 6, padding: "5px 12px", background: SURFACE, border: `1px solid ${BORDER}`, borderRadius: 8, fontSize: 12, fontWeight: 600, color: TEXT2, cursor: "pointer" }}>
                  Ask advisor →
                </button>
              </div>

              {/* Price gap banner — most important output per spec */}
              {priceGap && (
                <div style={{
                  display: "flex", alignItems: "center", gap: 12, padding: "14px 18px", marginBottom: 16,
                  background: priceGap.mood === "over" ? "#FEF2F2" : priceGap.mood === "under" ? "#F0FDF4" : "#EFF6FF",
                  border: `1.5px solid ${priceGap.mood === "over" ? "#FECACA" : priceGap.mood === "under" ? "#86EFAC" : "#BFDBFE"}`,
                  borderRadius: 14,
                }}>
                  <span style={{ fontSize: 22 }}>{priceGap.mood === "over" ? "⚠️" : priceGap.mood === "under" ? "✅" : "✓"}</span>
                  <div>
                    <div style={{ fontWeight: 800, fontSize: 16, color: priceGap.color }}>{priceGap.text}</div>
                    <div style={{ fontSize: 12, color: TEXT3, marginTop: 2 }}>{priceGap.detail}</div>
                  </div>
                </div>
              )}

              {/* What I'd Do — PRIMARY ACTION, always shown */}
              <div style={{
                padding: "18px 20px", marginBottom: 18,
                background: vCfg.bg, border: `1.5px solid ${vCfg.accent}33`,
                borderLeft: `4px solid ${vCfg.accent}`, borderRadius: "0 14px 14px 0",
              }}>
                <div style={{ fontSize: 10, fontWeight: 800, color: vCfg.accent, letterSpacing: "0.1em", marginBottom: 8 }}>WHAT I'D DO</div>
                <p style={{ fontSize: 15, fontWeight: 700, color: TEXT1, lineHeight: 1.55, margin: 0 }}>{whatIdDo}</p>
              </div>

              <p style={{ fontSize: 16, color: TEXT2, fontWeight: 500, margin: "0 0 14px", lineHeight: 1.5 }}>{reinforcingSentence}</p>
              <div style={{ padding: "14px 16px", background: SURFACE, border: `1px solid ${BORDER}`, borderRadius: 14, fontSize: 14, color: TEXT2, lineHeight: 1.7 }}>
                {whyBullets.map((b, i) => <div key={i} style={{ display: "flex", gap: 8 }}><span style={{ color: TEXT3 }}>·</span>{b}</div>)}
              </div>
            </div>

            {/* 2. Action needed */}
            {matters.length > 0 && (
              <div style={{ marginBottom: 52 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: TEXT3, letterSpacing: "0.1em", marginBottom: 16 }}>ACTION NEEDED</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                  {matters.map((m, i) => (
                    <div key={i} className="ask-row" style={{ padding: "16px 18px", background: SURFACE, border: `1px solid ${BORDER}`, borderRadius: 16 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
                        <div style={{ flex: 1 }}>
                          <div style={{ fontSize: 11, fontWeight: 700, color: TEXT3, marginBottom: 4 }}>{m.prefix.toUpperCase()}</div>
                          <div style={{ fontSize: 15, color: TEXT1, fontWeight: 700 }}>{m.headline}</div>
                          <div style={{ fontSize: 13, color: TEXT2, marginTop: 2 }}>{m.subline}</div>
                        </div>
                        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6, flexShrink: 0 }}>
                          {m.cost && <span style={{ fontSize: 13, fontWeight: 700, color: "#B91C1C" }}>{m.cost}</span>}
                          <button className="ask-btn" onClick={() => sendMessage(m.askQ)}
                            style={{ padding: "4px 10px", background: SURFACE2, border: "none", borderRadius: 7, fontSize: 11, fontWeight: 700, color: TEXT2, cursor: "pointer" }}>
                            Ask →
                          </button>
                        </div>
                      </div>
                      {m.details && <div style={{ marginTop: 10 }}><InlineDetail {...m.details} /></div>}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* 3. Vehicle Profile — Carfax signal extraction */}
            {carfaxSignals && (carfaxSignals.ownerCount != null || carfaxSignals.hasAccident != null || carfaxSignals.ownerTypes?.length > 0) && (
              <div style={{ marginBottom: 52 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: TEXT3, letterSpacing: "0.1em", marginBottom: 16 }}>VEHICLE PROFILE</div>
                {/* Narrative */}
                {modelInsights?.vehicleNarrative && (
                  <div style={{ padding: "14px 18px", background: "#EFF6FF", border: "1px solid #BFDBFE", borderRadius: 14, fontSize: 14, color: "#1D4ED8", fontWeight: 600, lineHeight: 1.55, marginBottom: 14 }}>
                    {modelInsights.vehicleNarrative}
                  </div>
                )}
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: 10 }}>
                  {carfaxSignals.ownerCount != null && (
                    <div style={{ padding: "12px 14px", background: SURFACE, border: `1px solid ${BORDER}`, borderRadius: 12 }}>
                      <div style={{ fontSize: 10, fontWeight: 700, color: TEXT3, letterSpacing: "0.08em", marginBottom: 4 }}>OWNERS</div>
                      <div style={{ fontSize: 16, fontWeight: 800, color: TEXT1 }}>{carfaxSignals.ownerCount}</div>
                      {carfaxSignals.ownerTypes?.length > 0 && <div style={{ fontSize: 11, color: TEXT3, marginTop: 2 }}>{carfaxSignals.ownerTypes.join(", ")}</div>}
                    </div>
                  )}
                  {carfaxSignals.hasAccident != null && (
                    <div style={{ padding: "12px 14px", background: carfaxSignals.hasAccident ? "#FEF2F2" : "#F0FDF4", border: `1px solid ${carfaxSignals.hasAccident ? "#FECACA" : "#86EFAC"}`, borderRadius: 12 }}>
                      <div style={{ fontSize: 10, fontWeight: 700, color: TEXT3, letterSpacing: "0.08em", marginBottom: 4 }}>ACCIDENTS</div>
                      <div style={{ fontSize: 15, fontWeight: 800, color: carfaxSignals.hasAccident ? "#B91C1C" : "#15803D" }}>
                        {carfaxSignals.hasAccident ? `${carfaxSignals.accidentCount ?? "Yes"} reported` : "None reported"}
                      </div>
                    </div>
                  )}
                  {carfaxSignals.serviceQuality && carfaxSignals.serviceQuality !== "unknown" && (
                    <div style={{ padding: "12px 14px", background: SURFACE, border: `1px solid ${BORDER}`, borderRadius: 12 }}>
                      <div style={{ fontSize: 10, fontWeight: 700, color: TEXT3, letterSpacing: "0.08em", marginBottom: 4 }}>SERVICE HISTORY</div>
                      <div style={{ fontSize: 13, fontWeight: 700, color: carfaxSignals.serviceQuality === "dealer_consistent" ? "#15803D" : TEXT2 }}>
                        {carfaxSignals.serviceQuality === "dealer_consistent" ? "✓ Dealer consistent" : carfaxSignals.serviceQuality === "mixed" ? "Mixed" : "Independent"}
                      </div>
                    </div>
                  )}
                  {(carfaxSignals.isColoradoCar || carfaxSignals.lastState) && (
                    <div style={{ padding: "12px 14px", background: SURFACE, border: `1px solid ${BORDER}`, borderRadius: 12 }}>
                      <div style={{ fontSize: 10, fontWeight: 700, color: TEXT3, letterSpacing: "0.08em", marginBottom: 4 }}>GEOGRAPHY</div>
                      <div style={{ fontSize: 13, fontWeight: 700, color: carfaxSignals.isColoradoCar ? "#15803D" : TEXT2 }}>
                        {carfaxSignals.isColoradoCar ? "✓ Colorado (low rust)" : carfaxSignals.lastState}
                      </div>
                    </div>
                  )}
                  {carfaxSignals.serviceRecordCount != null && (
                    <div style={{ padding: "12px 14px", background: SURFACE, border: `1px solid ${BORDER}`, borderRadius: 12 }}>
                      <div style={{ fontSize: 10, fontWeight: 700, color: TEXT3, letterSpacing: "0.08em", marginBottom: 4 }}>RECORDS</div>
                      <div style={{ fontSize: 16, fontWeight: 800, color: TEXT1 }}>{carfaxSignals.serviceRecordCount}</div>
                      <div style={{ fontSize: 11, color: TEXT3, marginTop: 2 }}>on file</div>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* 4. Major Exposures — $2k+ model-specific risks, own visual tier */}
            {modelInsights?.majorExposures?.length > 0 && (
              <div style={{ marginBottom: 52 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: TEXT3, letterSpacing: "0.1em", marginBottom: 16 }}>MAJOR EXPOSURE</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                  {(modelInsights.majorExposures as any[]).map((exp: any, i: number) => {
                    const urgencyColor = exp.urgency === "near_term" ? "#B91C1C" : exp.urgency === "watch" ? "#B45309" : "#64748B";
                    const urgencyLabel = exp.urgency === "near_term" ? "NEAR-TERM RISK" : exp.urgency === "watch" ? "WATCH CLOSELY" : "LONG-TERM";
                    const urgencyBg    = exp.urgency === "near_term" ? "#FEF2F2" : exp.urgency === "watch" ? "#FFFBEB" : "#F8FAFC";
                    const urgencyBdr   = exp.urgency === "near_term" ? "#FECACA" : exp.urgency === "watch" ? "#FDE68A" : BORDER;
                    return (
                      <div key={i} style={{ padding: "16px 18px", background: urgencyBg, border: `1.5px solid ${urgencyBdr}`, borderRadius: 14 }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
                          <div style={{ flex: 1 }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                              <span style={{ fontSize: 10, fontWeight: 800, color: urgencyColor, letterSpacing: "0.08em" }}>{urgencyLabel}</span>
                            </div>
                            <div style={{ fontSize: 15, fontWeight: 800, color: TEXT1, marginBottom: 4 }}>{exp.name}</div>
                            <div style={{ fontSize: 13, color: TEXT2, lineHeight: 1.5 }}>{exp.note}</div>
                          </div>
                          <div style={{ flexShrink: 0, textAlign: "right" }}>
                            <div style={{ fontSize: 11, color: TEXT3, marginBottom: 2 }}>If it fails</div>
                            <div style={{ fontSize: 18, fontWeight: 800, color: urgencyColor }}>
                              ${(exp.costLow||0).toLocaleString()}–${(exp.costHigh||0).toLocaleString()}
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* 5. Good Buy If / Bad Buy If */}
            {(modelInsights?.goodBuyIf?.length > 0 || modelInsights?.badBuyIf?.length > 0) && (
              <div style={{ marginBottom: 52 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: TEXT3, letterSpacing: "0.1em", marginBottom: 16 }}>IS THIS THE RIGHT CAR FOR YOU?</div>
                <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr", gap: 12 }}>
                  {modelInsights?.goodBuyIf?.length > 0 && (
                    <div style={{ padding: "16px 18px", background: "#F0FDF4", border: "1.5px solid #86EFAC", borderRadius: 14 }}>
                      <div style={{ fontSize: 11, fontWeight: 800, color: "#15803D", letterSpacing: "0.08em", marginBottom: 10 }}>✓ GOOD BUY IF</div>
                      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                        {(modelInsights.goodBuyIf as string[]).map((item: string, i: number) => (
                          <div key={i} style={{ display: "flex", gap: 8 }}>
                            <span style={{ color: "#15803D", flexShrink: 0, fontSize: 14 }}>·</span>
                            <span style={{ fontSize: 13, color: "#166534", lineHeight: 1.5 }}>{item}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  {modelInsights?.badBuyIf?.length > 0 && (
                    <div style={{ padding: "16px 18px", background: "#FEF2F2", border: "1.5px solid #FECACA", borderRadius: 14 }}>
                      <div style={{ fontSize: 11, fontWeight: 800, color: "#B91C1C", letterSpacing: "0.08em", marginBottom: 10 }}>✗ PASS IF</div>
                      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                        {(modelInsights.badBuyIf as string[]).map((item: string, i: number) => (
                          <div key={i} style={{ display: "flex", gap: 8 }}>
                            <span style={{ color: "#B91C1C", flexShrink: 0, fontSize: 14 }}>·</span>
                            <span style={{ fontSize: 13, color: "#991B1B", lineHeight: 1.5 }}>{item}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* 6. Depreciated Luxury / Total Cost of Ownership */}
            {(() => {
              const originalMsrp = modelInsights?.originalMsrp;
              const hasMsrp = originalMsrp && originalMsrp > 0;
              const depreciationPct = hasMsrp && askingPrice ? (originalMsrp - askingPrice) / originalMsrp : null;
              const isDepreciatedLuxury = depreciationPct != null && depreciationPct > 0.45;
              const msrpFmt = hasMsrp ? (originalMsrp >= 10000 ? `$${Math.round(originalMsrp / 1000)}k` : `$${originalMsrp.toLocaleString()}`) : null;
              const askFmt = askingPrice ? (askingPrice >= 10000 ? `$${Math.round(askingPrice / 1000)}k` : `$${askingPrice.toLocaleString()}`) : null;
              const savingsPct = depreciationPct != null ? Math.round(depreciationPct * 100) : null;

              return (
                <div style={{ marginBottom: 52 }}>

                  {/* ── Depreciated Luxury callout — only when applicable ── */}
                  {isDepreciatedLuxury && askFmt && msrpFmt && (
                    <div style={{ marginBottom: 20 }}>
                      <div style={{ fontSize: 11, fontWeight: 700, color: TEXT3, letterSpacing: "0.1em", marginBottom: 16 }}>DEPRECIATED LUXURY</div>
                      <div style={{
                        padding: "22px 24px",
                        background: "linear-gradient(135deg, #0F172A 0%, #1E293B 100%)",
                        borderRadius: 18,
                        position: "relative",
                        overflow: "hidden",
                      }}>
                        {/* Decorative accent */}
                        <div style={{ position: "absolute", top: -20, right: -20, width: 120, height: 120, background: "#4F46E5", borderRadius: "50%", opacity: 0.08 }} />
                        <div style={{ position: "absolute", bottom: -30, left: -10, width: 80, height: 80, background: "#7C3AED", borderRadius: "50%", opacity: 0.06 }} />

                        <div style={{ position: "relative" }}>
                          {/* Savings badge */}
                          <div style={{ display: "inline-flex", alignItems: "center", gap: 6, background: "rgba(79,70,229,0.25)", border: "1px solid rgba(129,140,248,0.4)", borderRadius: 99, padding: "4px 12px", marginBottom: 14 }}>
                            <span style={{ fontSize: 11, fontWeight: 800, color: "#A5B4FC", letterSpacing: "0.08em" }}>⚡ {savingsPct}% OFF MSRP</span>
                          </div>

                          {/* Headline */}
                          <div style={{ fontSize: isMobile ? 18 : 22, fontWeight: 900, color: "#F8FAFC", lineHeight: 1.3, marginBottom: 12, letterSpacing: "-0.02em" }}>
                            You&apos;re getting a {msrpFmt} car at {askFmt}.
                          </div>

                          {/* The core insight */}
                          <div style={{ fontSize: 14, color: "#CBD5E1", lineHeight: 1.7, marginBottom: 16 }}>
                            The experience depreciates with the price.{" "}
                            <span style={{ color: "#F8FAFC", fontWeight: 700 }}>The maintenance costs don&apos;t.</span>
                          </div>

                          {/* Breakdown */}
                          <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr", gap: 10 }}>
                            <div style={{ padding: "12px 14px", background: "rgba(255,255,255,0.06)", borderRadius: 12, border: "1px solid rgba(255,255,255,0.08)" }}>
                              <div style={{ fontSize: 10, fontWeight: 700, color: "#64748B", letterSpacing: "0.08em", marginBottom: 4 }}>WHAT YOU PAID</div>
                              <div style={{ fontSize: 20, fontWeight: 900, color: "#F0FDF4" }}>{askFmt}</div>
                              <div style={{ fontSize: 11, color: "#4ADE80", marginTop: 2, fontWeight: 600 }}>vs. {msrpFmt} new</div>
                            </div>
                            <div style={{ padding: "12px 14px", background: "rgba(255,255,255,0.06)", borderRadius: 12, border: "1px solid rgba(255,255,255,0.08)" }}>
                              <div style={{ fontSize: 10, fontWeight: 700, color: "#64748B", letterSpacing: "0.08em", marginBottom: 4 }}>MAINTENANCE REFLECTS</div>
                              <div style={{ fontSize: 20, fontWeight: 900, color: "#FCA5A5" }}>{msrpFmt} car</div>
                              <div style={{ fontSize: 11, color: "#94A3B8", marginTop: 2 }}>parts + labor don&apos;t depreciate</div>
                            </div>
                          </div>

                          <div style={{ marginTop: 14, padding: "10px 14px", background: "rgba(255,255,255,0.04)", borderRadius: 10, borderLeft: "3px solid rgba(129,140,248,0.5)" }}>
                            <div style={{ fontSize: 12, color: "#94A3B8", lineHeight: 1.6 }}>
                              If you understand this trade-off going in, this is one of the best value plays in the used car market.
                              {modelInsights?.avgAnnualCost ? ` Budget ~$${modelInsights.avgAnnualCost.toLocaleString()}/yr for maintenance and you won't be surprised.` : ""}
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* ── TCO section ── */}
                  {modelInsights?.tco && (
                    <div>
                      <div style={{ fontSize: 11, fontWeight: 700, color: TEXT3, letterSpacing: "0.1em", marginBottom: 16 }}>
                        {isDepreciatedLuxury ? `WHAT ${msrpFmt?.toUpperCase()} CAR OWNERSHIP COSTS` : "TOTAL COST OF OWNERSHIP"}
                      </div>
                      <div style={{ padding: "18px 20px", background: SURFACE, border: `1px solid ${BORDER}`, borderRadius: 16 }}>
                        {modelInsights.reliabilityTier && (
                          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16, paddingBottom: 16, borderBottom: `1px solid ${BORDER}` }}>
                            <div style={{
                              padding: "3px 10px", borderRadius: 99, fontSize: 11, fontWeight: 800,
                              background: modelInsights.reliabilityTier === "excellent" ? "#F0FDF4" : modelInsights.reliabilityTier === "good" ? "#EFF6FF" : modelInsights.reliabilityTier === "below_average" ? "#FFFBEB" : "#FEF2F2",
                              color: modelInsights.reliabilityTier === "excellent" ? "#15803D" : modelInsights.reliabilityTier === "good" ? "#1D4ED8" : modelInsights.reliabilityTier === "below_average" ? "#B45309" : "#B91C1C",
                              border: `1px solid ${modelInsights.reliabilityTier === "excellent" ? "#86EFAC" : modelInsights.reliabilityTier === "good" ? "#BFDBFE" : modelInsights.reliabilityTier === "below_average" ? "#FDE68A" : "#FECACA"}`,
                            }}>
                              {modelInsights.reliabilityTier === "excellent" ? "Excellent Reliability" : modelInsights.reliabilityTier === "good" ? "Good Reliability" : modelInsights.reliabilityTier === "below_average" ? "Below Average Reliability" : "Poor Reliability"}
                            </div>
                            {modelInsights.avgAnnualCost && (
                              <span style={{ fontSize: 13, color: TEXT3 }}>· ~${modelInsights.avgAnnualCost.toLocaleString()}/yr avg all-in</span>
                            )}
                          </div>
                        )}
                        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                          <div>
                            <div style={{ fontSize: 10, fontWeight: 700, color: TEXT3, letterSpacing: "0.08em", marginBottom: 4 }}>YEAR 1</div>
                            <div style={{ fontSize: 22, fontWeight: 900, color: TEXT1 }}>
                              ${(modelInsights.tco.year1Low||0).toLocaleString()}–${(modelInsights.tco.year1High||0).toLocaleString()}
                            </div>
                            <div style={{ fontSize: 11, color: TEXT3, marginTop: 2 }}>
                              {isDepreciatedLuxury ? `${msrpFmt} car, first year` : "expected first-year costs"}
                            </div>
                          </div>
                          <div>
                            <div style={{ fontSize: 10, fontWeight: 700, color: TEXT3, letterSpacing: "0.08em", marginBottom: 4 }}>3-YEAR TOTAL</div>
                            <div style={{ fontSize: 22, fontWeight: 900, color: TEXT1 }}>
                              ${(modelInsights.tco.year3Low||0).toLocaleString()}–${(modelInsights.tco.year3High||0).toLocaleString()}
                            </div>
                            <div style={{ fontSize: 11, color: TEXT3, marginTop: 2 }}>cumulative maintenance + repairs</div>
                          </div>
                        </div>
                        {modelInsights.ownershipOutlook && (
                          <div style={{ marginTop: 12, padding: "10px 12px", background: "#F8FAFC", borderRadius: 8, fontSize: 12, color: TEXT2, lineHeight: 1.5, borderLeft: `3px solid ${BORDER}` }}>
                            {modelInsights.ownershipOutlook}
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                </div>
              );
            })()}



            {/* 7. Vehicle intelligence — hide low-signal items for price-driven cars */}

            {(modelInsights?.watchouts?.length > 0 || modelInsights?.expertTake) && (
              <div style={{ marginBottom: 52 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: TEXT3, letterSpacing: "0.1em", marginBottom: 16 }}>VEHICLE INTELLIGENCE</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                  {/* Price-driven: only show HIGH cost watchouts (>$1500). Maintenance-driven: show all. */}
                  {(modelInsights?.watchouts || [])
                    .filter((wo: any) => mode !== "price_driven" || wo.estimatedCost > 1500)
                    .slice(0, 3)
                    .map((wo: any, i: number) => {
                      const isHigh = wo.estimatedCost > 1500;
                      const title = wo.text.split("–")[0].trim();
                      const context = wo.text.includes("–") ? wo.text.split("–").slice(1).join("–").trim() : null;
                      return (
                        <div key={i} className="ask-row" style={{ display: "flex", gap: 14, padding: "14px 16px", background: SURFACE, border: `1px solid ${BORDER}`, borderRadius: 14 }}>
                          <Tooltip tip={isHigh ? "Repair cost above $1,500. Prioritize verifying this during inspection." : "Known pattern on this model. Worth asking about service history for this item."}>
                            <div style={{ padding: "3px 9px", background: isHigh ? "#FEF2F2" : SURFACE2, border: `1px solid ${isHigh ? "#FECACA" : BORDER}`, borderRadius: 6, fontSize: 10, fontWeight: 800, color: isHigh ? "#B91C1C" : TEXT3, height: "fit-content", flexShrink: 0, cursor: "default" }}>
                              {isHigh ? "WATCH CLOSELY" : "KNOWN PATTERN"}
                            </div>
                          </Tooltip>
                          <div style={{ flex: 1 }}>
                            <div style={{ fontSize: 14, fontWeight: 700, color: TEXT1, marginBottom: 2 }}>{title}</div>
                            {context && <div style={{ fontSize: 13, color: TEXT2, lineHeight: 1.5 }}>{context}</div>}
                          </div>
                          <button className="ask-btn" onClick={() => sendMessage(`How serious is ${title} on this ${vehicleLabel}?`)}
                            style={{ padding: "4px 10px", background: SURFACE2, border: "none", borderRadius: 7, fontSize: 11, fontWeight: 700, color: TEXT2, cursor: "pointer", alignSelf: "flex-start", flexShrink: 0 }}>
                            Ask →
                          </button>
                        </div>
                      );
                    })}
                  {/* Expert take */}
                  {modelInsights?.expertTake && (
                    <div style={{ padding: "14px 16px", background: "#FEFCE8", border: "1px solid #FEF08A", borderRadius: 14, display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
                      <div>
                        <span style={{ fontSize: 11, fontWeight: 800, color: "#A16207", display: "block", marginBottom: 4 }}>EXPERT TAKE</span>
                        <span style={{ fontSize: 13, color: "#854D0E", lineHeight: 1.55 }}>{modelInsights.expertTake}</span>
                      </div>
                      <button onClick={() => sendMessage("What are the most important things to verify before buying this car?")}
                        style={{ flexShrink: 0, padding: "4px 10px", background: "#FEF9C3", border: "1px solid #FEF08A", borderRadius: 7, fontSize: 11, fontWeight: 700, color: "#A16207", cursor: "pointer" }}>
                        Ask →
                      </button>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* 4. Ownership profile */}
            <div style={{ marginBottom: 52 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: TEXT3, letterSpacing: "0.1em", marginBottom: 16 }}>OWNERSHIP OUTLOOK</div>
              <div style={{ padding: "20px", background: SURFACE, border: `1px solid ${BORDER}`, borderRadius: 16 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: profile.color, marginBottom: 4 }}>{profile.label}</div>
                <div style={{ fontSize: 22, fontWeight: 800, color: TEXT1, marginBottom: 6 }}>{outlookLine}</div>
                <div style={{ fontSize: 13, color: TEXT3 }}>{conditionDebt > 200 ? "Slightly higher than typical due to deferred maintenance." : "Typical for this vehicle and mileage range."}</div>
              </div>
            </div>

            {/* 5. Full analysis (collapsed) */}
            <CollapseRow label="Full maintenance analysis" sublabel={`${allItems.length} scheduled items checked`} badge={overdue.length > 0 ? `${overdue.length} overdue` : null}>
              <div style={{ display: "flex", flexDirection: "column" }}>
                {sortedItems.map((item: any) => {
                  const cfg = statusCfg[item.status] || statusCfg.unknown;
                  const isOd = item.status === "overdue" || item.status === "due_now";
                  const inOffer = ledger[item.canonicalService] ?? false;
                  const cost = Math.round(((item.estimatedCostLow || 0) + (item.estimatedCostHigh || 0)) / 2);
                  return (
                    <div key={item.canonicalService} style={{ display: "flex", alignItems: "flex-start", gap: 12, padding: "12px 0", borderBottom: `1px solid ${BORDER}` }}>
                      <SDot status={item.status} />
                      <div style={{ flex: 1 }}>
                        <div style={{ display: "flex", justifyContent: "space-between" }}>
                          <span style={{ fontSize: 13, color: TEXT1, fontWeight: 600 }}>{item.displayName}</span>
                          <span style={{ fontSize: 11, fontWeight: 700, color: cfg.color }}>{cfg.label.toUpperCase()}</span>
                        </div>
                        {isOd && (
                          <div style={{ marginTop: 6, display: "flex", alignItems: "center", gap: 10 }}>
                            {cost > 0 && <span style={{ fontSize: 12, color: "#B91C1C", fontWeight: 700 }}>~${cost.toLocaleString()}</span>}
                            {askingPrice && (
                              <button onClick={() => setLedger(p => ({ ...p, [item.canonicalService]: !p[item.canonicalService] }))}
                                style={{ fontSize: 11, fontWeight: 700, padding: "3px 9px", borderRadius: 6, border: "none", background: inOffer ? "#EEF2FF" : SURFACE2, color: inOffer ? "#4F46E5" : TEXT3, cursor: "pointer" }}>
                                {inOffer ? "✓ In offer" : "+ Add to offer"}
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </CollapseRow>

            <CollapseRow label="Service history" sublabel={`${rawHistory.length} event${rawHistory.length !== 1 ? "s" : ""} extracted`} badge={rawHistory.length > 0 ? String(rawHistory.length) : null}>
              {rawHistory.length > 0 ? rawHistory.map((h: any, i: number) => (
                <div key={i} style={{ padding: "10px 0", borderBottom: `1px solid ${BORDER}`, display: "flex", justifyContent: "space-between", gap: 12 }}>
                  <div>
                    <div style={{ fontSize: 13, color: TEXT1, fontWeight: 500 }}>{h.rawDescription}</div>
                    <div style={{ fontSize: 11, color: TEXT3, marginTop: 2 }}>{h.date}{h.mileage ? ` · ${h.mileage.toLocaleString()} mi` : ""}</div>
                  </div>
                  {matchedIds.has(h.id) && <span style={{ fontSize: 10, fontWeight: 700, color: "#15803D", background: "#F0FDF4", border: "1px solid #86EFAC", borderRadius: 6, padding: "2px 7px", flexShrink: 0 }}>MATCHED</span>}
                </div>
              )) : <div style={{ fontSize: 13, color: TEXT3, fontStyle: "italic" }}>No service events extracted.</div>}
            </CollapseRow>

          </div>

          {/* ── RIGHT: Sticky sidebar ──────────────────────────────────────── */}
          <div style={{ width: isMobile ? "100%" : SIDEBAR_W, flexShrink: 0, position: isMobile ? "static" : "sticky", top: 40, alignSelf: "flex-start" }}>

            <PricingCard />

            {/* Confidence note — always shown */}
            <div style={{ marginTop: 16, padding: "10px 14px", background: SURFACE2, borderRadius: 10, fontSize: 11, color: TEXT3 }}>
              {confidence.note} Pricing may vary based on trim, options, and condition.
            </div>

            {/* Negotiation playbook — ONLY when there's real leverage. Rule: if it doesn't change the decision, don't show it. */}
            {askingPrice && (impactTier === "moderate" || impactTier === "major" || deal?.mood === "over") && conditionDebt > 200 && (
              <div style={{ marginTop: 20 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: TEXT3, letterSpacing: "0.08em", marginBottom: 12 }}>NEGOTIATION PLAYBOOK</div>
                {[
                  { label: "QUICK TEXT", text: generatePitch(false), key: "q" },
                  { label: "FORMAL OFFER", text: generatePitch(true), key: "f" },
                ].map(({ label, text, key }) => (
                  <div key={key} style={{ marginBottom: 10, padding: "14px 16px", background: SURFACE, border: `1px solid ${BORDER}`, borderRadius: 14 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                      <span style={{ fontSize: 11, fontWeight: 700, color: TEXT2 }}>{label}</span>
                      <button onClick={() => copyText(text, key)} style={{ padding: "3px 10px", background: copied === key ? "#F0FDF4" : SURFACE2, border: "none", borderRadius: 6, fontSize: 11, fontWeight: 700, color: copied === key ? "#15803D" : TEXT2, cursor: "pointer" }}>
                        {copied === key ? "✓ Copied" : "Copy"}
                      </button>
                    </div>
                    <p style={{ fontSize: 13, fontStyle: "italic", color: TEXT2, margin: 0, lineHeight: 1.6 }}>"{text}"</p>
                  </div>
                ))}
              </div>
            )}

            {/* You're Done When — situation-specific inspection steps */}
            {askingPrice && (() => {
              // Build inspection checklist based on this car's actual situation
              const steps: string[] = [];
              if (deal?.mood === "over") {
                steps.push(`Price is at or under $${offerHigh.toLocaleString()}`);
              } else {
                steps.push("Seller accepts asking price (or close to it)");
              }
              if (highItems.length > 0) {
                steps.push(`${highItems[0].displayName} is confirmed addressed or explicitly priced into the deal`);
              } else if (matters[0]) {
                steps.push(`${matters[0].headline} is verified or credited in the price`);
              } else {
                steps.push("No surprise maintenance items at inspection");
              }
              if (watchoutItems.length > 0) {
                steps.push(`${watchoutItems[0].text.split("–")[0].trim()} checked and cleared at pre-purchase inspection`);
              } else {
                steps.push("Pre-purchase inspection shows no hidden issues");
              }
              return (
                <div style={{ marginTop: 20, padding: "20px", background: SURFACE, border: `2px solid ${BORDER}`, borderRadius: 16 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: TEXT3, letterSpacing: "0.08em", marginBottom: 14 }}>YOU'RE DONE WHEN:</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                    {steps.map((item, i) => (
                      <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
                        <div style={{ width: 16, height: 16, border: "2px solid #CBD5E1", borderRadius: 4, flexShrink: 0, marginTop: 1 }} />
                        <span style={{ fontSize: 13, color: TEXT1, fontWeight: 500, lineHeight: 1.4 }}>{item}</span>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })()}

          </div>
        </div>
      </div>

      {/* ── Integrated Buying Advisor Panel ────────────────────────────────── */}
      <div ref={chatBarRef} style={{
        position: "fixed", bottom: 0, left: 0, right: 0, zIndex: 100,
        background: "transparent",
      }}>
        {/* Messages pane */}
        {chatOpen && (
          <div style={{ background: "#F8FAFC", borderTop: "1px solid #E2E8F0", boxShadow: "0 -8px 40px rgba(0,0,0,0.07)" }}>
            <div style={{ maxHeight: "38vh", overflowY: "auto", maxWidth: 860, margin: "0 auto", padding: "20px 24px 12px" }}>
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {messages.map((m, i) => (
                  <div key={i} className="slide-up" style={{ display: "flex", justifyContent: m.role === "user" ? "flex-end" : "flex-start", flexDirection: "column", alignItems: m.role === "user" ? "flex-end" : "flex-start" }}>
                    <div style={{ maxWidth: "76%", padding: "10px 15px", borderRadius: m.role === "user" ? "18px 18px 4px 18px" : "18px 18px 18px 4px", background: m.role === "user" ? "#4F46E5" : "#FFFFFF", border: m.role === "assistant" ? "1px solid #E2E8F0" : "none", color: m.role === "user" ? "#fff" : TEXT1, fontSize: 14, lineHeight: 1.6, boxShadow: m.role === "assistant" ? "0 2px 8px rgba(0,0,0,0.06)" : "none" }}>
                      {m.content.split("\n").map((line, li) => (
                        <span key={li}>{line.startsWith("**") && line.endsWith("**") ? <strong>{line.slice(2, -2)}</strong> : line}{li < m.content.split("\n").length - 1 && <br />}</span>
                      ))}
                    </div>
                    {/* Risk On two-button choice */}
                    {m.isRiskOnPrompt && !riskOnMode && (
                      <div style={{ display: "flex", gap: 8, marginTop: 8, maxWidth: "76%" }}>
                        <button
                          onClick={() => sendMessage("Help me decide if this is the right car for my situation.")}
                          style={{ flex: 1, padding: "10px 14px", background: "#F1F5F9", border: "1px solid #E2E8F0", borderRadius: 12, fontSize: 13, fontWeight: 700, color: TEXT2, cursor: "pointer", textAlign: "center" }}
                        >
                          Help me decide
                        </button>
                        <button
                          onClick={() => {
                            setRiskOnMode(true);
                            sendMessage("I'm committed to this car. Help me buy the best example and know what I'm signing up for.");
                          }}
                          style={{ flex: 1, padding: "10px 14px", background: "linear-gradient(135deg, #0F172A 0%, #1E293B 100%)", border: "none", borderRadius: 12, fontSize: 13, fontWeight: 700, color: "#F8FAFC", cursor: "pointer", textAlign: "center" }}
                        >
                          Help me buy this well ⚡
                        </button>
                      </div>
                    )}
                  </div>
                ))}
                {chatLoading && <TypingDots />}
                <div ref={chatEndRef} />
              </div>
            </div>
          </div>
        )}

        {/* Input panel — integrated, not a footer */}
        <div style={{
          background: "#FFFFFF",
          borderTop: "1px solid #E8ECEF",
          boxShadow: "0 -8px 40px rgba(15,23,42,0.08)",
          borderRadius: "18px 18px 0 0",
        }}>
          <div style={{ maxWidth: 860, margin: "0 auto", padding: "14px 24px 16px" }}>
            {/* Header row */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <div style={{ width: 8, height: 8, borderRadius: "50%", background: "#22C55E" }} />
                <span style={{ fontSize: 12, fontWeight: 700, color: TEXT2, letterSpacing: "0.05em" }}>BUYING ADVISOR</span>
              </div>
              <button onClick={() => setChatOpen(o => !o)} style={{ background: "none", border: "none", fontSize: 12, color: TEXT3, cursor: "pointer", fontWeight: 600 }}>
                {chatOpen ? "Hide conversation" : `${messages.length} message${messages.length !== 1 ? "s" : ""}`}
              </button>
            </div>

            {/* Prompt chips (shown only when chat is collapsed) */}
            {!chatOpen && (
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
                {[
                  "Would you personally buy this?",
                  "What should I check in person?",
                  askingPrice ? `Is $${offerLow.toLocaleString()} a fair offer?` : "How do I evaluate if the price is fair?",
                  "What's the biggest risk here?",
                ].map(q => (
                  <button key={q} onClick={() => sendMessage(q)}
                    style={{ padding: "5px 12px", background: "#F1F5F9", border: "1px solid #E2E8F0", borderRadius: 20, fontSize: 12, fontWeight: 600, color: TEXT2, cursor: "pointer", whiteSpace: "nowrap" }}>
                    {q}
                  </button>
                ))}
              </div>
            )}

            {/* Input row */}
            <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
              <input
                value={chatInput}
                onChange={e => setChatInput(e.target.value)}
                onKeyDown={e => e.key === "Enter" && sendMessage()}
                onFocus={() => setChatOpen(true)}
                placeholder="Ask anything about this car…"
                style={{ flex: 1, padding: "11px 16px", borderRadius: 12, border: "1px solid #DDE1E7", background: "#F8FAFC", fontSize: 14, color: TEXT1 }}
              />
              <button onClick={() => sendMessage()} disabled={chatLoading}
                style={{ width: 42, height: 42, borderRadius: 12, background: "#4F46E5", border: "none", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                <Send size={15} color="#fff" />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
