"use client";

import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { useRouter, useParams, useSearchParams } from "next/navigation";
import {
  ChevronLeft, ChevronDown, Bot, Check, Clock, AlertTriangle,
  Pencil, X, Copy, Star, Send, ShieldCheck, Info, Zap, MessageSquare
} from "lucide-react";
import { supabase } from "@/lib/supabase";
import { generateCaseReport } from "@/lib/logic";
import { CURRENT_ANALYSIS_VERSION } from "@/lib/analysisVersion";
import type { StructuredResponse, AdvisorResponse, NegotiationResponse } from "@/app/api/advisor-chat/route";

// ─── Chat message type ─────────────────────────────────────────────────────────
interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  structured?: StructuredResponse;
}

// ─── Data Models ───
export type ServiceStatus = "pending" | "accepted" | "denied" | "hidden" | "wait" | "ask_shop";
export type DecisionState = "proceed" | "verify" | "wait" | "reconsider";

export interface ServiceExplanation {
  quickTake: string;
  worstCase: string;
  whenItMatters: string[];
  whyShopsRecommend: string[];
  whatIdDo: string;
  whatToSay: string;
}

export interface Service {
  id: string;
  name: string;
  vehicle?: string | null;
  price?: number | null;
  typicalRange?: { min?: number | null; max?: number | null };
  delta?: number | null;
  decision: DecisionState;
  status: ServiceStatus;
  recommendation?: string;
  shopContextLine?: string;
  explanation?: ServiceExplanation | "loading" | "error";
  negotiation?: NegotiationResponse | "loading" | null;
  rawItem?: any;
}

function mapReportToServices(report: any, vehicleStr: string | null): Service[] {
  if (!report) return [];
  const items: Service[] = [];
  const processBucket = (bucket: any[], defaultDecision: DecisionState) => {
    (bucket || []).forEach((item: any, i: number) => {
      const name =
        item.normalized_name === "Uncategorized Service" ||
        item.normalized_name === "Unclassified Service" ||
        !item.normalized_name
          ? item.raw_text || "Unknown Service"
          : item.normalized_name;
      const price = typeof item.price === "number" ? item.price : parseFloat(item.price) || 0;
      const priceHigh = item.market_range?.high || 0;
      const delta = priceHigh > 0 ? Math.round(price - priceHigh) : 0;
      let decision = defaultDecision;
      if (item.decision === "decline") decision = "reconsider";
      items.push({
        id: `${name}-${i}`,
        name,
        vehicle: vehicleStr,
        price,
        typicalRange: { min: item.market_range?.low || 0, max: item.market_range?.high || 0 },
        delta,
        decision,
        status: "pending",
        recommendation: item.pricing_explanation,
        shopContextLine:
          item.price_position === "above_market"
            ? `Priced above market at this ${report.shop_context?.shop_type || "shop"}`
            : "Fair market pricing",
        rawItem: item,
      });
    });
  };
  processBucket(report.red, "reconsider");
  processBucket(report.yellow, "verify");
  processBucket(report.green, "proceed");
  return items;
}

// ─── Main Component ───────────────────────────────────────────────────────────
export default function AuditPage() {
  const router = useRouter();
  const { id } = useParams();
  const caseId = id as string;
  const searchParams = useSearchParams();

  const [isInitializing, setIsInitializing] = useState(true);
  const [isPartialExtraction, setIsPartialExtraction] = useState(
    searchParams.get("partial") === "true"
  );

  const [caseData, setCaseData] = useState<any>(null);
  const [shopContext, setShopContext] = useState<any>(null);
  const [services, setServices] = useState<Service[]>([]);
  const [expandedCardIds, setExpandedCardIds] = useState<Set<string>>(new Set());

  // Chat
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [isTyping, setIsTyping] = useState(false);
  const [isChatOpen, setIsChatOpen] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const [showQuickReplies, setShowQuickReplies] = useState(false);
  const [shopExpanded, setShopExpanded] = useState(false);

  // Script block — shop actions generate these instead of chat messages
  const [activeScript, setActiveScript] = useState<{ title: string; text: string; serviceName: string } | null>(null);

  type AdvisorGoal = "decide" | "negotiate" | "pressure_test" | "understand_service" | "shop_around";

  // Shop action presets — these generate scripts, NOT chat messages
  const SHOP_ACTIONS = [
    "Ask for labor breakdown",
    "Ask if this can wait",
    "Ask about symptoms",
    "Ask for a better price",
    "Ask about bundle pricing",
    "Say I want to think about it",
  ];

  // Advisor action presets — these go to chat
  const ADVISOR_ACTIONS = [
    "Help me decide",
    "Is anything urgent?",
    "What should I do?",
    "Pressure test the shop",
  ];

  const generateScript = (action: string, serviceName: string): string => {
    const s = serviceName;
    switch (action) {
      case "Ask for labor breakdown":
        return `Hi — could you break out the labor and parts costs separately for the ${s}? I want to understand what I'm paying for.`;
      case "Ask if this can wait":
        return `Is the ${s} something that needs to happen this visit, or could it safely wait 2–3 months while I monitor it?`;
      case "Ask about symptoms":
        return `What specific issue or symptom triggered the recommendation for the ${s}? Is this based on something you observed, or is it a routine interval item?`;
      case "Ask for a better price":
        return `I'd like to move forward with the ${s}, but the price is a bit higher than I expected. Is there any flexibility there?`;
      case "Ask about bundle pricing":
        return `Since I'm already having multiple services done, is there any way to reduce the labor cost on the ${s} by combining it with the other work?`;
      case "Say I want to think about it":
        return `I appreciate the recommendation on the ${s}. I want to think it over before I commit — can I let you know before you start?`;
      default:
        return `Regarding the ${s}: ${action}`;
    }
  };


  // Vehicle
  const [vehicleEditMode, setVehicleEditMode] = useState(false);
  const [vehicleEdit, setVehicleEdit] = useState({ year: "", make: "", model: "" });
  const [isVehicleBarrierActive, setIsVehicleBarrierActive] = useState(false);

  // Manual entry
  const [isManualEntryOpen, setIsManualEntryOpen] = useState(false);
  const [manualEntry, setManualEntry] = useState({ name: "", price: "", notes: "" });
  const [isPasteOpen, setIsPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const [isParsingPaste, setIsParsingPaste] = useState(false);

  // Inline service edit
  const [editingServiceId, setEditingServiceId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState({ name: "", price: "" });

  // Watchouts
  const [isWatchOutsOpen, setIsWatchOutsOpen] = useState(false);
  const [watchOuts, setWatchOuts] = useState<any>(null);
  const [isFetchingWatchOuts, setIsFetchingWatchOuts] = useState(false);

  // Top-of-page AI summary (from boot structured response)
  const [topSummary, setTopSummary] = useState<string | null>(null);

  // Hide toast
  const [hideToast, setHideToast] = useState<{ serviceId: string; name: string } | null>(null);
  const hideToastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Script expansion — collapsed by default after first message
  const [expandedScriptIndices, setExpandedScriptIndices] = useState<Set<number>>(new Set());
  const toggleScript = (i: number) => setExpandedScriptIndices(prev => {
    const next = new Set(prev);
    next.has(i) ? next.delete(i) : next.add(i);
    return next;
  });

  const vehicleStr = useMemo(() => {
    if (!caseData) return null;
    const { vehicle_year, vehicle_make, vehicle_model } = caseData;
    return [vehicle_year, vehicle_make, vehicle_model].filter(Boolean).join(" ").trim() || null;
  }, [caseData]);

  // ─── Boot ────────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!caseId) return;
    async function boot() {
      try {
        const caseRes = await fetch(`/api/case/${caseId}`).then(r => r.ok ? r.json().then(d => d.case) : null);
        setCaseData(caseRes);
        const hasVehicle = !!(caseRes?.vehicle_year && caseRes?.vehicle_make);
        if (caseRes) {
          setVehicleEdit({
            year: caseRes.vehicle_year || "",
            make: caseRes.vehicle_make || "",
            model: caseRes.vehicle_model || "",
          });
          if (!hasVehicle) setIsVehicleBarrierActive(true);
        }

        const generatedReport = await generateCaseReport(caseId);
        setShopContext((generatedReport as any).shop_context);

        const vStr = [caseRes?.vehicle_year, caseRes?.vehicle_make, caseRes?.vehicle_model]
          .filter(Boolean)
          .join(" ");
        const mappedServices = mapReportToServices(generatedReport, vStr);
        setServices(mappedServices);

        // Auto-expand the most questionable service
        const topService =
          mappedServices.find((s) => s.decision === "reconsider") ||
          mappedServices.find((s) => s.decision === "verify") ||
          mappedServices[0];
        if (topService) setExpandedCardIds(new Set([topService.id]));

        // Pre-load intelligence ONLY for the auto-expanded card (rest load lazily on click)
        if (hasVehicle && topService) {
          fetchIntelligenceImmediate(
            topService.id, topService.name, topService.price || 0,
            topService.typicalRange?.min || undefined,
            topService.typicalRange?.max || undefined,
            vStr,
            (generatedReport as any).shop_context
          );
        }

        // Pre-fetch watchouts silently
        if (hasVehicle && vStr) {
          setIsFetchingWatchOuts(true);
          fetch("/api/vehicle-watchouts", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              vehicle: vStr,
              services: mappedServices.map((s: any) => s.name),
              mileage: caseData?.current_mileage ?? caseData?.mileage ?? null,
            }),
          })
            .then(r => r.json())
            .then(data => setWatchOuts(data))
            .catch(() => {})
            .finally(() => setIsFetchingWatchOuts(false));
        }


        // Load existing messages or trigger boot message
        const { data: msgRes } = await supabase
          .from("messages")
          .select("*")
          .eq("case_id", caseId)
          .order("created_at", { ascending: true });

        if (msgRes && msgRes.length > 0) {
          setMessages(msgRes);
        } else if (hasVehicle && mappedServices.length > 0) {
          // Proactive boot message
          triggerBootMessage(caseId, vStr, mappedServices, (generatedReport as any).shop_context);
        } else {
          setMessages([
            {
              role: "assistant",
              content: "I've reviewed your estimate. Ask me anything — I'll help you decide what to do.",
            },
          ]);
          setShowQuickReplies(true);
        }
      } catch (e) {
        console.error("Boot failed", e);
      } finally {
        setIsInitializing(false);
      }
    }
    boot();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [caseId]);

  const triggerBootMessage = async (
    caseId: string,
    vehicle: string,
    svcs: Service[],
    shop: any
  ) => {
    setIsTyping(true);
    try {
      const vParts = vehicle.trim().split(" ");
      const vehicleObj = vParts.length >= 3
        ? { year: vParts[0], make: vParts[1], model: vParts.slice(2).join(" ") }
        : { make: vehicle };

      const payload = {
        case_id: caseId,
        conversation: [
          { role: "user" as const, content: "I just uploaded my estimate. Give me a quick summary of what you see and tell me what to focus on first." }
        ],
        vehicle: vehicleObj,
        vehicle_intelligence: watchOuts?.watchOuts?.length ? {
          known_watchouts: watchOuts.watchOuts.map((w: any) => ({
            issue: w.title ?? w.description ?? String(w),
            description: w.description ?? "",
            severity: (w.severity ?? "").toLowerCase().includes("critical") ? "high"
              : (w.severity ?? "").toLowerCase().includes("high") ? "high" : "medium",
            evidenceStatus: w.evidenceStatus ?? "ambiguous",
            insight: w.insight ?? "",
            relatedServices: w.relatedCanonicalServices ?? [],
            relevance: w.negotiationRelevance ?? "medium",
          })),
          negotiationAngle: watchOuts.evidenceSummary?.negotiationAngle ?? null,
        } : undefined,
        shop: shop?.intelligence ? {
          name: shop.intelligence.name,
          grade: shop.intelligence.shop_grade,
          rating: shop.intelligence.rating,
          summary: shop.recommendation,
          specialization: shop.intelligence.shop_type,
        } : undefined,
        services: svcs.map((s) => ({
          id: s.id,
          name: s.name,
          price: s.price,
          marketMin: s.typicalRange?.min,
          marketMax: s.typicalRange?.max,
          deltaLabel: s.delta && s.delta > 20 ? `+$${s.delta} over market` : s.delta && s.delta < -20 ? "below market" : "fair price",
          status: s.status,
          decision: s.decision,
        })),
        current_focus_service_id: svcs.find(s => s.decision === "reconsider" || s.decision === "verify")?.id ?? svcs[0]?.id ?? null,
        user_goal: "decide" as const,
      };

      const resp = await fetch("/api/advisor-chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await resp.json();
      if (data.reply || data.structured) {
        const botMsg: ChatMessage = {
          role: "assistant",
          content: data.reply || "",
          structured: data.structured ?? undefined,
        };
        setMessages([botMsg]);
        setShowQuickReplies(true);

        // Populate top-of-page summary from structured boot response
        const s = data.structured;
        if (s?.mode === "advisor") {
          const lines = [
            s.headline,
            s.recommendation,
            s.next_step ? `Next: ${s.next_step}` : null,
          ].filter(Boolean);
          setTopSummary(lines.join(" · "));
        }

        setTimeout(() => messagesEndRef.current?.scrollIntoView({ behavior: "smooth" }), 100);
      }

    } catch {
      setMessages([{ role: "assistant", content: "I've reviewed your estimate. Ask me anything — I'll tell you exactly what to do." }]);
      setShowQuickReplies(true);
    } finally {
      setIsTyping(false);
    }
  };


  // ─── Per-service negotiation fetch ───────────────────────────────────────────
  const fetchNegotiationForService = useCallback(async (service: Service) => {
    // Skip if already loading or loaded
    if (service.negotiation) return;

    setServices(prev => prev.map(s => s.id === service.id ? { ...s, negotiation: "loading" } : s));

    try {
      const vParts = (vehicleStr || "").trim().split(" ");
      const vehicleObj = vParts.length >= 3
        ? { year: vParts[0], make: vParts[1], model: vParts.slice(2).join(" ") }
        : vehicleStr ? { make: vehicleStr } : undefined;

      const payload = {
        case_id: caseId,
        conversation: [
          { role: "user" as const, content: `Help me negotiate the ${service.name}.` }
        ],
        vehicle: vehicleObj,
        vehicle_intelligence: watchOuts?.watchOuts?.length ? {
          known_watchouts: watchOuts.watchOuts.map((w: any) => ({
            issue: w.title ?? w.description ?? String(w),
            description: w.description ?? "",
            severity: (w.severity ?? "").toLowerCase().includes("critical") ? "high"
              : (w.severity ?? "").toLowerCase().includes("high") ? "high" : "medium",
            evidenceStatus: w.evidenceStatus ?? "ambiguous",
            insight: w.insight ?? "",
            relatedServices: w.relatedCanonicalServices ?? [],
            relevance: w.negotiationRelevance ?? "medium",
          })),
          negotiationAngle: watchOuts.evidenceSummary?.negotiationAngle ?? null,
        } : undefined,
        shop: shopContext?.intelligence ? {
          name: shopContext.intelligence.name,
          grade: shopContext.intelligence.shop_grade,
          rating: shopContext.intelligence.rating,
          summary: shopContext.recommendation,
          specialization: shopContext.intelligence.shop_type,
        } : undefined,
        services: services.filter(s => s.status !== "hidden").map(s => ({
          id: s.id,
          name: s.name,
          price: s.price,
          marketMin: s.typicalRange?.min,
          marketMax: s.typicalRange?.max,
          deltaLabel: s.delta && s.delta > 20 ? `+$${s.delta} over market` : s.delta && s.delta < -20 ? "below market" : "fair price",
          status: s.status,
          decision: s.decision,
          analysis: typeof s.explanation === "object" ? {
            quickTake: (s.explanation as any).quickTake,
            whatIdDo: (s.explanation as any).whatIdDo,
            whatToSay: (s.explanation as any).whatToSay,
          } : undefined,
        })),
        current_focus_service_id: service.id,
        user_goal: "negotiate" as const,
      };

      const resp = await fetch("/api/advisor-chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await resp.json();
      const neg = data.structured?.mode === "negotiation" ? data.structured : null;
      setServices(prev => prev.map(s => s.id === service.id ? { ...s, negotiation: neg } : s));
    } catch {
      setServices(prev => prev.map(s => s.id === service.id ? { ...s, negotiation: null } : s));
    }
  }, [caseId, vehicleStr, services, shopContext, watchOuts]);

  const fetchIntelligenceImmediate = useCallback(
    async (
      serviceId: string,
      name: string,
      price: number,
      min?: number,
      max?: number,
      vStr?: string,
      shop?: any
    ) => {
      setServices((prev) =>
        prev.map((s) => (s.id === serviceId ? { ...s, explanation: "loading" } : s))
      );
      try {
        const res = await fetch("/api/service-explanation", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            service: name,
            vehicle: vStr || "Unknown Vehicle",
            price,
            typical_range: { min, max },
            shop: shop?.intelligence
              ? {
                  name: shop.intelligence.name,
                  rating: shop.intelligence.rating,
                  review_count: shop.intelligence.review_count,
                  shop_type: shop.intelligence.shop_type || "independent",
                }
              : undefined,
          }),
        });
        const data = await res.json();
        const expl = data.intelligence;
        setServices((prev) =>
          prev.map((s) =>
            s.id === serviceId
              ? {
                  ...s,
                  explanation: {
                    quickTake: expl.quick_take || "Intelligence loaded.",
                    worstCase: expl.worst_case || "Unknown risk if ignored.",
                    whenItMatters: expl.when_it_matters || [],
                    whyShopsRecommend: expl.why_shops_recommend || [],
                    whatIdDo: expl.what_id_do || "Seek clarification.",
                    whatToSay: expl.what_to_say || "",
                  },
                }
              : s
          )
        );
      } catch {
        setServices((prev) =>
          prev.map((s) => (s.id === serviceId ? { ...s, explanation: "error" } : s))
        );
      }
    },
    []
  );

  const fetchIntelligence = useCallback(
    async (serviceId: string, name: string, price: number, min?: number, max?: number) => {
      fetchIntelligenceImmediate(serviceId, name, price, min, max, vehicleStr || undefined, shopContext);
    },
    [vehicleStr, shopContext, fetchIntelligenceImmediate]
  );

  const saveVehicle = async () => {
    await supabase
      .from("cases")
      .update({
        vehicle_year: vehicleEdit.year,
        vehicle_make: vehicleEdit.make,
        vehicle_model: vehicleEdit.model,
      })
      .eq("id", caseId);
    setCaseData((prev: any) => ({
      ...prev,
      vehicle_year: vehicleEdit.year,
      vehicle_make: vehicleEdit.make,
      vehicle_model: vehicleEdit.model,
    }));
    setVehicleEditMode(false);
    setIsVehicleBarrierActive(false);
    const vStr = [vehicleEdit.year, vehicleEdit.make, vehicleEdit.model].filter(Boolean).join(" ");
    setServices((prev) => prev.map((s) => ({ ...s, vehicle: vStr })));
  };

  const handleAddService = async () => {
    if (!manualEntry.name) return;
    const priceNum = parseFloat(manualEntry.price) || 0;
    const { data: newItem, error } = await supabase
      .from("line_items")
      .insert({ case_id: caseId, raw_text: manualEntry.name, price: priceNum, item_type: "service_line" })
      .select()
      .single();
    if (error) return;
    const newService: Service = {
      id: newItem.id,
      name: manualEntry.name,
      price: priceNum,
      decision: "verify",
      status: "pending",
      vehicle: vehicleStr,
    };
    setServices((prev) => [newService, ...prev]);
    setManualEntry({ name: "", price: "", notes: "" });
    setIsManualEntryOpen(false);
    if (!isVehicleBarrierActive) fetchIntelligence(newService.id, newService.name, priceNum);
  };

  const commitServiceEdit = async (serviceId: string) => {
    const name = editDraft.name.trim();
    const price = parseFloat(editDraft.price) || 0;
    if (!name) { setEditingServiceId(null); return; }
    setServices(prev => prev.map(s => s.id === serviceId ? { ...s, name, price } : s));
    setEditingServiceId(null);
    // Persist to Supabase
    await supabase.from("estimate_items")
      .update({ raw_text: name, price })
      .eq("id", serviceId);
  };

  const handlePasteSubmit = async () => {
    if (!pasteText.trim()) return;
    setIsParsingPaste(true);
    try {
      const resp = await fetch("/api/ingest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: pasteText, case_id: caseId }),
      });
      const data = await resp.json();
      if (data.case_id) window.location.reload();
    } catch (e) {
      console.error("Paste failed", e);
    } finally {
      setIsParsingPaste(false);
    }
  };

  const openWatchOuts = async () => {
    setIsWatchOutsOpen(true);
    if (watchOuts || isFetchingWatchOuts) return;
    setIsFetchingWatchOuts(true);
    try {
      const res = await fetch("/api/vehicle-watchouts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          vehicle: vehicleStr,
          services: services.map((s) => s.name),
          mileage: caseData?.current_mileage ?? caseData?.mileage ?? null,
        }),
      });
      const data = await res.json();
      setWatchOuts(data);
    } catch {
    } finally {
      setIsFetchingWatchOuts(false);
    }
  };

  const toggleCard = (s: Service) => {
    setExpandedCardIds((prev) => {
      const next = new Set(prev);
      if (next.has(s.id)) {
        next.delete(s.id);
      } else {
        next.add(s.id);
        if (!s.explanation) fetchIntelligence(s.id, s.name, s.price || 0, s.typicalRange?.min || undefined, s.typicalRange?.max || undefined);
      }
      return next;
    });
  };

  const hideService = (service: Service) => {
    setServices((prev) => prev.map((s) => (s.id === service.id ? { ...s, status: "hidden" } : s)));
    setHideToast({ serviceId: service.id, name: service.name });
    if (hideToastTimer.current) clearTimeout(hideToastTimer.current);
    hideToastTimer.current = setTimeout(() => setHideToast(null), 5000);
  };

  const undoHide = () => {
    if (!hideToast) return;
    setServices((prev) => prev.map((s) => (s.id === hideToast.serviceId ? { ...s, status: "pending" } : s)));
    setHideToast(null);
    if (hideToastTimer.current) clearTimeout(hideToastTimer.current);
  };

  const submitChat = async (overrideMsg?: string) => {
    const msg = (overrideMsg ?? chatInput).trim();
    if (!msg) return;
    setIsChatOpen(true);
    setShowQuickReplies(false);
    setChatInput("");
    const updatedConversation = [...messages, { role: "user" as const, content: msg }];
    setMessages(updatedConversation);
    setIsTyping(true);
    try {
      // Detect user goal from message keywords
      const lc = msg.toLowerCase();
      const user_goal: AdvisorGoal =
        lc.includes("negotiat") || lc.includes("price") || lc.includes("come down") ? "negotiate"
        : lc.includes("pressure") || lc.includes("upsell") || lc.includes("legit") ? "pressure_test"
        : lc.includes("what is") || lc.includes("explain") || lc.includes("how does") ? "understand_service"
        : lc.includes("other shop") || lc.includes("shop around") || lc.includes("second opinion") ? "shop_around"
        : "decide";

      // Parse vehicle string back into object
      const vParts = (vehicleStr || "").trim().split(" ");
      const vehicleObj = vParts.length >= 3
        ? { year: vParts[0], make: vParts[1], model: vParts.slice(2).join(" ") }
        : vehicleStr ? { make: vehicleStr } : undefined;

      // Find focused service: prefer explicitly expanded card, then keyword match
      const expandedId = [...expandedCardIds][0] ?? null;
      const keywordMatch = services.find(s =>
        msg.toLowerCase().includes(s.name.toLowerCase().split(" ")[0])
      );
      const focusedServiceId = expandedId ?? keywordMatch?.id ?? null;

      // Serialize vehicle_intelligence from loaded watchouts
      const vehicleIntelligence = watchOuts?.watchOuts?.length ? {
        known_watchouts: watchOuts.watchOuts.map((w: any) => w.title ?? w.description ?? String(w)),
        related_current_services: watchOuts.related_service_note ? [watchOuts.related_service_note] : [],
      } : undefined;

      const payload = {
        case_id: caseId,
        conversation: updatedConversation.slice(-12),
        vehicle: vehicleObj,
        vehicle_intelligence: vehicleIntelligence,
        shop: shopContext?.intelligence ? {
          name: shopContext.intelligence.name,
          grade: shopContext.intelligence.shop_grade,
          rating: shopContext.intelligence.rating,
          summary: shopContext.recommendation,
          specialization: shopContext.intelligence.shop_type,
        } : undefined,
        services: services.filter(s => s.status !== "hidden").map(s => ({
          id: s.id,
          name: s.name,
          price: s.price,
          marketMin: s.typicalRange?.min,
          marketMax: s.typicalRange?.max,
          deltaLabel: s.delta && s.delta > 20 ? `+$${s.delta} over market` : s.delta && s.delta < -20 ? "below market" : "fair price",
          status: s.status,
          decision: s.decision,
          analysis: typeof s.explanation === "object" ? {
            quickTake: (s.explanation as any).quickTake,
            worstCase: (s.explanation as any).worstCase,
            whatIdDo: (s.explanation as any).whatIdDo,
            whatToSay: (s.explanation as any).whatToSay,
          } : undefined,
        })),
        current_focus_service_id: focusedServiceId,
        user_goal,
      };

      const resp = await fetch("/api/advisor-chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await resp.json();
      if (data.reply || data.structured) {
        const botMsg: ChatMessage = {
          role: "assistant",
          content: data.reply || "",
          structured: data.structured ?? undefined,
        };
        setMessages((prev) => [...prev, botMsg]);
      }
      setTimeout(() => messagesEndRef.current?.scrollIntoView({ behavior: "smooth" }), 100);
    } catch {
    } finally {
      setIsTyping(false);
    }
  };

  const activeServices = services.filter((s) => s.status !== "hidden");

  const hiddenServices = services.filter((s) => s.status === "hidden");

  // ─── Loading ──────────────────────────────────────────────────────────────────
  if (isInitializing) {
    return (
      <div className="min-h-screen bg-[#00236F] flex flex-col items-center justify-center text-white px-10">
        <div className="relative mb-10">
          <div className="w-24 h-24 rounded-full border-4 border-white/10 border-t-[#22C55E] animate-spin" />
          <div className="absolute inset-0 flex items-center justify-center">
            <ShieldCheck className="w-9 h-9 text-[#22C55E]" />
          </div>
        </div>
        <h2 className="text-2xl font-black italic uppercase tracking-tighter animate-pulse">
          Analyzing your estimate…
        </h2>
      </div>
    );
  }

  // ─── Render ───────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-[#F4F6FB] font-sans flex flex-col">

      {/* ── HEADER ── */}
      <header className="bg-white border-b border-slate-200 sticky top-0 z-40 px-4 h-14 flex items-center">
        <div className="flex items-center gap-3 w-full max-w-7xl mx-auto">
          <button onClick={() => router.push("/")} className="p-2 -ml-2 rounded-lg hover:bg-slate-100">
            <ChevronLeft className="w-5 h-5 text-slate-600" />
          </button>
          <div className="flex-1 flex items-center justify-between">
            <div onClick={() => setVehicleEditMode(true)} className="cursor-pointer group flex items-center gap-2">
              <div>
                <p className="text-[9px] text-slate-400 uppercase tracking-widest font-bold">Auditing for</p>
                <h1 className="text-sm font-black text-[#0D1C2E] flex items-center gap-1 group-hover:text-[#00236F]">
                  {vehicleStr || "Set Vehicle"} <Pencil className="w-3 h-3 opacity-40" />
                </h1>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setIsManualEntryOpen(true)}
                className="flex items-center gap-1.5 text-[11px] font-black text-slate-600 bg-slate-100 hover:bg-slate-200 px-3 py-1.5 rounded-full transition-colors"
              >
                <Pencil className="w-3 h-3" /> Add Service
              </button>
              <button
                onClick={() => setIsPasteOpen(true)}
                className="flex items-center gap-1.5 text-[11px] font-black text-slate-600 bg-slate-100 hover:bg-slate-200 px-3 py-1.5 rounded-full transition-colors"
              >
                <Copy className="w-3 h-3" /> Paste
              </button>
            </div>
          </div>
        </div>
      </header>

      {/* ── MODALS ── */}
      {(vehicleEditMode || isVehicleBarrierActive) && (
        <div
          className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4 backdrop-blur-sm"
          onClick={(e) => { if (e.target === e.currentTarget && !isVehicleBarrierActive) setVehicleEditMode(false); }}
        >
          <div className="bg-white w-full max-w-md rounded-[32px] p-8 shadow-2xl animate-in zoom-in-95 duration-200">
            <div className="w-12 h-12 bg-blue-50 rounded-2xl flex items-center justify-center mb-6">
              <Star className="w-6 h-6 text-[#00236F]" />
            </div>
            <h3 className="font-black text-2xl text-[#0D1C2E] mb-2">
              {isVehicleBarrierActive ? "What car is this for?" : "Edit Vehicle"}
            </h3>
            <p className="text-sm text-slate-500 font-medium mb-6">
              {isVehicleBarrierActive
                ? "Vehicle context is required for decision-grade analysis."
                : "Update for more accurate market data."}
            </p>
            <div className="space-y-4 mb-8">
              {(["year", "make", "model"] as const).map((f) => (
                <div key={f} className="relative">
                  <p className="absolute left-4 top-2 text-[10px] font-black uppercase tracking-widest text-[#00236F]/40">{f}</p>
                  <input
                    value={vehicleEdit[f]}
                    onChange={(e) => setVehicleEdit((prev) => ({ ...prev, [f]: e.target.value }))}
                    placeholder={`e.g. ${f === "year" ? "2022" : f === "make" ? "Audi" : "S4"}`}
                    className="w-full border border-slate-200 bg-slate-50 rounded-2xl px-4 pt-7 pb-3 text-[15px] font-bold text-[#0D1C2E] focus:bg-white focus:border-[#00236F] focus:ring-4 focus:ring-blue-50 transition-all outline-none"
                  />
                </div>
              ))}
            </div>
            <button
              onClick={saveVehicle}
              className="w-full h-14 bg-[#00236F] text-white rounded-2xl font-black uppercase tracking-widest text-[13px] shadow-[0_10px_30px_rgba(0,35,111,0.2)] active:scale-95 transition-all"
            >
              Save Vehicle
            </button>
          </div>
        </div>
      )}

      {isManualEntryOpen && (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4 backdrop-blur-sm"
          onClick={(e) => { if (e.target === e.currentTarget) setIsManualEntryOpen(false); }}>
          <div className="bg-white w-full max-w-md rounded-[32px] p-8 shadow-2xl animate-in zoom-in-95 duration-200">
            <div className="flex justify-between items-center mb-6">
              <h3 className="font-black text-2xl text-[#0D1C2E]">Add Service</h3>
              <button onClick={() => setIsManualEntryOpen(false)} className="p-2 hover:bg-slate-100 rounded-full"><X className="w-5 h-5 text-slate-400" /></button>
            </div>
            <div className="space-y-4 mb-8">
              <div className="relative">
                <p className="absolute left-4 top-2 text-[10px] font-black uppercase tracking-widest text-[#00236F]/40">Service Name</p>
                <input value={manualEntry.name} onChange={(e) => setManualEntry((p) => ({ ...p, name: e.target.value }))}
                  placeholder="e.g. Brake Pad Replacement"
                  className="w-full border border-slate-200 bg-slate-50 rounded-2xl px-4 pt-7 pb-3 text-[15px] font-bold text-[#0D1C2E] focus:bg-white focus:border-[#00236F] focus:ring-4 focus:ring-blue-50 transition-all outline-none" />
              </div>
              <div className="relative">
                <p className="absolute left-4 top-2 text-[10px] font-black uppercase tracking-widest text-[#00236F]/40">Price</p>
                <input value={manualEntry.price} onChange={(e) => setManualEntry((p) => ({ ...p, price: e.target.value }))}
                  placeholder="$0.00"
                  className="w-full border border-slate-200 bg-slate-50 rounded-2xl px-4 pt-7 pb-3 text-[15px] font-bold text-[#0D1C2E] focus:bg-white focus:border-[#00236F] focus:ring-4 focus:ring-blue-50 transition-all outline-none" />
              </div>
              <div className="relative">
                <p className="absolute left-4 top-2 text-[10px] font-black uppercase tracking-widest text-[#00236F]/40">Notes (optional)</p>
                <input value={manualEntry.notes} onChange={(e) => setManualEntry((p) => ({ ...p, notes: e.target.value }))}
                  placeholder="e.g. shop said it's needed, no symptoms"
                  className="w-full border border-slate-200 bg-slate-50 rounded-2xl px-4 pt-7 pb-3 text-[15px] font-bold text-[#0D1C2E] focus:bg-white focus:border-[#00236F] focus:ring-4 focus:ring-blue-50 transition-all outline-none" />
              </div>
            </div>
            <button onClick={handleAddService} className="w-full h-14 bg-[#00236F] text-white rounded-2xl font-black uppercase tracking-widest text-[13px] shadow-[0_10px_30px_rgba(0,35,111,0.2)] active:scale-95 transition-all">
              Add to Audit
            </button>
          </div>
        </div>
      )}

      {isPasteOpen && (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4 backdrop-blur-sm"
          onClick={(e) => { if (e.target === e.currentTarget) setIsPasteOpen(false); }}>
          <div className="bg-white w-full max-w-lg rounded-[32px] p-8 shadow-2xl animate-in zoom-in-95 duration-200">
            <div className="flex justify-between items-center mb-4">
              <h3 className="font-black text-2xl text-[#0D1C2E]">Paste Estimate</h3>
              <button onClick={() => setIsPasteOpen(false)} className="p-2 hover:bg-slate-100 rounded-full"><X className="w-5 h-5 text-slate-400" /></button>
            </div>
            <p className="text-sm text-slate-500 font-medium mb-4">Paste your estimate text — we'll extract the services automatically.</p>
            <textarea value={pasteText} onChange={(e) => setPasteText(e.target.value)} placeholder="Paste here..."
              className="w-full h-40 border border-slate-200 bg-slate-50 rounded-2xl p-4 text-[14px] font-medium text-[#0D1C2E] focus:bg-white focus:border-[#00236F] focus:ring-4 focus:ring-blue-50 transition-all outline-none mb-6 resize-none" />
            <button onClick={handlePasteSubmit} disabled={isParsingPaste}
              className="w-full h-14 bg-[#00236F] text-white rounded-2xl font-black uppercase tracking-widest text-[13px] shadow-[0_10px_30px_rgba(0,35,111,0.2)] active:scale-95 transition-all disabled:opacity-50">
              {isParsingPaste ? "Processing..." : "Run Analysis"}
            </button>
          </div>
        </div>
      )}

      {isWatchOutsOpen && (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4 backdrop-blur-sm"
          onClick={(e) => { if (e.target === e.currentTarget) setIsWatchOutsOpen(false); }}>
          <div className="bg-white w-full max-w-lg max-h-[85vh] overflow-y-auto rounded-3xl p-8 shadow-2xl animate-in zoom-in-95 duration-200">
            <div className="flex justify-between items-start mb-6">
              <div>
                <p className="text-[10px] text-[#00236F] uppercase tracking-widest font-black mb-1">Vehicle Intelligence</p>
                <h3 className="font-black text-2xl text-[#0D1C2E] leading-tight">What to watch on your {vehicleStr}</h3>
                {watchOuts?.evidenceSummary?.negotiationAngle && (
                  <p className="text-[12px] text-amber-600 font-semibold mt-1.5 bg-amber-50 border border-amber-200 rounded-lg px-3 py-1.5">
                    💰 {watchOuts.evidenceSummary.negotiationAngle}
                  </p>
                )}
              </div>
              <button onClick={() => setIsWatchOutsOpen(false)} className="p-2 hover:bg-slate-100 rounded-full shrink-0"><X className="w-5 h-5 text-slate-400" /></button>
            </div>
            {isFetchingWatchOuts && !watchOuts ? (
              <div className="py-12 flex flex-col items-center justify-center text-center">
                <div className="w-8 h-8 rounded-full border-2 border-slate-200 border-t-[#00236F] animate-spin mb-4" />
                <p className="text-sm font-medium text-slate-500">Retrieving platform history…</p>
              </div>
            ) : watchOuts ? (
              <div className="space-y-4">
                {watchOuts.related_service_note && (
                  <div className="bg-[#00236F]/5 border border-[#00236F]/20 rounded-xl p-4">
                    <p className="text-[13px] font-bold text-[#0D1C2E] leading-relaxed">🔍 {watchOuts.related_service_note}</p>
                  </div>
                )}
                {watchOuts.watchOuts?.map((w: any, i: number) => {
                  const ev = w.evidenceStatus;
                  const evConfig = ev === "present"
                    ? { label: "Service in estimate", className: "bg-green-50 text-green-700 border-green-200" }
                    : ev === "missing"
                    ? { label: "Not in estimate", className: "bg-red-50 text-red-700 border-red-200" }
                    : ev === "not_yet_relevant"
                    ? { label: "Not yet relevant", className: "bg-slate-50 text-slate-500 border-slate-200" }
                    : { label: "Verify", className: "bg-amber-50 text-amber-700 border-amber-200" };
                  return (
                    <div key={i} className="border border-slate-200 rounded-2xl p-4">
                      <div className="flex items-center gap-2 flex-wrap mb-2">
                        <span className={`text-[9px] font-black uppercase tracking-wider px-2 py-0.5 rounded inline-block ${w.severity?.includes("Critical") ? "bg-red-100 text-red-700" : "bg-amber-50 text-amber-700"}`}>
                          {w.severity}
                        </span>
                        {ev && (
                          <span className={`text-[9px] font-black uppercase tracking-wider px-2 py-0.5 rounded border inline-block ${evConfig.className}`}>
                            {evConfig.label}
                          </span>
                        )}
                      </div>
                      <h4 className="font-black text-[#0D1C2E] text-[15px] mb-1">{w.title}</h4>
                      <p className="text-slate-600 text-[13px] leading-relaxed font-medium mb-2">{w.description}</p>
                      {w.insight && (
                        <p className={`text-[12px] leading-relaxed px-3 py-2 rounded-lg border ${
                          ev === "missing" ? "bg-red-50 border-red-100 text-red-700 font-semibold"
                          : ev === "present" ? "bg-green-50 border-green-100 text-green-700"
                          : "bg-slate-50 border-slate-100 text-slate-600"
                        }`}>
                          {w.insight}
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="text-sm text-slate-500 text-center py-8">Failed to retrieve platform intelligence.</p>
            )}
          </div>
        </div>
      )}

      {/* ── UNDO TOAST ── */}
      {hideToast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 bg-[#0D1C2E] text-white px-5 py-3 rounded-2xl shadow-2xl flex items-center gap-4 animate-in slide-in-from-bottom-4 duration-200">
          <span className="text-[13px] font-medium">"{hideToast.name}" hidden</span>
          <button onClick={undoHide} className="text-[13px] font-black text-[#22C55E] hover:underline">Undo</button>
        </div>
      )}

      {/* ── BODY: CHAT LEFT, SERVICES RIGHT ── */}
      <main className="flex-1 w-full max-w-7xl mx-auto p-4 md:p-6 flex flex-col lg:flex-row gap-6">

        {/* ── LEFT: CHAT (PRIMARY) ── */}
        <div className={`
          lg:sticky lg:top-20 lg:h-[calc(100vh-6rem)] lg:w-[420px] shrink-0 flex flex-col
          fixed bottom-0 left-0 right-0 z-40 bg-white lg:bg-white lg:rounded-2xl lg:border lg:border-slate-200 lg:shadow-lg
          border-t border-slate-200 transition-transform
          ${isChatOpen ? "translate-y-0 h-[72vh]" : "translate-y-[calc(100%-68px)] lg:translate-y-0"}
        `}>
          {/* Chat header */}
          <div
            className="bg-[#00236F] lg:rounded-t-2xl p-4 flex items-center justify-between cursor-pointer lg:cursor-default shrink-0"
            onClick={() => setIsChatOpen(!isChatOpen)}
          >
            <div className="flex items-center gap-2.5">
              <div className="w-8 h-8 rounded-full bg-white/10 flex items-center justify-center">
                <Bot className="w-4 h-4 text-blue-200" />
              </div>
              <div>
                <h2 className="text-white font-black text-[14px]">WrenchCheck Advisor</h2>
                <p className="text-[10px] font-medium text-blue-200/80">Tells you exactly what to do next</p>
              </div>
            </div>
            <ChevronDown className={`w-5 h-5 text-blue-200 lg:hidden transition-transform ${isChatOpen ? "" : "rotate-180"}`} />
          </div>

          {/* Messages */}
          <div className="flex-1 overflow-y-auto p-4 space-y-4 bg-white">
            {messages.map((m, i) => {
              // User bubble — plain
              if (m.role === "user") {
                return (
                  <div key={i} className="flex justify-end">
                    <div className="max-w-[85%] px-4 py-3 rounded-2xl rounded-br-sm bg-[#00236F] text-white text-[13px] leading-relaxed font-medium">
                      {m.content}
                    </div>
                  </div>
                );
              }

              // Structured assistant card
              if (m.structured) {
                const s = m.structured;
                const isNeg = s.mode === "negotiation";
                const neg = isNeg ? (s as NegotiationResponse) : null;
                const adv = !isNeg ? (s as AdvisorResponse) : null;

                const levelColors: Record<string, string> = {
                  easy_ask:    "bg-emerald-100 text-emerald-700 border-emerald-200",
                  clarify:     "bg-amber-100  text-amber-700  border-amber-200",
                  price_match: "bg-red-100    text-red-700    border-red-200",
                  bundle:      "bg-purple-100 text-purple-700 border-purple-200",
                  walk_away:   "bg-slate-100  text-slate-700  border-slate-200",
                };
                const levelLabel: Record<string, string> = {
                  easy_ask: "Easy ask", clarify: "Clarify first",
                  price_match: "Price match", bundle: "Bundle it", walk_away: "Walk away",
                };

                return (
                  <div key={i} className="flex justify-start">
                    <div className="w-full max-w-full space-y-2">

                      {/* Mode indicator */}
                      <div className="flex items-center gap-2">
                        <div className="w-6 h-6 rounded-full bg-[#00236F]/10 flex items-center justify-center">
                          <Bot className="w-3.5 h-3.5 text-[#00236F]" />
                        </div>
                        {isNeg && neg?.negotiation_level && (
                          <span className={`text-[9px] font-black uppercase tracking-widest px-2 py-0.5 rounded border ${levelColors[neg.negotiation_level] ?? "bg-slate-100 text-slate-600 border-slate-200"}`}>
                            {levelLabel[neg.negotiation_level] ?? neg.negotiation_level}
                          </span>
                        )}
                        {isNeg && neg?.leverage_score != null && (
                          <span className="text-[9px] font-bold text-slate-400">
                            leverage {Math.round((neg.leverage_score) * 100)}%
                          </span>
                        )}


                      </div>

                      {/* Card */}
                      <div className="bg-slate-50 border border-slate-200 rounded-2xl rounded-tl-sm overflow-hidden">

                        {/* Headline */}
                        <div className="px-4 pt-4 pb-2">
                          <p className="text-[11px] font-black uppercase tracking-widest text-[#00236F]/60 mb-1">
                            {isNeg
                              ? "Negotiation"
                              : adv?.current_step
                                ? `Current step: ${adv.current_step}`
                                : "Advisor"}
                          </p>
                          <h4 className="text-[14px] font-black text-[#0D1C2E] leading-snug">{s.headline}</h4>
                        </div>

                        {/* Recommendation */}
                        <div className="px-4 pb-3">
                          <p className="text-[13px] font-medium text-[#0D1C2E] leading-relaxed">{s.recommendation}</p>
                        </div>

                        {/* Reasoning */}
                        {s.reasoning?.length > 0 && (
                          <div className="px-4 pb-3 space-y-1">
                            {s.reasoning.map((r, ri) => (
                              <div key={ri} className="flex items-start gap-2">
                                <span className="w-1 h-1 rounded-full bg-[#00236F] mt-2 shrink-0" />
                                <p className="text-[12px] text-slate-600 font-medium leading-relaxed">{r}</p>
                              </div>
                            ))}
                          </div>
                        )}

                        {/* Next step (advisor only) */}
                        {adv?.next_step && (
                          <div className="mx-4 mb-2 bg-[#00236F]/5 border border-[#00236F]/10 rounded-xl p-3">
                            <p className="text-[10px] font-black uppercase tracking-widest text-[#00236F]/60 mb-1">Next step</p>
                            <p className="text-[12px] font-bold text-[#0D1C2E]">{adv.next_step}</p>
                          </div>
                        )}

                        {/* Done when (advisor only) */}
                        {adv?.done_when && (
                          <div className="mx-4 mb-3 flex items-start gap-2">
                            <span className="text-[10px] mt-0.5">✔️</span>
                            <p className="text-[11px] font-medium text-slate-400 leading-relaxed italic">{adv.done_when}</p>
                          </div>
                        )}

                        {/* Shop script — collapsed by default after first message */}
                        {s.shop_script && (() => {
                          const isExpanded = expandedScriptIndices.has(i) || messages.length <= 1;
                          return (
                            <div className="mx-4 mb-3">
                              <button
                                onClick={() => toggleScript(i)}
                                className="flex items-center gap-1.5 text-[10px] font-black text-slate-400 hover:text-[#00236F] transition-colors mb-1.5"
                              >
                                <span className={`transition-transform ${isExpanded ? "rotate-90" : ""}`}>▶</span>
                                {isExpanded ? "Hide script" : "View script"}
                              </button>
                              {isExpanded && (
                                <div className="bg-white border border-slate-200 rounded-xl p-3">
                                  <div className="flex items-center justify-between mb-1.5">
                                    <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">
                                      {isNeg ? "Say this" : "Script"}
                                    </p>
                                    <button
                                      onClick={() => navigator.clipboard.writeText(s.shop_script)}
                                      className="text-[9px] font-black text-[#00236F] bg-[#EFF4FF] px-2 py-0.5 rounded transition-colors"
                                    >
                                      Copy
                                    </button>
                                  </div>
                                  <p className="text-[12px] font-medium text-[#0D1C2E] leading-relaxed italic">
                                    &ldquo;{s.shop_script}&rdquo;
                                  </p>
                                </div>
                              )}
                            </div>
                          );
                        })()}

                        {/* Backup script (negotiation only) — also collapsed */}
                        {neg?.backup_script && (() => {
                          const backupKey = i + 10000;
                          const isExpanded = expandedScriptIndices.has(backupKey);
                          return (
                            <div className="mx-4 mb-3">
                              <button
                                onClick={() => toggleScript(backupKey)}
                                className="flex items-center gap-1.5 text-[10px] font-black text-amber-600/70 hover:text-amber-700 transition-colors mb-1.5"
                              >
                                <span className={`transition-transform ${isExpanded ? "rotate-90" : ""}`}>▶</span>
                                {isExpanded ? "Hide backup script" : "If they push back"}
                              </button>
                              {isExpanded && (
                                <div className="bg-amber-50 border border-amber-100 rounded-xl p-3">
                                  <p className="text-[12px] font-medium text-[#0D1C2E] leading-relaxed italic">
                                    &ldquo;{neg.backup_script}&rdquo;
                                  </p>
                                </div>
                              )}
                            </div>
                          );
                        })()}

                      </div>
                    </div>
                  </div>
                );
              }

              // Plain assistant message (fallback / boot)
              return (
                <div key={i} className="flex justify-start">
                  <div className="max-w-[88%] px-4 py-3 rounded-2xl rounded-bl-sm bg-slate-100 text-[#0D1C2E] text-[13px] leading-relaxed font-medium border border-slate-200 whitespace-pre-line">
                    {m.content}
                  </div>
                </div>
              );
            })}
            {isTyping && (
              <div className="flex justify-start">
                <div className="bg-slate-100 border border-slate-200 rounded-xl px-4 py-3 flex gap-1.5 rounded-bl-sm">
                  <span className="w-1.5 h-1.5 bg-slate-400 rounded-full animate-bounce" />
                  <span className="w-1.5 h-1.5 bg-slate-400 rounded-full animate-bounce [animation-delay:0.1s]" />
                  <span className="w-1.5 h-1.5 bg-slate-400 rounded-full animate-bounce [animation-delay:0.2s]" />
                </div>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>

          {/* Dynamic chips — from most recent structured response, or static fallback on first message */}
          {(() => {
            const lastStructured = [...messages].reverse().find(m => (m as any).structured?.follow_up_options?.length > 0);
            const dynamicChips: string[] = (lastStructured as any)?.structured?.follow_up_options ?? [];
            const staticChips = ["What should I do next?", "What do I say to the shop?", "Can I wait on this?"];
            const chips = dynamicChips.length > 0 ? dynamicChips : (showQuickReplies ? staticChips : []);
            if (!chips.length || isTyping) return null;
            return (
              <div className="px-3 pb-2 pt-1 flex flex-wrap gap-1.5 bg-white border-t border-slate-100">
                {chips.map((q) => (
                  <button key={q} onClick={() => submitChat(q)}
                    className="text-left text-[11px] font-bold text-[#00236F] bg-[#EFF4FF] hover:bg-[#00236F] hover:text-white px-3 py-1.5 rounded-xl transition-all border border-blue-100">
                    {q}
                  </button>
                ))}
              </div>
            );
          })()}


          {/* Script block — appears when a shop action is triggered */}
          {activeScript && (
            <div className="mx-3 mb-2 bg-slate-50 border border-slate-200 rounded-2xl overflow-hidden">
              <div className="px-4 py-2.5 border-b border-slate-100 flex items-center justify-between">
                <p className="text-[10px] font-black uppercase tracking-widest text-slate-500">Message to your shop</p>
                <button onClick={() => setActiveScript(null)} className="text-slate-400 hover:text-slate-600">
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
              <div className="px-4 py-3">
                <p className="text-[13px] font-medium text-[#0D1C2E] leading-relaxed italic">&ldquo;{activeScript.text}&rdquo;</p>
              </div>
              <div className="px-4 pb-3 flex flex-wrap gap-2">
                <button
                  onClick={() => navigator.clipboard.writeText(activeScript.text)}
                  className="text-[10px] font-black text-white bg-[#00236F] hover:bg-[#001540] px-3 py-1.5 rounded-lg transition-colors">
                  Copy
                </button>
                <button
                  onClick={() => setActiveScript(s => s ? { ...s, text: generateScript("Ask for a better price", s.serviceName) + " I need this addressed before I approve it." } : s)}
                  className="text-[10px] font-black text-red-700 bg-red-50 hover:bg-red-100 border border-red-200 px-3 py-1.5 rounded-lg transition-colors">
                  Make firmer
                </button>
                <button
                  onClick={() => setActiveScript(s => s ? { ...s, text: s.text.replace(/ I need this addressed before I approve it\./, "").replace(/\?$/, " — no rush, just want to understand.") } : s)}
                  className="text-[10px] font-black text-blue-700 bg-blue-50 hover:bg-blue-100 border border-blue-200 px-3 py-1.5 rounded-lg transition-colors">
                  Make softer
                </button>
                <button
                  onClick={() => { setIsChatOpen(true); submitChat(`Help me refine this message to the shop about the ${activeScript.serviceName}: "${activeScript.text}"`); setActiveScript(null); }}
                  className="text-[10px] font-black text-slate-600 bg-slate-100 hover:bg-slate-200 border border-slate-200 px-3 py-1.5 rounded-lg transition-colors">
                  Work through in chat
                </button>
              </div>
            </div>
          )}

          {/* Input */}
          <div className="p-3 bg-white border-t border-slate-100 lg:rounded-b-2xl shrink-0">
            <div className="relative">
              <input
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && submitChat()}
                onFocus={() => setIsChatOpen(true)}
                placeholder="Ask anything about your estimate…"
                className="w-full bg-slate-100 border-none rounded-xl pl-4 pr-12 py-3.5 text-[13px] font-medium text-[#0D1C2E] focus:ring-2 focus:ring-[#00236F] transition-all placeholder:text-slate-400 outline-none"
              />
              <button onClick={() => submitChat()} disabled={isTyping}
                className="absolute right-2 top-2 bottom-2 w-10 flex items-center justify-center bg-[#00236F] hover:bg-[#001540] text-white rounded-lg transition-colors disabled:opacity-50">
                <Send className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>

        {/* ── RIGHT: SERVICES ── */}
        <div className="flex-1 space-y-4 pb-24 lg:pb-8 min-w-0">

          {/* Partial warning */}
          {isPartialExtraction && (
            <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4 flex items-start gap-3">
              <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
              <div className="flex-1">
                <p className="text-[13px] font-black text-amber-900 mb-0.5">We couldn't fully extract everything</p>
                <p className="text-[12px] text-amber-700 font-medium">Likely service items are shown below. Edit any that look wrong, or add missing ones above.</p>
              </div>
              <button onClick={() => setIsPartialExtraction(false)} className="shrink-0 text-amber-400 hover:text-amber-600">
                <X className="w-4 h-4" />
              </button>
            </div>
          )}

          {/* Shop card — expandable */}
          {shopContext?.intelligence && (
            <div
              className="bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden cursor-pointer"
              onClick={() => setShopExpanded(!shopExpanded)}
            >
              <div className="px-5 py-4 flex items-center gap-4">
                <div className="shrink-0 w-10 h-10 bg-[#00236F]/10 rounded-full flex items-center justify-center">
                  <Star className="w-5 h-5 text-[#00236F]" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h3 className="font-black text-[#0D1C2E] text-sm">{shopContext.intelligence.name || "Shop"}</h3>
                    {shopContext.intelligence.rating && (
                      <span className="text-[11px] font-bold text-amber-600">⭐ {shopContext.intelligence.rating}</span>
                    )}
                    {shopContext.intelligence.shop_grade && (
                      <span className="text-[9px] bg-[#00236F] text-white px-2 py-0.5 rounded font-bold uppercase tracking-widest">
                        Grade {shopContext.intelligence.shop_grade}
                      </span>
                    )}
                  </div>
                  <p className="text-[12px] text-slate-500 font-medium mt-0.5">
                    {shopContext.recommendation || "Shop data analyzed — tap to expand."}
                  </p>
                </div>
                <ChevronDown className={`w-5 h-5 text-slate-400 shrink-0 transition-transform ${shopExpanded ? 'rotate-180' : ''}`} />
              </div>
              {shopExpanded && (
                <div className="px-5 pb-5 pt-0 border-t border-slate-100 space-y-4 animate-in fade-in duration-150">
                  {shopContext.intelligence.review_count && (
                    <p className="text-[12px] text-slate-500 font-medium pt-3">{shopContext.intelligence.review_count.toLocaleString()} reviews</p>
                  )}
                  {shopContext.intelligence.reputation_summary && (
                    <p className="text-[13px] text-slate-700 font-medium leading-relaxed">{shopContext.intelligence.reputation_summary}</p>
                  )}
                  <div className="bg-blue-50 border border-blue-100 rounded-xl p-4">
                    <p className="text-[10px] font-black uppercase tracking-widest text-[#00236F] mb-1">What this means for you</p>
                    <p className="text-[13px] font-medium text-[#0D1C2E] leading-relaxed">
                      {shopContext.intelligence.shop_grade === 'A'
                        ? "Strong reputation — pricing may reflect quality. Still worth verifying any items flagged above market."
                        : shopContext.intelligence.shop_grade === 'B'
                        ? "Good shop overall. Verify any services priced above market — they may be upselling on routine items."
                        : "Use caution. Cross-check any recommendations and pricing against market rates before agreeing."}
                    </p>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Vehicle intelligence inline card */}
          {vehicleStr && (
            <div className="bg-gradient-to-r from-[#00236F] to-[#0037A8] rounded-2xl p-5 text-white shadow-md">
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <p className="text-[10px] font-black uppercase tracking-widest text-blue-200 mb-0.5">🧠 Vehicle Intelligence — Known Watchouts</p>
                  <h3 className="font-black text-[14px] mb-1">Your {vehicleStr}</h3>
                  <p className="text-[11px] text-blue-300 font-medium mb-3">Most common high-cost risks for this vehicle</p>
                  {watchOuts?.watchOuts ? (
                    <>
                      <ul className="space-y-1 mb-2">
                        {watchOuts.watchOuts.slice(0, 3).map((w: any, i: number) => {
                          const isMissing = w.evidenceStatus === "missing";
                          const isPresent = w.evidenceStatus === "present";
                          return (
                            <li key={i} className="text-[12px] text-blue-100 font-medium flex items-start gap-1.5">
                              <span className={`mt-0.5 shrink-0 ${isMissing ? "text-red-300" : isPresent ? "text-green-300" : "text-amber-400"}`}>
                                {isMissing ? "⚠️" : isPresent ? "✓" : "•"}
                              </span>
                              <span>{w.title}
                                {isMissing && <span className="text-red-300 text-[10px] ml-1">— not in estimate</span>}
                              </span>
                            </li>
                          );
                        })}
                      </ul>
                      {(watchOuts.evidenceSummary?.missingCount ?? 0) > 0 && (
                        <p className="text-[11px] text-red-300 font-semibold">
                          {watchOuts.evidenceSummary.missingCount} known issue{watchOuts.evidenceSummary.missingCount > 1 ? "s" : ""} with no supporting service
                        </p>
                      )}
                    </>
                  ) : isFetchingWatchOuts ? (
                    <div className="flex items-center gap-2 text-blue-200">
                      <div className="w-3 h-3 rounded-full border-2 border-blue-300 border-t-white animate-spin" />
                      <span className="text-[11px] font-medium">Loading platform risks…</span>
                    </div>
                  ) : (
                    <p className="text-[12px] text-blue-200">Tap "View all risks" to load platform-specific risk data.</p>
                  )}
                </div>
                <button
                  onClick={openWatchOuts}
                  className="shrink-0 text-[11px] font-black bg-white/10 hover:bg-white/20 text-white px-3 py-2 rounded-xl transition-colors whitespace-nowrap"
                >
                  View all risks
                </button>
              </div>
            </div>
          )}

          {/* ── AI TOP SUMMARY ── */}
          {topSummary && (
            <div className="bg-white border border-slate-200 rounded-2xl px-4 py-3 flex items-start gap-3">
              <div className="w-5 h-5 rounded-full bg-[#00236F]/10 flex items-center justify-center shrink-0 mt-0.5">
                <Bot className="w-3 h-3 text-[#00236F]" />
              </div>
              <p className="text-[12px] font-medium text-slate-600 leading-relaxed">{topSummary}</p>
            </div>
          )}

          {/* Service cards */}
          {services.length === 0 ? (
            <div className="flex flex-col items-center justify-center p-10 text-center bg-white rounded-3xl border-2 border-dashed border-slate-200">
              <div className="w-16 h-16 bg-blue-50 rounded-full flex items-center justify-center mb-4">
                <Zap className="w-8 h-8 text-[#00236F]" />
              </div>
              <h3 className="text-lg font-black text-[#0D1C2E] mb-2">Ready to audit</h3>
              <p className="text-sm text-slate-500 font-medium mb-6 max-w-xs">
                We couldn't read an estimate automatically. Add services manually or paste your estimate text.
              </p>
              <div className="flex gap-3">
                <button onClick={() => setIsManualEntryOpen(true)}
                  className="flex items-center gap-2 px-4 py-3 bg-[#00236F] text-white rounded-xl font-black text-[12px]">
                  <Pencil className="w-4 h-4" /> Add Service
                </button>
                <button onClick={() => setIsPasteOpen(true)}
                  className="flex items-center gap-2 px-4 py-3 bg-white border border-slate-200 text-[#0D1C2E] rounded-xl font-black text-[12px]">
                  <Copy className="w-4 h-4" /> Paste Text
                </button>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              {activeServices.map((service) => {
                const expanded = expandedCardIds.has(service.id);
                const decColors = {
                  proceed: "bg-emerald-50 text-emerald-700 border-emerald-200",
                  verify: "bg-amber-50 text-amber-700 border-amber-200",
                  wait: "bg-blue-50 text-blue-700 border-blue-200",
                  reconsider: "bg-red-50 text-red-700 border-red-200",
                }[service.decision];
                const decIcon = {
                  proceed: <Check className="w-4 h-4 text-emerald-600" />,
                  verify: <AlertTriangle className="w-4 h-4 text-amber-600" />,
                  wait: <Clock className="w-4 h-4 text-blue-600" />,
                  reconsider: <AlertTriangle className="w-4 h-4 text-red-600" />,
                }[service.decision];

                // Reframe name for questionable services
                const displayName =
                  service.decision === "reconsider" || service.decision === "verify"
                    ? `${service.name} — worth doing?`
                    : service.name;

                // Pricing badge — always show for all services
                const marketHigh = service.typicalRange?.max || 0;
                const marketLow = service.typicalRange?.min || 0;
                const price = service.price || 0;
                const hasMktData = marketHigh > 0;
                const pctAbove = hasMktData ? (price - marketHigh) / marketHigh : 0;
                const priceBadge = !hasMktData ? null
                  : pctAbove > 0.25
                    ? { label: `+$${service.delta} over market`, cls: "bg-red-100 text-red-700 border-red-200" }
                    : price < marketLow
                      ? { label: "below market", cls: "bg-blue-100 text-blue-700 border-blue-200" }
                      : { label: "fair price", cls: "bg-emerald-100 text-emerald-700 border-emerald-200" };

                return (
                  <article
                    key={service.id}
                    className={`bg-white rounded-2xl border transition-all duration-300 ${
                      expanded ? "border-[#00236F] shadow-lg" : "border-slate-200 shadow-sm hover:border-slate-300"
                    }`}
                  >
                    {editingServiceId === service.id ? (
                      /* ── Inline edit row ── */
                      <div className="p-3 flex items-center gap-2 border-b border-slate-100" onClick={e => e.stopPropagation()}>
                        <input
                          autoFocus
                          value={editDraft.name}
                          onChange={e => setEditDraft(d => ({ ...d, name: e.target.value }))}
                          onKeyDown={e => { if (e.key === "Enter") commitServiceEdit(service.id); if (e.key === "Escape") setEditingServiceId(null); }}
                          placeholder="Service name"
                          className="flex-1 min-w-0 border border-slate-200 rounded-xl px-3 py-2 text-[13px] font-bold text-[#0D1C2E] focus:border-[#00236F] focus:ring-2 focus:ring-blue-50 outline-none"
                        />
                        <input
                          value={editDraft.price}
                          onChange={e => setEditDraft(d => ({ ...d, price: e.target.value }))}
                          onKeyDown={e => { if (e.key === "Enter") commitServiceEdit(service.id); if (e.key === "Escape") setEditingServiceId(null); }}
                          placeholder="Price"
                          className="w-24 border border-slate-200 rounded-xl px-3 py-2 text-[13px] font-bold text-[#0D1C2E] focus:border-[#00236F] focus:ring-2 focus:ring-blue-50 outline-none"
                        />
                        <button onClick={() => commitServiceEdit(service.id)}
                          className="text-[11px] font-black text-white bg-[#00236F] hover:bg-[#001540] px-3 py-2 rounded-xl transition-colors">
                          Save
                        </button>
                        <button onClick={() => setEditingServiceId(null)}
                          className="text-[11px] font-black text-slate-500 hover:text-slate-700 px-2 py-2 rounded-xl transition-colors">
                          Cancel
                        </button>
                      </div>
                    ) : (
                      /* ── Normal collapsed row ── */
                      <div className="p-4 cursor-pointer flex items-center gap-3" onClick={() => toggleCard(service)}>
                        <div className={`shrink-0 w-9 h-9 rounded-full flex items-center justify-center border ${decColors}`}>
                          {decIcon}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap mb-0.5">
                            <h4 className="text-[14px] font-black text-[#0D1C2E]">{displayName}</h4>
                            {priceBadge && (
                              <span className={`text-[9px] px-1.5 py-0.5 rounded font-black border ${priceBadge.cls}`}>
                                {priceBadge.label}
                              </span>
                            )}
                          </div>
                          <p className="text-[12px] text-slate-500 font-medium">
                            ${price.toFixed(2)}
                            {hasMktData ? ` · market $${marketLow}–$${marketHigh}` : ""}
                          </p>
                        </div>
                        <div className="shrink-0 flex items-center gap-1.5">
                          <button
                            onClick={(e) => { e.stopPropagation(); setEditDraft({ name: service.name, price: String(service.price ?? "") }); setEditingServiceId(service.id); }}
                            className="w-7 h-7 flex items-center justify-center text-slate-300 hover:text-[#00236F] hover:bg-blue-50 rounded-lg transition-colors"
                            title="Edit"
                          >
                            <Pencil className="w-3 h-3" />
                          </button>
                          <button
                            onClick={(e) => { e.stopPropagation(); hideService(service); }}
                            className="w-7 h-7 flex items-center justify-center text-slate-300 hover:text-slate-500 hover:bg-slate-100 rounded-lg transition-colors"
                            title="Hide"
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                          <ChevronDown className={`w-5 h-5 text-slate-400 transition-transform duration-300 ${expanded ? "rotate-180" : ""}`} />
                        </div>
                      </div>
                    )}

                    {expanded && (
                      <div className="px-4 pb-4 pt-0 border-t border-slate-100 animate-in fade-in slide-in-from-top-2 duration-200">
                        <div className="bg-[#F8F9FF] rounded-xl p-5 mt-4 border border-blue-100">
                          <p className="text-[13px] font-black text-[#0D1C2E] mb-4">Should you actually do this?</p>
                          {service.explanation === "loading" ? (
                            <div className="py-4 flex items-center gap-3 text-slate-500">
                              <div className="w-4 h-4 rounded-full border-2 border-slate-300 border-t-[#00236F] animate-spin" />
                              <span className="text-sm font-medium">Analyzing…</span>
                            </div>
                          ) : service.explanation === "error" ? (
                            <p className="text-sm font-medium text-red-500">Could not load intelligence. Try again.</p>
                          ) : service.explanation ? (
                            <div className="space-y-5">
                              <div>
                                <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1">🧠 Quick Take</p>
                                <p className="text-[14px] font-bold text-[#0D1C2E] leading-relaxed">
                                  {(service.explanation as ServiceExplanation).quickTake}
                                </p>
                              </div>

                              <div className="bg-red-50 border border-red-100 rounded-xl p-4">
                                <p className="text-[10px] font-bold text-red-500 uppercase tracking-widest mb-1">💥 Worst case if ignored</p>
                                <p className="text-[13px] font-medium text-red-900 leading-relaxed">
                                  {(service.explanation as ServiceExplanation).worstCase}
                                </p>
                              </div>

                              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                {((service.explanation as ServiceExplanation).whenItMatters?.length || 0) > 0 && (
                                  <div>
                                    <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1">⚠️ When it matters</p>
                                    <ul className="text-[13px] space-y-1 text-slate-700 font-medium list-disc pl-4">
                                      {(service.explanation as ServiceExplanation).whenItMatters.map((w, i) => <li key={i}>{w}</li>)}
                                    </ul>
                                  </div>
                                )}
                                {((service.explanation as ServiceExplanation).whyShopsRecommend?.length || 0) > 0 && (
                                  <div>
                                    <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1">🟡 Why shops recommend this</p>
                                    <ul className="text-[13px] space-y-1 text-slate-700 font-medium list-disc pl-4">
                                      {(service.explanation as ServiceExplanation).whyShopsRecommend.map((w, i) => <li key={i}>{w}</li>)}
                                    </ul>
                                  </div>
                                )}
                              </div>

                              <div>
                                <p className="text-[10px] font-bold text-[#00236F] uppercase tracking-widest mb-1">🎯 What I'd do</p>
                                <p className="text-[13px] font-bold text-[#00236F]">
                                  {(service.explanation as ServiceExplanation).whatIdDo}
                                </p>
                              </div>

                              {(service.explanation as ServiceExplanation).whatToSay && (
                                <div className="bg-white border border-slate-200 rounded-xl p-4">
                                  <p className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-1">💬 What to say to the shop</p>
                                  <p className="text-[13px] font-serif italic font-medium text-slate-700">
                                    "{(service.explanation as ServiceExplanation).whatToSay}"
                                  </p>
                                </div>
                              )}
                            </div>
                          ) : (
                            <div className="py-4 flex items-center gap-3 text-slate-400">
                              <div className="w-4 h-4 rounded-full border-2 border-slate-200 border-t-[#00236F] animate-spin" />
                              <span className="text-[12px] font-medium">Loading analysis…</span>
                            </div>
                          )}
                        </div>

                        {/* ── NEGOTIATION PANEL ───────────────────────────── */}
                        {(() => {
                          const neg = service.negotiation;

                          // Leverage helpers
                          const leverageScore = neg && neg !== "loading" ? (neg as NegotiationResponse).leverage_score ?? 0 : 0;
                          const leverageLabel = leverageScore >= 0.65 ? "Strong leverage" : leverageScore >= 0.35 ? "Moderate leverage" : "Low leverage";
                          const leverageColor = leverageScore >= 0.65 ? "text-emerald-600" : leverageScore >= 0.35 ? "text-amber-600" : "text-slate-400";

                          const levelMap: Record<string, string> = {
                            easy_ask: "Easy ask",
                            clarify: "Clarify first",
                            price_match: "Ask for a better price",
                            bundle: "Bundle to save",
                            walk_away: "Be ready to walk",
                          };
                          const levelColor: Record<string, string> = {
                            easy_ask: "bg-emerald-50 text-emerald-700 border-emerald-200",
                            clarify: "bg-amber-50 text-amber-700 border-amber-200",
                            price_match: "bg-red-50 text-red-700 border-red-200",
                            bundle: "bg-purple-50 text-purple-700 border-purple-200",
                            walk_away: "bg-slate-100 text-slate-700 border-slate-200",
                          };

                          const BEST_FIRST_MOVE: Record<string, string> = {
                            easy_ask: "Start with a low-friction ask — coupons, package pricing, or fee removal.",
                            clarify: "Clarify why this is needed before discussing price. Necessity first.",
                            price_match: "Reference the market range and ask them to come closer — you have data.",
                            bundle: "Point out the labor overlap. Multiple services on the same lift = shared cost.",
                            walk_away: "Politely signal you want a second opinion. Often enough to unlock flexibility.",
                          };

                          const openNegInChat = (n: NegotiationResponse) => {
                            setIsChatOpen(true);
                            submitChat(
                              `Help me negotiate the ${service.name}. Leverage: ${leverageLabel}. ` +
                              `Level: ${n.negotiation_level}. Script ready: "${n.shop_script}"`
                            );
                          };

                          return (
                            <div className="mt-4 border border-slate-200 rounded-2xl overflow-hidden bg-white">
                              <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between">
                                <p className="text-[11px] font-black uppercase tracking-widest text-[#00236F]">Negotiation Options</p>
                                {neg && neg !== "loading" && (
                                  <span className={`text-[10px] font-bold ${leverageColor}`}>{leverageLabel}</span>
                                )}
                              </div>

                              {neg === "loading" ? (
                                <div className="px-4 py-5 flex items-center gap-3 text-slate-400">
                                  <div className="w-4 h-4 rounded-full border-2 border-slate-200 border-t-[#00236F] animate-spin" />
                                  <span className="text-[12px] font-medium">Finding your leverage…</span>
                                </div>
                              ) : neg ? (() => {
                                const n = neg as NegotiationResponse;
                                const isLowLeverage = (n.leverage_score ?? 0) < 0.25;

                                return (
                                  <div className="px-4 py-4 space-y-4">

                                    {/* Level badge + headline */}
                                    <div className="space-y-1.5">
                                      {n.negotiation_level && (
                                        <span className={`inline-block text-[9px] font-black uppercase tracking-widest px-2 py-0.5 rounded border ${levelColor[n.negotiation_level] ?? "bg-slate-100 text-slate-600 border-slate-200"}`}>
                                          {levelMap[n.negotiation_level] ?? n.negotiation_level}
                                        </span>
                                      )}
                                      <p className="text-[13px] font-black text-[#0D1C2E] leading-snug">
                                        {isLowLeverage ? "Not much to negotiate here" : n.headline}
                                      </p>
                                      {!isLowLeverage && n.negotiation_level && BEST_FIRST_MOVE[n.negotiation_level] && (
                                        <p className="text-[11px] font-bold text-[#00236F] bg-[#EFF4FF] rounded-lg px-2.5 py-1.5 border border-blue-100">
                                          🎯 Best first move: {BEST_FIRST_MOVE[n.negotiation_level]}
                                        </p>
                                      )}
                                    </div>

                                    {/* Recommendation */}
                                    <p className="text-[12px] font-medium text-slate-600 leading-relaxed">
                                      {isLowLeverage
                                        ? "This looks reasonably priced. Focus on whether to do it now — not pushing hard on price."
                                        : n.recommendation}
                                    </p>

                                    {/* Reasoning bullets */}
                                    {!isLowLeverage && n.reasoning?.length > 0 && (
                                      <div className="space-y-1">
                                        {n.reasoning.map((r, ri) => (
                                          <div key={ri} className="flex items-start gap-2">
                                            <span className="w-1 h-1 rounded-full bg-[#00236F] mt-1.5 shrink-0" />
                                            <p className="text-[11px] text-slate-500 font-medium leading-relaxed">{r}</p>
                                          </div>
                                        ))}
                                      </div>
                                    )}

                                    {/* Primary script */}
                                    {n.shop_script && (
                                      <div className="bg-slate-50 border border-slate-200 rounded-xl p-3">
                                        <div className="flex items-center justify-between mb-1.5">
                                          <p className="text-[9px] font-black uppercase tracking-widest text-slate-400">Say this</p>
                                          <button
                                            onClick={() => navigator.clipboard.writeText(n.shop_script)}
                                            className="text-[9px] font-black text-[#00236F] bg-[#EFF4FF] hover:bg-[#00236F] hover:text-white px-2 py-1 rounded transition-all"
                                          >
                                            Copy message
                                          </button>
                                        </div>
                                        <p className="text-[12px] font-medium text-[#0D1C2E] leading-relaxed italic">
                                          &ldquo;{n.shop_script}&rdquo;
                                        </p>
                                      </div>
                                    )}

                                    {/* Backup script */}
                                    {!isLowLeverage && n.backup_script && (
                                      <div className="bg-amber-50 border border-amber-100 rounded-xl p-3">
                                        <div className="flex items-center justify-between mb-1.5">
                                          <p className="text-[9px] font-black uppercase tracking-widest text-amber-600/80">If they push back</p>
                                          <button
                                            onClick={() => navigator.clipboard.writeText(n.backup_script)}
                                            className="text-[9px] font-black text-amber-700 bg-amber-100 hover:bg-amber-700 hover:text-white px-2 py-1 rounded transition-all"
                                          >
                                            Copy backup
                                          </button>
                                        </div>
                                        <p className="text-[12px] font-medium text-[#0D1C2E] leading-relaxed italic">
                                          &ldquo;{n.backup_script}&rdquo;
                                        </p>
                                      </div>
                                    )}

                                    {/* Quick preset chips — generate scripts, NOT chat messages */}
                                    <div>
                                      <p className="text-[9px] font-black uppercase tracking-widest text-slate-400 mb-2">Or generate a message to send:</p>
                                      <div className="flex flex-wrap gap-1.5">
                                        {SHOP_ACTIONS.map((p) => (
                                          <button key={p}
                                            onClick={() => {
                                              setActiveScript({ title: p, text: generateScript(p, service.name), serviceName: service.name });
                                              setIsChatOpen(true);
                                            }}
                                            className="text-[10px] font-bold text-slate-600 bg-slate-100 hover:bg-[#00236F] hover:text-white px-2.5 py-1.5 rounded-lg border border-slate-200 transition-all"
                                          >
                                            {p}
                                          </button>
                                        ))}
                                      </div>
                                    </div>


                                  </div>
                                );
                              })() : (
                                /* neg is null — fallback preset panel */
                                <div className="px-4 py-4 space-y-3">
                                  <p className="text-[12px] font-medium text-slate-500">Quick negotiation actions for this service:</p>
                                  <div className="flex flex-wrap gap-1.5">
                                    {SHOP_ACTIONS.map((p) => (
                                      <button key={p}
                                        onClick={() => { setActiveScript({ title: p, text: generateScript(p, service.name), serviceName: service.name }); setIsChatOpen(true); }}
                                        className="text-[10px] font-bold text-slate-600 bg-slate-100 hover:bg-[#00236F] hover:text-white px-2.5 py-1.5 rounded-lg border border-slate-200 transition-all"
                                      >
                                        {p}
                                      </button>
                                    ))}
                                  </div>

                                  <button
                                    onClick={() => { setIsChatOpen(true); submitChat(`Help me negotiate the ${service.name}`); }}
                                    className="w-full flex items-center justify-center gap-2 py-2.5 bg-[#00236F] hover:bg-[#001540] text-white rounded-xl text-[12px] font-black transition-colors"
                                  >
                                    <MessageSquare className="w-3.5 h-3.5" />
                                    Work this through in chat
                                  </button>
                                </div>
                              )}
                            </div>
                          );
                        })()} {/* end negotiation panel IIFE */}

                      </div>
                    )}
                  </article>
                );
              })}
            </div>
          )}

          {/* Hidden items */}
          {hiddenServices.length > 0 && (
            <details className="mt-4 group [&_summary::-webkit-details-marker]:hidden">
              <summary className="cursor-pointer text-[11px] font-black text-slate-400 uppercase tracking-widest flex items-center gap-2 mb-3">
                Hidden ({hiddenServices.length}) <ChevronDown className="w-4 h-4 group-open:rotate-180 transition-transform" />
              </summary>
              <div className="space-y-2 opacity-60 hover:opacity-100 transition-opacity">
                {hiddenServices.map((service) => (
                  <div key={service.id} className="flex items-center justify-between bg-slate-100 border border-slate-200 rounded-xl px-4 py-3">
                    <p className="text-[13px] font-bold text-slate-500 line-through">{service.name}</p>
                    <button
                      onClick={() => setServices((prev) => prev.map((s) => s.id === service.id ? { ...s, status: "pending" } : s))}
                      className="text-[11px] font-black bg-white border border-slate-300 text-slate-600 uppercase tracking-widest px-3 py-1.5 rounded hover:bg-slate-50 transition-colors"
                    >
                      Restore
                    </button>
                  </div>
                ))}
              </div>
            </details>
          )}
        </div>
      </main>
    </div>
  );
}
