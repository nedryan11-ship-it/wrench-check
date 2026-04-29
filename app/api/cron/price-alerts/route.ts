import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { scrapeListingUrlFast } from "@/lib/vehicleDatabases/fastScrape";
import { Resend } from "resend";

const resend = new Resend(process.env.RESEND_API_KEY);
const ALERT_EMAIL = process.env.ALERT_EMAIL || "onboarding@resend.dev";

// Serverless function timeout settings (for Vercel)
export const maxDuration = 300; // 5 minutes (max allowed on pro plans)

export async function GET(req: Request) {
  // 1. Authenticate the Cron request
  const authHeader = req.headers.get("Authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    // 2. Fetch all unique active URLs from the watchlist (both Focus and Watching tiers)
    const { data: activeCars, error: fetchErr } = await supabaseAdmin
      .from("watchlist_vehicles")
      .select("id, listing_url, price, lowest_price, initial_price, gem_price_target, title, year, make, model, price_history, seller_name, days_on_market, status, mileage")
      .in("status", ["watching", "focus"])
      .not("listing_url", "like", "manual_%");

    if (fetchErr || !activeCars) {
      throw new Error(`DB Fetch failed: ${fetchErr?.message}`);
    }

    let checked = 0;
    let drops = 0;
    let gemHits = 0;

    // 3. Loop and monitor price deltas
    // We run sequentially rather than Promise.all to avoid rate-limiting from Jina/Cloudflare
    for (const car of activeCars) {
      if (!car.listing_url) continue;

      try {
        // Fast scrape the live market listing
        const intel = await scrapeListingUrlFast(car.listing_url);
        
        if (!intel.price) {
          // Listing returned no price — it may be sold or pulled
          // Track consecutive failures in the DB (using last_price_check_at pattern)
          const { data: current } = await supabaseAdmin
            .from("watchlist_vehicles")
            .select("notes, scrape_fail_count")
            .eq("id", car.id)
            .single()
            .catch(() => ({ data: null }));

          const failCount = ((current as any)?.scrape_fail_count ?? 0) + 1;
          await supabaseAdmin.from("watchlist_vehicles")
            .update({ scrape_fail_count: failCount } as any)
            .eq("id", car.id);

          if (failCount >= 2) {
            // Two consecutive failures — likely sold
            const carName = car.title || `${car.year} ${car.make} ${car.model}`;
            await resend.emails.send({
              from: "WrenchCheck Alerts <onboarding@resend.dev>",
              to: ALERT_EMAIL,
              subject: `🚨 Listing Possibly Sold: ${carName}`,
              html: `
                <div style="font-family:system-ui,sans-serif;max-width:520px;margin:0 auto">
                  <div style="background:#7F1D1D;padding:18px 24px;border-radius:12px 12px 0 0">
                    <span style="color:#FCA5A5;font-size:11px;font-weight:800;letter-spacing:0.1em">WRENCHCHECK ALERT — LISTING GONE</span>
                  </div>
                  <div style="background:#FEF2F2;padding:24px;border:1px solid #FCA5A5;border-top:none;border-radius:0 0 12px 12px">
                    <h2 style="margin:0 0 8px;color:#7F1D1D">${carName}</h2>
                    <p style="color:#991B1B">This listing has failed to return price data on ${failCount} consecutive checks. It may have sold or been pulled.</p>
                    <p style="color:#64748B;font-size:12px">Last known price: <b>$${car.price?.toLocaleString() ?? "unknown"}</b></p>
                    <a href="${car.listing_url}" style="display:inline-block;padding:10px 18px;background:#7F1D1D;color:white;border-radius:8px;text-decoration:none;font-weight:700;font-size:13px;margin-top:8px">Check Listing →</a>
                    <p style="margin-top:16px;font-size:12px;color:#94A3B8">Remove it from your Radar if confirmed sold. Consider this market intel — it means demand is real.</p>
                  </div>
                </div>`,
            });
            console.log(`[ALERT] Listing possibly sold 🚨: ${carName}`);
          }
          continue;
        }

        checked++;

        const currentKnownBestPrice = car.lowest_price || car.price;
        
        // Append a price snapshot to history on every check
        const existingHistory: {price: number; date: string}[] = Array.isArray(car.price_history) ? car.price_history : [];
        const newSnapshot = { price: intel.price, date: new Date().toISOString() };
        // Only append if price changed or last entry is >6h old (avoid duplicates)
        const lastEntry = existingHistory[existingHistory.length - 1];
        const shouldAppend = !lastEntry || lastEntry.price !== intel.price ||
          (Date.now() - new Date(lastEntry.date).getTime()) > 6 * 60 * 60 * 1000;
        const updatedHistory = shouldAppend ? [...existingHistory, newSnapshot] : existingHistory;
        
        if (intel.price < currentKnownBestPrice) {
          drops++;
          
          // Price has dropped! Update the database
          await supabaseAdmin
            .from("watchlist_vehicles")
            .update({
              price: intel.price,
              lowest_price: intel.price,
              price_history: updatedHistory,
              last_price_check_at: new Date().toISOString(),
            })
            .eq("id", car.id);

          // Alert logic threshold check
          const isGemTargetHit = car.gem_price_target && intel.price <= car.gem_price_target;
          
          const dropAmount = currentKnownBestPrice - intel.price;
          const carName = car.title || `${car.year} ${car.make} ${car.model}`;

          const tier = car.status === 'focus' ? '🎯 Focus' : '👁 Watching';
          const milesText = car.mileage ? `${car.mileage.toLocaleString()} mi` : '';
          const domText = intel.daysOnMarket ? `${intel.daysOnMarket} days on market` : '';
          const priceHistory: {price:number;date:string}[] = Array.isArray(car.price_history) ? car.price_history : [];
          const historyRows = priceHistory.slice(-5).map((h: any) =>
            `<tr><td style="padding:3px 8px;color:#64748B">${new Date(h.date).toLocaleDateString()}</td><td style="padding:3px 8px;font-weight:600">$${h.price.toLocaleString()}</td></tr>`
          ).join('');

          const emailBase = `
            <div style="font-family:system-ui,sans-serif;max-width:520px;margin:0 auto">
              <div style="background:#0F172A;padding:18px 24px;border-radius:12px 12px 0 0">
                <span style="color:#818CF8;font-size:11px;font-weight:800;letter-spacing:0.1em">WRENCHCHECK ALERT</span>
              </div>
              <div style="background:#F8FAFC;padding:24px;border:1px solid #E2E8F0;border-top:none;border-radius:0 0 12px 12px">
                <h2 style="margin:0 0 4px;font-size:20px;color:#0F172A">${carName}</h2>
                <p style="margin:0 0 16px;color:#64748B;font-size:13px">${tier} · ${milesText}${domText ? ' · ' + domText : ''}</p>
                <div style="background:white;border:1px solid #E2E8F0;border-radius:8px;padding:16px;margin-bottom:16px">
                  <div style="font-size:13px;color:#64748B;margin-bottom:4px">New Price</div>
                  <div style="font-size:28px;font-weight:900;color:#0F172A">$${intel.price.toLocaleString()}</div>
                  <div style="font-size:13px;color:#15803D;font-weight:700">▼ $${dropAmount.toLocaleString()} drop</div>
                  ${car.gem_price_target ? `<div style="font-size:12px;color:#64748B;margin-top:4px">Gem target: $${car.gem_price_target.toLocaleString()}</div>` : ''}
                </div>
                ${historyRows ? `<table style="width:100%;margin-bottom:16px;font-size:12px"><tr><th style="text-align:left;padding:3px 8px;color:#94A3B8">Date</th><th style="text-align:left;padding:3px 8px;color:#94A3B8">Price</th></tr>${historyRows}</table>` : ''}
                <a href="${car.listing_url}" style="display:inline-block;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:700;font-size:14px;COLOR_PLACEHOLDER">View Listing →</a>
              </div>
            </div>`;

          if (isGemTargetHit) {
             gemHits++;
             await resend.emails.send({
               from: "WrenchCheck Alerts <onboarding@resend.dev>",
               to: ALERT_EMAIL,
               subject: `💎 GEM TARGET HIT: ${carName} → $${intel.price.toLocaleString()}`,
               html: emailBase.replace('COLOR_PLACEHOLDER', 'background:#4F46E5;color:white'),
             });
             console.log(`[ALERT] GEM HIT 💎: ${carName} dropped to $${intel.price}`);
          } else {
             await resend.emails.send({
               from: "WrenchCheck Alerts <onboarding@resend.dev>",
               to: ALERT_EMAIL,
               subject: `📉 Price Drop: ${carName} → $${intel.price.toLocaleString()} (↓$${dropAmount.toLocaleString()})`,
               html: emailBase.replace('COLOR_PLACEHOLDER', 'background:#15803D;color:white'),
             });
             console.log(`[ALERT] Price Drop 📉: ${carName} dropped to $${intel.price}`);
          }
        } else {
          // No drop — just update check timestamp and append snapshot if needed
          await supabaseAdmin
            .from("watchlist_vehicles")
            .update({
              last_price_check_at: new Date().toISOString(),
              price_history: updatedHistory,
            })
            .eq("id", car.id);
        }

        // Artificial delay to prevent spamming generic IPs across multiple scans
        await new Promise(r => setTimeout(r, 1000));
        
      } catch (scrapeErr) {
        console.warn(`[cron] Failed to evaluate ${car.id}:`, scrapeErr);
      }
    }

    return NextResponse.json({
      success: true,
      summary: `Swept ${checked} cars. Found ${drops} price drops and ${gemHits} gem targets.`
    });

  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
