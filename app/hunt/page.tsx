"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Search, Loader2, ArrowRight } from "lucide-react";
import ReactMarkdown from "react-markdown";
import AdvisorPanel from "./components/AdvisorPanel";
import DealScoreGauge from "./components/DealScoreGauge";
import ComparePanel from "./components/ComparePanel";

const BG = "#F8FAFC";
const SURFACE = "#FFFFFF";
const TEXT1 = "#0F172A";
const TEXT2 = "#475569";
const TEXT3 = "#94A3B8";
const BORDER = "#E2E8F0";
const ACCENT = "#4F46E5";

const fmt$ = (n: number) => `$${n.toLocaleString()}`;

// Parse and format auction end date with staleness detection
function formatAuctionDate(raw: string | null): { label: string; isPast: boolean; isUrgent: boolean } | null {
  if (!raw) return null;
  const parsed = new Date(raw);
  const now = new Date();
  const isValid = !isNaN(parsed.getTime()) && parsed.getFullYear() >= 2024;
  if (!isValid) return { label: raw, isPast: false, isUrgent: false };
  const isPast = parsed < now;
  const hoursUntil = (parsed.getTime() - now.getTime()) / 3600000;
  const isUrgent = !isPast && hoursUntil <= 24;
  const label = parsed.toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  return { label, isPast, isUrgent };
}

export default function HuntLobbyPage() {
  const router = useRouter();
  const [vehicles, setVehicles] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // ── Modal & Setup State ──
  const [showAddModal, setShowAddModal] = useState(false);
  const [activeTab, setActiveTab] = useState<"urls" | "manual">("urls");
  const [batchUrls, setBatchUrls] = useState("");
  const [manualEntry, setManualEntry] = useState({ year: "", make: "", model: "", price: "", mileage: "" });
  
  // ── Streaming State ──
  const [streaming, setStreaming] = useState(false);
  const [streamProgress, setStreamProgress] = useState<{ index: number; message: string; type: string; url?: string }[]>([]);
  const [streamDone, setStreamDone] = useState(false);
  const [processingBanner, setProcessingBanner] = useState<{total:number;done:number;errors:number} | null>(null);
  const [refreshingId, setRefreshingId] = useState<string | null>(null);
  const [urlWarnings, setUrlWarnings] = useState<string[]>([]);

  // ── Dossier State ──
  const [uploadingDocId, setUploadingDocId] = useState<string | null>(null);

  // ── Document Handlers ──
  // ── CarFax PDF upload ─────────────────────────────────────────────────────
  const [carfaxUploading, setCarfaxUploading] = useState<Record<string, boolean>>({});
  const [carfaxDataCache, setCarfaxDataCache] = useState<Record<string, any>>({});

  const handleCarfaxUpload = async (vehicleId: string, file: File) => {
    if (!file.name.toLowerCase().endsWith('.pdf')) {
      alert('Please upload a PDF CarFax report.');
      return;
    }
    setCarfaxUploading(prev => ({ ...prev, [vehicleId]: true }));
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch(`/api/hunt/${vehicleId}/carfax`, { method: 'POST', body: fd });
      const data = await res.json();
      if (data.success && data.carfax) {
        setCarfaxDataCache(prev => ({ ...prev, [vehicleId]: data.carfax }));
        // Sync key fields into local vehicle state
        setVehicles(prev => prev.map((x: any) => x.id === vehicleId ? {
          ...x,
          owner_count: data.carfax.owner_count ?? x.owner_count,
          has_accident: data.carfax.total_accidents > 0,
          carfax_data: data.carfax,
        } : x));
      } else {
        alert(data.error || 'CarFax upload failed');
      }
    } catch (e: any) {
      alert('Upload error: ' + e.message);
    } finally {
      setCarfaxUploading(prev => ({ ...prev, [vehicleId]: false }));
    }
  };

  // Keep old handleFile for PPI/other doc types
  const handleFile = async (vehicleId: string, docType: string, file: File) => {
    if (docType === 'carfax') { handleCarfaxUpload(vehicleId, file); return; }
    setUploadingDocId(vehicleId);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('docType', docType);
      await fetch(`/api/hunt/${vehicleId}/attach-document`, { method: 'POST', body: fd });
      fetchVehicles();
    } catch {}
    setUploadingDocId(null);
  };

  // ── Annual mileage for TCO estimator ─────────────────────────────────────
  const [annualMileage, setAnnualMileage] = useState<Record<string, number>>({});

  // ── Offer tracker state ───────────────────────────────────────────────────
  const [offerLogs, setOfferLogs] = useState<Record<string, any[]>>({});
  const [vehicleNotes, setVehicleNotes] = useState<Record<string, string>>({});
  const [showOfferForm, setShowOfferForm] = useState<Record<string, boolean>>({});
  const [offerAmt, setOfferAmt] = useState<Record<string, string>>({});
  const [offerNote, setOfferNote] = useState<Record<string, string>>({});
  const [offerOutcome, setOfferOutcome] = useState<Record<string, string>>({});
  const [offerSubmitting, setOfferSubmitting] = useState<Record<string, boolean>>({});

  const loadOfferLog = async (vehicleId: string) => {
    if (offerLogs[vehicleId] !== undefined) return; // already loaded
    try {
      const res = await fetch(`/api/hunt/${vehicleId}/offers`);
      const data = await res.json();
      setOfferLogs(prev => ({ ...prev, [vehicleId]: data.offer_log ?? [] }));
      setVehicleNotes(prev => ({ ...prev, [vehicleId]: data.notes ?? '' }));
    } catch {}
  };

  const submitOffer = async (vehicleId: string) => {
    const amount = parseFloat(offerAmt[vehicleId] || '0');
    if (!amount) return;
    setOfferSubmitting(prev => ({ ...prev, [vehicleId]: true }));
    try {
      const res = await fetch(`/api/hunt/${vehicleId}/offers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          amount,
          outcome: offerOutcome[vehicleId] || 'pending',
          note: offerNote[vehicleId] || '',
        }),
      });
      const data = await res.json();
      if (data.success) {
        setOfferLogs(prev => ({ ...prev, [vehicleId]: data.offer_log }));
        setShowOfferForm(prev => ({ ...prev, [vehicleId]: false }));
        setOfferAmt(prev => ({ ...prev, [vehicleId]: '' }));
        setOfferNote(prev => ({ ...prev, [vehicleId]: '' }));
        setOfferOutcome(prev => ({ ...prev, [vehicleId]: '' }));
      }
    } catch {}
    setOfferSubmitting(prev => ({ ...prev, [vehicleId]: false }));
  };

  const updateOfferOutcome = async (vehicleId: string, entryId: string, outcome: string) => {
    const res = await fetch(`/api/hunt/${vehicleId}/offers`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entry_id: entryId, outcome }),
    });
    const data = await res.json();
    if (data.success) setOfferLogs(prev => ({ ...prev, [vehicleId]: data.offer_log }));
  };

  const saveNotes = async (vehicleId: string, notes: string) => {
    setVehicleNotes(prev => ({ ...prev, [vehicleId]: notes }));
    await fetch(`/api/hunt/${vehicleId}/offers`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notes }),
    });
  };


  const [scanningPhotosId, setScanningPhotosId] = useState<string | null>(null);
  const [scoreDelta, setScoreDelta] = useState<Record<string, number>>({});

  // ── Inline mileage editing ─────────────────────────────────────────────────
  const [editingMileageId, setEditingMileageId] = useState<string | null>(null);
  const [mileageInput, setMileageInput] = useState<string>('');

  const saveMileage = async (vehicleId: string) => {
    const val = parseInt(mileageInput.replace(/\D/g, ''), 10);
    if (!val || val < 0) { setEditingMileageId(null); return; }
    setVehicles(prev => prev.map((x: any) => x.id === vehicleId ? { ...x, mileage: val } : x));
    setEditingMileageId(null);
    setMileageInput('');
    try {
      await fetch(`/api/hunt/${vehicleId}/offers`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mileage: val }),
      });
    } catch {}
  };

  // ── Inline price editing ──────────────────────────────────────────────────
  const [editingPriceId, setEditingPriceId] = useState<string | null>(null);
  const [priceInput, setPriceInput] = useState<string>('');

  const savePrice = async (vehicleId: string) => {
    const val = parseInt(priceInput.replace(/\D/g, ''), 10);
    if (!val || val < 0) { setEditingPriceId(null); return; }
    setVehicles(prev => prev.map((x: any) => x.id === vehicleId ? { ...x, price: val } : x));
    setEditingPriceId(null);
    setPriceInput('');
    try {
      await fetch(`/api/hunt/${vehicleId}/offers`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ price: val }),
      });
    } catch {}
  };

  // ── Generic field saver (for expanded card edit panel + Advisor write-back) ──
  const saveVehicleField = async (vehicleId: string, field: string, value: any) => {
    setVehicles(prev => prev.map((x: any) => x.id === vehicleId ? { ...x, [field]: value } : x));
    try {
      await fetch(`/api/hunt/${vehicleId}/offers`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [field]: value }),
      });
    } catch {}
  };

  const [navigatorOpenId, setNavigatorOpenId] = useState<string | null>(null);
  const [navigatorChat, setNavigatorChat] = useState<Record<string, { role: string; content: string }[]>>({}); 
  const [navigatorInput, setNavigatorInput] = useState<Record<string, string>>({});
  const [navigatorLoading, setNavigatorLoading] = useState<Record<string, boolean>>({});
  const chatEndRefs = useRef<Record<string, HTMLDivElement | null>>({});
  // Ref mirror of deletedVisually so fetchVehicles can filter without stale closure
  const deletedVisuallyRef = useRef<Record<string, boolean>>({});
  // Expert Take re-gen cache (vehicleId -> freshly generated take)
  const [expertTakeCache, setExpertTakeCache] = useState<Record<string, string>>({});
  const [regenningTakeId, setRegenningTakeId] = useState<string | null>(null);
  // Expanded CARFAX/doc panel state
  const [expandedDocKey, setExpandedDocKey] = useState<string | null>(null); // vehicleId+docType
  // FB-blocked listings from stream (index -> url)
  const [fbBlocked, setFbBlocked] = useState<{ url: string; message: string }[]>([]);
  // ── Scout + Leads ──
  const [scoutLeads, setScoutLeads] = useState<any[]>([]);
  const [showLeadsTray, setShowLeadsTray] = useState(false);
  const [showScoutModal_legacy, setShowScoutModal] = useState(false); // legacy unused
  const [scoutConfigs, setScoutConfigs] = useState<any[]>([]);
  const [scoutForm, setScoutForm] = useState({ label: '', make: '', model: '', year_min: '', year_max: '', price_max: '', mileage_max: '' });
  const [savingScout, setSavingScout] = useState(false);
  // ── Tag Filters ──
  const [activeTagFilter, setActiveTagFilter] = useState<string | null>(null);
  // ── View Tabs: Radar vs Inbox ──
  const [viewTab, setViewTab] = useState<'board' | 'advisor'>('board');
  const [scoutRunning, setScoutRunning] = useState(false);
  const [scoutResult, setScoutResult] = useState<{inserted:number;refreshed?:number;total:number;market_mid:number} | null>(null);
  // Per-lead add state: leadId → 'adding' | 'done' | 'error'
  const [addingLeadIds, setAddingLeadIds] = useState<Record<string, 'adding'|'done'|'error'>>({});
  // ── Scout Chat ──
  const [showScoutChat, setShowScoutChat] = useState(false);
  // ── Advisor (unified AI broker) ──
  const [advisorChat, setAdvisorChat] = useState<{role: string; content: string}[]>([]);
  const [advisorInput, setAdvisorInput] = useState('');
  const [advisorLoading, setAdvisorLoading] = useState(false);
  const advisorEndRef = useRef<HTMLDivElement>(null);
  const inboxRef = useRef<HTMLDivElement>(null);
  // ── Advisor sessions ──
  const [advisorSessions, setAdvisorSessions] = useState<any[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [sessionsLoaded, setSessionsLoaded] = useState(false);
  // ── Advisor file attachments ──
  const [advisorFiles, setAdvisorFiles] = useState<Array<{ name: string; type: string; dataUrl: string }>>([]);
  // ── Deletion & Financing ──
  const [deletedIds, setDeletedIds] = useState<Record<string, NodeJS.Timeout>>({});
  const [deletedVisually, setDeletedVisually] = useState<Record<string, boolean>>({});
  const [payMethod, setPayMethod] = useState<'cash'|'finance'>('cash');
  // ── Compare mode ──
  const [compareIds, setCompareIds] = useState<Set<string>>(new Set());
  const [showCompare, setShowCompare] = useState(false);
  const toggleCompare = (id: string) => {
    setCompareIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else if (next.size < 3) next.add(id);
      return next;
    });
  };

  const handleSoftDelete = (id: string, make: string, model: string) => {
    setDeletedVisually(prev => {
      const next = {...prev, [id]: true};
      deletedVisuallyRef.current = next;
      return next;
    });
    const timer = setTimeout(async () => {
      try {
        await fetch(`/api/hunt/${id}`, { method: 'DELETE' });
        setVehicles(prev => prev.filter(v => v.id !== id));
        // Also remove from ref once truly deleted
        setDeletedVisually(prev => { const n = {...prev}; delete n[id]; deletedVisuallyRef.current = n; return n; });
      } catch(e) {}
    }, 5000);
    setDeletedIds(prev => ({...prev, [id]: timer}));
  };

  const undoDelete = (id: string) => {
    clearTimeout(deletedIds[id]);
    setDeletedVisually(prev => {
      const next = {...prev};
      delete next[id];
      deletedVisuallyRef.current = next;
      return next;
    });
    setDeletedIds(prev => { const next = {...prev}; delete next[id]; return next; });
  };

  // Init radar statuses from vehicles data, load DnD order from localStorage
  useEffect(() => {
    if (vehicles.length === 0) return;
    setVehicleStatuses(prev => {
      const next = { ...prev };
      vehicles.forEach((v: any) => { if (!next[v.id]) next[v.id] = v.status || 'watching'; });
      return next;
    });
    if (radarOrder.length === 0) {
      try {
        const stored = localStorage.getItem('wc_radar_order');
        if (stored) setRadarOrder(JSON.parse(stored));
      } catch {}
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vehicles]);

  const setVehicleStatus = async (id: string, newStatus: 'focus' | 'watching') => {
    setVehicleStatuses(prev => ({ ...prev, [id]: newStatus }));
    setVehicles((prev: any[]) => prev.map(v => v.id === id ? { ...v, status: newStatus } : v));
    await fetch(`/api/hunt/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: newStatus }),
    });
  };

  const saveRadarOrder = (order: string[]) => {
    setRadarOrder(order);
    try { localStorage.setItem('wc_radar_order', JSON.stringify(order)); } catch {}
  };

  const handleVehicleReorder = (targetId: string) => {
    if (!dragId || dragId === targetId) { setDragId(null); setDragOverId(null); return; }
    const allIds = vehicles.map((v: any) => v.id);
    const base = radarOrder.length > 0 ? radarOrder.filter(id => allIds.includes(id)) : [...allIds];
    allIds.forEach(id => { if (!base.includes(id)) base.push(id); });
    const fromIdx = base.indexOf(dragId);
    const toIdx = base.indexOf(targetId);
    if (fromIdx === -1) { setDragId(null); setDragOverId(null); return; }
    const next = [...base];
    next.splice(fromIdx, 1);
    next.splice(toIdx, 0, dragId);
    saveRadarOrder(next);
    setDragId(null);
    setDragOverId(null);
  };

  // ── Buyer Profile — persists across sessions + injected into every Navigator call ──
  const [buyerProfile, setBuyerProfile] = useState<Record<string, string>>(() => {
    try { return JSON.parse(localStorage.getItem('wc_buyer_profile') || '{}'); } catch { return {}; }
  });
  const [showProfilePanel, setShowProfilePanel] = useState(false);
  const [analyzeLoading, setAnalyzeLoading] = useState(false);
  const [analyzeResult, setAnalyzeResult] = useState('');
  const [showAnalyzePanel, setShowAnalyzePanel] = useState(false);

  const saveBuyerProfile = (updates: Record<string, string>) => {
    const next = { ...buyerProfile, ...updates };
    setBuyerProfile(next);
    try { localStorage.setItem('wc_buyer_profile', JSON.stringify(next)); } catch {}
  };

  // Auto-extract preferences from Navigator conversations and save to profile
  const extractAndSavePrefs = (vehicleId: string, messages: {role:string;content:string}[]) => {
    const userMessages = messages.filter(m => m.role === 'user').map(m => m.content).join(' ');
    const updates: Record<string, string> = {};
    const colorMatch = userMessages.match(/(?:prefer|want|looking for|love|need).*?(terra|black|white|silver|grey|gray|brown|red|blue|green|cognac|sandstorm)[^.]*(?:interior|exterior|color)/i);
    if (colorMatch) updates['interior_color'] = colorMatch[1].toLowerCase();
    const mileageMatch = userMessages.match(/(?:under|below|max|less than)\s*([\d,]+)\s*(?:k\s*)?miles?/i);
    if (mileageMatch) updates['max_mileage'] = mileageMatch[1].replace(/,/g,'') + (mileageMatch[0].includes('k') ? '000' : '');
    const yearMatch = userMessages.match(/(?:prefer|want|looking at|interested in)\s*(?:a\s*)?(20\d\d)[^.]*(?:to|through|-)\s*(20\d\d)/i);
    if (yearMatch) updates['year_range'] = `${yearMatch[1]}-${yearMatch[2]}`;
    if (Object.keys(updates).length > 0) saveBuyerProfile(updates);
  };

  const [scoutChatHistory, setScoutChatHistory] = useState<{role:string;content:string}[]>([]);
  const [scoutChatInput, setScoutChatInput] = useState('');
  const [scoutChatLoading, setScoutChatLoading] = useState(false);
  const [scoutPendingConfig, setScoutPendingConfig] = useState<any>(null);
  const [activatingScout, setActivatingScout] = useState(false);
  // ── In-app notifications ──
  const [showNotifications, setShowNotifications] = useState(false);
  const [gemAlerts, setGemAlerts] = useState<any[]>([]);
  // ── Collapsible per-card sections: insightCollapsed[vehicleId] ──
  const [insightCollapsed, setInsightCollapsed] = useState<Record<string,boolean>>({});
  const [dossierCollapsed, setDossierCollapsed] = useState<Record<string,boolean>>({});
  // ── Enrichment auto-poll ──
  const [enrichmentPollActive, setEnrichmentPollActive] = useState(false);
  // ── Watchlist AI Summary ──
  const [watchlistSummary, setWatchlistSummary] = useState<string>('');
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [summaryDismissed, setSummaryDismissed] = useState(false);
  // ── Radar: Focus/Watching tiers + Drag-and-Drop ordering ──
  const [vehicleStatuses, setVehicleStatuses] = useState<Record<string, string>>({});
  const [radarOrder, setRadarOrder] = useState<string[]>([]);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);

  useEffect(() => {
    fetchVehicles(true); // true = trigger summary on first load
    fetchScoutLeads();
    fetchScoutConfigs();
    loadAdvisorSessions();
  }, []);

  // ── Advisor session management ─────────────────────────────────────────
  // Falls back to localStorage if Supabase tables don't exist yet
  const useLocalFallback = useRef(false);
  
  async function loadAdvisorSessions() {
    try {
      const res = await fetch('/api/advisor/sessions');
      const data = await res.json();
      
      // Check if tables exist
      if (data.error && (data.error.includes('not found') || data.error.includes('does not exist'))) {
        console.warn('[advisor] Tables not found — using localStorage fallback');
        useLocalFallback.current = true;
        loadLocalSessions();
        setSessionsLoaded(true);
        return;
      }
      
      if (data.sessions && data.sessions.length > 0) {
        setAdvisorSessions(data.sessions);
        const latest = data.sessions[0];
        setActiveSessionId(latest.id);
        await loadSessionMessages(latest.id);
      } else if (data.sessions) {
        // Tables exist but no sessions — check for localStorage migration
        let localChat: any[] = [];
        try { const s = localStorage.getItem('wc_advisor_chat'); if (s) localChat = JSON.parse(s); } catch {}
        
        if (localChat.length > 0) {
          const session = await createNewSession('Migrated conversation');
          if (session) {
            for (const msg of localChat) {
              await saveAdvisorMessage(session.id, msg.role, msg.content);
            }
            setAdvisorChat(localChat);
            localStorage.removeItem('wc_advisor_chat');
            fetch(`/api/advisor/sessions/${session.id}/title`, { method: 'POST' })
              .then(r => r.json())
              .then(d => {
                if (d.title) setAdvisorSessions(prev => prev.map(s => s.id === session.id ? { ...s, title: d.title } : s));
              })
              .catch(() => {});
          }
        }
      }
    } catch {
      // Network error or other issue — fall back to localStorage
      useLocalFallback.current = true;
      loadLocalSessions();
    }
    setSessionsLoaded(true);
  }

  function loadLocalSessions() {
    try {
      const stored = localStorage.getItem('wc_advisor_sessions');
      if (stored) {
        const sessions = JSON.parse(stored);
        setAdvisorSessions(sessions);
        if (sessions.length > 0) {
          setActiveSessionId(sessions[0].id);
          const msgs = localStorage.getItem(`wc_advisor_msgs_${sessions[0].id}`);
          if (msgs) setAdvisorChat(JSON.parse(msgs));
        }
      } else {
        // Legacy single-chat migration
        const legacy = localStorage.getItem('wc_advisor_chat');
        if (legacy) {
          const chat = JSON.parse(legacy);
          const id = `local_${Date.now()}`;
          const session = { id, title: 'Conversation', created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
          setAdvisorSessions([session]);
          setActiveSessionId(id);
          setAdvisorChat(chat);
          localStorage.setItem('wc_advisor_sessions', JSON.stringify([session]));
          localStorage.setItem(`wc_advisor_msgs_${id}`, JSON.stringify(chat));
          localStorage.removeItem('wc_advisor_chat');
        }
      }
    } catch {}
  }

  function saveLocalSessions(sessions: any[]) {
    try { localStorage.setItem('wc_advisor_sessions', JSON.stringify(sessions)); } catch {}
  }

  function saveLocalMessages(sessionId: string, messages: any[]) {
    try { localStorage.setItem(`wc_advisor_msgs_${sessionId}`, JSON.stringify(messages)); } catch {}
  }

  async function loadSessionMessages(sessionId: string) {
    if (useLocalFallback.current) {
      try {
        const msgs = localStorage.getItem(`wc_advisor_msgs_${sessionId}`);
        if (msgs) setAdvisorChat(JSON.parse(msgs));
        else setAdvisorChat([]);
      } catch {}
      return;
    }
    try {
      const res = await fetch(`/api/advisor/sessions/${sessionId}/messages`);
      const data = await res.json();
      if (data.messages) {
        setAdvisorChat(data.messages.map((m: any) => ({ role: m.role, content: m.content })));
      }
    } catch {}
  }

  async function createNewSession(title?: string): Promise<any | null> {
    const sessionTitle = title || 'New conversation';
    
    if (useLocalFallback.current) {
      const id = `local_${Date.now()}`;
      const session = { id, title: sessionTitle, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
      const updated = [session, ...advisorSessions];
      setAdvisorSessions(updated);
      setActiveSessionId(id);
      setAdvisorChat([]);
      saveLocalSessions(updated);
      return session;
    }
    
    try {
      const res = await fetch('/api/advisor/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: sessionTitle }),
      });
      const data = await res.json();
      if (data.session) {
        setAdvisorSessions(prev => [data.session, ...prev]);
        setActiveSessionId(data.session.id);
        setAdvisorChat([]);
        return data.session;
      }
    } catch {}
    return null;
  }

  async function switchSession(sessionId: string) {
    setActiveSessionId(sessionId);
    setAdvisorChat([]);
    await loadSessionMessages(sessionId);
  }

  async function saveAdvisorMessage(sessionId: string, role: string, content: string) {
    if (useLocalFallback.current) {
      // Save to localStorage
      const key = `wc_advisor_msgs_${sessionId}`;
      try {
        const existing = JSON.parse(localStorage.getItem(key) || '[]');
        existing.push({ role, content });
        localStorage.setItem(key, JSON.stringify(existing));
        // Update session timestamp
        const sessions = advisorSessions.map(s => 
          s.id === sessionId ? { ...s, updated_at: new Date().toISOString() } : s
        );
        saveLocalSessions(sessions);
      } catch {}
      return;
    }
    try {
      await fetch(`/api/advisor/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role, content }),
      });
    } catch {}
  }


  // Auto-poll for enrichment completion (every 8s while any vehicle is pending)
  useEffect(() => {
    const hasPending = vehicles.some(v => v.enrichment_status === 'pending');
    if (hasPending && !enrichmentPollActive) {
      setEnrichmentPollActive(true);
      const pollInterval = setInterval(async () => {
        const res = await fetch('/api/hunt/tracker');
        const data = await res.json();
        if (data.vehicles) {
          setVehicles(data.vehicles);
          const stillPending = data.vehicles.some((v: any) => v.enrichment_status === 'pending');
          if (!stillPending) {
            clearInterval(pollInterval);
            setEnrichmentPollActive(false);
          }
        }
      }, 8000);
      return () => clearInterval(pollInterval);
    }
  }, [vehicles, enrichmentPollActive]);

  async function fetchVehicles(triggerSummary = false) {
    try {
      const res = await fetch("/api/hunt/tracker");
      const data = await res.json();
      if (!res.ok) {
        if (data.error === "SCHEMA_MISSING") setErrorMsg("Please run watchlist_schema.sql in Supabase first.");
        else setErrorMsg(data.error);
      } else {
        // Filter out any IDs currently in the soft-delete window
        const deleted = deletedVisuallyRef.current;
        const vehicles = (data.vehicles || []).filter((v: any) => !deleted[v.id]);
        setVehicles(vehicles);
        if (triggerSummary && vehicles.length > 0) {
          generateWatchlistSummary(vehicles);
        }
      }
    } catch (e) {
      setErrorMsg("Failed to connect to API");
    } finally {
      setLoading(false);
    }
  }

  async function generateWatchlistSummary(vehicleList: any[]) {
    // Cache per session — only generate once per browser session
    const cacheKey = `wc_summary_${vehicleList.length}`;
    const cached = typeof window !== 'undefined' ? sessionStorage.getItem(cacheKey) : null;
    if (cached) { setWatchlistSummary(cached); return; }

    setSummaryLoading(true);
    setWatchlistSummary('');
    try {
      const res = await fetch('/api/hunt/summary', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vehicles: vehicleList }),
      });
      const reader = res.body?.getReader();
      const dec = new TextDecoder();
      let full = '';
      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          for (const line of dec.decode(value).split('\n')) {
            if (!line.startsWith('data: ')) continue;
            try {
              const ev = JSON.parse(line.slice(6));
              if (ev.type === 'delta') {
                full += ev.content;
                setWatchlistSummary(full);
              }
            } catch {}
          }
        }
      }
      if (full && typeof window !== 'undefined') sessionStorage.setItem(cacheKey, full);
    } catch {}
    finally { setSummaryLoading(false); }
  }

  async function fetchScoutLeads() {
    try {
      // ?status=active returns both 'new' and 'watching' leads
      const res = await fetch('/api/scout/leads?status=active');
      const data = await res.json();
      if (data.leads) setScoutLeads(data.leads);
    } catch {}
  }

  async function fetchScoutConfigs() {
    try {
      const res = await fetch('/api/scout/config');
      const data = await res.json();
      if (data.configs) setScoutConfigs(data.configs);
    } catch {}
  }

  async function watchLead(leadId: string) {
    await fetch('/api/scout/leads', { method: 'PATCH', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ id: leadId, status: 'watching' }) });
    // Update in-place so the card shows the watching badge immediately
    setScoutLeads(prev => prev.map(l => l.id === leadId ? { ...l, status: 'watching' } : l));
  }

  async function dismissLead(leadId: string) {
    await fetch('/api/scout/leads', { method: 'PATCH', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ id: leadId, status: 'dismissed' }) });
    setScoutLeads(prev => prev.filter(l => l.id !== leadId));
  }

  async function addLeadToHunt(lead: any) {
    // Mark this card as in-progress
    setAddingLeadIds(prev => ({ ...prev, [lead.id]: 'adding' }));

    try {
      // Stream directly — no modal needed
      const res = await fetch('/api/hunt/tracker/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ queue: [{ type: 'url', url: lead.listing_url }] }),
      });

      if (!res.ok) throw new Error(`Stream error: ${res.status}`);

      const reader = res.body?.getReader();
      const dec = new TextDecoder();
      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          for (const line of dec.decode(value).split('\n')) {
            if (!line.startsWith('data: ')) continue;
            try {
              const ev = JSON.parse(line.slice(6));
              if (ev.type === 'success' && ev.data) {
                setVehicles(prev => {
                  const already = prev.some((x: any) => x.id === ev.data.id);
                  return already ? prev : [ev.data, ...prev];
                });
              }
            } catch {}
          }
        }
      }

      // Mark scout lead as added in DB
      await fetch('/api/scout/leads', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: lead.id, status: 'added' }),
      });

      // Show done state briefly, then remove card and switch to Radar
      setAddingLeadIds(prev => ({ ...prev, [lead.id]: 'done' }));
      setTimeout(() => {
        setScoutLeads(prev => prev.filter(l => l.id !== lead.id));
        setViewTab('board');
        fetchVehicles();
      }, 1200);

    } catch (err: any) {
      console.error('[addLeadToHunt]', err);
      setAddingLeadIds(prev => ({ ...prev, [lead.id]: 'error' }));
      // Reset after 3s so they can retry
      setTimeout(() => setAddingLeadIds(prev => { const n={...prev}; delete n[lead.id]; return n; }), 3000);
    }
  }

  async function saveScoutConfig(e: React.FormEvent) {
    e.preventDefault();
    setSavingScout(true);
    try {
      const res = await fetch('/api/scout/config', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          label: scoutForm.label,
          make: scoutForm.make,
          model: scoutForm.model || undefined,
          year_min: scoutForm.year_min ? parseInt(scoutForm.year_min) : undefined,
          year_max: scoutForm.year_max ? parseInt(scoutForm.year_max) : undefined,
          price_max: scoutForm.price_max ? parseInt(scoutForm.price_max) : undefined,
          mileage_max: scoutForm.mileage_max ? parseInt(scoutForm.mileage_max) : undefined,
        })
      });
      if (res.ok) {
        await fetchScoutConfigs();
        setShowScoutChat(false);
        setScoutForm({ label: '', make: '', model: '', year_min: '', year_max: '', price_max: '', mileage_max: '' });
      }
    } finally {
      setSavingScout(false);
    }
  }

  // ── Backfill confidence_pct for existing vehicles that have market comps but were
  // imported before the confidence system existed (they'd show 25 = ESTIMATED wrongly)
  useEffect(() => {
    setVehicles(prev => prev.map(v => {
      if ((v.confidence_pct === 25 || v.confidence_pct == null) && v.market_mid) {
        return { ...v, confidence_pct: 45 }; // 25 base + 20 for having market comps
      }
      return v;
    }));
  }, [vehicles.length]); // run once when vehicles first load

  // ── Live score: applies current methodology penalties to the stored DB score.
  // This ensures ranking stays correct even before a user hits "Refresh Score".
  function liveScore(v: any): number {
    let s = v.adjusted_score ?? v.score ?? 0;
    // Accident penalty (added to methodology 2026-04-18 — old records don't have it)
    if (v.has_accident === true) s = Math.max(0, s - 12);
    // Hard mileage caps
    const mi = v.mileage ?? 0;
    if      (mi >= 200000) s = Math.max(0, s - 12);
    else if (mi >= 150000) s = Math.max(0, s - 8);
    else if (mi >= 120000) s = Math.max(0, s - 4);
    return Math.max(0, s);
  }

  // ── Transfer/shipping effort tier — used in expanded card transit dots
  function computeShippingTier(location: string | null | undefined): { level: number; label: string } {
    if (!location) return { level: 3, label: 'Unknown' };
    const loc = location.toLowerCase();
    if (/\b(co|colorado|denver|boulder|colorado springs|fort collins|pueblo)\b/.test(loc))
      return { level: 1, label: 'Local' };
    if (/\b(ut|utah|nm|new mexico|wy|wyoming|ne|nebraska|ks|kansas|az|arizona)\b/.test(loc))
      return { level: 2, label: 'Regional Drive' };
    if (/\b(tx|texas|ok|oklahoma|mo|missouri|ia|iowa|mn|minnesota|sd|south dakota|nd|north dakota|mt|montana|id|idaho|nv|nevada|ca|california|or|oregon|wa|washington)\b/.test(loc))
      return { level: 3, label: 'Mid-Haul' };
    return { level: 4, label: 'Long-Haul' };
  }

  async function handleBulkAdd(e: React.FormEvent) {
    e.preventDefault();
    setStreaming(true);
    setStreamProgress([]);
    setStreamDone(false);
    setErrorMsg("");
    setUrlWarnings([]);
    
    const queue = [];
    if (activeTab === "urls") {
      const urls = batchUrls.split('\n').map(s => s.trim()).filter(s => s);
      if (urls.length === 0) { setStreaming(false); return; }
      
      const BAD_PATTERNS = [
        /[?&]q=/i, /\/search[/?]/i, /\/inventory[?]/i, /\/cars[?]/i,
        /\/listings[?]/i, /\/find[?]/i, /\/results/i, /page=\d/i,
        /(cars\.com|autotrader\.com|cargurus\.com|carmax\.com)\/cars(?!.*\/detail)/i,
      ];
      const badUrls = urls.filter(u => BAD_PATTERNS.some(p => p.test(u)));
      if (badUrls.length > 0) {
        setUrlWarnings(badUrls);
        setStreaming(false);
        return;
      }
      queue.push(...urls.map((url, i) => ({ type: "url", url, _origIndex: i })));
    } else {
      if (!manualEntry.year || !manualEntry.make || !manualEntry.model) {
        setErrorMsg("Year, Make, and Model are required for manual entry.");
        setStreaming(false); return;
      }
      queue.push({ 
        type: "manual", 
        year: parseInt(manualEntry.year), 
        make: manualEntry.make, 
        model: manualEntry.model, 
        price: parseInt(manualEntry.price||"0"), 
        mileage: parseInt(manualEntry.mileage||"0") 
      });
    }

    // Close modal NOW before fetch — streaming fetch awaits first chunk, not connection
    setShowAddModal(false);
    setViewTab('board');
    setBatchUrls("");
    setProcessingBanner({ total: queue.length, done: 0, errors: 0 });

    try {
      const res = await fetch("/api/hunt/tracker/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ queue }),
      });

      const reader = res.body?.getReader();
      const dec = new TextDecoder();
      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          for (const line of dec.decode(value).split('\n')) {
            if (!line.startsWith("data: ")) continue;
            try {
              const ev = JSON.parse(line.slice(6));
              if (ev.type === "start") continue;
              if (ev.type === "complete") { fetchVehicles(); continue; }
              if (ev.type === "fatal") { setErrorMsg(ev.message); continue; }
              if (ev.type === "facebook_blocked") {
                setFbBlocked(prev => [...prev, { url: ev.url || "", message: ev.message }]);
                setProcessingBanner(prev => prev ? { ...prev, errors: prev.errors + 1 } : prev);
                continue;
              }
              // Live-insert the car as soon as it's ready
              if (ev.type === "success" && ev.data) {
                setVehicles(prev => {
                  const already = prev.some((x: any) => x.id === ev.data.id);
                  return already ? prev : [ev.data, ...prev];
                });
                setProcessingBanner(prev => prev ? { ...prev, done: prev.done + 1 } : prev);
              } else if (ev.type === "error") {
                setProcessingBanner(prev => prev ? { ...prev, errors: prev.errors + 1 } : prev);
              }
              const originalUrl = queue[ev.index]?.url;
              setStreamProgress(prev => {
                const arr = [...prev];
                arr[ev.index || 0] = { index: ev.index, message: ev.message, type: ev.type, url: originalUrl };
                return arr;
              });
            } catch {}
          }
        }
      }
    } catch(err) {
      setErrorMsg("Stream failed to connect.");
    } finally {
      setStreaming(false);
      setStreamDone(true);
      setProcessingBanner(null);
      fetchVehicles();
    }
  }

  // ── Per-vehicle Refresh Score ──
  async function refreshVehicle(vehicleId: string, listingUrl: string) {
    if (!listingUrl || listingUrl.startsWith('manual_')) return;
    setRefreshingId(vehicleId);
    try {
      // Re-run exactly like a new import but for a single URL
      const res = await fetch("/api/hunt/tracker/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ queue: [{ type: "url", url: listingUrl }], refreshId: vehicleId }),
      });
      const reader = res.body?.getReader();
      const dec = new TextDecoder();
      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          // Drain the stream silently — just wait for completion
          dec.decode(value);
        }
      }
      fetchVehicles(); // Reload updated scores
    } catch (err) {
      console.error('[refresh]', err);
    } finally {
      setRefreshingId(null);
    }
  }

  // ── Auto-regen Expert Take on expand if fallback ──────────────────────────
  const FALLBACK_PATTERN = /analysis complete|review physical|no issues|looks good/i;

  async function regenExpertTake(vehicleId: string, currentTake: string) {
    if (expertTakeCache[vehicleId]) return; // already cached
    if (currentTake && currentTake.length > 40 && !FALLBACK_PATTERN.test(currentTake)) return; // not a fallback
    if (regenningTakeId === vehicleId) return; // already in flight
    setRegenningTakeId(vehicleId);
    try {
      const res = await fetch(`/api/hunt/${vehicleId}/expert-take`, { method: 'POST' });
      const data = await res.json();
      if (data.expertTake) {
        setExpertTakeCache(prev => ({ ...prev, [vehicleId]: data.expertTake }));
      }
    } catch {} finally {
      setRegenningTakeId(null);
    }
  }

  function toggleRow(id: string) {
    const isOpening = expandedId !== id;
    setExpandedId(prev => prev === id ? null : id);
    if (isOpening) {
      // Auto-fire Navigator insight immediately on expand — no button click needed
      if (!navigatorChat[id]?.length) {
        sendNavigatorMessage(id, "");
      }
      setNavigatorOpenId(id); // keep chat panel open by default
      loadOfferLog(id); // lazy-load offer history + notes
    }
  }


  async function handleDelete(id: string, e: React.MouseEvent) {
    e.stopPropagation();
    if (!confirm("Remove vehicle from Master Inventory?")) return;
    try {
      const res = await fetch("/api/hunt/tracker", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id })
      });
      if (res.ok) {
        setVehicles(prev => prev.filter(v => v.id !== id));
        if (expandedId === id) setExpandedId(null);
      }
    } catch (err) {}
  }

  // ── Infer doc type from filename (CARFAX vs PPI) ───────────────────────────
  function inferDocType(fileName: string): string {
    const name = fileName.toLowerCase();
    if (/carfax|autocheck|vehicle.?history|car.?fax/.test(name)) return 'carfax';
    if (/ppi|inspection|pre.?purchase|mechanic|worksheet/.test(name)) return 'ppi';
    return 'carfax'; // sensible default
  }

  // ── Drag-and-drop handler ──────────────────────────────────────────────────
  function handleDrop(vehicleId: string, e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    setDragOverId(null);
    const file = e.dataTransfer.files?.[0];
    if (!file) return;
    attachDocument(vehicleId, file, inferDocType(file.name));
  }

  // ── Attach document to a vehicle ──────────────────────────────────────────
  async function attachDocument(vehicleId: string, file: File, docType: string) {
    setUploadingDocId(vehicleId);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("docType", docType);
      const res = await fetch(`/api/hunt/${vehicleId}/attach-document`, { method: "POST", body: fd });
      const data = await res.json();
      if (data.success) {
        // Score delta flash — shows +N / -N for 3.5 seconds
        const oldScore = vehicles.find(v => v.id === vehicleId)?.adjusted_score
          || vehicles.find(v => v.id === vehicleId)?.score || 0;
        const newScore = data.adjustedScore || data.vehicle?.adjusted_score || oldScore;
        const delta = newScore - oldScore;
        if (delta !== 0) {
          setScoreDelta(prev => ({ ...prev, [vehicleId]: delta }));
          setTimeout(() => setScoreDelta(prev => {
            const n = { ...prev }; delete n[vehicleId]; return n;
          }), 3500);
        }
        setVehicles(prev => prev.map(v => v.id === vehicleId ? { ...v, ...data.vehicle } : v));
      } else {
        alert(`Upload failed: ${data.error}`);
      }
    } catch (e: any) {
      alert(`Upload failed: ${e.message}`);
    } finally {
      setUploadingDocId(null);
    }
  }

  // ── Remove a document ─────────────────────────────────────────────────────
  async function removeDocument(vehicleId: string, docType: string) {
    // Optimistic: strip the doc locally immediately
    setVehicles(prev => prev.map(v => {
      if (v.id !== vehicleId) return v;
      const docs = (v.documents || []).filter((d: any) => d.type !== docType);
      return { ...v, documents: docs, confidence_pct: Math.max(25, (v.confidence_pct || 45) - (docType === 'carfax' ? 25 : 15)) };
    }));
    try {
      await fetch(`/api/hunt/${vehicleId}/attach-document`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ docType }),
      });
    } catch {}
  }

  // ── Scan listing photos ────────────────────────────────────────────────────
  async function scanPhotos(vehicleId: string) {
    setScanningPhotosId(vehicleId);
    try {
      const res = await fetch(`/api/hunt/${vehicleId}/scan-photos`, { method: "POST" });
      const data = await res.json();
      if (data.success) {
        setVehicles(prev => prev.map(v => v.id === vehicleId ? { ...v, ...data.vehicle } : v));
      } else {
        alert(data.error || "Photo scan failed");
      }
    } catch (e: any) {
      alert(e.message);
    } finally {
      setScanningPhotosId(null);
    }
  }

  // ── AI Deal Navigator ──────────────────────────────────────────────────────
  async function sendNavigatorMessage(vehicleId: string, userMsg: string = "") {
    const history = navigatorChat[vehicleId] || [];
    setNavigatorLoading(prev => ({ ...prev, [vehicleId]: true }));
    if (userMsg) setNavigatorChat(prev => ({ ...prev, [vehicleId]: [...(prev[vehicleId]||[]), { role: "user", content: userMsg }] }));
    setNavigatorInput(prev => ({ ...prev, [vehicleId]: "" }));
    try {
      const res = await fetch(`/api/hunt/${vehicleId}/navigator`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: userMsg, history, buyerProfile }),
      });
      const reader = res.body?.getReader();
      const dec = new TextDecoder();
      let assistantMsg = "";
      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          for (const line of dec.decode(value).split("\n")) {
            if (!line.startsWith("data: ")) continue;
            try {
              const ev = JSON.parse(line.slice(6));
              if (ev.type === "delta") {
                assistantMsg += ev.content;
                setNavigatorChat(prev => {
                  const h = [...(prev[vehicleId]||[])];
                  const last = h[h.length - 1];
                  if (last?.role === "assistant") h[h.length-1] = { role: "assistant", content: assistantMsg };
                  else h.push({ role: "assistant", content: assistantMsg });
                  return { ...prev, [vehicleId]: h };
                });
                // Auto-scroll to bottom as tokens stream in
                setTimeout(() => chatEndRefs.current[vehicleId]?.scrollIntoView({ behavior: "smooth" }), 20);
              }
            } catch {}
          }
        }
      }
      if (assistantMsg) extractAndSavePrefs(vehicleId, [...history, { role: "user", content: userMsg }, { role: "assistant", content: assistantMsg }]);
    } catch (e: any) {
      setNavigatorChat(prev => ({ ...prev, [vehicleId]: [...(prev[vehicleId]||[]), { role: "assistant", content: "⚠ Connection error. Please try again." }] }));
    } finally {
      setNavigatorLoading(prev => ({ ...prev, [vehicleId]: false }));
    }
  }

  // ── Advisor (unified AI broker) ─────────────────────────────────────────
  async function sendAdvisorMessage(msg: string) {
    const userMsg = msg.trim();
    const pendingFiles = [...advisorFiles];
    
    // Build display content — show file names alongside text
    const fileLabel = pendingFiles.length > 0
      ? pendingFiles.map(f => `📎 ${f.name}`).join('\n') + (userMsg ? '\n' + userMsg : '')
      : userMsg;
    
    const newChat = fileLabel
      ? [...advisorChat, { role: 'user' as const, content: fileLabel }]
      : [...advisorChat];
    
    if (fileLabel) setAdvisorChat(newChat);
    setAdvisorInput('');
    setAdvisorFiles([]);
    setAdvisorLoading(true);
    
    // Ensure we have a session — create one if needed
    let sessionId = activeSessionId;
    if (!sessionId) {
      const session = await createNewSession('New conversation');
      if (session) {
        sessionId = session.id;
      }
    }
    
    // Save user message to Supabase
    if (sessionId && fileLabel) {
      saveAdvisorMessage(sessionId, 'user', fileLabel);
    }
    
    // Build buyer profile from localStorage
    let profile: Record<string, string> = {};
    try { const s = localStorage.getItem('wc_buyer_profile'); if (s) profile = JSON.parse(s); } catch {}

    try {
      const res = await fetch('/api/advisor', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: userMsg || '',
          history: newChat.filter(m => m.content),
          buyerProfile: profile,
          files: pendingFiles.map(f => ({ name: f.name, type: f.type, dataUrl: f.dataUrl })),
        }),
      });

      const reader = res.body?.getReader();
      const dec = new TextDecoder();
      let assistantText = '';
      let buffer = '';

      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += dec.decode(value, { stream: true });
          
          // Parse SSE events
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          
          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            try {
              const data = JSON.parse(line.slice(6));
              if (data.type === 'delta') {
                assistantText += data.content;
                setAdvisorChat([...newChat, { role: 'assistant', content: assistantText }]);
              }
            } catch {}
          }
        }
      }

      const finalChat = [...newChat, { role: 'assistant', content: assistantText }];
      setAdvisorChat(finalChat);
      
      // Save assistant message
      if (sessionId && assistantText) {
        saveAdvisorMessage(sessionId, 'assistant', assistantText);
        // Auto-title after first exchange
        if (finalChat.length <= 3) {
          if (useLocalFallback.current) {
            // Local fallback: generate simple title from first user message
            const firstMsg = finalChat.find(m => m.role === 'user')?.content || '';
            const autoTitle = firstMsg.replace(/📎.*\n?/g, '').trim().slice(0, 40) || 'Chat';
            setAdvisorSessions(prev => {
              const updated = prev.map(s => s.id === sessionId ? { ...s, title: autoTitle } : s);
              saveLocalSessions(updated);
              return updated;
            });
          } else {
            fetch(`/api/advisor/sessions/${sessionId}/title`, { method: 'POST' })
              .then(r => r.json())
              .then(d => {
                if (d.title) {
                  setAdvisorSessions(prev => prev.map(s => s.id === sessionId ? { ...s, title: d.title } : s));
                }
              })
              .catch(() => {});
          }
        }
      }
      
      // ── WRITE-BACK: Extract insights from chat and update the Board ──
      if (userMsg || assistantText) {
        const lower = (userMsg || '').toLowerCase();
        const aiLower = assistantText.toLowerCase();
        
        // 1. Buyer preference extraction from user message
        const prefs: Record<string, string> = {};
        if (/terra/i.test(lower)) prefs.interior_color = 'Terra';
        if (/heritage/i.test(lower)) prefs.must_haves = (profile.must_haves || '') + ' Heritage Edition';
        const budgetMatch = lower.match(/budget.*?(\$?[\d,]+k?)/i) || lower.match(/under.*?(\$?[\d,]+k?)/i);
        if (budgetMatch) prefs.budget_ceiling = budgetMatch[1];
        if (Object.keys(prefs).length > 0) {
          const merged = { ...profile, ...prefs };
          localStorage.setItem('wc_buyer_profile', JSON.stringify(merged));
        }

        // 2. Extract price recommendations from Advisor and annotate the Board
        // Match vehicles: find which vehicle is being discussed
        const allV = vehicles;
        let matchedV: any = null;
        let bestScore = 0;
        for (const v of allV) {
          let score = 0;
          const year = String(v.year || '');
          const model = (v.model || '').toLowerCase();
          const trim = (v.trim || '').toLowerCase();
          if (year && lower.includes(year)) score += 3;
          if (model && lower.includes(model)) score += 2;
          if (trim && trim.length > 2 && lower.includes(trim)) score += 4;
          if (v.location) {
            const parts = v.location.split(/[,\s]+/).filter(Boolean);
            for (const p of parts) { if (p.length > 2 && lower.includes(p.toLowerCase())) { score += 3; break; } }
          }
          if (score > bestScore) { bestScore = score; matchedV = v; }
        }

        // If the Advisor mentioned a specific offer/price number for the matched vehicle
        if (matchedV && bestScore >= 2) {
          // Extract offer recommendation from AI response
          const offerMatch = assistantText.match(/(?:offer|bid|opening offer|target|I['']d offer|start at)[:\s]*\$?([\d,]+)/i);
          if (offerMatch) {
            const offerPrice = parseInt(offerMatch[1].replace(/,/g, ''), 10);
            if (offerPrice > 10000 && offerPrice < 200000) {
              // Save as gem_price_target
              saveVehicleField(matchedV.id, 'gem_price_target', offerPrice);
              console.log(`[advisor writeback] Set offer target for ${matchedV.year} ${matchedV.model}: $${offerPrice.toLocaleString()}`);
            }
          }

          // Extract user-provided mileage correction
          const mileageMatch = lower.match(/(?:actually|mileage is|it.?s at|has)\s+([\d,]+)\s*(?:mi|mile)/i);
          if (mileageMatch) {
            const newMi = parseInt(mileageMatch[1].replace(/,/g, ''), 10);
            if (newMi > 1000 && newMi < 500000) {
              saveVehicleField(matchedV.id, 'mileage', newMi);
              console.log(`[advisor writeback] Updated mileage for ${matchedV.year} ${matchedV.model}: ${newMi.toLocaleString()} mi`);
            }
          }

          // Extract user-provided price correction
          const priceCorrection = lower.match(/(?:price (?:is|dropped|changed|now)|asking|listed (?:at|for))\s*\$?([\d,]+)/i);
          if (priceCorrection) {
            const newPrice = parseInt(priceCorrection[1].replace(/,/g, ''), 10);
            if (newPrice > 10000 && newPrice < 200000) {
              saveVehicleField(matchedV.id, 'price', newPrice);
              console.log(`[advisor writeback] Updated price for ${matchedV.year} ${matchedV.model}: $${newPrice.toLocaleString()}`);
            }
          }
        }
      }
    } catch (err) {
      console.error('[advisor] Error:', err);
      setAdvisorChat([...newChat, { role: 'assistant', content: '⚠️ Connection error. Please try again.' }]);
    } finally {
      setAdvisorLoading(false);
      setTimeout(() => advisorEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 100);
    }
  }


  function openNavigator(vehicleId: string) {
    setNavigatorOpenId(vehicleId);
    if (!navigatorChat[vehicleId]?.length) {
      sendNavigatorMessage(vehicleId, "");
    }
  }

  // ── Scout Chat ────────────────────────────────────────────────────────────
  async function sendScoutMessage(msg: string) {
    if (!msg.trim()) return;
    const history = scoutChatHistory;
    const newHistory = [...history, { role: 'user', content: msg }];
    setScoutChatHistory(newHistory);
    setScoutChatInput('');
    setScoutChatLoading(true);
    try {
      const res = await fetch('/api/scout/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: msg, history }),
      });
      const reader = res.body?.getReader();
      const dec = new TextDecoder();
      let assistantMsg = '';
      let pendingConfig: any = null;
      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          for (const line of dec.decode(value).split('\n')) {
            if (!line.startsWith('data: ')) continue;
            try {
              const ev = JSON.parse(line.slice(6));
              if (ev.type === 'delta') {
                assistantMsg += ev.content;
                setScoutChatHistory(prev => {
                  const h = [...prev];
                  const last = h[h.length - 1];
                  if (last?.role === 'assistant') h[h.length-1] = { role: 'assistant', content: assistantMsg };
                  else h.push({ role: 'assistant', content: assistantMsg });
                  return h;
                });
              } else if (ev.type === 'done' && ev.savedConfig) {
                pendingConfig = ev.savedConfig;
              }
            } catch {}
          }
        }
      }
      if (pendingConfig) setScoutPendingConfig(pendingConfig);
    } catch (e: any) {
      setScoutChatHistory(prev => [...prev, { role: 'assistant', content: '⚠ Connection error. Try again.' }]);
    } finally {
      setScoutChatLoading(false);
    }
  }

  async function activateScoutConfig(configId: string) {
    setActivatingScout(true);
    try {
      await fetch('/api/scout/chat', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: configId }),
      });
      await fetchScoutConfigs();
      setScoutPendingConfig(null);
      setScoutChatHistory(prev => [...prev, { role: 'assistant', content: "✅ Scout is live! I'll check every 30 minutes and drop leads in your Inbox. You'll see a notification when I find something worth your time." }]);
    } finally {
      setActivatingScout(false);
    }
  }

  // ── Gem Alerts loader ─────────────────────────────────────────────────────
  async function fetchGemAlerts() {
    try {
      const res = await fetch('/api/scout/leads?status=new');
      const data = await res.json();
      const gems = (data.leads || []).filter((l: any) => l.shadow_tier === 'gem' || l.shadow_score >= 72);
      setGemAlerts(gems);
    } catch {}
  }

  return (


    <div style={{ minHeight: "100vh", background: BG, color: TEXT1, fontFamily: "'Inter', system-ui, sans-serif" }}>
      <div style={{ maxWidth: 1000, margin: "0 auto", padding: vehicles.length > 0 ? "40px" : "10vh 20px" }}>
        
        {/* ── SCOUT CHAT PANEL ─────────────────────────────────────────── */}
        {showScoutChat && (
          <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.7)', backdropFilter: 'blur(4px)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}
            onClick={() => setShowScoutChat(false)}>
            <div style={{ width: '100%', maxWidth: 560, background: '#0F172A', borderRadius: 20, overflow: 'hidden', boxShadow: '0 24px 80px rgba(0,0,0,0.5)', border: '1px solid #334155' }}
              onClick={e => e.stopPropagation()}>
              <div style={{ padding: '18px 22px', borderBottom: '1px solid #334155', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <div style={{ fontSize: 20 }}>🔭</div>
                  <div>
                    <div style={{ fontSize: 15, fontWeight: 800, color: '#F1F5F9' }}>Scout Setup</div>
                    <div style={{ fontSize: 11, color: '#64748B', marginTop: 1 }}>Tell me what you're hunting — I'll configure the search</div>
                  </div>
                </div>
                <button onClick={() => setShowScoutChat(false)} style={{ background: 'none', border: 'none', color: '#64748B', fontSize: 22, cursor: 'pointer', lineHeight: 1 }}>×</button>
              </div>
              <div style={{ maxHeight: 360, overflowY: 'auto', padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 12 }}>
                {scoutChatHistory.length === 0 && (
                  <div style={{ fontSize: 13, color: '#64748B', fontStyle: 'italic', textAlign: 'center', paddingTop: 20 }}>
                    Describe what you're hunting — make/model, budget, use case, or a vibe like "depreciation queen" or "reliable off-roader under $25k"
                  </div>
                )}
                {scoutChatHistory.map((msg: any, i: number) => (
                  <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', flexDirection: msg.role === 'user' ? 'row-reverse' : 'row' }}>
                    <div style={{ width: 26, height: 26, borderRadius: '50%', background: msg.role === 'user' ? '#334155' : '#4F46E5', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, flexShrink: 0 }}>
                      {msg.role === 'user' ? '👤' : '🔭'}
                    </div>
                    <div style={{ maxWidth: '86%', padding: '10px 14px', background: '#1E293B', borderRadius: msg.role === 'user' ? '14px 14px 4px 14px' : '4px 14px 14px 14px', fontSize: 13, lineHeight: 1.6, color: '#E2E8F0', whiteSpace: 'pre-wrap' }}>
                      {msg.content.replace(/---SCOUT_SUMMARY---[\s\S]*?---END_SUMMARY---/g, '').trim()}
                    </div>
                  </div>
                ))}
                {scoutChatLoading && (
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <div style={{ width: 26, height: 26, borderRadius: '50%', background: '#4F46E5', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11 }}>🔭</div>
                    <div style={{ fontSize: 13, color: '#64748B', fontStyle: 'italic' }}>Thinking…</div>
                  </div>
                )}
                {scoutPendingConfig && !activatingScout && (
                  <div style={{ background: '#0F2942', border: '1px solid #1D4ED8', borderRadius: 12, padding: '14px 16px' }}>
                    <div style={{ fontSize: 11, fontWeight: 800, color: '#60A5FA', letterSpacing: '0.08em', marginBottom: 8 }}>🎯 SCOUT READY</div>
                    <div style={{ fontSize: 13, color: '#BFDBFE', marginBottom: 12, lineHeight: 1.5 }}>
                      <strong style={{ color: '#F1F5F9' }}>{scoutPendingConfig.label}</strong>
                    </div>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button onClick={() => activateScoutConfig(scoutPendingConfig.id)}
                        style={{ flex: 1, padding: '10px 16px', background: '#4F46E5', color: '#fff', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>
                        🚀 Activate Scout
                      </button>
                      <button onClick={() => setScoutPendingConfig(null)}
                        style={{ padding: '10px 14px', background: 'transparent', color: '#64748B', border: '1px solid #334155', borderRadius: 8, fontSize: 13, cursor: 'pointer' }}>
                        Edit
                      </button>
                    </div>
                  </div>
                )}
              </div>
              <div style={{ padding: '12px 20px', borderTop: '1px solid #1E293B', display: 'flex', gap: 8 }}>
                <input
                  value={scoutChatInput}
                  onChange={e => setScoutChatInput(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && scoutChatInput.trim()) { e.preventDefault(); sendScoutMessage(scoutChatInput); } }}
                  placeholder="e.g. 'depreciation queen under $20k' or '2006 Land Cruiser nationwide'…"
                  style={{ flex: 1, padding: '10px 14px', background: '#1E293B', border: '1px solid #334155', borderRadius: 8, color: '#F1F5F9', fontSize: 13, outline: 'none' }}
                  autoFocus
                />
                <button onClick={() => { if (scoutChatInput.trim()) sendScoutMessage(scoutChatInput); }}
                  disabled={scoutChatLoading}
                  style={{ padding: '10px 16px', background: '#4F46E5', color: '#fff', border: 'none', borderRadius: 8, fontSize: 14, fontWeight: 700, cursor: 'pointer', opacity: scoutChatLoading ? 0.6 : 1 }}>↑</button>
              </div>
              {scoutConfigs.filter((c: any) => c.is_active).length > 0 && (
                <div style={{ padding: '10px 20px 16px', borderTop: '1px solid #1E293B' }}>
                  <div style={{ fontSize: 10, fontWeight: 800, color: '#334155', letterSpacing: '0.08em', marginBottom: 8 }}>ACTIVE SCOUTS</div>
                  {scoutConfigs.filter((c: any) => c.is_active).map((c: any) => (
                    <div key={c.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 12, color: '#64748B', padding: '4px 0' }}>
                      <span>🟢 {c.label}</span>
                      <button onClick={async () => { await fetch('/api/scout/config', { method: 'DELETE', headers: {'Content-Type':'application/json'}, body: JSON.stringify({id: c.id}) }); await fetchScoutConfigs(); }}
                        style={{ background: 'none', border: 'none', color: '#EF4444', fontSize: 11, cursor: 'pointer' }}>Deactivate</button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* ENHANCED ADD CARS MODAL */}
        {showAddModal && (
          <div style={{ position: "fixed", top: 0, left: 0, right: 0, bottom: 0, background: "rgba(15,23,42,0.8)", backdropFilter: "blur(4px)", zIndex: 100, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
            <div style={{ width: "100%", maxWidth: 500, background: SURFACE, borderRadius: 24, overflow: "hidden", boxShadow: "0 24px 64px rgba(0,0,0,0.2)" }}>
              <div style={{ padding: "24px 32px", borderBottom: `1px solid ${BORDER}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <h2 style={{ fontSize: 20, fontWeight: 800, margin: 0 }}>Add Inventory</h2>
                {!streaming && <button onClick={() => setShowAddModal(false)} style={{ background: "none", border: "none", fontSize: 24, color: TEXT3, cursor: "pointer" }}>×</button>}
              </div>
              
              {streaming ? (
                <div style={{ padding: 40, textAlign: "center" }}>
                  <Loader2 size={32} color={ACCENT} style={{ animation: "spin 1s linear infinite", margin: "0 auto 20px" }} />
                  <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 16 }}>Running AI Processing Engine...</div>
                  <div style={{ textAlign: "left", background: BG, border: `1px solid ${BORDER}`, borderRadius: 12, padding: 16, display: "flex", flexDirection: "column", gap: 8 }}>
                    {streamProgress.map((p, i) => (
                       <div key={i} style={{ fontSize: 13, color: p.type === 'error' ? '#EF4444' : p.type === 'success' ? '#10B981' : TEXT2, display: 'flex', gap: 8 }}>
                         <span>{p.type === 'error' ? '❌' : p.type === 'success' ? '✅' : '⚙️'}</span>
                         <span>{p.message}</span>
                       </div>
                    ))}
                  </div>
                </div>
              ) : streamDone ? (
                // Post-stream results summary — only shown when there were errors
                <div style={{ padding: 32 }}>
                  {(() => {
                    const successes = streamProgress.filter(p => p?.type === 'success');
                    const errors = streamProgress.filter(p => p?.type === 'error');
                    const warnings = streamProgress.filter(p => p?.type === 'warning');
                    return (
                      <>
                        <div style={{ fontSize: 18, fontWeight: 800, marginBottom: 16 }}>Import Complete</div>
                        {successes.length > 0 && (
                          <div style={{ padding: 12, background: '#F0FDF4', borderRadius: 10, border: '1px solid #86EFAC', marginBottom: 12 }}>
                            <div style={{ fontWeight: 700, color: '#15803D', fontSize: 13 }}>✅ {successes.length} vehicle{successes.length > 1 ? 's' : ''} added to your watchlist</div>
                          </div>
                        )}
                        {warnings.length > 0 && warnings.map((w, i) => (
                          <div key={i} style={{ padding: 12, background: '#FFFBEB', borderRadius: 10, border: '1px solid #FDE68A', marginBottom: 8 }}>
                            <div style={{ fontWeight: 700, color: '#92400E', fontSize: 12 }}>⚠ {w.message}</div>
                          </div>
                        ))}
                        {/* Facebook Marketplace blocked — friendly specific card */}
                        {fbBlocked.length > 0 && (
                          <div style={{ marginBottom: 16 }}>
                            <div style={{ fontWeight: 700, color: '#1D4ED8', fontSize: 13, marginBottom: 8 }}>
                              📘 {fbBlocked.length} Facebook Marketplace listing{fbBlocked.length > 1 ? 's' : ''} couldn't be read
                            </div>
                            <div style={{ padding: 14, background: '#EFF6FF', borderRadius: 10, border: '1px solid #BFDBFE', fontSize: 12, color: '#1e40af', lineHeight: 1.6 }}>
                              <div style={{ fontWeight: 700, marginBottom: 6 }}>Facebook blocks automated scraping — here's how to add this car:</div>
                              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                                <div>① <strong>Best option:</strong> Copy the Marketplace URL into Cars.com, CarGurus, or AutoTrader search — many dealers cross-post</div>
                                <div>② <strong>Quick option:</strong> Take a screenshot → use "Manual Entry" tab to add Year/Make/Model/Price yourself</div>
                                <div>③ <strong>If private seller:</strong> Copy the listing text, create a manual entry, then ask the AI Navigator for a deal analysis</div>
                              </div>
                              <button onClick={() => { setActiveTab('manual'); setStreamDone(false); setStreamProgress([]); setFbBlocked([]); }}
                                style={{ marginTop: 10, padding: '6px 14px', background: '#1D4ED8', color: '#fff', border: 'none', borderRadius: 6, fontSize: 11, fontWeight: 700, cursor: 'pointer' }}>
                                ➕ Enter Manually Instead
                              </button>
                            </div>
                          </div>
                        )}
                        {errors.length > 0 && (
                          <div style={{ marginBottom: 16 }}>
                            <div style={{ fontWeight: 700, color: '#B91C1C', fontSize: 13, marginBottom: 8 }}>❌ {errors.length} listing{errors.length > 1 ? 's' : ''} couldn't be imported:</div>
                            {errors.map((e, i) => (
                              <div key={i} style={{ padding: 10, background: '#FEF2F2', borderRadius: 8, border: '1px solid #FECACA', marginBottom: 6, fontSize: 12, color: '#991B1B', lineHeight: 1.4 }}>
                                {e.message}
                              </div>
                            ))}
                            <div style={{ fontSize: 12, color: TEXT3, marginTop: 8 }}>Tip: Make sure URLs are direct listing pages, not search results. BaT, Cars.com, and CarGurus direct links work best.</div>
                            {errors.some(e => e.url) && (
                              <button
                                onClick={() => {
                                  const failedUrls = errors.filter(e => e.url).map(e => e.url).join('\n');
                                  setBatchUrls(failedUrls);
                                  setStreamDone(false);
                                  setStreamProgress([]);
                                  setActiveTab('urls');
                                }}
                                style={{ marginTop: 12, padding: '8px 16px', background: ACCENT, color: '#fff', border: 'none', borderRadius: 8, fontSize: 12, fontWeight: 700, cursor: 'pointer' }}
                              >
                                ↩ Retry Failed Listings
                              </button>
                            )}
                          </div>
                        )}

                        <button onClick={() => { setShowAddModal(false); setStreamDone(false); setStreamProgress([]); }} style={{ width: '100%', padding: '12px', background: TEXT1, color: '#fff', borderRadius: 10, border: 'none', fontSize: 14, fontWeight: 700, cursor: 'pointer' }}>Done</button>
                      </>
                    );
                  })()}
                </div>
              ) : (
                <form onSubmit={handleBulkAdd} style={{ padding: "32px" }}>
                  <div style={{ display: "flex", gap: 12, marginBottom: 20 }}>
                    <button type="button" onClick={() => setActiveTab("urls")} style={{ flex: 1, padding: "10px", background: activeTab==="urls" ? TEXT1 : BG, color: activeTab==="urls" ? "#fff" : TEXT2, borderRadius: 8, border: "none", fontWeight: 600, cursor: "pointer" }}>Bulk URLs</button>
                    <button type="button" onClick={() => setActiveTab("manual")} style={{ flex: 1, padding: "10px", background: activeTab==="manual" ? TEXT1 : BG, color: activeTab==="manual" ? "#fff" : TEXT2, borderRadius: 8, border: "none", fontWeight: 600, cursor: "pointer" }}>Manual Entry</button>
                  </div>

                  {activeTab === "urls" ? (
                    <div>
                      <div style={{ fontSize: 13, color: TEXT2, marginBottom: 8, fontWeight: 500 }}>Paste multiple Cars.com or CarGurus links (one per line):</div>
                      <textarea 
                        value={batchUrls}
                        onChange={e => { setBatchUrls(e.target.value); setUrlWarnings([]); }}
                        placeholder="https://...&#10;https://..."
                        rows={6}
                        style={{ width: "100%", padding: 16, borderRadius: 12, border: `1px solid ${urlWarnings.length ? '#EF4444' : BORDER}`, outline: "none", fontSize: 14, fontFamily: "monospace", resize: "none" }}
                      />
                      {urlWarnings.length > 0 && (
                        <div style={{ marginTop: 8, padding: 12, background: '#FEF2F2', borderRadius: 10, border: '1px solid #FECACA' }}>
                          <div style={{ fontWeight: 700, color: '#B91C1C', fontSize: 12, marginBottom: 6 }}>🚫 These look like search pages, not listings:</div>
                          {urlWarnings.map((u, i) => <div key={i} style={{ fontFamily: 'monospace', fontSize: 11, color: '#991B1B', marginBottom: 2, wordBreak: 'break-all' }}>{u.slice(0, 80)}...</div>)}
                          <div style={{ fontSize: 11, color: TEXT3, marginTop: 6 }}>Open the listing itself and copy that URL (it should contain a vehicle ID or VIN, not a search query).</div>
                        </div>
                      )}
                    </div>
                  ) : (
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                      <input placeholder="Year *" required value={manualEntry.year} onChange={e=>setManualEntry(m=>({...m, year: e.target.value}))} style={{ padding: 12, borderRadius: 8, border: `1px solid ${BORDER}`, outline: "none" }} />
                      <input placeholder="Make *" required value={manualEntry.make} onChange={e=>setManualEntry(m=>({...m, make: e.target.value}))} style={{ padding: 12, borderRadius: 8, border: `1px solid ${BORDER}`, outline: "none" }} />
                      <input placeholder="Model *" required style={{ gridColumn: "span 2" }} value={manualEntry.model} onChange={e=>setManualEntry(m=>({...m, model: e.target.value}))} />
                      <input placeholder="Price ($)" value={manualEntry.price} onChange={e=>setManualEntry(m=>({...m, price: e.target.value}))} style={{ padding: 12, borderRadius: 8, border: `1px solid ${BORDER}`, outline: "none" }} />
                      <input placeholder="Mileage" value={manualEntry.mileage} onChange={e=>setManualEntry(m=>({...m, mileage: e.target.value}))} style={{ padding: 12, borderRadius: 8, border: `1px solid ${BORDER}`, outline: "none" }} />
                    </div>
                  )}

                  <button type="submit" style={{ width: "100%", padding: 16, background: ACCENT, color: "#fff", border: "none", borderRadius: 12, fontWeight: 700, fontSize: 16, marginTop: 24, cursor: "pointer", boxShadow: "0 4px 12px rgba(79,70,229,0.3)" }}>
                    Process Cars
                  </button>
                </form>
              )}
            </div>
          </div>
        )}

        {/* LOBBY / EMPTY STATE */}
        {vehicles.length === 0 && viewTab === 'board' ? (
          <div style={{ textAlign: "center", maxWidth: 600, margin: "0 auto", animation: "fadeIn 0.5s ease" }}>
            <div style={{ display: "inline-block", padding: "6px 14px", background: "#EEF2FF", border: "1px solid #C7D2FE", borderRadius: 99, color: "#4F46E5", fontWeight: 700, fontSize: 12, letterSpacing: "0.08em", marginBottom: 24 }}>
              GAUNTLET — MULTI-CAR COMPARISON
            </div>
            
            <h1 style={{ fontSize: 48, fontWeight: 900, color: "#0F172A", margin: "0 0 16px", letterSpacing: "-0.04em", lineHeight: 1.1 }}>
              Find the Gem.
            </h1>
            
            <p style={{ fontSize: 16, color: "#475569", lineHeight: 1.6, marginBottom: 40 }}>
              Bulk upload listings. We instantly rank them by real price vs. fair value, maintenance exposure, and location risk — so you know which one to buy before you even drive it.
            </p>

            <button onClick={() => setShowAddModal(true)} style={{ padding: "20px 40px", borderRadius: 16, background: TEXT1, color: "#fff", border: "none", fontSize: 18, fontWeight: 800, cursor: "pointer", boxShadow: "0 12px 32px rgba(0,0,0,0.15)", display: "flex", alignItems: "center", gap: 12, margin: "0 auto" }}>
              <span style={{ fontSize: 24 }}>+</span> Add Vehicles to Inventory
            </button>

            <div style={{ marginTop: 24, fontSize: 13, color: TEXT3, fontWeight: 500 }}>
              Upload via URLs or Manual Entry. AI extracts scores automatically.
            </div>

            {/* Scout shortcut */}
            <div style={{ marginTop: 32, paddingTop: 28, borderTop: '1px solid #E2E8F0' }}>
              <div style={{ fontSize: 13, color: TEXT3, marginBottom: 12 }}>Or let WrenchCheck find cars for you</div>
              <button onClick={() => setViewTab('board')}
                style={{ padding: '12px 28px', borderRadius: 12, background: '#EEF2FF', border: '1px solid #C7D2FE', color: ACCENT, fontWeight: 700, fontSize: 14, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                🔍 Open Scout Inbox
              </button>
            </div>
          </div>
        ) : (
          <div style={{ animation: "fadeIn 0.3s ease" }}>
            {/* GRID / POPULATED STATE */}
            {/* ── SCOUT STATUS BAR ─────────────────────────────────────── */}
            {scoutConfigs.some((c: any) => c.is_active) && (
              <div style={{ marginBottom: 16, padding: '8px 16px', background: 'linear-gradient(135deg, #0F172A 0%, #1E293B 100%)', borderRadius: 10, border: '1px solid #334155', display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                <span style={{ display: 'inline-block', width: 7, height: 7, borderRadius: '50%', background: '#22C55E', boxShadow: '0 0 6px #22C55E', animation: 'pulse 2s infinite' }} />
                <span style={{ fontSize: 11, fontWeight: 700, color: '#94A3B8' }}>Scout Active</span>
                <span style={{ fontSize: 11, color: '#334155' }}>·</span>
                {scoutConfigs.filter((c: any) => c.is_active).map((c: any) => (
                  <span key={c.id} style={{ fontSize: 11, fontWeight: 600, color: '#60A5FA' }}>{c.label}</span>
                ))}
                {scoutConfigs.find((c: any) => c.is_active)?.last_run_at && (
                  <>
                    <span style={{ fontSize: 11, color: '#334155' }}>·</span>
                    <span style={{ fontSize: 11, color: '#64748B' }}>
                      Last scan: {(() => { const d = new Date(scoutConfigs.find((c: any) => c.is_active)?.last_run_at); const mins = Math.round((Date.now() - d.getTime()) / 60000); return mins < 60 ? `${mins}m ago` : `${Math.round(mins/60)}h ago`; })()}
                    </span>
                  </>
                )}
                {scoutLeads.length > 0 && (
                  <>
                    <span style={{ fontSize: 11, color: '#334155' }}>·</span>
                    <button onClick={() => { setViewTab('board'); setTimeout(() => inboxRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 100); }}
                      style={{ fontSize: 11, fontWeight: 800, color: '#FB923C', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
                      ● {scoutLeads.length} new lead{scoutLeads.length > 1 ? 's' : ''} →
                    </button>
                  </>
                )}
                <button onClick={() => setShowScoutChat(true)} style={{ marginLeft: 'auto', fontSize: 10, fontWeight: 700, color: '#4F46E5', background: 'none', border: 'none', cursor: 'pointer' }}>Configure</button>
              </div>
            )}

            <header style={{ marginBottom: 24 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginBottom: 16 }}>
                <div>
                  <div style={{ fontSize: 11, fontWeight: 800, color: ACCENT, letterSpacing: "0.1em", marginBottom: 4 }}>MASTER INVENTORY</div>
                  <h1 style={{ fontSize: 32, fontWeight: 900, letterSpacing: "-0.03em", margin: 0 }}>The Hunt</h1>
                </div>
                <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                  {/* Gem alert bell */}
                  <div style={{ position: 'relative' }}>
                    <button onClick={() => { setShowNotifications(!showNotifications); fetchGemAlerts(); }}
                      style={{ padding: '10px 14px', background: gemAlerts.length > 0 ? '#FFF7ED' : BG, border: `1px solid ${gemAlerts.length > 0 ? '#FDBA74' : BORDER}`, borderRadius: 10, fontSize: 16, cursor: 'pointer', lineHeight: 1 }}>
                      🔔
                      {gemAlerts.length > 0 && (
                        <span style={{ position: 'absolute', top: 4, right: 4, width: 8, height: 8, borderRadius: '50%', background: '#EA580C', animation: 'pulse 1.5s infinite' }} />
                      )}
                    </button>
                    {showNotifications && (
                      <div style={{ position: 'absolute', top: '110%', right: 0, width: 320, background: SURFACE, border: `1px solid ${BORDER}`, borderRadius: 14, boxShadow: '0 8px 32px rgba(0,0,0,0.12)', zIndex: 50, overflow: 'hidden' }} onClick={e => e.stopPropagation()}>
                        <div style={{ padding: '12px 16px', borderBottom: `1px solid ${BORDER}`, fontSize: 11, fontWeight: 800, color: TEXT3, letterSpacing: '0.08em' }}>GEM ALERTS</div>
                        {gemAlerts.length === 0 ? (
                          <div style={{ padding: '20px 16px', fontSize: 13, color: TEXT3, textAlign: 'center' }}>No new gem leads. Scout is watching.</div>
                        ) : (
                          gemAlerts.slice(0, 5).map((lead: any) => (
                            <div key={lead.id} style={{ padding: '12px 16px', borderBottom: `1px solid ${BORDER}`, display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                              <span style={{ fontSize: 16 }}>💎</span>
                              <div style={{ flex: 1 }}>
                                <div style={{ fontSize: 13, fontWeight: 700 }}>{lead.year} {lead.make} {lead.model}</div>
                                <div style={{ fontSize: 11, color: TEXT2 }}>{lead.price ? `$${lead.price.toLocaleString()}` : ''} · {lead.location || ''} · Score {lead.shadow_score}</div>
                                <button onClick={() => { setViewTab('board'); setShowNotifications(false); }}
                                  style={{ marginTop: 4, fontSize: 11, color: ACCENT, fontWeight: 700, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
                                  View in Inbox →
                                </button>
                              </div>
                            </div>
                          ))
                        )}
                      </div>
                    )}
                  </div>
                  {/* Scout button */}
                  <button onClick={() => setShowScoutChat(true)} style={{ position: 'relative', padding: "10px 16px", borderRadius: 10, border: `1px solid ${BORDER}`, background: scoutConfigs.some((c:any)=>c.is_active) ? '#F0FDF4' : BG, color: TEXT1, fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>
                    🔭 Scout
                    {scoutConfigs.some((c:any)=>c.is_active) && <span style={{ marginLeft: 6, fontSize: 10, background: '#22C55E', color: '#fff', borderRadius: 99, padding: '1px 6px', fontWeight: 800 }}>Active</span>}
                  </button>
                  <button onClick={() => setShowAddModal(true)} style={{ padding: "12px 24px", borderRadius: 10, background: ACCENT, color: "#fff", border: "none", fontSize: 14, fontWeight: 700, cursor: "pointer" }}>
                    + Add to Radar
                  </button>
                </div>
              </div>

              {/* ── BOARD / ADVISOR TABS ──────────────────────────────── */}
              <div style={{ display: 'flex', gap: 4, marginBottom: 16, background: '#F1F5F9', padding: 4, borderRadius: 12, width: 'fit-content' }}>
                <button onClick={() => setViewTab('board')}
                  style={{ padding: '8px 24px', borderRadius: 10, fontSize: 13, fontWeight: 700, cursor: 'pointer', border: 'none', background: viewTab === 'board' ? '#fff' : 'transparent', color: viewTab === 'board' ? TEXT1 : TEXT3, boxShadow: viewTab === 'board' ? '0 1px 4px rgba(0,0,0,0.08)' : 'none', transition: 'all 0.15s' }}>
                  📋 Board <span style={{ fontWeight: 600, opacity: 0.6 }}>({vehicles.length})</span>
                </button>
                <button onClick={() => setViewTab('advisor')}
                  style={{ padding: '8px 24px', borderRadius: 10, fontSize: 13, fontWeight: 700, cursor: 'pointer', border: 'none', background: viewTab === 'advisor' ? '#fff' : 'transparent', color: viewTab === 'advisor' ? '#4F46E5' : TEXT3, boxShadow: viewTab === 'advisor' ? '0 1px 4px rgba(79,70,229,0.12)' : 'none', transition: 'all 0.15s' }}>
                  💬 Advisor
                  {advisorChat.length === 0 && <span style={{ marginLeft: 6, fontSize: 9, background: '#4F46E5', color: '#fff', borderRadius: 99, padding: '1px 6px', fontWeight: 800 }}>NEW</span>}
                </button>
              </div>

              {/* ── Tag Filter Row (Radar only) ── */}
              {viewTab === 'board' && vehicles.length > 0 && (
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                  <span style={{ fontSize: 11, fontWeight: 700, color: TEXT3 }}>FILTER:</span>
                  {[
                    { key: 'no_accident', label: '✅ No Accidents', test: (v: any) => v.has_accident === false },
                    { key: 'one_owner', label: '👤 1-Owner', test: (v: any) => v.owner_count === 1 },
                    { key: 'gem', label: '💎 Gems Only', test: (v: any) => v.tier === 'gem' },
                    { key: 'clean_photos', label: '📸 Clean Photos', test: (v: any) => ['clean'].includes(v.photo_intel?.condition) },
                    { key: 'auction', label: '⏰ Auctions', test: (v: any) => {
                      let ai: any = null; try { const s = v.description?.split('__WRENCH_AUDIT_JSON__')?.[1]; if(s) ai = JSON.parse(s); } catch {}
                      return !!(ai?.auctionEndDate);
                    }},
                    { key: 'verified', label: '🔬 AI Verified', test: (v: any) => v.enrichment_status === 'complete' },
                  ].map(f => {
                    const count = vehicles.filter(f.test).length;
                    if (count === 0) return null;
                    const isActive = activeTagFilter === f.key;
                    return (
                      <button key={f.key} onClick={() => setActiveTagFilter(isActive ? null : f.key)}
                        style={{ padding: '4px 10px', borderRadius: 99, fontSize: 11, fontWeight: 700, cursor: 'pointer', border: `1px solid ${isActive ? ACCENT : BORDER}`, background: isActive ? '#EEF2FF' : BG, color: isActive ? ACCENT : TEXT2, transition: 'all 0.15s' }}>
                        {f.label} <span style={{ opacity: 0.7 }}>({count})</span>
                      </button>
                    );
                  })}
                  {activeTagFilter && (
                    <button onClick={() => setActiveTagFilter(null)} style={{ padding: '4px 10px', borderRadius: 99, fontSize: 11, fontWeight: 600, cursor: 'pointer', background: 'transparent', color: TEXT3, border: `1px dashed ${BORDER}` }}>
                      ✕ Clear filter
                    </button>
                  )}
                </div>
              )}
            </header>

            {errorMsg && (
              <div style={{ background: "#FEF2F2", color: "#B91C1C", padding: 16, borderRadius: 12, marginBottom: 24, fontWeight: 600 }}>
                {errorMsg}
              </div>
            )}


            {/* ── RADAR TAB ─────────────────────────────────────────────── */}
            {viewTab === 'board' && (
            <div>
            {/* Portfolio Grid leaderboard */}
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {loading ? (
                <div style={{ padding: 40, textAlign: "center", color: TEXT3 }}>Loading inventory...</div>
              ) : (
                <>{(() => {
                  const TAG_FILTERS: Record<string, (v: any) => boolean> = {
                    no_accident: (v: any) => v.has_accident === false,
                    one_owner: (v: any) => v.owner_count === 1,
                    gem: (v: any) => v.tier === 'gem',
                    clean_photos: (v: any) => ['clean'].includes(v.photo_intel?.condition),
                    auction: (v: any) => { let ai: any = null; try { const s = v.description?.split('__WRENCH_AUDIT_JSON__')?.[1]; if(s) ai = JSON.parse(s); } catch {} return !!(ai?.auctionEndDate); },
                    verified: (v: any) => v.enrichment_status === 'complete',
                  };
                  const orderMap: Record<string, number> = {};
                  radarOrder.forEach((id, i) => { orderMap[id] = i; });
                  const baseList = [...vehicles]
                    .filter((v: any) => !deletedVisually[v.id])
                    .filter((v: any) => !activeTagFilter || (TAG_FILTERS[activeTagFilter]?.(v) ?? true))
                    .sort((a: any, b: any) => {
                      const ai = orderMap[a.id] ?? 9999, bi = orderMap[b.id] ?? 9999;
                      if (ai === 9999 && bi === 9999) return liveScore(b) - liveScore(a);
                      return ai - bi;
                    });
                  const focusVehicles = baseList.filter((v: any) => (vehicleStatuses[v.id] || v.status || 'watching') === 'focus');
                  const watchVehicles = baseList.filter((v: any) => (vehicleStatuses[v.id] || v.status || 'watching') !== 'focus');

                  const renderCard = (v: any, rankIdx: number) => {
                   const rank = rankIdx + 1;
                   const isExpanded = expandedId === v.id;
                   const vStatus = vehicleStatuses[v.id] || v.status || 'watching';
                  let aiData: any = null;
                  const rawStr = v.description?.split("__WRENCH_AUDIT_JSON__")?.[1];
                  if (rawStr) { try { aiData = JSON.parse(rawStr); } catch(e) {} }

                  const mi = aiData?.modelInsights || aiData;
                  const storedTake = mi?.expertTake || aiData?.verdict || "Analysis complete. Review physical condition closely.";
                  const expertTake = expertTakeCache[v.id] || storedTake;
                  const isTakeLoading = regenningTakeId === v.id && !expertTakeCache[v.id];
                  const repairs = mi?.majorExposures || aiData?.majorExposures || aiData?.repairs || [];
                  const redFlags = mi?.watchouts || aiData?.watchouts || [];
                  const auctionEndDate = aiData?.auctionEndDate || null;
                  const tco = mi?.tco || aiData?.tco || null;
                  const controversyIndex = typeof (mi?.controversyIndex ?? aiData?.controversyIndex) === 'number' ? (mi?.controversyIndex ?? aiData?.controversyIndex) : null;
                  const reliabilityTier = mi?.reliabilityTier || aiData?.reliabilityTier || null;
                  const isSaltBelt = v.location ? /ohio|michigan|\bny\b|new york|pennsylvania|\bpa\b|illinois|indiana|minnesota|wisconsin|connecticut|new jersey|\bnj\b|massachusetts|\bma\b|maryland|\bmd\b/i.test(v.location) : false;
                  const shippingTier = computeShippingTier(v.location);
                  
                  let targetString = null;
                  if (!v.price && v.gem_price_target) targetString = `Auction / Bid Target: ${fmt$(v.gem_price_target)}`;
                  else if (v.gem_price_target) targetString = `TGT: ${fmt$(v.gem_price_target)}`;

                  return (
                    <div key={v.id}
                      draggable
                      onDragStart={() => setDragId(v.id)}
                      onDragOver={(e) => { e.preventDefault(); setDragOverId(v.id); }}
                      onDrop={() => handleVehicleReorder(v.id)}
                      onDragEnd={() => { setDragId(null); setDragOverId(null); }}
                      style={{ 
                        display: "flex", flexDirection: "column",
                        background: isExpanded && v.tier === 'gem' ? '#0F172A' : SURFACE, 
                        borderRadius: 16,
                        border: `2px solid ${dragOverId === v.id ? '#6366F1' : isExpanded ? (v.tier === 'gem' ? '#334155' : ACCENT) : (v.tier === 'gem' && rank === 1 ? '#4F46E5' : BORDER)}`, 
                        transition: "all 0.2s", overflow: "hidden",
                        boxShadow: isExpanded ? "0 4px 16px rgba(79, 70, 229, 0.1)" : "0 2px 4px rgba(0,0,0,0.02)",
                        transform: dragId === v.id ? "scale(0.98)" : isExpanded ? "translateY(-1px)" : "none",
                        opacity: dragId === v.id ? 0.7 : 1,
                        cursor: 'grab',
                    }}>
                      
                      {/* HEADER ROW */}
                      <div onClick={() => toggleRow(v.id)} style={{ display: "flex", alignItems: "center", padding: 16, cursor: "pointer", gap: 12 }}>
                        {/* Drag handle */}
                        <div onMouseDown={(e) => e.stopPropagation()} style={{ flexShrink: 0, cursor: 'grab', color: '#CBD5E1', fontSize: 16, lineHeight: 1, userSelect: 'none', padding: '0 2px' }} title="Drag to reorder">⠿</div>
                        {/* Compare checkbox */}
                        <div onClick={e => { e.stopPropagation(); toggleCompare(v.id); }} style={{ flexShrink: 0, width: 20, height: 20, borderRadius: 4, border: `2px solid ${compareIds.has(v.id) ? '#4F46E5' : '#CBD5E1'}`, background: compareIds.has(v.id) ? '#4F46E5' : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', transition: 'all 0.15s' }} title="Select for comparison">
                          {compareIds.has(v.id) && <span style={{ color: '#fff', fontSize: 12, fontWeight: 900, lineHeight: 1 }}>✓</span>}
                        </div>
                        {/* Deal Score gauge */}
                        <DealScoreGauge score={liveScore(v)} size={44} />

                        {/* Vehicle photo thumbnail */}
                        {(() => {
                          const photoUrl = v.photo_intel?.photoUrls?.[0] || null;
                          return (
                            <div style={{
                              flexShrink: 0, width: 80, height: 56, borderRadius: 8, overflow: 'hidden',
                              background: photoUrl ? 'transparent' : '#F1F5F9',
                              border: `1px solid ${photoUrl ? '#E2E8F0' : '#F1F5F9'}`,
                              display: 'flex', alignItems: 'center', justifyContent: 'center',
                            }}>
                              {photoUrl ? (
                                <img
                                  src={photoUrl}
                                  alt={`${v.year} ${v.make} ${v.model}`}
                                  style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                                  onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; (e.target as HTMLImageElement).parentElement!.innerHTML = '<span style="font-size:20px;opacity:0.3">📷</span>'; }}
                                />
                              ) : (
                                <span style={{ fontSize: 20, opacity: 0.25 }}>📷</span>
                              )}
                            </div>
                          );
                        })()}

                        <div style={{ flex: 1.5 }}>
                          <div style={{ fontSize: 16, fontWeight: 800 }}>{v.year} {v.make} {v.model} {v.trim}</div>
                          <div style={{ fontSize: 13, color: TEXT2, marginTop: 4, display: "flex", gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
                            {editingMileageId === v.id ? (
                              <span onClick={e => e.stopPropagation()} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                                <input autoFocus type="number" placeholder="e.g. 48000" value={mileageInput}
                                  onChange={e => setMileageInput(e.target.value)}
                                  onKeyDown={e => { if (e.key === 'Enter') saveMileage(v.id); if (e.key === 'Escape') { setEditingMileageId(null); setMileageInput(''); }}}
                                  onBlur={() => saveMileage(v.id)}
                                  style={{ width: 90, padding: '1px 6px', borderRadius: 4, border: '1px solid #F59E0B', fontSize: 12, outline: 'none' }} />
                                <span style={{ fontSize: 11, color: '#94A3B8' }}>mi</span>
                              </span>
                            ) : (
                              <span>{v.mileage ? `${v.mileage.toLocaleString()} mi` : <span style={{ color: "#F59E0B", fontWeight: 700 }}>⚠ Enter mileage <button onClick={e => { e.stopPropagation(); setMileageInput(''); setEditingMileageId(v.id); }} style={{ background: "none", border: "1px solid #F59E0B", borderRadius: 4, color: "#F59E0B", fontSize: 10, cursor: "pointer", padding: "0 4px", marginLeft: 3 }}>+</button></span>}</span>
                            )}
                            {v.location && <><span>•</span><span>{v.location}</span></>}
                            {v.market_mid && <><span>•</span><span style={{ fontWeight: 700 }}>Mkt {fmt$(v.market_mid)}</span></>}
                            {!!v.days_on_market && <><span>•</span><span style={{ fontWeight: 700, color: v.days_on_market > 45 ? '#B45309' : v.days_on_market > 21 ? '#92400E' : TEXT2 }}>{v.days_on_market}d on market</span></> }
                          </div>
                          {/* PULSE TAGS */}
                          <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginTop: 7 }}>
                            {v.has_accident === false && <span style={{ padding: "2px 7px", borderRadius: 99, fontSize: 10, fontWeight: 700, background: '#F0FDF4', color: '#15803D', border: '1px solid #86EFAC' }}>✅ No Accidents</span>}
                            {v.has_accident === true && <span style={{ padding: "2px 7px", borderRadius: 99, fontSize: 10, fontWeight: 700, background: '#FEF2F2', color: '#B91C1C', border: '1px solid #FECACA' }}>🚨 Accident Reported</span>}
                            {v.owner_count === 1 && <span style={{ padding: "2px 7px", borderRadius: 99, fontSize: 10, fontWeight: 700, background: '#F0FDF4', color: '#15803D', border: '1px solid #86EFAC' }}>1-Owner</span>}
                            {!isSaltBelt && v.location && <span style={{ padding: "2px 7px", borderRadius: 99, fontSize: 10, fontWeight: 700, background: '#F0FDF4', color: '#15803D', border: '1px solid #86EFAC' }}>🌵 Rust-Free Region</span>}
                            {isSaltBelt && <span style={{ padding: "2px 7px", borderRadius: 99, fontSize: 10, fontWeight: 700, background: '#FFF7ED', color: '#C2410C', border: '1px solid #FDBA74' }}>🧊 Salt Belt</span>}
                            {reliabilityTier === 'excellent' && <span style={{ padding: "2px 7px", borderRadius: 99, fontSize: 10, fontWeight: 700, background: '#F0FDF4', color: '#15803D', border: '1px solid #86EFAC' }}>⭐ Excellent Reliability</span>}
                            {reliabilityTier === 'poor' && <span style={{ padding: "2px 7px", borderRadius: 99, fontSize: 10, fontWeight: 700, background: '#FEF2F2', color: '#B91C1C', border: '1px solid #FECACA' }}>⚠ Poor Reliability</span>}
                            {controversyIndex !== null && controversyIndex >= 7 && <span style={{ padding: "2px 7px", borderRadius: 99, fontSize: 10, fontWeight: 700, background: '#FEF2F2', color: '#B91C1C', border: '1px solid #FECACA' }}>🔥 High Risk Build</span>}
                            {auctionEndDate && (() => {
                              const adf = formatAuctionDate(auctionEndDate);
                              if (!adf) return null;
                              return <span style={{ padding: "2px 7px", borderRadius: 99, fontSize: 10, fontWeight: 700, background: adf.isPast ? '#F1F5F9' : '#FFF7ED', color: adf.isPast ? '#94A3B8' : '#EA580C', border: `1px solid ${adf.isPast ? '#CBD5E1' : '#FDBA74'}`, animation: adf.isPast ? 'none' : adf.isUrgent ? 'pulse 1s infinite' : 'pulse 2s infinite' }}>{adf.isPast ? '🏁 Ended' : adf.isUrgent ? '🔥 Ends soon' : '⏰ Ends'} {adf.label}</span>;
                            })()}
                            {Array.isArray(v.documents) && v.documents.length > 0 && <span style={{ padding: "2px 7px", borderRadius: 99, fontSize: 10, fontWeight: 700, background: '#EFF6FF', color: '#1D4ED8', border: '1px solid #BFDBFE' }}>📎 {v.documents.length} doc{v.documents.length > 1 ? 's' : ''}</span>}
                            {v.photo_intel?.condition === 'flag' && <span style={{ padding: "2px 7px", borderRadius: 99, fontSize: 10, fontWeight: 700, background: '#FEF2F2', color: '#B91C1C', border: '1px solid #FECACA' }}>📸 Condition Flag</span>}
                            {v.photo_intel?.condition === 'clean' && <span style={{ padding: "2px 7px", borderRadius: 99, fontSize: 10, fontWeight: 700, background: '#F0FDF4', color: '#15803D', border: '1px solid #86EFAC' }}>📸 Photos: Clean</span>}
                            {!v.score && <span style={{ padding: "2px 7px", borderRadius: 99, fontSize: 10, fontWeight: 700, background: '#F8FAFC', color: TEXT3, border: `1px solid ${BORDER}` }}>🚧 Needs Resubmit</span>}
                            {/* Possibly sold badge */}
                                   {(v as any).scrape_fail_count >= 2 && (
                                     <span style={{ padding: "2px 7px", borderRadius: 99, fontSize: 10, fontWeight: 700, background: '#7F1D1D', color: '#FCA5A5', display: 'flex', alignItems: 'center', gap: 3 }}>
                                       🚨 Possibly Sold
                                     </span>
                                   )}
                                   {v.enrichment_status === 'pending' && <span style={{ padding: "2px 7px", borderRadius: 99, fontSize: 10, fontWeight: 700, background: '#EFF6FF', color: '#4F46E5', border: '1px solid #C7D2FE', animation: 'pulse 1.5s infinite' }}>🔬 AI Enriching...</span>}
                            {v.enrichment_status === 'complete' && !v.photo_intel && <span style={{ padding: "2px 7px", borderRadius: 99, fontSize: 10, fontWeight: 700, background: '#F0FDF4', color: '#15803D', border: '1px solid #86EFAC' }}>✅ AI Verified</span>}
                            {v.recalls?.length > 0 && <span style={{ padding: "2px 7px", borderRadius: 99, fontSize: 10, fontWeight: 700, background: '#FEF2F2', color: '#B91C1C', border: '1px solid #FECACA' }}>⚠ {v.recalls.length} NHTSA Recall{v.recalls.length > 1 ? 's' : ''}</span>}
                            {v.vin && <span style={{ padding: "2px 7px", borderRadius: 99, fontSize: 10, fontWeight: 600, background: '#F8FAFC', color: TEXT2, border: `1px solid ${BORDER}` }}>VIN ✓</span>}
                          </div>
                        </div>


                        <div style={{ flexShrink: 0, textAlign: "right" }}>
                          {editingPriceId === v.id ? (
                            <span onClick={e => e.stopPropagation()} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                              <span style={{ fontSize: 16, fontWeight: 900, color: TEXT2 }}>$</span>
                              <input autoFocus type="number" placeholder="e.g. 72000" value={priceInput}
                                onChange={e => setPriceInput(e.target.value)}
                                onKeyDown={e => { if (e.key === 'Enter') savePrice(v.id); if (e.key === 'Escape') { setEditingPriceId(null); setPriceInput(''); }}}
                                onBlur={() => savePrice(v.id)}
                                style={{ width: 90, padding: '3px 6px', borderRadius: 6, border: `1px solid #6366F1`, fontSize: 16, fontWeight: 900, outline: 'none', textAlign: 'right' }}
                              />
                            </span>
                          ) : (
                            <div
                              onClick={e => { e.stopPropagation(); setEditingPriceId(v.id); setPriceInput(v.price ? String(v.price) : ''); }}
                              style={{ fontSize: 20, fontWeight: 900, color: TEXT1, cursor: 'pointer', position: 'relative' }}
                              title="Click to edit price"
                            >
                              {v.price ? fmt$(v.price) : <span style={{ fontSize: 13, color: '#F59E0B', fontWeight: 700, fontStyle: "italic" }}>+ Add price</span>}
                              <span style={{ position: 'absolute', top: -2, right: -14, fontSize: 10, opacity: 0.3 }}>✏️</span>
                            </div>
                          )}
                          {/* Market Value Signal — the #1 buy signal, shown immediately */}
                          {v.market_mid && v.price && (() => {
                            const diff = v.market_mid - v.price; // positive = below market (good)
                            const pct = Math.round(Math.abs(diff) / v.market_mid * 100);
                            if (Math.abs(diff) < 500) return (
                              <div style={{ fontSize: 10, fontWeight: 700, color: '#94A3B8', marginTop: 2 }}>≈ At market</div>
                            );
                            if (diff > 0) return (
                              <div style={{ fontSize: 11, fontWeight: 800, color: '#15803D', marginTop: 2 }}>
                                ↓ {fmt$(diff)} below market
                                <span style={{ fontSize: 9, fontWeight: 600, opacity: 0.7, marginLeft: 4 }}>({pct}%)</span>
                              </div>
                            );
                            return (
                              <div style={{ fontSize: 11, fontWeight: 700, color: '#B45309', marginTop: 2 }}>
                                ↑ {fmt$(Math.abs(diff))} above market
                              </div>
                            );
                          })()}
                          {auctionEndDate && <div style={{ fontSize: 11, fontWeight: 800, color: '#EA580C', marginTop: 4 }}>Ends {auctionEndDate}</div>}
                          {/* Price Velocity — $/day rate + seller motivation signal */}
                          {(() => {
                            const ph: {price:number;date:string}[] = Array.isArray(v.price_history) ? v.price_history : [];
                            const initP = v.initial_price;
                            if (!initP || !v.price) return null;
                            const totalDrop = initP - v.price;
                            const daysSince = ph.length >= 1
                              ? Math.max(1, Math.round((Date.now() - new Date(ph[0].date).getTime()) / 86400000))
                              : null;
                            const recentDrop = ph.length >= 2
                              ? ph[ph.length-2].price - ph[ph.length-1].price
                              : 0;
                            const daysSinceLastDrop = ph.length >= 2
                              ? Math.round((Date.now() - new Date(ph[ph.length-1].date).getTime()) / 86400000)
                              : null;
                            
                            // $/day velocity
                            const velocity = totalDrop > 0 && daysSince ? Math.round(totalDrop / daysSince) : 0;
                            const dropCount = ph.length >= 2 ? ph.filter((_: any, idx: number) => idx > 0 && ph[idx-1].price > ph[idx].price).length : 0;

                            const isHotDrop = recentDrop > 0 && daysSinceLastDrop != null && daysSinceLastDrop <= 7;
                            type VelocitySignal = { icon: string; label: string; color: string; bg: string };
                            const signal: VelocitySignal = isHotDrop
                              ? { icon: '🔥', label: 'HOT DROP', color: '#15803D', bg: '#F0FDF4' }
                              : velocity > 50
                                ? { icon: '📉', label: 'DECLINING', color: '#D97706', bg: '#FFFBEB' }
                                : totalDrop <= 0 && daysSince && daysSince > 21
                                  ? { icon: '🧊', label: 'STALE', color: '#64748B', bg: '#F8FAFC' }
                                  : totalDrop <= 0
                                    ? { icon: '📈', label: 'FIRM', color: '#7C3AED', bg: '#F5F3FF' }
                                    : { icon: '📉', label: 'SOFTENING', color: '#D97706', bg: '#FFFBEB' };

                            if (totalDrop <= 0 && !daysSince) return null;

                            return (
                              <div style={{ marginTop: 4, display: 'flex', flexDirection: 'column', gap: 2, alignItems: 'flex-end' }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                                  <span style={{ fontSize: 9, fontWeight: 800, letterSpacing: '0.06em', color: signal.color, background: signal.bg, padding: '1px 6px', borderRadius: 4 }}>
                                    {signal.icon} {signal.label}
                                  </span>
                                </div>
                                {totalDrop > 0 ? (
                                  <div style={{ fontSize: 10, fontWeight: 700, color: signal.color, lineHeight: 1.3 }}>
                                    ↓ {fmt$(totalDrop)} total · ${velocity}/day
                                    {daysSince != null && <span style={{ color: TEXT3, fontWeight: 600 }}> · {daysSince}d</span>}
                                  </div>
                                ) : daysSince != null ? (
                                  <div style={{ fontSize: 10, fontWeight: 600, color: TEXT3 }}>
                                    {daysSince}d listed, no drops
                                  </div>
                                ) : null}
                                {dropCount > 1 && (
                                  <div style={{ fontSize: 9, color: TEXT3 }}>
                                    {dropCount} price cuts — seller motivated
                                  </div>
                                )}
                              </div>
                            );
                          })()}
                          {/* Price sparkline */}
                          {(() => {
                            const ph: {price:number;date:string}[] = Array.isArray(v.price_history) ? v.price_history : [];
                            if (ph.length < 2) return null;
                            const prices = ph.map(p => p.price);
                            const minP = Math.min(...prices);
                            const maxP = Math.max(...prices);
                            const range = maxP - minP || 1;
                            const W = 80, H = 28, pad = 3;
                            const points = prices.map((p, i) => {
                              const x = pad + (i / (prices.length - 1)) * (W - pad * 2);
                              const y = pad + (1 - (p - minP) / range) * (H - pad * 2);
                              return `${x},${y}`;
                            }).join(' ');
                            const dropped = prices[prices.length - 1] < prices[0];
                            const flat = Math.abs(prices[prices.length - 1] - prices[0]) < 200;
                            const color = flat ? '#94A3B8' : dropped ? '#16A34A' : '#DC2626';
                            // Market mid reference line
                            const mktY = v.market_mid && v.market_mid >= minP && v.market_mid <= maxP
                              ? pad + (1 - (v.market_mid - minP) / range) * (H - pad * 2)
                              : null;
                            return (
                              <svg width={W} height={H} style={{ display: 'block', margin: '4px 0 0 auto' }}>
                                {mktY !== null && (
                                  <line x1={pad} y1={mktY} x2={W - pad} y2={mktY} stroke="#C7D2FE" strokeWidth="1" strokeDasharray="3,2" />
                                )}
                                <polyline
                                  points={points}
                                  fill="none"
                                  stroke={color}
                                  strokeWidth="1.5"
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                />
                                {/* Current price dot */}
                                <circle
                                  cx={pad + (W - pad * 2)}
                                  cy={pad + (1 - (prices[prices.length - 1] - minP) / range) * (H - pad * 2)}
                                  r="2.5"
                                  fill={color}
                                />
                              </svg>
                            );
                          })()}
                          <div style={{ fontSize: 11, fontWeight: 700, color: TEXT3, marginTop: 6 }}>{isExpanded ? "HIDE ▲" : "EXPAND ▼"}</div>
                        </div>
                        {/* Rank badge */}
                        <div style={{ flexShrink: 0, width: 22, height: 22, borderRadius: '50%', background: rank === 1 ? '#4F46E5' : rank === 2 ? '#6366F1' : rank <= 5 ? '#E2E8F0' : '#F1F5F9', color: rank <= 2 ? '#fff' : TEXT2, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 9, fontWeight: 900 }}>#{rank}</div>

                        {/* Status toggle: Focus ↔ Watching */}
                        <button
                          onClick={e => { e.stopPropagation(); setVehicleStatus(v.id, vStatus === 'focus' ? 'watching' : 'focus'); }}
                          title={vStatus === 'focus' ? 'Move to Watching' : 'Move to Focus'}
                          style={{ flexShrink: 0, padding: '3px 8px', borderRadius: 99, border: `1px solid ${vStatus === 'focus' ? '#818CF8' : '#CBD5E1'}`, background: vStatus === 'focus' ? '#EEF2FF' : 'transparent', color: vStatus === 'focus' ? '#4F46E5' : '#9CA3AF', fontSize: 10, fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap', lineHeight: 1.5 }}
                        >{vStatus === 'focus' ? '🎯 Focus' : '👁 Watching'}</button>
                        {/* × Delete */}
                        <button
                          onClick={e => { e.stopPropagation(); handleSoftDelete(v.id, v.make, v.model); }}
                          title="Remove from watchlist permanently"
                          style={{ flexShrink: 0, background: 'none', border: 'none', cursor: 'pointer', color: '#CBD5E1', fontSize: 18, lineHeight: 1, padding: '0 2px', opacity: 0.4, transition: 'opacity 0.15s, color 0.15s' }}
                          onMouseEnter={e => { (e.target as HTMLElement).style.opacity = '1'; (e.target as HTMLElement).style.color = '#EF4444'; }}
                          onMouseLeave={e => { (e.target as HTMLElement).style.opacity = '0.4'; (e.target as HTMLElement).style.color = '#CBD5E1'; }}
                        >×</button>

                      </div>

                      {/* EXPANDED REPORT CARD (WrenchScore UI Wrapper) */}
                      {isExpanded && v.score ? (
                        <div style={{ padding: "0 16px 16px", borderTop: `1px solid ${BORDER}`, background: v.tier === 'gem' ? '#0F172A' : "#FFFFFF", display: "flex", flexDirection: "column" }}>
                           {/* Replica of the beautiful Report Card Header */}
                           <div style={{ padding: "24px 0", borderBottom: `1px solid ${v.tier==='gem' ? '#1E293B' : BORDER}` }}>
                             
                             <div style={{ display: "flex", gap: 20, alignItems: "flex-start" }}>
                               {v.score && (
                                 <div style={{ flexShrink: 0, textAlign: 'center' }}>
                                   <WrenchScoreGauge score={liveScore(v)} size={110} />
                                   <div style={{ fontSize: 9, fontWeight: 700, color: v.tier==='gem' ? '#475569' : TEXT3, marginTop: 4, letterSpacing: "0.08em" }}>WRENCHSCORE</div>
                                 </div>
                               )}
                               
                               <div style={{ flex: 1 }}>
                                 <div style={{ display: "inline-flex", alignItems: "center", padding: "4px 12px", borderRadius: 99, background: v.tier==='gem' ? '#064E3B' : v.tier==='watch'? '#FFFBEB' : '#FEF2F2', marginBottom: 8 }}>
                                   <span style={{ fontWeight: 800, fontSize: 13, color: v.tier==='gem' ? '#34D399' : v.tier==='watch'? '#B45309' : '#B91C1C' }}>
                                     {v.tier==='gem' ? "💎 Gem" : v.tier==='watch' ? "👁 Watch" : "❌ Pass"}
                                   </span>
                                 </div>
                                 <div style={{ fontSize: 13, fontWeight: 600, color: v.tier==='gem' ? '#E2E8F0' : TEXT2, marginBottom: 8 }}>
                                    {v.tier === 'gem' ? "Exceptional all-in value. Buy it." : v.tier === 'watch' ? "Solid option with specific risks. Negotiate hard." : "Do not buy."}
                                 </div>
                                 
                                 <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 16 }}>
                                   {v.year && v.year > 2017 ? <span style={{ padding: "3px 8px", borderRadius: 99, fontSize: 10, fontWeight: 700, background: '#F0FDF4', color: '#15803D', border: '1px solid #86EFAC' }}>⭐ Excellent reliability</span> : null}
                                   {(!v.location || !v.location.match(/ohio|michigan|new york|ny|pa|pennsylvania|illinois|indiana|minnesota|wisconsin|connecticut|new jersey|mass/i)) && <span style={{ padding: "3px 8px", borderRadius: 99, fontSize: 10, fontWeight: 700, background: '#F0FDF4', color: '#15803D', border: '1px solid #86EFAC' }}>🌵 Rust-free</span>}
                                   <span style={{ padding: "3px 8px", borderRadius: 99, fontSize: 10, fontWeight: 700, background: '#EFF6FF', color: '#1D4ED8', border: '1px solid #BFDBFE' }}>📋 AI Verified</span>
                                 </div>

                                 <div style={{ display: "flex", gap: 24, flexWrap: "wrap", marginTop: 8 }}>
                                   {v.price && (
                                     <div>
                                       <div style={{ fontSize: 9, fontWeight: 700, color: v.tier==='gem' ? '#64748B' : TEXT3, letterSpacing: "0.1em" }}>ASKING</div>
                                       <div style={{ fontSize: 16, fontWeight: 800, color: v.tier==='gem' ? '#F8FAFC' : TEXT1 }}>{fmt$(v.price)}</div>
                                       {v.lowest_price && v.price < v.lowest_price && <div style={{ fontSize: 10, color: '#22C55E', fontWeight: 700, marginTop: 2 }}>Dropped {fmt$(v.lowest_price - v.price)}</div>}
                                     </div>
                                   )}
                                   {v.gem_price_target && (
                                     <div>
                                       <div style={{ fontSize: 9, fontWeight: 700, color: v.tier==='gem' ? '#64748B' : TEXT3, letterSpacing: "0.1em" }}>MARKET FAIR</div>
                                       <div style={{ fontSize: 16, fontWeight: 800, color: v.tier==='gem' ? '#94A3B8' : TEXT2 }}>{fmt$(v.gem_price_target)}</div>
                                     </div>
                                   )}
                                   {tco?.year1Low && (
                                     <div>
                                       <div style={{ fontSize: 9, fontWeight: 700, color: v.tier==='gem' ? '#64748B' : TEXT3, letterSpacing: "0.1em" }}>YEAR 1 TCO</div>
                                       <div style={{ fontSize: 16, fontWeight: 800, color: '#EF4444' }}>{fmt$(tco.year1Low)}–{fmt$(tco.year1High)}</div>
                                       {tco.year3Low && <div style={{ fontSize: 10, color: v.tier==='gem' ? '#475569' : TEXT3, marginTop: 2 }}>3yr: {fmt$(tco.year3Low)}–{fmt$(tco.year3High)}</div>}
                                     </div>
                                   )}
                                   {auctionEndDate && (
                                     <div>
                                       <div style={{ fontSize: 9, fontWeight: 700, color: v.tier==='gem' ? '#64748B' : TEXT3, letterSpacing: "0.1em" }}>AUCTION ENDS</div>
                                       {(() => {
                                          const adf = formatAuctionDate(auctionEndDate);
                                          if (!adf) return <div style={{ fontSize: 14, fontWeight: 800, color: '#EA580C' }}>{auctionEndDate}</div>;
                                          return <div style={{ fontSize: 14, fontWeight: 800, color: adf.isPast ? '#94A3B8' : '#EA580C' }}>{adf.isPast ? '🏁 Ended' : adf.isUrgent ? '🔥 ' : '⏰ '}{adf.label}</div>;
                                        })()}
                                     </div>
                                   )}
                                   {/* Shipping Complexity */}
                                   {shippingTier && (
                                     <div>
                                       <div style={{ fontSize: 9, fontWeight: 700, color: v.tier==='gem' ? '#64748B' : TEXT3, letterSpacing: "0.1em" }}>TRANSIT EFFORT</div>
                                       <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 2 }}>
                                         {[1,2,3,4,5].map(n => (
                                           <div key={n} style={{ width: 8, height: 8, borderRadius: '50%', background: n <= shippingTier.level ? (shippingTier.level <= 2 ? '#22C55E' : shippingTier.level <= 3 ? '#F59E0B' : '#EF4444') : (v.tier==='gem' ? '#334155' : '#E2E8F0') }} />
                                         ))}
                                       </div>
                                       <div style={{ fontSize: 10, fontWeight: 700, color: shippingTier.level <= 2 ? '#16A34A' : shippingTier.level <= 3 ? '#B45309' : '#B91C1C', marginTop: 2 }}>{shippingTier.label}</div>
                                     </div>
                                   )}
                                 </div>
                               </div>
                             </div>
                           </div>

                           <div style={{ padding: "20px 0 0", display: "flex", flexDirection: "column", gap: 16 }}>
                             {/* Narrative */}
                             <div style={{ fontSize: 13, color: v.tier==='gem' ? '#CBD5E1' : TEXT2, fontStyle: "italic", lineHeight: 1.55, borderLeft: `3px solid ${ACCENT}`, paddingLeft: 10 }}>
                               {aiData?.vehicleNarrative || `This ${v.year} ${v.make} ${v.model} with ${v.mileage ? v.mileage.toLocaleString() : 'unknown'} miles has been evaluated by our AI pipeline.`}
                             </div>


                              {/* ── VULNERABILITY SCAN ──────────────────────────────── */}
                              {redFlags.length > 0 && (
                                <div>
                                  <div style={{ fontSize: 10, fontWeight: 800, color: v.tier==='gem' ? '#94A3B8' : TEXT3, letterSpacing: "0.08em", marginBottom: 8 }}>VULNERABILITY SCAN</div>
                                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                                    {redFlags.map((w: any, i: number) => {
                                      const txt = (w.text || '').toLowerCase();
                                      const isImminent = /imminent|overdue|near.?term|critical|now/i.test(txt);
                                      const isApproaching = /approach|within|next.?\d|soon/i.test(txt);
                                      const bg = isImminent ? '#FEF2F2' : isApproaching ? '#FFFBEB' : '#EFF6FF';
                                      const border = isImminent ? '#FECACA' : isApproaching ? '#FDE68A' : '#BFDBFE';
                                      const color = isImminent ? '#B91C1C' : isApproaching ? '#92400E' : '#1D4ED8';
                                      const dot = isImminent ? '\u{1F534}' : isApproaching ? '\u{1F7E1}' : '\u{1F535}';
                                      const label = w.text.split('\u2013')[0].split('\u2014')[0].split(' - ')[0].split(' ').slice(0,5).join(' ');
                                      return (
                                        <span key={i} title={w.text + (w.estimatedCost ? ` (~${fmt$(w.estimatedCost)})` : '')} style={{ padding: "4px 10px", borderRadius: 99, fontSize: 11, fontWeight: 700, background: bg, color, border: `1px solid ${border}`, cursor: 'default' }}>
                                          {dot} {label}{w.estimatedCost ? ` \u00b7 ${fmt$(w.estimatedCost)}` : ''}
                                        </span>
                                      );
                                    })}
                                  </div>
                                </div>
                              )}

                              {/* ── SELLER INTEL PANEL ───────────────────────────────── */}
                              {(v.seller_name || v.seller_type || v.listing_url) && (() => {
                                const isDark = v.tier === 'gem';
                                const sType = v.seller_type as 'dealer'|'private'|'auction'|null;
                                const sName = (v.seller_name || '').toLowerCase();
                                const url = (v.listing_url || '').toLowerCase();
                                // Classify inline — no import needed
                                let profile = 'unknown'; let emoji = '\u2753'; let profileLabel = 'SELLER';
                                let approach = 'Establish seller type before engaging.';
                                let motivation = 'Unknown'; let motivColor = '#6B7280';
                                const NATIONAL = /carvana|echopark|carmax|hertz|vroom|drivetime/;
                                const AUCTION_P = /copart|iaai|bringatrailer|carsandbids|manheim|dickensheet|auction/;
                                if (NATIONAL.test(url + ' ' + sName)) { profile='national_lot'; emoji='\u{1F3ED}'; profileLabel='HIGH-VOLUME NATIONAL LOT'; motivation='Likely Flexible'; motivColor='#D97706'; approach='Counter with comps from market median. Ask for OTD price upfront — doc fees are where they pad margin.'; }
                                else if (AUCTION_P.test(url + ' ' + sName) || sType==='auction') { profile='auction'; emoji='\u{1F528}'; profileLabel='AUCTION UNIT'; motivation='Price is Market'; motivColor='#7C3AED'; approach='No negotiation after the hammer. Calculate max bid: fair value minus transport ($500-1,500) minus recon estimate.'; }
                                else if (sType==='private') { profile='private_party'; emoji='\u{1F464}'; profileLabel='PRIVATE PARTY'; motivation= (v.days_on_market||0) > 28 ? 'Growing Motivation' : 'Emotionally Anchored'; motivColor= (v.days_on_market||0) > 28 ? '#D97706' : '#DC2626'; approach='Ask why they\'re selling before any numbers. Their answer tells you everything about timeline and flexibility.'; }
                                else if (sType==='dealer' || sName.length > 0) {
                                  const makeWords = ['toyota','honda','ford','bmw','mercedes','audi','lexus','chevy','chevrolet','nissan','hyundai','kia','subaru','mazda','jeep','dodge','ram','vw','volkswagen','infiniti','acura','cadillac','lincoln','volvo','porsche'];
                                  const isFranchise = makeWords.some(m => sName.includes(m)) || /\bof\b|automotive|motors?/.test(sName);
                                  if (isFranchise) { profile='franchise_dealer'; emoji='\u{1F3EA}'; profileLabel='FRANCHISE DEALER'; motivation='Holding Firm'; motivColor='#DC2626'; approach='End of month = real urgency. Lead with a comp-based counter, not a percentage off asking price.'; }
                                  else { profile='independent_dealer'; emoji='\u{1F511}'; profileLabel='INDEPENDENT DEALER'; motivation='Unknown — probe first'; motivColor='#6B7280'; approach='Ask about their cost basis. As-is risk is highest here — a PPI is worth the cost.'; }
                                }
                                if (profile === 'unknown' && !v.seller_name) return null;
                                const ph: {price:number;date:string}[] = Array.isArray(v.price_history) ? v.price_history : [];
                                const totalDrop = (v.initial_price && v.price) ? v.initial_price - v.price : 0;
                                const dropCount = ph.filter((e: any, i: number) => i > 0 && e.price < ph[i-1].price).length;
                                const daysSince = ph.length >= 1
                                  ? Math.round((Date.now() - new Date(ph[0].date).getTime()) / 86400000)
                                  : v.days_on_market || null;
                                return (
                                  <div style={{ borderRadius: 12, border: `1px solid ${isDark ? '#1E293B' : '#E2E8F0'}`, background: isDark ? '#0F172A' : '#F8FAFC', overflow: 'hidden', marginBottom: 4 }}>
                                    <div style={{ padding: '10px 14px', background: isDark ? '#1E293B' : '#F1F5F9', display: 'flex', alignItems: 'center', gap: 10, borderBottom: `1px solid ${isDark ? '#334155' : '#E2E8F0'}` }}>
                                      <span style={{ fontSize: 15 }}>{emoji}</span>
                                      <div style={{ flex: 1 }}>
                                        <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: '0.08em', color: isDark ? '#64748B' : TEXT3 }}>SELLER INTEL</div>
                                        <div style={{ fontSize: 12, fontWeight: 800, color: isDark ? '#F1F5F9' : TEXT1 }}>{profileLabel}</div>
                                      </div>
                                      <div style={{ fontSize: 10, fontWeight: 700, color: motivColor, background: `${motivColor}18`, padding: '2px 8px', borderRadius: 99, border: `1px solid ${motivColor}30` }}>
                                        {motivation}
                                      </div>
                                    </div>
                                    <div style={{ padding: '10px 14px', display: 'flex', flexDirection: 'column', gap: 8 }}>
                                      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                                        {v.seller_name && (
                                          <div>
                                            <div style={{ fontSize: 9, fontWeight: 700, color: isDark ? '#475569' : TEXT3, letterSpacing: '0.08em' }}>SELLER</div>
                                            <div style={{ fontSize: 12, fontWeight: 600, color: isDark ? '#CBD5E1' : TEXT1 }}>{v.seller_name}</div>
                                          </div>
                                        )}
                                        {daysSince != null && (
                                          <div>
                                            <div style={{ fontSize: 9, fontWeight: 700, color: isDark ? '#475569' : TEXT3, letterSpacing: '0.08em' }}>ON MARKET</div>
                                            <div style={{ fontSize: 12, fontWeight: 600, color: isDark ? '#CBD5E1' : TEXT1 }}>{daysSince}d{dropCount > 0 ? ` \u00b7 ${dropCount} drop${dropCount > 1 ? 's' : ''}` : ''}</div>
                                          </div>
                                        )}
                                        {totalDrop > 0 && v.initial_price && (
                                          <div>
                                            <div style={{ fontSize: 9, fontWeight: 700, color: isDark ? '#475569' : TEXT3, letterSpacing: '0.08em' }}>PRICE MOVED</div>
                                            <div style={{ fontSize: 12, fontWeight: 700, color: '#15803D' }}>\u2193 {fmt$(totalDrop)} from {fmt$(v.initial_price)}</div>
                                          </div>
                                        )}
                                      </div>
                                    </div>
                                  </div>
                                );
                              })()}


                              {/* ── SHOOT YOUR SHOT ────────────────────────────────── */}
                             {v.gem_price_target && v.price && (() => {
                               const gap = v.price - v.gem_price_target;
                               const offerPrice = v.gem_price_target;
                               const hasCarfax = v.documents?.some((d: any) => d.doc_type === 'carfax' || d.type === 'carfax');
                               const hasPpi = v.documents?.some((d: any) => d.doc_type === 'ppi' || d.type === 'ppi');
                               const zone: 'gem' | 'close' | 'active' | 'wait' =
                                 (v.score && v.score >= 72) ? 'gem'
                                 : gap <= 0 ? 'gem'
                                 : gap <= 1500 ? 'close'
                                 : gap <= 5000 ? 'active'
                                 : 'wait';
                               const configs: Record<string,{bg:string;border:string;header:string;label:string;sub:string}> = {
                                 gem:    { bg: 'linear-gradient(135deg,#DCFCE7 0%,#BBF7D0 100%)', border: '#86EFAC', header: '#15803D', label: '💎 THIS IS A GEM', sub: '#166534' },
                                 close:  { bg: 'linear-gradient(135deg,#ECFDF5 0%,#D1FAE5 100%)', border: '#6EE7B7', header: '#047857', label: '🟢 WITHIN STRIKING DISTANCE', sub: '#065F46' },
                                 active: { bg: 'linear-gradient(135deg,#FFFBEB 0%,#FEF3C7 100%)', border: '#FDE68A', header: '#B45309', label: '🎯 ACTIVE OFFER ZONE', sub: '#78350F' },
                                 wait:   { bg: 'linear-gradient(135deg,#F8FAFC 0%,#F1F5F9 100%)', border: '#E2E8F0', header: '#475569', label: '⏳ WATCH & WAIT', sub: '#64748B' },
                               };
                               const zc = configs[zone];
                               const rawAiStr = v.description?.split('__WRENCH_AUDIT_JSON__')?.[1];
                               let watchouts: any[] = [];
                               if (rawAiStr) { try { const d = JSON.parse(rawAiStr); watchouts = d?.modelInsights?.watchouts || d?.watchouts || []; } catch {} }
                               const topRisk = watchouts[0]?.text || null;
                               const sType = v.seller_type === 'private' ? 'private party' : v.seller_name || (v.seller_type === 'dealer' ? 'dealer' : 'seller');
                               const ph: {price:number;date:string}[] = Array.isArray(v.price_history) ? v.price_history : [];
                               const priceDrop = ph.length >= 2 && v.initial_price && v.initial_price > v.price ? v.initial_price - v.price : 0;
                               const scriptParts = [
                                 `I want to make an offer on this ${v.year} ${v.make} ${v.model}${v.trim ? ' ' + v.trim : ''}.`,
                                 `Listed at $${v.price.toLocaleString()}. My target offer is $${offerPrice.toLocaleString()}${gap > 0 ? ' — a gap of $' + gap.toLocaleString() : ' — already at target'}.`,
                                 v.market_mid ? `Market median is $${v.market_mid.toLocaleString()}.` : '',
                                 `Seller: ${sType}.`,
                                 !hasCarfax ? 'No CARFAX — use as a lever.' : 'CARFAX on file.',
                                 !hasPpi ? 'No PPI yet.' : 'PPI on file.',
                                 topRisk ? `Key model risk: ${topRisk}` : '',
                                 priceDrop > 0 ? `Already dropped $${priceDrop.toLocaleString()} from $${v.initial_price!.toLocaleString()}.` : '',
                                 `Write a ready-to-send offer at $${offerPrice.toLocaleString()} — specific, confident, justified. Copy-paste ready.`,
                               ].filter(Boolean).join(' ');
                               return (
                                 <div style={{ marginBottom: 12, background: zc.bg, borderRadius: 12, border: `1px solid ${zc.border}`, overflow: 'hidden' }}>
                                   <div style={{ padding: '10px 14px', background: 'rgba(0,0,0,0.03)', borderBottom: `1px solid ${zc.border}`, display: 'flex', alignItems: 'center', gap: 8 }}>
                                     <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: '0.08em', color: zc.header }}>{zc.label}</span>
                                     {gap > 0 && <span style={{ marginLeft: 'auto', fontSize: 11, color: zc.header, fontWeight: 700, opacity: 0.8 }}>${gap.toLocaleString()} from gem</span>}
                                   </div>
                                   <div style={{ padding: '12px 14px' }}>
                                     {navigatorLoading[v.id] && !navigatorChat[v.id]?.length ? (
                                       <div style={{ fontSize: 12, color: zc.header, fontStyle: 'italic', marginBottom: 12 }}>Generating your deal playbook…</div>
                                     ) : navigatorChat[v.id]?.[0]?.content ? (
                                       <div style={{ fontSize: 13, lineHeight: 1.75, color: zc.sub, whiteSpace: 'pre-wrap', marginBottom: 12 }}>
                                         {expertTake}
                                       </div>
                                     ) : null}
                                     {zone !== 'wait' && (
                                       <div style={{ display: 'flex', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
                                         <div style={{ flex: 1, minWidth: 90, background: 'rgba(255,255,255,0.7)', borderRadius: 8, padding: '8px 12px', border: `1px solid ${zc.border}` }}>
                                           <div style={{ fontSize: 9, fontWeight: 800, color: zc.header, letterSpacing: '0.08em', marginBottom: 2 }}>LISTED AT</div>
                                           <div style={{ fontSize: 17, fontWeight: 900, color: zc.sub }}>${v.price.toLocaleString()}</div>
                                         </div>
                                         <div style={{ display: 'flex', alignItems: 'center', color: zc.header, fontWeight: 800, fontSize: 16 }}>→</div>
                                         <div style={{ flex: 1, minWidth: 90, background: zone === 'gem' ? 'rgba(21,128,61,0.1)' : 'rgba(255,255,255,0.9)', borderRadius: 8, padding: '8px 12px', border: `2px solid ${zone === 'gem' ? '#22C55E' : '#4F46E5'}` }}>
                                           <div style={{ fontSize: 9, fontWeight: 800, color: zone === 'gem' ? '#15803D' : '#4338CA', letterSpacing: '0.08em', marginBottom: 2 }}>{zone === 'gem' ? 'OFFER NOW' : 'YOUR OFFER'}</div>
                                           <div style={{ fontSize: 17, fontWeight: 900, color: zone === 'gem' ? '#15803D' : '#3730A3' }}>${offerPrice.toLocaleString()}</div>
                                         </div>
                                         {v.market_mid && (
                                           <div style={{ flex: 1, minWidth: 90, background: 'rgba(255,255,255,0.5)', borderRadius: 8, padding: '8px 12px', border: `1px solid ${zc.border}`, opacity: 0.8 }}>
                                             <div style={{ fontSize: 9, fontWeight: 800, color: zc.header, letterSpacing: '0.08em', marginBottom: 2 }}>MARKET MID</div>
                                             <div style={{ fontSize: 14, fontWeight: 700, color: zc.sub }}>${v.market_mid.toLocaleString()}</div>
                                           </div>
                                         )}
                                       </div>
                                     )}
                                     <div style={{ fontSize: 12, color: zc.sub, marginBottom: 12, lineHeight: 1.5 }}>
                                       {zone === 'gem' && `Scores as a gem. Open at $${v.price ? Math.round(v.price * 0.93).toLocaleString() : offerPrice.toLocaleString()} — don’t lose it over $1k.`}
                                       {zone === 'close' && `$${gap.toLocaleString()} is a rounding error in a car deal. Make this offer today.`}
                                       {zone === 'active' && `$${gap.toLocaleString()} gap is closeable. Use market data, missing docs, and model risks as your justification.`}
                                       {zone === 'wait' && `$${gap.toLocaleString()} gap. Watch for another drop — ${priceDrop > 0 ? 'velocity is on your side' : "price hasn’t moved yet"}.`}
                                     </div>
                                     {zone !== 'wait' && (
                                       <button
                                         onClick={() => { setNavigatorOpenId(v.id); sendNavigatorMessage(v.id, scriptParts.filter(Boolean).join(' ')); }}
                                         disabled={!!navigatorLoading[v.id]}
                                         style={{
                                           width: '100%', padding: '11px 16px', borderRadius: 10, marginBottom: 10,
                                           background: navigatorLoading[v.id] ? '#E2E8F0' : (zone === 'gem' || zone === 'close') ? 'linear-gradient(135deg,#16A34A,#15803D)' : 'linear-gradient(135deg,#4F46E5,#4338CA)',
                                           color: navigatorLoading[v.id] ? '#94A3B8' : '#fff', border: 'none', fontSize: 13, fontWeight: 800,
                                           cursor: navigatorLoading[v.id] ? 'not-allowed' : 'pointer',
                                           display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                                           boxShadow: navigatorLoading[v.id] ? 'none' : '0 2px 12px rgba(79,70,229,0.25)',
                                         }}
                                       >
                                         {navigatorLoading[v.id] ? '⏳ Writing your script…' : zone === 'gem' ? '💎 Generate Closing Script' : '✉️ Generate My Offer Script'}
                                       </button>
                                     )}
                                     {(zone === 'active' || zone === 'close') && (!hasCarfax || !hasPpi) && (
                                       <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                                         {!hasCarfax && (
                                           <label style={{ flex: 1, minWidth: 130, display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', background: '#fff', borderRadius: 8, border: '1px dashed #F59E0B', cursor: 'pointer' }}>
                                             <span style={{ fontSize: 14 }}>⬆️</span>
                                             <div><div style={{ fontSize: 11, fontWeight: 700, color: '#92400E' }}>Upload CARFAX</div><div style={{ fontSize: 10, color: '#B45309' }}>Boosts leverage</div></div>
                                             <input type="file" style={{ display: 'none' }} accept=".pdf,.png,.jpg,.jpeg" onChange={(e) => { if (e.target.files?.[0]) handleFile(v.id, 'carfax', e.target.files[0]) }} />
                                           </label>
                                         )}
                                         {!hasPpi && (
                                           <label style={{ flex: 1, minWidth: 130, display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', background: '#fff', borderRadius: 8, border: '1px dashed #F59E0B', cursor: 'pointer' }}>
                                             <span style={{ fontSize: 14 }}>⬆️</span>
                                             <div><div style={{ fontSize: 11, fontWeight: 700, color: '#92400E' }}>Upload PPI</div><div style={{ fontSize: 10, color: '#B45309' }}>Validates risk</div></div>
                                             <input type="file" style={{ display: 'none' }} accept=".pdf,.png,.jpg,.jpeg" onChange={(e) => { if (e.target.files?.[0]) handleFile(v.id, 'ppi', e.target.files[0]) }} />
                                           </label>
                                         )}
                                       </div>
                                     )}
                                   </div>
                                 </div>
                               );
                             })()}

                            {/* Full Analysis Breakdowns */}
                             <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 12, marginTop: 4 }}>
                               {/* AI Insight Panel — replaces Expert Take, driven by Navigator's first message */}
                               <div style={{ borderRadius: 12, border: `1px solid ${v.tier==='gem' ? '#334155' : '#C7D2FE'}`, overflow: 'hidden', background: v.tier==='gem' ? '#0F1E35' : '#F5F3FF' }}>
                                 {/* Header — click to collapse */}
                                  <div onClick={() => setInsightCollapsed(prev => ({...prev, [v.id]: !prev[v.id]}))} style={{ padding: '10px 14px', background: v.tier==='gem' ? '#1E293B' : '#EDE9FE', display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', userSelect: 'none' }}>
                                    <span style={{ fontSize: 14 }}>🤖</span>
                                    <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: '0.08em', color: v.tier==='gem' ? '#A78BFA' : '#5B21B6' }}>AI DEAL INSIGHT</span>
                                    {navigatorLoading[v.id] && (
                                      <span style={{ marginLeft: 4, display: 'inline-block', animation: 'spin 1s linear infinite', fontSize: 12 }}>⟳</span>
                                    )}
                                    <span style={{ marginLeft: 'auto', fontSize: 11, color: v.tier==='gem' ? '#64748B' : '#A78BFA', opacity: 0.7 }}>{insightCollapsed[v.id] ? '▼ expand' : '▲ collapse'}</span>
                                  </div>
                                  {!insightCollapsed[v.id] && <div style={{ padding: '12px 14px' }}>
                                     {false && (
                                       <div style={{ fontSize: 12, color: v.tier==='gem' ? '#94A3B8' : '#6D28D9', fontStyle: 'italic' }}>Analyzing deal…</div>
                                     )}
                                     {expertTake && (
                                       <div style={{ fontSize: 13, lineHeight: 1.7, color: v.tier==='gem' ? '#CBD5E1' : '#3B0764', whiteSpace: 'pre-wrap' }}>
                                         {expertTake}
                                       </div>
                                     )}
                                     {!(carfaxDataCache[v.id] || (v.carfax_data && Object.keys(v.carfax_data).length > 0)) && (
                                       <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', background: v.tier==='gem'?'#1E293B':'#FFFBEB', borderRadius: 8, border: `1px dashed ${v.tier==='gem'?'#475569':'#F59E0B'}` }}>
                                         <span style={{ fontSize: 13 }}>📎</span>
                                         <div style={{ flex: 1 }}>
                                           <div style={{ fontSize: 11, fontWeight: 700, color: v.tier==='gem'?'#FCD34D':'#92400E' }}>No CarFax on file</div>
                                           <div style={{ fontSize: 10, color: v.tier==='gem'?'#94A3B8':'#B45309' }}>Upload to sharpen the AI analysis & offer math</div>
                                         </div>
                                         <label style={{ cursor: 'pointer', padding: '5px 10px', background: '#F59E0B', color: '#fff', borderRadius: 6, fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap' }}>
                                           ⬆ Upload CarFax
                                           <input type="file" style={{ display: 'none' }} accept=".pdf" onChange={(e) => { if (e.target.files?.[0]) handleCarfaxUpload(v.id, e.target.files[0]) }} />
                                         </label>
                                       </div>
                                     )}
                                     {!expertTake && (
                                       <button
                                         onClick={() => { setViewTab('advisor'); setAdvisorInput(`Tell me about the ${v.year} ${v.make} ${v.model}`); }}
                                         style={{ fontSize: 12, color: v.tier==='gem' ? '#818CF8' : '#7C3AED', background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontWeight: 600 }}
                                       >
                                         💬 Ask the Advisor about this one
                                       </button>
                                     )}
                                   </div>}
                                </div>
                               {/* Photo Collage — renders listing photos from photo_intel */}
                               {v.photo_intel?.photoUrls?.length > 0 && (
                                 <div style={{ borderRadius: 12, overflow: 'hidden', border: `1px solid ${v.tier==='gem'?'#334155':BORDER}` }}>
                                   <div style={{ padding: '10px 12px 8px', fontSize: 10, fontWeight: 800, letterSpacing: '0.08em', color: v.tier==='gem'?'#94A3B8':TEXT3, background: v.tier==='gem'?'#1E293B':'#F8FAFC', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                                     <span>📸 LISTING PHOTOS ({v.photo_intel.photoUrls.length})</span>
                                     {v.photo_intel.grade && (
                                       <span style={{ padding: '2px 8px', borderRadius: 99, fontSize: 10, fontWeight: 900, background: ['A','B+'].includes(v.photo_intel.grade)?'#F0FDF4':['B','C+'].includes(v.photo_intel.grade)?'#EFF6FF':'#FEF2F2', color: ['A','B+'].includes(v.photo_intel.grade)?'#15803D':['B','C+'].includes(v.photo_intel.grade)?'#1D4ED8':'#B91C1C', border: `1px solid ${['A','B+'].includes(v.photo_intel.grade)?'#86EFAC':['B','C+'].includes(v.photo_intel.grade)?'#BFDBFE':'#FECACA'}` }}>Grade: {v.photo_intel.grade}</span>
                                     )}
                                   </div>
                                   <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 2, background: '#000' }}>
                                     {v.photo_intel.photoUrls.slice(0, 6).map((url: string, pi: number) => (
                                       <div key={pi} style={{ position: 'relative', paddingTop: '66%', overflow: 'hidden', background: '#1E293B' }}>
                                         <img src={url} alt={`${v.year} ${v.make} ${v.model} photo ${pi+1}`}
                                           loading="lazy"
                                           style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }}
                                           onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }}
                                         />
                                       </div>
                                     ))}
                                   </div>
                                   <div style={{ padding: '10px 12px', background: v.tier==='gem'?'#1E293B':'#F8FAFC', display: 'flex', flexDirection: 'column', gap: 4 }}>
                                     {v.photo_intel.exterior && <div style={{ fontSize: 11, color: v.tier==='gem'?'#CBD5E1':TEXT2 }}><strong>Exterior:</strong> {v.photo_intel.exterior}</div>}
                                     {v.photo_intel.interior && <div style={{ fontSize: 11, color: v.tier==='gem'?'#CBD5E1':TEXT2 }}><strong>Interior:</strong> {v.photo_intel.interior}</div>}
                                     {v.photo_intel.redFlags?.length > 0 && (
                                       <div style={{ marginTop: 4, display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                                         {v.photo_intel.redFlags.map((f: string, fi: number) => (
                                           <span key={fi} style={{ fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 99, background: '#FEF2F2', color: '#B91C1C', border: '1px solid #FECACA' }}>⚠ {f}</span>
                                         ))}
                                       </div>
                                     )}
                                     {v.photo_intel.positives?.length > 0 && (
                                       <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                                         {v.photo_intel.positives.slice(0, 3).map((p: string, pi: number) => (
                                           <span key={pi} style={{ fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 99, background: '#F0FDF4', color: '#15803D', border: '1px solid #86EFAC' }}>✓ {p}</span>
                                         ))}
                                       </div>
                                     )}
                                   </div>
                                 </div>
                               )}

                               {(redFlags.length > 0 || repairs.length > 0) && (
                                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                                 {redFlags.length > 0 && (
                                   <div style={{ padding: 16, background: v.tier==='gem' ? '#1E293B' : "#FEF2F2", borderRadius: 12, border: `1px solid ${v.tier==='gem' ? '#334155' : '#FECACA'}` }}>
                                     <div style={{ fontSize: 10, fontWeight: 800, color: v.tier==='gem' ? '#F87171' : "#EF4444", letterSpacing: "0.08em", marginBottom: 12 }}>⚠ CRITICAL WATCHOUTS</div>
                                     <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                                       {redFlags.map((w: any, i: number) => (
                                          <div key={i} style={{ fontSize: 12, color: v.tier==='gem' ? '#F1F5F9' : "#991B1B", lineHeight: 1.4 }}>
                                            • {w.text} {w.estimatedCost ? `(~${fmt$(w.estimatedCost)})` : ''}
                                          </div>
                                        ))}
                                      </div>
                                    </div>
                                  )}
                                  
                                  {repairs.length > 0 && (
                                    <div style={{ padding: 16, background: v.tier==='gem' ? '#1E293B' : "#F8FAFC", borderRadius: 12, border: `1px solid ${v.tier==='gem' ? '#334155' : '#E2E8F0'}` }}>
                                      <div style={{ fontSize: 10, fontWeight: 800, color: v.tier==='gem' ? '#94A3B8' : TEXT3, letterSpacing: "0.08em", marginBottom: 12 }}>💸 MAINTENANCE EXPOSURE</div>
                                      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                                        {repairs.map((r: any, i: number) => (
                                          <div key={i} style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: v.tier==='gem' ? '#F1F5F9' : TEXT1 }}>
                                            <span>{r.name}</span>
                                            <span style={{ fontWeight: 700 }}>{fmt$(r.costLow || 0)}–{fmt$(r.costHigh || 0)}</span>
                                          </div>
                                        ))}
                                      </div>
                                    </div>
                                  )}
                                 </div>
                               )}
                             </div>

                             {/* ── CarFax Panel ──────────────────────────────────────────── */}
                             {(() => {
                               const cf = carfaxDataCache[v.id] || (v.carfax_data && Object.keys(v.carfax_data).length > 0 ? v.carfax_data : null);
                               const isUploadingCF = carfaxUploading[v.id];
                               return (
                                 <div style={{ marginTop: 12, borderRadius: 10, border: '1px solid #E2E8F0', overflow: 'hidden' }}>
                                   <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', background: cf ? '#F0FDF4' : '#FFFBEB', borderBottom: cf ? '1px solid #BBF7D0' : '1px solid #FDE68A' }}>
                                     <span style={{ fontSize: 14 }}>{cf ? '✅' : '📎'}</span>
                                     <span style={{ fontSize: 11, fontWeight: 800, color: cf ? '#15803D' : '#92400E' }}>
                                       {cf ? 'CARFAX ON FILE' : 'NO CARFAX — upload to sharpen AI analysis'}
                                     </span>
                                     <label style={{ marginLeft: 'auto', cursor: isUploadingCF ? 'not-allowed' : 'pointer', padding: '4px 10px', background: cf ? '#15803D' : '#F59E0B', color: '#fff', borderRadius: 6, fontSize: 10, fontWeight: 700, opacity: isUploadingCF ? 0.6 : 1 }}>
                                       {isUploadingCF ? '⟳ Uploading…' : cf ? '↻ Re-upload' : '⬆ Upload PDF'}
                                       <input type="file" accept=".pdf" style={{ display: 'none' }} disabled={isUploadingCF}
                                         onChange={(e) => { if (e.target.files?.[0]) handleCarfaxUpload(v.id, e.target.files[0]); }} />
                                     </label>
                                   </div>
                                   {cf && (
                                     <div style={{ padding: '10px 12px', background: '#F8FAFC', display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
                                       {[
                                         { label: 'Owners', val: cf.owner_count != null ? `${cf.owner_count}` : '—', ok: cf.owner_count === 1 },
                                         { label: 'Accidents', val: cf.total_accidents != null ? `${cf.total_accidents}` : '—', ok: cf.total_accidents === 0 },
                                         { label: 'Clean Title', val: cf.clean_title === true ? 'Yes' : cf.clean_title === false ? 'No' : '—', ok: cf.clean_title === true },
                                         { label: 'Frame Damage', val: cf.frame_damage ? 'Yes' : 'No', ok: !cf.frame_damage },
                                         { label: 'Flood', val: cf.flood_damage ? 'Yes' : 'No', ok: !cf.flood_damage },
                                         { label: 'Service Records', val: cf.service_records != null ? `${cf.service_records}` : '—', ok: (cf.service_records ?? 0) > 3 },
                                       ].map(({ label, val, ok }) => (
                                         <div key={label} style={{ background: 'white', borderRadius: 6, padding: '6px 8px', border: `1px solid ${ok ? '#BBF7D0' : '#FEE2E2'}` }}>
                                           <div style={{ fontSize: 9, fontWeight: 700, color: '#94A3B8', textTransform: 'uppercase' }}>{label}</div>
                                           <div style={{ fontSize: 13, fontWeight: 800, color: ok ? '#15803D' : '#DC2626' }}>{val}</div>
                                         </div>
                                       ))}
                                       {cf.state_history?.length > 0 && (
                                         <div style={{ gridColumn: '1/-1', background: 'white', borderRadius: 6, padding: '6px 8px', border: '1px solid #E2E8F0' }}>
                                           <div style={{ fontSize: 9, fontWeight: 700, color: '#94A3B8', textTransform: 'uppercase', marginBottom: 3 }}>State History</div>
                                           <div style={{ fontSize: 12, color: '#0F172A' }}>{cf.state_history.join(' → ')}</div>
                                         </div>
                                       )}
                                       {cf.summary && (
                                         <div style={{ gridColumn: '1/-1', background: '#F0FDF4', borderRadius: 6, padding: '8px 10px', border: '1px solid #BBF7D0', fontSize: 12, lineHeight: 1.6, color: '#15803D' }}>
                                           {cf.summary}
                                         </div>
                                       )}
                                     </div>
                                   )}
                                 </div>
                               );
                             })()}

                             {/* ── Offer Tracker ─────────────────────────────────────────── */}
                             {(() => {
                               const log: any[] = offerLogs[v.id] ?? [];
                               const OUTCOME_COLORS: Record<string,string> = {
                                 pending: '#F59E0B', accepted: '#15803D', rejected: '#EF4444', countered: '#6366F1',
                               };
                               return (
                                 <div style={{ marginTop: 10, borderRadius: 10, border: '1px solid #E2E8F0', overflow: 'hidden' }}>
                                   <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', background: '#F8FAFC', borderBottom: '1px solid #E2E8F0' }}>
                                     <span style={{ fontSize: 13 }}>💰</span>
                                     <span style={{ fontSize: 11, fontWeight: 800, color: '#1E293B' }}>OFFER TRACKER</span>
                                     {log.length > 0 && <span style={{ fontSize: 10, background: '#EEF2FF', color: '#4F46E5', padding: '1px 7px', borderRadius: 99, fontWeight: 700 }}>{log.length} offer{log.length>1?'s':''}</span>}
                                     <button
                                       onClick={() => setShowOfferForm(prev => ({ ...prev, [v.id]: !prev[v.id] }))}
                                       style={{ marginLeft: 'auto', padding: '4px 10px', background: '#4F46E5', color: '#fff', borderRadius: 6, fontSize: 10, fontWeight: 700, border: 'none', cursor: 'pointer' }}>
                                       {showOfferForm[v.id] ? 'Cancel' : '+ Log Offer'}
                                     </button>
                                   </div>
                                   {showOfferForm[v.id] && (
                                     <div style={{ padding: '10px 12px', background: '#F8FAFC', borderBottom: '1px solid #E2E8F0', display: 'flex', flexDirection: 'column', gap: 8 }}>
                                       <div style={{ display: 'flex', gap: 8 }}>
                                         <input type="number" placeholder="Offer amount ($)" value={offerAmt[v.id] || ''}
                                           onChange={e => setOfferAmt(prev => ({ ...prev, [v.id]: e.target.value }))}
                                           style={{ flex: 1, padding: '6px 10px', borderRadius: 6, border: '1px solid #CBD5E1', fontSize: 13, fontWeight: 700 }} />
                                         <select value={offerOutcome[v.id] || 'pending'}
                                           onChange={e => setOfferOutcome(prev => ({ ...prev, [v.id]: e.target.value }))}
                                           style={{ padding: '6px 8px', borderRadius: 6, border: '1px solid #CBD5E1', fontSize: 12 }}>
                                           <option value="pending">⏳ Pending</option>
                                           <option value="countered">↔ Countered</option>
                                           <option value="accepted">✅ Accepted</option>
                                           <option value="rejected">❌ Rejected</option>
                                         </select>
                                       </div>
                                       <input placeholder="Note (e.g. dealer said lowest is $79k)" value={offerNote[v.id] || ''}
                                         onChange={e => setOfferNote(prev => ({ ...prev, [v.id]: e.target.value }))}
                                         style={{ padding: '6px 10px', borderRadius: 6, border: '1px solid #CBD5E1', fontSize: 12 }} />
                                       <button onClick={() => submitOffer(v.id)} disabled={offerSubmitting[v.id] || !offerAmt[v.id]}
                                         style={{ padding: '8px 14px', background: '#4F46E5', color: '#fff', border: 'none', borderRadius: 6, fontSize: 12, fontWeight: 700, cursor: 'pointer', opacity: offerSubmitting[v.id] ? 0.6 : 1 }}>
                                         {offerSubmitting[v.id] ? 'Saving…' : 'Save Offer'}
                                       </button>
                                     </div>
                                   )}
                                   {log.length > 0 ? (
                                     <div style={{ padding: '8px 12px', display: 'flex', flexDirection: 'column', gap: 6 }}>
                                       {log.map((entry: any) => (
                                         <div key={entry.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 10px', background: 'white', borderRadius: 8, border: '1px solid #E2E8F0' }}>
                                           <div style={{ flex: 1 }}>
                                             <div style={{ fontSize: 14, fontWeight: 800 }}>${Number(entry.amount).toLocaleString()}</div>
                                             {entry.note && <div style={{ fontSize: 11, color: '#64748B', marginTop: 2 }}>{entry.note}</div>}
                                             <div style={{ fontSize: 10, color: '#94A3B8' }}>{new Date(entry.date).toLocaleDateString()}</div>
                                           </div>
                                           <select value={entry.outcome} onChange={e => updateOfferOutcome(v.id, entry.id, e.target.value)}
                                             style={{ padding: '3px 6px', borderRadius: 6, border: `1px solid ${OUTCOME_COLORS[entry.outcome]||'#E2E8F0'}`, fontSize: 11, fontWeight: 700, color: OUTCOME_COLORS[entry.outcome]||'#0F172A', background: 'white' }}>
                                             <option value="pending">⏳ Pending</option>
                                             <option value="countered">↔ Countered</option>
                                             <option value="accepted">✅ Accepted</option>
                                             <option value="rejected">❌ Rejected</option>
                                           </select>
                                         </div>
                                       ))}
                                     </div>
                                   ) : (
                                     <div style={{ padding: '10px 12px', fontSize: 12, color: '#94A3B8', fontStyle: 'italic' }}>No offers logged yet. Track every offer — it builds your leverage history.</div>
                                   )}
                                   <div style={{ padding: '8px 12px', borderTop: '1px solid #E2E8F0', background: '#FAFAFF' }}>
                                     <div style={{ fontSize: 10, fontWeight: 700, color: '#94A3B8', marginBottom: 6 }}>EDIT DETAILS</div>
                                     <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                                       <div>
                                         <div style={{ fontSize: 9, fontWeight: 700, color: '#94A3B8', marginBottom: 2 }}>LOCATION</div>
                                         <input value={v.location || ''} onChange={e => { const val = e.target.value; setVehicles((prev: any[]) => prev.map((x: any) => x.id === v.id ? { ...x, location: val } : x)); }} onBlur={e => saveVehicleField(v.id, 'location', e.target.value)} placeholder="City, ST" onClick={e => e.stopPropagation()} style={{ width: '100%', padding: '4px 6px', borderRadius: 6, border: '1px solid #CBD5E1', fontSize: 12, boxSizing: 'border-box' as const }} />
                                       </div>
                                       <div>
                                         <div style={{ fontSize: 9, fontWeight: 700, color: '#94A3B8', marginBottom: 2 }}>OWNERS</div>
                                         <select value={v.owner_count || ''} onChange={e => { const val = parseInt(e.target.value); if (val) saveVehicleField(v.id, 'owner_count', val); }} onClick={e => e.stopPropagation()} style={{ width: '100%', padding: '4px 6px', borderRadius: 6, border: '1px solid #CBD5E1', fontSize: 12, background: '#fff' }}>
                                           <option value="">Unknown</option>
                                           <option value="1">1 Owner</option>
                                           <option value="2">2 Owners</option>
                                           <option value="3">3+ Owners</option>
                                         </select>
                                       </div>
                                       <div>
                                         <div style={{ fontSize: 9, fontWeight: 700, color: '#94A3B8', marginBottom: 2 }}>ACCIDENTS</div>
                                         <select value={v.has_accident === true ? 'yes' : v.has_accident === false ? 'no' : ''} onChange={e => { const val = e.target.value === 'yes' ? true : e.target.value === 'no' ? false : null; saveVehicleField(v.id, 'has_accident', val); }} onClick={e => e.stopPropagation()} style={{ width: '100%', padding: '4px 6px', borderRadius: 6, border: '1px solid #CBD5E1', fontSize: 12, background: '#fff' }}>
                                           <option value="">Unknown</option>
                                           <option value="no">Clean</option>
                                           <option value="yes">Accident</option>
                                         </select>
                                       </div>
                                       <div style={{ display: 'flex', alignItems: 'flex-end' }}>
                                         <button onClick={e => { e.stopPropagation(); setViewTab('advisor' as any); setAdvisorInput('Tell me about the ' + v.year + ' ' + v.make + ' ' + v.model); }} style={{ width: '100%', padding: '5px 8px', borderRadius: 6, border: '1px solid #C7D2FE', background: '#EEF2FF', color: '#4F46E5', fontSize: 11, fontWeight: 700, cursor: 'pointer' }}>💬 Ask Advisor</button>
                                       </div>
                                     </div>
                                   </div>
                                   <div style={{ padding: '8px 12px', borderTop: '1px solid #E2E8F0', background: '#F8FAFC' }}>
                                     <div style={{ fontSize: 10, fontWeight: 700, color: '#94A3B8', marginBottom: 4 }}>NOTES</div>
                                     <textarea placeholder="Dealer name, inspection findings, call notes…"
                                       value={vehicleNotes[v.id] ?? ''}
                                       onChange={e => setVehicleNotes(prev => ({ ...prev, [v.id]: e.target.value }))}
                                       onBlur={e => saveNotes(v.id, e.target.value)}
                                       rows={2}
                                       style={{ width: '100%', padding: '6px 8px', borderRadius: 6, border: '1px solid #CBD5E1', fontSize: 12, resize: 'vertical', fontFamily: 'inherit', boxSizing: 'border-box' }} />
                                   </div>
                                 </div>
                               );
                             })()}

                            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 12 }}>
                               <button onClick={(e) => handleDelete(v.id, e)} style={{ background: "none", border: "none", fontSize: 11, fontWeight: 700, color: '#EF4444', cursor: "pointer", padding: 0 }}>DELETE</button>
                               <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                                 {v.listing_url && !v.listing_url.startsWith('manual_') && (
                                   <button
                                     onClick={(e) => { e.stopPropagation(); refreshVehicle(v.id, v.listing_url); }}
                                     disabled={refreshingId === v.id}
                                     style={{ background: "none", border: `1px solid ${BORDER}`, borderRadius: 8, fontSize: 11, fontWeight: 700, color: TEXT2, cursor: refreshingId === v.id ? 'not-allowed' : 'pointer', padding: '4px 10px', display: 'flex', alignItems: 'center', gap: 5, opacity: refreshingId === v.id ? 0.6 : 1 }}
                                   >
                                     <span style={{ display: 'inline-block', animation: refreshingId === v.id ? 'spin 1s linear infinite' : 'none' }}>↻</span>
                                     {refreshingId === v.id ? 'Refreshing...' : 'Refresh Score'}
                                   </button>
                                 )}
                                 <a href={v.listing_url} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()} style={{ fontSize: 12, fontWeight: 800, color: ACCENT, textDecoration: "none", display: "flex", alignItems: "center", gap: 6 }}>
                                   VIEW LISTING ↗
                                 </a>
                               </div>
                             </div>
                           </div>
                        </div>
                      ) : isExpanded ? (
                         <div style={{ padding: "32px 16px", background: "#FAFAFA", borderTop: `1px solid ${BORDER}`, textAlign: "center" }}>
                            <div style={{ fontSize: 24, marginBottom: 8 }}>🚧</div>
                            <div style={{ fontSize: 16, fontWeight: 800, color: TEXT1, marginBottom: 4 }}>Vehicle Missing Analytics</div>
                            <div style={{ fontSize: 13, color: TEXT2, maxWidth: 400, margin: "0 auto 16px" }}>This vehicle lacks a finalized WrenchScore, which happens when the model couldn't extract key data like Mileage or Price. Update the stats or remove and track it manually to ensure an accurate grade.</div>
                            
                            <div style={{ display: "flex", justifyContent: "center", gap: 12 }}>
                               <button onClick={(e) => handleDelete(v.id, e)} style={{ padding: "8px 16px", borderRadius: 8, background: "#FEF2F2", color: "#B91C1C", fontSize: 12, fontWeight: 700, border: "none", cursor: "pointer" }}>Delete From Watchlist</button>
                            </div>
                         </div>
                      ) : null}
                    </div>
                  );
                  };


                  return (
                    <>
                      {focusVehicles.length > 0 && (
                        <>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, paddingBottom: 6, borderBottom: '1px solid #E0E7FF' }}>
                            <span style={{ fontSize: 11, fontWeight: 800, color: '#4F46E5', letterSpacing: '0.08em' }}>🎯 FOCUS</span>
                            <span style={{ fontSize: 10, background: '#EEF2FF', color: '#4F46E5', padding: '1px 7px', borderRadius: 99, fontWeight: 700 }}>{focusVehicles.length}</span>
                            <span style={{ fontSize: 10, color: '#9CA3AF' }}>Actively pursuing — click 🎯 to move to Watching</span>
                          </div>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                            {focusVehicles.map((v: any, i: number) => renderCard(v, i))}
                          </div>
                        </>
                      )}
                      {watchVehicles.length > 0 && (
                        <>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, marginTop: focusVehicles.length > 0 ? 20 : 0, paddingBottom: 6, borderBottom: '1px solid #E5E7EB' }}>
                            <span style={{ fontSize: 11, fontWeight: 800, color: '#6B7280', letterSpacing: '0.08em' }}>👁 WATCHING</span>
                            <span style={{ fontSize: 10, background: '#F3F4F6', color: '#6B7280', padding: '1px 7px', borderRadius: 99, fontWeight: 700 }}>{watchVehicles.length}</span>
                            <span style={{ fontSize: 10, color: '#9CA3AF' }}>Monitoring for price changes — click 👁 to promote to Focus</span>
                          </div>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                            {watchVehicles.map((v: any, i: number) => renderCard(v, focusVehicles.length + i))}
                          </div>
                        </>
                      )}
                    </>
                  );
                })()}</>
              )}

            {/* ── INBOX SECTION (integrated into Board) ──────────────── */}
            {viewTab === 'board' && scoutLeads.length > 0 && (
              <div ref={inboxRef} style={{ marginTop: 16 }}>
                {/* -- Scout Control Header -- */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20, padding: '14px 18px', background: '#F8FAFF', borderRadius: 12, border: '1px solid #E0E7FF' }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13, fontWeight: 800, color: '#1E40AF' }}>🔭 2020–2021 Toyota Land Cruiser Scout</div>
                    <div style={{ fontSize: 11, color: '#6B7280', marginTop: 2 }}>
                      {scoutResult
                        ? `Last scan: ${scoutResult.total} on market · $${scoutResult.market_mid.toLocaleString()} median · ${scoutResult.inserted} new · ${scoutResult.refreshed ?? 0} updated`
                        : 'Searches CarGurus, AutoTrader, Cars.com, CarMax, Carvana + more via Marketcheck'}
                    </div>
                  </div>
                  <button
                    onClick={async () => {
                      setScoutRunning(true);
                      setScoutResult(null);
                      try {
                        const res = await fetch('/api/scout/marketcheck-run', { method: 'POST' });
                        const data = await res.json();
                        if (data.inserted !== undefined) {
                           setScoutResult({ inserted: data.inserted, refreshed: data.refreshed, total: data.total_found, market_mid: data.market_mid });
                           await fetchScoutLeads();
                         }
                      } catch {}
                      finally { setScoutRunning(false); }
                    }}
                    disabled={scoutRunning}
                    style={{ padding: '10px 20px', background: scoutRunning ? '#E0E7FF' : '#4F46E5', color: scoutRunning ? '#818CF8' : '#fff', border: 'none', borderRadius: 10, fontSize: 13, fontWeight: 700, cursor: scoutRunning ? 'not-allowed' : 'pointer', whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: 6 }}
                  >
                    {scoutRunning ? (<><span style={{ display: 'inline-block', animation: 'spin 1s linear infinite' }}>⟳</span> Scanning…</>) : '🔍 Run Scout Now'}
                  </button>
                </div>

                {scoutLeads.length === 0 ? (
                  <div style={{ padding: '40px 20px', textAlign: 'center' }}>
                    <div style={{ fontSize: 36, marginBottom: 12 }}>🔭</div>
                    <div style={{ fontSize: 18, fontWeight: 800, marginBottom: 8 }}>No new leads yet</div>
                    <div style={{ fontSize: 13, color: TEXT2, maxWidth: 360, margin: '0 auto', lineHeight: 1.6 }}>
                      Hit <strong>Run Scout Now</strong> to scan all 2020–2021 Land Cruisers on the national market. New leads appear here instantly.
                    </div>
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                    <div style={{ fontSize: 13, color: TEXT2, marginBottom: 4 }}>
                      {scoutLeads.length} lead{scoutLeads.length > 1 ? 's' : ''} — review and accept or pass
                    </div>
                    {scoutLeads.map((lead: any) => {
                      const isGem = lead.shadow_score >= 72;
                      const transitColor = lead.transit_level <= 2 ? '#15803D' : lead.transit_level <= 3 ? '#B45309' : '#94A3B8';
                      const mktDelta = lead.price && lead.market_mid ? lead.market_mid - lead.price : null;
                      const shippingEst = lead.transit_level <= 2 ? 0 : lead.transit_level <= 3 ? 1200 : 2000;
                      const allInPrice = lead.price ? lead.price + shippingEst : null;
                      const photo = lead.raw_intel?.photos?.[0];
                      // carfax_clean_title=false from Marketcheck just means "no CarFax data" — not a title issue
                      const titleIssue = lead.raw_intel?.hasAccident === true;
                      const cleanTitle = lead.raw_intel?.carfax_clean_title === true;
                      const oneOwner = lead.raw_intel?.carfax_1_owner === true;
                      const dealerName = lead.raw_intel?.dealer_name;
                      return (
                        <div key={lead.id} style={{ background: SURFACE, borderRadius: 16, border: `2px solid ${isGem ? '#22C55E' : BORDER}`, overflow: 'hidden', boxShadow: isGem ? '0 0 0 1px #86EFAC' : 'none' }}>
                          <div style={{ display: 'flex' }}>
                            {/* Photo */}
                            {photo ? (
                              <div style={{ flexShrink: 0, width: 130, minHeight: 110, overflow: 'hidden' }}>
                                <img src={photo} alt={lead.title || ''} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
                              </div>
                            ) : (
                              <div style={{ flexShrink: 0, width: 130, minHeight: 110, background: '#F1F5F9', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 32 }}>🚙</div>
                            )}
                            {/* Content */}
                            <div style={{ flex: 1, padding: '14px 16px' }}>
                              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8, marginBottom: 5 }}>
                                <div>
                                  <div style={{ fontSize: 14, fontWeight: 800, lineHeight: 1.2 }}>
                                    {lead.year} {lead.make?.charAt(0).toUpperCase()}{lead.make?.slice(1)} {lead.model?.charAt(0).toUpperCase()}{lead.model?.slice(1)}{lead.trim ? ` — ${lead.trim}` : ''}
                                  </div>
                                  <div style={{ fontSize: 11, color: TEXT2, marginTop: 3, display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                                    {lead.mileage ? <span>{lead.mileage.toLocaleString()} mi</span> : <span style={{ color: '#F59E0B', fontWeight: 600 }}>Mileage N/A</span>}
                                    {lead.location && <span>📍 {lead.location}</span>}
                                    {dealerName && <span style={{ color: TEXT3 }}>{dealerName}</span>}
                                    {lead.source && lead.source !== 'unknown' && (() => {
                                      const sourceStyles: Record<string, { bg: string; color: string; label: string }> = {
                                        'bat': { bg: '#FEF3C7', color: '#92400E', label: 'BaT' },
                                        'carsandbids': { bg: '#DBEAFE', color: '#1E40AF', label: 'Cars & Bids' },
                                        'ih8mud': { bg: '#FEE2E2', color: '#991B1B', label: 'ih8mud' },
                                        'cars.com': { bg: '#E0E7FF', color: '#3730A3', label: 'Cars.com' },
                                        'marketcheck': { bg: '#F1F5F9', color: '#475569', label: 'Dealer' },
                                      };
                                      const s = sourceStyles[lead.source] || { bg: '#F1F5F9', color: '#64748B', label: lead.source };
                                      return <span style={{ padding: '1px 6px', borderRadius: 4, fontSize: 9, fontWeight: 800, background: s.bg, color: s.color, letterSpacing: '0.04em' }}>{s.label}</span>;
                                    })()}
                                  </div>
                                </div>
                                <div style={{ flexShrink: 0, width: 44, height: 44, borderRadius: '50%', background: isGem ? '#DCFCE7' : '#FFF7ED', border: `2px solid ${isGem ? '#22C55E' : '#FDBA74'}`, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
                                  <div style={{ fontSize: 13, fontWeight: 900, color: isGem ? '#15803D' : '#B45309' }}>{lead.shadow_score || '?'}</div>
                                  <div style={{ fontSize: 7, fontWeight: 700, color: '#9CA3AF' }}>SCORE</div>
                                </div>
                              </div>
                              {/* Prices */}
                              <div style={{ display: 'flex', gap: 16, alignItems: 'flex-end', marginBottom: 8, flexWrap: 'wrap' }}>
                                {lead.price && (
                                  <div>
                                    <div style={{ fontSize: 9, fontWeight: 700, color: TEXT3, letterSpacing: '0.07em' }}>ASKING</div>
                                    <div style={{ fontSize: 19, fontWeight: 900 }}>${lead.price.toLocaleString()}</div>
                                  </div>
                                )}
                                {allInPrice && shippingEst > 0 && (
                                  <div>
                                    <div style={{ fontSize: 9, fontWeight: 700, color: TEXT3, letterSpacing: '0.05em' }}>
                                      EST. ALL-IN <span style={{ fontWeight: 500 }}>(+ ~${shippingEst.toLocaleString()} freight)</span>
                                    </div>
                                    <div style={{ fontSize: 15, fontWeight: 800, color: '#475569' }}>${allInPrice.toLocaleString()}</div>
                                  </div>
                                )}
                                {mktDelta !== null && (
                                  <div style={{ marginLeft: 'auto', textAlign: 'right' }}>
                                    <div style={{ fontSize: 9, fontWeight: 700, color: TEXT3, letterSpacing: '0.07em' }}>VS {(lead.raw_intel?.comp_segment || 'MARKET').toUpperCase()}</div>
                                    <div style={{ fontSize: 13, fontWeight: 800, color: mktDelta > 0 ? '#15803D' : '#DC2626' }}>
                                      {mktDelta > 0 ? `↓ $${mktDelta.toLocaleString()} below` : `↑ $${Math.abs(mktDelta).toLocaleString()} above`}
                                    </div>
                                    <div style={{ fontSize: 9, color: TEXT3 }}>
                                      median ${lead.market_mid?.toLocaleString()} · {lead.raw_intel?.comp_count || '?'} comps
                                    </div>
                                  </div>
                                )}
                              </div>
                              {/* Badges */}
                              <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                                {isGem && <span style={{ fontSize: 10, fontWeight: 800, background: '#DCFCE7', color: '#15803D', padding: '2px 7px', borderRadius: 99, border: '1px solid #86EFAC' }}>💎 GEM</span>}
                                {lead.status === 'watching' && <span style={{ fontSize: 10, fontWeight: 800, background: '#EFF6FF', color: '#1D4ED8', padding: '2px 7px', borderRadius: 99, border: '1px solid #BFDBFE' }}>👁 Watching</span>}
                                {cleanTitle && <span style={{ fontSize: 10, fontWeight: 700, background: '#DCFCE7', color: '#15803D', padding: '2px 7px', borderRadius: 99 }}>✅ CarFax Clean Title</span>}
                                {oneOwner && <span style={{ fontSize: 10, fontWeight: 700, background: '#EFF6FF', color: '#1D4ED8', padding: '2px 7px', borderRadius: 99 }}>👤 1-Owner</span>}
                                {titleIssue && (
                                  <span style={{ fontSize: 10, fontWeight: 700, background: '#FEF2F2', color: '#DC2626', padding: '2px 7px', borderRadius: 99 }}
                                    title="CarFax reports an accident on this vehicle. Verify severity and repair quality before purchasing.">
                                    ⚠ Accident Reported
                                  </span>
                                )}
                                {lead.transit_label && (
                                  <span style={{ fontSize: 10, fontWeight: 700, color: transitColor, padding: '2px 7px', borderRadius: 99, border: `1px solid ${transitColor}33`, background: `${transitColor}11` }}>
                                    {lead.transit_level <= 1 ? '🏠' : lead.transit_level <= 2 ? '🚗' : lead.transit_level <= 3 ? '✈️' : '🚢'} {lead.transit_label}
                                  </span>
                                )}
                                {lead.raw_intel?.dom_active && <span style={{ fontSize: 10, color: TEXT2, padding: '2px 7px', borderRadius: 99, border: `1px solid ${BORDER}` }}>{lead.raw_intel.dom_active}d listed</span>}
                                {lead.raw_intel?.exterior_color && <span style={{ fontSize: 10, color: TEXT3, padding: '2px 7px', borderRadius: 99, border: `1px solid ${BORDER}` }}>{lead.raw_intel.exterior_color}</span>}
                              </div>
                            </div>
                          </div>
                          {/* Actions: Pass / Watch / Add to Radar */}
                          <div style={{ display: 'flex', borderTop: `1px solid ${BORDER}` }}>
                            <a href={lead.listing_url} target="_blank" rel="noopener noreferrer"
                              style={{ flex: 1, padding: '9px 10px', background: BG, fontSize: 11, fontWeight: 700, color: TEXT2, textDecoration: 'none', textAlign: 'center', borderRight: `1px solid ${BORDER}` }}>
                              View ↗
                            </a>
                            {/* Pass — dismisses, resurfaces on next run */}
                            <button
                              disabled={!!addingLeadIds[lead.id]}
                              onClick={() => dismissLead(lead.id)}
                              style={{ flex: 1, padding: '9px 10px', background: '#FEF2F2', fontSize: 11, fontWeight: 700, color: '#DC2626', cursor: 'pointer', border: 'none', borderRight: `1px solid ${BORDER}`, opacity: addingLeadIds[lead.id] ? 0.4 : 1 }}
                              title="Dismiss for now — will resurface on next scan if still available">
                              ✕ Pass
                            </button>
                            {/* Watch — keeps in inbox, tracks price changes */}
                            <button
                              disabled={!!addingLeadIds[lead.id] || lead.status === 'watching'}
                              onClick={() => watchLead(lead.id)}
                              style={{ flex: 1, padding: '9px 10px', background: lead.status === 'watching' ? '#EFF6FF' : '#F8FAFC', fontSize: 11, fontWeight: 700, color: lead.status === 'watching' ? '#1D4ED8' : TEXT2, cursor: lead.status === 'watching' ? 'default' : 'pointer', border: 'none', borderRight: `1px solid ${BORDER}`, opacity: addingLeadIds[lead.id] ? 0.4 : 1 }}
                              title="Keep in inbox and monitor for price drops">
                              {lead.status === 'watching' ? '👁 Watching' : '👁 Watch'}
                            </button>
                            {/* Add to Radar — full AI audit */}
                            <button
                              disabled={!!addingLeadIds[lead.id]}
                              onClick={() => addLeadToHunt(lead)}
                              style={{
                                flex: 1.4, padding: '9px 10px', border: 'none', fontSize: 11, fontWeight: 700, cursor: addingLeadIds[lead.id] ? 'default' : 'pointer',
                                background: addingLeadIds[lead.id] === 'done' ? '#DCFCE7' : addingLeadIds[lead.id] === 'error' ? '#FEF2F2' : addingLeadIds[lead.id] === 'adding' ? '#EEF2FF' : '#DCFCE7',
                                color: addingLeadIds[lead.id] === 'done' ? '#15803D' : addingLeadIds[lead.id] === 'error' ? '#DC2626' : addingLeadIds[lead.id] === 'adding' ? '#4F46E5' : '#15803D',
                                transition: 'all 0.2s',
                              }}
                              title="Run full AI audit and add to your Radar">
                              {addingLeadIds[lead.id] === 'adding' && <><span style={{ display: 'inline-block', animation: 'spin 1s linear infinite', marginRight: 4 }}>⟳</span>Analyzing…</>}
                              {addingLeadIds[lead.id] === 'done' && '✓ Added!'}
                              {addingLeadIds[lead.id] === 'error' && '⚠ Retry?'}
                              {!addingLeadIds[lead.id] && '⭐ Add to Radar'}
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
            </div>
            </div>
            )} {/* end viewTab === 'board' */}
            {/* ── ADVISOR TAB ──────────────────────────────────────────────── */}
            {viewTab === 'advisor' && (
              <AdvisorPanel
                sessions={advisorSessions}
                activeSessionId={activeSessionId}
                sessionsLoaded={sessionsLoaded}
                chat={advisorChat}
                loading={advisorLoading}
                input={advisorInput}
                files={advisorFiles}
                onInputChange={setAdvisorInput}
                onFilesChange={setAdvisorFiles}
                onSendMessage={sendAdvisorMessage}
                onCreateSession={createNewSession}
                onSwitchSession={switchSession}
                endRef={advisorEndRef}
              />
            )}


          </div>
        )}
      </div>

      {/* ── Compare floating button ────────────────────────────────────── */}
      {compareIds.size >= 2 && !showCompare && (
        <div style={{
          position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)',
          zIndex: 999, animation: 'fadeInCompare 0.2s ease',
        }}>
          <style>{`@keyframes fadeInCompare { from { opacity: 0; transform: translateX(-50%) translateY(10px); } to { opacity: 1; transform: translateX(-50%) translateY(0); } }`}</style>
          <button
            onClick={() => setShowCompare(true)}
            style={{
              padding: '12px 28px', borderRadius: 99,
              background: 'linear-gradient(135deg, #4F46E5, #7C3AED)',
              color: '#fff', border: 'none', fontSize: 14, fontWeight: 800,
              cursor: 'pointer', boxShadow: '0 8px 32px rgba(79, 70, 229, 0.4)',
              display: 'flex', alignItems: 'center', gap: 8,
              transition: 'transform 0.15s, box-shadow 0.15s',
            }}
            onMouseEnter={e => { (e.currentTarget as HTMLElement).style.transform = 'scale(1.05)'; }}
            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.transform = 'scale(1)'; }}
          >
            ⚔️ Compare {compareIds.size} vehicles
          </button>
        </div>
      )}

      {/* ── Compare Panel ──────────────────────────────────────────────── */}
      {showCompare && compareIds.size >= 2 && (
        <ComparePanel
          vehicles={vehicles.filter(v => compareIds.has(v.id))}
          onClose={() => setShowCompare(false)}
          onAskAdvisor={(msg) => {
            setShowCompare(false);
            setViewTab('advisor');
            sendAdvisorMessage(msg);
          }}
          fmt$={fmt$}
          liveScore={liveScore}
        />
      )}
    </div>
  );
}


// ── ConfidenceRing ─────────────────────────────────────────────────────────────
function ConfidenceRing({ score, confidencePct, tier }: { score: number; confidencePct: number; tier?: string }) {
  const size = 52;
  const strokeW = 4;
  const r = (size - strokeW) / 2;
  const circ = 2 * Math.PI * r;
  const pct = Math.min(score / 100, 1);
  const dash = pct * circ;
  const tierColor = tier === 'gem' ? '#22C55E' : tier === 'pass' ? '#EF4444' : '#F59E0B';
  const confColor = confidencePct >= 85 ? '#22C55E' : confidencePct >= 70 ? '#60A5FA' : confidencePct >= 45 ? '#F59E0B' : '#CBD5E1';
  return (
    <div style={{ position: 'relative', width: size, height: size }}>
      <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }}>
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="#F1F5F9" strokeWidth={strokeW} />
        <circle
          cx={size/2} cy={size/2} r={r} fill="none"
          stroke={tierColor}
          strokeWidth={strokeW}
          strokeDasharray={`${dash} ${circ}`}
          strokeLinecap="round"
          style={{ transition: 'stroke-dasharray 0.6s ease' }}
        />
        <circle
          cx={size/2} cy={size/2} r={r - strokeW - 1} fill="none"
          stroke={confColor}
          strokeWidth={2}
          strokeDasharray={`${(confidencePct/100) * 2 * Math.PI * (r - strokeW - 1)} ${2 * Math.PI * (r - strokeW - 1)}`}
          strokeOpacity={0.4}
          style={{ transition: 'stroke-dasharray 0.6s ease' }}
        />
      </svg>
      <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 900, color: tierColor }}>
        {score}
      </div>
    </div>
  );
}

// ── WrenchScoreGauge ───────────────────────────────────────────────────────────
function WrenchScoreGauge({ score, size = 120 }: { score: number; size?: number }) {
  const strokeW = size * 0.08;
  const r = (size - strokeW) / 2;
  const circ = Math.PI * r; // half circle
  const pct = Math.min(score / 100, 1);
  const dash = pct * circ;
  const color = score >= 78 ? '#22C55E' : score >= 60 ? '#F59E0B' : '#EF4444';
  return (
    <div style={{ position: 'relative', width: size, height: size / 2 + strokeW }}>
      <svg width={size} height={size / 2 + strokeW} viewBox={`0 0 ${size} ${size / 2 + strokeW}`}>
        <path
          d={`M ${strokeW/2} ${size/2} A ${r} ${r} 0 0 1 ${size - strokeW/2} ${size/2}`}
          fill="none" stroke="#F1F5F9" strokeWidth={strokeW} strokeLinecap="round"
        />
        <path
          d={`M ${strokeW/2} ${size/2} A ${r} ${r} 0 0 1 ${size - strokeW/2} ${size/2}`}
          fill="none" stroke={color} strokeWidth={strokeW} strokeLinecap="round"
          strokeDasharray={`${dash} ${circ}`}
          style={{ transition: 'stroke-dasharray 0.8s ease' }}
        />
      </svg>
      <div style={{ position: 'absolute', bottom: 0, left: '50%', transform: 'translateX(-50%)', textAlign: 'center' }}>
        <div style={{ fontSize: size * 0.28, fontWeight: 900, color, lineHeight: 1 }}>{score}</div>
        <div style={{ fontSize: size * 0.09, fontWeight: 700, color: '#94A3B8', letterSpacing: '0.06em' }}>/ 100</div>
      </div>
    </div>
  );
}
