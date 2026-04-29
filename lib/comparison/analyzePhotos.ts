// lib/comparison/analyzePhotos.ts
// GPT-4o Vision — comprehensive condition + mechanical area assessment.
// Returns letter grade A–D, red flags, positives, and mechanical area coverage.

import OpenAI from "openai";

export type PhotoGrade = "A" | "B+" | "B" | "C+" | "C" | "D";

export type PhotoConditionReport = {
  grade: PhotoGrade;
  gradeLabel: string;           // "Excellent — garage kept, clean throughout"
  exterior: string | null;      // specific exterior observations
  interior: string | null;      // specific interior observations
  engineBay: string | null;     // engine bay observations
  undercarriage: string | null; // undercarriage / frame rail observations
  suspension: string | null;    // suspension components visible in wheel wells
  redFlags: string[];           // specific issues — named, precise
  positives: string[];          // specific positives
  mileageConsistency: "consistent" | "inconsistent" | "unverifiable";
  sellerContext: "dealer" | "private" | "unknown";
  backgroundNotes: string | null;
  // Coverage mapping — what mechanical areas were actually photographed
  mechanicalCoverage: {
    engineBayVisible: boolean;
    undercarriageVisible: boolean;
    suspensionVisible: boolean;
    odometerVisible: boolean;
    frameRailsVisible: boolean;
  };
  missingAreas: string[]; // areas not photographed — "Engine bay not shown", etc.
  mechanicalFlags: string[]; // specific mechanical observations: "Oil residue at valve cover", "Surface rust on frame rail"
};

/**
 * Run vision analysis on up to 7 listing photos.
 * All photos in one AI call for efficiency.
 * Accepts either raw URLs or base64 buffers.
 */
export async function analyzeListingPhotos(
  images: (string | { buffer: Buffer; mimeType: string })[]
): Promise<PhotoConditionReport | null> {
  if (!images.length) return null;

  const photos = images.slice(0, 7);
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const imageContent = photos.map((img) => ({
    type: "image_url" as const,
    image_url: {
      url: typeof img === "string" ? img : `data:${img.mimeType};base64,${img.buffer.toString("base64")}`,
      detail: "high" as const,
    },
  }));

  const prompt = `You are an expert automotive condition inspector reviewing used car listing photos. Your job is to give a buyer the kind of assessment a professional mechanic would give after a walkaround inspection.

GRADE SCALE:
- A: Exceptional for age. No visible issues. Clearly well-maintained.
- B+: Very good. Minor cosmetic items only. Would pass any PPI.
- B: Good overall. Wear consistent with age/miles. Nothing alarming.
- C+: Average. Visible wear, some deferred maintenance signals. Negotiate.
- C: Below average. Multiple issues visible. Significant discount warranted.
- D: Major concerns. Do not buy without thorough inspection and heavy discount.

LOOK SPECIFICALLY FOR:
EXTERIOR: Rust (surface vs. structural), paint fade, mismatched panels (sign of accident repair), ripples in body lines, dents, cracked lenses, tire condition
INTERIOR: Seat wear inconsistent with mileage, cracked dash, headliner sag, stains, worn steering wheel, broken trim
ENGINE BAY: Oil residue / leaks at valve covers / gaskets, coolant staining, crack in overflow tank, battery corrosion, aftermarket modifications, general cleanliness
UNDERCARRIAGE / FRAME RAILS: If any photos show beneath the car — look for rust perforation, frame welds, subframe condition, exhaust leaks
SUSPENSION: Look in wheel wells for control arm rust, shock condition, CV boot tears, brake rotor thickness
ODOMETER: If visible, note reading and whether it aligns with claimed mileage
BACKGROUND: Garage keeps → better. Dealer lot, street parked, storage yard each tell a different story.
RED FLAGS: Overspray on trim (masked respray = accident), misaligned panels (body work), fresh undercoating (hiding rust), touch-up paint spots

Respond ONLY with this exact JSON (no markdown):
{
  "grade": "B+",
  "gradeLabel": "Very good condition — maintained, minor cosmetic wear",
  "exterior": "Clean paint, no rust or mismatch. Small stone chips on hood. Tires 70% tread.",
  "interior": "Light seat wear appropriate for mileage. Steering wheel shows normal wear. No cracks.",
  "engineBay": "Clean overall. Minor oil residue at valve cover — normal for age. Stock configuration.",
  "undercarriage": null,
  "suspension": "Rotors visible in front — adequate thickness. No visible CV boot tears.",
  "redFlags": ["Driver bolster wear heavier than expected for stated 55k miles", "Touch-up paint spot near rear bumper corner"],
  "positives": ["Garage kept based on background", "Undercarriage partially visible — no structural rust", "Recent tires"],
  "mileageConsistency": "consistent",
  "sellerContext": "private",
  "backgroundNotes": "Residential garage — consistent with private owner story.",
  "mechanicalCoverage": {
    "engineBayVisible": true,
    "undercarriageVisible": false,
    "suspensionVisible": true,
    "odometerVisible": false,
    "frameRailsVisible": false
  },
  "missingAreas": ["Undercarriage not photographed — request seller to jack up and photograph frame rails", "Odometer not shown"],
  "mechanicalFlags": ["Minor oil residue at valve cover", "Touch-up paint rear bumper corner"]
}`;

  try {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 35000);

    const resp = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [{
        role: "user",
        content: [
          { type: "text", text: prompt },
          ...imageContent,
        ],
      }],
      max_tokens: 800,
      temperature: 0.1,
      response_format: { type: "json_object" },
    }, { signal: abort.signal });

    clearTimeout(timer);

    const raw = JSON.parse(resp.choices[0].message.content ?? "{}");

    return {
      grade: (raw.grade ?? "C") as PhotoGrade,
      gradeLabel: raw.gradeLabel ?? "Photos analyzed",
      exterior: raw.exterior ?? null,
      interior: raw.interior ?? null,
      engineBay: raw.engineBay ?? null,
      undercarriage: raw.undercarriage ?? null,
      suspension: raw.suspension ?? null,
      redFlags: Array.isArray(raw.redFlags) ? raw.redFlags : [],
      positives: Array.isArray(raw.positives) ? raw.positives : [],
      mileageConsistency: raw.mileageConsistency ?? "unverifiable",
      sellerContext: raw.sellerContext ?? "unknown",
      backgroundNotes: raw.backgroundNotes ?? null,
      mechanicalCoverage: {
        engineBayVisible: raw.mechanicalCoverage?.engineBayVisible ?? false,
        undercarriageVisible: raw.mechanicalCoverage?.undercarriageVisible ?? false,
        suspensionVisible: raw.mechanicalCoverage?.suspensionVisible ?? false,
        odometerVisible: raw.mechanicalCoverage?.odometerVisible ?? false,
        frameRailsVisible: raw.mechanicalCoverage?.frameRailsVisible ?? false,
      },
      missingAreas: Array.isArray(raw.missingAreas) ? raw.missingAreas : [],
      mechanicalFlags: Array.isArray(raw.mechanicalFlags) ? raw.mechanicalFlags : [],
    };
  } catch (err) {
    console.warn("[analyzePhotos] failed:", err instanceof Error ? err.message : err);
    return null;
  }
}

/** Grade → numeric for ranking */
export function gradeToScore(grade: PhotoGrade): number {
  return { A: 6, "B+": 5, B: 4, "C+": 3, C: 2, D: 1 }[grade] ?? 0;
}

/** Color coding for grade badge */
export function gradeColors(grade: PhotoGrade) {
  if (grade === "A")  return { bg: "#F0FDF4", color: "#15803D", border: "#86EFAC" };
  if (grade === "B+") return { bg: "#F0FDF4", color: "#15803D", border: "#86EFAC" };
  if (grade === "B")  return { bg: "#EFF6FF", color: "#1D4ED8", border: "#BFDBFE" };
  if (grade === "C+") return { bg: "#FFFBEB", color: "#B45309", border: "#FDE68A" };
  if (grade === "C")  return { bg: "#FFFBEB", color: "#B45309", border: "#FDE68A" };
  return               { bg: "#FEF2F2", color: "#B91C1C", border: "#FECACA" };
}
