"use client";

import { useState, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";
import {
  UploadCloud,
  Link2,
  FileText,
  ArrowRight,
  Zap,
  FileCheck,
  Info,
  X,
  ShieldCheck,
} from "lucide-react";

type Tab = "file" | "url" | "text";
type StatusState = "idle" | "loading" | "done" | "error";

const SOURCE_LABELS: Record<string, string> = {
  image: "Image",
  pdf_text: "PDF (text)",
  pdf_vision: "PDF (vision)",
  url: "URL",
  text: "Text",
};

export default function Home() {
  const router = useRouter();

  const [tab, setTab] = useState<Tab>("file");
  const [status, setStatus] = useState<StatusState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);

  // File tab
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // URL tab
  const [urlInput, setUrlInput] = useState("");

  // Text tab
  const [textInput, setTextInput] = useState("");

  const reset = () => {
    setStatus("idle");
    setError(null);
  };

  // ── Shared submission handler ────────────────────────────────────────────────
  const submit = useCallback(async (overrideFiles?: File[]) => {
    setError(null);
    const files = overrideFiles ?? selectedFiles;

    if (tab === "file" && files.length === 0) return;
    if (tab === "url" && !urlInput.trim()) return;
    if (tab === "text" && !textInput.trim()) return;

    try {
      setStatus("loading");
      let res: Response;

      if (tab === "file" && files.length > 0) {
        const fd = new FormData();
        files.forEach(f => fd.append("files", f));
        res = await fetch("/api/upload-init", { method: "POST", body: fd });
      } else {
        res = await fetch("/api/ingest", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            tab === "url" ? { url: urlInput.trim() } : { text: textInput.trim() }
          ),
        });
      }

      const data = await res.json();
      if (!res.ok || data.error) {
        setError(data.error || "Something went wrong.");
        setStatus("error");
        return;
      }

      setStatus("done");
      const partial = data.warning || data.confidence === "low";
      const dest = partial
        ? `/audit/${data.case_id}?partial=true`
        : `/audit/${data.case_id}`;
      router.push(dest);
    } catch (err: any) {
      setError(err.message || "Unexpected error. Please try again.");
      setStatus("error");
    }
  }, [tab, selectedFiles, urlInput, textInput, router]);

  // ── Drag & drop ──────────────────────────────────────────────────────────────
  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragActive(false);
      const files = Array.from(e.dataTransfer.files || []);
      if (files.length > 0) {
        setSelectedFiles(files);
        setTab("file");
        submit(files);
      }
    },
    [submit]
  );

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length > 0) {
      setSelectedFiles(files);
      submit(files);
    }
  };

  const isLoading = status === "loading";

  const tabs: { id: Tab; Icon: any; label: string; sublabel: string }[] = [
    { id: "file", Icon: UploadCloud, label: "Upload file", sublabel: "Image or PDF" },
    { id: "url",  Icon: Link2,       label: "Paste Digital Estimate Link",   sublabel: "Hosted estimate" },
    { id: "text", Icon: FileText,    label: "Paste text",   sublabel: "Copy from email" },
  ];

  return (
    <div className="min-h-screen bg-[#F8F9FF] font-sans selection:bg-[#00236F]/10">

      {/* Full-screen loading takeover — replaces the entire form */}
      {isLoading && (
        <div className="fixed inset-0 z-50 bg-[#F8F9FF] flex flex-col items-center justify-center gap-6">
          <div className="relative w-20 h-20">
            <div className="absolute inset-0 rounded-3xl bg-white border border-slate-100 shadow-[0_20px_40px_rgba(13,28,46,0.06)] flex items-center justify-center">
              <ShieldCheck className="w-9 h-9 text-[#00236F]" />
            </div>
            <div className="absolute inset-0 rounded-3xl border-2 border-t-[#00236F] border-r-transparent border-b-transparent border-l-transparent animate-spin" />
          </div>
          <div className="text-center space-y-1.5">
            <p className="text-[10px] font-black uppercase tracking-widest text-[#00236F]/40">WrenchCheck</p>
            <h2 className="text-xl font-black text-[#0D1C2E] tracking-tighter">Reviewing your estimate…</h2>
            <p className="text-[12px] text-slate-400 font-medium">Extracting services and checking market prices</p>
          </div>
        </div>
      )}

      {/* Header */}
      <header className="fixed top-0 w-full z-50 bg-white/80 backdrop-blur-xl border-b border-[#C5C5D3]/20 h-16 flex items-center">
        <div className="flex justify-between items-center px-8 w-full max-w-5xl mx-auto">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 bg-[#00236F] rounded-lg flex items-center justify-center">
              <ShieldCheck className="w-5 h-5 text-white" />
            </div>
            <h1 className="text-xl font-bold tracking-tighter uppercase italic text-[#00236F]">WrenchCheck</h1>
          </div>
          <div className="flex items-center gap-3">
            <a
              href="/maintenance"
              className="text-[11px] font-semibold text-[#00236F]/60 hover:text-[#00236F] border border-[#00236F]/15 hover:border-[#00236F]/30 hover:bg-[#EFF4FF] px-3 py-1.5 rounded-full transition-all duration-150"
            >
              Maintenance Audit →
            </a>
            <div className="bg-[#EFF4FF] px-4 py-1.5 rounded-full flex items-center gap-2">
              <span className="w-1.5 h-1.5 bg-[#00236F] rounded-full animate-pulse" />
              <span className="text-[10px] font-black uppercase tracking-widest text-[#00236F]/60">Advisor Active</span>
            </div>
          </div>
        </div>
      </header>

      <main className="pt-28 pb-24 px-4 max-w-2xl mx-auto">

        {/* Hero */}
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6 }}
          className="text-center mb-10 space-y-3"
        >
          <p className="text-[10px] font-black uppercase tracking-[0.4em] text-[#00236F]/40">Precision Concierge</p>
          <h2 className="text-5xl font-black text-[#0D1C2E] tracking-tighter leading-none">
            Submit Your <span className="text-[#00236F] italic">Estimate.</span>
          </h2>
          <p className="text-sm text-slate-500 font-medium leading-relaxed max-w-sm mx-auto">
            Upload a photo, drop a PDF, paste a link, or type it out — we'll handle the rest.
          </p>
        </motion.div>

        {/* Error banner */}
        <AnimatePresence>
          {error && (
            <motion.div
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              className="mb-4 bg-red-50 border border-red-200 rounded-2xl p-4 flex items-start gap-3"
            >
              <Info className="w-4 h-4 text-red-500 shrink-0 mt-0.5" />
              <p className="text-sm text-red-700 font-medium leading-relaxed flex-1">{error}</p>
              <button onClick={reset} className="shrink-0 text-red-400 hover:text-red-600">
                <X className="w-4 h-4" />
              </button>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Intake card */}
        <div className="bg-white rounded-3xl shadow-[0_20px_40px_rgba(13,28,46,0.06)] border border-slate-100 overflow-hidden">

          {/* Tab bar */}
          <div className="grid grid-cols-3 border-b border-slate-100">
            {tabs.map(({ id, Icon, label, sublabel }) => (
              <button
                key={id}
                onClick={() => { setTab(id); reset(); }}
                className={`flex flex-col items-center gap-1 py-4 px-2 text-center transition-all border-b-2 ${
                  tab === id
                    ? "border-[#00236F] bg-[#EFF4FF]/40 text-[#00236F]"
                    : "border-transparent text-slate-400 hover:text-slate-600 hover:bg-slate-50"
                }`}
              >
                <Icon className="w-4 h-4" />
                <span className="text-[11px] font-black uppercase tracking-widest">{label}</span>
                <span className="text-[10px] text-slate-400">{sublabel}</span>
              </button>
            ))}
          </div>

          {/* Tab panels */}
          <div className="p-6">
            <AnimatePresence mode="wait">

              {/* ── FILE TAB ── */}
              {tab === "file" && (
                <motion.div
                  key="file"
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.2 }}
                >
                  <div
                    className={`relative flex flex-col items-center justify-center rounded-2xl border-2 border-dashed transition-all duration-200 min-h-[240px] cursor-pointer ${
                      dragActive
                        ? "border-[#00236F] bg-[#EFF4FF]/60 scale-[1.01]"
                        : selectedFiles.length > 0
                        ? "border-emerald-400 bg-emerald-50/40"
                        : "border-slate-200 hover:border-slate-400 hover:bg-slate-50/50"
                    }`}
                    onDragOver={(e) => { e.preventDefault(); setDragActive(true); }}
                    onDragLeave={() => setDragActive(false)}
                    onDrop={handleDrop}
                    onClick={() => fileInputRef.current?.click()}
                  >
                    <input
                      ref={fileInputRef}
                      type="file"
                      className="hidden"
                      multiple
                      accept="image/png,image/jpeg,image/webp,application/pdf"
                      onChange={handleFileChange}
                    />

                    {selectedFiles.length > 0 ? (
                      <div className="flex flex-col items-center gap-3 text-center p-6">
                        <div className="w-12 h-12 bg-emerald-100 rounded-xl flex items-center justify-center">
                          <FileCheck className="w-6 h-6 text-emerald-600" />
                        </div>
                        <p className="font-bold text-[#0D1C2E] text-sm">
                          {selectedFiles.length === 1 ? selectedFiles[0].name : `${selectedFiles.length} files selected`}
                        </p>
                        <p className="text-[11px] text-slate-400">
                          {selectedFiles.length === 1 
                            ? `${(selectedFiles[0].size / 1024).toFixed(0)} KB · ${selectedFiles[0].type || "unknown type"}`
                            : `Total ${(selectedFiles.reduce((acc, f) => acc + f.size, 0) / 1024 / 1024).toFixed(2)} MB`}
                        </p>
                      </div>
                    ) : (
                      <div className="flex flex-col items-center gap-4 p-8 text-center">
                        <div className="w-14 h-14 bg-slate-100 rounded-2xl flex items-center justify-center">
                          <UploadCloud className="w-7 h-7 text-slate-400" />
                        </div>
                        <div>
                          <p className="text-sm font-bold text-[#0D1C2E]">Drop your estimate here</p>
                          <p className="text-[11px] text-slate-400 mt-1">PNG, JPG, WEBP, PDF · up to 20 MB</p>
                        </div>
                        <span className="text-[10px] font-black text-[#00236F] uppercase tracking-widest bg-[#EFF4FF] px-3 py-1.5 rounded-full">
                          or click to browse
                        </span>
                      </div>
                    )}
                  </div>

                  {selectedFiles.length > 0 && (
                    <motion.button
                      initial={{ opacity: 0, y: 4 }}
                      animate={{ opacity: 1, y: 0 }}
                      onClick={() => submit()}
                      disabled={isLoading}
                      className="w-full mt-4 bg-[#00236F] text-white rounded-2xl py-4 font-black uppercase tracking-widest text-[11px] flex items-center justify-center gap-3 hover:bg-[#001a55] transition-all disabled:opacity-50 shadow-lg"
                    >
                      {isLoading ? (
                        <><div className="w-4 h-4 rounded-full border-2 border-white/20 border-t-white animate-spin" />
                        Reviewing estimate…</>
                      ) : (
                        <><Zap className="w-4 h-4" /> Analyze My Estimate</>
                      )}
                    </motion.button>
                  )}
                </motion.div>
              )}

              {/* ── URL TAB ── */}
              {tab === "url" && (
                <motion.div
                  key="url"
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.2 }}
                  className="space-y-4"
                >
                  <div>
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest block mb-2">
                      Estimate URL
                    </label>
                    <input
                      type="url"
                      value={urlInput}
                      onChange={(e) => setUrlInput(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && submit()}
                      placeholder="https://shop.example.com/estimate/abc123"
                      className="w-full border border-slate-200 rounded-xl px-4 py-3 text-sm text-slate-700 placeholder:text-slate-300 focus:outline-none focus:border-[#00236F]/40 focus:ring-1 focus:ring-[#00236F]/20 transition-all"
                    />
                  </div>
                  <p className="text-[11px] text-slate-400 leading-relaxed">
                    Works with public estimate pages, hosted invoices, and online repair order links.
                    Auth-protected pages won't work — upload a screenshot instead.
                  </p>
                  <button
                    onClick={() => submit()}
                    disabled={!urlInput.trim() || isLoading}
                    className="w-full bg-[#00236F] text-white rounded-2xl py-4 font-black uppercase tracking-widest text-[11px] flex items-center justify-center gap-3 hover:bg-[#001a55] transition-all disabled:opacity-40 shadow-lg"
                  >
                    {isLoading ? (
                      <><div className="w-4 h-4 rounded-full border-2 border-white/20 border-t-white animate-spin" />
                      Reviewing estimate…</>
                    ) : (
                      <><ArrowRight className="w-4 h-4" /> Fetch &amp; Analyze</>
                    )}
                  </button>
                </motion.div>
              )}

              {/* ── TEXT TAB ── */}
              {tab === "text" && (
                <motion.div
                  key="text"
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.2 }}
                  className="space-y-4"
                >
                  <div>
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest block mb-2">
                      Paste Estimate Text
                    </label>
                    <textarea
                      value={textInput}
                      onChange={(e) => setTextInput(e.target.value)}
                      placeholder={"Shop: Urban Autocare\nPower Steering Fluid Service — $245.79\nFront Brake Pads — $189.00\nTotal: $434.79"}
                      rows={9}
                      className="w-full border border-slate-200 rounded-xl px-4 py-3 text-sm text-slate-700 placeholder:text-slate-300 font-mono leading-relaxed focus:outline-none focus:border-[#00236F]/40 focus:ring-1 focus:ring-[#00236F]/20 resize-none transition-all"
                    />
                    <p className="text-[10px] text-slate-400 mt-1 text-right">{textInput.length} chars</p>
                  </div>
                  <p className="text-[11px] text-slate-400 leading-relaxed">
                    Copy directly from an email, SMS, or any readable format. Include shop name and prices for best results.
                  </p>
                  <button
                    onClick={() => submit()}
                    disabled={textInput.trim().length < 20 || isLoading}
                    className="w-full bg-[#00236F] text-white rounded-2xl py-4 font-black uppercase tracking-widest text-[11px] flex items-center justify-center gap-3 hover:bg-[#001a55] transition-all disabled:opacity-40 shadow-lg"
                  >
                    {isLoading ? (
                      <><div className="w-4 h-4 rounded-full border-2 border-white/20 border-t-white animate-spin" />
                      Parsing estimate…</>
                    ) : (
                      <><Zap className="w-4 h-4" /> Parse &amp; Analyze</>
                    )}
                  </button>
                </motion.div>
              )}

            </AnimatePresence>
          </div>
        </div>

        {/* Supported formats row */}
        <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
          {["PNG", "JPG", "WEBP", "PDF", "Hosted link", "Pasted text"].map((f) => (
            <span key={f} className="text-[10px] font-bold text-slate-400 bg-white border border-slate-200 px-2.5 py-1 rounded-full">
              {f}
            </span>
          ))}
        </div>

        {/* Trust strip */}
        <div className="mt-8 grid grid-cols-3 gap-3">
          {[
            { icon: <Zap className="w-4 h-4" />, title: "Instant Extraction", text: "Any format, any shop." },
            { icon: <FileCheck className="w-4 h-4" />, title: "Market Benchmarks", text: "140k repair data points." },
            { icon: <ShieldCheck className="w-4 h-4" />, title: "Advisor-Led", text: "One intelligent verdict." },
          ].map((item, i) => (
            <div key={i} className="bg-white rounded-2xl p-4 border border-slate-100 text-center space-y-2 shadow-sm">
              <div className="w-8 h-8 bg-[#EFF4FF] rounded-lg flex items-center justify-center mx-auto text-[#00236F]">
                {item.icon}
              </div>
              <p className="text-[11px] font-black text-[#0D1C2E] uppercase">{item.title}</p>
              <p className="text-[10px] text-slate-400">{item.text}</p>
            </div>
          ))}
        </div>

      </main>

    </div>
  );
}
