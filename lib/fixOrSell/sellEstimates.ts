// lib/fixOrSell/sellEstimates.ts
// Hardcoded sell price estimates by channel.
// V5: Problem-aware — all channels now account for the vehicle's current condition.
//
// KEY FIX: Previous versions calculated sell prices based on "running" retail value.
// Now we separate "if you fix first" prices from "as-is with problem" prices.
// A 1994 LC with broken transmission is NOT worth $18k trade-in.

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
  /** Explicitly: these are as-is values WITH the current problem */
  disclaimer: string;
}

function round100(n: number): number {
  return Math.round(n / 100) * 100;
}

// ── Channel definitions ──────────────────────────────────────────────────────
// Multipliers are applied to PRIVATE PARTY VALUE of a RUNNING vehicle.
// Then we apply a problem discount based on repair cost.

interface ChannelDef {
  id: string;
  label: string;
  emoji: string;
  /** Multiplier vs. private-party value of running vehicle */
  multLow: number;
  multHigh: number;
  /** How much of the repair cost does the buyer discount? (0-1) */
  problemDiscountPct: number;
  timeframe: string;
  effort: 'low' | 'medium' | 'high';
  noteRunning: string;
  noteAsIs: string;
}

const CHANNELS: ChannelDef[] = [
  {
    id: "private_party",
    label: "FB Marketplace / Craigslist",
    emoji: "📱",
    multLow: 0.92,
    multHigh: 1.0,
    problemDiscountPct: 1.2, // Buyers discount MORE than repair cost (risk premium)
    timeframe: "1–4 weeks",
    effort: "high",
    noteRunning: "Best price for a running vehicle, but expect lowballers.",
    noteAsIs: "Selling with a known problem — buyers will negotiate hard. Disclose everything.",
  },
  {
    id: "instant_offer",
    label: "CarMax / Carvana",
    emoji: "🏪",
    multLow: 0.78,
    multHigh: 0.85,
    problemDiscountPct: 1.5, // Institutional buyers discount heavily
    timeframe: "1–3 days",
    effort: "low",
    noteRunning: "Quick, no-hassle offer. Expect 15-20% below private party.",
    noteAsIs: "If they'll take it — instant offers on problem vehicles are very low.",
  },
  {
    id: "trade_in",
    label: "Dealer Trade-In",
    emoji: "🤝",
    multLow: 0.68,
    multHigh: 0.78,
    problemDiscountPct: 1.5, // Dealers discount at wholesale + repair cost + margin
    timeframe: "Same day",
    effort: "low",
    noteRunning: "Convenient if buying another car. Lowest price but simplest.",
    noteAsIs: "Dealers deduct full repair cost plus margin. Expect the lowest offer.",
  },
];

export function computeSellEstimates(
  privatePartyValue: number,
  repairCost: number,
  archetypeResult?: ArchetypeResult,
): SellEstimates {
  const excluded = archetypeResult?.excludedChannels || [];

  const estimates: SellEstimate[] = CHANNELS.map(ch => {
    const available = !excluded.includes(ch.id);

    // Value if running × channel multiplier − problem discount
    const runningLow = round100(privatePartyValue * ch.multLow);
    const runningHigh = round100(privatePartyValue * ch.multHigh);
    const discount = round100(repairCost * ch.problemDiscountPct);

    const low = Math.max(round100(runningLow - discount), 500);
    const high = Math.max(round100(runningHigh - discount), round100(low * 1.1));
    const mid = round100((low + high) / 2);

    let note = repairCost > 0 ? ch.noteAsIs : ch.noteRunning;
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

  // Add specialty channels from archetype (enthusiast auctions)
  if (archetypeResult?.specialtyChannels?.length) {
    for (const sp of archetypeResult.specialtyChannels) {
      // Enthusiast buyers discount less — they know the value of the platform
      const discount = round100(repairCost * 0.8);
      const low = Math.max(round100(privatePartyValue * 0.88 - discount), 1000);
      const high = Math.max(round100(privatePartyValue * 1.0 - discount), round100(low * 1.1));
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
        note: repairCost > 0
          ? `${sp.note} Enthusiast buyers discount less for known mechanical issues.`
          : sp.note,
        available: true,
      });
    }
  }

  // Best channel = highest available mid
  const available = estimates.filter(e => e.available);
  const sorted = [...available].sort((a, b) => b.mid - a.mid);

  const disclaimer = repairCost > 0
    ? `These are estimated as-is values — what you'd get selling WITH the current problem. Buyers will factor in the ~$${repairCost.toLocaleString()} repair.`
    : `These are estimated values for a vehicle in current condition.`;

  return {
    estimates,
    bestChannel: sorted[0]?.channel || 'private_party',
    bestMid: sorted[0]?.mid || 0,
    disclaimer,
  };
}
