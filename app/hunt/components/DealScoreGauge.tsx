"use client";

// DealScoreGauge — Compact circular gauge showing the consolidated deal score
// Renders a tiny SVG arc gauge with the score number in the center
// Color: green (75+), indigo (50-74), amber (25-49), red (0-24)

interface DealScoreGaugeProps {
  score: number;     // 0-100
  size?: number;     // pixel diameter (default 44)
  showLabel?: boolean; // show "DEAL" label below score
}

export default function DealScoreGauge({ score, size = 44, showLabel = true }: DealScoreGaugeProps) {
  const r = (size - 6) / 2; // radius with stroke padding
  const cx = size / 2;
  const cy = size / 2;
  const circumference = 2 * Math.PI * r;
  const pct = Math.min(score, 100) / 100;
  const dashOffset = circumference * (1 - pct * 0.75); // 270° arc (75% of circle)

  // Color based on score
  const color = score >= 75 ? '#16A34A' : score >= 50 ? '#4F46E5' : score >= 25 ? '#D97706' : '#DC2626';
  const bgColor = score >= 75 ? '#DCFCE7' : score >= 50 ? '#EEF2FF' : score >= 25 ? '#FEF3C7' : '#FEE2E2';
  const trackColor = score >= 75 ? '#BBF7D0' : score >= 50 ? '#C7D2FE' : score >= 25 ? '#FDE68A' : '#FECACA';

  return (
    <div style={{ position: 'relative', width: size, height: size, flexShrink: 0 }}>
      <svg width={size} height={size} style={{ transform: 'rotate(-225deg)' }}>
        {/* Track */}
        <circle
          cx={cx} cy={cy} r={r}
          fill="none"
          stroke={trackColor}
          strokeWidth={3}
          strokeDasharray={`${circumference * 0.75} ${circumference * 0.25}`}
          strokeLinecap="round"
          opacity={0.5}
        />
        {/* Score arc */}
        <circle
          cx={cx} cy={cy} r={r}
          fill="none"
          stroke={color}
          strokeWidth={3}
          strokeDasharray={`${circumference * 0.75 * pct} ${circumference}`}
          strokeLinecap="round"
          style={{ transition: 'stroke-dasharray 0.4s ease' }}
        />
      </svg>
      {/* Center text */}
      <div style={{
        position: 'absolute', top: 0, left: 0, width: '100%', height: '100%',
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        gap: 0,
      }}>
        <div style={{ fontSize: size * 0.32, fontWeight: 900, color, lineHeight: 1 }}>{score}</div>
        {showLabel && (
          <div style={{ fontSize: size * 0.16, fontWeight: 700, color: '#94A3B8', letterSpacing: '0.05em', lineHeight: 1, marginTop: 1 }}>DEAL</div>
        )}
      </div>
    </div>
  );
}
