// Server-only ingestion utilities (called only from API routes)

/**
 * WrenchCheck Unified Ingestion Pipeline
 * Handles: image files, PDF files, hosted URLs, pasted plain text
 * All paths produce the same NormalizedExtraction shape.
 */

import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ─── Types ────────────────────────────────────────────────────────────────────

export type SourceType = "image" | "pdf_text" | "pdf_vision" | "url" | "text";

export interface RawLineItem {
  description: string;
  price: number;
}

export interface NormalizedExtraction {
  source_type: SourceType;
  shop_name: string;
  shop_address: string | null;
  vehicle_info: {
    year?: string;
    make?: string;
    model?: string;
    vin?: string;
  };
  line_items: RawLineItem[];
  totals: {
    subtotal?: number;
    tax?: number;
    grand_total?: number;
  };
  observations: string[];
  raw_text?: string;
  confidence: "high" | "medium" | "low";
  error?: string;
}

// ─── Main entry point ─────────────────────────────────────────────────────────

export type IngestInput =
  | { type: "image"; buffer: Buffer; mimeType: string }
  | { type: "pdf";   buffer: Buffer }
  | { type: "url";   url: string }
  | { type: "text";  text: string };

export async function ingestEstimate(input: IngestInput): Promise<NormalizedExtraction> {
  switch (input.type) {
    case "image":
      return ingestImage(input.buffer, input.mimeType);
    case "pdf":
      return ingestPdf(input.buffer);
    case "url":
      return ingestUrl(input.url);
    case "text":
      return ingestText(input.text);
  }
}

// ─── Source Detection ─────────────────────────────────────────────────────────

export function detectSourceType(
  filename: string,
  mimeType: string
): "image" | "pdf" | "unknown" {
  const ext = filename.split(".").pop()?.toLowerCase() || "";
  if (["png", "jpg", "jpeg", "webp", "gif"].includes(ext)) return "image";
  if (ext === "pdf" || mimeType === "application/pdf") return "pdf";
  if (["png", "jpg", "jpeg", "webp"].some((e) => mimeType.includes(e))) return "image";
  return "unknown";
}

// ─── Shared GPT extraction prompt ─────────────────────────────────────────────

const EXTRACTION_SYSTEM_PROMPT = `You are an expert automotive repair estimate parser. Your ONLY job is to extract every service line item from the document.

CRITICAL RULES — NEVER BREAK THESE:
1. You MUST return at least one item in "line_items" OR "observations" if ANY text about vehicle services exists.
2. NEVER return an empty "line_items" array if you can see service names, prices, or repair descriptions.
3. Extract EVERYTHING: named services, "Recommended Service" headers, diagnostic notes, parts, labor — all of it.
4. If a price is unclear or missing, set it to 0. Never skip a service because the price is unclear.
5. For images: read every visible line of text, including handwritten notes, headers, and totals.
6. If the document mentions dollar amounts like "$X.XX", those are prices — extract them with their associated service name.

Return this exact JSON shape:
{
  "shop_name": "string or null",
  "shop_address": "string or null",
  "vehicle_info": { "year": "string or null", "make": "string or null", "model": "string or null", "vin": "string or null" },
  "line_items": [{ "description": "string", "price": number }],
  "totals": { "subtotal": number or null, "tax": number or null, "grand_total": number or null },
  "observations": ["string — any diagnostic note, recommendation, or concern that didn't have a standalone price"],
  "confidence": "high" | "medium" | "low"
}

MANDATORY: If no line_items exist but you can see service text or recommendations, put those in "observations".
FORBIDDEN: Returning { "line_items": [], "observations": [] } if ANY automotive text is visible.`;

// ─── Image extractor ──────────────────────────────────────────────────────────

async function ingestImage(
  buffer: Buffer,
  mimeType: string
): Promise<NormalizedExtraction> {
  const base64 = buffer.toString("base64");
  const dataUrl = `data:${mimeType};base64,${base64}`;

  const completion = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [
      { role: "system", content: EXTRACTION_SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          { type: "text", text: "Extract all estimate data from this image." },
          { type: "image_url", image_url: { url: dataUrl, detail: "high" } },
        ],
      },
    ],
    response_format: { type: "json_object" },
    max_tokens: 2000,
  });

  return parseGptResponse(completion.choices[0].message.content, "image");
}

// ─── PDF extractor ────────────────────────────────────────────────────────────

async function ingestPdf(buffer: Buffer): Promise<NormalizedExtraction> {
  // Step 1: Try text extraction
  let extractedText = "";
  try {
    // pdf-parse ships CJS, dynamic import wraps it
    const pdfParseMod = await import("pdf-parse");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pdfParse: (buf: Buffer) => Promise<{ text: string }> = (pdfParseMod as any).default ?? pdfParseMod;
    const result = await pdfParse(buffer);
    extractedText = result.text?.trim() || "";
  } catch (err) {
    console.warn("[ingest] pdf-parse failed, falling back to vision:", err);
  }

  // Step 2: If text extraction yielded meaningful content (>100 chars with digits), use text path
  const hasUsefulText = extractedText.length > 100 && /\d+\.\d{2}/.test(extractedText);
  if (hasUsefulText) {
    console.log(`[ingest] PDF text extraction successful: ${extractedText.length} chars`);
    const result = await ingestText(extractedText);
    return { ...result, source_type: "pdf_text", raw_text: extractedText };
  }

  // Step 3: Fallback — send first page as base64 image via vision
  console.log("[ingest] PDF text weak, using vision fallback on raw PDF bytes");
  try {
    // gpt-4o can receive PDFs as base64 file inputs for vision analysis
    const base64 = buffer.toString("base64");
    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        { role: "system", content: EXTRACTION_SYSTEM_PROMPT },
        {
          role: "user",
          content: [
            { type: "text", text: "This is a PDF estimate. Extract all data from it." },
            {
              type: "image_url",
              image_url: {
                url: `data:application/pdf;base64,${base64}`,
                detail: "high",
              },
            },
          ],
        },
      ],
      response_format: { type: "json_object" },
      max_tokens: 2000,
    });
    return parseGptResponse(completion.choices[0].message.content, "pdf_vision");
  } catch (visionErr: any) {
    // Last resort: send extracted text even if weak
    if (extractedText.length > 30) {
      console.warn("[ingest] Vision fallback failed, using weak text:", visionErr.message);
      const result = await ingestText(extractedText);
      return { ...result, source_type: "pdf_text", confidence: "low", raw_text: extractedText };
    }
    throw new Error(
      "We couldn't read this PDF. Try uploading a screenshot or copy-pasting the estimate text."
    );
  }
}

// ─── URL extractor ────────────────────────────────────────────────────────────

export async function ingestUrl(url: string): Promise<NormalizedExtraction> {
  let html = "";
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; WrenchCheck/1.0)",
        Accept: "text/html,application/xhtml+xml",
      },
      signal: AbortSignal.timeout(12000),
      redirect: "follow",
    });

    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        throw new Error(
          "We couldn't read this hosted estimate — it requires a login. Please upload a screenshot or PDF instead."
        );
      }
      throw new Error(
        `We couldn't reach that URL (status ${res.status}). Please upload a screenshot or PDF instead.`
      );
    }

    const contentType = res.headers.get("content-type") || "";
    if (contentType.includes("application/pdf")) {
      const pdfBuffer = Buffer.from(await res.arrayBuffer());
      return ingestPdf(pdfBuffer);
    }

    html = await res.text();
  } catch (err: any) {
    if (err.message.includes("couldn't")) throw err;
    if (err.name === "TimeoutError") {
      throw new Error(
        "That URL took too long to respond. Please upload a screenshot or PDF instead."
      );
    }
    throw new Error(
      "We couldn't read this hosted estimate. Please upload a screenshot or PDF instead."
    );
  }

  // Strip HTML tags, decode entities, collapse whitespace
  const visibleText = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();

  if (visibleText.length < 50) {
    throw new Error(
      "We couldn't extract enough content from that URL. Please upload a screenshot or PDF instead."
    );
  }

  // Check for price-like content
  if (!/\$\d|\d+\.\d{2}/.test(visibleText)) {
    throw new Error(
      "That page doesn't appear to contain an estimate. Please upload a screenshot or PDF instead."
    );
  }

  const result = await ingestText(visibleText.slice(0, 8000)); // cap tokens
  return { ...result, source_type: "url" };
}

// ─── Plain text extractor ─────────────────────────────────────────────────────

async function ingestText(text: string): Promise<NormalizedExtraction> {
  if (!text || text.trim().length < 10) {
    throw new Error(
      "The estimate text is too short to analyze. Please paste the full estimate content."
    );
  }

  const completion = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [
      { role: "system", content: EXTRACTION_SYSTEM_PROMPT },
      {
        role: "user",
        content: `Extract estimate data from this text:\n\n${text.slice(0, 10000)}`,
      },
    ],
    response_format: { type: "json_object" },
    max_tokens: 2000,
    temperature: 0.1,
  });

  return parseGptResponse(completion.choices[0].message.content, "text");
}

// ─── GPT response parser ──────────────────────────────────────────────────────

function parseGptResponse(
  content: string | null,
  sourceType: SourceType
): NormalizedExtraction {
  try {
    const parsed = JSON.parse(content || "{}");
    return {
      source_type: sourceType,
      shop_name: parsed.shop_name || "Unknown Shop",
      shop_address: parsed.shop_address || null,
      vehicle_info: {
        year: parsed.vehicle_info?.year || undefined,
        make: parsed.vehicle_info?.make || undefined,
        model: parsed.vehicle_info?.model || undefined,
        vin: parsed.vehicle_info?.vin || undefined,
      },
      line_items: Array.isArray(parsed.line_items) ? parsed.line_items : [],
      totals: {
        subtotal: parsed.totals?.subtotal ?? undefined,
        tax: parsed.totals?.tax ?? undefined,
        grand_total: parsed.totals?.grand_total ?? undefined,
      },
      observations: Array.isArray(parsed.observations) ? parsed.observations : [],
      confidence: parsed.confidence || "medium",
    };
  } catch (err) {
    console.error("[ingest] Failed to parse GPT response:", content);
    return {
      source_type: sourceType,
      shop_name: "Unknown Shop",
      shop_address: null,
      vehicle_info: {},
      line_items: [],
      totals: {},
      observations: [],
      confidence: "low",
      error: "Extraction returned an unreadable response. Please try again.",
    };
  }
}
