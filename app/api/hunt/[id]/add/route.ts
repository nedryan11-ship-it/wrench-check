import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { synthesizeComparison } from "@/lib/comparison/synthesize";
import type { ComparisonResult } from "@/lib/comparison/types";
import { runAuditPipeline } from "@/lib/maintenanceDebt/pipeline";
import { extractPdfText } from "@/lib/pdfParser";
import { fetchMarketComps } from "@/lib/vehicleDatabases/marketComps";
import type { MarketComps } from "@/lib/vehicleDatabases/marketComps";

import { scrapeListingUrlFast } from "@/lib/vehicleDatabases/fastScrape";
import type { ListingIntel } from "@/lib/vehicleDatabases/fastScrape";

// ─── Build listing text for the audit pipeline ────────────────────────────────
function buildListingText(intel: ListingIntel, url: string): string {
  const lines: string[] = [];
  if (intel.year)        lines.push(`Year: ${intel.year}`);
  if (intel.make)        lines.push(`Make: ${intel.make}`);
  if (intel.model)       lines.push(`Model: ${intel.model}`);
  if (intel.trim)        lines.push(`Trim: ${intel.trim}`);
  if (intel.mileage)     lines.push(`Mileage: ${intel.mileage.toLocaleString()} miles`);
  if (intel.price)       lines.push(`Asking Price: $${intel.price.toLocaleString()}`);
  if (intel.location)    lines.push(`Location: ${intel.location}`);
  if (intel.ownerCount != null) lines.push(`Number of Owners: ${intel.ownerCount}`);
  if (intel.hasAccident === false) lines.push("Accident History: No accidents reported");
  if (intel.hasAccident === true)  lines.push("Accident History: Accident reported");
  if (intel.description) lines.push(`\nListing Description:\n${intel.description.slice(0, 600)}`);
  if (lines.length === 0) lines.push(`Listing URL: ${url}`);
  return lines.join("\n");
}

// ─── POST handler ─────────────────────────────────────────────────────────────
export async function POST(
  req: Request,
  context: { params: Promise<{ id: string }> | { id: string } }
) {
  const params    = await context.params;
  const sessionId = params.id;

  const contentType = req.headers.get("content-type") || "";
  if (!contentType.includes("multipart/form-data")) {
    return NextResponse.json({ success: false, error: "multipart/form-data required" }, { status: 400 });
  }

  const formData = await req.formData();

  const encoder = new TextEncoder();
  const stream  = new ReadableStream({
    async start(controller) {
      let closed = false;
      const close = () => { if (!closed) { closed = true; close(); } };
      const send = (data: any) => {
        try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`)); } catch {}
      };

      try {
        send({ type: "progress", message: "Reading workspace...", pct: 5 });

        // ── Load existing workspace state ──────────────────────────────────────
        const { data: msgs, error: msgErr } = await supabaseAdmin
          .from("messages").select("content")
          .eq("case_id", sessionId).eq("role", "system")
          .order("created_at", { ascending: false }).limit(1);
        if (msgErr || !msgs || msgs.length === 0) throw new Error("Workspace not found in database.");

        let existingData: ComparisonResult | null = null;
        try { existingData = JSON.parse(msgs[0].content); } catch { existingData = null; }
        const priorCars = existingData?.cars ?? [];
        const priorSums = existingData?.auditSummaries ?? [];

        // ── Parse car bundles from form ────────────────────────────────────────
        const bundles: { url: string; dbId: string | null; price: string; pdfs: File[] }[] = [];
        for (let i = 0; i < 15; i++) {
          const url   = formData.get(`car[${i}][url]`)   as string | null;
          const dbId  = formData.get(`car[${i}][dbId]`)  as string | null;
          const price = formData.get(`car[${i}][price]`) as string | null;
          const pdfs  = formData.getAll(`car[${i}][pdf]`) as File[];
          if (url || dbId || pdfs.length > 0) {
            bundles.push({ url: url || "", dbId, price: price || "", pdfs });
          }
        }

        if (bundles.length === 0) {
          send({ type: "error", message: "No car data provided." });
          close(); return;
        }

        send({ type: "progress", message: `Evaluating ${bundles.length} car(s)...`, pct: 10 });

        // ── Phase 1: Scrape listings SEQUENTIALLY so Firecrawl calls don't ────
        // compete for the same time window. Each car gets a full 20s budget.
        type ScrapedBundle = {
          url: string; price: string; pdfs: File[];
          intel: ListingIntel; pdfText: string; filenameVin: string | null; hasPdf: boolean;
        };
        const scrapedBundles: ScrapedBundle[] = [];
        for (let idx = 0; idx < bundles.length; idx++) {
          const bundle = bundles[idx];
          send({ type: "progress", message: `Reading listing ${idx + 1} of ${bundles.length}...`, pct: 15 + Math.round(idx * (35 / bundles.length)) });

          // PDF extraction
          let pdfText = "";
          const hasPdf = bundle.pdfs.length > 0;
          for (const pdf of bundle.pdfs) {
            const buf = Buffer.from(await pdf.arrayBuffer());
            pdfText += (await extractPdfText(buf, pdf.name)) + "\n";
          }

          const filenameVin = bundle.pdfs.map(f => f.name).join(" ").match(/\b([A-HJ-NPR-Z0-9]{17})\b/i)?.[1]?.toUpperCase() ?? null;

          // Hydrate intel from Postgres if imported from Master Tracker, else Scrape
          let intel: ListingIntel = {
            title: null, year: null, make: null, model: null, trim: null,
            mileage: null, price: null, location: null,
            ownerCount: null, hasAccident: null, description: null,
            auctionEndDate: null, sellerType: null,
            sellerName: null, daysOnMarket: null,
          };
          if (bundle.dbId) {
            const { data: dbCar } = await supabaseAdmin.from("watchlist_vehicles").select("*").eq("id", bundle.dbId).single();
            if (dbCar) {
               intel = {
                 title: dbCar.title, year: dbCar.year, make: dbCar.make, model: dbCar.model, trim: dbCar.trim,
                 mileage: dbCar.mileage, price: dbCar.price, location: dbCar.location, 
                 ownerCount: dbCar.owner_count, hasAccident: dbCar.has_accident, description: dbCar.description,
                 auctionEndDate: null, sellerType: null,
                 sellerName: null, daysOnMarket: null,
               };
               bundle.url = dbCar.listing_url; // Rehydrate the naked URL variable so the LLM pipeline knows what it's attached to
            }
          } else if (bundle.url) {
            intel = await scrapeListingUrlFast(bundle.url);
          }

          scrapedBundles.push({ url: bundle.url, price: bundle.price, pdfs: bundle.pdfs, intel, pdfText, filenameVin, hasPdf });
        }

        // ── Build peer context for each car AFTER Phase 1 ─────────────────────
        // Now that we have all intel objects, each car can know its competition.
        const buildPeerContext = (idx: number): string | null => {
          const peers = scrapedBundles
            .map((sb, i) => {
              if (i === idx) return null;
              const parts = [sb.intel.year, sb.intel.make, sb.intel.model, sb.intel.trim].filter(Boolean).join(" ");
              const miStr = sb.intel.mileage ? `${sb.intel.mileage.toLocaleString()} miles` : "unknown mileage";
              const prStr = sb.intel.price ? `asking $${sb.intel.price.toLocaleString()}` : "price unknown";
              const locStr = sb.intel.location ? `(${sb.intel.location})` : "";
              return `- ${parts || `Car ${i + 1}`}: ${miStr}, ${prStr} ${locStr}`.trim();
            })
            .filter(Boolean);
          return peers.length > 0 ? peers.join("\n") : null;
        };

        // ── Phase 2: Run audit pipelines in PARALLEL (no scraping, pure AI) ───
        const newCarPromises = scrapedBundles.map(async (sb, idx) => {
          const { url, price, intel, pdfText, filenameVin, hasPdf } = sb;
          const peerContext = buildPeerContext(idx);

          const listingText  = buildListingText(intel, url);
          const combinedText = pdfText.trim() ? listingText + "\n\n" + pdfText : listingText;

          const vehicleOverride: Record<string, any> = {};
          if (filenameVin)   vehicleOverride.vin           = filenameVin;
          if (intel.year)    vehicleOverride.year           = intel.year;
          if (intel.make)    vehicleOverride.make           = intel.make;
          if (intel.model)   vehicleOverride.model          = intel.model;
          if (intel.trim)    vehicleOverride.trim           = intel.trim;
          if (intel.mileage) vehicleOverride.currentMileage = intel.mileage;

          const source = sb.pdfs.some(f => f.name.toLowerCase().includes("carfax"))    ? "carfax"
                       : sb.pdfs.some(f => f.name.toLowerCase().includes("autocheck")) ? "autocheck"
                       : "receipt";

          const label = [intel.year, intel.make, intel.model].filter(Boolean).join(" ") || `Car ${idx + 1}`;
          send({ type: "progress", message: `Auditing: ${label}...`, pct: 55 + Math.round(idx * (25 / scrapedBundles.length)) });

          const auditResultRaw = await runAuditPipeline({
            text: combinedText.trim(),
            source,
            vehicleOverride: Object.keys(vehicleOverride).length > 0 ? vehicleOverride : undefined,
            pricingContext: {},
            send: () => {},
            skipSchedule: true,  // Hunt only needs YMMT + modelInsights + market value
            peerContext,         // so modelInsights can differentiate this car from its siblings
          });

          const result = (auditResultRaw as any)?.result ?? null;

          const manualPrice = price ? parseInt(price.replace(/\D/g, ""), 10) : null;
          const finalPrice  = (manualPrice && manualPrice > 0) ? manualPrice : intel.price;
          if (result && finalPrice) result.askingPrice = finalPrice;

          const auditVehicle = result?.vehicle ?? {};
          const auditName    = [auditVehicle.year, auditVehicle.make, auditVehicle.model, auditVehicle.trim].filter(Boolean).join(" ");
          const intelName    = [intel.year, intel.make, intel.model, intel.trim].filter(Boolean).join(" ");
          const vehicleName  = intel.title || auditName || intelName || `Car ${idx + 1}`;

          const finalResult = {
            auditResult:      result,
            photoReport:      null,
            vehicleName,
            listingUrl:       url || null,
            scrapedMileage:   intel.mileage,
            scrapedLocation:  intel.location,
            notes:            "",
            hasServiceHistory: hasPdf,
            photoCount:       0,
            scrapedIntel:     intel,   // carry intel forward for marketComps lookup
          };

          send({ type: "car_resolved", carData: finalResult });
          return finalResult;
        });


        // Settle all — one bad car never blocks the rest
        const settled       = await Promise.allSettled(newCarPromises);
        const newCarResults = settled
          .filter(p => p.status === "fulfilled")
          .map((p: any) => p.value);

        // ── Phase 2b: Fetch live market comps per unique YMMT (≈ Cars.com) ──
        // Run in parallel for each distinct year+make+model group
        const ymtKeys = new Map<string, { make: string; model: string; year: number; mileage: number | null }>();
        for (const sb of scrapedBundles) {
          const { intel } = sb;
          if (intel.make && intel.model && intel.year) {
            const key = `${intel.year}|${intel.make}|${intel.model}`;
            if (!ymtKeys.has(key)) ymtKeys.set(key, { make: intel.make, model: intel.model, year: intel.year, mileage: intel.mileage ?? null });
          }
        }
        const marketCompsMap = new Map<string, MarketComps | null>();
        if (ymtKeys.size > 0) {
          send({ type: "progress", message: "Fetching live market pricing...", pct: 82 });
          await Promise.allSettled(
            Array.from(ymtKeys.entries()).map(async ([key, v]) => {
              const comps = await fetchMarketComps(v.make, v.model, v.year, v.mileage);
              marketCompsMap.set(key, comps);
            })
          );
        }
        // Helper to look up comps for a scrapedBundle by its intel
        const getCompsForIntel = (intel: ListingIntel): MarketComps | null => {
          if (!intel.make || !intel.model || !intel.year) return null;
          return marketCompsMap.get(`${intel.year}|${intel.make}|${intel.model}`) ?? null;
        };

        // ── Rebuild prior cars from stored state ───────────────────────────────
        const priorCarMaps = priorCars.map((car: any) => ({
          auditResult:      priorSums.find((s: any) => s.vehicleName === car.vehicleName)?.auditResult ?? null,
          photoReport:      car.photoConditionReport ?? null,
          vehicleName:      car.vehicleName,
          listingUrl:       car.listingUrl,
          scrapedMileage:   car.mileage ?? null,
          scrapedLocation:  car.listingNotes ?? null,
          notes:            car.listingNotes || "",
          hasServiceHistory: true,
          photoCount:       car.photoCount || 0,
        }));

        const mergedCarResults = [...priorCarMaps, ...newCarResults];

        send({ type: "progress", message: "Synthesizing Leaderboard...", pct: 85 });

        let synthesis: any;
        if (mergedCarResults.length === 1) {
          const c = mergedCarResults[0];
          const v = c.auditResult?.vehicle ?? {};
          synthesis = {
            headline:     "Car 1 is in — add more to compare.",
            winner:       c.vehicleName,
            winnerReason: "Add another vehicle to begin the head-to-head comparison.",
            tcoComparison: "", bottomLine: "", isSameCar: false,
            cars: [{
              vehicleName: c.vehicleName, fileIndex: 0, rank: 1,
              rankReason: "Only contender so far.",
              askingPrice: c.auditResult?.askingPrice ?? null,
              marketLow:   c.auditResult?.marketValueEstimate?.low  ?? 0,
              marketHigh:  c.auditResult?.marketValueEstimate?.high ?? 0,
              marketMid: 0, priceGapDollars: 0, priceGapLabel: "—",
              tcoYear1Low: 0, tcoYear1High: 0, tcoYear3Low: 0, tcoYear3High: 0, avgAnnualCost: null,
              frictionTier: "medium", frictionNote: "", downtimeEvents: "—",
              reliabilityTier: null, majorRisk: null, riskLevel: "medium",
              optimalSellMileage: null, optimalSellNote: null,
              photoConditionReport: null, photoCount: 0,
              verdict: c.auditResult?.verdict ?? "incomplete",
              maintenanceDebt: 0, overdueCount: 0,
              listingUrl: c.listingUrl, listingNotes: c.notes ?? null,
              mileage:   c.scrapedMileage ?? v.currentMileage ?? null,
              location:  c.scrapedLocation ?? null,
              hasServiceHistory: c.hasServiceHistory,
            }],
          };
        } else {
          synthesis = await synthesizeComparison(
            mergedCarResults.map(r => r.auditResult ?? {}),
            mergedCarResults.map(r => r.photoReport),
            mergedCarResults.map(r => r.listingUrl),
            mergedCarResults.map(r => r.notes),
            mergedCarResults.map(r => r.photoCount),
            mergedCarResults.map(r => r.scrapedLocation ?? null),  // for salt-belt + adjusted pricing
          );
        }

        const comparison: ComparisonResult = {
          ...synthesis,
          sessionId,
          createdAt: new Date().toISOString(),
          // Attach marketComps to each car (matched by position in mergedCarResults)
          cars: synthesis.cars?.map((car: any, i: number) => {
            const matchedResult = mergedCarResults[car.fileIndex ?? i];
            const intel = (matchedResult as any)?.scrapedIntel as ListingIntel | undefined;
            const comps = intel ? getCompsForIntel(intel) : null;
            return { ...car, marketComps: comps ?? null };
          }) ?? synthesis.cars,
          auditSummaries: mergedCarResults.map((r, i) => ({
            vehicleName: r.vehicleName,
            auditKey:    `audit_${sessionId}_${i}`,
            verdict:     r.auditResult?.verdict ?? "unknown",
            auditResult: r.auditResult,
          })),
        };

        // ── Push WrenchScore & Targets back to the Watchlist Database ──────────
        // (Runs unawaited to keep the stream extremely fast)
        try {
          const { computeWrenchScore } = await import("@/lib/comparison/wrenchScore");
          comparison.cars.forEach((c) => {
            if (c.listingUrl) {
               const auditSum = comparison.auditSummaries?.find((a: any) => a.vehicleName === c.vehicleName);
               const ws = computeWrenchScore(c, auditSum?.auditResult);
               supabaseAdmin.from("watchlist_vehicles").update({
                 score: ws.score,
                 tier: ws.tier,
                 tier_label: ws.tierLabel,
                 gem_price_target: ws.gemPriceTarget,
                 market_mid: c.marketComps?.priceMed ?? c.marketMid ?? null
               }).eq("listing_url", c.listingUrl).then(() => {});
            }
          });
        } catch(e) { console.warn("[hunt] Backward WrenchScore sync failed:", e); }

        await supabaseAdmin.from("messages").insert({
          case_id: sessionId, role: "system",
          content: JSON.stringify(comparison),
        });

        send({ type: "complete", sessionId, comparison, pct: 100 });
        close();

      } catch (err: any) {
        console.error("[hunt/add]", err);
        send({ type: "error", message: err.message || "Evaluation failed." });
        close();
      }
    },
  });

  return new NextResponse(stream, {
    headers: {
      "Content-Type":  "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection":    "keep-alive",
    },
  });
}
