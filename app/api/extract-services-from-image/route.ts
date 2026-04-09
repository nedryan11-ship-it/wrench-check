import { NextResponse } from 'next/server';
import OpenAI from 'openai';
import sharp from 'sharp';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const systemPrompt = `
You are an expert automotive auditor. I am providing an image of a service estimate. You MUST extract all text. If no services are found, return a JSON object explaining WHY (e.g., 'Image too blurry' or 'No prices found') in the service array. Never return an empty array.

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
}
`;

export async function POST(req: Request) {
  try {
    const formData = await req.formData();
    const file = formData.get("file") as File;
    
    if (!file) {
      return NextResponse.json({ error: "No image file provided." }, { status: 400 });
    }

    const mimeType = file.type || '';
    console.log('MIME Type detected:', mimeType);
    if (!mimeType.includes("image")) {
      return NextResponse.json({ error: "Provided file is not an image." }, { status: 400 });
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const base64 = buffer.toString('base64');

    async function performExtraction(imagePayloads: any[]) {
      const response = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
           { role: 'system', content: systemPrompt },
           { role: 'user', content: imagePayloads }
        ],
        response_format: { type: "json_object" }
      });
      console.log("=== OPENAI FULL JSON RESPONSE ===");
      console.log(JSON.stringify(response, null, 2));
      
      return response.choices[0]?.message?.content || "{}";
    }

    let rawContent = await performExtraction([
       { 
           type: "image_url", 
           image_url: { url: `data:${mimeType};base64,${base64}`, detail: "high" } 
       }
    ]);
    
    console.log("=== RAW_VISION_RESPONSE ===");
    console.log(rawContent);
    
    let parsed: any;
    try {
      let content = rawContent.trim();
      
      // strip markdown fences if present
      content = content.replace(/```json/g, "").replace(/```/g, "");
      
      parsed = JSON.parse(content);
      
      console.log("=== PARSED_JSON ===");
      console.log(parsed);
      console.log("=== SERVICES_BEFORE_FILTER ===", parsed.services);
      
    } catch (e) {
      console.error("❌ JSON PARSE FAILED");
      console.log("RAW CONTENT:", rawContent);
      
      // DO NOT silently fallback
      throw new Error("Vision JSON parsing failed");
    }

    if (!parsed.services || parsed.services.length === 0) {
      console.warn("⚠️ EMPTY SERVICES ON FIRST PASS — executing 4 quadrant fallback");

      try {
        const metadata = await sharp(buffer).metadata();
        const width = metadata.width || 0;
        const height = metadata.height || 0;
        
        const qW = Math.floor(width / 2);
        const qH = Math.floor(height / 2);

        if (width > 0 && height > 0) {
          const quadrants = [
            { left: 0, top: 0, width: qW, height: qH },
            { left: qW, top: 0, width: width - qW, height: qH },
            { left: 0, top: qH, width: qW, height: height - qH },
            { left: qW, top: qH, width: width - qW, height: height - qH }
          ];

          const splitPayloads = await Promise.all(quadrants.map(async (q) => {
             const qBuffer = await sharp(buffer).extract(q).toBuffer();
             return {
                 type: "image_url",
                 image_url: { url: `data:${mimeType};base64,${qBuffer.toString('base64')}`, detail: "high" }
             };
          }));
          
          console.log("=== EXECUTING QUADRANT EXTRACTION ===");
          rawContent = await performExtraction(splitPayloads);
          
          const cleanQJson = rawContent.trim().replace(/```json/g, "").replace(/```/g, "");
          parsed = JSON.parse(cleanQJson);
          console.log("=== QUADRANT PARSED_JSON ===", parsed);
        }
      } catch (fallbackErr) {
        console.error("Quadrant fallback failed:", fallbackErr);
      }

      if (!parsed.services || parsed.services.length === 0) {
        console.warn("⚠️ STILL EMPTY AFTER QUADRANT FALLBACK — injecting fallback stub");
        parsed.services = [{
          name: "Potential services detected",
          price: null,
          description: "Unable to confidently extract structured services",
          confidence: "low"
        }];
      }
    }

    return NextResponse.json({
      vehicle: parsed.vehicle || null,
      shop: parsed.shop_name || null,
      services: parsed.services || []
    });

  } catch (err: any) {
    console.error("[/api/extract-services-from-image] error:", err);
    return NextResponse.json({ 
       error: err.message || "Failed to extract from image.",
       openai_status: err.status || err.statusCode || 500
    }, { status: 500 });
  }
}
