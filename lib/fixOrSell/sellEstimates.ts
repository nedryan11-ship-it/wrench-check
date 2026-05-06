// lib/fixOrSell/sellEstimates.ts
// Hardcoded sell price estimates by channel.
// V4: Archetype-aware — channels excluded/added based on vehicle type.
//
// Sources:
//   CarMax/Carvana instant offers typically 75-82% of dealer retail
//   Private party (FB/Craigslist) typically 85-92% of retail
//   Trade-in typically 68-78% of retail
//   As-is (with known problems) typically 60-70% of retail

import type { ArchetypeResult } from './vehicleArchetypes';

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
  available: boolean;
}

export interface SellEstimates {
  estimates: SellEstimate[];
  bestChannel: string;
  bestMid: number;
}

function round100(n: number): number {
  return Math.round(n / 100) * 100;
}

interface ChannelDef {
  id: string;
  label: string;
  emoji: string;
  multLow: number;
  multHigh: number;
  timeframe: string;
  effort: 'low' | 'medium' | 'high';
  note: string;
}

const BASE_CHANNELS: ChannelDef[] = [
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

export function computeSellEstimates(
  dealerRetailValue: number,
  archetypeResult?: ArchetypeResult,
): SellEstimates {
  const excluded = archetypeResult?.excludedChannels || [];

  const estimates: SellEstimate[] = BASE_CHANNELS.map(ch => {
    const available = !excluded.includes(ch.id);
    const low = round100(dealerRetailValue * ch.multLow);
    const high = round100(dealerRetailValue * ch.multHigh);
    const mid = round100((low + high) / 2);

    let note = ch.note;
    if (!available && ch.id === 'instant_offer') {
      note = "CarMax/Carvana generally don't buy vehicles this old or in this category.";
    }

    return {
      channel: ch.id,
      label: ch.label,
      emoji: ch.emoji,
      low,
      high,
      mid,
      timeframe: ch.timeframe,
      effort: ch.effort,
      note,
      available,
    };
  });

  // Add specialty channels from archetype
  if (archetypeResult?.specialtyChannels?.length) {
    for (const sp of archetypeResult.specialtyChannels) {
      // Enthusiast auctions typically get 90-105% of retail
      const low = round100(dealerRetailValue * 0.90);
      const high = round100(dealerRetailValue * 1.05);
      const mid = round100((low + high) / 2);
      estimates.push({
        channel: `specialty_${estimates.length}`,
        label: sp.label,
        emoji: sp.emoji,
        low,
        high,
        mid,
        timeframe: "1–3 weeks",
        effort: "high",
        note: sp.note,
        available: true,
      });
    }
  }

  // Best channel = highest available mid
  const available = estimates.filter(e => e.available);
  const sorted = [...available].sort((a, b) => b.mid - a.mid);
  return {
    estimates,
    bestChannel: sorted[0]?.channel || 'private_party',
    bestMid: sorted[0]?.mid || 0,
  };
}
