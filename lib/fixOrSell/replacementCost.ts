// lib/fixOrSell/replacementCost.ts
// "If you sell, what does switching actually cost?"
// Computes the real cost of selling + buying a replacement.
//
// This is the killer insight most people miss:
//   You sell for $12k, buy a comparable car for $16k,
//   pay $1,500 in taxes/reg → switching cost = $5,500.
//   That's MORE than the $2,495 repair.

export interface ReplacementAnalysis {
  sellBestMid: number;            // what you'd get (best channel)
  replacementCost: number;        // what a comparable car costs
  switchingCost: number;          // replacement - sell + taxes/fees
  repairCost: number;             // the quote
  repairSaves: number;            // switching cost - repair cost (positive = repair is cheaper)
  verdict: 'repair_cheaper' | 'sell_cheaper' | 'roughly_equal';
  summary: string;
}

// Tax + registration + dealer fees for buying a replacement
const SWITCHING_OVERHEAD = 1500;

// A "comparable" replacement costs roughly the retail value of your current car
// (because you're buying the same thing, but someone else's)
// Actually it costs MORE because your car has the known problem deducted,
// but a clean replacement sells at full retail.
const REPLACEMENT_PREMIUM = 1.05; // 5% above your car's retail (you're a buyer now, not seller)

export function computeReplacementAnalysis(
  dealerRetailValue: number,
  sellBestMid: number,
  repairCost: number,
): ReplacementAnalysis {
  const replacementCost = Math.round(dealerRetailValue * REPLACEMENT_PREMIUM / 100) * 100;
  const switchingCost = replacementCost - sellBestMid + SWITCHING_OVERHEAD;

  const repairSaves = switchingCost - repairCost;

  let verdict: ReplacementAnalysis['verdict'];
  if (repairSaves > 500) verdict = 'repair_cheaper';
  else if (repairSaves < -500) verdict = 'sell_cheaper';
  else verdict = 'roughly_equal';

  let summary: string;
  if (verdict === 'repair_cheaper') {
    summary = `Repairing saves you ~$${repairSaves.toLocaleString()} compared to selling and buying a replacement. The math favors fixing.`;
  } else if (verdict === 'sell_cheaper') {
    summary = `Selling and replacing would cost ~$${Math.abs(repairSaves).toLocaleString()} less than repairing. The math favors selling.`;
  } else {
    summary = `Repairing and replacing cost about the same. Your decision should come down to how much you trust this specific car.`;
  }

  return {
    sellBestMid,
    replacementCost,
    switchingCost,
    repairCost,
    repairSaves,
    verdict,
    summary,
  };
}
