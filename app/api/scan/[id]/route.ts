import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import OpenAI from 'openai';

function cleanOCRText(rawText: string): string {
  return rawText
    .replace(/\n+/g, "\n")
    .replace(/[^\x20-\x7E\n]/g, "") // remove weird unicode
    .replace(/\s{2,}/g, " ")
    .trim();
}

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const caseId = (await params).id;
  
  // Create an SSE stream
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: any) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      };

      try {
        send({ status: "Deep Scan in Progress", message: "Fetching encrypted files..." });

        const { data: uploads, error } = await supabase.from('uploads').select('*').eq('case_id', caseId);
        if (error || !uploads || uploads.length === 0) {
          throw new Error("No files found for this case.");
        }

        const { data: caseData } = await supabase.from('cases').select('*').eq('id', caseId).single();


        const systemInstruction = {
          type: "text" as const, 
          text: `You are an expert automotive auditor. I am providing an image of a service estimate. You MUST extract all text. If no services are found, return a JSON object explaining WHY (e.g., 'Image too blurry' or 'No prices found') in the service array. Never return an empty array.

Return ONLY valid JSON:

{
  "vehicle": {
    "year": string | null,
    "make": string | null,
    "model": string | null
  } | null,
  "shop_name": string | null,
  "services": [
    {
      "name": string,
      "price": number | null,
      "category": string
    }
  ]
}`
        };

        const allPayloads: any[] = [];

        for (let i = 0; i < uploads.length; i++) {
          const u = uploads[i];
          send({ status: "Deep Scan in Progress", message: `Loading file parts (${i + 1}/${uploads.length})...` });
          
          const filePath = u.file_url || "";
          const { data: fileData, error: dlError } = await supabase.storage.from('estimates').download(filePath);
          if (dlError || !fileData) {
            console.error("STORAGE DOWNLOAD FAILED:", dlError);
            throw new Error(`Failed to download uploaded file from storage: ${dlError?.message || "Unknown error"}`);
          }
          
          const buffer = Buffer.from(await fileData.arrayBuffer());
          const mimeType = filePath.toLowerCase().endsWith(".pdf") ? "application/pdf" : (filePath.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg");

          console.log(`=== FILE METADATA ===\nSource type: ${mimeType.includes("pdf") ? "pdf" : "image"}\nFilename: ${filePath}\nMime type: ${mimeType}\nSize: ${buffer.length}\n=====================`);

          if (mimeType.includes("pdf")) {
            // Extract text from PDF
            try {
              const pdfParseMod = await import("pdf-parse");
              const pdfParse: (buf: Buffer) => Promise<{ text: string }> = (pdfParseMod as any).default ?? pdfParseMod;
              const result = await pdfParse(buffer);
              if (result.text && result.text.length > 50) {
                 const cleanedText = cleanOCRText(result.text);
                 
                 console.log("=== RAW_EXTRACTED_TEXT (First 3000 chars) ===");
                 console.log(cleanedText.substring(0, 3000));
                 console.log("=============================================");

                 const chunkSize = 4000;
                 for (let c = 0; c < cleanedText.length; c += chunkSize) {
                    allPayloads.push({
                      type: "text",
                      text: `\n--- PDF CHUNK ---\n${cleanedText.slice(c, c + chunkSize)}\n--- END CHUNK ---\n`
                    });
                 }
              } else {
                 console.warn("PDF had no text.");
              }
            } catch (err) {
              console.warn("pdf-parse failed", err);
            }
          } else {
             const base64 = buffer.toString('base64');
             console.log("Payload Size:", base64.length);
             const actualMimeParams = mimeType;
             allPayloads.push({
               type: "image_url",
               image_url: { url: `data:${actualMimeParams};base64,${base64}`, detail: "high" }
             });
          }
        }

        const aggregatedData = {
          shopName: null as string | null,
          vehicle: { year: "", make: "", model: "" },
          services: [] as any[]
        };

        if (allPayloads.length === 0) {
          throw new Error("No files could be converted to image payloads. Check if upload failed or format is unsupported.");
        }

        const batchSize = 3;
        const totalBatches = Math.ceil(allPayloads.length / batchSize);

        for (let b = 0; b < allPayloads.length; b += batchSize) {
           const currentBatchNum = Math.floor(b / batchSize) + 1;
           const batchPayloads = allPayloads.slice(b, b + batchSize);
           
           send({ status: `Page ${currentBatchNum} of ${totalBatches} analyzed...`, message: `Initiating GPT-4o Extraction for Batch ${currentBatchNum}/${totalBatches}...` });

           console.log("=== LLM_INPUT_TEXT (Payload content preview) ===");
           console.log(JSON.stringify(batchPayloads).substring(0, 3000));
           console.log("================================================");

           const responseStream = await openai.chat.completions.create({
             model: 'gpt-4o',
             messages: [{ role: 'user', content: [systemInstruction as any, ...batchPayloads] }],
             response_format: { type: "json_object" },
             stream: true
           });

           let batchText = "";
           for await (const chunk of responseStream) {
             const text = chunk.choices[0]?.delta?.content || "";
             batchText += text;
             send({ chunk: text });
           }
           
           console.log("=== RAW_VISION_RESPONSE ===");
           console.log(batchText);
           console.log("DEBUG: GPT-4o Output", batchText);
           console.log("========================");
           
           let parsed: any;
           try {
             let content = batchText.trim();
             // Remove markdown code block wrappers if present
             content = content.replace(/^```json\s*/, "").replace(/\s*```$/, "");
             parsed = JSON.parse(content);
             
             console.log("=== PARSED_JSON ===");
             console.log(JSON.stringify(parsed, null, 2));
             console.log("=== SERVICES_BEFORE_FILTER ===", parsed.services);
             
           } catch (e) {
             console.error("❌ JSON PARSE FAILED");
             console.log("RAW CONTENT:", batchText);
             throw new Error("Vision JSON parsing failed");
           }
           
           if (!parsed.services || parsed.services.length === 0) {
             console.warn("⚠️ EMPTY SERVICES — injecting fallback");
             parsed.services = [{
               name: "Potential services detected",
               price: null,
               description: "Unable to confidently extract structured services",
               confidence: "low"
             }];
           }
           
           if (parsed.shop_name && !aggregatedData.shopName) aggregatedData.shopName = parsed.shop_name;
           if (parsed.vehicle && !aggregatedData.vehicle?.year) aggregatedData.vehicle = parsed.vehicle;
           if (parsed.services && Array.isArray(parsed.services)) {
             aggregatedData.services.push(...parsed.services);
           }
        }
        
        send({ status: "Complete", message: "Processing final data..." });

        await parseAndSaveFullJSON(caseId, aggregatedData);

        send({ status: "Complete", message: "Redirecting..." });
        controller.close();
      } catch (err: any) {
        console.error(err);
        send({ 
          error: err.message || "Failed to process scan.",
          openai_status: err.status || err.statusCode || 500 
        });
        controller.close();
      }
    }
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}

async function parseAndSaveFullJSON(caseId: string, data: any) {
  let shopName = data.shopName || "Unknown Shop";
  let vehicleInfo = data.vehicle || {};
  
  console.log("=== MAPPING SERVICES FOR DB ===");
  const items = (data.services || []).map((s: any, idx: number) => {
    if (typeof s === "string") return { case_id: caseId, raw_text: s, price: 0 };
    
    // Dynamically extract whatever keys GPT-4 decided to use
    const allStringVals = Object.values(s).filter(v => typeof v === "string");
    const synthesizedName = allStringVals.length > 0 ? allStringVals.join(" - ") : JSON.stringify(s);
    
    // Extract price safely by hunting for number values, or parsing strings
    let numericPrice = 0;
    for (const val of Object.values(s)) {
      if (typeof val === "number") { numericPrice = val; break; }
      if (typeof val === "string" && (val.includes("$") || /^\d+(\.\d{1,2})?$/.test(val))) {
         const parsed = parseFloat(val.replace(/[^\d.-]/g, ''));
         if (!isNaN(parsed)) { numericPrice = parsed; break; }
      }
    }
    
    console.log(`  [${idx}] Synthesized: "${synthesizedName}" | Price: ${numericPrice}`);

    return {
      case_id: caseId,
      raw_text: synthesizedName,
      price: numericPrice || s.price || 0
    };
  }).filter((s: any) => s.raw_text !== "{}");
  console.log(`=== TOTAL ITEMS PREPARED: ${items.length} ===`);

  const { error: caseErr } = await supabase.from("cases").update({
    shop_name: shopName,
    vehicle_year: String(vehicleInfo.year || ""),
    vehicle_make: String(vehicleInfo.make || ""),
    vehicle_model: String(vehicleInfo.model || ""),
    status: "processing"
  }).eq("id", caseId);
  if (caseErr) {
    console.error("DB CASE UPDATE_FAILED:", caseErr);
    throw new Error(`Database case update failed: ${caseErr.message}`);
  }

  if (items.length > 0) {
    const { error: insertErr } = await supabase.from("line_items").insert(items);
    if (insertErr) {
      console.error("DB LINE_ITEMS INSERT FAILED:", insertErr);
      throw new Error(`Database line_items insert failed: ${insertErr.message}`);
    }
  }
}
