"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Search, Loader2, ArrowRight } from "lucide-react";

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
  const [refreshingId, setRefreshingId] = useState<string | null>(null);
  const [urlWarnings, setUrlWarnings] = useState<string[]>([]);

  // ── Dossier State ──
  const [uploadingDocId, setUploadingDocId] = useState<string | null>(null);
  const [scanningPhotosId, setScanningPhotosId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [scoreDelta, setScoreDelta] = useState<Record<string, number>>({});
  const [navigatorOpenId, setNavigatorOpenId] = useState<string | null>(null);
  const [navigatorChat, setNavigatorChat] = useState<Record<string, { role: string; content: string }[]>>({}); 
  const [navigatorInput, setNavigatorInput] = useState<Record<string, string>>({});
  const [navigatorLoading, setNavigatorLoading] = useState<Record<string, boolean>>({});
  const chatEndRefs = useRef<Record<string, HTMLDivElement | null>>({});
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
  const [viewTab, setViewTab] = useState<'radar' | 'inbox'>('radar');
  // ── Scout Chat ──
  const [showScoutChat, setShowScoutChat] = useState(false);
  // ── Deletion & Financing ──
  const [deletedIds, setDeletedIds] = useState<Record<string, NodeJS.Timeout>>({});
  const [deletedVisually, setDeletedVisually] = useState<Record<string, boolean>>({});
  const [payMethod, setPayMethod] = useState<'cash'|'finance'>('cash');

  const handleDelete = (id: string, make: string, model: string) => {
    setDeletedVisually(prev => ({...prev, [id]: true}));
    const timer = setTimeout(async () => {
      try {
        await fetch(`/api/hunt/${id}`, { method: 'DELETE' });
        setVehicles(prev => prev.filter(v => v.id !== id));
      } catch(e) {}
    }, 5000);
    setDeletedIds(prev => ({...prev, [id]: timer}));
  };

  const undoDelete = (id: string) => {
    clearTimeout(deletedIds[id]);
    setDeletedVisually(prev => { const next = {...prev}; delete next[id]; return next; });
    setDeletedIds(prev => { const next = {...prev}; delete next[id]; return next; });
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

  useEffect(() => {
    fetchVehicles();
    fetchScoutLeads();
    fetchScoutConfigs();
  }, []);

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

  async function fetchVehicles() {
    try {
      const res = await fetch("/api/hunt/tracker");
      const data = await res.json();
      if (!res.ok) {
        if (data.error === "SCHEMA_MISSING") setErrorMsg("Please run watchlist_schema.sql in Supabase first.");
        else setErrorMsg(data.error);
      } else {
        setVehicles(data.vehicles || []);
      }
    } catch (e) {
      setErrorMsg("Failed to connect to API");
    } finally {
      setLoading(false);
    }
  }

  async function fetchScoutLeads() {
    try {
      const res = await fetch('/api/scout/leads?status=new');
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

  async function dismissLead(leadId: string) {
    await fetch('/api/scout/leads', { method: 'PATCH', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ id: leadId, status: 'dismissed' }) });
    setScoutLeads(prev => prev.filter(l => l.id !== leadId));
  }

  async function addLeadToHunt(lead: any) {
    await fetch('/api/scout/leads', { method: 'PATCH', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ id: lead.id, status: 'added' }) });
    setScoutLeads(prev => prev.filter(l => l.id !== lead.id));
    // Add to Hunt via stream
    setBatchUrls(lead.listing_url);
    setShowAddModal(true);
    setActiveTab('urls');
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
      
      // ── URL Guard: reject search result pages before wasting a pipeline slot ──
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
              if (ev.type === "complete" || ev.type === "start") continue;
              if (ev.type === "fatal") { setErrorMsg(ev.message); continue; }
              // Friendly Facebook Marketplace block
              if (ev.type === "facebook_blocked") {
                setFbBlocked(prev => [...prev, { url: ev.url || "", message: ev.message }]);
                setStreamProgress(prev => {
                  const arr = [...prev];
                  arr[ev.index || 0] = { index: ev.index, message: "Facebook Marketplace (blocked)", type: "facebook_blocked", url: ev.url };
                  return arr;
                });
                continue;
              }
              
              // Track the original URL so we can offer retry
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
      setBatchUrls("");
      setStreamDone(true);
      fetchVehicles();
      // Only auto-close if ALL listings succeeded — otherwise stay open to show errors
      setStreamProgress(prev => {
        const hasErrors = prev.some(p => p?.type === 'error' || p?.type === 'warning');
        if (!hasErrors) setShowAddModal(false);
        return prev;
      });
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
        body: JSON.stringify({ message: userMsg, history }),
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
    } catch (e: any) {
      setNavigatorChat(prev => ({ ...prev, [vehicleId]: [...(prev[vehicleId]||[]), { role: "assistant", content: "⚠ Connection error. Please try again." }] }));
    } finally {
      setNavigatorLoading(prev => ({ ...prev, [vehicleId]: false }));
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
        {vehicles.length === 0 ? (
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
                    <button onClick={() => setViewTab('inbox')}
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
                                <button onClick={() => { setViewTab('inbox'); setShowNotifications(false); }}
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

              {/* ── RADAR / INBOX TABS ─────────────────────────────────── */}
              <div style={{ display: 'flex', gap: 4, marginBottom: 16, background: '#F1F5F9', padding: 4, borderRadius: 10, width: 'fit-content' }}>
                <button onClick={() => setViewTab('radar')}
                  style={{ padding: '7px 20px', borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: 'pointer', border: 'none', background: viewTab === 'radar' ? '#fff' : 'transparent', color: viewTab === 'radar' ? TEXT1 : TEXT3, boxShadow: viewTab === 'radar' ? '0 1px 4px rgba(0,0,0,0.08)' : 'none', transition: 'all 0.15s' }}>
                  📡 Radar <span style={{ fontWeight: 600, opacity: 0.6 }}>({vehicles.length})</span>
                </button>
                <button onClick={() => { setViewTab('inbox'); fetchScoutLeads(); }}
                  style={{ padding: '7px 20px', borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: 'pointer', border: 'none', background: viewTab === 'inbox' ? '#fff' : 'transparent', color: viewTab === 'inbox' ? TEXT1 : TEXT3, boxShadow: viewTab === 'inbox' ? '0 1px 4px rgba(0,0,0,0.08)' : 'none', transition: 'all 0.15s', position: 'relative' }}>
                  📥 Inbox
                  {scoutLeads.length > 0 && <span style={{ marginLeft: 6, fontSize: 10, background: '#EA580C', color: '#fff', borderRadius: 99, padding: '1px 6px', fontWeight: 800, animation: 'pulse 2s infinite' }}>{scoutLeads.length}</span>}
                </button>
              </div>

              {/* ── Tag Filter Row (Radar only) ── */}
              {viewTab === 'radar' && vehicles.length > 0 && (
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
            {viewTab === 'radar' && (
            <div>
            {/* Portfolio Grid leaderboard */}
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {loading ? (
                <div style={{ padding: 40, textAlign: "center", color: TEXT3 }}>Loading inventory...</div>
              ) : (
                <>{[...vehicles].sort((a, b) => (b.score || 0) - (a.score || 0))
                  .filter(v => {
                    const TAG_FILTERS: Record<string, (v: any) => boolean> = {
                      no_accident: (v: any) => v.has_accident === false,
                      one_owner: (v: any) => v.owner_count === 1,
                      gem: (v: any) => v.tier === 'gem',
                      clean_photos: (v: any) => ['clean'].includes(v.photo_intel?.condition),
                      auction: (v: any) => { let ai: any = null; try { const s = v.description?.split('__WRENCH_AUDIT_JSON__')?.[1]; if(s) ai = JSON.parse(s); } catch {} return !!(ai?.auctionEndDate); },
                      verified: (v: any) => v.enrichment_status === 'complete',
                    };
                    return !activeTagFilter || (TAG_FILTERS[activeTagFilter]?.(v) ?? true);
                  })
                  .filter(v => !deletedVisually[v.id])
                  .map((v, rankIdx) => {
                   const rank = rankIdx + 1;
                   const isExpanded = expandedId === v.id;

                  
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
                    <div key={v.id} style={{ 
                      display: "flex", flexDirection: "column",
                      background: isExpanded && v.tier === 'gem' ? '#0F172A' : SURFACE, 
                      borderRadius: 16,
                      border: `2px solid ${isExpanded ? (v.tier === 'gem' ? '#334155' : ACCENT) : (v.tier === 'gem' && rank === 1 ? '#4F46E5' : BORDER)}`, 
                      transition: "all 0.2s", overflow: "hidden",
                      boxShadow: isExpanded ? "0 4px 16px rgba(79, 70, 229, 0.1)" : "0 2px 4px rgba(0,0,0,0.02)",
                      transform: isExpanded ? "translateY(-1px)" : "none"
                    }}>
                      
                      {/* HEADER ROW */}
                      <div onClick={() => toggleRow(v.id)} style={{ display: "flex", alignItems: "center", padding: 16, cursor: "pointer", gap: 12 }}>
                        {/* Ranking badge */}
                        <div style={{ flexShrink: 0, width: 28, height: 28, borderRadius: "50%", background: rank === 1 ? '#4F46E5' : rank === 2 ? '#6366F1' : rank <= 5 ? '#E2E8F0' : '#F1F5F9', color: rank <= 2 ? '#fff' : TEXT2, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 900 }}>#{rank}</div>

                        <div style={{ flex: 1.5 }}>
                          <div style={{ fontSize: 16, fontWeight: 800 }}>{v.year} {v.make} {v.model} {v.trim}</div>
                          <div style={{ fontSize: 13, color: TEXT2, marginTop: 4, display: "flex", gap: 12 }}>
                            <span>{v.mileage ? `${v.mileage.toLocaleString()} mi` : "Unknown mi"}</span>
                            {v.location && <><span>•</span><span>{v.location}</span></>}
                            {v.market_mid && <><span>•</span><span style={{ fontWeight: 700 }}>Mkt {fmt$(v.market_mid)}</span></>}
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
                            {v.enrichment_status === 'pending' && <span style={{ padding: "2px 7px", borderRadius: 99, fontSize: 10, fontWeight: 700, background: '#EFF6FF', color: '#4F46E5', border: '1px solid #C7D2FE', animation: 'pulse 1.5s infinite' }}>🔬 AI Enriching...</span>}
                            {v.enrichment_status === 'complete' && !v.photo_intel && <span style={{ padding: "2px 7px", borderRadius: 99, fontSize: 10, fontWeight: 700, background: '#F0FDF4', color: '#15803D', border: '1px solid #86EFAC' }}>✅ AI Verified</span>}
                            {v.recalls?.length > 0 && <span style={{ padding: "2px 7px", borderRadius: 99, fontSize: 10, fontWeight: 700, background: '#FEF2F2', color: '#B91C1C', border: '1px solid #FECACA' }}>⚠ {v.recalls.length} NHTSA Recall{v.recalls.length > 1 ? 's' : ''}</span>}
                            {v.vin && <span style={{ padding: "2px 7px", borderRadius: 99, fontSize: 10, fontWeight: 600, background: '#F8FAFC', color: TEXT2, border: `1px solid ${BORDER}` }}>VIN ✓</span>}
                          </div>
                        </div>

                        {/* Score + confidence ring — with pre-flight hover tooltip */}
                      <div style={{ flex: 1, textAlign: "left", display: "flex", alignItems: "center", gap: 12 }}>
                          {v.score ? (
                            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2, position: 'relative',  cursor: 'default' }}
                              onMouseEnter={e => { const el = (e.currentTarget as HTMLElement).querySelector('.preflight-tip') as HTMLElement|null; if(el) el.style.opacity = '1'; }}
                              onMouseLeave={e => { const el = (e.currentTarget as HTMLElement).querySelector('.preflight-tip') as HTMLElement|null; if(el) el.style.opacity = '0'; }}>
                              <ConfidenceRing score={v.adjusted_score || v.score} confidencePct={v.confidence_pct || 25} tier={v.tier} />
                              <div style={{ fontSize: 9, fontWeight: 700, color: TEXT3, letterSpacing: "0.06em" }}>
                                {v.confidence_pct >= 85 ? '✅ VERIFIED' : v.confidence_pct >= 70 ? '🔵 MEDIUM' : v.confidence_pct >= 45 ? '🟡 LOW' : '⚪ ESTIMATED'}
                              </div>
                              {/* Pre-flight Hover Tooltip */}
                              <div className="preflight-tip" style={{ opacity: 0, transition: 'opacity 0.15s', position: 'absolute', bottom: '110%', left: '50%', transform: 'translateX(-50%)', zIndex: 50, background: '#0F172A', color: '#fff', borderRadius: 10, padding: '10px 14px', width: 200, boxShadow: '0 8px 24px rgba(0,0,0,0.3)', pointerEvents: 'none' }}>
                                <div style={{ fontSize: 10, fontWeight: 800, marginBottom: 6, color: '#94A3B8' }}>SCORE BREAKDOWN</div>
                                {[
                                  { label: 'Mechanical', pts: Math.round((v.score || 0) * 0.30), max: 30, color: '#60A5FA' },
                                  { label: 'History', pts: Math.round((v.score || 0) * 0.25), max: 25, color: '#34D399' },
                                  { label: 'Market Value', pts: Math.round((v.score || 0) * 0.25), max: 25, color: '#F59E0B' },
                                  { label: 'Data Quality', pts: Math.round((v.score || 0) * 0.20), max: 20, color: '#A78BFA' },
                                ].map(row => (
                                  <div key={row.label} style={{ marginBottom: 5 }}>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9, marginBottom: 2 }}>
                                      <span style={{ color: '#CBD5E1' }}>{row.label}</span>
                                      <span style={{ fontWeight: 700, color: row.color }}>{row.pts}/{row.max}</span>
                                    </div>
                                    <div style={{ height: 3, background: '#1E293B', borderRadius: 99 }}>
                                      <div style={{ height: '100%', width: `${Math.round((row.pts / row.max) * 100)}%`, background: row.color, borderRadius: 99 }} />
                                    </div>
                                  </div>
                                ))}
                                <div style={{ borderTop: '1px solid #1E293B', marginTop: 6, paddingTop: 6, fontSize: 9, color: '#94A3B8' }}>Hover expand for full report</div>
                                <div style={{ position: 'absolute', bottom: -5, left: '50%', transform: 'translateX(-50%)', width: 10, height: 10, background: '#0F172A', rotate: '45deg' }} />
                              </div>
                            </div>
                          ) : <div style={{ fontSize: 12, color: TEXT3, fontWeight: 600 }}>Unscored</div>}
                          {v.score && (
                            <div>
                              <div style={{ fontSize: 12, fontWeight: 800, color: TEXT1 }}>{v.tier_label?.toUpperCase() || 'EVALUATED'}</div>
                              {targetString && <div style={{ fontSize: 10, fontWeight: 800, color: ACCENT }}>{targetString}</div>}
                            </div>
                          )}
                        </div>

                        <div style={{ flexShrink: 0, textAlign: "right" }}>
                          <div style={{ fontSize: 20, fontWeight: 900, color: TEXT1 }}>{v.price ? fmt$(v.price) : "—"}</div>
                          {auctionEndDate && <div style={{ fontSize: 11, fontWeight: 800, color: '#EA580C', marginTop: 4 }}>Ends {auctionEndDate}</div>}
                          {v.price && v.lowest_price && v.price < v.lowest_price && <div style={{ fontSize: 12, fontWeight: 800, color: "#16A34A", marginTop: 4 }}>↓ Dropped</div>}
                          <div style={{ fontSize: 11, fontWeight: 700, color: TEXT3, marginTop: 6 }}>{isExpanded ? "HIDE ▲" : "EXPAND ▼"}</div>
                        </div>
                      </div>

                      {/* EXPANDED REPORT CARD (WrenchScore UI Wrapper) */}
                      {isExpanded && v.score ? (
                        <div style={{ padding: "0 16px 16px", borderTop: `1px solid ${BORDER}`, background: v.tier === 'gem' ? '#0F172A' : "#FFFFFF", display: "flex", flexDirection: "column" }}>
                           {/* Replica of the beautiful Report Card Header */}
                           <div style={{ padding: "24px 0", borderBottom: `1px solid ${v.tier==='gem' ? '#1E293B' : BORDER}` }}>
                             
                             <div style={{ display: "flex", gap: 20, alignItems: "flex-start" }}>
                               {v.score && (
                                 <div style={{ flexShrink: 0, textAlign: 'center' }}>
                                   <WrenchScoreGauge score={v.score} size={110} />
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

                             {/* ── VULNERABILITY SCAN — urgency-coded model weak spots ── */}
                             {redFlags.length > 0 && (
                               <div>
                                 <div style={{ fontSize: 10, fontWeight: 800, color: v.tier==='gem' ? '#94A3B8' : TEXT3, letterSpacing: "0.08em", marginBottom: 8 }}>VULNERABILITY SCAN</div>
                                 <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                                   {redFlags.map((w: any, i: number) => {
                                     // Detect urgency from the text: IMMINENT = red, APPROACHING = amber, WATCH = blue
                                     const txt = (w.text || '').toLowerCase();
                                     const isImminent = /imminent|overdue|near.?term|critical|now/i.test(txt);
                                     const isApproaching = /approach|within|next.?\d|soon/i.test(txt);
                                     const bg = isImminent ? '#FEF2F2' : isApproaching ? '#FFFBEB' : '#EFF6FF';
                                     const border = isImminent ? '#FECACA' : isApproaching ? '#FDE68A' : '#BFDBFE';
                                     const color = isImminent ? '#B91C1C' : isApproaching ? '#92400E' : '#1D4ED8';
                                     const dot = isImminent ? '🔴' : isApproaching ? '🟡' : '🔵';
                                     // Short label = first clause before " – " or first 5 words
                                     const label = w.text.split(' – ')[0].split(' — ')[0].split(' - ')[0].split(' ').slice(0,5).join(' ');
                                     return (
                                       <span key={i} title={w.text + (w.estimatedCost ? ` (~${fmt$(w.estimatedCost)})` : '')} style={{ padding: "4px 10px", borderRadius: 99, fontSize: 11, fontWeight: 700, background: bg, color, border: `1px solid ${border}`, cursor: 'default' }}>
                                         {dot} {label}{w.estimatedCost ? ` · ${fmt$(w.estimatedCost)}` : ''}
                                       </span>
                                     );
                                   })}
                                 </div>
                               </div>
                             )}

                             {/* ── PATH TO GEM ─────────────────────────────────────── */}
                            {v.score && v.score < 72 && (
                              <div style={{ marginBottom: 12, background: 'linear-gradient(135deg, #FFFBEB 0%, #FEF3C7 100%)', borderRadius: 12, border: '1px solid #FDE68A', overflow: 'hidden' }}>
                                <div style={{ padding: '10px 14px', background: 'rgba(0,0,0,0.03)', borderBottom: '1px solid #FDE68A', display: 'flex', alignItems: 'center', gap: 8 }}>
                                  <span style={{ fontSize: 13 }}>🎯</span>
                                  <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: '0.08em', color: '#92400E' }}>PATH TO GEM</span>
                                  <span style={{ marginLeft: 'auto', fontSize: 11, color: '#B45309', fontWeight: 700 }}>Score {v.adjusted_score || v.score}/100 → need 72</span>
                                </div>
                                <div style={{ padding: '12px 14px' }}>
                                  {/* Gap items */}
                                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }}>
                                    {!v.documents?.some((d: any) => d.doc_type === 'carfax') && (
                                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
                                        <span style={{ fontSize: 14 }}>🔴</span>
                                        <span style={{ flex: 1, color: '#78350F' }}>No CARFAX on file</span>
                                        <span style={{ fontWeight: 700, color: '#92400E' }}>+8 pts if clean</span>
                                      </div>
                                    )}
                                    {v.market_mid && v.price && v.price > v.market_mid * 0.97 && (
                                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
                                        <span style={{ fontSize: 14 }}>🟡</span>
                                        <span style={{ flex: 1, color: '#78350F' }}>Priced above market median</span>
                                        <span style={{ fontWeight: 700, color: '#92400E' }}>at ${Math.round(v.market_mid * 0.95).toLocaleString()} = gem-priced</span>
                                      </div>
                                    )}
                                    {v.enrichment_status !== 'complete' && (
                                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
                                        <span style={{ fontSize: 14 }}>🔵</span>
                                        <span style={{ flex: 1, color: '#78350F' }}>AI enrichment incomplete</span>
                                        <span style={{ fontWeight: 700, color: '#92400E' }}>+5–10 pts on full scan</span>
                                      </div>
                                    )}
                                    {!v.photo_intel && (
                                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
                                        <span style={{ fontSize: 14 }}>📸</span>
                                        <span style={{ flex: 1, color: '#78350F' }}>No photo analysis</span>
                                        <span style={{ fontWeight: 700, color: '#92400E' }}>condition unknown</span>
                                      </div>
                                    )}
                                  </div>
                                  {/* Negotiation signal */}
                                  <div style={{ background: '#FFF', borderRadius: 8, padding: '10px 12px', border: '1px solid #FDE68A' }}>
                                    <div style={{ fontSize: 10, fontWeight: 800, color: '#B45309', letterSpacing: '0.08em', marginBottom: 4 }}>
                                      {v.market_mid && v.price && (v.price < v.market_mid * 0.95) ? '⚡ MOVE NOW' : '🤝 NEGOTIATE'}
                                    </div>
                                    <div style={{ fontSize: 12, color: '#78350F', lineHeight: 1.5 }}>
                                      {v.market_mid && v.price ? (
                                        v.price < v.market_mid * 0.95
                                          ? `Listed ${Math.round((1 - v.price/v.market_mid)*100)}% below market — priced to move. Don't overthink this.`
                                          : `Open at $${Math.round(v.market_mid * 0.92).toLocaleString()} — cite mileage and any deferred maintenance. Walk away at $${Math.round(v.market_mid * 0.97).toLocaleString()}.`
                                      ) : `Use the AI chat below for a specific negotiation plan.`}
                                    </div>
                                  </div>
                                </div>
                              </div>
                            )}
                            {v.score && v.score >= 72 && (
                              <div style={{ marginBottom: 12, background: 'linear-gradient(135deg, #DCFCE7 0%, #BBF7D0 100%)', borderRadius: 12, border: '1px solid #86EFAC', padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 10 }}>
                                <span style={{ fontSize: 20 }}>💎</span>
                                <div>
                                  <div style={{ fontSize: 11, fontWeight: 800, color: '#15803D', letterSpacing: '0.08em' }}>THIS IS A GEM — ACT</div>
                                  <div style={{ fontSize: 12, color: '#166534', marginTop: 2 }}>
                                    {v.market_mid && v.price
                                      ? `Open at $${Math.round(v.price * 0.93).toLocaleString()}. Don't let it kill the deal — this is correctly priced and won't last long.`
                                      : `Negotiate from strength. This unit checks all boxes — don't lose it over $1,000.`}
                                  </div>
                                </div>
                              </div>
                            )}

                            {/* Full Analysis Breakdowns */}
                             <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 12, marginTop: 4 }}>
                               {/* AI Insight Panel — replaces Expert Take, driven by Navigator's first message */}
                               <div style={{ borderRadius: 12, border: `1px solid ${v.tier==='gem' ? '#334155' : '#C7D2FE'}`, overflow: 'hidden', background: v.tier==='gem' ? '#0F1E35' : '#F5F3FF' }}>
                                 {/* Header — click to collapse */}
                                 <div onClick={() => setInsightCollapsed(prev => ({...prev, [v.id]: !prev[v.id]}))} style={{ padding: '10px 14px', background: v.tier==='gem' ? '#1E293B' : '#EDE9FE', display: 'flex', alignItems: 'center', gap: 8, borderBottom: insightCollapsed[v.id] ? 'none' : `1px solid ${v.tier==='gem' ? '#334155' : '#C4B5FD'}`, cursor: 'pointer', userSelect: 'none' }}>
                                   <span style={{ fontSize: 14 }}>🤖</span>
                                   <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: '0.08em', color: v.tier==='gem' ? '#A78BFA' : '#5B21B6' }}>AI DEAL INSIGHT</span>
                                   {navigatorLoading[v.id] && (
                                     <span style={{ marginLeft: 4, display: 'inline-block', animation: 'spin 1s linear infinite', fontSize: 12 }}>⟳</span>
                                   )}
                                   <span style={{ marginLeft: 'auto', fontSize: 11, color: v.tier==='gem' ? '#64748B' : '#A78BFA', opacity: 0.7 }}>{insightCollapsed[v.id] ? '▼' : '▲'}</span>
                                 </div>
                                 {/* Content: first AI message or loading state — hidden when collapsed */}
                                 {!insightCollapsed[v.id] && <div style={{ padding: '12px 14px' }}>
                                   {navigatorLoading[v.id] && !(navigatorChat[v.id]?.length) ? (
                                     <div style={{ fontSize: 13, color: v.tier==='gem' ? '#94A3B8' : '#6D28D9', fontStyle: 'italic', opacity: 0.8 }}>
                                       Generating your personalized deal analysis…
                                     </div>
                                   ) : navigatorChat[v.id]?.[0] ? (
                                     <div style={{ fontSize: 13, lineHeight: 1.7, color: v.tier==='gem' ? '#E2E8F0' : '#1E1048', whiteSpace: 'pre-wrap', fontWeight: 400 }}>
                                       {navigatorChat[v.id][0].content}
                                     </div>
                                   ) : (
                                     <div style={{ fontSize: 13, color: v.tier==='gem' ? '#64748B' : '#7C3AED', fontStyle: 'italic' }}>
                                       Expand to load AI analysis…
                                     </div>
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

                            {/* ── DOSSIER — unified drag-and-drop ─────────────────────────── */}
                            <div
                              style={{ marginTop: 16, borderRadius: 12, border: `2px dashed ${dragOverId===v.id ? '#4F46E5' : (v.tier==='gem' ? '#334155' : BORDER)}`, background: dragOverId===v.id ? (v.tier==='gem'?'rgba(79,70,229,0.1)':'rgba(79,70,229,0.04)') : (v.tier==='gem' ? '#1E293B' : '#F8FAFC'), transition: 'all 0.15s ease', position: 'relative', overflow: 'hidden' }}
                              onDragOver={e => { e.preventDefault(); e.stopPropagation(); setDragOverId(v.id); }}
                              onDragLeave={e => { e.stopPropagation(); setDragOverId(null); }}
                              onDrop={e => handleDrop(v.id, e)}
                            >
                              {/* Drop overlay */}
                              {dragOverId === v.id && (
                                <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', background: 'rgba(79,70,229,0.08)', zIndex: 10, pointerEvents: 'none', gap: 4 }}>
                                  <div style={{ fontSize: 28 }}>📄</div>
                                  <div style={{ fontSize: 13, fontWeight: 800, color: '#4F46E5' }}>Drop to analyze</div>
                                  <div style={{ fontSize: 11, color: '#6366F1' }}>CARFAX, PPI, inspection report</div>
                                </div>
                              )}

                              <div style={{ padding: 16 }}>
                                {/* Header row */}
                                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                    <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: '0.08em', color: v.tier==='gem' ? '#94A3B8' : TEXT3 }}>📎 DOSSIER</div>
                                    {scoreDelta[v.id] && (
                                      <div style={{ fontSize: 11, fontWeight: 900, color: scoreDelta[v.id] > 0 ? '#16A34A' : '#DC2626', background: scoreDelta[v.id] > 0 ? '#F0FDF4' : '#FEF2F2', padding: '1px 6px', borderRadius: 99, animation: 'pulse 0.5s ease' }}>
                                        {scoreDelta[v.id] > 0 ? `+${scoreDelta[v.id]}` : scoreDelta[v.id]} pts
                                      </div>
                                    )}
                                  </div>
                                  <div style={{ fontSize: 10, fontWeight: 700, color: (v.confidence_pct||25) >= 85 ? '#16A34A' : (v.confidence_pct||25) >= 70 ? '#2563EB' : '#B45309' }}>
                                    {v.confidence_pct || 25}% confidence
                                  </div>
                                </div>

                                {/* Confidence bar */}
                                <div style={{ height: 3, background: v.tier==='gem' ? '#334155' : '#E2E8F0', borderRadius: 99, marginBottom: 12, overflow: 'hidden' }}>
                                  <div style={{ height: '100%', width: `${v.confidence_pct || 25}%`, background: (v.confidence_pct||25) >= 85 ? '#16A34A' : (v.confidence_pct||25) >= 70 ? '#3B82F6' : (v.confidence_pct||25) >= 45 ? '#F59E0B' : '#94A3B8', borderRadius: 99, transition: 'width 0.6s ease' }} />
                                </div>

                                {/* Attached docs */}
                                {(v.documents||[]).length > 0 && (
                                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 10 }}>
                                    {(v.documents||[]).map((doc: any, di: number) => (
                                      <div key={di} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', background: '#F0FDF4', borderRadius: 8, border: '1px solid #86EFAC' }}>
                                        <span style={{ fontSize: 13 }}>✅</span>
                                        <div style={{ flex: 1 }}>
                                          <div style={{ fontSize: 11, fontWeight: 800, color: '#15803D' }}>{doc.type === 'ppi' ? 'PPI / Inspection' : 'CARFAX / AutoCheck'} attached</div>
                                          <div style={{ fontSize: 10, color: '#166534' }}>
                                            {(doc.maintenanceDebt ?? 0) > 0 ? `Debt: $${(doc.maintenanceDebt||0).toLocaleString()}` : 'No issues flagged'}
                                            {(doc.maintenanceEvents ?? 0) > 0 && ` · ${doc.maintenanceEvents} events`}
                                          </div>
                                         </div>
                                         <button onClick={e => { e.stopPropagation(); removeDocument(v.id, doc.type); }}
                                          style={{ width: 20, height: 20, borderRadius: '50%', background: '#FEE2E2', border: 'none', color: '#B91C1C', fontSize: 12, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, fontWeight: 700 }}>×</button>
                                       </div>
                                    ))}
                                  </div>
                                )}

                                {/* Upload actions row */}
                                {uploadingDocId === v.id ? (
                                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', background: v.tier==='gem'?'#0F172A':'#EFF6FF', borderRadius: 8, border: '1px solid #C7D2FE' }}>
                                    <span style={{ display: 'inline-block', animation: 'spin 1s linear infinite', fontSize: 14 }}>↻</span>
                                    <div style={{ fontSize: 12, fontWeight: 700, color: '#4F46E5' }}>Analyzing document…</div>
                                  </div>
                                ) : (
                                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                                    {/* CARFAX upload */}
                                    {!(v.documents||[]).find((d:any) => d.type==='carfax' || d.type==='autocheck') && (
                                      <label style={{ flex: 1, minWidth: 140, display: 'flex', flexDirection: 'column', gap: 4, padding: '9px 12px', background: v.tier==='gem'?'#0F172A':'#fff', borderRadius: 8, border: `1px dashed ${v.tier==='gem'?'#475569':BORDER}`, cursor: 'pointer' }}>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                          <span style={{ fontSize: 13 }}>📎</span>
                                          <div style={{ flex: 1 }}>
                                            <div style={{ fontSize: 11, fontWeight: 700, color: v.tier==='gem'?'#CBD5E1':TEXT1 }}>CARFAX / AutoCheck</div>
                                            <div style={{ fontSize: 10, color: '#EA580C', fontWeight: 600 }}>🚨 Missing — accident history unknown</div>
                                          </div>
                                        </div>
                                        <div style={{ height: 4, background: '#E2E8F0', borderRadius: 99 }}>
                                          <div style={{ height: '100%', width: '0%', background: '#16A34A', borderRadius: 99 }} />
                                        </div>
                                        <div style={{ fontSize: 9, color: TEXT3 }}>Upload to unlock +25% confidence · drag & drop PDF</div>
                                        <input type="file" accept=".pdf,.png,.jpg,.jpeg,.webp,.heic" style={{display:'none'}}
                                          onChange={async (e) => { const f = e.target.files?.[0]; if(f) await attachDocument(v.id, f, 'carfax'); }} />
                                      </label>
                                    )}

                                    {/* PPI upload */}
                                    {!(v.documents||[]).find((d:any) => d.type==='ppi') && (
                                      <label style={{ flex: 1, minWidth: 140, display: 'flex', flexDirection: 'column', gap: 4, padding: '9px 12px', background: v.tier==='gem'?'#0F172A':'#fff', borderRadius: 8, border: `1px dashed ${v.tier==='gem'?'#475569':BORDER}`, cursor: 'pointer' }}>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                          <span style={{ fontSize: 13 }}>🔧</span>
                                          <div style={{ flex: 1 }}>
                                            <div style={{ fontSize: 11, fontWeight: 700, color: v.tier==='gem'?'#CBD5E1':TEXT1 }}>PPI / Inspection</div>
                                            <div style={{ fontSize: 10, color: '#B45309', fontWeight: 600 }}>⚠ No mechanic sign-off on file</div>
                                          </div>
                                        </div>
                                        <div style={{ height: 4, background: '#E2E8F0', borderRadius: 99 }}>
                                          <div style={{ height: '100%', width: '0%', background: '#3B82F6', borderRadius: 99 }} />
                                        </div>
                                        <div style={{ fontSize: 9, color: TEXT3 }}>Upload inspection report → unlock +15% confidence</div>
                                        <input type="file" accept=".pdf,.png,.jpg,.jpeg,.webp,.heic" style={{display:'none'}}
                                          onChange={async (e) => { const f = e.target.files?.[0]; if(f) await attachDocument(v.id, f, 'ppi'); }} />
                                      </label>
                                    )}

                                    {/* Photo scan */}
                                    {!v.photo_intel?.condition && v.listing_url && !v.listing_url.startsWith('manual_') && (
                                      <button onClick={e => { e.stopPropagation(); scanPhotos(v.id); }} disabled={scanningPhotosId===v.id}
                                        style={{ flex: 1, minWidth: 140, display: 'flex', flexDirection: 'column', gap: 4, padding: '9px 12px', background: v.tier==='gem'?'#0F172A':'#fff', borderRadius: 8, border: `1px dashed ${v.tier==='gem'?'#475569':BORDER}`, cursor: 'pointer', textAlign: 'left' }}>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                          <span style={{ fontSize: 13 }}>{scanningPhotosId===v.id ? '⏳' : '📸'}</span>
                                          <div style={{ flex: 1 }}>
                                            <div style={{ fontSize: 11, fontWeight: 700, color: v.tier==='gem'?'#CBD5E1':TEXT1 }}>{scanningPhotosId===v.id ? 'Scanning…' : 'AI Photo Scan'}</div>
                                            <div style={{ fontSize: 10, color: '#B45309', fontWeight: 600 }}>⚠ Visual condition not assessed</div>
                                          </div>
                                        </div>
                                        <div style={{ height: 4, background: '#E2E8F0', borderRadius: 99 }}>
                                          <div style={{ height: '100%', width: scanningPhotosId===v.id ? '50%' : '0%', background: '#8B5CF6', borderRadius: 99, transition: 'width 1s' }} />
                                        </div>
                                        <div style={{ fontSize: 9, color: TEXT3 }}>Detect rust, leaks, and missing mechanical areas</div>
                                      </button>
                                    )}

                                    {/* Photo result — with mechanical coverage bars */}
                                    {v.photo_intel?.condition && (() => {
                                      const pi = v.photo_intel;
                                      const cov = pi.mechanicalCoverage;
                                      const covered = cov ? [cov.engineBayVisible, cov.suspensionVisible, cov.undercarriageVisible, cov.frameRailsVisible, cov.odometerVisible].filter(Boolean).length : 0;
                                      const coverPct = cov ? Math.round((covered / 5) * 100) : 50;
                                      const isFlag = pi.condition === 'flag';
                                      const isFair = pi.condition === 'fair';
                                      const flagColor = isFlag ? '#B91C1C' : isFair ? '#B45309' : '#15803D';
                                      const flagBg = isFlag ? '#FEF2F2' : isFair ? '#FFFBEB' : '#F0FDF4';
                                      const flagBorder = isFlag ? '#FECACA' : isFair ? '#FDE68A' : '#86EFAC';
                                      return (
                                        <div style={{ flex: 1, minWidth: 160, display: 'flex', flexDirection: 'column', gap: 4, padding: '9px 12px', background: flagBg, borderRadius: 8, border: `1px solid ${flagBorder}` }}>
                                          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                            <span style={{ fontSize: 13 }}>{isFlag ? '⚠️' : '📸'}</span>
                                            <div style={{ flex: 1 }}>
                                              <div style={{ fontSize: 11, fontWeight: 800, color: flagColor }}>
                                                {pi.grade && <span style={{ marginRight: 4 }}>Grade {pi.grade}</span>}
                                                {(pi.gradeLabel || ('Photos: ' + pi.condition)).slice(0, 28)}
                                              </div>
                                            </div>
                                          </div>
                                          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                            <div style={{ flex: 1, height: 4, background: '#E2E8F0', borderRadius: 99 }}>
                                              <div style={{ height: '100%', width: `${coverPct}%`, background: coverPct >= 60 ? '#16A34A' : coverPct >= 30 ? '#F59E0B' : '#EF4444', borderRadius: 99, transition: 'width 0.5s' }} />
                                            </div>
                                            <div style={{ fontSize: 9, color: '#6B7280', whiteSpace: 'nowrap', fontWeight: 700 }}>{covered}/5 key areas</div>
                                          </div>
                                          {pi.missingAreas?.length > 0 && (
                                            <div style={{ fontSize: 9, color: '#B45309', fontWeight: 600 }}>📋 Request: {(pi.missingAreas[0] || '').split('—')[0].slice(0,40)}</div>
                                          )}
                                        </div>
                                      );
                                    })()}
                                  </div>
                                )}

                                {/* Drag hint */}
                                {!uploadingDocId && (v.documents||[]).length === 0 && (
                                  <div style={{ marginTop: 10, fontSize: 10, color: TEXT3, textAlign: 'center' }}>
                                    ↑ click to upload · or drag & drop a PDF anywhere on this box
                                  </div>
                                )}
                              </div>
                            </div>

                            {/* ── CHAT CONTINUATION ─────────────────────────────────────── */}
                             <div style={{ marginTop: 4 }} onClick={e => e.stopPropagation()}>

                               {/* Follow-up messages (msg[0] already shown in AI Insight above) */}
                               {(navigatorChat[v.id]?.length ?? 0) > 1 && (
                                 <div style={{ marginBottom: 8, borderRadius: 12, border: `1px solid ${v.tier==='gem'?'#334155':BORDER}`, overflow: 'hidden' }}>
                                   <div style={{ maxHeight: 360, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 10, padding: 14, background: v.tier==='gem'?'#1E293B':'#fff' }}>
                                     {(navigatorChat[v.id]||[]).slice(1).map((msg, mi) => (
                                       <div key={mi} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', flexDirection: msg.role==='user'?'row-reverse':'row' }}>
                                         <div style={{ width: 24, height: 24, borderRadius: '50%', background: msg.role==='user'?'#E2E8F0':'#4F46E5', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, flexShrink: 0 }}>
                                           {msg.role==='user'?'👤':'🤖'}
                                         </div>
                                         <div style={{ maxWidth: '88%', padding: '8px 12px', background: msg.role==='user'?(v.tier==='gem'?'#334155':'#EFF6FF'):(v.tier==='gem'?'#0F172A':'#F8FAFC'), borderRadius: msg.role==='user'?'12px 12px 4px 12px':'4px 12px 12px 12px', fontSize: 12, lineHeight: 1.65, color: v.tier==='gem'?'#E2E8F0':TEXT1, whiteSpace: 'pre-wrap' }}>
                                           {msg.content}
                                         </div>
                                       </div>
                                     ))}
                                     {navigatorLoading[v.id] && (navigatorChat[v.id]?.length ?? 0) > 1 && (
                                       <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                                         <div style={{ width: 24, height: 24, borderRadius: '50%', background: '#4F46E5', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, flexShrink: 0 }}>🤖</div>
                                         <div style={{ fontSize: 12, color: v.tier==='gem'?'#CBD5E1':TEXT2, fontStyle: 'italic' }}>Thinking…</div>
                                       </div>
                                     )}
                                     <div ref={el => { chatEndRefs.current[v.id] = el; }} />
                                   </div>
                                 </div>
                               )}

                               {/* Quick-action chips */}
                               {!navigatorLoading[v.id] && (navigatorChat[v.id]?.length ?? 0) > 0 && (
                                 <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
                                   {["What should I offer?", "Walk me through red flags", "What to ask the seller?", "Is this worth the risk?", "What's a walk-away price?"].map(chip => (
                                     <button key={chip} onClick={() => sendNavigatorMessage(v.id, chip)}
                                       style={{ padding: '5px 11px', borderRadius: 99, fontSize: 11, fontWeight: 600, background: v.tier==='gem'?'#1E293B':'#F1F5F9', border: `1px solid ${v.tier==='gem'?'#334155':BORDER}`, color: v.tier==='gem'?'#94A3B8':TEXT2, cursor: 'pointer', whiteSpace: 'nowrap' }}>
                                       {chip}
                                     </button>
                                   ))}
                                 </div>
                               )}

                               {/* Chat input */}
                               <div style={{ display: 'flex', borderRadius: 10, border: `1px solid ${v.tier==='gem'?'#334155':BORDER}`, overflow: 'hidden' }}>
                                 <input
                                   value={navigatorInput[v.id]||''}
                                   onChange={e => setNavigatorInput(prev => ({...prev, [v.id]: e.target.value}))}
                                   onKeyDown={e => { if(e.key==='Enter' && !e.shiftKey && navigatorInput[v.id]?.trim()) { e.preventDefault(); sendNavigatorMessage(v.id, navigatorInput[v.id]); } }}
                                   placeholder="Ask anything about this deal…"
                                   style={{ flex: 1, padding: '10px 14px', border: 'none', background: v.tier==='gem'?'#1E293B':'#fff', color: v.tier==='gem'?'#F1F5F9':TEXT1, fontSize: 12, outline: 'none' }}
                                 />
                                 <button
                                   onClick={() => { if(navigatorInput[v.id]?.trim()) sendNavigatorMessage(v.id, navigatorInput[v.id]); }}
                                   disabled={navigatorLoading[v.id]}
                                   style={{ padding: '10px 16px', background: '#4F46E5', color: '#fff', border: 'none', fontSize: 13, fontWeight: 700, cursor: 'pointer', opacity: navigatorLoading[v.id]?0.6:1 }}>
                                   ↑
                                 </button>
                               </div>
                             </div>

                             {/* ── Quick Actions: Draft Offer ── */}
                            {v.score && v.gem_price_target && (
                              <div style={{ marginTop: 8, marginBottom: 4 }}>
                                <button
                                  onClick={e => {
                                    e.stopPropagation();
                                    const offerPct = v.tier === 'gem' ? 92 : v.tier === 'watch' ? 88 : 84;
                                    const offer = Math.round((v.gem_price_target || v.price || 0) * (offerPct / 100) / 100) * 100;
                                    const msg = `Draft an offer strategy for this ${v.year} ${v.make} ${v.model}: Listed at ${v.price ? '$' + v.price.toLocaleString() : 'unlisted'}. My target is $${offer.toLocaleString()} (${offerPct}% of gem target $${(v.gem_price_target||0).toLocaleString()}). Help me craft a compelling lowball with psychological anchoring, what justifications to cite (mileage, market comps, any known issues), and a final walk-away number.`;
                                    if (!navigatorOpenId || navigatorOpenId !== v.id) openNavigator(v.id);
                                    setTimeout(() => {
                                      setNavigatorInput(prev => ({ ...prev, [v.id]: msg }));
                                      sendNavigatorMessage(v.id, msg);
                                    }, 300);
                                  }}
                                  style={{ width: '100%', padding: '8px 14px', background: v.tier==='gem' ? '#064E3B' : '#1E293B', color: '#fff', border: 'none', borderRadius: 8, fontSize: 12, fontWeight: 700, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
                                  {`✍️ Draft Offer Strategy → Target: $${Math.round((v.gem_price_target || v.price || 0) * (v.tier==='gem'?0.92:v.tier==='watch'?0.88:0.84)/100)*100}`}
                                </button>
                              </div>
                            )}

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
                })}
                </>
              )}
            </div>
            </div>
            )} {/* end viewTab === 'radar' */}

            {/* ── INBOX TAB ─────────────────────────────────────────────── */}
            {viewTab === 'inbox' && (
              <div>
                {scoutLeads.length === 0 ? (
                  <div style={{ padding: '60px 20px', textAlign: 'center' }}>
                    <div style={{ fontSize: 48, marginBottom: 16 }}>🔭</div>
                    <div style={{ fontSize: 20, fontWeight: 800, marginBottom: 8 }}>Inbox is empty</div>
                    <div style={{ fontSize: 14, color: TEXT2, maxWidth: 360, margin: '0 auto', lineHeight: 1.6 }}>
                      Your Scout will drop leads here when it finds vehicles matching your criteria. Set one up to get started.
                    </div>
                    <button onClick={() => setShowScoutChat(true)}
                      style={{ marginTop: 24, padding: '12px 28px', background: ACCENT, color: '#fff', border: 'none', borderRadius: 10, fontSize: 14, fontWeight: 700, cursor: 'pointer' }}>
                      🔭 Configure Scout
                    </button>
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                    <div style={{ fontSize: 13, color: TEXT2, marginBottom: 4 }}>
                      {scoutLeads.length} new lead{scoutLeads.length > 1 ? 's' : ''} — review and accept or pass
                    </div>
                    {scoutLeads.map((lead: any) => {
                      const isGem = lead.shadow_score >= 72;
                      const transitColor = lead.transit_level <= 2 ? '#15803D' : lead.transit_level <= 3 ? '#B45309' : '#94A3B8';
                      const mktDelta = lead.price && lead.market_mid ? lead.market_mid - lead.price : null;
                      const landedPrice = lead.price && lead.transit_level ? lead.price + (lead.transit_level <= 2 ? 0 : lead.transit_level <= 3 ? 1000 : 1800) : null;
                      return (
                        <div key={lead.id} style={{ background: SURFACE, borderRadius: 16, border: `2px solid ${isGem ? '#22C55E' : BORDER}`, padding: '20px 24px', boxShadow: isGem ? '0 0 0 1px #86EFAC' : 'none' }}>
                          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16 }}>
                            {/* Score */}
                            <div style={{ flexShrink: 0, width: 52, height: 52, borderRadius: '50%', background: isGem ? '#DCFCE7' : '#FFF7ED', border: `2px solid ${isGem ? '#22C55E' : '#FDBA74'}`, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
                              <div style={{ fontSize: 15, fontWeight: 900, color: isGem ? '#15803D' : '#B45309' }}>{lead.shadow_score || '?'}</div>
                              <div style={{ fontSize: 7, fontWeight: 700, color: '#9CA3AF' }}>SCORE</div>
                            </div>
                            {/* Info */}
                            <div style={{ flex: 1 }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                                <div style={{ fontSize: 16, fontWeight: 800 }}>{lead.year} {lead.make?.charAt(0).toUpperCase()}{lead.make?.slice(1)} {lead.model?.charAt(0).toUpperCase()}{lead.model?.slice(1)}{lead.trim ? ` ${lead.trim}` : ''}</div>
                                {isGem && <span style={{ fontSize: 10, fontWeight: 800, background: '#DCFCE7', color: '#15803D', padding: '2px 8px', borderRadius: 99, border: '1px solid #86EFAC' }}>💎 GEM</span>}
                              </div>
                              <div style={{ fontSize: 12, color: TEXT2, display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 8 }}>
                                {lead.mileage && <span>{lead.mileage.toLocaleString()} mi</span>}
                                {lead.location && <span>📍 {lead.location}</span>}
                                {lead.transit_label && <span style={{ fontWeight: 700, color: transitColor }}>{lead.transit_label}</span>}
                                {lead.market_mid && <span style={{ fontWeight: 700 }}>Mkt ${lead.market_mid.toLocaleString()}</span>}
                              </div>
                              {/* Price analysis */}
                              <div style={{ display: 'flex', gap: 20, marginBottom: 10 }}>
                                {lead.price && (
                                  <div>
                                    <div style={{ fontSize: 9, fontWeight: 700, color: TEXT3, letterSpacing: '0.08em' }}>ASKING</div>
                                    <div style={{ fontSize: 18, fontWeight: 900 }}>${lead.price.toLocaleString()}</div>
                                  </div>
                                )}
                                {landedPrice && lead.transit_level > 2 && (
                                  <div>
                                    <div style={{ fontSize: 9, fontWeight: 700, color: TEXT3, letterSpacing: '0.08em' }}>LANDED (EST)</div>
                                    <div style={{ fontSize: 18, fontWeight: 900, color: '#475569' }}>${landedPrice.toLocaleString()}</div>
                                  </div>
                                )}
                                {mktDelta !== null && (
                                  <div>
                                    <div style={{ fontSize: 9, fontWeight: 700, color: TEXT3, letterSpacing: '0.08em' }}>VS MARKET</div>
                                    <div style={{ fontSize: 14, fontWeight: 800, color: mktDelta > 0 ? '#15803D' : '#DC2626' }}>
                                      {mktDelta > 0 ? `↓ $${mktDelta.toLocaleString()} below` : `↑ $${Math.abs(mktDelta).toLocaleString()} above`}
                                    </div>
                                  </div>
                                )}
                              </div>
                              {/* Scout label */}
                              {lead.scout_configs?.label && (
                                <div style={{ fontSize: 10, color: '#64748B', marginBottom: 8 }}>Found by: <strong>{lead.scout_configs.label}</strong></div>
                              )}
                            </div>
                          </div>
                          {/* Actions */}
                          <div style={{ display: 'flex', gap: 10, marginTop: 16, paddingTop: 14, borderTop: `1px solid ${BORDER}` }}>
                            <a href={lead.listing_url} target="_blank" rel="noopener noreferrer"
                              style={{ flex: 1, padding: '9px 16px', background: BG, border: `1px solid ${BORDER}`, borderRadius: 8, fontSize: 12, fontWeight: 700, color: TEXT2, textDecoration: 'none', textAlign: 'center' }}>
                              View Listing ↗
                            </a>
                            <button onClick={async () => {
                              await fetch('/api/scout/leads', { method: 'PATCH', headers: {'Content-Type':'application/json'}, body: JSON.stringify({id: lead.id, status: 'dismissed'}) });
                              await fetchScoutLeads();
                            }}
                              style={{ flex: 1, padding: '9px 16px', background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 8, fontSize: 12, fontWeight: 700, color: '#DC2626', cursor: 'pointer' }}>
                              ✕ Pass
                            </button>
                            <button onClick={async () => {
                              await addLeadToHunt(lead);
                              await fetch('/api/scout/leads', { method: 'PATCH', headers: {'Content-Type':'application/json'}, body: JSON.stringify({id: lead.id, status: 'added'}) });
                              await fetchScoutLeads();
                              setViewTab('radar');
                            }}
                              style={{ flex: 1, padding: '9px 16px', background: '#DCFCE7', border: '1px solid #86EFAC', borderRadius: 8, fontSize: 12, fontWeight: 700, color: '#15803D', cursor: 'pointer' }}>
                              ✓ Add to Radar
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
        )}
      </div>
      <style dangerouslySetInnerHTML={{__html: "@keyframes spin { 100% { transform: rotate(360deg); } } @keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } } @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.6; } }"}} />
    </div>
  );
}

// ─── Shipping Tier — Hilltop Denver (80209) as home base ──────────────────────
function computeShippingTier(location: string | null): { level: number; label: string } | null {
  if (!location) return null;
  const loc = location.toLowerCase();
  // Tier 1: Local/Driveable — Colorado + adjacent states
  if (/colorado|\bco\b|utah|\but\b|wyoming|\bwy\b|new mexico|\bnm\b/.test(loc)) return { level: 1, label: "Local / Driveable" };
  // Tier 2: Regional — Mountain West within ~800mi
  if (/arizona|\baz\b|nevada|\bnv\b|idaho|\bid\b|montana|\bmt\b|north dakota|south dakota/.test(loc)) return { level: 2, label: "Regional Haul" };
  // Tier 3: Mid-Continent — Midwest, Texas, Central
  if (/texas|\btx\b|kansas|\bks\b|nebraska|\bne\b|oklahoma|\bok\b|missouri|\bmo\b|iowa|\bia\b|minnesota|\bmn\b|illinois|\bil\b|indiana|\bin\b|ohio|\boh\b|tennessee|\btn\b|arkansas|\bar\b|louisiana|\bla\b/.test(loc)) return { level: 3, label: "Mid-Haul" };
  // Tier 4: Coastal / Long-Haul
  if (/california|\bca\b|oregon|\bor\b|washington|\bwa\b|new york|\bny\b|florida|\bfl\b|georgia|\bga\b|north carolina|south carolina|virginia|\bva\b|pennsylvania|\bpa\b|michigan|\bmi\b|wisconsin|\bwi\b/.test(loc)) return { level: 4, label: "Long-Haul" };
  // Tier 5: Remote / International
  if (/alaska|\bak\b|hawaii|\bhi\b|canada|international|overseas/.test(loc)) return { level: 5, label: "Remote / Complex" };
  // Default: unknown location = mid-haul assumption
  return { level: 3, label: "Est. Mid-Haul" };
}

// ─── Scout Config Modal ───────────────────────────────────────────────────────
function ScoutConfigModal({ show, onClose, scoutConfigs, scoutForm, setScoutForm, savingScout, saveScoutConfig, onDelete }: any) {
  if (!show) return null;
  const INP: React.CSSProperties = { width: '100%', padding: '9px 12px', borderRadius: 8, border: '1px solid #E2E8F0', fontSize: 13, outline: 'none', boxSizing: 'border-box' };
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      <div style={{ background: '#fff', borderRadius: 16, padding: 28, maxWidth: 480, width: '100%', maxHeight: '90vh', overflowY: 'auto' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 20 }}>
          <div>
            <div style={{ fontSize: 11, fontWeight: 800, color: '#4F46E5', letterSpacing: '0.1em' }}>AUTOMATED SCOUT</div>
            <div style={{ fontSize: 20, fontWeight: 900, marginTop: 4 }}>🔭 Configure Your Scout</div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 22, color: '#94A3B8' }}>×</button>
        </div>
        <div style={{ fontSize: 13, color: '#475569', marginBottom: 20, lineHeight: 1.5 }}>
          The Scout runs every 30 minutes, monitoring Cars.com and Bring a Trailer for new listings matching your criteria. Gems appear in your Incoming Leads tray.
        </div>

        {/* Active configs */}
        {scoutConfigs.length > 0 && (
          <div style={{ marginBottom: 20 }}>
            <div style={{ fontSize: 10, fontWeight: 800, color: '#94A3B8', letterSpacing: '0.08em', marginBottom: 8 }}>ACTIVE SCOUTS</div>
            {scoutConfigs.map((c: any) => (
              <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', background: '#F8FAFC', borderRadius: 8, border: '1px solid #E2E8F0', marginBottom: 6 }}>
                <span style={{ fontSize: 13 }}>🔭</span>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 12, fontWeight: 700 }}>{c.label}</div>
                  <div style={{ fontSize: 10, color: '#94A3B8' }}>
                    {c.make} {c.model} · max ${c.price_max?.toLocaleString() ?? '?'} · {c.radius_miles}mi radius
                    {c.last_run_at && ` · Last run: ${new Date(c.last_run_at).toLocaleDateString()}`}
                  </div>
                </div>
                <div style={{ fontSize: 10, fontWeight: 800, color: '#15803D' }}>{c.lead_count || 0} leads</div>
                <button onClick={() => onDelete(c.id)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#EF4444', fontSize: 16 }}>×</button>
              </div>
            ))}
          </div>
        )}

        {/* New config form */}
        <form onSubmit={saveScoutConfig}>
          <div style={{ fontSize: 10, fontWeight: 800, color: '#94A3B8', letterSpacing: '0.08em', marginBottom: 12 }}>NEW SCOUT DIRECTIVE</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 10 }}>
            <div>
              <label style={{ fontSize: 11, fontWeight: 700, color: '#475569', display: 'block', marginBottom: 4 }}>Make *</label>
              <input required placeholder="toyota" value={scoutForm.make} onChange={e => setScoutForm((f: any) => ({...f, make: e.target.value}))} style={INP} />
            </div>
            <div>
              <label style={{ fontSize: 11, fontWeight: 700, color: '#475569', display: 'block', marginBottom: 4 }}>Model</label>
              <input placeholder="land cruiser" value={scoutForm.model} onChange={e => setScoutForm((f: any) => ({...f, model: e.target.value}))} style={INP} />
            </div>
            <div>
              <label style={{ fontSize: 11, fontWeight: 700, color: '#475569', display: 'block', marginBottom: 4 }}>Year min</label>
              <input type="number" placeholder="2015" value={scoutForm.year_min} onChange={e => setScoutForm((f: any) => ({...f, year_min: e.target.value}))} style={INP} />
            </div>
            <div>
              <label style={{ fontSize: 11, fontWeight: 700, color: '#475569', display: 'block', marginBottom: 4 }}>Year max</label>
              <input type="number" placeholder="2022" value={scoutForm.year_max} onChange={e => setScoutForm((f: any) => ({...f, year_max: e.target.value}))} style={INP} />
            </div>
            <div>
              <label style={{ fontSize: 11, fontWeight: 700, color: '#475569', display: 'block', marginBottom: 4 }}>Max Price ($)</label>
              <input type="number" placeholder="30000" value={scoutForm.price_max} onChange={e => setScoutForm((f: any) => ({...f, price_max: e.target.value}))} style={INP} />
            </div>
            <div>
              <label style={{ fontSize: 11, fontWeight: 700, color: '#475569', display: 'block', marginBottom: 4 }}>Max Mileage</label>
              <input type="number" placeholder="120000" value={scoutForm.mileage_max} onChange={e => setScoutForm((f: any) => ({...f, mileage_max: e.target.value}))} style={INP} />
            </div>
          </div>
          <div style={{ marginBottom: 16 }}>
            <label style={{ fontSize: 11, fontWeight: 700, color: '#475569', display: 'block', marginBottom: 4 }}>Scout Name (optional)</label>
            <input placeholder="Land Cruiser Hunt" value={scoutForm.label} onChange={e => setScoutForm((f: any) => ({...f, label: e.target.value}))} style={INP} />
          </div>
          <div style={{ fontSize: 11, color: '#94A3B8', marginBottom: 16 }}>
            Sources: <strong>Cars.com</strong> + <strong>Bring a Trailer</strong> · Runs every 30 min · Gem alerts sent via email
          </div>
          <button type="submit" disabled={savingScout} style={{ width: '100%', padding: '12px', background: '#4F46E5', color: '#fff', borderRadius: 10, border: 'none', fontSize: 14, fontWeight: 700, cursor: 'pointer', opacity: savingScout ? 0.7 : 1 }}>
            {savingScout ? 'Saving...' : '🔭 Activate Scout'}
          </button>
        </form>
      </div>
    </div>
  );
}

// ─── WrenchScore gauge (SVG semicircle) ──────────────────────────────────────
function WrenchScoreGauge({ score, size = 100 }: { score: number; size?: number }) {
  const R     = 40;
  const cx    = 50;
  const cy    = 52;
  const circ  = Math.PI * R; // semicircle circumference
  const pct   = Math.max(0, Math.min(1, score / 100));
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
      <path d={"M 10 52 A 40 40 0 0 1 90 52"} fill="none" stroke="#334155" strokeWidth="10" strokeLinecap="round" />
      {/* Filled arc */}
      <path d={"M 10 52 A 40 40 0 0 1 90 52"} fill="none" stroke={gaugeColor} strokeWidth="10" strokeLinecap="round" strokeDasharray={`${pct * circ} ${circ}`} />
      {/* Needle */}
      <line x1={cx} y1={cy} x2={nx} y2={ny} stroke="#CBD5E1" strokeWidth="2" strokeLinecap="round" />
      <circle cx={cx} cy={cy} r="3.5" fill="#CBD5E1" />
      {/* Score label */}
      <text x={cx} y={cy - 8} textAnchor="middle" fontSize="13" fontWeight="800" fill={gaugeColor}>{score}</text>
    </svg>
  );
}


// ─── Confidence Ring — score bubble with dossier completion arc ───────────────
function ConfidenceRing({ score, confidencePct, tier }: { score: number; confidencePct: number; tier?: string }) {
  const size = 52;
  const R = 22;
  const cx = size / 2;
  const cy = size / 2;
  const circ = 2 * Math.PI * R;
  const filled = Math.max(0, Math.min(1, confidencePct / 100)) * circ;

  const scoreColor = score >= 75 ? "#16A34A" : score >= 65 ? "#CA8A04" : score >= 50 ? "#EA580C" : "#DC2626";
  const ringColor = confidencePct >= 85 ? "#16A34A" : confidencePct >= 70 ? "#3B82F6" : confidencePct >= 45 ? "#F59E0B" : "#CBD5E1";
  const bgColor = tier === 'gem' ? '#DCFCE7' : tier === 'watch' ? '#FEF9C3' : tier === 'pass' ? '#FEE2E2' : '#F1F5F9';

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <circle cx={cx} cy={cy} r={R - 3} fill={bgColor} />
      <circle cx={cx} cy={cy} r={R} fill="none" stroke="#E2E8F0" strokeWidth="4" />
      <circle
        cx={cx} cy={cy} r={R}
        fill="none"
        stroke={ringColor}
        strokeWidth="4"
        strokeLinecap="round"
        strokeDasharray={`${filled} ${circ}`}
        transform={`rotate(-90 ${cx} ${cy})`}
        style={{ transition: 'stroke-dasharray 0.6s ease' }}
      />
      <text x={cx} y={cy + 5} textAnchor="middle" fontSize="14" fontWeight="900" fill={scoreColor}>{score}</text>
    </svg>
  );
}
