"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  AlertTriangle, CheckCircle, ChevronDown, ChevronUp,
  Copy, Check, ArrowLeft, Shield, Send, Clock, Info,
  TrendingDown, DollarSign, Tag,
} from "lucide-react";
import type { MaintenanceDebtAuditResult, MaintenanceDebtItem } from "@/lib/maintenanceDebt/types";
import type { BuyingAdvisorResponse } from "@/lib/buyingAdvisor/types";
import { buildPrioritySummary, debtItemsToServiceInputs, type PriorityOutput } from "@/lib/prioritization/buildPrioritySummary";
import { computeNegotiationLeverage } from "@/lib/buyingAdvisor/computeNegotiationLeverage";

// ─── Types ────────────────────────────────────────────────────────────────────

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  chips?: string[];
  isDoneSignal?: boolean;
}

type DealQuality = "great_deal" | "good_deal" | "fair_deal" | "overpriced" | "unknown";

// ─── Verdict config ───────────────────────────────────────────────────────────

interface VerdictCfg {
  label: string; tagline: string; color: string; bg: string; border: string;
  icon: React.ElementType;
}

const VERDICT_CONFIG: Record<string, VerdictCfg> = {
  strong_buy:      { label: "Strong Buy — Go For It",       tagline: "Maintenance looks solid. Confirm the details, then make your offer.",                    color: "#16A34A", bg: "rgba(22,163,74,0.08)",    border: "rgba(22,163,74,0.25)",   icon: CheckCircle },
  reasonable_buy:  { label: "Good Buy If Priced Right",     tagline: "Some catch-up expected. Factor the cost into your offer and negotiate.",              color: "#D97706", bg: "rgba(245,158,11,0.08)",  border: "rgba(245,158,11,0.25)", icon: Clock },
  proceed_caution: { label: "Negotiate Before Committing",  tagline: "Several items need verification. Price should reflect the condition risk.",          color: "#C2410C", bg: "rgba(194,65,12,0.08)",  border: "rgba(194,65,12,0.25)", icon: AlertTriangle },
  high_risk:       { label: "Walk Away Or Negotiate Hard",  tagline: "Confirmed gaps create real risk. Only proceed if priced significantly below market.",  color: "#DC2626", bg: "rgba(220,38,38,0.08)",   border: "rgba(220,38,38,0.28)",  icon: Shield },
  walk_away:       { label: "Walk Away",                    tagline: "Clear red flags. This deal carries serious risk regardless of price.",                  color: "#7F1D1D", bg: "rgba(127,29,29,0.10)",  border: "rgba(127,29,29,0.30)",  icon: Shield },
  incomplete:      { label: "Verify Before Deciding",       tagline: "Not enough data to assess condition. Get a CARFAX or pre-purchase inspection.",        color: "#7C3AED", bg: "rgba(167,139,250,0.12)", border: "rgba(167,139,250,0.35)", icon: Info },
  // Legacy aliases
  clean:                 { label: "Strong Buy — Go For It",      tagline: "Maintenance looks solid. Confirm the details, then make your offer.",         color: "#16A34A", bg: "rgba(22,163,74,0.08)",    border: "rgba(22,163,74,0.25)",   icon: CheckCircle },
  light_catch_up:        { label: "Good Buy If Priced Right",    tagline: "Some catch-up expected. Factor the cost into your offer and negotiate.",      color: "#D97706", bg: "rgba(245,158,11,0.08)",  border: "rgba(245,158,11,0.25)", icon: Clock },
  maintenance_debt_risk: { label: "Negotiate Before Committing", tagline: "Several items need verification. Price should reflect the condition risk.",  color: "#C2410C", bg: "rgba(194,65,12,0.08)",  border: "rgba(194,65,12,0.25)", icon: AlertTriangle },
};

// ─── Deal quality config ──────────────────────────────────────────────────────

const DEAL_QUALITY_CONFIG: Record<DealQuality, { label: string; color: string; bg: string }> = {
  great_deal: { label: "Great Deal",  color: "#16A34A", bg: "rgba(22,163,74,0.10)" },
  good_deal:  { label: "Good Deal",   color: "#D97706", bg: "rgba(245,158,11,0.10)" },
  fair_deal:  { label: "Fair Price",  color: "#64748B", bg: "rgba(100,116,139,0.10)" },
  overpriced: { label: "Overpriced",  color: "#DC2626", bg: "rgba(220,38,38,0.10)" },
  unknown:    { label: "Enter Price", color: "#94A3B8", bg: "rgba(148,163,184,0.08)" },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getItemLabel(item: MaintenanceDebtItem, isAiEstimated: boolean): string {
  if (item.evidenceFound) return "Documented";
  if (item.status === "done") return "Completed";
  if (isAiEstimated) return item.severity === "high" ? "Verify" : "Undocumented";
  if (item.status === "overdue") return "Overdue";
  return "Due Now";
}

function getItemLabelStyle(item: MaintenanceDebtItem, isAiEstimated: boolean): { color: string; bg: string } {
  if (item.evidenceFound) return { color: "#16A34A", bg: "rgba(22,163,74,0.12)" };
  if (isAiEstimated) {
    return item.severity === "high"
      ? { color: "#D97706", bg: "rgba(245,158,11,0.12)" }
      : { color: "#94A3B8", bg: "rgba(148,163,184,0.12)" };
  }
  return item.status === "overdue"
    ? { color: "#DC2626", bg: "rgba(220,38,38,0.12)" }
    : { color: "#FB923C", bg: "rgba(251,146,60,0.12)" };
}

function getTopItems(result: MaintenanceDebtAuditResult, limit = 4): MaintenanceDebtItem[] {
  return [...result.debtItems]
    .filter((i) => i.status === "overdue" || i.status === "due_now")
    .sort((a, b) => {
      const s = { high: 3, medium: 2, low: 1 };
      return (s[b.severity] ?? 1) * 1000 + (b.estimatedCostHigh ?? 0)
           - (s[a.severity] ?? 1) * 1000 - (a.estimatedCostHigh ?? 0);
    })
    .slice(0, limit);
}

function buildNegotiationPitch(r: MaintenanceDebtAuditResult): string {
  const items = [...r.debtItems]
    .filter((i) => (i.status === "overdue" || i.status === "due_now") && !i.evidenceFound)
    .sort((a, b) => (b.estimatedCostHigh ?? 0) - (a.estimatedCostHigh ?? 0))
    .slice(0, 3);
  if (!items.length) return "No significant undocumented maintenance gaps found.";
  const vehicle = [r.vehicle.year, r.vehicle.make, r.vehicle.model].filter(Boolean).join(" ") || "this vehicle";
  const mileage = r.vehicle.currentMileage?.toLocaleString();
  const names = items.map((i) => i.displayName);
  const nameStr = names.length === 1 ? names[0] : names.length === 2 ? `${names[0]} and ${names[1]}` : `${names[0]}, ${names[1]}, and ${names[2]}`;
  const low = Math.round((r.debtEstimateLow ?? 200) / 50) * 50;
  const high = Math.round((r.debtEstimateHigh ?? low) / 50) * 50;
  const ask = Math.round(((low + high) / 2) / 100) * 100;
  return `The service records for this ${vehicle} don't show ${nameStr} being serviced${mileage ? ` by ${mileage} miles` : ""}. These services typically cost $${low.toLocaleString()}–$${high.toLocaleString()} to address. I'd like to reduce the asking price by $${ask.toLocaleString()} to account for this deferred maintenance.`;
}

function computeDealQuality(
  askingPrice: number,
  marketLow: number,
  marketHigh: number,
  maintenanceMid: number
): DealQuality {
  const effectiveCost = askingPrice + maintenanceMid;
  const marketMid = (marketLow + marketHigh) / 2;
  const ratio = effectiveCost / marketMid;
  if (ratio < 0.88) return "great_deal";
  if (ratio < 0.97) return "good_deal";
  if (ratio <= 1.06) return "fair_deal";
  return "overpriced";
}

function getConfidenceNote(r: MaintenanceDebtAuditResult): string {
  const n = r.normalizedHistory?.length ?? 0;
  if (r.scheduleSource === "vehicle_databases") return `VIN-matched OEM schedule · ${n} service events recorded`;
  if (r.scheduleSource === "ai_estimated") return `AI-estimated schedule · ${n} events found · undocumented ≠ confirmed overdue`;
  return "";
}

// ─── Adaptive mode badge ──────────────────────────────────────────────────────

function getAdaptiveMode(r: MaintenanceDebtAuditResult): { label: string; sublabel: string; color: string; bg: string; border: string } {
  // Future: if (r.ppiFindings?.length) return { label: "Inspection Report", sublabel: "Confirmed findings · Highest confidence", color: "#16A34A", bg: "rgba(22,163,74,0.08)", border: "rgba(22,163,74,0.25)" };
  if (r.scheduleSource === "vehicle_databases") {
    return { label: "CARFAX + OEM Schedule", sublabel: "VIN-matched · High confidence", color: "#0369A1", bg: "rgba(3,105,161,0.07)", border: "rgba(3,105,161,0.2)" };
  }
  if (r.scheduleSource === "ai_estimated") {
    return { label: "CARFAX Only", sublabel: "AI-estimated schedule · Inferred, not confirmed", color: "#B45309", bg: "rgba(180,83,9,0.07)", border: "rgba(180,83,9,0.2)" };
  }
  return { label: "General Guidance", sublabel: "No service history · Watchouts + OEM only", color: "#6B7280", bg: "rgba(107,114,128,0.07)", border: "rgba(107,114,128,0.2)" };
}

// ─── Done condition ────────────────────────────────────────────────────────────

function getDoneCondition(verdict: string, topItems: MaintenanceDebtItem[]): string {
  const topName = topItems[0]?.displayName;
  switch (verdict) {
    case "strong_buy":   case "clean":
      return "You have enough to make an offer. No critical undocumented gaps detected.";
    case "reasonable_buy": case "light_catch_up":
      return topName
        ? `You're ready to negotiate. Ask the seller to document ${topName} — then adjust your offer by the catch-up cost.`
        : "You're ready to negotiate. Use the catch-up cost to adjust your offer.";
    case "proceed_caution": case "maintenance_debt_risk":
      return topName
        ? `Get clarity on ${topName} before committing. Ask for documentation or a price reduction.`
        : "Get clarity on the flagged items above before committing.";
    case "high_risk":
      return "Request a pre-purchase inspection (PPI) before making any offer. The risk isn't fully quantified yet.";
    case "incomplete":
      return "Get a CARFAX report or enter the VIN to complete this assessment.";
    default:
      return "Review the key items above and use the advisor for a personalized recommendation.";
  }
}

// ─── Explicit next step ────────────────────────────────────────────────────────

function getNextStep(verdict: string, dealQuality: DealQuality, topItems: MaintenanceDebtItem[], askingPrice: number | null, conditionDebt: number): string {
  const savings = conditionDebt > 0 ? `~$${(Math.round(conditionDebt / 100) * 100).toLocaleString()}` : "";
  const top = topItems[0]?.displayName;
  switch (verdict) {
    case "strong_buy": case "clean":
      if (askingPrice && dealQuality !== "overpriced") return `Make an offer at or near $${askingPrice.toLocaleString()}`;
      return "Enter the asking price above to confirm the deal makes sense";
    case "reasonable_buy": case "light_catch_up":
      return savings ? `Counter-offer ${savings} lower using the maintenance gaps as leverage` : "Use the catch-up cost estimate as your negotiation anchor";
    case "proceed_caution": case "maintenance_debt_risk":
      return top ? `Ask the seller to document ${top} or reduce the price accordingly` : "Request documentation for the flagged services or negotiate a price reduction";
    case "high_risk":
      return "Request a pre-purchase inspection (PPI) before making any offer";
    case "incomplete":
      return "Get a CARFAX report or enter the VIN to complete this assessment";
    default:
      return "Use the chat below to get a personalized recommendation";
  }
}

// ─── CopyButton ───────────────────────────────────────────────────────────────

function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => { navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 2000); }}
      style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 12, fontWeight: 500, color: copied ? "#16A34A" : "#64748B", background: "none", border: `1px solid ${copied ? "rgba(22,163,74,0.35)" : "#E2E8F0"}`, cursor: "pointer", padding: "5px 10px", borderRadius: 8, transition: "all 0.15s" }}
    >
      {copied ? <Check size={12} /> : <Copy size={12} />}
      {copied ? "Copied!" : label}
    </button>
  );
}

// ─── Typing indicator ─────────────────────────────────────────────────────────

function TypingDots() {
  return (
    <div style={{ display: "flex", gap: 4, padding: "4px 0", alignItems: "center" }}>
      {[0, 1, 2].map((i) => (
        <div key={i} style={{
          width: 7, height: 7, borderRadius: "50%", background: "#CBD5E1",
          animation: `wrenchDot 1.2s ease-in-out ${i * 0.2}s infinite`,
        }} />
      ))}
      <style>{`@keyframes wrenchDot { 0%,100%{opacity:.3;transform:translateY(0)} 50%{opacity:1;transform:translateY(-3px)} }`}</style>
    </div>
  );
}

// ─── Decision Card helpers ────────────────────────────────────────────────────

function getCardAction(item: MaintenanceDebtItem, isAiEstimated: boolean): { label: string; color: string; bg: string } {
  if (item.severity === "high" && !isAiEstimated && (item.status === "overdue" || item.status === "due_now"))
    return { label: "Do This Now", color: "#DC2626", bg: "rgba(220,38,38,0.08)" };
  if (isAiEstimated || item.severity === "medium")
    return { label: "Ask Seller", color: "#D97706", bg: "rgba(245,158,11,0.08)" };
  return { label: "Monitor", color: "#6366F1", bg: "rgba(99,102,241,0.08)" };
}

function buildItemScript(item: MaintenanceDebtItem, vehicle: string, isAiEstimated: boolean): string {
  const lo = item.estimatedCostLow ?? 0;
  const hi = item.estimatedCostHigh ?? lo;
  const mid = Math.round((lo + hi) / 2 / 50) * 50;
  if (isAiEstimated) {
    return `I noticed there’s no record of ${item.displayName} in the service history for this ${vehicle}. Could you share documentation, or would you consider adjusting the price to reflect this?`;
  }
  const costStr = lo > 0 ? ` This typically runs $${lo.toLocaleString()}–$${hi.toLocaleString()}.` : "";
  const askStr = mid > 0 ? ` I’d like to adjust the price by ~$${mid.toLocaleString()} to account for this.` : "";
  return `The service records for this ${vehicle} don’t show ${item.displayName} being completed.${costStr}${askStr}`;
}

interface DecisionCardProps {
  item: MaintenanceDebtItem;
  vehicle: string;
  isAiEstimated: boolean;
  onAskAdvisor: (q: string) => void;
}

function DecisionCard({ item, vehicle, isAiEstimated, onAskAdvisor }: DecisionCardProps) {
  const [copied, setCopied] = useState(false);
  const action = getCardAction(item, isAiEstimated);
  const lStyle = getItemLabelStyle(item, isAiEstimated);
  const lLabel = getItemLabel(item, isAiEstimated);
  const script = buildItemScript(item, vehicle, isAiEstimated);
  const cost = item.estimatedCostLow != null
    ? `$${item.estimatedCostLow.toLocaleString()}–$${(item.estimatedCostHigh ?? item.estimatedCostLow).toLocaleString()}`
    : null;

  return (
    <div style={{ background: "#fff", border: "1px solid #E2E8F0", borderRadius: 14, padding: "18px 20px", display: "flex", flexDirection: "column", gap: 10 }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
        <div style={{ flex: 1 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 4, flexWrap: "wrap" }}>
            <span style={{ fontSize: 10, fontWeight: 700, color: lStyle.color, background: lStyle.bg, padding: "2px 7px", borderRadius: 5 }}>{lLabel}</span>
            {item.severity === "high" && !isAiEstimated && (
              <span style={{ fontSize: 10, fontWeight: 700, color: "#DC2626", letterSpacing: "0.04em" }}>⚡ HIGH PRIORITY</span>
            )}
          </div>
          <div style={{ fontSize: 15, fontWeight: 700, color: "#0F172A", lineHeight: 1.3 }}>{item.displayName}</div>
          {cost && <div style={{ fontSize: 12, color: "#64748B", marginTop: 3 }}>{cost} estimated</div>}
        </div>
        <span style={{ fontSize: 11, fontWeight: 700, color: action.color, background: action.bg, border: `1px solid ${action.color}33`, padding: "4px 10px", borderRadius: 20, whiteSpace: "nowrap", flexShrink: 0 }}>
          {action.label}
        </span>
      </div>

      {/* Quick take */}
      <div style={{ fontSize: 13, color: "#475569", lineHeight: 1.6 }}>{item.reasoning}</div>

      {/* Script */}
      <div style={{ background: "#F8FAFC", border: "1px solid #E2E8F0", borderRadius: 8, padding: "10px 12px" }}>
        <div style={{ fontSize: 10, fontWeight: 700, color: "#94A3B8", letterSpacing: "0.07em", marginBottom: 5 }}>SCRIPT — COPY &amp; SEND TO SELLER</div>
        <p style={{ fontSize: 12, color: "#374151", lineHeight: 1.65, margin: 0, fontStyle: "italic" }}>“{script}”</p>
      </div>

      {/* Actions */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button
          onClick={() => { navigator.clipboard.writeText(script); setCopied(true); setTimeout(() => setCopied(false), 2000); }}
          style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 12, fontWeight: 500, color: copied ? "#16A34A" : "#64748B", background: "none", border: `1px solid ${copied ? "rgba(22,163,74,0.35)" : "#E2E8F0"}`, cursor: "pointer", padding: "5px 10px", borderRadius: 8, transition: "all 0.15s" }}
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
          {copied ? "Copied!" : "Copy script"}
        </button>
        <button
          onClick={() => onAskAdvisor(`Tell me more about ${item.displayName} on this vehicle — how concerned should I be and how does it affect my decision?`)}
          style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 12, fontWeight: 500, color: "#6366F1", background: "rgba(99,102,241,0.06)", border: "1px solid rgba(99,102,241,0.2)", cursor: "pointer", padding: "5px 10px", borderRadius: 8, transition: "all 0.15s" }}
        >
          <Send size={11} /> Ask advisor
        </button>
      </div>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function MaintenanceAuditPage() {
  const { id } = useParams();
  const caseId = id as string;
  const router = useRouter();

  // Core data
  const [result, setResult] = useState<MaintenanceDebtAuditResult | null>(null);
  const [loading, setLoading] = useState(true);

  // Chat
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [chatLoading, setChatLoading] = useState(true);
  const [chatPhase, setChatPhase] = useState<BuyingAdvisorResponse["phase"] | null>(null);
  const [chatCollapsed, setChatCollapsed] = useState(false);
  const [activeChips, setActiveChips] = useState<string[]>([
    "Would you buy this car?", "How much should I negotiate?", "What should I ask the seller?",
  ]);

  // UI state
  const [breakdownOpen, setBreakdownOpen] = useState(false);
  const [whatMattersExpanded, setWhatMattersExpanded] = useState<string | null>(null);
  const [completedOpen, setCompletedOpen] = useState(false);
  const [priorityOutput, setPriorityOutput] = useState<PriorityOutput | null>(null);
  const [vehicleWatchouts, setVehicleWatchouts] = useState<any[]>([]);

  // Price + deal quality
  const [askingPriceInput, setAskingPriceInput] = useState("");
  const [askingPrice, setAskingPrice] = useState<number | null>(null);

  // Market estimate — fetched client-side (non-blocking, never delays audit)
  const [marketEstimate, setMarketEstimate] = useState<{ low: number; high: number; confidence: string } | null>(null);
  const [marketLoading, setMarketLoading] = useState(false);

  const chatEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // ── Load result ─────────────────────────────────────────────────────────────
  useEffect(() => {
    try {
      const stored = sessionStorage.getItem("maintenance_audit_result");
      if (stored) {
        const parsed: MaintenanceDebtAuditResult = JSON.parse(stored);
        setResult(parsed);
        const inputs = debtItemsToServiceInputs(parsed.debtItems);
        setPriorityOutput(buildPrioritySummary(inputs, null, {
          vehicleAgeYears: parsed.vehicle.year ? new Date().getFullYear() - parsed.vehicle.year : undefined,
          mileage: parsed.vehicle.currentMileage ?? undefined,
        }));
        const label = [parsed.vehicle.year, parsed.vehicle.make, parsed.vehicle.model].filter(Boolean).join(" ");
        if (label.trim()) {
          fetch("/api/vehicle-watchouts", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ vehicle: label, services: parsed.debtItems.map((i) => i.displayName), mileage: parsed.vehicle.currentMileage ?? null }),
          }).then((r) => r.json()).then((data) => { if (data?.watchOuts) setVehicleWatchouts(data.watchOuts); }).catch(() => {});
        }
      }
    } catch { /* ignore */ }
    setLoading(false);
  }, []);

  // ── Boot advisor chat ────────────────────────────────────────────────────────
  useEffect(() => {
    if (!result || chatMessages.length > 0) return;
    const leverage = computeNegotiationLeverage(result);
    const topItems = priorityOutput?.topItems.map((t) => ({ canonicalService: t.canonicalService, displayName: t.displayName, reason: t.reason, severity: "medium" as const, priority: t.priority })) ?? [];
    const ctx = {
      vehicle: result.vehicle,
      maintenanceDebtEstimate: { low: result.debtEstimateLow, high: result.debtEstimateHigh },
      verdict: result.verdict, topPriorityItems: topItems,
      missingOrOverdueItems: result.debtItems.filter((i) => i.status === "overdue" || i.status === "due_now").map((i) => ({ displayName: i.displayName, reasoning: i.reasoning, estimatedCostLow: i.estimatedCostLow, estimatedCostHigh: i.estimatedCostHigh, severity: i.severity })),
      vehicleWatchouts: vehicleWatchouts.map((w) => ({ issue: w.title ?? "", severity: (w.severity ?? "").toLowerCase().includes("high") ? "high" as const : "medium" as const, description: w.description ?? "", relatedServices: w.relatedCanonicalServices ?? [], relevance: w.negotiationRelevance ?? "medium", evidenceStatus: w.evidenceStatus ?? "ambiguous" })),
      negotiationLeverage: leverage, conversation: [],
    };
    fetch("/api/buying-advisor-chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ context: ctx }) })
      .then((r) => r.json())
      .then((data: BuyingAdvisorResponse) => {
        const reply = (data as any).reply ?? "I've reviewed this vehicle. Ask me anything about this purchase.";
        setChatMessages([{ role: "assistant", content: reply, chips: activeChips }]);
        if (data.phase) setChatPhase(data.phase);
      })
      .catch(() => setChatMessages([{ role: "assistant", content: "Advisor unavailable. Please try again.", chips: activeChips }]))
      .finally(() => setChatLoading(false));
  }, [result, priorityOutput, vehicleWatchouts]);

  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [chatMessages]);

  // ── Send message ─────────────────────────────────────────────────────────────
  const sendMessage = useCallback(async (overrideText?: string) => {
    const text = (overrideText ?? chatInput).trim();
    if (!text || chatLoading || !result) return;
    setChatInput(""); setActiveChips([]);
    const userMsg: ChatMessage = { role: "user", content: text };
    setChatMessages((prev) => [...prev, userMsg]);
    setChatLoading(true);
    const leverage = computeNegotiationLeverage(result);
    const history = [...chatMessages, userMsg].map((m) => ({ role: m.role, content: m.content }));
    const ctx = {
      vehicle: result.vehicle,
      maintenanceDebtEstimate: { low: result.debtEstimateLow, high: result.debtEstimateHigh },
      verdict: result.verdict,
      topPriorityItems: priorityOutput?.topItems.map((t) => ({ canonicalService: t.canonicalService, displayName: t.displayName, reason: t.reason, severity: "medium" as const, priority: t.priority })) ?? [],
      missingOrOverdueItems: result.debtItems.filter((i) => i.status === "overdue" || i.status === "due_now").map((i) => ({ displayName: i.displayName, reasoning: i.reasoning, estimatedCostLow: i.estimatedCostLow, estimatedCostHigh: i.estimatedCostHigh, severity: i.severity })),
      vehicleWatchouts: vehicleWatchouts.map((w) => ({ issue: w.title ?? "", severity: (w.severity ?? "").toLowerCase().includes("high") ? "high" as const : "medium" as const, description: w.description ?? "", relatedServices: w.relatedCanonicalServices ?? [], relevance: w.negotiationRelevance ?? "medium", evidenceStatus: w.evidenceStatus ?? "ambiguous" })),
      negotiationLeverage: leverage, conversation: history,
    };
    try {
      const res = await fetch("/api/buying-advisor-chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ context: ctx, userMessage: text }) });
      const data: BuyingAdvisorResponse = await res.json();
      const newChips = data.phase === "done"
        ? ["How much should I negotiate?", "What should I say to the seller?"]
        : ["Would you buy this car?", "What should I ask the seller?", "When should I walk away?"];
      if (data.phase) setChatPhase(data.phase);
      setChatMessages((prev) => [...prev, { role: "assistant", content: data.reply ?? "Something went wrong.", chips: newChips, isDoneSignal: data.phase === "done" }]);
      setActiveChips(newChips);
    } catch {
      setChatMessages((prev) => [...prev, { role: "assistant", content: "Advisor unavailable. Please try again." }]);
    } finally { setChatLoading(false); }
  }, [chatLoading, result, chatMessages, priorityOutput, vehicleWatchouts]);

  // ── Fetch market estimate (client-side, non-blocking) ──────────────────────
  useEffect(() => {
    if (!result?.vehicle.year || !result?.vehicle.make || !result?.vehicle.model) return;
    setMarketLoading(true);
    fetch("/api/market-estimate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        year: result.vehicle.year,
        make: result.vehicle.make,
        model: result.vehicle.model,
        trim: result.vehicle.trim,
        mileage: result.vehicle.currentMileage,
      }),
    })
      .then((r) => r.json())
      .then((data) => { if (data.low && data.high) setMarketEstimate(data); })
      .catch(() => {})
      .finally(() => setMarketLoading(false));
  }, [result?.vehicle.year, result?.vehicle.make, result?.vehicle.model]);

  // ── Apply asking price ─────────────────────────────────────────────────
  const applyPrice = () => {
    const n = parseFloat(askingPriceInput.replace(/[^0-9.]/g, ""));
    setAskingPrice(isNaN(n) ? null : n);
  };

  // ── Guards ───────────────────────────────────────────────────────────────────
  if (loading) return (
    <div style={{ minHeight: "100vh", background: "#F8FAFC", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ color: "#475569", fontSize: 14 }}>Loading audit…</div>
    </div>
  );
  if (!result) return (
    <div style={{ minHeight: "100vh", background: "#F8FAFC", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 16, padding: 32 }}>
      <Shield size={40} color="#374151" />
      <div style={{ color: "#475569", fontSize: 15, textAlign: "center" }}>No audit result found. Run a maintenance audit first.</div>
      <button onClick={() => router.push("/")} style={{ fontSize: 13, color: "#4F46E5", background: "none", border: "none", cursor: "pointer", textDecoration: "underline" }}>Back to start</button>
    </div>
  );

  // ── Derived values ────────────────────────────────────────────────────────────
  const verdictCfg = VERDICT_CONFIG[result.verdict] ?? VERDICT_CONFIG.proceed_caution;
  const VerdictIcon = verdictCfg.icon;
  const vehicleLabel = [result.vehicle.year, result.vehicle.make, result.vehicle.model].filter(Boolean).join(" ") || result.vehicle.vin || "Unknown Vehicle";
  const isAiEstimated = result.scheduleSource === "ai_estimated";
  const topItems = getTopItems(result);
  const allOverdue = result.debtItems.filter((i) => i.status === "overdue" || i.status === "due_now");
  const extraCount = Math.max(0, allOverdue.length - topItems.length);
  const decisionItems = topItems.slice(0, 3); // max 3 decision cards
  const pitch = buildNegotiationPitch(result);

  // Card advisor handler — scrolls chat into view and auto-sends
  const handleCardAskAdvisor = useCallback((question: string) => {
    setChatCollapsed(false);
    sendMessage(question);
    setTimeout(() => chatEndRef.current?.scrollIntoView({ behavior: "smooth" }), 150);
  }, [sendMessage]);

  // conditionDebt = maintenance mid for now; when PPI is live, add inspectionFindingsCost
  const maintenanceMid = ((result.debtEstimateLow ?? 0) + (result.debtEstimateHigh ?? result.debtEstimateLow ?? 0)) / 2;
  const conditionDebt = maintenanceMid; // TODO: + inspectionFindingsMid when PPI lands

  // Deal quality: effectiveCost = askingPrice + conditionDebt (per spec)
  const mv = marketEstimate ?? result.marketValueEstimate;
  const effectiveCost = askingPrice != null ? askingPrice + conditionDebt : null;
  const dealQuality: DealQuality = (effectiveCost != null && mv)
    ? computeDealQuality(effectiveCost, mv.low, mv.high, 0) // 0: conditionDebt already included
    : "unknown";
  const dealCfg = DEAL_QUALITY_CONFIG[dealQuality];
  const confidenceNote = getConfidenceNote(result);
  const isLowConfidence = result.confidence === "low" || isAiEstimated;

  return (
    <div style={{ minHeight: "100vh", background: "#F8FAFC", fontFamily: "'Inter', -apple-system, sans-serif", color: "#0F172A" }}>
      <style>{`
        * { box-sizing: border-box; }
        input:focus { outline: none; }
        @keyframes wrenchDot { 0%,100%{opacity:.3;transform:translateY(0)} 50%{opacity:1;transform:translateY(-3px)} }
      `}</style>

      {/* ── Header ───────────────────────────────────────────────────────────── */}
      <header style={{ position: "sticky", top: 0, zIndex: 50, background: "rgba(248,250,252,0.97)", backdropFilter: "blur(12px)", borderBottom: "1px solid #E2E8F0", padding: "12px 24px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <button onClick={() => router.back()} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "#64748B", background: "none", border: "none", cursor: "pointer", padding: "6px 8px", borderRadius: 8 }}>
            <ArrowLeft size={15} /> Back
          </button>
          <div style={{ width: 1, height: 20, background: "#E2E8F0" }} />
          <span style={{ fontSize: 14, fontWeight: 600, color: "#0F172A" }}>{vehicleLabel}</span>
          {result.vehicle.currentMileage && (
            <span style={{ fontSize: 13, color: "#64748B" }}>{result.vehicle.currentMileage.toLocaleString()} mi</span>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 700, letterSpacing: "0.04em", color: verdictCfg.color, background: verdictCfg.bg, border: `1px solid ${verdictCfg.border}`, padding: "5px 12px", borderRadius: 20 }}>
          <VerdictIcon size={13} />
          {verdictCfg.label}
        </div>
      </header>

      {/* ── Main content ──────────────────────────────────────────────────────── */}
      <main style={{ maxWidth: 920, margin: "0 auto", padding: "24px 16px 48px", display: "flex", flexDirection: "column", gap: 16 }}>

        {/* AI-estimated banner */}
        {isAiEstimated && (
          <div style={{ background: "rgba(245,158,11,0.08)", border: "1px solid rgba(245,158,11,0.25)", borderRadius: 10, padding: "10px 16px", fontSize: 13, color: "#92400E", display: "flex", alignItems: "flex-start", gap: 10 }}>
            <Info size={14} style={{ marginTop: 1, flexShrink: 0 }} />
            <span>Results are based on an AI-estimated schedule — some gaps may be due to incomplete records rather than missed maintenance. Verify key items before deciding.</span>
          </div>
        )}

        {/* ── 1. SUMMARY CARD ──────────────────────────────────────────────────── */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1.5fr", gap: 16 }}>

          {/* Verdict column */}
          <div style={{ background: verdictCfg.bg, border: `1px solid ${verdictCfg.border}`, borderRadius: 16, padding: 24, display: "flex", flexDirection: "column", gap: 12 }}>
            {/* Adaptive mode badge */}
            {(() => {
              const mode = getAdaptiveMode(result);
              return (
                <div style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11, fontWeight: 600, color: mode.color, background: mode.bg, border: `1px solid ${mode.border}`, borderRadius: 20, padding: "3px 10px", alignSelf: "flex-start" }}>
                  <div style={{ width: 6, height: 6, borderRadius: "50%", background: mode.color, flexShrink: 0 }} />
                  {mode.label} · {mode.sublabel}
                </div>
              );
            })()}

            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <VerdictIcon size={18} color={verdictCfg.color} />
              <span style={{ fontSize: 17, fontWeight: 700, color: verdictCfg.color }}>{verdictCfg.label}</span>
            </div>
            <p style={{ fontSize: 13, color: "#475569", lineHeight: 1.5, margin: 0 }}>{verdictCfg.tagline}</p>

            {result.debtEstimateLow != null && (
              <div style={{ borderTop: `1px solid ${verdictCfg.border}`, paddingTop: 12 }}>
                <div style={{ fontSize: 26, fontWeight: 800, color: "#0F172A", letterSpacing: "-0.02em" }}>
                  ${result.debtEstimateLow.toLocaleString()}–${(result.debtEstimateHigh ?? result.debtEstimateLow).toLocaleString()}
                </div>
                <div style={{ fontSize: 12, color: "#64748B", marginTop: 3 }}>estimated catch-up cost</div>
              </div>
            )}

            {/* Done condition */}
            <div style={{ borderTop: `1px solid ${verdictCfg.border}`, paddingTop: 12, fontSize: 12, color: "#475569", lineHeight: 1.55 }}>
              <span style={{ fontWeight: 600, color: "#64748B", fontSize: 10, letterSpacing: "0.06em", display: "block", marginBottom: 4 }}>WHEN YOU'RE DONE</span>
              {getDoneCondition(result.verdict, topItems)}
            </div>

            {/* Explicit next step */}
            <div style={{ background: "rgba(255,255,255,0.6)", border: `1px solid ${verdictCfg.border}`, borderRadius: 10, padding: "10px 14px", fontSize: 13, color: "#0F172A", fontWeight: 500, display: "flex", alignItems: "flex-start", gap: 8 }}>
              <span style={{ color: verdictCfg.color, fontWeight: 700, flexShrink: 0 }}>→</span>
              <span>{getNextStep(result.verdict, dealQuality, topItems, askingPrice, conditionDebt)}</span>
            </div>
          </div>

          {/* What Matters column */}
          <div style={{ background: "#fff", border: "1px solid #E2E8F0", borderRadius: 16, padding: 24 }}>
            <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", color: "#94A3B8", marginBottom: 14 }}>WHAT MATTERS</div>
            {topItems.length === 0 ? (
              <div style={{ fontSize: 13, color: "#94A3B8" }}>No high-priority items identified.</div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
                {topItems.map((item, i) => {
                  const lStyle = getItemLabelStyle(item, isAiEstimated);
                  const lLabel = getItemLabel(item, isAiEstimated);
                  const isExpanded = whatMattersExpanded === item.canonicalService;
                  return (
                    <div key={item.canonicalService} style={{ borderBottom: i < topItems.length - 1 ? "1px solid #F1F5F9" : "none", paddingBottom: 12, marginBottom: 12 }}>
                      <div onClick={() => setWhatMattersExpanded(isExpanded ? null : item.canonicalService)} style={{ display: "flex", alignItems: "flex-start", gap: 10, cursor: "pointer" }}>
                        <span style={{ fontSize: 10, fontWeight: 700, color: lStyle.color, background: lStyle.bg, padding: "2px 7px", borderRadius: 5, whiteSpace: "nowrap", marginTop: 2, flexShrink: 0 }}>{lLabel}</span>
                        <span style={{ fontSize: 14, fontWeight: 500, color: "#0F172A", flex: 1 }}>{item.displayName}</span>
                        <span style={{ color: "#CBD5E1", flexShrink: 0, marginTop: 2 }}>{isExpanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}</span>
                      </div>
                      {isExpanded && (
                        <div style={{ marginTop: 8, paddingLeft: 0, fontSize: 13, color: "#64748B", lineHeight: 1.5 }}>
                          {item.reasoning}
                          {item.estimatedCostLow && (
                            <span style={{ display: "inline-block", marginTop: 4, fontSize: 12, fontWeight: 500, color: "#475569" }}>
                              {" "}~${item.estimatedCostLow}–${item.estimatedCostHigh ?? item.estimatedCostLow} est.
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
            {extraCount > 0 && (
              <button onClick={() => setBreakdownOpen(true)} style={{ fontSize: 12, color: "#6366F1", background: "none", border: "none", cursor: "pointer", padding: 0, marginTop: 4 }}>
                +{extraCount} more items · View full breakdown ↓
              </button>
            )}
          </div>
        </div>

        {/* ── 2. DECISION CARDS ─────────────────────────────────────────────── */}
        {decisionItems.length > 0 && (
          <div>
            <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", color: "#94A3B8", marginBottom: 10 }}>DECISION CARDS</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {decisionItems.map((item) => (
                <DecisionCard
                  key={item.canonicalService}
                  item={item}
                  vehicle={vehicleLabel}
                  isAiEstimated={isAiEstimated}
                  onAskAdvisor={handleCardAskAdvisor}
                />
              ))}
            </div>
          </div>
        )}

        {/* ── 3. DEAL QUALITY CARD ─────────────────────────────────────────────── */}
        <div style={{ background: "#fff", border: "1px solid #E2E8F0", borderRadius: 16, padding: 24 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}>
            <Tag size={15} color="#64748B" />
            <span style={{ fontSize: 13, fontWeight: 700, color: "#0F172A" }}>Deal Quality</span>
            {askingPrice && mv && (
              <span style={{ marginLeft: "auto", fontSize: 12, fontWeight: 700, color: dealCfg.color, background: dealCfg.bg, padding: "3px 10px", borderRadius: 20 }}>{dealCfg.label}</span>
            )}
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, marginBottom: 16 }}>
            {/* Market estimate */}
            <div style={{ background: "#F8FAFC", borderRadius: 10, padding: "12px 14px" }}>
              <div style={{ fontSize: 11, color: "#94A3B8", fontWeight: 600, letterSpacing: "0.05em", marginBottom: 4 }}>MARKET VALUE</div>
              {marketLoading ? (
                <div style={{ fontSize: 13, color: "#CBD5E1" }}>Estimating…</div>
              ) : mv ? (
                <div style={{ fontSize: 16, fontWeight: 700, color: "#0F172A" }}>${mv.low.toLocaleString()}–${mv.high.toLocaleString()}</div>
              ) : (
                <div style={{ fontSize: 13, color: "#CBD5E1" }}>Unavailable</div>
              )}
              {mv && <div style={{ fontSize: 11, color: "#94A3B8", marginTop: 2 }}>AI estimate · {mv.confidence} confidence</div>}
            </div>

            {/* Condition debt */}
            <div style={{ background: "#F8FAFC", borderRadius: 10, padding: "12px 14px" }}>
              <div style={{ fontSize: 11, color: "#94A3B8", fontWeight: 600, letterSpacing: "0.05em", marginBottom: 4 }}>CONDITION ADJUSTMENT</div>
              <div style={{ fontSize: 16, fontWeight: 700, color: conditionDebt > 0 ? "#C2410C" : "#16A34A" }}>+${Math.round(conditionDebt).toLocaleString()}</div>
              <div style={{ fontSize: 11, color: "#94A3B8", marginTop: 2 }}>maintenance catch-up</div>
            </div>

            {/* Effective cost */}
            <div style={{ background: "#F8FAFC", borderRadius: 10, padding: "12px 14px" }}>
              <div style={{ fontSize: 11, color: "#94A3B8", fontWeight: 600, letterSpacing: "0.05em", marginBottom: 4 }}>EFFECTIVE COST</div>
              {effectiveCost != null ? (
                <div style={{ fontSize: 16, fontWeight: 700, color: "#0F172A" }}>${Math.round(effectiveCost).toLocaleString()}</div>
              ) : (
                <div style={{ fontSize: 13, color: "#CBD5E1" }}>Enter price →</div>
              )}
              <div style={{ fontSize: 11, color: "#94A3B8", marginTop: 2 }}>price + condition debt</div>
            </div>
          </div>

          {/* Price input */}
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <DollarSign size={14} color="#94A3B8" />
            <input
              value={askingPriceInput}
              onChange={(e) => setAskingPriceInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && applyPrice()}
              placeholder="Enter asking price (e.g. 38000)"
              style={{ flex: 1, border: "1px solid #E2E8F0", borderRadius: 10, padding: "9px 14px", fontSize: 14, background: "#F8FAFC", color: "#0F172A" }}
            />
            <button
              onClick={applyPrice}
              style={{ padding: "9px 18px", borderRadius: 10, background: "#1E293B", color: "#fff", border: "none", fontSize: 13, fontWeight: 600, cursor: "pointer" }}
            >
              Analyze
            </button>
          </div>

          {/* Deal quality result — price-aware language, never absolute */}
          {effectiveCost != null && mv && (
            <div style={{ marginTop: 12, padding: "12px 14px", background: dealCfg.bg, borderRadius: 10, fontSize: 13, color: "#374151", lineHeight: 1.5 }}>
              {dealQuality === "great_deal" && `At $${askingPrice!.toLocaleString()} with ~$${Math.round(conditionDebt).toLocaleString()} in expected work, your effective cost is well below market — the price reflects the condition risk.`}
              {dealQuality === "good_deal" && `At $${askingPrice!.toLocaleString()}, the price already accounts for most of the ~$${Math.round(conditionDebt).toLocaleString()} in expected work. Reasonable deal — use the maintenance gaps to push a bit further.`}
              {dealQuality === "fair_deal" && `At $${askingPrice!.toLocaleString()} with ~$${Math.round(conditionDebt).toLocaleString()} in expected work, you’re roughly at market. The price should reflect the condition — try negotiating down by $${Math.round(conditionDebt / 100) * 100 || 500}.`}
              {dealQuality === "overpriced" && `At $${askingPrice!.toLocaleString()} plus ~$${Math.round(conditionDebt).toLocaleString()} in expected work, the effective cost exceeds market value. This only makes sense if priced ~$${Math.round((effectiveCost - mv.high) / 100) * 100} lower.`}
            </div>
          )}
          {/* Fallback when no price — never say walk away, always frame around price */}
          {effectiveCost == null && (
            <div style={{ marginTop: 12, padding: "10px 14px", background: "rgba(148,163,184,0.08)", borderRadius: 10, fontSize: 13, color: "#64748B", lineHeight: 1.5 }}>
              {conditionDebt > 800
                ? `This vehicle has ~$${Math.round(conditionDebt).toLocaleString()} in expected catch-up work. It only makes sense if priced below market by at least that amount.`
                : `Add the asking price above to see whether this deal makes sense given the expected catch-up cost.`
              }
            </div>
          )}
        </div>

        {/* ── 3. BUYING ADVISOR CHAT ───────────────────────────────────────────── */}
        <div style={{ background: "#fff", border: "1px solid #E2E8F0", borderRadius: 16, overflow: "hidden" }}>
          {/* Chat header */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 20px", borderBottom: chatCollapsed ? "none" : "1px solid #F1F5F9" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <div style={{ width: 8, height: 8, borderRadius: "50%", background: chatLoading ? "#F59E0B" : "#22C55E", transition: "background 0.5s" }} />
              <span style={{ fontSize: 13, fontWeight: 700, color: "#0F172A" }}>Buying Advisor</span>
              <span style={{ fontSize: 12, color: "#94A3B8" }}>· Pre-purchase intelligence</span>
            </div>
            <button onClick={() => setChatCollapsed((v) => !v)} style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 12, color: "#64748B", background: "none", border: "1px solid #E2E8F0", cursor: "pointer", padding: "5px 10px", borderRadius: 8 }}>
              {chatCollapsed ? <ChevronDown size={13} /> : <ChevronUp size={13} />}
              {chatCollapsed ? "Expand" : "Collapse"}
            </button>
          </div>

          {!chatCollapsed && (
            <>
              {/* Messages */}
              <div style={{ maxHeight: 500, overflowY: "auto", padding: "20px 24px", display: "flex", flexDirection: "column", gap: 20 }}>
                {chatMessages.map((msg, i) => (
                  <div key={i} style={{ display: "flex", flexDirection: "column", alignItems: msg.role === "user" ? "flex-end" : "flex-start" }}>
                    {msg.role === "user" ? (
                      <div style={{ background: "#1E293B", color: "#F8FAFC", borderRadius: "18px 18px 4px 18px", padding: "10px 16px", maxWidth: "72%", fontSize: 14, lineHeight: 1.5 }}>
                        {msg.content}
                      </div>
                    ) : (
                      <div style={{ fontSize: 14, color: "#0F172A", lineHeight: 1.7, maxWidth: "88%" }}>
                        {msg.content}
                      </div>
                    )}
                    {msg.chips && msg.chips.length > 0 && msg.role === "assistant" && (
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 10 }}>
                        {msg.chips.map((chip, ci) => (
                          <button key={ci} onClick={() => sendMessage(chip)} style={{ fontSize: 13, padding: "6px 14px", borderRadius: 20, border: "1px solid #E2E8F0", background: "#fff", cursor: "pointer", color: "#374151", transition: "border-color 0.15s, background 0.15s" }}
                            onMouseEnter={(e) => { (e.target as HTMLElement).style.borderColor = "#6366F1"; (e.target as HTMLElement).style.background = "rgba(99,102,241,0.05)"; }}
                            onMouseLeave={(e) => { (e.target as HTMLElement).style.borderColor = "#E2E8F0"; (e.target as HTMLElement).style.background = "#fff"; }}>
                            {chip}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
                {chatLoading && <TypingDots />}
                <div ref={chatEndRef} />
              </div>

              {/* Input */}
              <div style={{ borderTop: "1px solid #F1F5F9", padding: "12px 16px", display: "flex", gap: 8, alignItems: "center" }}>
                <input
                  ref={inputRef}
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && sendMessage(chatInput)}
                  placeholder="Ask about this car…"
                  disabled={chatLoading}
                  style={{ flex: 1, border: "1px solid #E2E8F0", borderRadius: 24, padding: "10px 18px", fontSize: 14, background: "#F8FAFC", color: "#0F172A", transition: "border-color 0.15s" }}
                  onFocus={(e) => (e.target.style.borderColor = "#6366F1")}
                  onBlur={(e) => (e.target.style.borderColor = "#E2E8F0")}
                />
                <button
                  onClick={() => sendMessage(chatInput)}
                  disabled={!chatInput.trim() || chatLoading}
                  style={{ width: 40, height: 40, borderRadius: "50%", background: chatInput.trim() && !chatLoading ? "#1E293B" : "#E2E8F0", border: "none", cursor: chatInput.trim() && !chatLoading ? "pointer" : "default", display: "flex", alignItems: "center", justifyContent: "center", transition: "background 0.15s", flexShrink: 0 }}
                >
                  <Send size={15} color={chatInput.trim() && !chatLoading ? "#fff" : "#94A3B8"} />
                </button>
              </div>
            </>
          )}
        </div>

        {/* ── 4. FULL ANALYSIS (collapsed) ─────────────────────────────────────── */}
        <div style={{ background: "#fff", border: "1px solid #E2E8F0", borderRadius: 16, overflow: "hidden" }}>
          <button
            onClick={() => setBreakdownOpen((v) => !v)}
            style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 20px", background: "none", border: "none", cursor: "pointer", fontSize: 13, fontWeight: 600, color: "#374151" }}
          >
            <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <TrendingDown size={14} color="#64748B" />
              Full Analysis · {allOverdue.length} item{allOverdue.length !== 1 ? "s" : ""} overdue / undocumented
            </span>
            {breakdownOpen ? <ChevronUp size={14} color="#94A3B8" /> : <ChevronDown size={14} color="#94A3B8" />}
          </button>

          {breakdownOpen && (
            <div style={{ borderTop: "1px solid #F1F5F9", padding: "16px 20px", display: "flex", flexDirection: "column", gap: 20 }}>

              {/* Overdue / due items */}
              {allOverdue.length > 0 && (
                <div>
                  <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.07em", color: "#94A3B8", marginBottom: 10 }}>
                    {isAiEstimated ? "UNDOCUMENTED / UNVERIFIED" : "MISSING / OVERDUE"}
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {allOverdue.map((item) => {
                      const lStyle = getItemLabelStyle(item, isAiEstimated);
                      const lLabel = getItemLabel(item, isAiEstimated);
                      return (
                        <div key={item.canonicalService} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", background: "#F8FAFC", borderRadius: 10 }}>
                          <span style={{ fontSize: 10, fontWeight: 700, color: lStyle.color, background: lStyle.bg, padding: "2px 7px", borderRadius: 5, whiteSpace: "nowrap", flexShrink: 0 }}>{lLabel}</span>
                          <span style={{ fontSize: 13, fontWeight: 500, color: "#0F172A", flex: 1 }}>{item.displayName}</span>
                          {item.estimatedCostLow && <span style={{ fontSize: 12, color: "#64748B", whiteSpace: "nowrap" }}>~${item.estimatedCostLow}–${item.estimatedCostHigh ?? item.estimatedCostLow}</span>}
                          <span style={{ fontSize: 11, color: item.severity === "high" ? "#EF4444" : item.severity === "medium" ? "#F59E0B" : "#94A3B8" }}>{item.severity}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Upcoming */}
              {result.upcomingItems.length > 0 && (
                <div>
                  <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.07em", color: "#94A3B8", marginBottom: 10 }}>UPCOMING</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    {result.upcomingItems.map((item) => (
                      <div key={item.canonicalService} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 14px", background: "#F8FAFC", borderRadius: 10 }}>
                        <span style={{ fontSize: 10, fontWeight: 700, color: "#64748B", background: "rgba(100,116,139,0.12)", padding: "2px 7px", borderRadius: 5, flexShrink: 0 }}>Upcoming</span>
                        <span style={{ fontSize: 13, color: "#374151", flex: 1 }}>{item.displayName}</span>
                        {item.dueMileage && <span style={{ fontSize: 12, color: "#94A3B8" }}>due at {item.dueMileage.toLocaleString()} mi</span>}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Completed */}
              {result.completedItems.length > 0 && (
                <div>
                  <button onClick={() => setCompletedOpen((v) => !v)} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, fontWeight: 700, letterSpacing: "0.07em", color: "#94A3B8", background: "none", border: "none", cursor: "pointer", padding: 0, marginBottom: completedOpen ? 10 : 0 }}>
                    {completedOpen ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                    COMPLETED ({result.completedItems.length})
                  </button>
                  {completedOpen && (
                    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                      {result.completedItems.map((item) => (
                        <div key={item.canonicalService} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 14px", background: "#F0FDF4", borderRadius: 10 }}>
                          <CheckCircle size={12} color="#22C55E" style={{ flexShrink: 0 }} />
                          <span style={{ fontSize: 13, color: "#374151", flex: 1 }}>{item.displayName}</span>
                          {item.lastServiceDate && <span style={{ fontSize: 12, color: "#94A3B8" }}>{item.lastServiceDate.slice(0, 7)}</span>}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Negotiation pitch */}
              <div>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.07em", color: "#94A3B8" }}>NEGOTIATION PITCH</div>
                  <CopyButton text={pitch} label="Copy pitch" />
                </div>
                <div style={{ background: "#F8FAFC", border: "1px solid #E2E8F0", borderRadius: 10, padding: "14px 16px", fontSize: 13, color: "#374151", lineHeight: 1.6 }}>
                  {pitch}
                </div>
              </div>

            </div>
          )}
        </div>
      </main>
    </div>
  );
}
