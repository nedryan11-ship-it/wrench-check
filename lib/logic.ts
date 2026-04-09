"use server";

import { supabaseAdmin as supabase } from "./supabase";
import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export interface LineItem {
  description: string;
  price: number;
}

export interface ExtractedData {
  shop_name: string;
  vehicle_info: {
    year: string;
    make: string;
    model: string;
    vin?: string;
  };
  line_items: LineItem[];
}

export async function extractEstimateFromUpload(caseId: string, filePath: string) {
  try {
    console.log(`[SERVER] extraction started for case: ${caseId}, path: ${filePath}`);
    
    // 1. Get a short-lived signed URL for the image
    console.log(`[SERVER] getting signed URL for file metadata...`);
    const { data: signedData, error } = await supabase.storage.from("estimates").createSignedUrl(filePath, 60);
    
    if (error || !signedData) {
      console.error(`[SERVER] signed URL failed:`, JSON.stringify(error, null, 2));
      throw new Error("Unable to read file from storage.");
    }
    console.log(`[SERVER] signed URL obtained successfully.`);

    // 2. Call OpenAI Vision to extract structured data (with 30s timeout)
    console.log(`[SERVER] starting OpenAI Vision request... (Awaiting up to 30s)`);
    
    const openAICall = openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "system",
          content: `You are an expert mechanic data extraction tool parsing physical auto shop invoices. 
CRITICAL EXTRACTION RULES:
1. DO NOT blend diagnostic text with service line items. They must be separate objects in the array.
2. Under "RECOMMENDED SERVICE" sections, you will find observation notes (e.g. "Power Steering Fluid Condition...") followed by the actual billable service (e.g. "POWER STEERING FLUID SERVICE - CHF11S").
3. You MUST extract these as TWO separate line items:
   - Item 1: description: "Power Steering Fluid Condition...", price: 0
   - Item 2: description: "POWER STEERING FLUID SERVICE - CHF11S", price: 245.79
4. NEVER attach a price to an observation row. If the text contains "condition", "leaks", "noted", or "inspection", the price must be 0.`
        },
        {
          role: "user",
          content: [
            { 
              type: "text", 
              text: "Extract shop name, vehicle properties, and all line items. Ensure boxed/highlighted/uppercase service names form their own distinct rows with prices, while preceding diagnostic text forms a separate row with price = 0. Return JSON exactly like: { shop_name: string, vehicle_info: {year: string, make: string, model: string, vin?: string}, line_items: [{description: string, price: number}] }" 
            },
            { 
              type: "image_url", 
              image_url: { url: signedData.signedUrl } 
            }
          ]
        }
      ],
      response_format: { type: "json_object" }
    });

    // 30 second timeout wrapper
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error("[SERVER] OpenAI Vision API request timed out after 30 seconds.")), 30000)
    );

    const completion = await Promise.race([openAICall, timeoutPromise]) as any;

    console.log(`[SERVER] OpenAI Response Received.`);
    const content = completion.choices[0].message.content || "{}";
    const extraction: ExtractedData = JSON.parse(content);

    // 3. Update the case record
    console.log(`[SERVER] Updating case record...`);
    await supabase
      .from("cases")
      .update({ 
        shop_name: extraction.shop_name, 
        vehicle_info: extraction.vehicle_info,
        status: 'processing'
      })
      .eq("id", caseId);

    // 4. Save line items
    console.log(`[SERVER] EXTRACTED JSON Payload (BEFORE INSERTING): \n`, JSON.stringify(extraction.line_items, null, 2));
    console.log(`[SERVER] line_items insert started... (Found: ${extraction.line_items?.length || 0})`);
    
    if (extraction.line_items && extraction.line_items.length > 0) {
      // Mapping 'description' from JSON to 'raw_text' for DB Schema
      const itemsToInsert = extraction.line_items.map(item => ({
        case_id: caseId,
        raw_text: item.description,
        price: item.price
      }));

      console.log(`[SERVER] PREPARED DB INSERT PAYLOAD: \n`, JSON.stringify(itemsToInsert, null, 2));
      console.log(`[SERVER] inserting line item array...`);
      
      const { error: insertErr } = await supabase.from("line_items").insert(itemsToInsert);
      
      if (insertErr) {
        console.error(`[SERVER] insert error on line_items table:`, JSON.stringify(insertErr, null, 2));
      } else {
        console.log(`[SERVER] insert success! Rows written to 'line_items'.`);
      }
    } else {
       console.warn(`[SERVER] extraction returned NO line items.`);
    }
    
    console.log(`[SERVER] extraction finished successfully.`);
    return extraction;

  } catch (err: any) {
    console.error(`[SERVER] extraction failed:`, err.message || JSON.stringify(err));
    throw err;
  }
}

/**
 * Normalizes line items by matching against the ontology library using rigorous token logic.
 */
export async function normalizeCaseLineItems(caseId: string) {
  try {
    console.log(`\n[SERVER] --- BEGIN ONTOLOGY SCAN FOR CASE: ${caseId} ---`);
    const { data: items } = await supabase.from("line_items").select("*").eq("case_id", caseId);
    const { data: ontology } = await supabase.from("ontology").select("*");

    if (!items || !ontology) {
      console.warn(`[SERVER] Missing line_items or ontology library data.`);
      return;
    }

    console.log(`[SERVER] Matcher booted. Pipeline loaded ${items.length} items & ${ontology.length} rules.`);

    for (const item of items) {
      const rawText = (item.raw_text || "").toLowerCase();
      const price = parseFloat(item.price) || 0;

      // --- 1. CLASSIFICATION STAGE ---
      let itemType = "observation"; // observation | recommendation | service_line
      
      const obsRecTriggers = ["condition", "leak", "if applicable", "inspection", "noted", "found", "recommend"];
      const hardRejectTriggers = ["condition", "leak", "inspection", "noted"];
      
      const hasObsRecTrigger = obsRecTriggers.some(t => rawText.includes(t));
      const hasHardRejectTrigger = hardRejectTriggers.some(t => rawText.includes(t));
      
      const isUppercaseLike = item.raw_text === item.raw_text.toUpperCase() && item.raw_text.length > 5;
      const isTitleLike = /^[A-Z][a-z]/.test(item.raw_text);

      if (hasObsRecTrigger) {
         itemType = rawText.includes("recommend") ? "recommendation" : "observation";
      } else if (price > 0 && (isUppercaseLike || isTitleLike)) {
         itemType = "service_line";
      } else if (price > 0) {
         itemType = "service_line";
      } else {
         itemType = "observation";
      }
      
      // Override specifically for strong shop headers even if they contain a soft trigger
      if (price > 0 && isUppercaseLike) {
         itemType = "service_line";
      }

      // RULE 4 FIREWALL: If a row contains condition, leak, inspection, noted -> NEVER a service line
      // UNLESS it has a price or is formatted as a primary service header
      if (hasHardRejectTrigger && price === 0 && !isUppercaseLike) {
         itemType = "observation";
      }

      console.log(`[SERVER] ANALYZING: Original: "${item.raw_text}" -> Classified as [${itemType.toUpperCase()}]`);

      // --- 2. ONTOLOGY MATCHING (SERVICES ONLY) ---
      let bestMatch = null;
      let highestScore = 0;
      let matchReason = "";

      if (itemType === "service_line") {
        const normalizedRawText = rawText.replace(/[^\w\s]|_/g, "").replace(/\s+/g, " ").trim();
        const rawTextTokens = normalizedRawText.split(" ");
        
        const WEAK_TOKENS = new Set(["fluid", "service", "condition", "leak", "leaks", "system", "replace", "check", "inspect", "noted", "flush", "exchange", "the", "and", "for", "with"]);

        for (const entry of ontology) {
          const catKey = entry.category_key || entry.normalized_category || "";
          
          // --- 3. DOMAIN OVERRIDE & EXCLUSION GUARDRAILS ---
          if (catKey.includes("coolant_reservoir")) {
             if (!rawText.includes("coolant") && !rawText.includes("expansion tank") && !rawText.includes("reservoir tank")) continue;
             if (rawText.includes("power steering") || rawText.includes("brake") || rawText.includes("transmission")) continue;
          }
          if (catKey.includes("power_steering")) {
             if (!rawText.includes("power steering")) continue;
          }
          if (catKey.includes("brake_fluid_flush") || catKey.includes("brake")) {
             if (catKey.includes("fluid") && !rawText.includes("brake fluid")) continue;
             if (rawText.includes("power steering") || rawText.includes("transmission")) continue;
          }
          if (catKey.includes("transmission_fluid") || catKey.includes("transmission")) {
             if (!rawText.includes("transmission")) continue;
             if (rawText.includes("brake") || rawText.includes("power steering")) continue;
          }

          let entryScore = 0;
          let entryReason = "";

          const keywordPhrases = (entry.keywords || "")
             .split(/[,;]/)
             .map((k: string) => k.trim().toLowerCase())
             .filter((k: string) => k.length > 0);
          
          for (const phrase of keywordPhrases) {
            const normalizedPhrase = phrase.replace(/[^\w\s]|_/g, "").replace(/\s+/g, " ").trim();
            const keywordTokens = normalizedPhrase.split(" ");

            if (normalizedPhrase && normalizedRawText.includes(normalizedPhrase)) {
               entryScore = Math.max(entryScore, 100);
               entryReason = `Exact internal phrase match: "${normalizedPhrase}"`;
            }

            let tokenIntersection = [];
            let hasStrongDomainToken = false;
            
            for (const kt of keywordTokens) {
               if (kt.length > 2 && rawTextTokens.includes(kt)) {
                  tokenIntersection.push(kt);
                  if (!WEAK_TOKENS.has(kt)) hasStrongDomainToken = true;
               }
            }

            if (tokenIntersection.length >= 2 && hasStrongDomainToken && entryScore < 100) {
               entryScore = Math.max(entryScore, 50);
               entryReason = `Strong Token Intersection (2+ with defining token): [${tokenIntersection.join(", ")}] against rule "${normalizedPhrase}"`;
            }
          }
          
          if (entryScore > highestScore) {
            highestScore = entryScore;
            bestMatch = entry;
            matchReason = entryReason;
          }
        }
      }

      // --- 3. PERSISTENCE ---
      if (itemType === "service_line" && bestMatch && highestScore > 0) {
        console.log(`[SERVER] ✅ MATCHED SERVICE: -> Category: [${bestMatch.category_key || bestMatch.normalized_category}] | Score: ${highestScore}`);
        try {
          await supabase.from("line_items").update({
            item_type: itemType,
            normalized_category: bestMatch.category_key || bestMatch.normalized_category,
            normalized_name: bestMatch.normalized_name,
            decision: bestMatch.decision_default,
            urgency: bestMatch.urgency_default
          }).eq("id", item.id);
        } catch (e) {
             console.error(`[SERVER] DB Update failed on item ${item.id}`, e);
        }
        
      } else {
         console.log(`[SERVER] 🚫 UNMATCHED / ${itemType.toUpperCase()}: Fields left null.`);
         try {
           await supabase.from("line_items").update({
             item_type: itemType,
             normalized_category: null,
             normalized_name: null,
             decision: itemType === 'observation' || itemType === 'recommendation' ? itemType : 'ask',
             urgency: 'low'
           }).eq("id", item.id);
         } catch (e) {
             console.error(`[SERVER] DB Update failed on item ${item.id}`, e);
         }
      }
    }
    
    console.log(`[SERVER] --- SCAN COMPLETE ---\n`);
    return { success: true, processedCount: items.length };

  } catch (err: any) {
    console.error(`[SERVER] Library alignment failed completely:`, err.message || JSON.stringify(err));
    throw err;
  }
}

/**
 * Generates the final audit report by segregating processed service lines into Red, Yellow, and Green buckets.
 */
export async function generateCaseReport(caseId: string) {
  console.log(`[SERVER-DIAGNOSTIC] Generating deterministic Case Report for: ${caseId}`);
  
  // FETCH ALL ITEMS to prevent empty render states, even if normalization fails
  const { data: items, error: itemsErr } = await supabase
    .from("line_items")
    .select("raw_text, price, normalized_name, decision, urgency, item_type")
    .eq("case_id", caseId);

  console.log(`[SERVER-DIAGNOSTIC] DB line_items query result:`, { count: items?.length || 0, error: itemsErr });
  console.log(`[SERVER-DIAGNOSTIC] Raw DB items mapping: `, items?.map((i) => i.raw_text).join(" | "));

  if (!items || items.length === 0) {
     console.warn(`[SERVER-DIAGNOSTIC] NO ITEMS FOUND for caseId: ${caseId} with item_type = "service_line". Checking all items regardless of type:`);
     const { data: allItems } = await supabase.from("line_items").select("*").eq("case_id", caseId);
     console.log(`[SERVER-DIAGNOSTIC] Fallback DB Check (all item_types): count=${allItems?.length}`);
     if (allItems) console.log(allItems.map(i => `${i.raw_text} (${i.item_type})`));
     
     // Fallback to processing them anyways for testing if empty
     return { red: [], yellow: [], green: [] };
  }

  // --- Deduplication Engine ---
  const deduplicatedItems: any[] = [];
  const signatureMap = new Set<string>();
  
  for (const item of items) {
     const priceStr = parseFloat(item.price || "0").toFixed(2);
     const nameStr = item.normalized_name ? item.normalized_name.toLowerCase() : (item.raw_text || "").toLowerCase();
     const sig = `${nameStr}_${priceStr}`;
     
     if (!signatureMap.has(sig)) {
        signatureMap.add(sig);
        deduplicatedItems.push(item);
     }
  }

  // --- Fetch Vehicle Context for Pricing AI ---
  const { data: caseData } = await supabase.from("cases").select("*").eq("id", caseId).single();
  const vehicleString = caseData?.vehicle_info ? `${caseData.vehicle_info.year} ${caseData.vehicle_info.make} ${caseData.vehicle_info.model}` : "Standard Sedan";

  // --- Global Shop AI Classification ---
  let shop_type = caseData?.shop_type;
  if (!shop_type && caseData?.shop_name) {
    try {
      const shopPrompt = `Classify this auto repair shop strictly into one of these 4 JSON strings: 'dealership', 'independent_general', 'independent_specialist', 'chain'. Shop Name: "${caseData.shop_name}". Output raw JSON like {"shop_type":"..."}`;
      const shc = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [{ role: "system", content: shopPrompt }],
        response_format: { type: "json_object" }
      });
      const parsed = JSON.parse(shc.choices[0].message.content || "{}");
      shop_type = parsed.shop_type || "independent_general";
      await supabase.from("cases").update({ shop_type }).eq("id", caseId);
    } catch (err) {
      console.error("[SERVER] Shop Classification LLM failed", err);
      shop_type = "independent_general";
    }
  } else if (!shop_type) {
    shop_type = "independent_general";
  }

  // --- Batched Pricing Intelligence LLM Query ---
  let pricingData: Record<string, any> = {};
  if (deduplicatedItems.length > 0) {
     const pricingPrompt = `
       You are an automotive pricing expert. Provide fair market repair estimates for the following vehicle: ${vehicleString}.
       For each service below, reply with a JSON dictionary mapping the service name strictly to:
       { "low_price": number, "high_price": number, "average_price": number, "shop_recommendation": string (e.g. "independent specialist", "dealership", "general mechanic") }

       Services:
       ${deduplicatedItems.map(i => i.normalized_name || i.raw_text).join(", ")}

       Return ONLY raw valid JSON exactly like this:
       {
         "Service Name": { "low_price": 100, "high_price": 200, "average_price": 150, "shop_recommendation": "independent specialist" }
       }
     `;
     
     try {
       const completion = await openai.chat.completions.create({
         model: "gpt-4o-mini",
         messages: [{ role: "system", content: pricingPrompt }],
         response_format: { type: "json_object" }
       });
       pricingData = JSON.parse(completion.choices[0].message.content || "{}");
     } catch (err) {
       console.error("[SERVER] Pricing LLM map failed", err);
     }
  }

  const report = {
    red: [] as any[],
    yellow: [] as any[],
    green: [] as any[]
  };

  let aboveMarketCount = 0;

  for (const item of deduplicatedItems) {
    // --- Confidence Sync ---
    let confidence_level = "Low";
    if (item.normalized_name && parseFloat(item.price) > 0 && item.decision !== "ask") {
        confidence_level = "High";
    } else if (item.normalized_name) {
        confidence_level = "Medium";
    }

    const itemKey = item.normalized_name || item.raw_text;
    const priceEst = pricingData[itemKey] || { low_price: 0, high_price: 0, average_price: 0, shop_recommendation: "general mechanic" };
    
    let price_position = "fair";
    let pricing_explanation = "This quote is within the typical range for this service.";
    const rawPrice = parseFloat(item.price);
    
    if (priceEst.low_price > 0 && priceEst.high_price > 0) {
       if (rawPrice < priceEst.low_price * 0.9) {
          price_position = "below_market";
          pricing_explanation = "This quote is lower than typical pricing for this service.";
       } else if (rawPrice > priceEst.high_price * 1.1) {
          price_position = "above_market";
          const endingStr = rawPrice > priceEst.high_price * 1.4 ? " This appears to be on the higher end of typical pricing." : "";
          pricing_explanation = `This quote is above the typical range for this service in your area.${endingStr}`;
          aboveMarketCount++;
       }
    }

    const formattedItem = {
      raw_text: item.raw_text,
      price: rawPrice,
      normalized_name: item.normalized_name || item.raw_text,
      decision: item.decision || "ask",
      urgency: item.urgency || "Unknown",
      confidence_level,
      market_range: {
         low: priceEst.low_price,
         high: priceEst.high_price,
         average: priceEst.average_price
      },
      shop_recommendation: priceEst.shop_recommendation || "general mechanic",
      price_position,
      pricing_explanation,
      flag_reason: "",
      technical_context: "",
      check_list: [] as string[]
    };

    if (item.decision === "decline") {
      formattedItem.flag_reason = `This service is commonly recommended, but rarely an immediate safety risk. ${price_position === 'above_market' ? 'Since the price is above typical, ' : ''}it’s worth confirming if this is actually required right now.`;
      formattedItem.technical_context = "Usually recommended prematurely as an add-on, rather than an immediate risk.";
      formattedItem.check_list = [
        "Is there a verifiable symptom, or is this just a guess?",
        "Does the manufacturer actually require this at your mileage?",
        "Can they show you the failed part or fluid condition?"
      ];
      report.red.push(formattedItem);
    } else if (item.decision === "ask" || item.decision === "approve_if_due") {
      formattedItem.flag_reason = `This service is commonly recommended, but not always urgent. ${price_position === 'above_market' ? 'Since you are paying a premium, ' : ''}it's worth exploring exactly why they flagged it today.`;
      formattedItem.technical_context = "Typical interval: every 30k–60k miles or standard visual inspection.";
      formattedItem.check_list = [
        "When was this last performed?",
        "Is there visible contamination or failure?",
        "Is this based on mileage or inspection?"
      ];
      report.yellow.push(formattedItem);
    } else if (item.decision === "approve" || item.decision === "approve_if_leaking") {
      formattedItem.flag_reason = "This service appears routine and reasonable.";
      formattedItem.technical_context = "Standard replacement to restore safe vehicle operation.";
      formattedItem.check_list = [
        "Are OEM or high-quality aftermarket parts being used?",
        "Is there a warranty included with this repair?"
      ];
      report.green.push(formattedItem);
    } else {
      // Fallback
      formattedItem.flag_reason = "This service is commonly recommended, but not always urgent. Since you are evaluating options, it's worth confirming why it's needed now.";
      formattedItem.technical_context = "Usually recommended based on mileage or fluid condition.";
      formattedItem.check_list = [
        "Can you help me understand why this service is needed now instead of at the next interval?",
        "What happens if I wait on this?"
      ];
      report.yellow.push(formattedItem);
    }
  }

  // Optionally mark case complete
  await supabase.from("cases").update({ status: 'completed' }).eq("id", caseId);

  // Global Mapping
  let shop_suggestion = "This is a general mechanic. You may want to compare with a specialist depending on the repair.";
  if (shop_type === "dealership") shop_suggestion = "You’re currently at a dealership. You can usually save by getting a quote from an independent specialist.";
  if (shop_type === "independent_specialist") shop_suggestion = "You’re already at a specialist. If pricing feels high, the best move is to compare with another specialist — not a general shop.";
  if (shop_type === "chain") shop_suggestion = "Chains are convenient, but pricing and quality can vary. Consider comparing with a well-reviewed independent or specialist.";


  // Fetch AI Shop Intelligence
  const intelligence = await getShopIntelligence({ shopName: caseData.shop_name || "Unknown Shop", shopType: shop_type, location: caseData.location || caseData.city || undefined });

  // Override recommendation based on shop grade
  const shopGrade = intelligence.shop_grade;
  const premiumAllowed = intelligence.quality_premium_allowed;

  if (shopGrade === "A") {
    shop_suggestion = `You're paying above typical pricing, but this shop appears reputable and specialized (Grade A). The premium may reflect expertise and quality parts.`;
    if (aboveMarketCount === 0) {
      shop_suggestion = `This is a Grade A shop with a strong reputation. Pricing looks fair relative to their quality — you can approve with confidence.`;
    }
  } else if (shopGrade === "B") {
    if (aboveMarketCount > 0) {
      shop_suggestion = `This quote is above market and the shop looks decent (Grade B), but it's worth comparing with another option before approving.`;
    } else {
      shop_suggestion = `This shop is solid (Grade B) and pricing looks fair. Reasonable to proceed, but a second opinion never hurts for larger jobs.`;
    }
  } else if (shopGrade === "C") {
    if (aboveMarketCount > 0) {
      shop_suggestion = `This quote is above market and the shop does not appear strong enough to justify a premium (Grade C). Compare with another shop before approving.`;
    } else {
      shop_suggestion = `Pricing is fair, but this shop has a weaker reputation (Grade C). Consider whether you're comfortable with the quality of work before proceeding.`;
    }
  }

  // Enrich pricing explanations based on shop grade
  const enrichPricingExplanation = (items: any[]) => {
    items.forEach((item: any) => {
      if (item.price_position === "above_market") {
        if (premiumAllowed) {
          item.pricing_explanation = "This is meaningfully above market, but common for highly rated specialists.";
        } else if (shopGrade === "C") {
          item.pricing_explanation = "This is meaningfully above market and difficult to justify given the shop's reputation.";
        } else {
          item.pricing_explanation = "This is slightly high, but common for this type of shop.";
        }
      } else if (item.price_position === "below_market") {
        item.pricing_explanation = "This is below typical market pricing.";
      } else {
        item.pricing_explanation = "This is within a normal range.";
      }
    });
  };
  enrichPricingExplanation(report.red);
  enrichPricingExplanation(report.yellow);
  enrichPricingExplanation(report.green);

  const formatted_shop_type = intelligence.shop_type?.replace("_", " ").toUpperCase() || shop_type.replace("_", " ").toUpperCase();
  const shop_reason = aboveMarketCount > 0 ? `We found ${aboveMarketCount} item(s) quoted above typical market rates at this ${formatted_shop_type.toLowerCase()}.` : `This ${formatted_shop_type.toLowerCase()} seems to be pricing fairly relative to market benchmarks.`;

  // Generate Executive Summary
  const audit_summary = await generateAuditSummary({
     red: report.red,
     yellow: report.yellow,
     green: report.green,
     shop_context: {
        shop_type: formatted_shop_type,
        intelligence
     }
  });

  return {
     ...report,
     audit_summary,
     shop_context: {
        shop_type: formatted_shop_type,
        recommendation: shop_suggestion,
        reason: shop_reason,
        intelligence
     }
  };
}

export async function getShopIntelligence({ shopName, shopType, location }: { shopName: string, shopType: string, location?: string }) {
    console.log("[SERVER] Generating Shop Intelligence for:", shopName, location ? `(${location})` : "");
    const normalizedName = shopName.trim().toLowerCase();
    const locationHint = location?.trim().toLowerCase() || null;

    // ──────────────────────────────────────────────
    // STAGE 1: Cache Check (Supabase)
    // ──────────────────────────────────────────────
    try {
        let cacheQuery = supabase
            .from("shop_intelligence_cache")
            .select("*")
            .eq("shop_name", normalizedName);
        
        if (locationHint) {
            cacheQuery = cacheQuery.eq("location_hint", locationHint);
        }

        const { data: cached } = await cacheQuery.single();

        if (cached && cached.fetched_at) {
            const ageMs = Date.now() - new Date(cached.fetched_at).getTime();
            const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
            if (ageMs < sevenDaysMs) {
                console.log("[SERVER] Cache HIT for:", shopName, "| Age:", Math.round(ageMs / 3600000), "hrs");
                const cachedGrading = await gradeShop({
                    rating: cached.rating,
                    review_count: cached.review_count,
                    shop_type: cached.shop_type || shopType,
                    specialization: cached.specialization || "general repair",
                    review_quality_label: cached.review_quality_label || "Unknown",
                    sentiment_summary: cached.sentiment_summary || "",
                });
                return {
                    name: cached.name || shopName,
                    rating: cached.rating,
                    review_count: cached.review_count,
                    review_quality_label: cached.review_quality_label,
                    specialization: cached.specialization,
                    shop_type: cached.shop_type || shopType,
                    sentiment_summary: cached.sentiment_summary,
                    interpretation: cached.interpretation,
                    shop_grade: cachedGrading.shop_grade,
                    grade_reason: cachedGrading.grade_reason,
                    quality_premium_allowed: cachedGrading.quality_premium_allowed,
                };
            } else {
                console.log("[SERVER] Cache STALE for:", shopName, "| Age:", Math.round(ageMs / 86400000), "days — refetching");
            }
        }
    } catch (cacheErr) {
        console.warn("[SERVER] Cache lookup failed (table may not exist yet), proceeding to API:", cacheErr);
    }

    // ──────────────────────────────────────────────
    // STAGE 2: Google Places API — Text Search
    // ──────────────────────────────────────────────
    const GOOGLE_API_KEY = process.env.GOOGLE_PLACES_API_KEY;
    let placesData: any = null;
    let reviews: any[] = [];
    let placeId: string | null = null;

    if (GOOGLE_API_KEY) {
        try {
            // 2a. Text Search to find the shop
            const searchRes = await fetch("https://places.googleapis.com/v1/places:searchText", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "X-Goog-Api-Key": GOOGLE_API_KEY,
                    "X-Goog-FieldMask": "places.id,places.displayName,places.rating,places.userRatingCount,places.types,places.reviews,places.formattedAddress",
                },
                body: JSON.stringify({
                    textQuery: locationHint ? `${shopName} auto repair ${locationHint}` : `${shopName} auto repair`,
                }),
            });

            if (searchRes.ok) {
                const searchJson = await searchRes.json();
                if (searchJson.places && searchJson.places.length > 0) {
                    placesData = searchJson.places[0];
                    placeId = placesData.id || null;
                    reviews = placesData.reviews || [];
                    console.log("[SERVER] Google Places found:", placesData.displayName?.text, "| Rating:", placesData.rating);
                }
            } else {
                console.warn("[SERVER] Google Places search failed:", searchRes.status, await searchRes.text());
            }
        } catch (apiErr) {
            console.warn("[SERVER] Google Places API call failed:", apiErr);
        }
    } else {
        console.warn("[SERVER] GOOGLE_PLACES_API_KEY not set — falling back to AI-only enrichment");
    }

    // ──────────────────────────────────────────────
    // STAGE 3: Extract + Classify
    // ──────────────────────────────────────────────
    const rating = placesData?.rating ?? null;
    const review_count = placesData?.userRatingCount ?? null;
    const displayName = placesData?.displayName?.text || shopName;

    // 3a. Reputation Label
    let review_quality_label = "No review data available";
    if (rating !== null && review_count !== null) {
        if (rating >= 4.6 && review_count >= 200) review_quality_label = "Excellent reputation";
        else if (rating >= 4.3) review_quality_label = "Strong reputation";
        else if (rating >= 4.0) review_quality_label = "Mixed reviews";
        else review_quality_label = "Potential concern";
    }

    // 3b. Shop Type Detection (keyword-based)
    const nameLower = displayName.toLowerCase();
    const DEALER_KEYWORDS = ["dealer", "dealership", "toyota service", "honda service", "bmw of", "mercedes-benz of", "audi of", "lexus of", "ford service"];
    const SPECIALIST_KEYWORDS = ["european", "german", "porsche", "audi", "bmw", "mercedes", "volkswagen", "vw", "volvo", "motorsport", "performance", "racing", "exotic", "import specialist"];
    const CHAIN_KEYWORDS = ["midas", "jiffy", "pep boys", "firestone", "meineke", "valvoline", "goodyear", "ntb", "maaco", "aamco", "safelite"];

    let detectedShopType = shopType || "independent";
    if (DEALER_KEYWORDS.some(k => nameLower.includes(k))) detectedShopType = "dealership";
    else if (SPECIALIST_KEYWORDS.some(k => nameLower.includes(k))) detectedShopType = "independent_specialist";
    else if (CHAIN_KEYWORDS.some(k => nameLower.includes(k))) detectedShopType = "chain";

    // 3c. Specialization Detection (AI enrichment)
    let specialization = "general repair";
    try {
        const aiResp = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [{
                role: "system",
                content: `Analyze this auto repair shop name: "${displayName}". Return ONLY a 2-5 word specialization category in lowercase (e.g. "german performance specialist", "general repair", "dealership service", "tire and brake specialist").`
            }],
            temperature: 0.1,
        });
        specialization = aiResp.choices[0].message.content?.trim().replace(/['"]/g, '') || "general repair";
    } catch (e) {
        // Fallback — keep "general repair"
    }

    // ──────────────────────────────────────────────
    // STAGE 4: AI Sentiment Summary from Reviews
    // ──────────────────────────────────────────────
    let sentiment_summary = "No customer reviews available for analysis.";
    if (reviews.length > 0) {
        const reviewTexts = reviews
            .slice(0, 5)
            .map((r: any) => r.text?.text || r.originalText?.text || "")
            .filter(Boolean);

        if (reviewTexts.length > 0) {
            try {
                const sentimentResp = await openai.chat.completions.create({
                    model: "gpt-4o-mini",
                    messages: [{
                        role: "system",
                        content: `Summarize these auto shop reviews in exactly one calm, professional sentence. Focus on what customers consistently praise or complain about. Do not use quotes. Do not start with "Customers".\n\nReviews:\n${reviewTexts.join("\n---\n")}`
                    }],
                    temperature: 0.2,
                });
                sentiment_summary = sentimentResp.choices[0].message.content?.trim() || sentiment_summary;
            } catch (e) {
                console.warn("[SERVER] Sentiment summary generation failed:", e);
            }
        }
    }

    // ──────────────────────────────────────────────
    // STAGE 5: Interpretation Layer
    // ──────────────────────────────────────────────
    let interpretation = "";
    if (rating === null) {
        interpretation = "No public review data found.";
    } else if (review_quality_label === "Excellent reputation" && detectedShopType === "independent_specialist") {
        interpretation = "A highly rated specialist — higher prices are expected, but quality is typically strong.";
    } else if (review_quality_label === "Excellent reputation") {
        interpretation = "Strong reputation — higher pricing is sometimes common here.";
    } else if (review_quality_label === "Strong reputation" && detectedShopType === "dealership") {
        interpretation = "An established dealership — expect premium parts but higher labor rates.";
    } else if (review_quality_label === "Strong reputation") {
        interpretation = "Solid reputation — pricing should be competitive.";
    } else if (review_quality_label === "Mixed reviews") {
        interpretation = "Mixed reviews — consider verifying why specific repairs are needed.";
    } else {
        interpretation = "Concerning reviews — you may want to get a second opinion.";
    }

    // ──────────────────────────────────────────────
    // STAGE 6: Cache Write (Supabase)
    // ──────────────────────────────────────────────
    // ──────────────────────────────────────────────
    // STAGE 6.5: Shop Grading
    // ──────────────────────────────────────────────
    const grading = await gradeShop({ rating, review_count, shop_type: detectedShopType, specialization, review_quality_label, sentiment_summary });

    const intelligenceResult = {
        name: displayName,
        rating,
        review_count,
        review_quality_label,
        specialization,
        shop_type: detectedShopType,
        sentiment_summary,
        interpretation,
        shop_grade: grading.shop_grade,
        grade_reason: grading.grade_reason,
        quality_premium_allowed: grading.quality_premium_allowed,
    };

    try {
        await supabase.from("shop_intelligence_cache").upsert({
            shop_name: normalizedName,
            location_hint: locationHint,
            place_id: placeId,
            name: displayName,
            rating,
            review_count,
            shop_type: detectedShopType,
            specialization,
            review_quality_label,
            sentiment_summary,
            interpretation,
            raw_reviews: reviews.slice(0, 5).map((r: any) => ({ text: r.text?.text || r.originalText?.text, rating: r.rating })),
            fetched_at: new Date().toISOString(),
        }, { onConflict: "shop_name" });
        console.log("[SERVER] Cache WRITE for:", shopName, `[Grade ${grading.shop_grade}]`, locationHint ? `(${locationHint})` : "");
    } catch (cacheWriteErr) {
        console.warn("[SERVER] Cache write failed (table may not exist):", cacheWriteErr);
    }

    return intelligenceResult;
}

/**
 * Grades a shop on a A/B/C tier system based on its intelligence data.
 * Used to determine whether a pricing premium is justified.
 */
export async function gradeShop(intel: {
    rating: number | null,
    review_count: number | null,
    shop_type: string,
    specialization: string,
    review_quality_label: string,
    sentiment_summary: string,
}) {
    const { rating, review_count, shop_type, specialization, review_quality_label } = intel;

    // No data → ungraded
    if (rating === null || review_count === null) {
        return {
            shop_grade: "B" as const,
            grade_reason: "Insufficient data to fully evaluate this shop. Defaulting to a neutral grade.",
            quality_premium_allowed: false,
        };
    }

    const isSpecialist = shop_type === "independent_specialist";
    const isDealer = shop_type === "dealership";
    const hasStrongSpecialization = !specialization.includes("general") && specialization !== "general repair";
    const hasExcellentReputation = review_quality_label === "Excellent reputation" || review_quality_label === "Strong reputation";

    // ── Grade A ──
    if (rating >= 4.6 && review_count >= 100 && (isSpecialist || (isDealer && hasStrongSpecialization)) && hasExcellentReputation) {
        return {
            shop_grade: "A" as const,
            grade_reason: `High rating (${rating}★), ${review_count}+ reviews, and recognized as a ${specialization}. This shop has earned trust through consistent quality.`,
            quality_premium_allowed: true,
        };
    }

    // Grade A — general shop with outstanding reviews
    if (rating >= 4.7 && review_count >= 200 && hasExcellentReputation) {
        return {
            shop_grade: "A" as const,
            grade_reason: `Exceptional rating (${rating}★) with ${review_count} reviews. Even without a narrow specialization, this shop has a very strong track record.`,
            quality_premium_allowed: true,
        };
    }

    // ── Grade C ──
    if (rating < 4.2 || review_count < 30 || review_quality_label === "Potential concern" || review_quality_label === "Mixed reviews") {
        let reason = `Rating of ${rating}★`;
        if (review_count < 30) reason += `, only ${review_count} reviews`;
        if (review_quality_label === "Potential concern") reason += ", concerning reputation";
        else if (review_quality_label === "Mixed reviews") reason += ", mixed customer feedback";
        reason += ". Not strong enough to justify premium pricing.";

        return {
            shop_grade: "C" as const,
            grade_reason: reason,
            quality_premium_allowed: false,
        };
    }

    // ── Grade B (everything else) ──
    return {
        shop_grade: "B" as const,
        grade_reason: `Solid rating (${rating}★) with ${review_count} reviews. Decent shop, but not strong enough to clearly justify above-market pricing.`,
        quality_premium_allowed: false,
    };
}

/**
 * Handles persistent chat messages.
 */
export async function sendCaseChatMessage(caseId: string, content: string) {
  // 1. Save user message
  await supabase.from("messages").insert({ case_id: caseId, role: 'user', content });

  // 2. Fetch context
  const { data: caseData } = await supabase.from("cases").select("*").eq("id", caseId).single();
  const { data: items } = await supabase.from("line_items").select("*").eq("case_id", caseId);
  const { data: history } = await supabase.from("messages").select("*").eq("case_id", caseId).order("created_at", { ascending: true });

  // 3. AI Response
  const messages: any[] = [
    { role: "system", content: "You are WrenchCheck, a high-trust fiduciary auditor. Help the user understand their repair quote and negotiate with the shop." },
    { role: "system", content: `Context: ${JSON.stringify({ vehicle: caseData?.vehicle_info, items })}` },
    ...(history || []).map(m => ({ role: m.role, content: m.content }))
  ];

  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages
  });

  const aiResponse = completion.choices[0].message.content || "";

  // 4. Save AI message
  await supabase.from("messages").insert({ case_id: caseId, role: 'assistant', content: aiResponse });

  return aiResponse;
}

export async function generateAuditSummary(reportData: any) {
  const prompt = `
    You are a trusted automotive advisor — like a knowledgeable friend, not a report generator.
    Your goal is to help the user feel confident about what to DO, not just what the numbers say.
    
    The primary question to answer is: "Do I actually need this service right now?"
    Secondary: "Is the pricing fair given this shop's quality?"

    Return strictly JSON matching this exact structure:
    {
       "headline": "A short, plain-English decision prompt (5-10 words). Should answer 'what should I do?' Examples: 'Worth asking about before you approve', 'Looks fair — you can proceed with confidence', 'Push back on this before signing off'",
       "summary": "2-3 conversational sentences. Address: is this service actually needed now? Is the pricing justified given the shop's quality? Avoid robotic language. Speak like a trusted advisor, not a report.",
       "key_takeaway": "1 direct sentence capturing the core advice. Should feel like something a friend would say.",
       "recommendation": "1-2 sentences on exactly what to do next. Concrete and confident."
    }

    Data Context:
    Shop Type/Reputation: ${reportData.shop_context?.shop_type} - ${reportData.shop_context?.intelligence?.review_quality_label || 'Unknown'}
    Shop Rating: ${reportData.shop_context?.intelligence?.rating || 'N/A'} stars from ${reportData.shop_context?.intelligence?.review_count || 'N/A'} reviews
    Shop Grade: ${reportData.shop_context?.intelligence?.shop_grade || 'Unknown'} — ${reportData.shop_context?.intelligence?.grade_reason || 'No grading data'}
    Quality Premium Justified: ${reportData.shop_context?.intelligence?.quality_premium_allowed ? 'Yes' : 'No'}
    Shop Detail: ${reportData.shop_context?.intelligence?.interpretation || 'Unknown'}
    Customer Sentiment: ${reportData.shop_context?.intelligence?.sentiment_summary || 'No review data available'}
    
    Total Price: $${[...reportData.red, ...reportData.yellow, ...reportData.green].reduce((sum: any, i: any) => sum + i.price, 0)}
    Red Items (push back): ${reportData.red.map((i: any) => `${i.normalized_name} ($${i.price}) [${i.price_position}] urgency:${i.urgency}`).join(", ") || "None"}
    Yellow Items (ask questions): ${reportData.yellow.map((i: any) => `${i.normalized_name} ($${i.price}) [${i.price_position}] urgency:${i.urgency}`).join(", ") || "None"}
    Green Items (looks good): ${reportData.green.map((i: any) => `${i.normalized_name} ($${i.price}) [${i.price_position}]`).join(", ") || "None"}
  `;

  try {
     const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [{ role: "system", content: prompt }],
        response_format: { type: "json_object" },
        temperature: 0.2
     });
     return JSON.parse(completion.choices[0].message.content || "{}");
  } catch (err) {
     console.error("Failed to generate audit summary", err);
     return {
        headline: "Audit Complete",
        summary: "We have reviewed the submitted estimate against the fiduciary engine.",
        key_takeaway: "Review the flagged items carefully.",
        recommendation: "If you have questions, ask the shop for clarification."
     };
  }
}
