// lib/fixOrSell/sellEstimates.ts
// Hardcoded sell price estimates by channel.
// Multipliers based on industry data — NOT LLM generated.
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
}

export interface SellEstimates {
  estimates: SellEstimate[];
  bestChannel: string;
  bestMid: number;
}

const CHANNELS: {
  id: string;
  label: string;
  emoji: string;
  multLow: number;
  multHigh: number;
  timeframe: string;
  effort: 'low' | 'medium' | 'high';
  note: string;
}[] = [
  {
    id: "instant_offer",
    label: "CarMax / Carvana",
    emoji: "🏪",
    multLow: 0.75,
    multHigh: 0.82,
    timeframe: "1–3 days",
    effort: "low",
    note: "Drive in, get a check. No haggling, no tire-kickers.",
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
  },
];

// Round to nearest $100 for cleaner display
function round100(n: number): number {
  return Math.round(n / 100) * 100;
}

export function computeSellEstimates(
  dealerRetailValue: number,
): SellEstimates {
  const estimates: SellEstimate[] = CHANNELS.map(ch => {
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
    };
  });

  // Best channel = private party (highest mid)
  const sorted = [...estimates].sort((a, b) => b.mid - a.mid);
  return {
    estimates,
    bestChannel: sorted[0].channel,
    bestMid: sorted[0].mid,
  };
}
