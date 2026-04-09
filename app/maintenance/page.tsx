"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import { useRouter } from "next/navigation";
import {
  Upload, FileText, ClipboardPaste, Pencil, ArrowRight,
  X, CheckCircle, AlertCircle, Car, Gauge, Plus, Trash2, ChevronRight
} from "lucide-react";
import type { ServiceHistoryEvent, VehicleIdentity } from "@/lib/maintenanceDebt/types";

// ─── Types ────────────────────────────────────────────────────────────────────

type InputMode = "paste" | "file" | "manual";
type AuditStage = "input" | "processing" | "done" | "error";

interface ManualEntry {
  id: string;
  description: string;
  date: string;
  mileage: string;
}

const PROCESSING_STEPS = [
  "Reading your PDF…",
  "Extracting service history…",
  "Normalizing service descriptions…",
  "Fetching OEM maintenance schedule…",
  "Calculating maintenance debt…",
  "Comparing to OEM requirements…",
  "Building your report…",
  "Still working — large PDFs take a moment…",
  "Almost there…",
];

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function MaintenanceAuditPage() {
  const router = useRouter();

  const [mode, setMode] = useState<InputMode>("file");
  const [stage, setStage] = useState<AuditStage>("input");
  const [processingStep, setProcessingStep] = useState(0);
  const [errorMsg, setErrorMsg] = useState("");

  // Paste mode
  const [pastedText, setPastedText] = useState("");
  const [pasteSource, setPasteSource] = useState<"carfax" | "autocheck" | "receipt" | "unknown">("carfax");

  // File mode
  const [dragActive, setDragActive] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Manual mode
  const [vin, setVin] = useState("");
  const [mileage, setMileage] = useState("");
  const [manualEntries, setManualEntries] = useState<ManualEntry[]>([
    { id: "entry-0", description: "", date: "", mileage: "" },
  ]);

  useEffect(() => {
    if (stage !== "processing") return;
    setProcessingStep(0);
    const interval = setInterval(() => {
      // Loop through steps so it never looks frozen
      setProcessingStep(prev => (prev + 1) % PROCESSING_STEPS.length);
    }, 2400);
    return () => clearInterval(interval);
  }, [stage]);

  // ── Submission ──────────────────────────────────────────────────────────────

  const submit = useCallback(async () => {
    setErrorMsg("");
    setStage("processing");

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 110_000); // 110s client timeout

    try {
      let res: Response;

      if (mode === "paste") {
        if (!pastedText.trim() || pastedText.trim().length < 30) {
          clearTimeout(timeoutId);
          setErrorMsg("Please paste at least a few lines of service history.");
          setStage("input");
          return;
        }
        res = await fetch("/api/maintenance-audit", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: pastedText, source: pasteSource }),
          signal: controller.signal,
        });

      } else if (mode === "file") {
        if (!selectedFile) {
          clearTimeout(timeoutId);
          setErrorMsg("Please select a file to upload.");
          setStage("input");
          return;
        }
        const formData = new FormData();
        formData.append("file", selectedFile);
        res = await fetch("/api/maintenance-audit", {
          method: "POST",
          body: formData,
          signal: controller.signal,
        });

      } else {
        // Manual
        const events: ServiceHistoryEvent[] = manualEntries
          .filter(e => e.description.trim())
          .map(e => ({
            id: `evt-${Math.random().toString(36).slice(2, 9)}`,
            source: "manual" as const,
            rawDescription: e.description.trim(),
            date: e.date || null,
            mileage: e.mileage ? parseInt(e.mileage.replace(/,/g, ""), 10) : null,
          }));

        const vehicleOverride: Partial<VehicleIdentity> = {
          vin: vin.trim() || undefined,
          currentMileage: mileage ? parseInt(mileage.replace(/,/g, ""), 10) : undefined,
          mileageConfidence: "confirmed",
        };

        if (events.length === 0) {
          clearTimeout(timeoutId);
          setErrorMsg("Add at least one service entry.");
          setStage("input");
          return;
        }
        res = await fetch("/api/maintenance-audit", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ historyOverride: events, vehicleOverride, source: "manual" }),
          signal: controller.signal,
        });
      }

      clearTimeout(timeoutId);
      const data = await res.json();

      if (!data.success) {
        setErrorMsg(data.error ?? "Something went wrong. Please try again.");
        setStage("error");
        return;
      }

      // Store result and navigate
      sessionStorage.setItem("maintenance_audit_result", JSON.stringify(data.result));
      const caseId = "maint_" + Date.now();
      setStage("done");
      setTimeout(() => router.push(`/audit/${caseId}/maintenance`), 600);

    } catch (err: unknown) {
      clearTimeout(timeoutId);
      console.error("[maintenance upload]", err);
      if ((err as Error).name === "AbortError") {
        setErrorMsg("Analysis is taking longer than expected (>2 min). Try pasting the key service records in the Paste History tab instead.");
      } else {
        setErrorMsg("Network error. Please try again.");
      }
      setStage("error");
    }
  }, [mode, pastedText, pasteSource, selectedFile, manualEntries, vin, mileage, router]);


  // ── File handlers ───────────────────────────────────────────────────────────

  const handleFile = (file: File) => {
    const ext = file.name.split(".").pop()?.toLowerCase();
    if (!["pdf", "png", "jpg", "jpeg", "webp"].includes(ext ?? "")) {
      setErrorMsg("Please upload a PDF, PNG, JPG, or WEBP file.");
      return;
    }
    if (file.size > 20 * 1024 * 1024) {
      setErrorMsg("File must be under 20 MB.");
      return;
    }
    setErrorMsg("");
    setSelectedFile(file);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragActive(false);
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  };

  // ── Manual entry helpers ────────────────────────────────────────────────────

  const addEntry = () => setManualEntries(prev => [
    ...prev,
    { id: `entry-${prev.length}`, description: "", date: "", mileage: "" },
  ]);

  const updateEntry = (id: string, field: keyof ManualEntry, value: string) => {
    setManualEntries(prev => prev.map(e => e.id === id ? { ...e, [field]: value } : e));
  };

  const removeEntry = (id: string) => {
    setManualEntries(prev => prev.length > 1 ? prev.filter(e => e.id !== id) : prev);
  };

  // ── Rendering ───────────────────────────────────────────────────────────────

  if (stage === "processing" || stage === "done") {
    return (
      <div style={{
        minHeight: "100vh", background: "#F8FAFC",
        display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
        fontFamily: "'Inter', -apple-system, sans-serif", padding: 32, gap: 24,
      }}>
        <div style={{
          width: 56, height: 56, borderRadius: "50%",
          background: stage === "done" ? "rgba(34,197,94,0.15)" : "rgba(99,102,241,0.15)",
          display: "flex", alignItems: "center", justifyContent: "center",
          border: `2px solid ${stage === "done" ? "rgba(34,197,94,0.4)" : "rgba(99,102,241,0.4)"}`,
          animation: stage === "processing" ? "spin 2s linear infinite" : "none",
        }}>
          {stage === "done"
            ? <CheckCircle size={24} color="#22C55E" />
            : <Car size={24} color="#818CF8" />}
        </div>

        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: 16, fontWeight: 600, color: "#0F172A", marginBottom: 8 }}>
            {stage === "done" ? "Audit complete!" : "Running audit…"}
          </div>
          <div style={{
            fontSize: 13, color: "#64748B",
            minHeight: 20, transition: "opacity 0.4s",
          }}>
            {PROCESSING_STEPS[processingStep]}
          </div>
        </div>

        <div style={{
          display: "flex", gap: 6,
        }}>
          {PROCESSING_STEPS.map((_, i) => (
            <div key={i} style={{
              width: 6, height: 6, borderRadius: "50%",
              background: i <= processingStep ? "#6366F1" : "#CBD5E1",
              transition: "background 0.4s",
            }} />
          ))}
        </div>

        <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
      </div>
    );
  }

  return (
    <div style={{
      minHeight: "100vh",
      background: "#F8FAFC",
      fontFamily: "'Inter', -apple-system, sans-serif",
      color: "#0F172A",
    }}>
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <header style={{
        padding: "20px 32px",
        borderBottom: "1px solid rgba(0,0,0,0.05)",
        display: "flex", alignItems: "center", gap: 12,
      }}>
        <div style={{
          width: 32, height: 32, borderRadius: 8,
          background: "linear-gradient(135deg, #6366F1, #8B5CF6)",
          display: "flex", alignItems: "center", justifyContent: "center",
        }}>
          <Car size={16} color="white" />
        </div>
        <div>
          <div style={{ fontSize: 15, fontWeight: 700, color: "#0F172A" }}>WrenchCheck</div>
          <div style={{ fontSize: 11, color: "#475569" }}>Maintenance Debt Audit</div>
        </div>
      </header>

      {/* ── Main content ───────────────────────────────────────────────────── */}
      <main style={{
        maxWidth: 680, margin: "0 auto", padding: "40px 24px",
        display: "flex", flexDirection: "column", gap: 28,
      }}>

        {/* Hero */}
        <div style={{ textAlign: "center", display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{
            display: "inline-flex", alignItems: "center", gap: 6,
            background: "rgba(99,102,241,0.1)", border: "1px solid rgba(99,102,241,0.2)",
            borderRadius: 20, padding: "4px 14px", margin: "0 auto",
          }}>
            <Gauge size={12} color="#818CF8" />
            <span style={{ fontSize: 11, color: "#4F46E5", fontWeight: 600, letterSpacing: "0.04em" }}>
              PRE-PURCHASE ANALYSIS
            </span>
          </div>
          <h1 style={{ fontSize: 28, fontWeight: 700, color: "#0F172A", margin: 0 }}>
            Maintenance Debt Audit
          </h1>
          <p style={{ fontSize: 14, color: "#64748B", margin: 0, lineHeight: 1.6 }}>
            Upload any vehicle history document — we'll compare it against the OEM schedule<br />
            and show exactly what&apos;s missing and what it will cost to catch up.
          </p>
        </div>

        {/* Mode switcher */}
        <div style={{
          display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8,
          background: "rgba(0,0,0,0.03)",
          border: "1px solid rgba(0,0,0,0.05)", borderRadius: 12, padding: 6,
        }}>
          {([
            { id: "paste", icon: ClipboardPaste, label: "Paste History" },
            { id: "file", icon: Upload, label: "Upload File" },
            { id: "manual", icon: Pencil, label: "Enter Manually" },
          ] as const).map(({ id, icon: Icon, label }) => (
            <button
              key={id}
              onClick={() => setMode(id)}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center", gap: 7,
                padding: "10px 12px", borderRadius: 8, border: "none", cursor: "pointer",
                fontSize: 13, fontWeight: mode === id ? 600 : 400,
                background: mode === id ? "rgba(99,102,241,0.2)" : "transparent",
                color: mode === id ? "#4338CA" : "#64748B",
                transition: "all 0.15s",
              }}
            >
              <Icon size={13} />
              {label}
            </button>
          ))}
        </div>

        {/* ── Input panels ────────────────────────────────────────────────── */}

        {/* PASTE mode */}
        {mode === "paste" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {/* Source hint — internal only, helps extraction quality */}
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span style={{ fontSize: 11, color: "#374151" }}>Source hint:</span>
              {(["carfax", "autocheck", "receipt", "unknown"] as const).map(src => (
                <button key={src} onClick={() => setPasteSource(src)} style={{
                  fontSize: 11, fontWeight: 600,
                  color: pasteSource === src ? "#4F46E5" : "#4B5563",
                  background: pasteSource === src ? "rgba(99,102,241,0.12)" : "rgba(0,0,0,0.03)",
                  border: `1px solid ${pasteSource === src ? "rgba(99,102,241,0.25)" : "rgba(0,0,0,0.05)"}`,
                  borderRadius: 8, padding: "5px 12px", cursor: "pointer",
                  transition: "all 0.15s",
                }}>
                  {src === "carfax" ? "CARFAX" : src === "autocheck" ? "AutoCheck" : src === "receipt" ? "Receipt / Records" : "Other"}
                </button>
              ))}
            </div>

            <textarea
              value={pastedText}
              onChange={e => setPastedText(e.target.value)}
              placeholder={`Paste your vehicle history here — any source works.\n\nInclude:\n• Year, make, model, VIN, and current mileage\n• Service dates and mileage readings\n• Service descriptions`}
              style={{
                width: "100%", minHeight: 260, padding: "14px 16px",
                background: "rgba(0,0,0,0.03)", border: "1px solid rgba(0,0,0,0.06)",
                borderRadius: 12, fontSize: 13, color: "#334155", lineHeight: 1.6,
                resize: "vertical", outline: "none", fontFamily: "monospace",
                transition: "border-color 0.15s",
              }}
              onFocus={e => (e.target.style.borderColor = "rgba(99,102,241,0.4)")}
              onBlur={e => (e.target.style.borderColor = "rgba(0,0,0,0.06)")}
            />

            {pastedText.length > 0 && (
              <div style={{ fontSize: 11, color: "#475569", textAlign: "right" }}>
                {pastedText.length.toLocaleString()} characters
              </div>
            )}
          </div>
        )}

        {/* FILE mode */}
        {mode === "file" && (
          <div
            onDragOver={e => { e.preventDefault(); setDragActive(true); }}
            onDragLeave={() => setDragActive(false)}
            onDrop={handleDrop}
            onClick={() => fileInputRef.current?.click()}
            style={{
              border: `2px dashed ${dragActive ? "rgba(99,102,241,0.5)" : selectedFile ? "rgba(34,197,94,0.4)" : "rgba(0,0,0,0.10)"}`,
              borderRadius: 16, padding: "48px 32px", textAlign: "center",
              background: dragActive ? "rgba(99,102,241,0.05)" : selectedFile ? "rgba(34,197,94,0.04)" : "rgba(0,0,0,0.02)",
              cursor: "pointer", transition: "all 0.2s",
              display: "flex", flexDirection: "column", alignItems: "center", gap: 12,
            }}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept=".pdf,.png,.jpg,.jpeg,.webp"
              style={{ display: "none" }}
              onChange={e => e.target.files?.[0] && handleFile(e.target.files[0])}
            />

            {selectedFile ? (
              <>
                <div style={{
                  width: 48, height: 48, borderRadius: "50%",
                  background: "rgba(34,197,94,0.15)", border: "2px solid rgba(34,197,94,0.3)",
                  display: "flex", alignItems: "center", justifyContent: "center",
                }}>
                  <CheckCircle size={22} color="#22C55E" />
                </div>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 600, color: "#0F172A" }}>{selectedFile.name}</div>
                  <div style={{ fontSize: 12, color: "#64748B", marginTop: 4 }}>
                    {(selectedFile.size / 1024).toFixed(0)} KB · Click to change
                  </div>
                </div>
                <button
                  onClick={e => { e.stopPropagation(); setSelectedFile(null); }}
                  style={{
                    fontSize: 11, color: "#EF4444", background: "none", border: "none",
                    cursor: "pointer", display: "flex", alignItems: "center", gap: 4,
                  }}
                >
                  <X size={11} /> Remove
                </button>
              </>
            ) : (
              <>
                <div style={{
                  width: 52, height: 52, borderRadius: "50%",
                  background: "rgba(99,102,241,0.1)", border: "2px solid rgba(99,102,241,0.2)",
                  display: "flex", alignItems: "center", justifyContent: "center",
                }}>
                  <FileText size={22} color="#818CF8" />
                </div>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 600, color: "#0F172A" }}>
                    Upload vehicle history documents
                  </div>
                  <div style={{ fontSize: 12, color: "#64748B", marginTop: 4 }}>
                    CARFAX, AutoCheck, dealer records, receipts, or photos of paper documents
                  </div>
                </div>
                <div style={{ fontSize: 11, color: "#64748B" }}>PDF · PNG · JPG · WEBP · max 20 MB</div>
              </>
            )}
          </div>
        )}

        {/* MANUAL mode */}
        {mode === "manual" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            {/* Vehicle identity */}
            <div style={{
              background: "rgba(0,0,0,0.03)", border: "1px solid rgba(0,0,0,0.05)",
              borderRadius: 12, padding: "16px",
              display: "flex", flexDirection: "column", gap: 12,
            }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: "#64748B", textTransform: "uppercase", letterSpacing: "0.06em" }}>
                Vehicle
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                <div>
                  <label style={{ fontSize: 11, color: "#475569", display: "block", marginBottom: 4 }}>VIN (optional)</label>
                  <input
                    value={vin}
                    onChange={e => setVin(e.target.value.toUpperCase())}
                    placeholder="17-character VIN"
                    maxLength={17}
                    style={inputStyle}
                    onFocus={e => (e.target.style.borderColor = "rgba(99,102,241,0.4)")}
                    onBlur={e => (e.target.style.borderColor = "rgba(0,0,0,0.10)")}
                  />
                </div>
                <div>
                  <label style={{ fontSize: 11, color: "#475569", display: "block", marginBottom: 4 }}>Current Mileage</label>
                  <input
                    value={mileage}
                    onChange={e => setMileage(e.target.value.replace(/\D/g, ""))}
                    placeholder="e.g. 72000"
                    style={inputStyle}
                    onFocus={e => (e.target.style.borderColor = "rgba(99,102,241,0.4)")}
                    onBlur={e => (e.target.style.borderColor = "rgba(0,0,0,0.10)")}
                  />
                </div>
              </div>
            </div>

            {/* Service entries */}
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: "#64748B", textTransform: "uppercase", letterSpacing: "0.06em" }}>
                Service History Entries
              </div>

              {manualEntries.map((entry, idx) => (
                <div key={entry.id} style={{
                  background: "rgba(0,0,0,0.02)", border: "1px solid rgba(0,0,0,0.05)",
                  borderRadius: 10, padding: 12, display: "flex", flexDirection: "column", gap: 8,
                }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <span style={{ fontSize: 11, color: "#64748B" }}>Entry {idx + 1}</span>
                    {manualEntries.length > 1 && (
                      <button onClick={() => removeEntry(entry.id)} style={{
                        background: "none", border: "none", cursor: "pointer", color: "#374151", padding: 2,
                      }}><Trash2 size={12} /></button>
                    )}
                  </div>

                  <input
                    value={entry.description}
                    onChange={e => updateEntry(entry.id, "description", e.target.value)}
                    placeholder="e.g. Oil and filter changed, Transmission fluid service"
                    style={{ ...inputStyle, width: "100%" }}
                    onFocus={e => (e.target.style.borderColor = "rgba(99,102,241,0.4)")}
                    onBlur={e => (e.target.style.borderColor = "rgba(0,0,0,0.10)")}
                  />

                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                    <input
                      value={entry.date}
                      onChange={e => updateEntry(entry.id, "date", e.target.value)}
                      placeholder="Date (e.g. 2023-04-15)"
                      style={inputStyle}
                      onFocus={e => (e.target.style.borderColor = "rgba(99,102,241,0.4)")}
                      onBlur={e => (e.target.style.borderColor = "rgba(0,0,0,0.10)")}
                    />
                    <input
                      value={entry.mileage}
                      onChange={e => updateEntry(entry.id, "mileage", e.target.value)}
                      placeholder="Mileage (e.g. 45000)"
                      style={inputStyle}
                      onFocus={e => (e.target.style.borderColor = "rgba(99,102,241,0.4)")}
                      onBlur={e => (e.target.style.borderColor = "rgba(0,0,0,0.10)")}
                    />
                  </div>
                </div>
              ))}

              <button onClick={addEntry} style={{
                display: "flex", alignItems: "center", gap: 6, fontSize: 12,
                color: "#6366F1", background: "rgba(99,102,241,0.06)",
                border: "1px dashed rgba(99,102,241,0.2)", borderRadius: 8,
                padding: "8px 14px", cursor: "pointer", transition: "all 0.15s",
              }}>
                <Plus size={12} /> Add another entry
              </button>
            </div>
          </div>
        )}

        {/* Error message */}
        {(stage === "error" || errorMsg) && (
          <div style={{
            display: "flex", alignItems: "flex-start", gap: 8,
            background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.2)",
            borderRadius: 10, padding: "10px 14px", fontSize: 13, color: "#FCA5A5",
          }}>
            <AlertCircle size={14} style={{ flexShrink: 0, marginTop: 1 }} />
            {errorMsg || "Something went wrong. Please try again."}
          </div>
        )}

        {/* Submit button */}
        <button
          onClick={submit}
          style={{
            display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
            background: "linear-gradient(135deg, #6366F1, #8B5CF6)",
            border: "none", borderRadius: 12, padding: "14px 24px",
            fontSize: 14, fontWeight: 600, color: "white", cursor: "pointer",
            boxShadow: "0 4px 24px rgba(99,102,241,0.3)",
            transition: "all 0.2s",
          }}
          onMouseEnter={e => { e.currentTarget.style.transform = "translateY(-1px)"; e.currentTarget.style.boxShadow = "0 6px 30px rgba(99,102,241,0.4)"; }}
          onMouseLeave={e => { e.currentTarget.style.transform = "none"; e.currentTarget.style.boxShadow = "0 4px 24px rgba(99,102,241,0.3)"; }}
        >
          Analyze Vehicle History
          <ChevronRight size={15} />
        </button>

        {/* Footer note */}
        <div style={{ display: "flex", flexDirection: "column", gap: 4, alignItems: "center" }}>
          <p style={{ fontSize: 11, color: "#64748B", textAlign: "center", margin: 0 }}>
            Works with any source — CARFAX, AutoCheck, dealer records, receipts, or screenshots
          </p>
          <p style={{ fontSize: 10, color: "#475569", textAlign: "center", margin: 0 }}>
            WrenchCheck is not affiliated with CARFAX, AutoCheck, or any data provider.
          </p>
        </div>
      </main>

      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');
        * { box-sizing: border-box; }
        textarea::placeholder, input::placeholder { color: #6B7280; }
        ::-webkit-scrollbar { width: 4px; }
        ::-webkit-scrollbar-thumb { background: rgba(0,0,0,0.06); border-radius: 4px; }
      `}</style>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  background: "rgba(0,0,0,0.03)",
  border: "1px solid rgba(0,0,0,0.10)",
  borderRadius: 8,
  padding: "8px 12px",
  fontSize: 13,
  color: "#0F172A",
  outline: "none",
  transition: "border-color 0.15s",
  fontFamily: "'Inter', -apple-system, sans-serif",
};
