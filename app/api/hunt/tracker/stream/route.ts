import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { runAuditPipeline } from "@/lib/maintenanceDebt/pipeline";
import { fetchMarketComps } from "@/lib/vehicleDatabases/marketComps";
import { scrapeListingUrlFast } from "@/lib/vehicleDatabases/fastScrape";
import { computeWrenchScore } from "@/lib/comparison/wrenchScore";
import { runEnrichment } from "@/lib/enrichment/runEnrichment";
import type { ListingIntel } from "@/lib/vehicleDatabases/fastScrape";
import OpenAI from "openai";

function buildListingText(intel: any, url: string): string {
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

export async function POST(req: Request) {
  const contentType = req.headers.get("content-type") || "";
  
  try {
    const { queue } = await req.json();
    
    if (!Array.isArray(queue) || queue.length === 0) {
      return NextResponse.json({ success: false, error: "Empty queue" }, { status: 400 });
    }

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        let closed = false;
        const close = () => { if (!closed) { closed = true; controller.close(); } };
        const send = (data: any) => {
          if (closed) return;
          try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`)); } catch {}
        };

        try {
          const total = queue.length;
          send({ type: "start", total });

          // Process sequentially to stream exact progress back without hitting rate limits
          for (let i = 0; i < total; i++) {
            const item = queue[i];
            const currentCount = i + 1;
            
            try {
              // ── Facebook Marketplace early detection ─────────────────────────
              if (item.type === "url" && /facebook\.com\/marketplace/i.test(item.url || "")) {
                send({ type: "facebook_blocked", index: i, url: item.url,
                  message: `Facebook Marketplace blocks automated access. To add this car, copy the listing details and paste the specs manually using the "Manual Entry" tab, or re-find it on Cars.com, CarGurus, or AutoTrader.` });
                continue;
              }

              send({ type: "progress", index: i, message: `Extracting vehicle data...` });
              
              let intel: ListingIntel;
              
              if (item.type === "url") {
                intel = await scrapeListingUrlFast(item.url);
              } else {
                // Manual fallback injection
                intel = {
                  title: `${item.year} ${item.make} ${item.model}`,
                  year: item.year, make: item.make, model: item.model,
                  trim: item.trim || null,
                  mileage: item.mileage, price: item.price,
                  location: null, description: null, ownerCount: null, hasAccident: null,
                  auctionEndDate: null, sellerType: null, sellerName: null, daysOnMarket: null,
                };
              }

              if (!intel.year || !intel.make) {
                const shortUrl = (item.url || "manual entry").slice(0, 55);
                throw new Error(`Can't read listing at ${shortUrl}… — this dealer site blocks automated access. Try: screenshot the page → upload via Maintenance Audit → or paste the URL on Cars.com / BaT directly.`);
              }

              const label = `${intel.year} ${intel.make} ${intel.model}`;
              send({ type: "progress", index: i, message: `Auditing ${label}...` });

              // AI Deep Audit Pipeline
              const listingText = buildListingText(intel, item.url || "Manual Entry");
              
              const vehicleOverride: any = { year: intel.year, make: intel.make, model: intel.model };
              if (intel.trim) vehicleOverride.trim = intel.trim;
              if (intel.mileage) vehicleOverride.currentMileage = intel.mileage;

              const auditResult = await runAuditPipeline({
                text: listingText,
                vehicleOverride,
                source: "receipt"
              });

              // Market Pipeline
              send({ type: "progress", index: i, message: `Fetching live market comps...` });
              const comps = intel.make && intel.model && intel.year
                ? await fetchMarketComps(intel.make, intel.model, intel.year, intel.mileage ?? undefined)
                : null;

              // Synthesis into WrenchScore Context
              send({ type: "progress", index: i, message: `Calculating WrenchScore...` });
              
              // We simulate the "ComparedCar" shape expected by WrenchScore natively
              const simulatedCar = {
                vehicleName: label,
                listingUrl: item.type === "url" ? item.url : null,
                year: intel.year,
                make: intel.make,
                model: intel.model,
                trim: intel.trim,
                mileage: intel.mileage,
                askingPrice: intel.price,
                location: intel.location,
                isSaltBelt: false, // fallback
                maintenanceDebt: (auditResult as any)?.repairs?.reduce((sum: number, r: any) => sum + (r.costHigh||0), 0) ?? 0,
                tcoYear1High: 5000, // mock/fallback unless computed
                marketComps: comps
              };

              // Safely detect salt belt via naive text search if location exists
              if (intel.location) {
                const SALTBELT = ["OH", "MI", "IL", "IN", "PA", "NY", "NJ", "MA", "MN", "WI", "CT", "MD", "VA", "ME"];
                if (SALTBELT.some(s => intel.location!.includes(s))) simulatedCar.isSaltBelt = true;
              }

              const ws = computeWrenchScore(simulatedCar as any, auditResult as any);

              // Derive actual year-1 TCO from audit results for score differentiation
              // (the mock 5000 was pushing every car to the same score band)
              const auditRepairs: any[] = (auditResult as any)?.repairs || (auditResult as any)?.result?.repairs || (auditResult as any)?.majorExposures || [];
              const auditDebt = auditRepairs.reduce((s: number, r: any) => s + (r.costHigh || r.estimatedCostHigh || 0), 0);
              // Re-run score with real TCO so differentiation actually works
              const simulatedCarWithTco = {
                ...simulatedCar,
                tcoYear1High: auditDebt + (comps?.priceMed ? Math.round(comps.priceMed * 0.08) : 5000),
                maintenanceDebt: auditDebt,
              };
              const wsFinal = computeWrenchScore(simulatedCarWithTco as any, auditResult as any);

              // ── Phase 5: Generate specific Expert Take if generic ──────────────────
              const existingTake = (auditResult as any)?.result?.expertTake || (auditResult as any)?.expertTake || "";
              const isGeneric = !existingTake || existingTake.length < 40 || /analysis complete|review physical|no issues|looks good/i.test(existingTake);
              let expertTake = existingTake;

              if (isGeneric) {
                try {
                  const oai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
                  const priceVsMarket = comps?.priceMed && intel.price
                    ? intel.price > comps.priceMed
                      ? `$${(intel.price - comps.priceMed).toLocaleString()} above market median ($${comps.priceMed.toLocaleString()})`
                      : `$${(comps.priceMed - intel.price).toLocaleString()} below market median ($${comps.priceMed.toLocaleString()})`
                    : null;
                  const watchouts = (auditResult as any)?.result?.watchouts || (auditResult as any)?.watchouts || [];
                  const topRisk = watchouts[0]?.text || null;
                  const prompt = [
                    `Vehicle: ${intel.year} ${intel.make} ${intel.model}${intel.trim ? " " + intel.trim : ""}`,
                    intel.mileage ? `Mileage: ${intel.mileage.toLocaleString()} mi` : "",
                    intel.price ? `Asking: $${intel.price.toLocaleString()}` : "",
                    priceVsMarket ? `vs Market: ${priceVsMarket}` : "",
                    ws.gemPriceTarget ? `Fair value target: $${ws.gemPriceTarget.toLocaleString()}` : "",
                    topRisk ? `Top model risk: ${topRisk}` : "",
                    intel.location ? `Location: ${intel.location}` : "",
                  ].filter(Boolean).join("\n");

                  const completion = await oai.chat.completions.create({
                    model: "gpt-4o-mini",
                    messages: [
                      { role: "system", content: "Write a 2-3 sentence expert take for a vehicle buyer. Be specific: reference the actual price vs market, a key model-specific risk if known, and a concrete negotiation target or recommendation. No generic filler. No disclaimers. Direct and fiduciary." },
                      { role: "user", content: prompt }
                    ],
                    temperature: 0.3,
                    max_tokens: 120,
                  });
                  expertTake = completion.choices[0].message.content?.trim() || existingTake;
                } catch (e) {
                  console.warn("[stream] expert take generation failed:", e);
                }
              }

              // ── Insert fully loaded row into Watchlist Database ──
              const auditWithTake = { ...(auditResult || {}), auctionEndDate: intel.auctionEndDate, expertTake };
              const packedDescription = (intel.description || "") + "\n\n__WRENCH_AUDIT_JSON__\n" + JSON.stringify(auditWithTake);

              // Confidence: 25 base + 20 if market comps exist = 45 on first import
              const confidence_pct = comps?.priceMed ? 45 : 25;

              const { data: inserted, error } = await supabaseAdmin.from("watchlist_vehicles").insert({
                 listing_url: item.type === "url" ? item.url : `manual_${Date.now()}_${i}`,
                 title: intel.title,
                 year: intel.year,
                 make: intel.make,
                 model: intel.model,
                 trim: intel.trim,
                 mileage: intel.mileage,
                 price: intel.price,
                 initial_price: intel.price,
                 lowest_price: intel.price,
                 location: intel.location,
                 description: packedDescription,
                 owner_count: intel.ownerCount,
                 has_accident: intel.hasAccident,
                 seller_name: intel.sellerName,
                 days_on_market: intel.daysOnMarket,
                 price_history: intel.price ? [{ price: intel.price, date: new Date().toISOString() }] : [],
                 score: wsFinal.score,
                 tier: wsFinal.tier,
                 tier_label: wsFinal.tierLabel,
                 gem_price_target: wsFinal.gemPriceTarget,
                 market_mid: comps?.priceMed ?? null,
                 confidence_pct,
                 documents: [],
                 photo_intel: null,
                 deal_chat: [],
                 next_steps: [],
                 enrichment_status: item.type === "url" ? "pending" : "manual",
                 status: "focus",   // new adds land in Focus tier by default
              }).select().single();



              if (error) {
                 if (error.code === '23505') {
                    send({ type: "warning", index: i, message: `${label} is already in your inventory.` });
                 } else {
                    throw new Error(error.message);
                 }
              } else if (inserted?.id && item.type === "url") {
                 // Fire-and-forget enrichment: VIN + photo vision + NHTSA recalls (~45s)
                 // Does NOT block the stream response
                 runEnrichment(inserted.id).catch(e =>
                   console.warn("[stream] background enrichment failed:", e)
                 );
              }

              send({ type: "success", index: i, message: `Completed ${label}!`, data: inserted });
            } catch (err: any) {
              send({ type: "error", index: i, message: `Error processing listing: ${err.message}` });
            }
          }
          
          send({ type: "complete" });
          close();
        } catch (err: any) {
          console.error("[hunt/stream]", err);
          send({ type: "fatal", message: err.message || "Evaluation failed." });
          close();
        }
      }
    });

    return new NextResponse(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive"
      }
    });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
