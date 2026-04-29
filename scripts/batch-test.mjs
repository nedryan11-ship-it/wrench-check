#!/usr/bin/env node
/**
 * WrenchCheck Batch Test Runner
 * Usage: node scripts/batch-test.mjs [folder]
 *
 * Uploads every PDF in the folder to localhost:3000/api/maintenance-audit,
 * streams the SSE response, and saves a JSON report per file.
 * Results are written to scripts/batch-results/
 */

import fs from "fs";
import path from "path";
import { Readable } from "stream";
import { FormData, File } from "formdata-node";
import { fileFromPath } from "formdata-node/file-from-path";

const BASE_URL = process.env.WRENCH_URL ?? "http://localhost:3000";
const RESULTS_DIR = path.join(process.cwd(), "scripts", "batch-results");
const INPUT_DIR = process.argv[2] ?? path.join(process.cwd(), "scripts", "test-pdfs");
const ASKING_PRICES = {}; // Optional: { "filename.pdf": 42000 } — add known prices here

fs.mkdirSync(RESULTS_DIR, { recursive: true });

const VERDICT_LABELS = {
  strong_buy: "Strong Buy ✅",
  clean: "Clean ✅",
  good_buy: "Good Buy 🟢",
  reasonable_buy: "Reasonable Buy 🟢",
  buy_if_priced_right: "Buy If Priced Right 🟡",
  high_risk: "High Risk 🔴",
  incomplete: "Incomplete ⚠️",
};

async function testFile(filePath) {
  const filename = path.basename(filePath);
  console.log(`\n${"─".repeat(60)}`);
  console.log(`📄 Testing: ${filename}`);
  console.log(`${"─".repeat(60)}`);

  const formData = new FormData();
  const file = await fileFromPath(filePath, filename, { type: "application/pdf" });
  formData.set("file", file);

  const startMs = Date.now();
  let events = [];
  let finalResult = null;
  let vehicle = null;
  let verdict = null;

  try {
    const res = await fetch(`${BASE_URL}/api/maintenance-audit`, {
      method: "POST",
      body: formData,
    });

    const contentType = res.headers.get("content-type") ?? "";

    // ── Streaming SSE path ──────────────────────────────────────────────────
    if (contentType.includes("text/event-stream") && res.body) {
      const decoder = new TextDecoder();
      let buf = "";
      for await (const chunk of res.body) {
        buf += decoder.decode(chunk, { stream: true });
        const parts = buf.split("\n\n");
        buf = parts.pop() ?? "";
        for (const part of parts) {
          if (!part.startsWith("data: ")) continue;
          let evt;
          try { evt = JSON.parse(part.slice(6)); } catch { continue; }
          events.push(evt);
          if (evt.type === "vehicle") {
            vehicle = evt.vehicle;
            const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
            console.log(`  ✦ Vehicle identified (${elapsed}s): ${vehicle.year} ${vehicle.make} ${vehicle.model} — ${vehicle.currentMileage?.toLocaleString() ?? "?"} mi`);
          } else if (evt.type === "verdict") {
            verdict = evt;
            const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
            const label = VERDICT_LABELS[evt.verdict] ?? evt.verdict;
            const debtLow = evt.debtEstimateLow ?? 0;
            const debtHigh = evt.debtEstimateHigh ?? 0;
            console.log(`  ✦ Early verdict (${elapsed}s): ${label} | Debt: $${debtLow.toLocaleString()}–$${debtHigh.toLocaleString()}`);
          } else if (evt.type === "complete") {
            finalResult = evt;
          } else if (evt.type === "progress") {
            process.stdout.write(`  … ${evt.message} (${evt.pct}%)\r`);
          } else if (evt.type === "error") {
            console.error(`  ❌ Error: ${evt.error}`);
          }
        }
      }
    } else {
      // Fallback: JSON response (paste/manual path won't be hit here but just in case)
      finalResult = await res.json();
    }

    const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
    console.log(`\n  ⏱  Total: ${elapsed}s`);

    if (!finalResult?.success) {
      console.log(`  ❌ FAILED: ${finalResult?.error ?? "unknown"}`);
      return { filename, success: false, error: finalResult?.error, elapsed };
    }

    const r = finalResult.result;
    const mv = r.marketValueEstimate;
    const label = VERDICT_LABELS[r.verdict] ?? r.verdict;
    const vin = r.vehicle?.vin ?? "—";
    const mileage = r.vehicle?.currentMileage?.toLocaleString() ?? "—";
    const overdueCount = (r.debtItems ?? []).filter(i => i.status === "overdue" || i.status === "due_now").length;
    const totalDebt = Math.round(((r.debtEstimateLow ?? 0) + (r.debtEstimateHigh ?? 0)) / 2);

    console.log(`\n  RESULT SUMMARY`);
    console.log(`  Vehicle:     ${r.vehicle?.year} ${r.vehicle?.make} ${r.vehicle?.model} ${r.vehicle?.trim ?? ""}`);
    console.log(`  VIN:         ${vin}`);
    console.log(`  Mileage:     ${mileage} mi`);
    console.log(`  Verdict:     ${label}`);
    console.log(`  Schedule:    ${r.scheduleSource}`);
    console.log(`  Confidence:  ${r.confidence}`);
    console.log(`  Overdue:     ${overdueCount} items (~$${totalDebt.toLocaleString()} total)`);

    if (mv) {
      console.log(`  Market Val:  $${mv.low.toLocaleString()}–$${mv.high.toLocaleString()} [${mv.source ?? "unknown"}] confidence=${mv.confidence}`);
    } else {
      console.log(`  Market Val:  ❌ Not returned`);
    }

    if (r.modelInsights?.expertTake) {
      console.log(`  Expert Take: ${r.modelInsights.expertTake}`);
    }
    if (r.modelInsights?.warrantyStatus) {
      console.log(`  Warranty:    ${r.modelInsights.warrantyStatus}`);
    }

    // Save full result to disk
    const outFile = path.join(RESULTS_DIR, filename.replace(".pdf", ".json"));
    const summary = {
      filename,
      elapsed: parseFloat(elapsed),
      vehicle: r.vehicle,
      verdict: r.verdict,
      scheduleSource: r.scheduleSource,
      confidence: r.confidence,
      overdueCount,
      totalDebt,
      marketValue: mv ?? null,
      debtItems: (r.debtItems ?? []).map(i => ({
        service: i.canonicalService,
        status: i.status,
        severity: i.severity,
        costLow: i.estimatedCostLow,
        costHigh: i.estimatedCostHigh,
      })),
      modelInsights: r.modelInsights ?? null,
      fullResult: r,
      streamEvents: events.map(e => ({ type: e.type, pct: e.pct })),
    };
    fs.writeFileSync(outFile, JSON.stringify(summary, null, 2));
    console.log(`  💾 Saved: ${path.relative(process.cwd(), outFile)}`);

    return summary;

  } catch (err) {
    console.error(`  ❌ Exception: ${err.message}`);
    return { filename, success: false, error: err.message };
  }
}

async function main() {
  if (!fs.existsSync(INPUT_DIR)) {
    console.error(`❌ Input directory not found: ${INPUT_DIR}`);
    console.error(`   Create it and drop your PDFs in, or pass a path: node scripts/batch-test.mjs ./my-pdfs`);
    process.exit(1);
  }

  const files = fs.readdirSync(INPUT_DIR)
    .filter(f => f.toLowerCase().endsWith(".pdf"))
    .map(f => path.join(INPUT_DIR, f));

  if (files.length === 0) {
    console.error(`❌ No PDFs found in ${INPUT_DIR}`);
    process.exit(1);
  }

  console.log(`\n🔧 WrenchCheck Batch Test`);
  console.log(`   Server:  ${BASE_URL}`);
  console.log(`   PDFs:    ${files.length} files in ${INPUT_DIR}`);
  console.log(`   Results: ${RESULTS_DIR}\n`);

  const results = [];
  for (const f of files) {
    const r = await testFile(f);
    results.push(r);
    // Small delay between files to avoid hammering the dev server
    await new Promise(res => setTimeout(res, 1000));
  }

  // ── Aggregate summary ──────────────────────────────────────────────────────
  console.log(`\n${"═".repeat(60)}`);
  console.log(`BATCH SUMMARY (${results.length} files)`);
  console.log(`${"═".repeat(60)}`);

  const succeeded = results.filter(r => r.verdict);
  const failed = results.filter(r => !r.verdict);
  const mcHits = succeeded.filter(r => r.marketValue?.source === "marketcheck");
  const aiHits = succeeded.filter(r => r.marketValue?.source === "ai_estimated");
  const noMv = succeeded.filter(r => !r.marketValue);
  const avgElapsed = succeeded.length
    ? (succeeded.reduce((s, r) => s + (r.elapsed ?? 0), 0) / succeeded.length).toFixed(1)
    : "—";

  console.log(`  Succeeded:      ${succeeded.length}/${results.length}`);
  console.log(`  Failed:         ${failed.length}`);
  console.log(`  Avg time:       ${avgElapsed}s`);
  console.log(`  Market data:    MarketCheck=${mcHits.length}  AI fallback=${aiHits.length}  None=${noMv.length}`);
  console.log(`\nVERDICTS:`);
  for (const r of succeeded) {
    const mv = r.marketValue ? `$${r.marketValue.low.toLocaleString()}–$${r.marketValue.high.toLocaleString()} [${r.marketValue.source}]` : "no market data";
    console.log(`  ${r.filename.padEnd(40)} ${(VERDICT_LABELS[r.verdict] ?? r.verdict).padEnd(28)} ${mv}`);
  }
  if (failed.length) {
    console.log(`\nFAILED:`);
    for (const r of failed) console.log(`  ${r.filename}: ${r.error}`);
  }

  // Write aggregate summary
  fs.writeFileSync(
    path.join(RESULTS_DIR, "_summary.json"),
    JSON.stringify({ timestamp: new Date().toISOString(), results }, null, 2)
  );
  console.log(`\n💾 Summary saved to scripts/batch-results/_summary.json`);
}

main().catch(console.error);
