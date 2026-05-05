"use client";
import { useRouter } from "next/navigation";

export default function HomePage() {
  const router = useRouter();
  const BRAND = "#00236F";

  return (
    <div style={{
      minHeight: "100vh",
      background: "linear-gradient(170deg, #0F172A 0%, #1E293B 45%, #0F172A 100%)",
      fontFamily: "'Inter', system-ui, sans-serif",
      display: "flex", flexDirection: "column", alignItems: "center",
      padding: "60px 20px 80px",
    }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap');
        * { box-sizing: border-box; }
        .hero-btn { transition: all 0.2s ease; cursor: pointer; }
        .hero-btn:hover { transform: translateY(-2px); box-shadow: 0 12px 40px rgba(0,35,111,0.4) !important; }
        .tool-card { transition: transform 0.2s ease, box-shadow 0.2s ease; cursor: pointer; }
        .tool-card:hover { transform: translateY(-3px); box-shadow: 0 16px 48px rgba(0,0,0,0.3) !important; }
      `}</style>

      {/* Header */}
      <div style={{ textAlign: "center", marginBottom: 48, maxWidth: 600 }}>
        <div style={{
          display: "inline-block", padding: "5px 14px",
          background: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.12)",
          borderRadius: 99, color: "#94A3B8", fontWeight: 700, fontSize: 11,
          letterSpacing: "0.12em", marginBottom: 20,
        }}>
          WRENCHCHECK
        </div>
        <h1 style={{
          fontSize: "clamp(32px, 6vw, 52px)", fontWeight: 900, color: "#F8FAFC",
          margin: "0 0 16px", letterSpacing: "-0.04em", lineHeight: 1.05,
        }}>
          Before you spend<br />on your car —<br /><span style={{ color: "#60A5FA" }}>we'll tell you what to do.</span>
        </h1>
        <p style={{ fontSize: 17, color: "#94A3B8", lineHeight: 1.6, margin: 0 }}>
          Got a repair quote? Drop it in. We'll analyze every line, check your car's value, and give you a clear answer: fix it or sell it.
        </p>
      </div>

      {/* Hero CTA */}
      <button
        className="hero-btn"
        onClick={() => router.push("/fix-or-sell")}
        style={{
          padding: "18px 48px",
          background: "linear-gradient(135deg, #00236F, #1E40AF)",
          color: "#fff",
          border: "none",
          borderRadius: 16,
          fontSize: 16,
          fontWeight: 800,
          letterSpacing: "-0.01em",
          boxShadow: "0 8px 32px rgba(0,35,111,0.3)",
          marginBottom: 56,
        }}
      >
        ⚡ Analyze My Repair Quote
      </button>

      {/* Secondary tools */}
      <p style={{ fontSize: 11, fontWeight: 700, color: "#475569", letterSpacing: "0.15em", textTransform: "uppercase", marginBottom: 16 }}>
        More tools
      </p>
      <div style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
        gap: 16, width: "100%", maxWidth: 680,
      }}>
        {[
          { href: "/audit/new", icon: "🔧", title: "Service Invoice Audit", desc: "Upload any shop estimate — we'll tell you if prices are fair and what to negotiate." },
          { href: "/maintenance", icon: "📋", title: "Maintenance Tracker", desc: "Track your car's service history and see what's coming due." },
        ].map(tool => (
          <div
            key={tool.href}
            className="tool-card"
            onClick={() => router.push(tool.href)}
            style={{
              background: "rgba(255,255,255,0.06)",
              borderRadius: 16, padding: 20,
              border: "1px solid rgba(255,255,255,0.08)",
              boxShadow: "0 4px 16px rgba(0,0,0,0.15)",
            }}
          >
            <div style={{ fontSize: 24, marginBottom: 8 }}>{tool.icon}</div>
            <div style={{ fontSize: 15, fontWeight: 800, color: "#F1F5F9", marginBottom: 4 }}>{tool.title}</div>
            <div style={{ fontSize: 12, color: "#64748B", lineHeight: 1.5 }}>{tool.desc}</div>
          </div>
        ))}
      </div>

      <div style={{ marginTop: 56, fontSize: 12, color: "#475569", textAlign: "center" }}>
        Built for car owners who want straight answers.
      </div>
    </div>
  );
}
