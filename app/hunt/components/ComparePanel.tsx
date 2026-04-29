"use client";

// ComparePanel — Side-by-side comparison of 2-3 selected vehicles
// Shown as a slide-over panel at the bottom of the board

interface Vehicle {
  id: string;
  year: number;
  make: string;
  model: string;
  trim?: string;
  price?: number;
  mileage?: number;
  location?: string;
  market_mid?: number;
  score?: number;
  tier?: string;
  has_accident?: boolean;
  owner_count?: number;
  photo_intel?: any;
  price_history?: { price: number; date: string }[];
  days_on_market?: number;
  gem_price_target?: number;
  confidence_pct?: number;
}

interface ComparePanelProps {
  vehicles: Vehicle[];
  onClose: () => void;
  onAskAdvisor: (msg: string) => void;
  fmt$: (n: number) => string;
  liveScore: (v: any) => number;
}

function bestInRow(values: (number | null)[], lowerIsBetter: boolean = false): number {
  let bestIdx = -1;
  let bestVal: number | null = null;
  values.forEach((v, i) => {
    if (v === null) return;
    if (bestVal === null || (lowerIsBetter ? v < bestVal : v > bestVal)) {
      bestVal = v;
      bestIdx = i;
    }
  });
  return bestIdx;
}

export default function ComparePanel({ vehicles, onClose, onAskAdvisor, fmt$, liveScore }: ComparePanelProps) {
  if (vehicles.length < 2) return null;

  const cols = vehicles.slice(0, 3);
  const colWidth = `${Math.floor(100 / cols.length)}%`;

  // Compute comparison data
  const scores = cols.map(v => liveScore(v));
  const prices = cols.map(v => v.price ?? null);
  const mileages = cols.map(v => v.mileage ?? null);
  const marketDeltas = cols.map(v => (v.market_mid && v.price) ? v.market_mid - v.price : null);
  const daysOnMarket = cols.map(v => v.days_on_market ?? null);

  type Row = { 
    label: string; 
    values: (string | null)[]; 
    bestIdx: number; 
    icon?: string;
    sublabel?: string;
  };

  const rows: Row[] = [
    {
      label: 'Deal Score',
      icon: '🎯',
      values: scores.map(s => `${s}/100`),
      bestIdx: bestInRow(scores),
    },
    {
      label: 'Price',
      icon: '💰',
      values: prices.map(p => p ? fmt$(p) : '—'),
      bestIdx: bestInRow(prices, true),
    },
    {
      label: 'vs Market',
      icon: '📊',
      values: marketDeltas.map(d => d === null ? '—' : d > 0 ? `↓ ${fmt$(d)} below` : d < -500 ? `↑ ${fmt$(Math.abs(d))} above` : '≈ At market'),
      bestIdx: bestInRow(marketDeltas),
    },
    {
      label: 'Mileage',
      icon: '🛣',
      values: mileages.map(m => m ? `${m.toLocaleString()} mi` : '—'),
      bestIdx: bestInRow(mileages, true),
    },
    {
      label: 'Ownership',
      icon: '👤',
      values: cols.map(v => {
        const parts: string[] = [];
        if (v.owner_count) parts.push(`${v.owner_count}-owner`);
        if (v.has_accident === true) parts.push('⚠️ Accident');
        else if (v.has_accident === false) parts.push('Clean title');
        return parts.length > 0 ? parts.join(' · ') : '—';
      }),
      bestIdx: bestInRow(cols.map(v => {
        let s = 0;
        if (v.owner_count === 1) s += 2;
        if (v.has_accident === false) s += 2;
        if (v.has_accident === true) s -= 3;
        return s;
      })),
    },
    {
      label: 'Days Listed',
      icon: '📅',
      values: daysOnMarket.map(d => d ? `${d} days` : '—'),
      bestIdx: bestInRow(daysOnMarket, true),
      sublabel: 'Longer = more negotiation leverage',
    },
    {
      label: 'Gem Target',
      icon: '💎',
      values: cols.map(v => v.gem_price_target ? fmt$(v.gem_price_target) : scores[cols.indexOf(v)] >= 75 ? '✅ Already Gem' : '—'),
      bestIdx: -1,
    },
    {
      label: 'Photo Condition',
      icon: '📸',
      values: cols.map(v => {
        const pi = v.photo_intel;
        if (!pi?.condition) return '—';
        if (pi.condition === 'clean') return '✅ Clean';
        if (pi.condition === 'fair') return '⚠️ Fair';
        return '🔴 Flagged';
      }),
      bestIdx: bestInRow(cols.map(v => {
        const c = v.photo_intel?.condition;
        if (c === 'clean') return 3;
        if (c === 'fair') return 2;
        if (c === 'flag') return 1;
        return 0;
      })),
    },
  ];

  // Build advisor prompt
  const promptNames = cols.map(v => `${v.year} ${v.make} ${v.model}${v.trim ? ` ${v.trim}` : ''}`).join(', ');

  return (
    <div style={{
      position: 'fixed', bottom: 0, left: 0, right: 0,
      background: '#fff',
      borderTop: '3px solid #4F46E5',
      boxShadow: '0 -8px 40px rgba(0,0,0,0.15)',
      borderRadius: '20px 20px 0 0',
      zIndex: 1000,
      maxHeight: '75vh',
      overflowY: 'auto',
      animation: 'slideUp 0.3s ease',
    }}>
      <style>{`
        @keyframes slideUp {
          from { transform: translateY(100%); opacity: 0; }
          to { transform: translateY(0); opacity: 1; }
        }
      `}</style>

      {/* Header */}
      <div style={{
        position: 'sticky', top: 0, background: '#fff', zIndex: 1,
        padding: '16px 24px', borderBottom: '1px solid #E2E8F0',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      }}>
        <div>
          <div style={{ fontSize: 16, fontWeight: 900, color: '#1E293B' }}>⚔️ Side-by-Side Compare</div>
          <div style={{ fontSize: 12, color: '#64748B', marginTop: 2 }}>Best value per metric is highlighted</div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            onClick={() => onAskAdvisor(`Compare these vehicles and tell me which is the best buy: ${promptNames}. Consider price vs market, mileage, condition, and overall value.`)}
            style={{ padding: '8px 16px', borderRadius: 10, border: '1px solid #C7D2FE', background: '#EEF2FF', color: '#4F46E5', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}
          >🧠 Ask Advisor</button>
          <button
            onClick={onClose}
            style={{ padding: '8px 16px', borderRadius: 10, border: '1px solid #E2E8F0', background: '#F8FAFC', color: '#64748B', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}
          >✕ Close</button>
        </div>
      </div>

      {/* Vehicle headers */}
      <div style={{ display: 'flex', padding: '16px 24px 0', gap: 12 }}>
        <div style={{ width: 140, flexShrink: 0 }} /> {/* label column spacer */}
        {cols.map(v => {
          const photoUrl = v.photo_intel?.photoUrls?.[0];
          const score = liveScore(v);
          const scoreColor = score >= 75 ? '#16A34A' : score >= 50 ? '#4F46E5' : '#D97706';
          return (
            <div key={v.id} style={{ flex: 1, textAlign: 'center' }}>
              {/* Photo */}
              <div style={{
                width: 80, height: 56, borderRadius: 10, overflow: 'hidden',
                margin: '0 auto 8px', background: '#F1F5F9',
                border: '2px solid #E2E8F0',
              }}>
                {photoUrl ? (
                  <img src={photoUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                ) : (
                  <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 24, opacity: 0.3 }}>🚙</div>
                )}
              </div>
              {/* Name */}
              <div style={{ fontSize: 13, fontWeight: 800, color: '#1E293B', lineHeight: 1.2 }}>
                {v.year} {v.make} {v.model}
              </div>
              {v.trim && <div style={{ fontSize: 11, color: '#64748B', fontWeight: 600 }}>{v.trim}</div>}
              {/* Score badge */}
              <div style={{
                display: 'inline-block', marginTop: 6,
                padding: '3px 10px', borderRadius: 99,
                background: score >= 75 ? '#DCFCE7' : score >= 50 ? '#EEF2FF' : '#FEF3C7',
                border: `1px solid ${score >= 75 ? '#86EFAC' : score >= 50 ? '#C7D2FE' : '#FDE68A'}`,
                fontSize: 11, fontWeight: 900, color: scoreColor,
              }}>
                {score}/100
              </div>
            </div>
          );
        })}
      </div>

      {/* Comparison rows */}
      <div style={{ padding: '12px 24px 24px' }}>
        {rows.map((row, ri) => (
          <div key={ri} style={{
            display: 'flex', alignItems: 'center', gap: 12,
            padding: '10px 0',
            borderBottom: ri < rows.length - 1 ? '1px solid #F1F5F9' : 'none',
          }}>
            {/* Label */}
            <div style={{ width: 140, flexShrink: 0 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: '#475569' }}>
                {row.icon} {row.label}
              </div>
              {row.sublabel && <div style={{ fontSize: 9, color: '#94A3B8', marginTop: 1 }}>{row.sublabel}</div>}
            </div>
            {/* Values */}
            {row.values.map((val, ci) => (
              <div key={ci} style={{
                flex: 1, textAlign: 'center',
                fontSize: 13, fontWeight: ci === row.bestIdx ? 800 : 500,
                color: ci === row.bestIdx ? '#15803D' : '#334155',
                background: ci === row.bestIdx ? '#F0FDF4' : 'transparent',
                padding: '6px 8px', borderRadius: 8,
                transition: 'all 0.15s',
              }}>
                {val || '—'}
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
