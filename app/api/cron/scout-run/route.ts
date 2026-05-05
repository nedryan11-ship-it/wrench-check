// app/api/cron/scout-run/route.ts
// Scout agent cron — runs every 30 minutes via Vercel cron.
// For each active scout_config: crawls Cars.com + BaT RSS, shadow-scores new listings,
// inserts into scout_leads, alerts on Gem + Mid-Haul finds.
//
// Triggered by: GET /api/cron/scout-run with Authorization: Bearer {CRON_SECRET}

import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { scrapeListingUrlFast } from "@/lib/vehicleDatabases/fastScrape";
import { computeWrenchScore } from "@/lib/comparison/wrenchScore";
import { fetchMarketComps } from "@/lib/vehicleDatabases/marketComps";
import { Resend } from "resend";
import {
  buildCarsDotComUrl,
  fetchBaTLeads,
  fetchCarsAndBidsLeads,
  fetchIh8mudLeads,
  fetchMarketCheckLeads,
  fetchSearchMarkdown,
  extractListingUrls,
  computeTransitFromDenver,
  type ScoutConfig,
  type MarketCheckLead,
} from "@/lib/scout/searchBuilders";

export const maxDuration = 300;

// Lazy init — avoids build-time crash when env var missing
const getResend = () => new Resend(process.env.RESEND_API_KEY || 're_placeholder');
const ALERT_EMAIL = process.env.ALERT_EMAIL || "onboarding@resend.dev";
const GEM_THRESHOLD = 72; // Shadow score to qualify as a Gem lead
const MAX_TRANSIT_FOR_ALERT = 3; // Mid-Haul or closer triggers email

export async function GET(req: Request) {
  // Support both header auth (Vercel cron) and query param auth (external cron services)
  const authHeader = req.headers.get("Authorization");
  const url = new URL(req.url);
  const queryKey = url.searchParams.get("key");
  const cronSecret = process.env.CRON_SECRET;
  
  if (authHeader !== `Bearer ${cronSecret}` && queryKey !== cronSecret) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // ── 1. Load active scout configs ─────────────────────────────────────────
  const { data: configs, error: configErr } = await supabaseAdmin
    .from("scout_configs")
    .select("*")
    .eq("is_active", true);

  if (configErr || !configs?.length) {
    return NextResponse.json({ success: true, message: "No active scout configs" });
  }

  // ── 2. Load existing URLs to dedup against ────────────────────────────────
  const [{ data: existingVehicles }, { data: existingLeads }] = await Promise.all([
    supabaseAdmin.from("watchlist_vehicles").select("listing_url"),
    supabaseAdmin.from("scout_leads").select("listing_url"),
  ]);

  const seenUrls = new Set<string>([
    ...(existingVehicles ?? []).map((v: any) => v.listing_url),
    ...(existingLeads ?? []).map((l: any) => l.listing_url),
  ]);

  let totalLeads = 0;
  let totalGemAlerts = 0;

  // ── 3. Process each config ────────────────────────────────────────────────
  for (const config of configs as ScoutConfig[]) {
    const newUrls: { url: string; source: string }[] = [];

    // Cars.com
    if (config.sources?.includes("cars.com")) {
      const searchUrl = buildCarsDotComUrl(config);
      const markdown = await fetchSearchMarkdown(searchUrl);
      if (markdown) {
        const urls = extractListingUrls(markdown, "cars.com");
        for (const u of urls) {
          if (!seenUrls.has(u)) newUrls.push({ url: u, source: 'cars.com' });
        }
      }
      await new Promise((r) => setTimeout(r, 1500)); // rate limit delay
    }

    // BaT RSS
    if (config.sources?.includes("bat")) {
      const batLeads = await fetchBaTLeads(config);
      for (const lead of batLeads) {
        if (!seenUrls.has(lead.url)) newUrls.push({ url: lead.url, source: 'bat' });
      }
    }

    // Cars & Bids
    if (config.sources?.includes("carsandbids")) {
      const cabLeads = await fetchCarsAndBidsLeads(config);
      for (const lead of cabLeads) {
        if (!seenUrls.has(lead.url)) newUrls.push({ url: lead.url, source: 'carsandbids' });
      }
    }

    // ih8mud Classifieds
    if (config.sources?.includes("ih8mud")) {
      const mudLeads = await fetchIh8mudLeads(config);
      for (const lead of mudLeads) {
        if (!seenUrls.has(lead.url)) newUrls.push({ url: lead.url, source: 'ih8mud' });
      }
    }

    // ── Marketcheck API (direct structured data — no scraping needed) ──────
    if (config.sources?.includes("marketcheck")) {
      console.log(`[scout] Running Marketcheck for ${config.label}...`);
      const mcLeads = await fetchMarketCheckLeads(config);
      console.log(`[scout] Marketcheck returned ${mcLeads.length} listings`);

      for (const mc of mcLeads) {
        if (seenUrls.has(mc.url)) continue;
        if (mc.vin && seenUrls.has(mc.vin)) continue;
        seenUrls.add(mc.url);
        if (mc.vin) seenUrls.add(mc.vin);

        // Direct WrenchScore — no scrape needed, data is structured
        const comps = await fetchMarketComps(mc.make, mc.model, mc.year, mc.mileage || 80000);
        const ws = computeWrenchScore({
          year: mc.year, make: mc.make, model: mc.model,
          mileage: mc.mileage || 0,
          price: mc.price || 0,
          marketMid: comps?.priceMed ?? null,
          auditDebt: 0,
          tcoYear1High: comps?.priceMed ? comps.priceMed * 0.08 : 3000,
          hasAccident: mc.hasAccident,
          ownerCount: mc.ownerCount,
          location: mc.location,
        } as any);

        if (ws.score < 35) continue;

        const transit = computeTransitFromDenver(mc.location);

        // Criteria matching
        const criteriaSignals: string[] = [];
        if (mc.mileage && config.mileage_max && mc.mileage <= config.mileage_max * 0.8) criteriaSignals.push('✅ Well under mileage ceiling');
        if (mc.price && config.price_max && mc.price <= config.price_max * 0.9) criteriaSignals.push('✅ Well under budget');
        if (mc.hasAccident === false) criteriaSignals.push('✅ No accidents');
        if (mc.ownerCount === 1) criteriaSignals.push('✅ Single owner');
        if (comps?.priceMed && mc.price && mc.price < comps.priceMed) {
          criteriaSignals.push(`✅ $${(comps.priceMed - mc.price).toLocaleString()} below market`);
        }

        const { error: insertErr } = await supabaseAdmin.from("scout_leads").insert({
          scout_config_id: config.id,
          listing_url: mc.url,
          vin: mc.vin,
          title: mc.title,
          year: mc.year, make: mc.make, model: mc.model, trim: mc.trim,
          mileage: mc.mileage, price: mc.price, location: mc.location,
          shadow_score: ws.score, shadow_tier: ws.tier,
          transit_level: transit.level, transit_label: transit.label,
          gem_price_target: ws.gemPriceTarget,
          market_mid: comps?.priceMed ?? null,
          source: 'marketcheck',
          status: 'new',
          discovered_at: new Date().toISOString(),
          raw_intel: {
            hasAccident: mc.hasAccident, ownerCount: mc.ownerCount,
            photos: mc.photos, exteriorColor: mc.exteriorColor,
            sellerName: mc.sellerName, sellerType: mc.sellerType,
            daysOnMarket: mc.daysOnMarket, carfaxCleanTitle: mc.carfaxCleanTitle,
            criteriaSignals,
          },
        });

        if (!insertErr) {
          totalLeads++;
          console.log(`[scout] +MC lead: ${mc.title} | $${mc.price?.toLocaleString()} | score=${ws.score}`);

          // Gem alert email
          if (ws.score >= GEM_THRESHOLD && transit.level <= MAX_TRANSIT_FOR_ALERT) {
            try {
              await getResend().emails.send({
                from: "WrenchCheck Scout <onboarding@resend.dev>",
                to: ALERT_EMAIL,
                subject: `💎 GEM: ${mc.title} — Score ${ws.score} | ${transit.label}`,
                html: `<h2>💎 ${mc.title}</h2><p>$${mc.price?.toLocaleString()} · ${mc.mileage?.toLocaleString()} mi · ${mc.location}</p><p>Score: ${ws.score} · ${transit.emoji} ${transit.label}</p><p>${criteriaSignals.join(' · ')}</p><p><a href="${mc.url}">View Listing</a></p>`,
              });
              totalGemAlerts++;
            } catch {}
          }
        }
      }
    }

    // Process each new URL with shadow scoring (for non-Marketcheck sources)
    for (const { url, source } of newUrls.slice(0, 12)) {
      // Cap per run to avoid timeout
      try {
        seenUrls.add(url); // Immediately mark seen to prevent double-processing

        // Shadow scrape
        const intel = await scrapeListingUrlFast(url);
        if (!intel?.year || !intel?.make) continue;

        // Verify make/model matches the config (Cars.com results can drift)
        const intelMake = (intel.make || "").toLowerCase();
        const intelModel = (intel.model || "").toLowerCase();
        const configMake = (config.make || "").toLowerCase();
        const configModel = (config.model || "").toLowerCase();
        if (configMake && !intelMake.includes(configMake)) continue;
        if (configModel && !intelModel.includes(configModel)) continue;

        // Shadow market comps
        const comps = await fetchMarketComps(intel.make, intel.model || "", intel.year, intel.mileage || 80000);

        // Shadow WrenchScore
        const wsInput = {
          year: intel.year,
          make: intel.make,
          model: intel.model || "",
          mileage: intel.mileage || 0,
          price: intel.price || 0,
          marketMid: comps?.priceMed ?? null,
          auditDebt: 0,
          tcoYear1High: comps?.priceMed ? comps.priceMed * 0.08 : 3000,
          hasAccident: intel.hasAccident ?? null,
          ownerCount: intel.ownerCount ?? null,
          location: intel.location ?? null,
        };
        const ws = computeWrenchScore(wsInput as any);

        // Transit effort from Denver
        const transit = computeTransitFromDenver(intel.location);

        // Price filter check
        if (config.price_max && intel.price && intel.price > config.price_max) continue;
        if (config.mileage_max && intel.mileage && intel.mileage > config.mileage_max) continue;

        // Shadow score threshold (only store if meaningful)
        if (ws.score < 35) continue; // Skip obvious junk

        // ── Buyer Criteria Matching ─────────────────────────────────────────
        // Check this lead against buyer's saved preferences
        const criteriaSignals: string[] = [];
        let criteriaScore = 0;
        
        // Match against scout config which contains the buyer's known prefs
        const prefMaxMileage = config.mileage_max;
        const prefPriceMax = config.price_max;
        const prefYearMin = config.year_min;
        const prefYearMax = config.year_max;
        
        // Mileage check
        if (intel.mileage && prefMaxMileage) {
          if (intel.mileage <= prefMaxMileage * 0.8) { criteriaSignals.push('✅ Well under mileage ceiling'); criteriaScore += 20; }
          else if (intel.mileage <= prefMaxMileage) { criteriaSignals.push('✅ Under mileage ceiling'); criteriaScore += 10; }
        }
        // Price check
        if (intel.price && prefPriceMax) {
          if (intel.price <= prefPriceMax * 0.9) { criteriaSignals.push('✅ Well under budget'); criteriaScore += 20; }
          else if (intel.price <= prefPriceMax) { criteriaSignals.push('✅ Within budget'); criteriaScore += 10; }
          else { criteriaSignals.push('⚠️ Over budget ceiling'); criteriaScore -= 10; }
        }
        // Year check  
        if (intel.year && prefYearMin && intel.year >= prefYearMin) { criteriaSignals.push('✅ Year in range'); criteriaScore += 10; }
        // Clean history bonus
        if (intel.hasAccident === false) { criteriaSignals.push('✅ No accidents'); criteriaScore += 15; }
        if (intel.ownerCount === 1) { criteriaSignals.push('✅ Single owner'); criteriaScore += 10; }
        // Below market bonus
        if (comps?.priceMed && intel.price && intel.price < comps.priceMed) {
          const savings = comps.priceMed - intel.price;
          criteriaSignals.push(`✅ $${savings.toLocaleString()} below market`);
          criteriaScore += 15;
        }

        // Insert into scout_leads (with criteria match data)
        const { data: leadInserted } = await supabaseAdmin
          .from("scout_leads")
          .insert({
            scout_config_id: config.id,
            listing_url: url,
            title: intel.title,
            year: intel.year,
            make: intel.make,
            model: intel.model,
            trim: intel.trim,
            mileage: intel.mileage,
            price: intel.price,
            location: intel.location,
            shadow_score: ws.score,
            shadow_tier: ws.tier,
            transit_level: transit.level,
            transit_label: transit.label,
            gem_price_target: ws.gemPriceTarget,
            market_mid: comps?.priceMed ?? null,
            source: source,
            status: "new",
            raw_intel: { ...intel, criteria_signals: criteriaSignals, criteria_score: criteriaScore },
          })
          .select()
          .single();

        if (leadInserted) {
          totalLeads++;

          // Update config lead count
          await supabaseAdmin
            .from("scout_configs")
            .update({ lead_count: (config as any).lead_count + 1 })
            .eq("id", config.id);

          // ── In-app notification for criteria matches ────────────────────
          if (criteriaScore >= 40 || ws.score >= GEM_THRESHOLD) {
            const carName = intel.title || `${intel.year} ${intel.make} ${intel.model}`;
            const matchLabel = criteriaScore >= 60 ? '🎯 CRITERIA MATCH' 
              : criteriaScore >= 40 ? '📋 PARTIAL MATCH'
              : '💎 GEM LEAD';
            
            // Store in-app notification
            try {
              await supabaseAdmin.from("gem_alerts").insert({
                vehicle_title: carName,
                alert_type: criteriaScore >= 40 ? 'criteria_match' : 'gem',
                score: ws.score,
                price: intel.price,
                market_mid: comps?.priceMed,
                listing_url: url,
                criteria_signals: criteriaSignals,
                criteria_score: criteriaScore,
                read: false,
              });
            } catch (e) {
              // gem_alerts table may not exist yet — non-fatal
              console.warn('[scout] gem_alerts insert failed:', e);
            }
          }

          // ── 4. High-priority alert: Gem + Mid-Haul ────────────────────────
          if (ws.score >= GEM_THRESHOLD && transit.level <= MAX_TRANSIT_FOR_ALERT) {
            totalGemAlerts++;
            const carName = intel.title || `${intel.year} ${intel.make} ${intel.model}`;
            const vsMarket = comps?.priceMed && intel.price
              ? intel.price < comps.priceMed
                ? `$${(comps.priceMed - intel.price).toLocaleString()} below market`
                : `$${(intel.price - comps.priceMed).toLocaleString()} above market`
              : "No market comp";
            
            const criteriaHtml = criteriaSignals.length > 0
              ? `<tr><td style="padding:6px; color:#666;">Criteria Match</td><td style="padding:6px; font-weight:700; color:#15803D;">${criteriaSignals.join(' · ')}</td></tr>`
              : '';

            await getResend().emails.send({
              from: "WrenchCheck Scout <onboarding@resend.dev>",
              to: ALERT_EMAIL,
              subject: `💎 GEM LEAD: ${carName} — Score ${ws.score} | ${transit.label}`,
              html: `
                <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
                  <h2 style="color: #4F46E5;">💎 New Gem Lead Detected</h2>
                  <p><strong>${carName}</strong></p>
                  <table style="width:100%; border-collapse: collapse; margin-bottom: 16px;">
                    <tr><td style="padding:6px; color:#666;">WrenchScore</td><td style="padding:6px; font-weight:700; color:#4F46E5;">${ws.score}/100 — ${ws.tierLabel}</td></tr>
                    <tr><td style="padding:6px; color:#666;">Price</td><td style="padding:6px; font-weight:700;">${intel.price ? `$${intel.price.toLocaleString()}` : "Not listed"}</td></tr>
                    <tr><td style="padding:6px; color:#666;">vs Market</td><td style="padding:6px;">${vsMarket}</td></tr>
                    <tr><td style="padding:6px; color:#666;">Mileage</td><td style="padding:6px;">${intel.mileage?.toLocaleString() ?? "??"} mi</td></tr>
                    <tr><td style="padding:6px; color:#666;">Location</td><td style="padding:6px;">${intel.location ?? "Unknown"}</td></tr>
                    <tr><td style="padding:6px; color:#666;">Transit</td><td style="padding:6px; font-weight:700; color:#EA580C;">${transit.emoji} ${transit.label} — ${transit.driveHours ?? transit.flyEstimate ?? "?"}</td></tr>
                    <tr><td style="padding:6px; color:#666;">Shipping Est.</td><td style="padding:6px;">${transit.shipEstimate ?? "N/A"}</td></tr>
                    ${criteriaHtml}
                  </table>
                  <a href="${url}" style="display:inline-block; padding: 12px 24px; background: #4F46E5; color: white; border-radius: 8px; text-decoration: none; font-weight: 700;">View Listing →</a>
                  <p style="margin-top:20px; font-size:12px; color:#999;">This lead was discovered by your WrenchCheck Scout. Accept or dismiss it in your <strong>Incoming Leads</strong> tray.</p>
                </div>
              `,
            });
          }
        }

        await new Promise((r) => setTimeout(r, 1200)); // rate limit
      } catch (e) {
        console.warn(`[scout] Failed to process ${url}:`, e);
      }
    }

    // Update last_run_at
    await supabaseAdmin
      .from("scout_configs")
      .update({ last_run_at: new Date().toISOString() })
      .eq("id", config.id);
  }

  return NextResponse.json({
    success: true,
    summary: `Scout run complete. Found ${totalLeads} new leads, ${totalGemAlerts} gem alerts sent.`,
  });
}
