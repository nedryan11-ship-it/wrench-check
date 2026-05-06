// lib/fixOrSell/sellEstimates.ts
// Hardcoded sell price estimates by channel.
// V3: Year-aware — older/classic vehicles can't use CarMax/Carvana.
//
// Sources:
//   CarMax/Carvana instant offers typically 75-82% of dealer retail
//   Private party (FB/Craigslist) typically 85-92% of retail
//   Trade-in typically 68-78% of retail
//   As-is (with known problems) typically 60-70% of retail

export interface SellEstimate {
  channel: string;
  label: string;
  emoji: string;
  low: number;
  high: number;
  mid: number;
  timeframe: string;
  effort: 'low' | 'medium' | 'high';
  note: string;
  available: boolean; // false if channel doesn't apply
}

export interface SellEstimates {
  estimates: SellEstimate[];
  bestChannel: string;
  bestMid: number;
}

// Round to nearest $100 for cleaner display
function round100(n: number): number {
  return Math.round(n / 100) * 100;
}

// CarMax/Carvana generally won't buy cars older than ~20 years
const INSTANT_OFFER_MAX_AGE = 20;

export function computeSellEstimates(
  dealerRetailValue: number,
  vehicleYear?: number,
): SellEstimates {
  const currentYear = new Date().getFullYear();
  const vehicleAge = vehicleYear ? currentYear - vehicleYear : 0;
  const isTooOldForInstant = vehicleAge > INSTANT_OFFER_MAX_AGE;

  const channels: {
    id: string;
    label: string;
    emoji: string;
    multLow: number;
    multHigh: number;
    timeframe: string;
    effort: 'low' | 'medium' | 'high';
    note: string;
    available: boolean;
  }[] = [
    {
      id: "instant_offer",
      label: "CarMax / Carvana",
      emoji: "🏪",
      multLow: 0.75,
      multHigh: 0.82,
      timeframe: "1–3 days",
      effort: "low",
      note: isTooOldForInstant
        ? `CarMax/Carvana generally don't buy vehicles over ${INSTANT_OFFER_MAX_AGE} years old.`
        : "Drive in, get a check. No haggling, no tire-kickers.",
      available: !isTooOldForInstant,
    },
    {
      id: "private_party",
      label: "FB Marketplace / Craigslist",
      emoji: "📱",
      multLow: 0.85,
      multHigh: 0.93,
      timeframe: "1–4 weeks",
      effort: "high",
      note: "Best price, but you'll deal with lowballers and no-shows.",
      available: true,
    },
    {
      id: "trade_in",
      label: "Dealer Trade-In",
      emoji: "🤝",
      multLow: 0.68,
      multHigh: 0.78,
      timeframe: "Same day",
      effort: "low",
      note: "Convenient if buying another car. Lowest price but simplest.",
      available: true,
    },
    {
      id: "as_is",
      label: "Sell As-Is (with problem)",
      emoji: "⚠️",
      multLow: 0.58,
      multHigh: 0.68,
      timeframe: "3–7 days",
      effort: "medium",
      note: "Skip the repair, disclose the issue, sell at a discount.",
      available: true,
    },
  ];

  const estimates: SellEstimate[] = channels.map(ch => {
    const low = round100(dealerRetailValue * ch.multLow);
    const high = round100(dealerRetailValue * ch.multHigh);
    const mid = round100((low + high) / 2);
    return {
      channel: ch.id,
      label: ch.label,
      emoji: ch.emoji,
      low,
      high,
      mid,
      timeframe: ch.timeframe,
      effort: ch.effort,
      note: ch.note,
      available: ch.available,
    };
  });

  // Best channel = highest available mid
  const available = estimates.filter(e => e.available);
  const sorted = [...available].sort((a, b) => b.mid - a.mid);
  return {
    estimates,
    bestChannel: sorted[0]?.channel || 'private_party',
    bestMid: sorted[0]?.mid || 0,
  };
}
