/**
 * WrenchScore: 0–100 composite score measuring how good a car deal is.
 *
 * Three tiers:
 *   💎 Gem    (75–100) — Buy it
 *   👁 Watch  (50–74)  — Proceed with caution
 *   ❌ Pass   (0–49)   — Move on
 *
 * Four transparent components:
 *   Value     (0–30)  price vs live market
 *   Condition (0–25)  mileage, salt-belt, reliability tier
 *   Cost      (0–25)  TCO year-1, maintenance debt, platform risk
 *   Story     (0–20)  service history, owner count, location quality
 */

import type { ComparedCar } from "./types";

export type WrenchTier = "gem" | "watch" | "pass";

export type CarProfile = "new" | "mid" | "seasoned";

export interface WrenchScoreResult {
  score: number;            // 0–100
  potentialScore: number;   // what it scores if missing data is perfect
  tier: WrenchTier;
  tierLabel: string;        // "💎 Gem" | "👁 Watch" | "❌ Pass"
  tierDescription: string;  // one-liner
  contextualLabel: string;  // human-readable score label: "High Potential", "Needs Verification", etc.
  carProfile: CarProfile;   // "new" | "mid" | "seasoned" — drives scoring weights
  components: {
    value:     number;  // 0–30
    condition: number;  // 0–25
    cost:      number;  // 0–25
    story:     number;  // 0–20
  };
  reasons: string[];          // up to 3 bullet points explaining the score
  gemPriceTarget: number | null; // price at which this car becomes a Gem (null if already Gem or impossible)
  pointsToGem: number | null;    // how many points short of Gem threshold
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function scoreValue(car: any, auditResult?: any): { pts: number; reasons: string[] } {
  const reasons: string[] = [];
  const marketRef = car.marketComps?.priceMed ?? car.marketMid ?? 0;

  if (!car.askingPrice || marketRef === 0) {
    reasons.push("Price not available — value score is neutral");
    return { pts: 15, reasons };
  }

  const pctAbove = (car.askingPrice - marketRef) / marketRef;  // negative = below market

  let pts: number;
  if      (pctAbove <= -0.10) { pts = 30; reasons.push(`Priced ${fmt$(Math.round(-pctAbove * marketRef))} below market — exceptional value`); }
  else if (pctAbove <= -0.06) { pts = 26; reasons.push(`Priced ${fmt$(Math.round(-pctAbove * marketRef))} below market — strong value`); }
  else if (pctAbove <= -0.02) { pts = 22; reasons.push(`At or just below market — fair value`); }
  else if (pctAbove <=  0.02) { pts = 18; reasons.push(`Within 2% of market — pricing is fair`); }
  else if (pctAbove <=  0.07) { pts = 12; reasons.push(`Priced ${fmt$(Math.round(pctAbove * marketRef))} above market — negotiate down`); }
  else if (pctAbove <=  0.12) { pts = 7;  reasons.push(`Priced ${fmt$(Math.round(pctAbove * marketRef))} above market — significant premium`); }
  else                         { pts = 3;  reasons.push(`Priced ${fmt$(Math.round(pctAbove * marketRef))} above market — hard to justify`); }

  return { pts: clamp(pts, 0, 30), reasons };
}

function scoreCondition(car: any, auditResult?: any): { pts: number; reasons: string[] } {
  const reasons: string[] = [];
  let pts = 0;

  // Base from reliability tier
  const tier = (car.reliabilityTier ?? auditResult?.modelInsights?.reliabilityTier ?? null) as string | null;
  if      (tier === "excellent")    { pts += 15; reasons.push("Excellent reliability for make/model/year"); }
  else if (tier === "good")         { pts += 12; reasons.push("Good reliability history"); }
  else if (tier === "below_average"){ pts += 6;  reasons.push("Below-average reliability — increased risk"); }
  else if (tier === "poor")         { pts += 2;  reasons.push("Poor reliability tier — known platform issues"); }
  else                               { pts += 9;  } // neutral

  // Mileage for year
  const year    = auditResult?.vehicle?.year ?? null;
  const mileage = car.mileage ?? auditResult?.vehicle?.currentMileage ?? null;
  if (mileage && year) {
    const age = Math.max(1, 2026 - year);
    const miPerYear = mileage / age;
    if      (miPerYear < 7000)  { pts += 7; reasons.push(`Low mileage for age — ${Math.round(miPerYear / 1000)}k/yr avg`); }
    else if (miPerYear < 11000) { pts += 5; } // normal, no reason needed
    else if (miPerYear < 15000) { pts += 3; reasons.push(`Slightly high annual mileage — ${Math.round(miPerYear / 1000)}k/yr avg`); }
    else                         { pts += 0; reasons.push(`High mileage for year — ${Math.round(miPerYear / 1000)}k/yr avg`); }
  } else if (mileage) {
    pts += 3; // have mileage but not year
  }

  // Salt belt penalty
  if (car.isSaltBelt) {
    pts -= 4;
    // Add reason only if not already dominated by a worse signal
    reasons.push("Salt-belt state — elevated rust risk");
  } else if (car.location && !car.isSaltBelt) {
    pts += 3; // rust-free location bonus
  }

  // Hard odometer cap — no reliability rating overrides raw total miles
  if (mileage) {
    if      (mileage >= 200000) { pts -= 12; reasons.push(`${Math.round(mileage/1000)}k total miles — very high mileage risk`); }
    else if (mileage >= 150000) { pts -= 8;  reasons.push(`${Math.round(mileage/1000)}k total miles — elevated wear risk`); }
    else if (mileage >= 120000) { pts -= 4;  reasons.push(`${Math.round(mileage/1000)}k miles — factor into offer`); }
  }

  return { pts: clamp(pts, 0, 25), reasons };
}

function scoreCost(car: any, auditResult?: any): { pts: number; reasons: string[] } {
  const reasons: string[] = [];
  let pts = 0;

  // Maintenance debt
  const debt = car.maintenanceDebt ?? 0;
  if      (debt === 0)      { pts += 6; }
  else if (debt < 500)      { pts += 5; }
  else if (debt < 1500)     { pts += 3; reasons.push(`${fmt$(debt)} in overdue maintenance`); }
  else if (debt < 4000)     { pts += 1; reasons.push(`${fmt$(debt)} maintenance debt — factor into offer`); }
  else                       { pts += 0; reasons.push(`${fmt$(debt)} maintenance debt — significant`); }

  // Year-1 TCO
  const tcoHigh = car.tcoYear1High ?? 0;
  if      (tcoHigh === 0)    { pts += 10; } // unknown → neutral
  else if (tcoHigh < 5000)   { pts += 12; reasons.push(`Low year-1 ownership cost (est. ${fmt$(tcoHigh)} high)`); }
  else if (tcoHigh < 8000)   { pts += 9;  }
  else if (tcoHigh < 12000)  { pts += 6;  reasons.push(`Moderate year-1 cost — est. ${fmt$(tcoHigh)}`); }
  else                        { pts += 2;  reasons.push(`High year-1 ownership cost — est. up to ${fmt$(tcoHigh)}`); }

  // Controversy / platform risk (0 = safe, 10 = very risky)
  const ci = auditResult?.modelInsights?.controversyIndex ?? null;
  if (ci !== null) {
    if      (ci <= 2) { pts += 7; }
    else if (ci <= 4) { pts += 5; }
    else if (ci <= 6) { pts += 3; reasons.push(`Moderate platform risk index (${ci}/10)`); }
    else if (ci <= 8) { pts += 1; reasons.push(`High platform risk (${ci}/10) — known failure modes`); }
    else              { pts += 0; reasons.push(`Very high platform risk (${ci}/10) — significant concerns`); }
  } else {
    pts += 4; // neutral
  }

  return { pts: clamp(pts, 0, 25), reasons };
}

function getCarProfile(car: any, auditResult?: any): CarProfile {
  const year    = car.year ?? auditResult?.vehicle?.year ?? null;
  const mileage = car.mileage ?? auditResult?.vehicle?.currentMileage ?? null;
  const age     = year ? Math.max(0, 2026 - year) : null;

  if ((age !== null && age <= 3) || (mileage !== null && mileage <= 35000)) return "new";
  if ((age !== null && age <= 7) || (mileage !== null && mileage <= 80000)) return "mid";
  return "seasoned";
}

function scoreStory(car: any, auditResult?: any, profile?: CarProfile): { pts: number; reasons: string[] } {
  const reasons: string[] = [];
  let pts = 0;
  const carProfile = profile ?? getCarProfile(car, auditResult);

  // Service documentation — weight depends on car age/mileage
  const hasDocs = (car as any).hasServiceHistory ?? (auditResult?.auditKey ? true : false);
  const hasCarfax = Array.isArray(car.documents) && car.documents.some((d: any) => d.type === 'carfax' || d.type === 'autocheck');
  const hasHistory = hasDocs || hasCarfax;

  if (carProfile === "new") {
    // New cars: service docs barely matter — it's basically still under warranty
    if (hasHistory) { pts += 10; reasons.push("Service history on file"); }
    else            { pts += 8;  } // Neutral — don't punish new cars for no CARFAX
  } else if (carProfile === "mid") {
    if (hasHistory) { pts += 10; reasons.push("Service history documented"); }
    else            { pts += 4;  reasons.push("No service docs — history unclear"); }
  } else {
    // Seasoned: full weight — missing history is a real risk
    if (hasHistory) { pts += 10; reasons.push("Service history documented — key for this age"); }
    else            { pts += 0;  reasons.push("No service history — critical gap for this age"); }
  }

  // Owner count
  const ownerCount = car.owner_count ?? auditResult?.vehicle?.ownerCount ?? null;
  if      (ownerCount === 1)   { pts += 5; reasons.push("1-owner vehicle"); }
  else if (ownerCount === 2)   { pts += 3; }
  else if (ownerCount >= 3)    { pts += 1; reasons.push(`${ownerCount} owners`); }
  else                          { pts += 2; } // unknown

  // Location quality
  const loc = (car.location ?? "").toLowerCase();
  const SUNBELT = ["colorado", "arizona", "california", "nevada", "utah", "texas", "florida", "hawaii", "new mexico", "oregon", "washington"];
  const SALTBELT = ["ohio", "michigan", "illinois", "indiana", "pennsylvania", "new york", "new jersey", "massachusetts", "minnesota", "wisconsin", "connecticut", "maryland", "virginia", "maine"];
  if (SUNBELT.some(s => loc.includes(s))) { pts += 3; }
  else if (SALTBELT.some(s => loc.includes(s))) { pts += 0; }
  else if (loc) { pts += 2; }
  else { pts += 1; }

  // Accident history — hard penalty
  const hasAccident = car.hasAccident ?? auditResult?.vehicle?.hasAccident ?? null;
  if (hasAccident === true) {
    pts -= 12;
    reasons.push("Accident on CARFAX — significant deduction");
  } else if (hasAccident === false) {
    pts += 2; // clean history bonus
  }

  // Listing transparency
  if (car.listingUrl) pts += 1;
  if (car.listingNotes && car.listingNotes.length > 20) pts += 1;

  return { pts: clamp(pts, 0, 20), reasons };
}

// ── Gem price target ──────────────────────────────────────────────────────────

function gemPriceTarget(
  car: any,
  currentScore: number,
  valuePts: number,
  nonValueScore: number,
): number | null {
  const GEM_THRESHOLD = 75;
  if (currentScore >= GEM_THRESHOLD) return null; // already a Gem

  const neededValuePts = GEM_THRESHOLD - nonValueScore;
  if (neededValuePts > 30) return null; // can't reach Gem through price alone

  const marketRef = car.marketComps?.priceMed ?? car.marketMid ?? 0;
  if (marketRef === 0 || !car.askingPrice) return null;

  // Work backward: what price achieves neededValuePts?
  let targetPct: number;
  if      (neededValuePts <= 18) targetPct = 0.02;   // at market (+2%)
  else if (neededValuePts <= 22) targetPct = 0;       // at market exactly
  else if (neededValuePts <= 26) targetPct = -0.06;  // 6% below
  else                            targetPct = -0.10;  // 10% below

  const target = Math.round(marketRef * (1 + targetPct));
  if (target >= car.askingPrice) return null; // price is already good enough
  return target;
}

// ── Main export ───────────────────────────────────────────────────────────────

export function computeWrenchScore(
  car: ComparedCar,
  auditResult?: any,
): WrenchScoreResult {
  const carProfile = getCarProfile(car, auditResult);

  const { pts: vPts, reasons: vR } = scoreValue(car, auditResult);
  const { pts: cPts, reasons: cR } = scoreCondition(car, auditResult);
  const { pts: oPts, reasons: oR } = scoreCost(car, auditResult);
  const { pts: sPts, reasons: sR } = scoreStory(car, auditResult, carProfile);

  const score = clamp(vPts + cPts + oPts + sPts, 0, 100);
  const nonValueScore = cPts + oPts + sPts;

  // Potential score: what this car would score if missing verification is positive
  const hasDocs = Array.isArray(car.documents) && car.documents.some((d: any) =>
    d.type === 'carfax' || d.type === 'autocheck' || d.type === 'ppi');
  const hasCarfax = Array.isArray(car.documents) && car.documents.some((d: any) =>
    d.type === 'carfax' || d.type === 'autocheck');
  const hasPpi = Array.isArray(car.documents) && car.documents.some((d: any) => d.type === 'ppi');

  let potentialBonus = 0;
  if (carProfile === "seasoned" && !hasCarfax) potentialBonus += 10;
  if (carProfile === "seasoned" && !hasPpi)    potentialBonus += 8;
  if (carProfile === "mid"      && !hasCarfax) potentialBonus += 6;
  if (car.hasAccident === null || car.hasAccident === undefined) potentialBonus += 4;
  const potentialScore = clamp(score + potentialBonus, 0, 100);

  // Tier
  let tier: WrenchTier;
  let tierLabel: string;
  let tierDescription: string;
  if      (score >= 78) { tier = "gem";   tierLabel = "💎 Gem";   tierDescription = "Exceptional all-in value. Buy it."; }
  else if (score >= 50) { tier = "watch"; tierLabel = "👁 Watch"; tierDescription = "Solid option with specific risks. Negotiate hard."; }
  else                   { tier = "pass";  tierLabel = "❌ Pass";  tierDescription = "Multiple concerns converge. Move on."; }

  // Contextual label — what to show users instead of just the number
  let contextualLabel: string;
  if (score >= 78) {
    contextualLabel = "💎 Gem";
  } else if (potentialScore >= 78 && score < 65) {
    contextualLabel = carProfile === "new" ? "✨ Priced to Beat" : "🔍 High Potential";
  } else if (score >= 65) {
    contextualLabel = "💪 Strong Foundation";
  } else if (carProfile === "seasoned" && !hasDocs) {
    contextualLabel = "⚠️ Needs Verification";
  } else if (carProfile === "new") {
    contextualLabel = score >= 60 ? "✅ Looks Clean" : "📊 Check the Price";
  } else {
    contextualLabel = "👁 Watch";
  }

  // Top 3 reasons
  const allReasons = [...vR, ...cR, ...oR, ...sR].filter(Boolean).slice(0, 3);

  // Gem price target
  const gpt = gemPriceTarget(car, score, vPts, nonValueScore);
  const ptToGem = score < 75 ? 75 - score : null;

  return {
    score,
    potentialScore,
    tier,
    tierLabel,
    tierDescription,
    contextualLabel,
    carProfile,
    components: { value: vPts, condition: cPts, cost: oPts, story: sPts },
    reasons: allReasons,
    gemPriceTarget: gpt,
    pointsToGem: ptToGem,
  };
}

// fmt$ is duplicated here to keep this library dependency-free
function fmt$(n: number) {
  if (n >= 1000000) return `$${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000)    return `$${(n / 1000).toFixed(0)}k`;
  return `$${n}`;
}
