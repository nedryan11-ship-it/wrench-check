// ─── WrenchCheck Comparison Types ──────────────────────────────────────────

import type { PhotoConditionReport } from "./analyzePhotos";
export type { PhotoConditionReport };
import type { MarketComps } from "@/lib/vehicleDatabases/marketComps";
export type { MarketComps };

export type FrictionTier = "low" | "medium" | "high";
export type RiskLevel = "low" | "medium" | "high";
export type ReliabilityTier = "excellent" | "good" | "below_average" | "poor";

/** One car's full input bundle — whatever the user provided */
export type CarBundle = {
  label: string;
  askingPrice: number | null;
  pdfFiles: File[];
  photoFiles: File[];   // capped at 7
  url: string | null;
  notes: string;
};

export type ComparedCar = {
  // Identity
  vehicleName: string;       // "2024 Jeep Grand Cherokee 4XE"
  vin?: string | null;
  mileage?: number | null;
  fileIndex: number;         // position in upload order

  // Ranking
  rank: number;              // 1 = best overall
  rankReason: string;        // one sentence

  // Pricing
  askingPrice: number | null;
  marketLow: number;
  marketHigh: number;
  marketMid: number;
  priceGapDollars: number;   // positive = overpriced vs market mid, negative = under
  priceGapLabel: string;     // "~$1.5k below market" or "~$2k above market"

  // Ownership cost
  tcoYear1Low: number;
  tcoYear1High: number;
  tcoYear3Low: number;
  tcoYear3High: number;
  avgAnnualCost: number | null;

  // Ownership profile
  frictionTier: FrictionTier;
  frictionNote: string;        // "Predictable, routine ownership"
  downtimeEvents: string;      // "0–1 unplanned events/yr"
  reliabilityTier: ReliabilityTier | null;

  // Risk
  majorRisk: string | null;   // "AIRMATIC failure ($2–4k)"
  riskLevel: RiskLevel;

  // Optimal hold
  optimalSellMileage: number | null;
  optimalSellNote: string | null; // "Sell by 90k to avoid suspension cycle"

  // Photo analysis
  photoConditionReport: PhotoConditionReport | null;
  photoCount: number;

  // From existing audit
  verdict: string;
  maintenanceDebt: number;    // confirmed overdue cost
  overdueCount: number;

  // Listing context
  listingUrl: string | null;
  listingNotes: string | null;
  location?: string | null;      // scraped from listing (e.g. "Phoenix, AZ")
  isSaltBelt?: boolean;          // true if location is a high-salt-use state
  marketComps?: MarketComps | null; // live retail market pricing (Cars.com)
};

export type ComparisonResult = {
  // Meta
  sessionId: string;
  createdAt: string;

  // AI synthesis
  headline: string;           // "The real tradeoff: ..."
  winner: string;             // vehicle name
  winnerReason: string;       // one sentence, specific
  tcoComparison: string;      // "Over 3 years, X costs $4,200 less than Y"
  bottomLine: string;         // decisive final recommendation

  // Mode flags
  isSameCar: boolean;         // all cars are same make/model/year → listing-level diff
  crossCarFeatureDiff?: string | null;  // e.g. "2019 adds power tailgate; 2016 has none"

  // Per-car ranked results
  cars: ComparedCar[];

  // Raw audit summaries for deep-dive links
  auditSummaries: {
    vehicleName: string;
    auditKey: string;         // localStorage key for the individual audit
    verdict: string;
    auditResult?: any;
  }[];
};
