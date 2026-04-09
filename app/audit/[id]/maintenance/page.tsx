"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  AlertTriangle, CheckCircle, ChevronDown, ChevronUp,
  Copy, Check, ArrowLeft, Shield, Send, Clock, Info,
  TrendingDown, DollarSign, Tag, MessageSquare,
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

type ItemAction = "negotiate" | "done" | "seller_fix";
type DealQuality = "strong_buy" | "fair_deal" | "overpriced" | "unknown";

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
  strong_buy: { label: "Strong Buy",  color: "#16A34A", bg: "rgba(22,163,74,0.10)" },
  fair_deal:  { label: "Fair Price",  color: "#64748B", bg: "rgba(100,116,139,0.10)" },
  overpriced: { label: "Overpriced",  color: "#DC2626", bg: "rgba(220,38,38,0.10)" },
  unknown:    { label: "Enter Price", color: "#94A3B8", bg: "rgba(148,163,184,0.08)" },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getItemLabel(item: MaintenanceDebtItem, result: MaintenanceDebtAuditResult): string {
  const matchingEventIds = item.matchingHistoryEventIds || [];
  const isPpiConfirmed = result.normalizedHistory?.some(h => matchingEventIds.includes(h.id) && h.is_ppi);

  if (isPpiConfirmed) return "Confirmed";
  if (item.evidenceFound) return "Documented";
  if (item.status === "done") return "Completed";
  if (result.scheduleSource === "ai_estimated") return item.severity === "high" ? "Verify" : "Undocumented";
  if (item.status === "overdue") return "Due based on mileage";
  return "Due Now";
}

function getItemLabelStyle(item: MaintenanceDebtItem, result: MaintenanceDebtAuditResult): { color: string; bg: string } {
  const matchingEventIds = item.matchingHistoryEventIds || [];
  const isPpiConfirmed = result.normalizedHistory?.some(h => matchingEventIds.includes(h.id) && h.is_ppi);

  if (isPpiConfirmed) return { color: "#16A34A", bg: "rgba(22,163,74,0.12)" };
  if (item.evidenceFound) return { color: "#10B981", bg: "rgba(16,185,129,0.12)" };
  if (result.scheduleSource === "ai_estimated") {
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

interface NegotiationGuidance {
  state: string;
  uiMessage: string;
  script: string;
  tone: string;
}

function getNegotiationGuidance(r: MaintenanceDebtAuditResult, askingPrice: number | null, dealQuality: DealQuality): NegotiationGuidance {
  const overdueItems = [...r.debtItems]
    .filter((i) => (i.status === "overdue" || i.status === "due_now") && !i.evidenceFound)
    .sort((a, b) => (b.estimatedCostHigh ?? 0) - (a.estimatedCostHigh ?? 0));
    
  const names = overdueItems.slice(0, 2).map(i => i.displayName).join(" and ");
  const cost = Math.round(((r.debtEstimateLow ?? 0) + (r.debtEstimateHigh ?? r.debtEstimateLow ?? 0)) / 2 / 100) * 100;
  const vehicle = `${r.vehicle.year} ${r.vehicle.make} ${r.vehicle.model}`;
  
  const mvAvg = r.marketValueEstimate ? (r.marketValueEstimate.low + r.marketValueEstimate.high) / 2 : 0;
  const target = Math.round((mvAvg - cost) / 100) * 100;

  if (dealQuality === "overpriced") {
    return {
      state: "Overpaying",
      uiMessage: "Price is high relative to its condition.",
      script: `I’ve reviewed the service history for the ${vehicle}. It looks like it’s due for ${names} soon, which typically runs ~$${cost.toLocaleString()}. With those items factored in, the current price is a bit above market. If you can get closer to $${target.toLocaleString()}, I’d love to make this work.`,
      tone: "Objective & Firm"
    };
  }

  if (dealQuality === "fair_deal") {
    return {
      state: "Fair Deal",
      uiMessage: "Price is fair, but these gaps are your leverage.",
      script: `I’m really interested in the ${vehicle}. The records don’t show ${names} being done, and those services run about $${cost.toLocaleString()}. If you can help me out on the price to cover that deferred maintenance, I’m ready to move forward.`,
      tone: "Fair & Collaborative"
    };
  }

  if (dealQuality === "strong_buy") {
    return {
      state: "Strong Buy",
      uiMessage: "Excellent value. Close the deal quickly.",
      script: `The ${vehicle} looks great. I noticed it’s just about due for ${names} (~$${cost.toLocaleString()}). If we can adjust the price slightly to account for that, I can come out today and close the deal.`,
      tone: "Ready & Motivated"
    };
  }

  return {
    state: "Reviewing",
    uiMessage: "Enter price to see negotiation strategy.",
    script: `I noticed the ${vehicle} is due for ${names} soon. This typically costs about $${cost.toLocaleString()} to address.`,
    tone: "Informative"
  };
}

function computeDealQuality(
  askingPrice: number,
  marketLow: number,
  marketHigh: number,
  conditionAdj: number
): DealQuality {
  const targetPrice = ((marketLow + marketHigh) / 2) - conditionAdj;
  const ratio = askingPrice / targetPrice;

  if (ratio < 0.92) return "strong_buy";
  if (ratio < 1.05) return "fair_deal";
  return "overpriced";
}

function getConfidenceNote(r: MaintenanceDebtAuditResult): string {
  const n = r.normalizedHistory?.length ?? 0;
  if (r.scheduleSource === "vehicle_databases") return `VIN-matched OEM schedule · ${n} service events recorded`;
  if (r.scheduleSource === "ai_estimated") return `AI-estimated schedule · ${n} events found · undocumented ≠ confirmed overdue`;
  return "";
}

function getForwardMaintenance(r: MaintenanceDebtAuditResult) {
  const upcoming = r.upcomingItems || [];
  const make = r.vehicle.make?.toLowerCase() || "";
  const year = r.vehicle.year || new Date().getFullYear();
  const mileage = r.vehicle.currentMileage || 0;
  const age = new Date().getFullYear() - year;
  
  // 1. Assign Profile
  let profile = "Moderate Maintenance";
  let profileMsg = "Maintenance costs are fairly typical for this type of vehicle.";
  let riskNote = "No major issues expected with standard care.";

  const lowMaintMakes = ["toyota", "honda", "lexus"];
  const highMaintMakes = ["audi", "bmw", "mercedes", "mercedes-benz", "land rover", "porsche", "range rover", "volkswagen", "jaguar"];
  
  if (lowMaintMakes.includes(make)) {
    profile = "Low Maintenance";
    profileMsg = "This is generally a low-maintenance platform with predictable costs.";
    riskNote = "Reliability is a strong point for this model.";
  } else if (highMaintMakes.includes(make)) {
    profile = "Higher Maintenance";
    profileMsg = "This platform tends to have higher maintenance costs over time.";
    riskNote = "Expect higher parts and labor costs for routine items.";
  }
  
  if (age > 10 || mileage > 110000) {
    profile = "Aging / Higher Variability";
    profileMsg = "At this age, expect more variability in maintenance and occasional repairs.";
    riskNote = "Set aside a reserve for unscheduled mechanical work.";
  }

  // 2. Calculate Costs
  const debtLow = r.debtEstimateLow ?? 0;
  const debtHigh = r.debtEstimateHigh ?? debtLow;
  
  // Forward cost includes 10% of existing debt (trickle down) + upcoming + baseline
  const upcomingCostLow = upcoming.reduce((acc, i) => acc + (i.estimatedCostLow ?? 0), 0);
  const upcomingCostHigh = upcoming.reduce((acc, i) => acc + (i.estimatedCostHigh ?? i.estimatedCostLow ?? 0), 0);
  
  let baseline = 400;
  if (profile === "Higher Maintenance") baseline = 800;
  if (profile === "Aging / Higher Variability") baseline = 600;

  const low = Math.round((debtLow * 0.1 + upcomingCostLow + baseline) / 100) * 100;
  const high = Math.round((debtHigh * 0.15 + upcomingCostHigh + baseline * 1.5) / 100) * 100;
  
  const isHighRisk = r.verdict === "high_risk" || r.verdict === "walk_away" || upcoming.some(i => i.severity === "high");
  
  return {
    range: `$${low.toLocaleString()}–$${high.toLocaleString()}`,
    profile: profileMsg,
    note: isHighRisk ? "Plan for mechanical attention within 12 months." : riskNote,
    behavior: isHighRisk ? "Elevated cost due to deferred items." : "Stable ownership costs expected."
  };
}

// ─── Adaptive mode badge ──────────────────────────────────────────────────────

function getAdaptiveMode(r: MaintenanceDebtAuditResult): { label: string; sublabel: string; color: string; bg: string; border: string } {
  const hasPPI = r.normalizedHistory?.some(h => h.is_ppi);
  if (hasPPI) {
    return { label: "Inspection Report", sublabel: "Confirmed condition · Level 1 confidence", color: "#16A34A", bg: "rgba(22,163,74,0.08)", border: "rgba(22,163,74,0.25)" };
  }
  if (r.scheduleSource === "vehicle_databases") {
    return { label: "CARFAX + OEM Schedule", sublabel: "VIN-matched · Level 2 confidence", color: "#0369A1", bg: "rgba(3,105,161,0.07)", border: "rgba(3,105,161,0.2)" };
  }
  if (r.scheduleSource === "ai_estimated") {
    return { label: "CARFAX Only", sublabel: "AI-estimated schedule · Level 3 confidence", color: "#B45309", bg: "rgba(180,83,9,0.07)", border: "rgba(180,83,9,0.2)" };
  }
  return { label: "General Guidance", sublabel: "No records found", color: "#6B7280", bg: "rgba(107,114,128,0.07)", border: "rgba(107,114,128,0.2)" };
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

function getCategorization(item: MaintenanceDebtItem, result?: MaintenanceDebtAuditResult): "Real Concerns" | "Expected Maintenance" | "Informational" {
  const mechanical = ["Brakes", "Tires", "Suspension", "Transmission", "Timing Belt", "Cooling System", "Leaks", "Oil Leak"].some(k => item.displayName.toLowerCase().includes(k.toLowerCase()) || item.canonicalService.toLowerCase().includes(k.toLowerCase()));
  const isPpi = result?.normalizedHistory?.some(h => item.matchingHistoryEventIds?.includes(h.id) && h.is_ppi);
  if (mechanical || isPpi || item.severity === "high") return "Real Concerns";
  if (item.status === "upcoming" || item.severity === "low") return "Informational";
  return "Expected Maintenance";
}

function getSeverityEmoji(cat: string): string {
  if (cat === "Real Concerns") return "🔴";
  if (cat === "Expected Maintenance") return "🟡";
  return "⚪";
}

function getIntervalLabel(item: MaintenanceDebtItem): string {
  if (item.dueMileage) return `${item.dueMileage.toLocaleString()} mi`;
  return "Scheduled interval";
}

function getLastSeenRecord(item: MaintenanceDebtItem, result?: MaintenanceDebtAuditResult): string {
  if (item.matchingHistoryEventIds?.length && result?.normalizedHistory) {
    const latest = result.normalizedHistory.find(h => item.matchingHistoryEventIds.includes(h.id));
    if (latest) return `${latest.date || "Multiple records"} (${latest.mileage?.toLocaleString() ?? "?"} mi)`;
  }
  return "No record found";
}

interface DecisionCardProps {
  item: MaintenanceDebtItem;
  vehicle: string;
  isAiEstimated: boolean;
  result: MaintenanceDebtAuditResult;
  onAskAdvisor: (q: string) => void;
  ledgerAction: ItemAction;
  onLedgerChange: (id: string, action: ItemAction) => void;
}

function DecisionCard({ item, vehicle, isAiEstimated, result, onAskAdvisor, ledgerAction, onLedgerChange }: DecisionCardProps) {
  const cat = getCategorization(item, result);
  const emoji = getSeverityEmoji(cat);
  const interval = getIntervalLabel(item);
  const lastSeen = getLastSeenRecord(item, result);

  return (
    <div style={{ background: "#fff", border: "1px solid #E2E8F0", borderRadius: 16, padding: "20px", display: "flex", flexDirection: "column", gap: 12, opacity: ledgerAction !== "negotiate" ? 0.6 : 1, transition: "opacity 0.2s" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 18 }}>{emoji}</span>
          <span style={{ fontSize: 15, fontWeight: 700, color: "#0F172A" }}>{item.displayName}</span>
        </div>
        <div style={{ display: "flex", background: "#F1F5F9", padding: 3, borderRadius: 10, gap: 2 }}>
          {[
            { id: "negotiate", label: "Include", icon: Tag },
            { id: "done", label: "Fixed", icon: CheckCircle },
            { id: "seller_fix", label: "Seller Fix", icon: Shield }
          ].map((a) => {
            const isActive = ledgerAction === a.id;
            return (
              <button
                key={a.id}
                onClick={() => onLedgerChange(item.canonicalService, a.id as ItemAction)}
                style={{ display: "flex", alignItems: "center", gap: 4, padding: "5px 10px", borderRadius: 8, border: "none", fontSize: 11, fontWeight: 700, cursor: "pointer", background: isActive ? "#fff" : "transparent", color: isActive ? "#0F172A" : "#64748B", boxShadow: isActive ? "0 1px 3px rgba(0,0,0,0.1)" : "none", transition: "all 0.15s" }}
              >
                {a.label}
              </button>
            );
          })}
        </div>
      </div>
      <div style={{ fontSize: 13, color: "#475569", lineHeight: 1.6 }}>{item.reasoning}</div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, background: "#F8FAFC", padding: "10px 14px", borderRadius: 12 }}>
        <div>
          <div style={{ fontSize: 10, fontWeight: 700, color: "#94A3B8", letterSpacing: "0.05em", marginBottom: 2 }}>EXPECTED</div>
          <div style={{ fontSize: 12, color: "#1E293B", fontWeight: 600 }}>{interval}</div>
        </div>
        <div>
          <div style={{ fontSize: 10, fontWeight: 700, color: "#94A3B8", letterSpacing: "0.05em", marginBottom: 2 }}>LAST SEEN</div>
          <div style={{ fontSize: 12, color: item.evidenceFound ? "#16A34A" : "#64748B", fontWeight: 600 }}>{lastSeen}</div>
        </div>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {["Is this a big deal?", "Can this wait?", "How do I negotiate this?"].map((q) => (
          <button key={q} onClick={() => onAskAdvisor(`${q} about ${item.displayName}`)} style={{ fontSize: 11, padding: "6px 12px", borderRadius: 15, border: "1px solid #E2E8F0", background: "#fff", cursor: "pointer", color: "#64748B" }}>{q}</button>
        ))}
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
  // Responsive and Navigation
  const [isMobile, setIsMobile] = useState(false);
  const [activeTab, setActiveTab] = useState<"summary" | "negotiate" | "pitch" | "advisor" | "details">("summary");

  useEffect(() => {
    const checkMobile = () => setIsMobile(window.innerWidth < 1024);
    checkMobile();
    window.addEventListener("resize", checkMobile);
    return () => window.removeEventListener("resize", checkMobile);
  }, []);

  // Market estimate
  const [marketEstimate, setMarketEstimate] = useState<{ low: number; high: number; confidence: string } | null>(null);

  // Negotiation Ledger
  const [ledger, setLedger] = useState<Record<string, ItemAction>>({});
  const updateLedger = (id: string, action: ItemAction) => {
    setLedger(prev => ({ ...prev, [id]: action }));
  };

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
    // setMarketLoading(true); // removed in UX refactor
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
       .catch(() => {});
  }, [result?.vehicle.year, result?.vehicle.make, result?.vehicle.model]);

  // ── Apply asking price ─────────────────────────────────────────────────
  const applyPrice = () => {
    const n = parseFloat(askingPriceInput.replace(/[^0-9.]/g, ""));
    setAskingPrice(isNaN(n) ? null : n);
  };

  // ── Derived values ────────────────────────────────────────────────────────────
  const verdictCfg = (result && VERDICT_CONFIG[result.verdict]) ?? VERDICT_CONFIG.proceed_caution;
  const VerdictIcon = verdictCfg.icon;
  const vehicleLabel = result ? ([result.vehicle.year, result.vehicle.make, result.vehicle.model].filter(Boolean).join(" ") || result.vehicle.vin || "Unknown Vehicle") : "Unknown Vehicle";
  const isAiEstimated = result ? (result.scheduleSource === "ai_estimated") : false;
  const allOverdue = result ? result.debtItems.filter((i) => i.status === "overdue" || i.status === "due_now") : [];

  // conditionDebt = only include items with action "negotiate" (default)
  const conditionDebt = (result && allOverdue.length) ? allOverdue.reduce((acc, i) => {
    const action = ledger[i.canonicalService] || "negotiate";
    if (action !== "negotiate") return acc;
    return acc + (((i.estimatedCostLow ?? 0) + (i.estimatedCostHigh ?? i.estimatedCostLow ?? 0)) / 2);
  }, 0) : 0;

  // Filter result for guidance based on ledger
  const resultForGuidance = result ? {
    ...result,
    debtItems: result.debtItems.filter(i => (ledger[i.canonicalService] || "negotiate") === "negotiate"),
    debtEstimateLow: allOverdue.reduce((acc, i) => (ledger[i.canonicalService] || "negotiate") === "negotiate" ? acc + (i.estimatedCostLow ?? 0) : acc, 0),
    debtEstimateHigh: allOverdue.reduce((acc, i) => (ledger[i.canonicalService] || "negotiate") === "negotiate" ? acc + (i.estimatedCostHigh ?? i.estimatedCostLow ?? 0) : acc, 0)
  } : null;

  const mv = result ? (marketEstimate ?? result.marketValueEstimate) : null;
  const effectiveCost = (askingPrice != null && result) ? askingPrice + conditionDebt : null;
  const dealQuality: DealQuality = (effectiveCost != null && mv)
    ? computeDealQuality(effectiveCost, mv.low, mv.high, 0)
    : "unknown";
  const dealCfg = DEAL_QUALITY_CONFIG[dealQuality];
  const guidance = resultForGuidance ? getNegotiationGuidance(resultForGuidance, askingPrice, dealQuality) : null;

  // Card advisor handler
  const handleCardAskAdvisor = useCallback((question: string) => {
    setChatCollapsed(false);
    sendMessage(question);
    setTimeout(() => chatEndRef.current?.scrollIntoView({ behavior: "smooth" }), 150);
  }, [sendMessage]);

  const realConcerns = allOverdue.filter(i => getCategorization(i, result || undefined) === "Real Concerns");
  const expectedMaintenance = allOverdue.filter(i => getCategorization(i, result || undefined) === "Expected Maintenance");
  const verifiedHistory = result?.normalizedHistory?.filter(h => !h.is_ppi) || [];
  const showSticky = result && !loading;

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

  return (
    <div style={{ minHeight: "100vh", background: "#F8FAFC", fontFamily: "'Inter', -apple-system, sans-serif", color: "#0F172A" }}>
      <style>{`
        * { box-sizing: border-box; }
        input:focus { outline: none; }
        @keyframes wrenchDot { 0%,100%{opacity:.3;transform:translateY(0)} 50%{opacity:1;transform:translateY(-3px)} }
      `}</style>

      {/* ── Main content (Responsive: Tabs on Mobile, Stacked on Desktop) ─────────── */}
      <main style={{ maxWidth: 920, margin: "0 auto", padding: isMobile ? "16px 16px 140px" : "40px 24px 120px", display: "flex", flexDirection: "column", gap: isMobile ? 16 : 32 }}>
        
        {/* DESKTOP BRANDING / TOP BAR */}
        {!isMobile && (
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginBottom: 8 }}>
            <div>
              <div style={{ fontSize: 14, fontWeight: 700, color: "#6366F1", letterSpacing: "0.1em", marginBottom: 4 }}>WRENCHCHECK AUDIT</div>
              <h1 style={{ fontSize: 36, fontWeight: 900, color: "#0F172A", margin: 0 }}>{vehicleLabel}</h1>
            </div>
            <div style={{ textAlign: "right" }}>
              <div style={{ fontSize: 12, color: "#94A3B8", fontWeight: 700, marginBottom: 4 }}>CURRENT MILEAGE</div>
              <div style={{ fontSize: 24, fontWeight: 800, color: "#0F172A" }}>{result.vehicle.currentMileage?.toLocaleString()} mi</div>
            </div>
          </div>
        )}

        {/* ── SECTION 1: VERDICT & DRIVERS (SUMMARY) ────────────────────────── */}
        {(isMobile ? activeTab === "summary" : true) && (
          <div style={{ display: "flex", flexDirection: "column", gap: isMobile ? 16 : 24 }}>
             {/* Headline Card */}
             <div style={{ background: "#fff", border: "1px solid #E2E8F0", borderRadius: 32, padding: isMobile ? "28px 24px" : "40px", textAlign: "center", display: "flex", flexDirection: "column", alignItems: "center", gap: 12, boxShadow: "0 4px 6px -1px rgba(0,0,0,0.05)" }}>
                <div style={{ background: verdictCfg.bg, color: verdictCfg.color, border: `1px solid ${verdictCfg.border}`, borderRadius: "50%", padding: 24, marginBottom: 8 }}>
                  <VerdictIcon size={48} />
                </div>
                <div style={{ fontSize: isMobile ? 24 : 32, fontWeight: 900, color: "#0F172A", lineHeight: 1.1 }}>{verdictCfg.label}</div>
                <div style={{ fontSize: isMobile ? 15 : 18, color: "#64748B", lineHeight: 1.5, maxWidth: "560px" }}>{verdictCfg.tagline}</div>
                
                {/* Why this matters (Single sentence Insight) */}
                <div style={{ marginTop: 8, fontSize: 14, color: "#475569", fontWeight: 600, background: "#F8FAFC", padding: "10px 20px", borderRadius: 12, border: "1px solid #F1F5F9" }}>
                   💡 {allOverdue.length > 0 ? "Deferred maintenance can lead to expensive failures if ignored." : "This appears to be a well-maintained vehicle with no immediate risks."}
                </div>

                {/* What's driving this (Top 2 issues) */}
                {allOverdue.length > 0 && (
                  <div style={{ marginTop: 24, width: "100%", textAlign: "left" }}>
                    <div style={{ fontSize: 11, fontWeight: 800, color: "#94A3B8", letterSpacing: "0.1em", marginBottom: 12, textAlign: "center" }}>WHAT'S DRIVING THIS:</div>
                    <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr", gap: 12 }}>
                       {allOverdue.slice(0, 2).map((item, idx) => (
                         <div key={idx} style={{ padding: "14px 18px", background: "#F8FAFC", border: "1px solid #E2E8F0", borderRadius: 16, display: "flex", alignItems: "center", gap: 12 }}>
                           <div style={{ fontSize: 18 }}>🔴</div>
                           <div>
                              <div style={{ fontSize: 14, fontWeight: 800, color: "#0F172A" }}>{item.displayName}</div>
                              <div style={{ fontSize: 12, color: "#64748B" }}>
                                {item.daysOverdue && item.daysOverdue > 365 
                                  ? `Overdue by ~${Math.round(item.daysOverdue/365)} years` 
                                  : "Likely never serviced"}
                                {" · "}
                                <span style={{ color: "#EF4444", fontWeight: 700 }}>{item.severity === "high" ? "mechanical risk" : "deferred debt"}</span>
                              </div>
                           </div>
                         </div>
                       ))}
                    </div>
                  </div>
                )}
                
                <div style={{ marginTop: 12, width: "100%", background: "#F8FAFC", borderRadius: 20, padding: "20px 24px", display: "flex", justifyContent: "space-between", alignItems: "center", border: "1px solid #F1F5F9" }}>
                   <div style={{ textAlign: "left" }}>
                      <div style={{ fontSize: 11, fontWeight: 800, color: "#94A3B8", marginBottom: 2 }}>EST. CATCH-UP DEBT</div>
                      <div style={{ fontSize: 24, fontWeight: 900, color: "#0F172A" }}>${result.debtEstimateLow?.toLocaleString()}–${(result.debtEstimateHigh ?? result.debtEstimateLow)?.toLocaleString()}</div>
                   </div>
                   {isMobile && (
                     <button onClick={() => setActiveTab("negotiate")} style={{ background: "#0F172A", color: "#fff", border: "none", borderRadius: 12, padding: "12px 20px", fontSize: 14, fontWeight: 700, cursor: "pointer" }}>
                       Offer Strategy
                     </button>
                   )}
                </div>
             </div>

             {/* Vehicle Profile Card (Next 12-18 months) */}
             <div style={{ background: "#fff", border: "1px solid #E2E8F0", borderRadius: 28, padding: isMobile ? 24 : 32 }}>
                <div style={{ fontSize: 11, fontWeight: 800, color: "#94A3B8", letterSpacing: "0.1em", marginBottom: 20 }}>FUTURE OWNERSHIP COST</div>
                {(() => {
                  const fm = getForwardMaintenance(result!);
                  return (
                    <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1.5fr", gap: 24, alignItems: "center" }}>
                      <div>
                        <div style={{ fontSize: 28, fontWeight: 900, color: "#0F172A" }}>~{fm.range}</div>
                        <div style={{ fontSize: 14, fontWeight: 600, color: "#64748B" }}>Expected in next 12–18mo</div>
                      </div>
                      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                        {[fm.profile, fm.behavior, fm.note].map((t, i) => (
                          <div key={i} style={{ display: "flex", alignItems: "center", gap: 12, fontSize: 15, color: "#475569", fontWeight: 500 }}>
                            <div style={{ width: 8, height: 8, borderRadius: "50%", background: "#6366F1", flexShrink: 0 }} />
                            {t}
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })()}
             </div>

             {isMobile && (
               <button 
                  onClick={() => setActiveTab("negotiate")} 
                  style={{ background: "#4F46E5", color: "#fff", border: "none", borderRadius: 20, padding: "20px", fontSize: 16, fontWeight: 800, cursor: "pointer", boxShadow: "0 10px 15px -3px rgba(79, 70, 229, 0.4)" }}
               >
                  What should I offer?
               </button>
             )}
          </div>
        )}

        {/* ── SECTION 2: PRICING & TOP ISSUES (NEGOTIATE) ────────────────────── */}
        {(isMobile ? activeTab === "negotiate" : true) && (
           <div style={{ display: "flex", flexDirection: "column", gap: isMobile ? 16 : 32 }}>
              {/* Scoreboard / Ledger */}
              <div style={{ background: "#0F172A", border: "1px solid #1E293B", borderRadius: 32, padding: isMobile ? "24px" : "32px", color: "#fff", boxShadow: "0 20px 25px -5px rgba(0, 0, 0, 0.1)" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 28 }}>
                    <div style={{ fontSize: 12, fontWeight: 900, letterSpacing: "0.12em", color: "#94A3B8" }}>NEGOTIATION LEDGER</div>
                    <div style={{ fontSize: 11, fontWeight: 900, background: dealCfg.bg, color: dealCfg.color, padding: "6px 14px", borderRadius: 20 }}>{dealCfg.label.toUpperCase()}</div>
                  </div>

                  <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
                    <div style={{ position: "relative" }}>
                      <div style={{ fontSize: 11, fontWeight: 800, color: "#64748B", marginBottom: 10, letterSpacing: "0.05em" }}>SELLER'S ASKING PRICE</div>
                      <span style={{ position: "absolute", left: 18, bottom: 15, color: "#94A3B8", fontSize: 20 }}>$</span>
                      <input
                        value={askingPriceInput}
                        onChange={(e) => setAskingPriceInput(e.target.value)}
                        onBlur={applyPrice}
                        className="price-input"
                        placeholder="e.g. 42,000"
                        style={{ width: "100%", border: "2px solid #1E293B", borderRadius: 16, padding: "16px 20px 16px 36px", fontSize: 22, fontWeight: 800, background: "rgba(255,255,255,0.03)", color: "#fff" }}
                      />
                    </div>

                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24 }}>
                       <div style={{ background: "rgba(255,255,255,0.02)", padding: 20, borderRadius: 20, border: "1px solid rgba(255,255,255,0.05)" }}>
                          <div style={{ fontSize: 11, fontWeight: 700, color: "#64748B", marginBottom: 6 }}>MARKET AVERAGE</div>
                          <div style={{ fontSize: 24, fontWeight: 900 }}>${mv ? Math.round((mv.low + mv.high)/2).toLocaleString() : "—"}</div>
                       </div>
                       <div style={{ background: "rgba(255,255,255,0.02)", padding: 20, borderRadius: 20, border: "1px solid rgba(255,255,255,0.05)" }}>
                          <div style={{ fontSize: 11, fontWeight: 700, color: "#64748B", marginBottom: 6 }}>MAINT. ADJUSTMENT</div>
                          <div style={{ fontSize: 24, fontWeight: 900, color: "#F87171" }}>−${Math.round(conditionDebt).toLocaleString()}</div>
                       </div>
                    </div>

                    <div style={{ background: "linear-gradient(135deg, #1E293B 0%, #0F172A 100%)", padding: "28px", borderRadius: 24, border: "1px solid rgba(255,255,255,0.1)", textAlign: "center" }}>
                      <div style={{ fontSize: 12, fontWeight: 800, color: "#4ADE80", marginBottom: 8, letterSpacing: "0.1em" }}>TARGET OFFER PRICE</div>
                      <div style={{ fontSize: 48, fontWeight: 950, color: "#fff", letterSpacing: "-0.03em" }}>${mv ? (Math.round((mv.low + mv.high)/2) - Math.round(conditionDebt)).toLocaleString() : "—"}</div>
                    </div>
                  </div>
              </div>

              {/* Priority Issues */}
              <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                 <div style={{ fontSize: 12, fontWeight: 900, color: "#94A3B8", letterSpacing: "0.1em" }}>TOP 3 PRIORITY ISSUES</div>
                 <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                    {allOverdue.slice(0, 3).map((item) => (
                      <DecisionCard
                        key={item.canonicalService}
                        item={item}
                        vehicle={vehicleLabel}
                        isAiEstimated={isAiEstimated}
                        result={result}
                        onAskAdvisor={() => setActiveTab("advisor")}
                        ledgerAction={ledger[item.canonicalService] || "negotiate"}
                        onLedgerChange={updateLedger}
                      />
                    ))}
                 </div>
              </div>

              {!isMobile && (
                <div style={{ display: "flex", justifyContent: "center" }}>
                   <button 
                      onClick={() => setActiveTab("pitch")}
                      style={{ background: "#fff", border: "1px solid #E2E8F0", borderRadius: 16, padding: "16px 32px", fontSize: 15, fontWeight: 700, color: "#0F172A", cursor: "pointer" }}
                    >
                      View Full Negotiation Pitch →
                    </button>
                </div>
              )}
           </div>
        )}

        {/* ── SECTION 3: PITCH (SCRIPT) ───────────────────────────────────────── */}
        {(isMobile ? activeTab === "pitch" : true) && (
           <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
              <div style={{ background: "#fff", border: "1px solid #E2E8F0", borderRadius: 32, padding: isMobile ? 24 : 40 }}>
                <div style={{ fontSize: 12, fontWeight: 950, color: "#6366F1", letterSpacing: "0.12em", marginBottom: 24 }}>THE PERFECT PITCH</div>
                
                <div style={{ background: "#F8FAFC", border: "1px solid #E2E8F0", borderRadius: 24, padding: isMobile ? "24px" : "40px", position: "relative" }}>
                   <div style={{ fontSize: isMobile ? 18 : 22, color: "#0F172A", lineHeight: 1.6, fontStyle: "italic", whiteSpace: "pre-wrap" }}>
                     “{guidance?.script}”
                   </div>
                   <div style={{ marginTop: 32, display: "flex", gap: 16 }}>
                      <button 
                        onClick={() => { navigator.clipboard.writeText(guidance?.script || ""); alert("Copied to clipboard!"); }}
                        style={{ flex: 1, background: "#0F172A", color: "#fff", border: "none", borderRadius: 16, padding: "18px", fontSize: 15, fontWeight: 800, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}
                      >
                        <Copy size={18} /> Copy to Clipboard
                      </button>
                      <button 
                        onClick={() => window.open(`sms:?&body=${encodeURIComponent(guidance?.script || "")}`)}
                        style={{ flex: 1, background: "#EEF2FF", color: "#4F46E5", border: "none", borderRadius: 16, padding: "18px", fontSize: 15, fontWeight: 800, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}
                      >
                         Send as Text
                      </button>
                   </div>
                </div>

                <div style={{ marginTop: 32, background: "#F1F5F9", borderRadius: 20, padding: 24 }}>
                   <div style={{ fontSize: 11, fontWeight: 900, color: "#475569", marginBottom: 16, letterSpacing: "0.1em" }}>STRATEGY BREAKDOWN</div>
                   <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr", gap: 16 }}>
                      {[
                        { label: "Tone Control", value: guidance?.tone },
                        { label: "Data Leverage", value: "References specific verified gaps" },
                        { label: "Price Logic", value: "Ties directly to market fair value" },
                        { label: "Expert Proof", value: "Condition-based adjustment" }
                      ].map((t, i) => (
                        <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
                           <div style={{ marginTop: 4 }}><Check size={16} color="#10B981" strokeWidth={3} /></div>
                           <div>
                              <div style={{ fontSize: 12, fontWeight: 800, color: "#0F172A" }}>{t.label}</div>
                              <div style={{ fontSize: 13, color: "#64748B" }}>{t.value}</div>
                           </div>
                        </div>
                      ))}
                   </div>
                </div>
              </div>
           </div>
        )}

        {/* ── SECTION 4 & 5: ADVISOR & FULL BREAKDOWN ───────────────────────── */}
        {(isMobile ? (activeTab === "advisor" || activeTab === "details") : true) && (
           <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr", gap: 24 }}>
              
              {/* Advisor Chat */}
              {(activeTab === "advisor" || !isMobile) && (
                <div style={{ background: "#fff", border: "1px solid #E2E8F0", borderRadius: 32, overflow: "hidden", display: "flex", flexDirection: "column", height: isMobile ? "70vh" : "600px" }}>
                  <div style={{ padding: "20px 24px", borderBottom: "1px solid #F1F5F9", display: "flex", gap: 12, alignItems: "center", background: "#F8FAFC" }}>
                    <Shield size={20} color="#6366F1" />
                    <span style={{ fontSize: 16, fontWeight: 800 }}>Buying Advisor</span>
                    <div style={{ marginLeft: "auto", display: "flex", gap: 4 }}>
                       {[1,2,3].map(i => <div key={i} style={{ width: 4, height: 4, borderRadius: "50%", background: "#10B981" }} />)}
                    </div>
                  </div>
                  
                  <div style={{ flex: 1, overflowY: "auto", padding: "24px" }}>
                    {chatMessages.map((msg, i) => (
                        <div key={i} style={{ marginBottom: 24, display: "flex", flexDirection: "column", alignItems: msg.role === "user" ? "flex-end" : "flex-start" }}>
                          <div style={{ 
                            maxWidth: "88%", 
                            padding: "14px 20px", 
                            borderRadius: msg.role === "user" ? "24px 24px 4px 24px" : "24px 24px 24px 4px",
                            background: msg.role === "user" ? "#0F172A" : "#F1F5F9",
                            color: msg.role === "user" ? "#fff" : "#0F172A",
                            fontSize: 15,
                            lineHeight: 1.6,
                            boxShadow: msg.role === "user" ? "0 4px 12px rgba(0,0,0,0.1)" : "none"
                          }}>
                            {msg.content}
                          </div>
                        </div>
                    ))}
                    {chatLoading && <TypingDots />}
                    <div ref={chatEndRef} />
                  </div>

                  <div style={{ borderTop: "1px solid #F1F5F9", padding: "20px", background: "#F8FAFC" }}>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 8, justifyContent: "center" }}>
                      {["Is this a big deal?", "Can this wait?", "How do I negotiate?"].map((q) => (
                        <button key={q} onClick={() => sendMessage(q)} disabled={chatLoading} style={{ padding: "10px 18px", borderRadius: 24, border: "1px solid #E2E8F0", background: "#fff", cursor: "pointer", color: "#0F172A", fontSize: 13, fontWeight: 700, transition: "all 0.1s" }}>{q}</button>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              {/* Full Details */}
              {(activeTab === "details" || !isMobile) && (
                <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
                   <div style={{ background: "#fff", border: "1px solid #E2E8F0", borderRadius: 32, padding: 32 }}>
                      <div style={{ fontSize: 12, fontWeight: 900, color: "#94A3B8", letterSpacing: "0.1em", marginBottom: 24 }}>FULL SERVICE BREAKDOWN</div>
                      
                      {/* Upcoming */}
                      {result.upcomingItems.length > 0 && (
                        <div style={{ marginBottom: 32 }}>
                          <div style={{ fontSize: 11, fontWeight: 800, color: "#64748B", marginBottom: 12 }}>UPCOMING (NEXT 12 MO)</div>
                          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                            {result.upcomingItems.map((item) => (
                              <div key={item.canonicalService} style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 16px", background: "#F8FAFC", borderRadius: 16 }}>
                                <div style={{ width: 8, height: 8, borderRadius: "50%", background: "#CBD5E1" }} />
                                <span style={{ fontSize: 14, color: "#374151", flex: 1, fontWeight: 700 }}>{item.displayName}</span>
                                {item.dueMileage && <span style={{ fontSize: 12, color: "#94A3B8", fontWeight: 700 }}>{item.dueMileage.toLocaleString()} mi</span>}
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* Verified History */}
                      <div>
                        <div style={{ fontSize: 11, fontWeight: 800, color: "#16A34A", marginBottom: 12 }}>VERIFIED & SOLID ({verifiedHistory.length})</div>
                        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                          {verifiedHistory.slice(0, 5).map((h, i) => (
                            <div key={i} style={{ display: "flex", justifyContent: "space-between", fontSize: 13, color: "#64748B", padding: "10px 0", borderBottom: "1px solid #F1F5F9" }}>
                              <div>
                                <div style={{ fontWeight: 800, color: "#0F172A" }}>{h.rawDescription}</div>
                                <div style={{ fontSize: 11, color: "#94A3B8" }}>{h.date || "Date unknown"}</div>
                              </div>
                              <span style={{ fontSize: 12, fontWeight: 900, color: "#16A34A" }}>{h.mileage?.toLocaleString()} mi</span>
                            </div>
                          ))}
                          {verifiedHistory.length > 5 && (
                             <div style={{ fontSize: 12, color: "#94A3B8", textAlign: "center", marginTop: 8 }}>+ {verifiedHistory.length - 5} more records verified</div>
                          )}
                        </div>
                      </div>
                   </div>
                </div>
              )}

           </div>
        )}

      </main>

      {/* ── Mobile Bottom Navigation ───────────────────────────────────────── */}
      {isMobile && (
        <nav style={{ position: "fixed", bottom: 0, left: 0, right: 0, height: 72, background: "#fff", borderTop: "1px solid #E2E8F0", display: "flex", alignItems: "center", justifyContent: "space-around", zIndex: 200, paddingBottom: "env(safe-area-inset-bottom)" }}>
          {[
            { id: "summary", label: "Verdict", icon: CheckCircle },
            { id: "negotiate", label: "Price", icon: Tag },
            { id: "pitch", label: "Pitch", icon: MessageSquare },
            { id: "advisor", label: "Advisor", icon: Shield },
            { id: "details", label: "Details", icon: TrendingDown }
          ].map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id as any)}
                style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4, background: "none", border: "none", cursor: "pointer", color: isActive ? "#4F46E5" : "#94A3B8", padding: "8px 4px" }}
              >
                <Icon size={20} strokeWidth={isActive ? 2.5 : 2} />
                <span style={{ fontSize: 10, fontWeight: 700 }}>{tab.label}</span>
              </button>
            );
          })}
        </nav>
      )}

      {/* ── Sticky Negotiation Bar (Floating above Mobile Nav or Desktop Bottom) ── */}
      {showSticky && (isMobile ? activeTab !== "negotiate" : true) && (
        <div style={{ position: "fixed", bottom: isMobile ? 72 : 24, left: isMobile ? 0 : "50%", transform: isMobile ? "none" : "translateX(-50%)", width: isMobile ? "100%" : "auto", minWidth: isMobile ? "none" : 500, background: "rgba(15, 23, 42, 0.95)", backdropFilter: "blur(12px)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: isMobile ? 0 : 20, padding: "16px 32px", zIndex: 100, display: "flex", alignItems: "center", justifyContent: "space-between", boxShadow: "0 20px 25px -5px rgba(0,0,0,0.3)" }}>
          <div style={{ display: "flex", gap: 40 }}>
            <div>
              <div style={{ fontSize: 9, fontWeight: 900, color: "rgba(255,255,255,0.4)", letterSpacing: "0.1em", marginBottom: 2 }}>CATCH-UP COST</div>
              <div style={{ fontSize: 20, fontWeight: 950, color: "#fff" }}>${Math.round(conditionDebt).toLocaleString()}</div>
            </div>
            <div>
              <div style={{ fontSize: 9, fontWeight: 900, color: "#4ADE80", letterSpacing: "0.1em", marginBottom: 2 }}>TARGET PRICE</div>
              <div style={{ fontSize: 20, fontWeight: 950, color: "#4ADE80" }}>${mv ? (Math.round((mv.low + mv.high)/2) - Math.round(conditionDebt)).toLocaleString() : "—"}</div>
            </div>
          </div>
          <button 
            onClick={() => { navigator.clipboard.writeText(guidance?.script || ""); alert("Negotiation pitch copied!"); }}
            style={{ padding: "12px 24px", borderRadius: 14, background: "linear-gradient(135deg, #6366F1 0%, #4F46E5 100%)", color: "#fff", border: "none", fontSize: 14, fontWeight: 800, cursor: "pointer", boxShadow: "0 4px 6px rgba(0,0,0,0.2)" }}
          >
            Copy Pitch
          </button>
        </div>
      )}
    </div>
  );
}
