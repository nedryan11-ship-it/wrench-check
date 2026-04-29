"use client";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState, useRef } from "react";
import type { ComparisonResult, ComparedCar } from "@/lib/comparison/types";
import { gradeColors } from "@/lib/comparison/analyzePhotos";
import { computeWrenchScore } from "@/lib/comparison/wrenchScore";
import type { WrenchScoreResult } from "@/lib/comparison/wrenchScore";

// ─── Design tokens ────────────────────────────────────────────────────────────
const BG      = "#F8FAFC";
const SURFACE = "#FFFFFF";
const SURFACE2= "#F1F5F9";
const BORDER  = "#E2E8F0";
const TEXT1   = "#0F172A";
const TEXT2   = "#475569";
const TEXT3   = "#94A3B8";
const ACCENT  = "#4F46E5";
const GREEN   = "#15803D";
const RED     = "#B91C1C";
const YELLOW  = "#B45309";

// ─── Helpers ──────────────────────────────────────────────────────────────────
const fmt$ = (n: number) => `$${n.toLocaleString()}`;
const fmtK = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(0)}k` : String(n);

function mileageColor(mi: number | null | undefined) {
  if (!mi) return TEXT3;
  if (mi < 80000)  return GREEN;
  if (mi < 150000) return YELLOW;
  return RED;
}
function mileageLabel(mi: number | null | undefined) {
  if (!mi) return "—";
  return `${mi.toLocaleString()} mi`;
}

function reliabilityColors(tier: string | null) {
  if (tier === "excellent")    return { bg: "#F0FDF4", color: GREEN,  border: "#86EFAC" };
  if (tier === "good")         return { bg: "#EFF6FF", color: "#1D4ED8", border: "#BFDBFE" };
  if (tier === "below_average")return { bg: "#FFFBEB", color: YELLOW, border: "#FDE68A" };
  if (tier === "poor")         return { bg: "#FEF2F2", color: RED,    border: "#FECACA" };
  return { bg: SURFACE2, color: TEXT3, border: BORDER };
}
function frictionColors(tier: string) {
  if (tier === "low")    return { color: GREEN,  bg: "#F0FDF4", border: "#86EFAC" };
  if (tier === "medium") return { color: YELLOW, bg: "#FFFBEB", border: "#FDE68A" };
  return { color: RED, bg: "#FEF2F2", border: "#FECACA" };
}
function priceGapColor(gap: number) {
  if (gap < -500)  return GREEN;
  if (gap > 1500)  return RED;
  return TEXT2;
}

function Chip({ label, color, bg, border }: { label: string; color: string; bg: string; border: string }) {
  return (
    <span style={{ padding: "2px 10px", borderRadius: 99, fontSize: 12, fontWeight: 700,
      background: bg, color, border: `1px solid ${border}` }}>
      {label}
    </span>
  );
}

function GradeBadge({ grade }: { grade: string }) {
  const cs = gradeColors(grade as any);
  return <Chip label={grade} color={cs.color} bg={cs.bg} border={cs.border} />;
}

// ─── WrenchScore gauge (SVG semicircle, CarGurus-inspired) ────────────────────────
function WrenchScoreGauge({ score, size = 100 }: { score: number; size?: number }) {
  const R     = 40;
  const cx    = 50;
  const cy    = 52;
  const circ  = Math.PI * R; // semicircle circumference
  const pct   = clamp01(score / 100);
  // Score color: red(<50) → orange(50-64) → yellow(65-74) → green(75+)
  const gaugeColor = score >= 75 ? "#16A34A" : score >= 65 ? "#CA8A04" : score >= 50 ? "#EA580C" : "#DC2626";
  // Needle angle: -180° (left) to 0° (right) mapped to score 0–100
  const angleDeg  = -180 + pct * 180;
  const angleRad  = (angleDeg * Math.PI) / 180;
  const needleLen = 32;
  const nx = cx + needleLen * Math.cos(angleRad);
  const ny = cy + needleLen * Math.sin(angleRad);

  return (
    <svg width={size} height={size * 0.6} viewBox="0 0 100 60" style={{ display: "block" }}>
      {/* Track */}
      <path
        d={`M 10 52 A 40 40 0 0 1 90 52`}
        fill="none" stroke="#E2E8F0" strokeWidth="10" strokeLinecap="round"
      />
      {/* Filled arc */}
      <path
        d={`M 10 52 A 40 40 0 0 1 90 52`}
        fill="none" stroke={gaugeColor} strokeWidth="10" strokeLinecap="round"
        strokeDasharray={`${pct * circ} ${circ}`}
      />
      {/* Needle */}
      <line x1={cx} y1={cy} x2={nx} y2={ny} stroke="#1E293B" strokeWidth="2" strokeLinecap="round" />
      <circle cx={cx} cy={cy} r="3.5" fill="#1E293B" />
      {/* Score label */}
      <text x={cx} y={cy - 8} textAnchor="middle" fontSize="13" fontWeight="800" fill={gaugeColor}>{score}</text>
    </svg>
  );
}
function clamp01(n: number) { return Math.max(0, Math.min(1, n)); }

// ─── Matrix row label cell ────────────────────────────────────────────────────
function RowLabel({ main, sub }: { main: string; sub?: string }) {
  return (
    <div style={{ padding: "14px 20px", display: "flex", flexDirection: "column", justifyContent: "center" }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: TEXT3, letterSpacing: "0.06em" }}>{main}</div>
      {sub && <div style={{ fontSize: 9, color: TEXT3, opacity: 0.7, marginTop: 1 }}>{sub}</div>}
    </div>
  );
}

// ─── Matrix data cell ─────────────────────────────────────────────────────────
function Cell({ children, highlight }: { children: React.ReactNode; highlight?: boolean }) {
  return (
    <div style={{
      padding: "14px 16px", borderLeft: `1px solid ${BORDER}`, textAlign: "center",
      display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 4,
      background: highlight ? "#FFFDE7" : undefined,
    }}>
      {children}
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────
export default function HuntWorkspace() {
  const { id }   = useParams<{ id: string }>();
  const router   = useRouter();
  const searchParams = useSearchParams();
  const [comparison, setComparison] = useState<ComparisonResult | null>(null);
  const [isMobile, setIsMobile]     = useState(false);
  const [loading, setLoading]       = useState(true);
  const [expandedCards, setExpandedCards] = useState<Set<number>>(new Set());
  const [vaultOpen,     setVaultOpen]     = useState(false);
  const vaultInputRef = useRef<HTMLInputElement>(null);
  const [vaultFiles,   setVaultFiles]     = useState<File[]>([]);
  const [vaultMatches, setVaultMatches]   = useState<Record<string, string>>({});

  // Per-car re-audit state
  const [reauditProgress, setReauditProgress] = useState<Record<number, string>>({});
  const [reauditLoading,  setReauditLoading]  = useState<Record<number, boolean>>({});

  const runReaudit = async (fileIndex: number) => {
    if (!comparison || reauditLoading[fileIndex]) return;
    setReauditLoading(prev => ({ ...prev, [fileIndex]: true }));
    setReauditProgress(prev => ({ ...prev, [fileIndex]: "Starting re-audit..." }));

    const fd = new FormData();
    fd.append("carFileIndex", String(fileIndex));
    // Find vault PDFs matched to this car
    const car = comparison.cars.find(c => (c as any).fileIndex === fileIndex) as any;
    vaultFiles.forEach(f => {
      const vinMatch = f.name.match(/\b([A-HJ-NPR-Z0-9]{17})\b/i)?.[1]?.toUpperCase();
      const carVin   = (comparison.auditSummaries?.[fileIndex] as any)?.auditResult?.vehicle?.vin?.toUpperCase();
      const nameMatch = vaultMatches[f.name] === (car?.vehicleName ?? "");
      if ((vinMatch && carVin && vinMatch === carVin) || nameMatch) {
        fd.append("pdf", f);
      }
    });

    try {
      const res = await fetch(`/api/hunt/${id}/reaudit`, { method: "POST", body: fd });
      if (!res.ok) throw new Error("Re-audit request failed");
      const reader = res.body?.getReader();
      const dec    = new TextDecoder();
      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          for (const line of dec.decode(value).split("\n")) {
            if (!line.startsWith("data: ")) continue;
            try {
              const ev = JSON.parse(line.slice(6));
              if (ev.type === "progress") setReauditProgress(prev => ({ ...prev, [fileIndex]: ev.message }));
              if (ev.type === "complete" && ev.comparison) {
                setComparison(ev.comparison);
                setReauditProgress(prev => ({ ...prev, [fileIndex]: "Done!" }));
              }
              if (ev.type === "error")    setReauditProgress(prev => ({ ...prev, [fileIndex]: ev.message }));
            } catch {}
          }
        }
      }
    } catch (err: any) {
      setReauditProgress(prev => ({ ...prev, [fileIndex]: err.message ?? "Failed" }));
    } finally {
      setReauditLoading(prev => ({ ...prev, [fileIndex]: false }));
    }
  };

  // Add-car form state
  type CarForm = { url: string; price: string; pdfs: File[]; photos: File[]; dbId?: string };
  const [contenders,  setContenders]  = useState<CarForm[]>([{ url: "", price: "", pdfs: [], photos: [] }]);
  const [activeTab,   setActiveTab]   = useState(0);
  const pdfInputRef   = useRef<HTMLInputElement>(null);
  const photoInputRef = useRef<HTMLInputElement>(null);
  const [adding,      setAdding]      = useState(false);
  const [addProgress, setAddProgress] = useState("");
  const [addError,    setAddError]    = useState("");

  // Chat state
  type ChatMsg = { role: "user" | "assistant"; content: string; streaming?: boolean };
  const [chatOpen,    setChatOpen]    = useState(false);
  const [chatHistory, setChatHistory] = useState<ChatMsg[]>([]);
  const [chatInput,   setChatInput]   = useState("");
  const [chatLoading, setChatLoading] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);

  const sendChat = async (msg: string) => {
    if (!msg.trim() || chatLoading || !comparison) return;
    const userMsg: ChatMsg = { role: "user", content: msg };
    const updatedHistory = [...chatHistory, userMsg];
    setChatHistory(updatedHistory);
    setChatInput("");
    setChatLoading(true);
    setChatHistory(h => [...h, { role: "assistant", content: "", streaming: true }]);
    try {
      const res = await fetch(`/api/hunt/${id}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: msg,
          history: updatedHistory,
          comparison: {
            cars: comparison.cars,
            winner: comparison.winner,
            winnerReason: comparison.winnerReason,
            auditSummaries: comparison.auditSummaries,
          },
        }),
      });
      if (!res.ok) throw new Error("Chat request failed");
      const reader  = res.body?.getReader();
      const decoder = new TextDecoder();
      let full = "";
      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          for (const line of decoder.decode(value).split("\n")) {
            if (!line.startsWith("data: ")) continue;
            const text = line.slice(6);
            if (text === "[DONE]") break;
            full += text;
            setChatHistory(h => [...h.slice(0, -1), { role: "assistant", content: full, streaming: true }]);
          }
        }
      }
      setChatHistory(h => [...h.slice(0, -1), { role: "assistant", content: full || "Sorry, something went wrong.", streaming: false }]);
    } catch {
      setChatHistory(h => [...h.slice(0, -1), { role: "assistant", content: "Something went wrong. Please try again.", streaming: false }]);
    } finally {
      setChatLoading(false);
      setTimeout(() => chatEndRef.current?.scrollIntoView({ behavior: "smooth" }), 50);
    }
  };

  const toggleCard = (idx: number) => {
    setExpandedCards(prev => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx); else next.add(idx);
      return next;
    });
  };

  // ── Load workspace from DB ─────────────────────────────────────────────────
  useEffect(() => {
    setIsMobile(window.innerWidth < 768);
    fetch(`/api/case/${id}`)
      .then(r => r.json())
      .then(data => {
        if (data.messages?.length > 0) {
          const sysMsgs = data.messages.filter((m: any) => m.role === "system");
          if (sysMsgs.length > 0) {
            try { setComparison(JSON.parse(sysMsgs[sysMsgs.length - 1].content)); } catch {}
          }
        }
        setLoading(false);

        // Check if we were passed dbIds from the Master Inventory to auto-compare
        const dbIdsParam = searchParams?.get("dbIds");
        if (dbIdsParam) {
          try {
            const dbIds = JSON.parse(dbIdsParam) as string[];
            if (dbIds.length > 0) {
              setContenders(dbIds.map(dbId => ({ url: "", price: "", pdfs: [], photos: [], dbId })));
              // Remove the param from the URL so it doesn't re-trigger on refresh
              window.history.replaceState({}, '', `/hunt/${id}`);
              // Wait for React to flush the state to contenders, then submit
              setTimeout(() => {
                const triggerBtn = document.getElementById("auto-trigger-add");
                if (triggerBtn) triggerBtn.click();
              }, 100);
            }
          } catch(e) {}
        }
      })
      .catch(() => setLoading(false));
  }, [id, searchParams]);

  // ── Tab management ─────────────────────────────────────────────────────────
  const handleAddTab = () => {
    if (contenders.length >= 5) return;
    setContenders(prev => [...prev, { url: "", price: "", pdfs: [], photos: [] }]);
    setActiveTab(contenders.length);
  };

  const handleRemoveTab = (index: number) => {
    const next = contenders.filter((_, i) => i !== index);
    const safeNext = next.length ? next : [{ url: "", price: "", pdfs: [], photos: [] }];
    setContenders(safeNext);
    setActiveTab(Math.min(activeTab, Math.max(0, safeNext.length - 1)));
  };

  const updateContender = (index: number, field: keyof CarForm, value: any) => {
    setContenders(prev => {
      const next = [...prev];
      next[index] = { ...next[index], [field]: value };
      return next;
    });
  };

  const removePdf = (tabIdx: number, fileIdx: number) => {
    setContenders(prev => {
      const next = [...prev];
      const pdfs = [...next[tabIdx].pdfs];
      pdfs.splice(fileIdx, 1);
      next[tabIdx] = { ...next[tabIdx], pdfs };
      return next;
    });
  };

  const removePhoto = (tabIdx: number, fileIdx: number) => {
    setContenders(prev => {
      const next = [...prev];
      const photos = [...next[tabIdx].photos];
      photos.splice(fileIdx, 1);
      next[tabIdx] = { ...next[tabIdx], photos };
      return next;
    });
  };

  const clearForm = () => {
    setContenders([{ url: "", price: "", pdfs: [], photos: [] }]);
    setActiveTab(0);
  };

  // ── Submit ─────────────────────────────────────────────────────────────────
  const handleAdd = async () => {
    const hasData = contenders.some(c => c.dbId || c.url || c.pdfs.length > 0 || c.photos.length > 0);
    if (!hasData) return;

    setAdding(true);
    setAddProgress(`Starting analysis on ${contenders.filter(c => c.dbId || c.url || c.pdfs.length > 0 || c.photos.length > 0).length} car(s)...`);
    setAddError("");

    try {
      const fd = new FormData();
      contenders.forEach((c, idx) => {
        if (!c.dbId && !c.url && c.pdfs.length === 0 && c.photos.length === 0) return;
        if (c.dbId) fd.append(`car[${idx}][dbId]`, c.dbId);
        if (c.url) fd.append(`car[${idx}][url]`,   c.url);
        if (c.price) fd.append(`car[${idx}][price]`, c.price);
        c.pdfs.forEach(f  => fd.append(`car[${idx}][pdf]`,   f));
        c.photos.forEach(f => fd.append(`car[${idx}][photo]`, f));
      });

      const res = await fetch(`/api/hunt/${id}/add`, { method: "POST", body: fd });
      if (!res.body) throw new Error("No response stream");

      const reader  = res.body.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunks = decoder.decode(value).split("\n\n").filter(Boolean);
        for (const chunk of chunks) {
          if (!chunk.startsWith("data: ")) continue;
          let data: any;
          try { data = JSON.parse(chunk.slice(6)); } catch { continue; }

          if (data.type === "progress") setAddProgress(data.message);

          if (data.type === "car_resolved") {
            const c = data.carData;
            setComparison(prev => {
              if (!prev) return prev;
              const syntheticCar: any = {
                vehicleName:    c.vehicleName || "Unknown",
                fileIndex:      prev.cars.length,
                rank:           99,
                rankReason:     "Finalizing...",
                askingPrice:    c.auditResult?.askingPrice  ?? null,
                marketLow:      c.auditResult?.marketValueEstimate?.low  ?? 0,
                marketHigh:     c.auditResult?.marketValueEstimate?.high ?? 0,
                marketMid:      0,
                priceGapDollars:0,
                priceGapLabel:  "Analyzing...",
                tcoYear1Low: 0, tcoYear1High: 0, tcoYear3Low: 0, tcoYear3High: 0,
                avgAnnualCost:  null,
                frictionTier:   "medium",
                frictionNote:   "Analyzing...",
                downtimeEvents: "Analyzing...",
                reliabilityTier:null,
                majorRisk:      null,
                riskLevel:      "medium",
                optimalSellMileage: null,
                optimalSellNote: null,
                photoConditionReport: c.photoReport,
                photoCount:     c.photoCount,
                verdict:        c.auditResult?.verdict ?? "incomplete",
                maintenanceDebt:c.auditResult?.maintenanceDebt ?? 0,
                overdueCount:   0,
                listingUrl:     c.listingUrl,
                listingNotes:   c.notes ?? null,
                mileage:        c.scrapedMileage ?? c.auditResult?.vehicle?.currentMileage ?? null,
                location:       c.scrapedLocation ?? null,
                hasServiceHistory: c.hasServiceHistory,
              };
              return { ...prev, cars: [...prev.cars, syntheticCar] };
            });
          }

          if (data.type === "error") { setAddError(data.message); setAdding(false); }
          if (data.type === "complete") {
            setComparison(data.comparison);
            clearForm();
            setAdding(false);
          }
        }
      }
    } catch (err: any) {
      setAddError(err.message);
      setAdding(false);
    }
  };

  // ── Guards ─────────────────────────────────────────────────────────────────
  if (loading && !comparison) {
    return (
      <div style={{ minHeight: "100vh", background: BG, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div style={{ textAlign: "center" }}>
          <div style={{ width: 40, height: 40, border: `4px solid ${BORDER}`, borderTopColor: ACCENT, borderRadius: "50%", animation: "spin 0.8s linear infinite", margin: "0 auto 16px" }} />
          <div style={{ color: TEXT2, fontWeight: 600 }}>Loading Workspace...</div>
        </div>
      </div>
    );
  }
  if (!comparison) {
    return (
      <div style={{ minHeight: "100vh", background: BG, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div style={{ textAlign: "center", color: RED, fontWeight: 700, fontSize: 18 }}>Workspace not found.</div>
      </div>
    );
  }

  const { cars, headline, winner, winnerReason, bottomLine, isSameCar } = comparison;
  const PX = isMobile ? 16 : 32;
  const MAXW = 1200;

  const colGrid = `200px repeat(${cars.length}, minmax(160px, 1fr))`;

  const bestGap   = cars.length ? Math.min(...cars.map(c => c.priceGapDollars ?? 0)) : 0;
  const worstGap  = cars.length ? Math.max(...cars.map(c => c.priceGapDollars ?? 0)) : 0;
  const bestTco   = cars.length ? Math.min(...cars.filter(c => c.tcoYear3Low > 0).map(c => c.tcoYear3Low)) : 0;
  const bestDebt  = cars.length ? Math.min(...cars.map(c => c.maintenanceDebt ?? 0)) : 0;

  // ── Duplicate detection ────────────────────────────────────────────────────
  const duplicatePairs: [number, number][] = [];
  for (let a = 0; a < cars.length; a++) {
    for (let b = a + 1; b < cars.length; b++) {
      const ca = cars[a] as any;
      const cb = cars[b] as any;
      const sameModel = ca.vehicleName && cb.vehicleName &&
        ca.vehicleName.toLowerCase().replace(/\s+/g, ' ').trim() ===
        cb.vehicleName.toLowerCase().replace(/\s+/g, ' ').trim();
      const sameMileage = ca.mileage && cb.mileage && Math.abs(ca.mileage - cb.mileage) < 500;
      const sameLocation = ca.location && cb.location &&
        ca.location.toLowerCase().trim() === cb.location.toLowerCase().trim();
      if (sameModel && (sameMileage || sameLocation)) {
        duplicatePairs.push([a, b]);
      }
    }
  }
  const hasDuplicates = duplicatePairs.length > 0;

  // ── Negotiation script for the winner ─────────────────────────────────────
  const winnerCar = cars.find(c => c.rank === 1) as any;
  const winnerAudit = winnerCar
    ? (comparison.auditSummaries?.[winnerCar.fileIndex] ?? null) as any
    : null;
  const winnerInsights = winnerAudit?.auditResult?.modelInsights ?? null;
  const negotiationPoints: string[] = [];
  if (winnerCar) {
    const gap = winnerCar.priceGapDollars ?? 0;
    if (gap > 500) negotiationPoints.push(`Asking price is ${fmt$(Math.abs(gap))} above adjusted fair value — open $${Math.round(Math.abs(gap) * 0.9 / 100) * 100} below ask as your first offer.`);
    if (gap < -500) negotiationPoints.push(`Car is ${fmt$(Math.abs(gap))} below fair value — strong buy signal, but confirm with a PPI before committing.`);
    const mi = winnerInsights?.majorExposures ?? [];
    mi.forEach((exp: any) => {
      if (exp.urgency === 'near_term' && exp.costLow >= 1000) {
        negotiationPoints.push(`${exp.name} is a near-term failure (${fmt$(exp.costLow)}–${fmt$(exp.costHigh)}) — ask for a price concession or dealer-backed warranty covering this repair.`);
      }
    });
    const watchouts = winnerInsights?.watchouts ?? [];
    if (watchouts.length > 0 && negotiationPoints.length < 4) {
      negotiationPoints.push(`Request a pre-purchase inspection from an independent shop specifically focused on: ${watchouts.slice(0, 2).map((w: any) => w.text.split(' – ')[0]).join(' and ')}.`);
    }
    if ((winnerCar as any).location) {
      const isSalt = /ohio|michigan|new york|ny|pa|pennsylvania|illinois|indiana|minnesota|wisconsin|connecticut|new jersey|mass/i.test((winnerCar as any).location);
      if (isSalt) negotiationPoints.push(`Vehicle is from a salt-belt state (${(winnerCar as any).location}) — ask for a documented undercarriage inspection and negotiate a $1,500–$2,500 rust-risk discount.`);
    }
    if (negotiationPoints.length === 0) negotiationPoints.push('No major leverage points identified — this car appears fairly priced for its condition.');
  }

  // ── PPI checklist items ────────────────────────────────────────────────────
  const ppiItems: string[] = [];
  if (winnerInsights) {
    (winnerInsights.watchouts ?? []).forEach((w: any) => ppiItems.push(w.text.split(' – ')[0]));
    (winnerInsights.majorExposures ?? []).forEach((e: any) => {
      if (!ppiItems.some(p => p.toLowerCase().includes(e.name.toLowerCase().split(' ')[0]))) {
        ppiItems.push(`${e.name} — check for wear, leaks, and operational status`);
      }
    });
    if ((winnerCar as any)?.isSaltBelt) ppiItems.push('Undercarriage rust inspection — frame rails, subframe, brake lines');
    if (ppiItems.length === 0) ppiItems.push('Full pre-purchase inspection — brakes, suspension, engine, transmission');
  }
  const ppiText = [
    `PRE-PURCHASE INSPECTION CHECKLIST`,
    `Vehicle: ${winnerCar?.vehicleName ?? 'Winner'}`,
    `Generated by WrenchCheck`,
    '',
    ...ppiItems.map((item, i) => `☐ ${i + 1}. ${item}`),
    '',
    'Additionally request:',
    '☐ Full compression test',
    '☐ OBD-II scan for stored/pending codes',
    '☐ Transmission fluid condition check',
    '☐ Cooling system pressure test',
  ].join('\n');

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <>
    <div style={{ minHeight: "100vh", background: BG, fontFamily: "'Inter', system-ui, sans-serif", paddingBottom: 80 }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap');
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
        * { box-sizing: border-box; }
        input, button { font-family: inherit; }
        .card-expand { overflow: hidden; transition: max-height 0.35s ease, opacity 0.25s ease; }
      `}</style>

      <div style={{ maxWidth: MAXW, margin: "0 auto", padding: `40px ${PX}px` }}>

        {/* ── Nav ────────────────────────────────────────────────────────────── */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
          <button onClick={() => router.push("/hunt")}
            style={{ background: "none", border: "none", color: TEXT3, fontSize: 13, cursor: "pointer", padding: 0 }}>
            ← New Hunt
          </button>
          <button onClick={() => setVaultOpen(true)}
            style={{
              background: SURFACE, border: `1px solid ${BORDER}`, borderRadius: 10,
              color: TEXT2, fontSize: 12, fontWeight: 700, cursor: "pointer",
              padding: "6px 14px", display: "flex", alignItems: "center", gap: 6,
              boxShadow: "0 1px 4px rgba(0,0,0,0.06)",
            }}>
            📁 Document Vault {vaultFiles.length > 0 && <span style={{ background: ACCENT, color: "#fff", borderRadius: 99, fontSize: 10, padding: "1px 6px" }}>{vaultFiles.length}</span>}
          </button>
          {comparison && cars.length > 0 && (
            <button
              onClick={() => {
                const url = window.location.origin + window.location.pathname + "?shared=1";
                navigator.clipboard.writeText(url).then(() => {}).catch(() => {});
              }}
              style={{
                background: SURFACE, border: `1px solid ${BORDER}`, borderRadius: 10,
                color: TEXT2, fontSize: 12, fontWeight: 700, cursor: "pointer",
                padding: "6px 14px", display: "flex", alignItems: "center", gap: 6,
                boxShadow: "0 1px 4px rgba(0,0,0,0.06)",
              }}
            >
              🔗 Share
            </button>
          )}
        </div>
        <div style={{ fontSize: 11, fontWeight: 800, color: TEXT3, letterSpacing: "0.2em", marginBottom: 8 }}>
          WRENCHCHECK GARAGE WORKSPACE · {cars.length} CARS
        </div>
        <h1 style={{ fontSize: isMobile ? 22 : 34, fontWeight: 900, color: TEXT1, margin: "0 0 24px", letterSpacing: "-0.03em", lineHeight: 1.15 }}>
          {cars.length === 0 ? "The Hunt Begins" : headline}
        </h1>

        {/* ── Add Contender Widget ────────────────────────────────────────────── */}
        <div style={{ background: SURFACE, border: `1px solid ${BORDER}`, borderRadius: 16, padding: 24, marginBottom: 32, boxShadow: "0 4px 12px rgba(0,0,0,0.03)" }}>
          <div style={{ fontSize: 15, fontWeight: 800, color: TEXT1, marginBottom: 16 }}>
            Drop Contenders into the Gauntlet
          </div>
          <button id="auto-trigger-add" onClick={handleAdd} style={{ display: "none" }} />

          {/* Tabs with inline remove */}
          <div style={{ display: "flex", gap: 4, borderBottom: `1px solid ${BORDER}`, marginBottom: 20, overflowX: "auto", flexWrap: "nowrap" }}>
            {contenders.map((_, i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 0 }}>
                <button onClick={() => setActiveTab(i)} style={{
                  padding: "10px 16px", background: "none", border: "none",
                  borderBottom: activeTab === i ? `3px solid ${ACCENT}` : "3px solid transparent",
                  color: activeTab === i ? TEXT1 : TEXT2, fontWeight: activeTab === i ? 800 : 500,
                  cursor: "pointer", fontSize: 14, whiteSpace: "nowrap",
                }}>
                  Car {i + 1}
                </button>
                {contenders.length > 1 && (
                  <button onClick={() => handleRemoveTab(i)} disabled={adding} title="Remove this car" style={{
                    background: "none", border: "none", color: RED, fontSize: 12, cursor: "pointer",
                    padding: "0 6px", opacity: 0.7, lineHeight: 1,
                  }}>✕</button>
                )}
              </div>
            ))}
            {contenders.length < 5 && (
              <button onClick={handleAddTab} style={{
                padding: "10px 14px", background: "none", border: "none",
                borderBottom: "3px solid transparent",
                color: ACCENT, fontWeight: 700, cursor: "pointer", fontSize: 14,
              }}>+ Add Car</button>
            )}
          </div>

          {/* Active tab form */}
          <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "2fr 1fr", gap: 12, marginBottom: 10 }}>
            <input
              type="url"
              placeholder="Paste listing URL (cars.com, AutoTrader, Craigslist, FB Marketplace...)"
              value={contenders[activeTab].url}
              onChange={e => updateContender(activeTab, "url", e.target.value)}
              disabled={adding}
              style={{ width: "100%", padding: "12px 14px", border: `1px solid ${BORDER}`, borderRadius: 10, fontSize: 14, color: TEXT1, outline: "none" }}
            />
            <input
              type="text"
              placeholder="Manual Price (e.g. 45000)"
              value={contenders[activeTab].price}
              onChange={e => updateContender(activeTab, "price", e.target.value)}
              disabled={adding}
              style={{ width: "100%", padding: "12px 14px", border: `1px solid ${BORDER}`, borderRadius: 10, fontSize: 14, color: TEXT1, outline: "none" }}
            />
          </div>

          <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr", gap: 12, marginBottom: 20 }}>
            {/* PDF upload */}
            <div style={{ padding: 14, border: `2px dashed ${BORDER}`, borderRadius: 10, background: SURFACE2 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: TEXT2, marginBottom: 6 }}>Carfax / Service PDF</div>
              <input
                ref={pdfInputRef}
                type="file" multiple accept=".pdf"
                onChange={e => {
                  if (!e.target.files) return;
                  const newFiles = Array.from(e.target.files);
                  updateContender(activeTab, "pdfs", [...contenders[activeTab].pdfs, ...newFiles]);
                  e.target.value = "";
                }}
                disabled={adding}
                style={{ fontSize: 12, display: "block", marginBottom: 6 }}
              />
              {contenders[activeTab].pdfs.length > 0 && (
                <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                  {contenders[activeTab].pdfs.map((f, fi) => (
                    <div key={fi} style={{ display: "flex", alignItems: "center", gap: 4, background: "#EEF2FF", border: `1px solid #C7D2FE`, borderRadius: 6, padding: "2px 8px", fontSize: 11 }}>
                      <span style={{ color: ACCENT, fontWeight: 600 }}>📄 {f.name.length > 20 ? f.name.slice(0, 18) + "…" : f.name}</span>
                      <button onClick={() => removePdf(activeTab, fi)} style={{ background: "none", border: "none", color: RED, cursor: "pointer", padding: 0, fontSize: 12, lineHeight: 1 }}>✕</button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Photo upload */}
            <div style={{ padding: 14, border: `2px dashed ${BORDER}`, borderRadius: 10, background: SURFACE2 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: TEXT2, marginBottom: 6 }}>Listing Photos (Max 7)</div>
              <input
                ref={photoInputRef}
                type="file" multiple accept="image/*"
                onChange={e => {
                  if (!e.target.files) return;
                  const newFiles = Array.from(e.target.files);
                  const merged = [...contenders[activeTab].photos, ...newFiles].slice(0, 7);
                  updateContender(activeTab, "photos", merged);
                  e.target.value = "";
                }}
                disabled={adding}
                style={{ fontSize: 12, display: "block", marginBottom: 6 }}
              />
              {contenders[activeTab].photos.length > 0 && (
                <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                  {contenders[activeTab].photos.map((f, fi) => (
                    <div key={fi} style={{ display: "flex", alignItems: "center", gap: 4, background: "#F0FDF4", border: "1px solid #86EFAC", borderRadius: 6, padding: "2px 8px", fontSize: 11 }}>
                      <span style={{ color: GREEN, fontWeight: 600 }}>🖼 {f.name.length > 20 ? f.name.slice(0, 18) + "…" : f.name}</span>
                      <button onClick={() => removePhoto(activeTab, fi)} style={{ background: "none", border: "none", color: RED, cursor: "pointer", padding: 0, fontSize: 12, lineHeight: 1 }}>✕</button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
            <button
              onClick={handleAdd}
              disabled={adding || !contenders.some(c => c.url || c.pdfs.length > 0 || c.photos.length > 0)}
              style={{
                padding: "13px 28px",
                background: adding ? TEXT3 : TEXT1,
                color: "#FFF", border: "none", borderRadius: 10,
                fontSize: 15, fontWeight: 800, cursor: adding ? "wait" : "pointer",
                boxShadow: adding ? "none" : "0 4px 16px rgba(15,23,42,0.18)",
                transition: "all 0.15s",
              }}
            >
              {adding ? "Evaluating..." : `Evaluate ${contenders.filter(c => c.url || c.pdfs.length > 0 || c.photos.length > 0).length} Car(s)`}
            </button>
            {addProgress && <span style={{ fontSize: 13, color: TEXT2, fontWeight: 600 }}>{addProgress}</span>}
            {addError    && <span style={{ fontSize: 13, color: RED,   fontWeight: 600 }}>⚠ {addError}</span>}
          </div>
        </div>

        {/* ── Empty state ────────────────────────────────────────────────────── */}
        {cars.length === 0 && (
          <div style={{ padding: "60px 20px", textAlign: "center", border: `2px dashed ${BORDER}`, borderRadius: 20, animation: "fadeIn 0.3s ease" }}>
            <div style={{ fontSize: 40, marginBottom: 12 }}>🔍</div>
            <div style={{ fontSize: 22, fontWeight: 800, color: TEXT2, marginBottom: 8 }}>The Matrix is Empty</div>
            <div style={{ fontSize: 15, color: TEXT3 }}>Paste a listing URL above to start your first evaluation.</div>
          </div>
        )}

        {/* ── Winner Banner / Analysis Progress ──────────────────────────── */}
        {adding ? (
          <div style={{ animation: "fadeIn 0.4s ease" }}>
            <div style={{
              padding: "28px 32px",
              background: "linear-gradient(135deg, #0F172A 0%, #1E293B 100%)",
              borderRadius: 20, marginBottom: 32,
              boxShadow: "0 8px 32px rgba(15,23,42,0.2)",
            }}>
              <div style={{ fontSize: 11, fontWeight: 800, color: "#A5B4FC", letterSpacing: "0.1em", marginBottom: 10 }}>⏳ ANALYZING</div>
              <div style={{ fontSize: isMobile ? 18 : 24, fontWeight: 900, color: "#F8FAFC", marginBottom: 6 }}>
                Building Your Leaderboard...
              </div>
              <div style={{ fontSize: 14, color: "#94A3B8", lineHeight: 1.6 }}>
                {addProgress || "Fetching listings, running maintenance audit, and generating vehicle intelligence."}
              </div>
              <div style={{ marginTop: 16, height: 4, background: "rgba(255,255,255,0.1)", borderRadius: 99, overflow: "hidden" }}>
                <div style={{ height: "100%", width: "60%", background: "linear-gradient(90deg, #6366F1, #A5B4FC)", borderRadius: 99, animation: "pulse 1.5s ease-in-out infinite" }} />
              </div>
            </div>
          </div>
        ) : cars.length > 0 && winner && !winner.toLowerCase().includes("awaiting") && !winner.toLowerCase().includes("contenders") ? (
          <div style={{ animation: "fadeIn 0.4s ease" }}>
            <div style={{
              padding: "28px 32px",
              background: "linear-gradient(135deg, #0F172A 0%, #1E293B 100%)",
              borderRadius: 20, marginBottom: 32,
              boxShadow: "0 8px 32px rgba(15,23,42,0.2)",
            }}>
              <div style={{ fontSize: 11, fontWeight: 800, color: "#A5B4FC", letterSpacing: "0.1em", marginBottom: 10 }}>⚡ VERDICT</div>
              <div style={{ fontSize: isMobile ? 20 : 28, fontWeight: 900, color: "#F8FAFC", marginBottom: 6 }}>{winner}</div>
              <div style={{ fontSize: 14, color: "#CBD5E1", lineHeight: 1.6, marginBottom: bottomLine ? 12 : 0 }}>{winnerReason}</div>
              {bottomLine && (
                <div style={{ fontSize: 13, color: "#94A3B8", lineHeight: 1.7, borderTop: "1px solid rgba(255,255,255,0.08)", paddingTop: 12 }}>
                  {bottomLine}
                </div>
              )}
            </div>

            {/* ── Duplicate warning ───────────────────────────────────────────── */}
            {hasDuplicates && (
              <div style={{
                padding: "12px 16px", background: "#FFFBEB", border: "1px solid #FDE68A",
                borderRadius: 12, marginBottom: 20,
                display: "flex", alignItems: "flex-start", gap: 10,
              }}>
                <span style={{ fontSize: 16, flexShrink: 0 }}>⚠️</span>
                <div>
                  <div style={{ fontSize: 12, fontWeight: 800, color: YELLOW, marginBottom: 3 }}>POSSIBLE DUPLICATE LISTINGS DETECTED</div>
                  <div style={{ fontSize: 12, color: TEXT2, lineHeight: 1.5 }}>
                    {duplicatePairs.map(([a, b]) => `"${cars[a]?.vehicleName}" and "${cars[b]?.vehicleName}" appear to be the same car (same model${(cars[a] as any).mileage && (cars[b] as any).mileage ? ', similar mileage' : ''}${(cars[a] as any).location && (cars[b] as any).location ? ', same location' : ''}).`).join(' ')}
                    {' '}Remove one before finalizing your decision.
                  </div>
                </div>
              </div>
            )}

            {/* ── Negotiation Script ──────────────────────────────────────────── */}
            {negotiationPoints.length > 0 && winnerCar && (
              <div style={{
                padding: "20px 24px",
                background: "linear-gradient(135deg, #0C4A6E 0%, #075985 100%)",
                borderRadius: 16, marginBottom: 28,
                boxShadow: "0 4px 16px rgba(7,89,133,0.25)",
              }}>
                <div style={{ fontSize: 11, fontWeight: 800, color: "#7DD3FC", letterSpacing: "0.1em", marginBottom: 8 }}>💬 NEGOTIATION PLAYBOOK — {winnerCar.vehicleName}</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {negotiationPoints.map((pt, pi) => (
                    <div key={pi} style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                      <span style={{ flexShrink: 0, color: "#38BDF8", fontWeight: 800, fontSize: 14, marginTop: 1 }}>{pi + 1}.</span>
                      <div style={{ fontSize: 13, color: "#E0F2FE", lineHeight: 1.55 }}>{pt}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* ── PPI Checklist ────────────────────────────────────────────────── */}
            {ppiItems.length > 0 && winnerCar && (
              <div style={{
                padding: "16px 20px",
                background: SURFACE, border: `1px solid ${BORDER}`,
                borderRadius: 14, marginBottom: 28,
                boxShadow: "0 2px 8px rgba(0,0,0,0.04)",
              }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                  <div style={{ fontSize: 11, fontWeight: 800, color: TEXT3, letterSpacing: "0.1em" }}>🔍 PRE-PURCHASE INSPECTION CHECKLIST — HAND TO YOUR MECHANIC</div>
                  <button
                    onClick={() => { try { navigator.clipboard.writeText(ppiText); } catch {} }}
                    style={{
                      background: SURFACE2, border: `1px solid ${BORDER}`, borderRadius: 8,
                      color: TEXT2, fontSize: 11, fontWeight: 700, cursor: "pointer", padding: "4px 12px",
                    }}
                  >
                    Copy
                  </button>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {ppiItems.map((item, pi) => (
                    <div key={pi} style={{ display: "flex", gap: 10, alignItems: "flex-start", padding: "6px 10px", background: SURFACE2, borderRadius: 8 }}>
                      <span style={{ flexShrink: 0, fontSize: 13, color: TEXT3 }}>☐</span>
                      <div style={{ fontSize: 12, color: TEXT1, fontWeight: 500, lineHeight: 1.4 }}>{item}</div>
                    </div>
                  ))}
                  <div style={{ borderTop: `1px dashed ${BORDER}`, paddingTop: 8, marginTop: 4 }}>
                    {['Full compression test', 'OBD-II scan for stored/pending codes', 'Transmission fluid condition check', 'Cooling system pressure test'].map((std, si) => (
                      <div key={si} style={{ display: "flex", gap: 10, alignItems: "flex-start", padding: "4px 10px" }}>
                        <span style={{ flexShrink: 0, fontSize: 13, color: TEXT3 }}>☐</span>
                        <div style={{ fontSize: 12, color: TEXT2, lineHeight: 1.4 }}>{std}</div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {/* ── Leaderboard Matrix ──────────────────────────────────────────── */}
            <div style={{ background: SURFACE, border: `1px solid ${BORDER}`, borderRadius: 18, overflow: "hidden", overflowX: "auto", marginBottom: 40, boxShadow: "0 2px 8px rgba(0,0,0,0.04)" }}>
              {/* Header Row */}
              <div style={{ display: "grid", gridTemplateColumns: colGrid, borderBottom: `2px solid ${BORDER}`, background: SURFACE2, minWidth: isMobile ? 600 : undefined }}>
                <div style={{ padding: "16px 20px", position: isMobile ? "sticky" : undefined, left: isMobile ? 0 : undefined, background: SURFACE2, zIndex: 1 }} />
                {cars.map((c, i) => (
                  <div key={i} style={{ padding: "14px 16px", borderLeft: `1px solid ${BORDER}`, textAlign: "center" }}>
                    <div style={{ fontSize: 13, fontWeight: 800, color: TEXT1, marginBottom: 4 }}>
                      {c.vehicleName || `Car ${i + 1}`}
                    </div>
                    <div style={{
                      display: "inline-block", padding: "2px 10px", borderRadius: 99, fontSize: 11, fontWeight: 700,
                      background: c.rank === 1 ? "#EEF2FF" : SURFACE2,
                      color: c.rank === 1 ? ACCENT : TEXT3,
                      border: `1px solid ${c.rank === 1 ? "#C7D2FE" : BORDER}`,
                    }}>#{c.rank === 99 ? "…" : c.rank}</div>
                    {c.rankReason && c.rankReason !== "Finalizing..." && (
                      <div style={{ fontSize: 10, color: TEXT3, marginTop: 4, padding: "0 4px", lineHeight: 1.4 }}>{c.rankReason}</div>
                    )}
                  </div>
                ))}
              </div>

              {/* Price vs Market */}
              <div style={{ display: "grid", gridTemplateColumns: colGrid, borderBottom: `1px solid ${BORDER}` }}>
                <RowLabel main="PRICE VS MARKET" sub="Mileage + location adjusted" />
                {cars.map((c, i) => {
                  const gap    = c.priceGapDollars ?? 0;
                  const gapDir = gap > 500 ? "above" : gap < -500 ? "below" : "at";
                  const gapColor = gapDir === "below" ? GREEN : gapDir === "above" ? RED : TEXT2;
                  const adjMid = c.marketMid && c.marketMid > 0 ? c.marketMid : null;
                  return (
                    <Cell key={i}>
                      {c.askingPrice && <span style={{ fontWeight: 800, color: TEXT1 }}>{fmt$(c.askingPrice)}</span>}
                      <span style={{ fontWeight: 700, color: gapColor, fontSize: 12 }}>{c.priceGapLabel || "—"}</span>
                      {adjMid && (
                        <span style={{ fontSize: 10, color: TEXT3 }}>Fair value: {fmt$(adjMid)}</span>
                      )}
                    </Cell>
                  );
                })}
              </div>

              {/* Market Comps Row */}
              <div style={{ display: "grid", gridTemplateColumns: colGrid, borderBottom: `1px solid ${BORDER}`, background: "#F8FFFE" }}>
                <RowLabel main="RETAIL MARKET" sub="Live Cars.com comps" />
                {cars.map((c: any, i) => {
                  const mc = c.marketComps;
                  if (!mc || mc.count < 2) return (
                    <Cell key={i}><span style={{ fontSize: 11, color: TEXT3 }}>Fetching...</span></Cell>
                  );
                  return (
                    <Cell key={i}>
                      <span style={{ fontWeight: 800, color: TEXT1 }}>{fmt$(mc.priceMed)}</span>
                      <span style={{ fontSize: 10, color: TEXT3 }}>median · {mc.count} listings</span>
                      <span style={{ fontSize: 10, color: TEXT3 }}>{fmt$(mc.priceMin)}–{fmt$(mc.priceMax)}</span>
                    </Cell>
                  );
                })}
              </div>

              <div style={{ display: "grid", gridTemplateColumns: colGrid, borderBottom: `1px solid ${BORDER}`, background: "#FAFBFC" }}>
                <RowLabel main="MILEAGE" sub="Lower is better" />
                {cars.map((c: any, i) => {
                  const mi = (c as any).mileage ?? (c as any).auditResult?.vehicle?.currentMileage ?? null;
                  return (
                    <Cell key={i}>
                      <span style={{ fontWeight: 800, fontSize: 15, color: mileageColor(mi) }}>{mileageLabel(mi)}</span>
                    </Cell>
                  );
                })}
              </div>

              {/* Maintenance Debt */}
              <div style={{ display: "grid", gridTemplateColumns: colGrid, borderBottom: `1px solid ${BORDER}` }}>
                <RowLabel main="MAINT. DEBT" sub="Confirmed overdue" />
                {cars.map((c, i) => {
                  const debt = c.maintenanceDebt ?? 0;
                  const color = debt === 0 ? GREEN : debt === bestDebt ? GREEN : debt > 1000 ? RED : YELLOW;
                  return (
                    <Cell key={i}>
                      <span style={{ fontWeight: 800, color }}>{debt > 0 ? fmt$(debt) : "None ✓"}</span>
                      {c.overdueCount > 0 && <span style={{ fontSize: 10, color: RED }}>{c.overdueCount} overdue item{c.overdueCount > 1 ? "s" : ""}</span>}
                    </Cell>
                  );
                })}
              </div>

              {/* Service History */}
              <div style={{ display: "grid", gridTemplateColumns: colGrid, borderBottom: `1px solid ${BORDER}`, background: "#FAFBFC" }}>
                <RowLabel main="HISTORY" sub="Provenance confidence" />
                {cars.map((c: any, i) => {
                  const hasHistory = (c as any).hasServiceHistory !== false;
                  return (
                    <Cell key={i} highlight={!hasHistory}>
                      {hasHistory ? (
                        <span style={{ fontWeight: 700, color: GREEN, fontSize: 12 }}>✓ Provided</span>
                      ) : (
                        <div style={{ textAlign: "center" }}>
                          <div style={{ fontWeight: 700, color: YELLOW, fontSize: 12, marginBottom: 4 }}>⚠ Missing</div>
                          <label style={{
                            fontSize: 10, fontWeight: 700, color: ACCENT, cursor: "pointer",
                            padding: "3px 8px", border: `1px solid ${ACCENT}`, borderRadius: 6,
                            background: "#EEF2FF",
                          }}>
                            Upload Carfax
                            <input type="file" accept=".pdf" style={{ display: "none" }}
                              onChange={e => {
                                if (!e.target.files) return;
                                // Switch to the matching contender tab (or first empty one)
                                const tab = Math.min(i, contenders.length - 1);
                                updateContender(tab, "pdfs", [...contenders[tab].pdfs, ...Array.from(e.target.files)]);
                                setActiveTab(tab);
                              }}
                            />
                          </label>
                        </div>
                      )}
                    </Cell>
                  );
                })}
              </div>

              {/* Location */}
              <div style={{ display: "grid", gridTemplateColumns: colGrid, borderBottom: `1px solid ${BORDER}` }}>
                <RowLabel main="LOCATION" sub="Rust risk signal" />
                {cars.map((c: any, i) => {
                  const loc = (c as any).location ?? null;
                  const isSaltBelt = loc && /ohio|michigan|new york|ny|pa|pennsylvania|illinois|indiana|minnesota|wisconsin|connecticut|new jersey|mass/i.test(loc);
                  const isDryBelt  = loc && /colorado|arizona|california|nevada|new mexico|utah|texas|florida/i.test(loc);
                  return (
                    <Cell key={i}>
                      {loc ? (
                        <>
                          <span style={{ fontWeight: 700, color: TEXT1, fontSize: 12 }}>{loc}</span>
                          {isDryBelt  && <span style={{ fontSize: 10, color: GREEN }}>🌵 Low rust risk</span>}
                          {isSaltBelt && <span style={{ fontSize: 10, color: YELLOW }}>⚠ Salt belt</span>}
                        </>
                      ) : (
                        <span style={{ color: TEXT3 }}>—</span>
                      )}
                    </Cell>
                  );
                })}
              </div>

              {/* Owner History */}
              <div style={{ display: "grid", gridTemplateColumns: colGrid, borderBottom: `1px solid ${BORDER}`, background: "#FAFBFC" }}>
                <RowLabel main="OWNER HISTORY" />
                {cars.map((c: any, i) => {
                  const cf     = c.auditResult?.carfaxSignals;
                  const owners = cf?.ownerCount ?? null;
                  const accident = cf?.hasAccident ?? null;
                  return (
                    <Cell key={i}>
                      {owners !== null
                        ? <span style={{ fontWeight: 700, color: owners === 1 ? GREEN : owners <= 2 ? TEXT2 : YELLOW, fontSize: 12 }}>
                            {owners} owner{owners !== 1 ? "s" : ""}
                          </span>
                        : <span style={{ color: TEXT3 }}>—</span>
                      }
                      {accident === false && <span style={{ fontSize: 10, color: GREEN }}>No accidents</span>}
                      {accident === true  && <span style={{ fontSize: 10, color: RED }}>⚠ Accident reported</span>}
                    </Cell>
                  );
                })}
              </div>

              {/* TCO 3-Year */}
              <div style={{ display: "grid", gridTemplateColumns: colGrid, borderBottom: `1px solid ${BORDER}` }}>
                <RowLabel main="TCO · 3 YEARS" sub="Lower is better" />
                {cars.map((c, i) => (
                  <Cell key={i}>
                    {c.tcoYear3Low > 0
                      ? <span style={{ fontWeight: 800, fontSize: 15, color: c.tcoYear3Low === bestTco ? GREEN : TEXT1 }}>
                          {fmt$(c.tcoYear3Low)}
                        </span>
                      : <span style={{ color: TEXT3 }}>—</span>
                    }
                  </Cell>
                ))}
              </div>

              {/* Friction Tier */}
              <div style={{ display: "grid", gridTemplateColumns: colGrid, borderBottom: `1px solid ${BORDER}`, background: "#FAFBFC" }}>
                <RowLabel main="OWNERSHIP" sub="Friction level" />
                {cars.map((c, i) => {
                  const fc = frictionColors(c.frictionTier || "medium");
                  return (
                    <Cell key={i}>
                      <Chip label={c.frictionTier || "medium"} {...fc} />
                      {c.frictionNote && c.frictionNote !== "TBD" && c.frictionNote !== "Analyzing..." && (
                        <span style={{ fontSize: 10, color: TEXT3, marginTop: 2, padding: "0 4px", lineHeight: 1.4, textAlign: "center" }}>{c.frictionNote}</span>
                      )}
                    </Cell>
                  );
                })}
              </div>

              {/* Photo Grade */}
              {cars.some(c => c.photoConditionReport) && (
                <div style={{ display: "grid", gridTemplateColumns: colGrid, borderBottom: `1px solid ${BORDER}` }}>
                  <RowLabel main="PHOTO GRADE" sub="Visual condition" />
                  {cars.map((c, i) => (
                    <Cell key={i}>
                      {c.photoConditionReport ? (
                        <>
                          <GradeBadge grade={c.photoConditionReport.grade} />
                          <span style={{ fontSize: 10, color: TEXT3, marginTop: 2 }}>{c.photoConditionReport.gradeLabel}</span>
                        </>
                      ) : (
                        <span style={{ fontSize: 10, color: TEXT3 }}>No photos</span>
                      )}
                    </Cell>
                  ))}
                </div>
              )}

              {/* Major Risk */}
              <div style={{ display: "grid", gridTemplateColumns: colGrid }}>
                <RowLabel main="MAJOR RISK" />
                {cars.map((c, i) => (
                  <Cell key={i}>
                    {c.majorRisk
                      ? <span style={{ fontSize: 11, color: RED, fontWeight: 600, padding: "0 4px", textAlign: "center", lineHeight: 1.4 }}>{c.majorRisk}</span>
                      : <span style={{ color: GREEN, fontWeight: 700, fontSize: 12 }}>None identified</span>
                    }
                  </Cell>
                ))}
              </div>
            </div>

            {/* ── Vehicle Intelligence Cards ────────────────────────────────── */}
            <div style={{ marginBottom: 40 }}>
              <div style={{ fontSize: 11, fontWeight: 800, color: TEXT3, letterSpacing: "0.15em", marginBottom: 16 }}>
                🔬 VEHICLE INTELLIGENCE — MODEL-SPECIFIC ANALYSIS
              </div>

              {/* Cross-car year feature diff callout */}
              {comparison.crossCarFeatureDiff && (
                <div style={{
                  marginBottom: 16, padding: "12px 16px",
                  background: "linear-gradient(135deg, #EFF6FF, #DBEAFE)",
                  border: "1px solid #93C5FD", borderRadius: 12,
                  display: "flex", alignItems: "flex-start", gap: 10,
                }}>
                  <span style={{ fontSize: 16, flexShrink: 0 }}>🔀</span>
                  <div>
                    <div style={{ fontSize: 11, fontWeight: 800, color: "#1D4ED8", letterSpacing: "0.07em", marginBottom: 3 }}>
                      YEAR-OVER-YEAR FEATURE DIFFERENCES
                    </div>
                    <div style={{ fontSize: 13, color: "#1E3A8A", fontWeight: 500, lineHeight: 1.5 }}>
                      {comparison.crossCarFeatureDiff}
                    </div>
                  </div>
                </div>
              )}

              <div style={{ display: "grid", gridTemplateColumns: `repeat(${Math.min(cars.length, 2)}, 1fr)`, gap: 16 }}>
                {cars.map((c: any, i) => {
                  // CRITICAL: cars[] is sorted by rank, but auditSummaries[] is ordered by upload position.
                  // Use c.fileIndex (upload order) to find the correct auditSummary for this car.
                  const auditSummary = comparison.auditSummaries?.[c.fileIndex]
                    ?? comparison.auditSummaries?.find(
                      (s: any) => s.auditKey === `audit_${comparison.sessionId}_${c.fileIndex}`
                    );

                  const mi: any = auditSummary?.auditResult?.modelInsights ?? null;
                  const mileage = c.mileage ?? auditSummary?.auditResult?.vehicle?.currentMileage ?? null;
                  const name = c.vehicleName || `Car ${i + 1}`;
                  const isSaltBelt = c.isSaltBelt ?? false;
                  const isExpanded = expandedCards.has(i);
                  const ci = auditSummary?.auditResult?.controversyIndex ?? null;

                  // Compute WrenchScore for this car
                  const ws: WrenchScoreResult = computeWrenchScore(c, auditSummary?.auditResult);
                  const tierBg    = ws.tier === "gem" ? "#DCFCE7" : ws.tier === "watch" ? "#FEF3C7" : "#FEE2E2";
                  const tierColor = ws.tier === "gem" ? "#15803D" : ws.tier === "watch" ? "#92400E" : "#B91C1C";

                  const trustBadge = (color: "green" | "orange" | "blue" | "red") => ({
                    padding: "3px 8px", borderRadius: 99, fontSize: 10, fontWeight: 700,
                    background: color === "green" ? "#F0FDF4" : color === "orange" ? "#FFF7ED" : color === "blue" ? "#EFF6FF" : "#FEF2F2",
                    color: color === "green" ? "#15803D" : color === "orange" ? "#C2410C" : color === "blue" ? "#1D4ED8" : "#B91C1C",
                    border: `1px solid ${color === "green" ? "#86EFAC" : color === "orange" ? "#FDBA74" : color === "blue" ? "#BFDBFE" : "#FECACA"}`,
                    whiteSpace: "nowrap" as const
                  });

                  return (
                    <div key={i} style={{
                      background: SURFACE, border: `1px solid ${ws.tier === "gem" ? "#86EFAC" : ws.tier === "watch" ? "#FCD34D" : "#FCA5A5"}`,
                      borderRadius: 16, overflow: "hidden",
                      boxShadow: ws.tier === "gem" ? "0 4px 16px rgba(22,163,74,0.12)" : "0 2px 8px rgba(0,0,0,0.04)",
                      animation: "fadeIn 0.4s ease",
                    }}>

                      {/* Card header — verdict-first */}
                      <div style={{ padding: "16px 18px", background: c.rank === 1 ? "linear-gradient(135deg, #0F172A, #1E293B)" : SURFACE2, borderBottom: `1px solid ${BORDER}` }}>
                        {/* Gauge + verdict + gem price */}
                        <div style={{ display: "flex", alignItems: "flex-start", gap: 14, marginBottom: 12 }}>
                          <div style={{ flexShrink: 0 }}>
                            <WrenchScoreGauge score={ws.score} size={92} />
                            <div style={{ fontSize: 9, fontWeight: 700, color: c.rank === 1 ? "#64748B" : TEXT3, textAlign: "center", marginTop: 1, letterSpacing: "0.08em" }}>WRENCHSCORE</div>
                          </div>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ display: "inline-flex", alignItems: "center", padding: "4px 12px", borderRadius: 99, background: tierBg, marginBottom: 6 }}>
                              <span style={{ fontWeight: 800, fontSize: 13, color: tierColor }}>{ws.tierLabel}</span>
                            </div>
                            <div style={{ fontSize: 12, fontWeight: 600, color: c.rank === 1 ? "#CBD5E1" : TEXT2, marginBottom: 6 }}>{ws.tierDescription}</div>
                            {ws.gemPriceTarget && c.askingPrice ? (
                              <div style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "3px 10px", borderRadius: 8, background: "#EFF6FF", border: "1px solid #BFDBFE" }}>
                                <span style={{ fontSize: 10, color: "#1D4ED8", fontWeight: 700 }}>{"\U0001f4a1"} Gem at {fmt$(ws.gemPriceTarget)}</span>
                                <span style={{ fontSize: 10, color: "#3B82F6" }}>({fmt$(c.askingPrice - ws.gemPriceTarget)} off ask)</span>
                              </div>
                            ) : ws.tier === "gem" ? (
                              <div style={{ display: "inline-flex", alignItems: "center", padding: "3px 10px", borderRadius: 8, background: "#DCFCE7", border: "1px solid #86EFAC" }}>
                                <span style={{ fontSize: 10, color: "#15803D", fontWeight: 700 }}>{"\u2713"} Already a Gem {"\u2014"} buy it</span>
                              </div>
                            ) : null}
                          </div>
                          <div style={{ flexShrink: 0, padding: "3px 9px", borderRadius: 8, background: c.rank === 1 ? "#4F46E5" : SURFACE, border: `1px solid ${c.rank === 1 ? "#4F46E5" : BORDER}`, color: c.rank === 1 ? "#fff" : TEXT3, fontSize: 11, fontWeight: 800 }}>
                            #{c.rank === 99 ? "—" : c.rank}
                          </div>
                        </div>
                        {/* Vehicle name */}
                        <div style={{ fontSize: 16, fontWeight: 900, color: c.rank === 1 ? "#F8FAFC" : TEXT1, marginBottom: 8, lineHeight: 1.2 }}>{name}</div>
                        {/* Trust badges */}
                        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
                          {!isSaltBelt && c.location && <span style={trustBadge("green")}>{"\U0001f335"} Rust-free</span>}
                          {isSaltBelt && <span style={trustBadge("orange")}>{"\u26a0"} Salt belt</span>}
                          {auditSummary?.auditResult?.vehicle?.ownerCount === 1 && <span style={trustBadge("green")}>1-owner</span>}
                          {(c as any).hasServiceHistory && <span style={trustBadge("blue")}>{"\U0001f4cb"} Docs</span>}
                          {!mileage && <span style={trustBadge("orange")}>{"\u26a0"} No mileage</span>}
                          {mi?.reliabilityTier === "excellent" && <span style={trustBadge("green")}>{"\u2b50"} Excellent reliability</span>}
                          {mi?.reliabilityTier === "poor" && <span style={trustBadge("red")}>{"\u26a0"} Poor reliability</span>}
                        </div>
                        {/* Key stats */}
                        <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
                          {mileage && (
                            <div>
                              <div style={{ fontSize: 9, fontWeight: 700, color: c.rank === 1 ? "#94A3B8" : TEXT3, letterSpacing: "0.1em" }}>MILEAGE</div>
                              <div style={{ fontSize: 14, fontWeight: 800, color: c.rank === 1 ? "#F8FAFC" : mileageColor(mileage) }}>{mileageLabel(mileage)}</div>
                            </div>
                          )}
                          {c.askingPrice && (
                            <div>
                              <div style={{ fontSize: 9, fontWeight: 700, color: c.rank === 1 ? "#94A3B8" : TEXT3, letterSpacing: "0.1em" }}>ASKING</div>
                              <div style={{ fontSize: 14, fontWeight: 800, color: c.rank === 1 ? "#F8FAFC" : TEXT1 }}>{fmt$(c.askingPrice)}</div>
                            </div>
                          )}
                          {c.marketComps?.priceMed ? (
                            <div>
                              <div style={{ fontSize: 9, fontWeight: 700, color: c.rank === 1 ? "#94A3B8" : TEXT3, letterSpacing: "0.1em" }}>MARKET MED.</div>
                              <div style={{ fontSize: 14, fontWeight: 800, color: c.rank === 1 ? "#CBD5E1" : TEXT2 }}>{fmt$(c.marketComps.priceMed)}</div>
                            </div>
                          ) : c.marketMid > 0 ? (
                            <div>
                              <div style={{ fontSize: 9, fontWeight: 700, color: c.rank === 1 ? "#94A3B8" : TEXT3, letterSpacing: "0.1em" }}>FAIR VALUE</div>
                              <div style={{ fontSize: 14, fontWeight: 800, color: c.rank === 1 ? "#CBD5E1" : TEXT2 }}>{fmt$(c.marketMid)}</div>
                            </div>
                          ) : null}
                          {mi?.avgAnnualCost && (
                            <div>
                              <div style={{ fontSize: 9, fontWeight: 700, color: c.rank === 1 ? "#94A3B8" : TEXT3, letterSpacing: "0.1em" }}>AVG/YR</div>
                              <div style={{ fontSize: 14, fontWeight: 800, color: c.rank === 1 ? "#FCA5A5" : RED }}>{fmt$(mi.avgAnnualCost)}</div>
                            </div>
                          )}
                        </div>
                      </div>


                      {/* ── Always-visible: Narrative + Expert Take + Collapse toggle ── */}
                      <div style={{ padding: "14px 20px", display: "flex", flexDirection: "column", gap: 10 }}>

                        {/* Vehicle narrative — unique pitch for this specific car */}
                        {mi?.vehicleNarrative && (
                          <div style={{ fontSize: 13, color: TEXT2, fontStyle: "italic", lineHeight: 1.55, borderLeft: `3px solid ${c.rank === 1 ? ACCENT : BORDER}`, paddingLeft: 10 }}>
                            {mi.vehicleNarrative}
                          </div>
                        )}

                        {/* Expert take — always visible */}
                        {mi?.expertTake && (
                          <div style={{ padding: "10px 14px", background: "#FFFBEB", border: "1px solid #FDE68A", borderRadius: 10 }}>
                            <div style={{ fontSize: 10, fontWeight: 800, color: YELLOW, letterSpacing: "0.08em", marginBottom: 4 }}>⚡ EXPERT TAKE</div>
                            <div style={{ fontSize: 13, color: TEXT1, lineHeight: 1.5, fontWeight: 500 }}>{mi.expertTake}</div>
                          </div>
                        )}

                        {/* No intel fallback */}
                        {!mi && (
                          <div style={{ padding: "16px", background: SURFACE2, borderRadius: 10, textAlign: "center" }}>
                            <div style={{ fontSize: 12, color: TEXT2, fontWeight: 600, marginBottom: 4 }}>⏳ Model-specific analysis pending</div>
                            <div style={{ fontSize: 11, color: TEXT3, lineHeight: 1.5 }}>Re-run evaluation to fetch watchouts, TCO, and known issues for this {name}.</div>
                          </div>
                        )}

                        {/* Footer row: listing link + expand toggle */}
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 2 }}>
                          {c.listingUrl && (
                            <a href={c.listingUrl} target="_blank" rel="noopener noreferrer" style={{ fontSize: 12, color: ACCENT, fontWeight: 600, textDecoration: "none" }}>
                              ↗ View Listing
                            </a>
                          )}
                          {mi && (
                            <button
                              onClick={() => toggleCard(i)}
                              style={{
                                background: "none", border: `1px solid ${BORDER}`, borderRadius: 8,
                                color: TEXT3, fontSize: 11, fontWeight: 700, cursor: "pointer",
                                padding: "5px 12px", marginLeft: "auto",
                                transition: "border-color 0.15s",
                              }}
                            >
                              {isExpanded ? "↑ Collapse" : "↓ Full Analysis"}
                            </button>
                          )}
                        </div>
                      </div>

                      {/* ── Expandable deep-dive ─────────────────────────── */}
                      {mi && isExpanded && (
                        <div style={{ padding: "16px 20px", display: "flex", flexDirection: "column", gap: 16, borderTop: `1px solid ${BORDER}`, animation: "fadeIn 0.25s ease" }}>

                          {/* Controversy meter */}
                          {ci !== null && (
                            <div>
                            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                              <div style={{ fontSize: 10, fontWeight: 700, color: TEXT3, letterSpacing: "0.08em" }}>RISK / CONTROVERSY INDEX</div>
                              <div style={{ fontSize: 12, fontWeight: 800, color: ci <= 3 ? GREEN : ci <= 6 ? YELLOW : RED }}>{ci}/10</div>
                            </div>
                            <div style={{ height: 6, background: SURFACE2, borderRadius: 99, overflow: "hidden" }}>
                              <div style={{ height: "100%", width: `${ci * 10}%`, borderRadius: 99, background: ci <= 3 ? "#22C55E" : ci <= 6 ? "#F59E0B" : "#EF4444", transition: "width 0.6s ease" }} />
                            </div>
                            <div style={{ fontSize: 10, color: TEXT3, marginTop: 4 }}>
                              {ci <= 2 ? "Bulletproof daily driver" : ci <= 4 ? "Mainstream, manageable risk" : ci <= 6 ? "Elevated — budget for surprises" : ci <= 8 ? "High risk / enthusiast territory" : "Extreme — project car territory"}
                            </div>
                          </div>
                        )}

                        {/* Year-specific feature differences */}
                        {(mi?.yearFeatures?.length > 0 || mi?.trimNotes) && (
                          <div style={{ padding: "12px 14px", background: "#EFF6FF", border: "1px solid #BFDBFE", borderRadius: 10 }}>
                            <div style={{ fontSize: 10, fontWeight: 800, color: "#1D4ED8", letterSpacing: "0.08em", marginBottom: 8 }}>
                              🔧 {name.match(/\d{4}/)?.[0] ?? ""} MODEL YEAR — WHAT YOU GET
                            </div>
                            {mi.yearFeatures?.length > 0 && (
                              <div style={{ display: "flex", flexDirection: "column", gap: 4, marginBottom: mi.trimNotes ? 8 : 0 }}>
                                {mi.yearFeatures.map((f: string, fi: number) => (
                                  <div key={fi} style={{ fontSize: 12, color: "#1E40AF", display: "flex", gap: 6, alignItems: "flex-start" }}>
                                    <span style={{ flexShrink: 0, marginTop: 1 }}>✦</span>
                                    <span style={{ lineHeight: 1.4 }}>{f}</span>
                                  </div>
                                ))}
                              </div>
                            )}
                            {mi.trimNotes && (
                              <div style={{ fontSize: 11, color: "#3730A3", borderTop: mi.yearFeatures?.length > 0 ? "1px solid #BFDBFE" : "none", paddingTop: mi.yearFeatures?.length > 0 ? 8 : 0, fontStyle: "italic" }}>
                                {mi.trimNotes}
                              </div>
                            )}
                          </div>
                        )}

                        {/* Known Watchouts */}
                        {mi?.watchouts?.length > 0 && (
                          <div>
                            <div style={{ fontSize: 10, fontWeight: 800, color: TEXT3, letterSpacing: "0.08em", marginBottom: 8 }}>⚠ KNOWN WATCHOUTS AT THIS MILEAGE</div>
                            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                              {mi.watchouts.map((w: any, wi: number) => (
                                <div key={wi} style={{ display: "flex", gap: 10, alignItems: "flex-start", padding: "8px 12px", background: "#FEF2F2", border: "1px solid #FECACA", borderRadius: 8 }}>
                                  <span style={{ color: RED, fontSize: 14, flexShrink: 0 }}>⚑</span>
                                  <div style={{ flex: 1 }}>
                                    <div style={{ fontSize: 12, fontWeight: 700, color: TEXT1, lineHeight: 1.4 }}>{w.text}</div>
                                    {w.estimatedCost && <div style={{ fontSize: 11, color: RED, fontWeight: 600, marginTop: 2 }}>~{fmt$(w.estimatedCost)}</div>}
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}

                        {/* Major Exposures */}
                        {mi?.majorExposures?.length > 0 && (
                          <div>
                            <div style={{ fontSize: 10, fontWeight: 800, color: TEXT3, letterSpacing: "0.08em", marginBottom: 8 }}>💸 MAJOR COST EXPOSURES</div>
                            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                              {mi.majorExposures.map((e: any, ei: number) => {
                                const urgencyColor = e.urgency === "near_term" ? RED : e.urgency === "watch" ? YELLOW : TEXT2;
                                const urgencyLabel = e.urgency === "near_term" ? "Soon" : e.urgency === "watch" ? "Watch" : "Long-term";
                                return (
                                  <div key={ei} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 12px", background: SURFACE2, border: `1px solid ${BORDER}`, borderRadius: 8 }}>
                                    <div style={{ flex: 1 }}>
                                      <div style={{ fontSize: 12, fontWeight: 700, color: TEXT1 }}>{e.name}</div>
                                      {e.note && <div style={{ fontSize: 10, color: TEXT2, marginTop: 2 }}>{e.note}</div>}
                                    </div>
                                    <div style={{ textAlign: "right", flexShrink: 0, marginLeft: 12 }}>
                                      <div style={{ fontSize: 12, fontWeight: 800, color: TEXT1 }}>{fmt$(e.costLow)}–{fmt$(e.costHigh)}</div>
                                      <div style={{ fontSize: 10, fontWeight: 700, color: urgencyColor }}>{urgencyLabel}</div>
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        )}

                        {/* Upcoming service */}
                        {mi?.namedUpcoming?.length > 0 && (
                          <div>
                            <div style={{ fontSize: 10, fontWeight: 800, color: TEXT3, letterSpacing: "0.08em", marginBottom: 8 }}>📅 UPCOMING SERVICES</div>
                            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                              {mi.namedUpcoming.map((s: any, si: number) => (
                                <div key={si} style={{ padding: "5px 10px", background: "#EFF6FF", border: "1px solid #BFDBFE", borderRadius: 8, fontSize: 11 }}>
                                  <span style={{ fontWeight: 700, color: "#1D4ED8" }}>{s.name}</span>
                                  {s.dueMileage && <span style={{ color: TEXT3 }}> @ {s.dueMileage.toLocaleString()}mi</span>}
                                  {s.estimatedCost && <span style={{ color: TEXT2, fontWeight: 600 }}> · {fmt$(s.estimatedCost)}</span>}
                                </div>
                              ))}
                            </div>
                          </div>
                        )}

                        {/* Good / Bad buy personas */}
                        {(mi?.goodBuyIf?.length > 0 || mi?.badBuyIf?.length > 0) && (
                          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                            <div>
                              <div style={{ fontSize: 10, fontWeight: 800, color: GREEN, letterSpacing: "0.08em", marginBottom: 6 }}>✓ BUY IF YOU…</div>
                              {(mi.goodBuyIf || []).map((g: string, gi: number) => (
                                <div key={gi} style={{ fontSize: 11, color: TEXT2, lineHeight: 1.5, paddingLeft: 10, borderLeft: `2px solid #86EFAC`, marginBottom: 4 }}>{g}</div>
                              ))}
                            </div>
                            <div>
                              <div style={{ fontSize: 10, fontWeight: 800, color: RED, letterSpacing: "0.08em", marginBottom: 6 }}>✕ AVOID IF YOU…</div>
                              {(mi.badBuyIf || []).map((b: string, bi: number) => (
                                <div key={bi} style={{ fontSize: 11, color: TEXT2, lineHeight: 1.5, paddingLeft: 10, borderLeft: `2px solid #FECACA`, marginBottom: 4 }}>{b}</div>
                              ))}
                            </div>
                          </div>
                        )}

                        {/* Ownership outlook */}
                        {mi?.ownershipOutlook && (
                          <div style={{ padding: "10px 14px", background: SURFACE2, border: `1px solid ${BORDER}`, borderRadius: 10 }}>
                            <div style={{ fontSize: 10, fontWeight: 800, color: TEXT3, letterSpacing: "0.08em", marginBottom: 4 }}>12–18 MONTH OUTLOOK</div>
                            <div style={{ fontSize: 12, color: TEXT2, lineHeight: 1.5 }}>{mi.ownershipOutlook}</div>
                          </div>
                        )}

                        {/* Re-audit button */}
                        {(() => {
                          const carFileIdx = (c as any).fileIndex ?? i;
                          const isRunning  = reauditLoading[carFileIdx];
                          const progress   = reauditProgress[carFileIdx];
                          const hasVaultPdfs = vaultFiles.some(f => {
                            const vinMatch = f.name.match(/\b([A-HJ-NPR-Z0-9]{17})\b/i)?.[1]?.toUpperCase();
                            const carVin   = (comparison?.auditSummaries?.[carFileIdx] as any)?.auditResult?.vehicle?.vin?.toUpperCase();
                            return (vinMatch && carVin && vinMatch === carVin) || vaultMatches[f.name] === name;
                          });
                          return (
                            <div style={{ marginTop: 4 }}>
                              <button
                                onClick={() => runReaudit(carFileIdx)}
                                disabled={isRunning}
                                style={{
                                  width: "100%", padding: "8px 14px",
                                  background: isRunning ? SURFACE2 : "#0F172A",
                                  border: `1px solid ${isRunning ? BORDER : "#334155"}`,
                                  borderRadius: 8, cursor: isRunning ? "default" : "pointer",
                                  color: isRunning ? TEXT3 : "#F8FAFC",
                                  fontSize: 12, fontWeight: 700,
                                  display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
                                }}
                              >
                                {isRunning ? (
                                  <><span style={{ animation: "pulse 1s infinite", display: "inline-block" }}>⟳</span> {progress || "Re-auditing..."}</>
                                ) : (
                                  <>🔄 Re-audit{hasVaultPdfs ? " with Vault docs" : ""}</>
                                )}
                              </button>
                            </div>
                          );
                        })()}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>

      {/* --- Vault Drawer --- */}
      {vaultOpen && (
        <div style={{
          position: "fixed", inset: 0, zIndex: 1000,
          display: "flex", alignItems: "stretch", justifyContent: "flex-end",
        }}>
          {/* Backdrop */}
          <div onClick={() => setVaultOpen(false)}
            style={{ flex: 1, background: "rgba(15,23,42,0.45)", backdropFilter: "blur(2px)" }} />
          {/* Panel */}
          <div style={{
            width: isMobile ? "100vw" : 400,
            background: SURFACE, boxShadow: "-8px 0 40px rgba(0,0,0,0.15)",
            display: "flex", flexDirection: "column",
            animation: "fadeIn 0.2s ease",
          }}>
            <div style={{ padding: "20px 24px", borderBottom: `1px solid ${BORDER}`, display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 800, color: TEXT1 }}>📁 Document Vault</div>
                <div style={{ fontSize: 11, color: TEXT3, marginTop: 2 }}>Drop Carfax & service records — we'll match them to your cars.</div>
              </div>
              <button onClick={() => setVaultOpen(false)}
                style={{ background: "none", border: "none", color: TEXT3, fontSize: 20, cursor: "pointer", lineHeight: 1 }}>×</button>
            </div>
            {/* Drop zone */}
            <div
              onDragOver={e => e.preventDefault()}
              onDrop={e => {
                e.preventDefault();
                const newFiles = Array.from(e.dataTransfer.files).filter(f => f.name.endsWith(".pdf"));
                setVaultFiles(prev => [...prev, ...newFiles]);
              }}
              onClick={() => vaultInputRef.current?.click()}
              style={{
                margin: "20px 24px 0",
                border: `2px dashed ${BORDER}`, borderRadius: 12,
                padding: "28px 20px", textAlign: "center", cursor: "pointer",
                background: SURFACE2,
              }}>
              <div style={{ fontSize: 24, marginBottom: 6 }}>📄</div>
              <div style={{ fontSize: 13, fontWeight: 700, color: TEXT2, marginBottom: 2 }}>Drop PDFs here or click to browse</div>
              <div style={{ fontSize: 11, color: TEXT3 }}>Carfax, AutoCheck, dealer service records</div>
              <input ref={vaultInputRef} type="file" accept=".pdf" multiple hidden
                onChange={e => setVaultFiles(prev => [...prev, ...Array.from(e.target.files ?? [])])} />
            </div>
            {/* File list */}
            <div style={{ flex: 1, overflowY: "auto", padding: "12px 24px 20px" }}>
              {vaultFiles.length === 0 ? (
                <div style={{ textAlign: "center", color: TEXT3, fontSize: 12, marginTop: 24 }}>No documents uploaded yet</div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {vaultFiles.map((f, fi) => {
                    const vinMatch = f.name.match(/\b([A-HJ-NPR-Z0-9]{17})\b/i)?.[1]?.toUpperCase();
                    const autoMatch = cars.find((c: any) => {
                      const auditVin = (comparison?.auditSummaries?.[c.fileIndex] as any)?.auditResult?.vehicle?.vin;
                      return auditVin && vinMatch && auditVin.toUpperCase() === vinMatch;
                    }) as any;
                    return (
                      <div key={fi} style={{ padding: "10px 12px", background: SURFACE2, border: `1px solid ${BORDER}`, borderRadius: 10 }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
                          <div style={{ flex: 1 }}>
                            <div style={{ fontSize: 12, fontWeight: 700, color: TEXT1, marginBottom: 2, wordBreak: "break-word" }}>{f.name}</div>
                            {vinMatch && <div style={{ fontSize: 10, color: TEXT3 }}>VIN detected: {vinMatch}</div>}
                            {autoMatch && <div style={{ fontSize: 11, color: GREEN, fontWeight: 600, marginTop: 2 }}>✓ Matched to {autoMatch.vehicleName}</div>}
                          </div>
                          <button onClick={() => setVaultFiles(prev => prev.filter((_, i) => i !== fi))}
                            style={{ background: "none", border: "none", color: TEXT3, cursor: "pointer", fontSize: 14, padding: 2, flexShrink: 0 }}>✕</button>
                        </div>
                        {!autoMatch && (
                          <div style={{ marginTop: 8 }}>
                            <div style={{ fontSize: 10, color: TEXT3, marginBottom: 4 }}>Assign to car:</div>
                            <select
                              value={vaultMatches[f.name] ?? ""}
                              onChange={e => setVaultMatches(prev => ({ ...prev, [f.name]: e.target.value }))}
                              style={{ width: "100%", padding: "4px 8px", borderRadius: 6, border: `1px solid ${BORDER}`, fontSize: 11, background: SURFACE, color: TEXT1 }}>
                              <option value="">— Select car —</option>
                              {cars.map((c: any, ci: number) => (
                                <option key={ci} value={c.vehicleName}>{c.vehicleName || `Car ${ci + 1}`}</option>
                              ))}
                            </select>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* CHAT FAB + DRAWER */}
      {comparison && cars.length > 0 && (
        <button
          onClick={() => setChatOpen(o => !o)}
          style={{
            position: "fixed", bottom: 28, right: 28, zIndex: 900,
            width: 56, height: 56, borderRadius: "50%",
            background: ACCENT, border: "none", cursor: "pointer",
            display: "flex", alignItems: "center", justifyContent: "center",
            boxShadow: "0 4px 20px rgba(79,70,229,0.5)",
            fontSize: 22, color: "#fff",
            transition: "transform 0.2s, box-shadow 0.2s",
          }}
          title="Ask WrenchCheck"
        >
          {chatOpen ? "✕" : "💬"}
        </button>
      )}

      {chatOpen && comparison && (
        <div style={{
          position: "fixed", bottom: 96, right: isMobile ? 0 : 28, zIndex: 899,
          width: isMobile ? "100vw" : 420,
          height: isMobile ? "70vh" : 540,
          background: SURFACE, borderRadius: isMobile ? "20px 20px 0 0" : 20,
          boxShadow: "0 -4px 40px rgba(0,0,0,0.18)",
          border: `1px solid ${BORDER}`,
          display: "flex", flexDirection: "column",
          animation: "fadeIn 0.2s ease",
          overflow: "hidden",
        }}>
          {/* Header */}
          <div style={{ padding: "14px 18px", borderBottom: `1px solid ${BORDER}`, background: "#0F172A", flexShrink: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 800, color: "#F8FAFC" }}>Ask WrenchCheck</div>
            <div style={{ fontSize: 11, color: "#94A3B8", marginTop: 1 }}>Full context on all {cars.length} cars</div>
          </div>
          {/* Quick prompts */}
          {chatHistory.length === 0 && (
            <div style={{ padding: "10px 12px", borderBottom: `1px solid ${BORDER}`, display: "flex", gap: 6, flexWrap: "wrap", flexShrink: 0, background: SURFACE2 }}>
              {[
                "Why did you pick the winner?",
                "Draft a negotiation email",
                "Compare the top 2 head-to-head",
                "What's my biggest risk?",
                "5-year cost breakdown",
              ].map((q, qi) => (
                <button key={qi} onClick={() => sendChat(q)}
                  style={{
                    background: SURFACE, border: `1px solid ${BORDER}`, borderRadius: 20,
                    color: TEXT2, fontSize: 11, fontWeight: 600, cursor: "pointer",
                    padding: "5px 12px",
                  }}>
                  {q}
                </button>
              ))}
            </div>
          )}
          {/* Messages */}
          <div style={{ flex: 1, overflowY: "auto", padding: "14px", display: "flex", flexDirection: "column", gap: 10 }}>
            {chatHistory.length === 0 && (
              <div style={{ textAlign: "center", color: TEXT3, fontSize: 12, marginTop: 40 }}>
                <div style={{ fontSize: 32, marginBottom: 8 }}>🔧</div>
                I have full context on all {cars.length} cars. Ask me anything.
              </div>
            )}
            {chatHistory.map((msg, mi) => (
              <div key={mi} style={{ display: "flex", justifyContent: msg.role === "user" ? "flex-end" : "flex-start" }}>
                <div style={{
                  maxWidth: "85%", padding: "9px 13px",
                  borderRadius: msg.role === "user" ? "16px 16px 4px 16px" : "16px 16px 16px 4px",
                  background: msg.role === "user" ? ACCENT : SURFACE2,
                  color: msg.role === "user" ? "#fff" : TEXT1,
                  fontSize: 13, lineHeight: 1.55,
                  border: msg.role === "assistant" ? `1px solid ${BORDER}` : "none",
                }}>
                  {msg.content || (msg.streaming ? "●●●" : "…")}
                </div>
              </div>
            ))}
            <div ref={chatEndRef} />
          </div>
          {/* Input */}
          <div style={{ padding: "10px 12px", borderTop: `1px solid ${BORDER}`, display: "flex", gap: 8, flexShrink: 0 }}>
            <input
              value={chatInput}
              onChange={e => setChatInput(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendChat(chatInput); } }}
              placeholder="Ask anything about these cars…"
              disabled={chatLoading}
              style={{
                flex: 1, padding: "9px 14px", borderRadius: 20,
                border: `1px solid ${BORDER}`, fontSize: 13,
                background: SURFACE2, color: TEXT1, outline: "none",
              }}
            />
            <button onClick={() => sendChat(chatInput)} disabled={chatLoading || !chatInput.trim()}
              style={{
                width: 38, height: 38, borderRadius: "50%", border: "none",
                background: chatLoading || !chatInput.trim() ? SURFACE2 : ACCENT,
                color: chatLoading || !chatInput.trim() ? TEXT3 : "#fff",
                cursor: chatLoading || !chatInput.trim() ? "default" : "pointer",
                fontSize: 16, display: "flex", alignItems: "center", justifyContent: "center",
                flexShrink: 0,
              }}>
              ↑
            </button>
          </div>
        </div>
      )}
    </>
  );
}
