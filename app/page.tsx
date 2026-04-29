"use client";
import { useRouter } from "next/navigation";

const tools = [
  {
    id: "mechanic",
    href: "/audit/new",
    badge: "INSTANT AUDIT",
    badgeColor: "#4F46E5",
    badgeBg: "#EEF2FF",
    badgeBorder: "#C7D2FE",
    icon: "🔧",
    title: "Mechanic Report",
    tagline: "Is this car hiding something?",
    description: "Upload a Carfax, dealer service receipt, or paste VIN history. We flag overdue maintenance, known failure points, and what it'll actually cost you.",
    ctaLabel: "Run a free audit →",
    ctaStyle: { background: "#0F172A" },
  },
  {
    id: "maintenance",
    href: "/maintenance",
    badge: "TRACK YOUR CAR",
    badgeColor: "#15803D",
    badgeBg: "#F0FDF4",
    badgeBorder: "#86EFAC",
    icon: "📋",
    title: "Maintenance Tracker",
    tagline: "Stay ahead of your service schedule.",
    description: "Log your car's service history, get a live maintenance debt score, and never miss the services that matter before a big repair bill arrives.",
    ctaLabel: "Start tracking →",
    ctaStyle: { background: "#15803D" },
  },
  {
    id: "hunt",
    href: "/hunt",
    badge: "MULTI-CAR COMPARE",
    badgeColor: "#B45309",
    badgeBg: "#FFFBEB",
    badgeBorder: "#FDE68A",
    icon: "⚡",
    title: "The Gauntlet",
    tagline: "Find the gem in a sea of listings.",
    description: "Paste links to cars you're considering. We scrape them, audit each one, and rank by real value — price vs. fair market, mileage-adjusted, location risk included.",
    ctaLabel: "Start a new hunt →",
    ctaStyle: { background: "#B45309" },
  },
];

export default function HubPage() {
  const router = useRouter();

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
        .tool-card { transition: transform 0.2s ease, box-shadow 0.2s ease; cursor: pointer; }
        .tool-card:hover { transform: translateY(-4px); box-shadow: 0 24px 64px rgba(0,0,0,0.35) !important; }
        .cta-btn { transition: opacity 0.15s ease, transform 0.15s ease; }
        .cta-btn:hover { opacity: 0.9; transform: translateY(-1px); }
      `}</style>

      {/* Header */}
      <div style={{ textAlign: "center", marginBottom: 56, maxWidth: 560 }}>
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
          Every tool you need<br />to buy a used car right.
        </h1>
        <p style={{ fontSize: 17, color: "#94A3B8", lineHeight: 1.6, margin: 0 }}>
          Stop guessing. Know what you're buying before you sign anything.
        </p>
      </div>

      {/* Tool cards */}
      <div style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))",
        gap: 20,
        width: "100%",
        maxWidth: 1020,
      }}>
        {tools.map((tool) => (
          <div
            key={tool.id}
            className="tool-card"
            onClick={() => router.push(tool.href)}
            style={{
              background: "#FFFFFF",
              borderRadius: 20,
              padding: 28,
              border: "1px solid rgba(255,255,255,0.06)",
              boxShadow: "0 8px 32px rgba(0,0,0,0.2)",
              display: "flex",
              flexDirection: "column",
              gap: 14,
            }}
          >
            {/* Badge */}
            <div style={{
              display: "inline-flex", alignItems: "center", gap: 6,
              padding: "4px 10px",
              background: tool.badgeBg, border: `1px solid ${tool.badgeBorder}`,
              borderRadius: 99, alignSelf: "flex-start",
            }}>
              <span style={{ fontSize: 12 }}>{tool.icon}</span>
              <span style={{ fontSize: 10, fontWeight: 800, color: tool.badgeColor, letterSpacing: "0.08em" }}>
                {tool.badge}
              </span>
            </div>

            {/* Title + tagline */}
            <div>
              <div style={{ fontSize: 22, fontWeight: 900, color: "#0F172A", letterSpacing: "-0.02em", marginBottom: 4 }}>
                {tool.title}
              </div>
              <div style={{ fontSize: 14, fontWeight: 600, color: "#475569" }}>
                {tool.tagline}
              </div>
            </div>

            {/* Description */}
            <div style={{ fontSize: 13, color: "#64748B", lineHeight: 1.6 }}>
              {tool.description}
            </div>

            {/* CTA */}
            <button
              className="cta-btn"
              style={{
                marginTop: 4,
                padding: "12px 20px",
                border: "none",
                borderRadius: 10,
                color: "#FFF",
                fontSize: 13,
                fontWeight: 700,
                cursor: "pointer",
                textAlign: "left",
                ...tool.ctaStyle,
              }}
            >
              {tool.ctaLabel}
            </button>
          </div>
        ))}
      </div>

      {/* Footer */}
      <div style={{ marginTop: 56, fontSize: 12, color: "#475569", textAlign: "center" }}>
        Built for buyers who do their homework.
      </div>
    </div>
  );
}
