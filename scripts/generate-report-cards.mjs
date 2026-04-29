/**
 * generate-report-cards.mjs
 * Reads batch JSON results, applies asking prices, runs the same verdict/gap/mode
 * logic as the UI, and writes a styled HTML report card for each car.
 */

import { readFileSync, writeFileSync, readdirSync } from "fs";
import { join } from "path";

// ── Asking prices ────────────────────────────────────────────────────────────
const ASKING = {
  "1C4RJFBG0FC814917": 12999,   // 2015 Jeep Grand Cherokee Limited
  "SALVR2RX0JH274690": 19990,   // 2018 Range Rover Evoque HSE
  "SALCJ2FX0LH880996": 17999,   // 2020 Land Rover Discovery Sport
  "5LM5J7XC0LGL07037": 29999,   // 2020 Lincoln Aviator Reserve
  "1C4SJVDT9NS140180": 39998,   // 2022 Jeep Wagoneer Series III
  "1C4RJYB66RC196476": 29948,   // 2024 Jeep Grand Cherokee 4XE
  "SALE27EU2R2279692": 66498,   // 2024 Land Rover Defender 110
  "JA4ARUAU0RU004004": 17380,   // 2024 Mitsubishi Outlander Sport SE
};

// ── Helpers ──────────────────────────────────────────────────────────────────
const fmtK  = n => n >= 10000 ? `$${Math.round(n/1000)}k` : `$${Math.round(n/100)*100}`;
const fmtD  = n => `$${Math.round(n).toLocaleString("en-US")}`;
const round500 = n => Math.round(n/500)*500;

function computeMode(vehicle, conditionDebt, overdueCount) {
  const age      = 2026 - (vehicle?.year ?? 2015);
  const mileage  = vehicle?.currentMileage ?? 0;
  const highRisk = 0; // simplified — debt and overdueCount suffice for classification
  if (age <= 3 && mileage < 35000 && conditionDebt < 500) return "price_driven";
  if (age >= 7 || mileage > 85000 || conditionDebt > 1500) return "maintenance_driven";
  return "mixed";
}

function computeDeal(askingPrice, mv) {
  if (!askingPrice || !mv) return null;
  const marketMid  = (mv.low + mv.high) / 2;
  const marketRange = mv.high - mv.low;
  if (askingPrice < mv.low * 0.93)              return { mood:"strong", label:"Below Market",  color:"#15803D" };
  if (askingPrice <= mv.low + marketRange * 0.5) return { mood:"low",    label:"Good Value",   color:"#16A34A" };
  if (askingPrice <= mv.high)                    return { mood:"mid",    label:"Fair Deal",    color:"#1D4ED8" };
  return                                                { mood:"over",   label:"Overpriced",  color:"#B91C1C" };
}

function computeVerdict(mode, deal, overdueCount) {
  if (!deal) return { label:"Enter Price", accent:"#94A3B8", bg:"#F8FAFC" };
  const isRisky = mode === "maintenance_driven";
  const isClean = mode === "price_driven";
  if (deal.mood === "strong") return isClean || overdueCount === 0
    ? { label:"Strong Buy",          accent:"#15803D", bg:"#F0FDF4" }
    : { label:"Good Deal — Buy",     accent:"#15803D", bg:"#F0FDF4" };
  if (deal.mood === "over") return isRisky
    ? { label:"Proceed with Caution", accent:"#B91C1C", bg:"#FEF2F2" }
    : { label:"Buy if Priced Right",  accent:"#B45309", bg:"#FFFBEB" };
  if (isRisky) return { label:"Proceed with Caution", accent:"#B91C1C", bg:"#FEF2F2" };
  if (isClean) return { label:"Good Buy",              accent:"#1D4ED8", bg:"#EFF6FF" };
  return overdueCount === 0
    ? { label:"Good Buy",             accent:"#1D4ED8", bg:"#EFF6FF" }
    : { label:"Buy if Priced Right",  accent:"#B45309", bg:"#FFFBEB" };
}

function computePriceGap(askingPrice, mv) {
  if (!askingPrice || !mv) return null;
  const mid  = (mv.low + mv.high) / 2;
  const diff = askingPrice - mid;
  const pct  = Math.abs(diff) / mid;
  if (pct < 0.04) return { text:"About right — within market range", mood:"fair",  color:"#1D4ED8" };
  const rounded = round500(Math.abs(diff));
  if (diff > 0)   return { text:`Overpaying by ~${fmtK(rounded)}`,    mood:"over",  color:"#B91C1C" };
  return            { text:`Below market by ~${fmtK(rounded)}`,       mood:"under", color:"#15803D" };
}

function computeWhatIdDo(mode, deal, conditionDebt, overdueCnt, mv, askingPrice) {
  if (!askingPrice || !deal) return `Enter asking price to unlock recommendation.`;
  const mid         = mv ? (mv.low + mv.high) / 2 : 0;
  const fairTarget  = Math.max(Math.round(mid - conditionDebt * 0.7), mv?.low ?? 0);
  const offerLow    = round500(fairTarget - 500);
  if (deal.mood === "strong") return `Buy at asking — priced below market. Don't negotiate, verify condition and move.`;
  if (deal.mood === "low" && mode !== "maintenance_driven")
    return `Buy at asking — fairly priced${overdueCnt === 0 ? " with clean history" : ""}. No meaningful negotiation edge.`;
  if (deal.mood === "mid" && mode === "price_driven")
    return `Fair price, clean car. Buy at asking or nudge $500–$1k max — don't lose it over noise.`;
  if (deal.mood === "mid" && conditionDebt > 0)
    return `Fair price but ~${fmtK(conditionDebt)} in deferred work. Ask for ${fmtD(round500(conditionDebt*0.6))} off or walk.`;
  if (deal.mood === "mid")
    return `Fair price for a clean car. Buy at asking.`;
  if (deal.mood === "over" && mode === "maintenance_driven")
    return `Overpriced AND high maintenance risk — hard pass unless they come down to ~${fmtK(offerLow)} and you're prepared for more.`;
  if (deal.mood === "over")
    return `Overpriced — target ~${fmtK(offerLow)} or walk. ${conditionDebt > 0 ? `Use the ~${fmtK(conditionDebt)} maintenance gap as leverage.` : "Market data is your leverage."}`;
  if (mode === "maintenance_driven")
    return `High maintenance risk — negotiate to ~${fmtK(fairTarget)} or avoid. Don't pay full price with this history.`;
  return `Review price against market data before committing.`;
}

// ── Load results from ALL batch directories ──────────────────────────────────
const RESULTS_DIRS = [
  "/Users/nedryan/Documents/wrench-check/scripts/batch-results",
  "/Users/nedryan/Documents/wrench-check/scripts/test-pdfs-new/scripts/batch-results",
];

const cars = [];
const seenVins = new Set();
for (const RESULTS_DIR of RESULTS_DIRS) {
  let files;
  try { files = readdirSync(RESULTS_DIR).filter(f => f.endsWith(".json") && f !== "_summary.json"); }
  catch { continue; }
  for (const file of files) {
    const data = JSON.parse(readFileSync(join(RESULTS_DIR, file), "utf8"));
    const vin  = data.vehicle?.vin;
    if (!vin || !ASKING[vin] || seenVins.has(vin)) continue;
    seenVins.add(vin);

    const mv           = data.marketValue || data.marketValueEstimate; // field name varies
    const overdue      = (data.debtItems || []).filter(i => i.status === "overdue" || i.status === "due_now");
    const conditionDebt = overdue.reduce((s,i)=>s+Math.round(((i.estimatedCostLow||0)+(i.estimatedCostHigh||0))/2),0);
    const askingPrice  = ASKING[vin];
    const mode         = computeMode(data.vehicle, conditionDebt, overdue.length);
    const deal         = computeDeal(askingPrice, mv);
    const verdict      = computeVerdict(mode, deal, overdue.length);
    const priceGap     = computePriceGap(askingPrice, mv);
    const whatIdDo     = computeWhatIdDo(mode, deal, conditionDebt, overdue.length, mv, askingPrice);
    const marketMid    = mv ? Math.round((mv.low+mv.high)/2) : null;

    cars.push({ data, vin, mv, overdue, conditionDebt, askingPrice, mode, deal, verdict, priceGap, whatIdDo, marketMid });
  }
}

// Sort by verdict severity (caution first, then buy-if, then good)
const ORDER = { "Proceed with Caution":0, "Buy if Priced Right":1, "Good Buy":2, "Good Deal — Buy":3, "Strong Buy":4 };
cars.sort((a,b) => (ORDER[a.verdict.label]??5) - (ORDER[b.verdict.label]??5));

// ── HTML template ────────────────────────────────────────────────────────────
function card(car) {
  const v   = car.data.vehicle;
  const mv  = car.mv;
  const gap = car.priceGap;
  const gapBg   = gap?.mood === "over"  ? "#FEF2F2" : gap?.mood === "under" ? "#F0FDF4" : "#EFF6FF";
  const gapBdr  = gap?.mood === "over"  ? "#FECACA" : gap?.mood === "under" ? "#86EFAC" : "#BFDBFE";
  const modeLabel = car.mode === "price_driven" ? "PRICE-DRIVEN" : car.mode === "maintenance_driven" ? "MAINTENANCE-DRIVEN" : "MIXED";
  const modeColor = car.mode === "price_driven" ? "#1D4ED8" : car.mode === "maintenance_driven" ? "#B91C1C" : "#B45309";

  const overdueRows = car.overdue.slice(0,5).map(i => {
    const cost = Math.round(((i.estimatedCostLow||0)+(i.estimatedCostHigh||0))/2);
    const sev  = i.severity === "high" ? "#B91C1C" : i.severity === "medium" ? "#B45309" : "#64748B";
    return `<div style="display:flex;justify-content:space-between;padding:5px 0;border-bottom:1px solid #F1F5F9;font-size:12px;">
      <span style="color:#0F172A;">${i.displayName}</span>
      <span style="color:${sev};font-weight:700;">${fmtD(cost)}</span>
    </div>`;
  }).join("");

  const expertTake = car.data.modelInsights?.expertTake;

  return `
  <div style="background:#fff;border:1px solid #E2E8F0;border-radius:20px;padding:28px 32px;margin-bottom:32px;box-shadow:0 4px 24px rgba(0,0,0,0.06);page-break-inside:avoid;">

    <!-- Header -->
    <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:20px;">
      <div>
        <div style="font-size:11px;font-weight:800;color:#94A3B8;letter-spacing:0.15em;margin-bottom:4px;">WRENCHCHECK AUDIT</div>
        <div style="font-size:26px;font-weight:900;color:#0F172A;letter-spacing:-0.03em;">${v?.year} ${v?.make} ${v?.model}</div>
        <div style="font-size:13px;color:#64748B;margin-top:2px;">${v?.trim || ""} · ${(v?.currentMileage||0).toLocaleString()} mi · VIN: ${car.vin}</div>
      </div>
      <div style="text-align:right;flex-shrink:0;margin-left:20px;">
        <div style="background:${car.verdict.bg};border:1.5px solid ${car.verdict.accent}33;border-radius:12px;padding:10px 18px;display:inline-block;">
          <div style="font-size:11px;font-weight:700;color:${car.verdict.accent};letter-spacing:0.08em;margin-bottom:2px;">VERDICT</div>
          <div style="font-size:22px;font-weight:900;color:${car.verdict.accent};">${car.verdict.label}</div>
        </div>
      </div>
    </div>

    <!-- Mode badge -->
    <div style="display:inline-block;background:${modeColor}15;border:1px solid ${modeColor}30;border-radius:6px;padding:3px 10px;font-size:10px;font-weight:800;color:${modeColor};letter-spacing:0.1em;margin-bottom:16px;">${modeLabel}</div>

    <!-- What I'd Do — hero action -->
    <div style="background:${car.verdict.bg};border-left:4px solid ${car.verdict.accent};border-radius:0 12px 12px 0;padding:14px 18px;margin-bottom:16px;">
      <div style="font-size:10px;font-weight:800;color:${car.verdict.accent};letter-spacing:0.1em;margin-bottom:6px;">WHAT I'D DO</div>
      <div style="font-size:14px;font-weight:700;color:#0F172A;line-height:1.5;">${car.whatIdDo}</div>
    </div>

    <!-- Price gap banner -->
    ${gap ? `<div style="display:flex;align-items:center;gap:12px;background:${gapBg};border:1.5px solid ${gapBdr};border-radius:12px;padding:12px 16px;margin-bottom:16px;">
      <span style="font-size:20px;">${gap.mood==="over"?"⚠️":gap.mood==="under"?"✅":"✓"}</span>
      <div>
        <div style="font-weight:800;font-size:15px;color:${gap.color};">${gap.text}</div>
        <div style="font-size:11px;color:#64748B;margin-top:1px;">vs. ~${fmtK(car.marketMid)} market mid</div>
      </div>
    </div>` : ""}

    <!-- Price breakdown -->
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-bottom:16px;">
      <div style="background:#F8FAFC;border-radius:12px;padding:12px 14px;">
        <div style="font-size:10px;font-weight:700;color:#94A3B8;letter-spacing:0.08em;margin-bottom:4px;">MARKET RANGE</div>
        <div style="font-size:18px;font-weight:800;color:#475569;">~${fmtK(mv?.low||0)}–${fmtK(mv?.high||0)}</div>
        <div style="font-size:10px;color:#94A3B8;margin-top:2px;">${mv?.source === "marketcheck" ? "✓ MarketCheck live" : "AI estimate"}</div>
      </div>
      <div style="background:#F8FAFC;border-radius:12px;padding:12px 14px;">
        <div style="font-size:10px;font-weight:700;color:#94A3B8;letter-spacing:0.08em;margin-bottom:4px;">ASKING PRICE</div>
        <div style="font-size:18px;font-weight:800;color:#0F172A;">${fmtD(car.askingPrice)}</div>
        <div style="font-size:10px;color:#94A3B8;margin-top:2px;">from listing</div>
      </div>
      <div style="background:#F8FAFC;border-radius:12px;padding:12px 14px;">
        <div style="font-size:10px;font-weight:700;color:#94A3B8;letter-spacing:0.08em;margin-bottom:4px;">MAINTENANCE DEBT</div>
        <div style="font-size:18px;font-weight:800;color:${car.conditionDebt > 500 ? "#B91C1C":"#15803D"};">${car.conditionDebt > 0 ? "~"+fmtK(car.conditionDebt) : "None"}</div>
        <div style="font-size:10px;color:#94A3B8;margin-top:2px;">${car.overdue.length} overdue item${car.overdue.length !== 1 ? "s":""}</div>
      </div>
    </div>

    <!-- Overdue items -->
    ${car.overdue.length > 0 ? `
    <div style="margin-bottom:14px;">
      <div style="font-size:10px;font-weight:700;color:#94A3B8;letter-spacing:0.08em;margin-bottom:8px;">OVERDUE MAINTENANCE</div>
      <div style="background:#FEF2F2;border-radius:10px;padding:10px 14px;">
        ${overdueRows}
        ${car.overdue.length > 5 ? `<div style="font-size:11px;color:#94A3B8;padding-top:6px;">+ ${car.overdue.length-5} more items</div>` : ""}
      </div>
    </div>` : `<div style="background:#F0FDF4;border-radius:10px;padding:10px 14px;margin-bottom:14px;font-size:13px;color:#15803D;font-weight:600;">✓ No overdue maintenance items</div>`}

    <!-- Expert take -->
    ${expertTake ? `<div style="background:#FEFCE8;border:1px solid #FEF08A;border-radius:10px;padding:10px 14px;font-size:12px;color:#854D0E;line-height:1.55;">
      <span style="font-weight:800;font-size:10px;letter-spacing:0.08em;display:block;margin-bottom:4px;color:#A16207;">EXPERT TAKE</span>${expertTake}
    </div>` : ""}
  </div>`;
}

const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>WrenchCheck — Deal Analysis</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap');
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Inter', -apple-system, sans-serif; background: #F8FAFC; color: #0F172A; padding: 40px; }
    .page-title { font-size: 32px; font-weight: 900; color: #0F172A; margin-bottom: 6px; letter-spacing: -0.04em; }
    .page-sub { font-size: 14px; color: #64748B; margin-bottom: 40px; }
  </style>
</head>
<body>
  <div style="max-width:860px;margin:0 auto;">
    <div class="page-title">WrenchCheck Deal Analysis</div>
    <div class="page-sub">8 vehicles · with real asking prices · MarketCheck data · ${new Date().toLocaleDateString("en-US",{month:"long",day:"numeric",year:"numeric"})}</div>
    ${cars.map(card).join("")}
  </div>
</body>
</html>`;

const outPath = "/tmp/wrenchcheck-report-cards.html";
writeFileSync(outPath, html);
console.log(`✓ Report cards written to ${outPath} (${cars.length} vehicles)`);
cars.forEach(c => {
  console.log(`  ${c.data.vehicle?.year} ${c.data.vehicle?.make} ${c.data.vehicle?.model?.padEnd(25)} → ${c.verdict.label.padEnd(24)} | Gap: ${c.priceGap?.text || "n/a"}`);
});
