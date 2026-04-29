/**
 * lib/sellerIntelligence.ts
 *
 * Five-profile seller classification for the Deal Navigator.
 * Zero LLM calls — pure heuristic from listing data already in the DB.
 * The context shapes negotiation approach, leverage signals, and risk flags.
 */

export type SellerProfile =
  | 'national_lot'      // Carvana, EchoPark, CarMax, Hertz, Vroom — algo-priced
  | 'franchise_dealer'  // BMW of Denver, Toyota of Somewhere — OEM brand + City
  | 'independent_dealer'// Generic lot, no OEM affiliation
  | 'private_party'     // Individual seller
  | 'auction'           // BaT, Copart, IAAI, tow yard, C&B
  | 'unknown';

export interface SellerIntel {
  profile: SellerProfile;
  label: string;               // Display label: "HIGH-VOLUME NATIONAL LOT"
  emoji: string;               // UI icon
  motivationRead: string;      // "Motivated" | "Likely Flexible" | "Holding Firm" | "Unknown"
  motivationColor: string;     // CSS color for motivation badge
  negotiationApproach: string; // One sharp sentence on HOW to negotiate
  greenFlags: string[];        // Positive signals for this seller type
  redFlags: string[];          // Watch-out signals for this seller type
  daysOnMarketSignal: string | null; // Contextual read on DOM (null if unknown)
}

// ─── National Lot Detection ────────────────────────────────────────────────────
const NATIONAL_LOT_PATTERNS = [
  /\bcarvana\b/i, /\bechoparkb\b/i, /\bechodepot\b/i, /\bcarmax\b/i,
  /\bhertz\b/i, /\bvroom\b/i, /\bautos direct\b/i, /\bautotrader\b/i,
  /\bshift\b/i, /\bdrive time\b/i, /\bdrivetime\b/i, /\brichmond ford\b/i,
  /^carvana/i, /^echop/i, /^carmax/i,
];

const FRANCHISE_DEALER_MAKES = [
  'toyota','honda','ford','chevrolet','chevy','gmc','dodge','ram','jeep',
  'subaru','mazda','nissan','hyundai','kia','volkswagen','vw','bmw',
  'mercedes','audi','lexus','infiniti','acura','volvo','jaguar','land rover',
  'porsche','cadillac','buick','lincoln','genesis','mitsubishi','chrysler',
];

const FRANCHISE_PATTERNS = [
  // "BMW of Denver", "Toyota of Colorado Springs", "Lexus of Bellevue"
  new RegExp(`(${FRANCHISE_DEALER_MAKES.join('|')})\\s+(of|auto|motor|cars|city|direct|world|nation)`, 'i'),
  // "Denver BMW", "Schomp Honda"
  new RegExp(`(of|automotive|auto|motors?|dealer|dealership|group)`, 'i'),
];

const AUCTION_PATTERNS = [
  /\bcopart\b/i, /\biaai\b/i, /\bbring a trailer\b/i, /\bbringatrailer\b/i,
  /\bcars \u0026 bids\b/i, /\bcarsandbids\b/i, /\bmanheim\b/i, /\bdickensheet\b/i,
  /\bauction\b/i, /\btow yard\b/i, /\bimpound\b/i,
];

// ─── URL-based Platform Detection ─────────────────────────────────────────────
function detectFromUrl(url: string): SellerProfile | null {
  const u = url.toLowerCase();
  if (/carvana\.com|echoparkautomotive|carmax\.com|hertz\.com\/vehicle|vroom\.com/.test(u)) return 'national_lot';
  if (/copart\.com|iaai\.com|bringatrailer\.com|carsandbids\.com|manheim\.com|dickensheet\.com/.test(u)) return 'auction';
  return null;
}

// ─── Days-on-Market Signal ─────────────────────────────────────────────────────
function getDomSignal(dom: number | null, profile: SellerProfile): string | null {
  if (dom === null) return null;
  if (profile === 'private_party') {
    if (dom <= 7)  return `Listed ${dom}d ago — fresh listing, minimal pressure`;
    if (dom <= 21) return `${dom} days live — still early, seller not desperate`;
    if (dom <= 45) return `${dom} days on market — starting to feel it. Good leverage window.`;
    return `${dom} days — a private seller sitting this long is motivated. Play it.`;
  }
  if (profile === 'national_lot' || profile === 'franchise_dealer') {
    if (dom <= 14) return `${dom} days on lot — normal aging, no urgency yet`;
    if (dom <= 30) return `${dom} days on lot — approaching carrying cost threshold`;
    if (dom <= 60) return `${dom} days on lot — floorplan cost is real now. Counter hard.`;
    return `${dom}+ days — this is a problem unit for them. Maximum leverage.`;
  }
  if (dom > 30) return `${dom} days listed — extended time on market is your leverage`;
  return `Listed ${dom} days ago`;
}

// ─── Main Classifier ───────────────────────────────────────────────────────────
export function classifySellerIntel(options: {
  sellerType: 'dealer' | 'private' | 'auction' | null;
  sellerName: string | null;
  listingUrl: string | null;
  daysOnMarket: number | null;
}): SellerIntel {
  const { sellerType, sellerName, listingUrl, daysOnMarket } = options;
  const name = (sellerName || '').toLowerCase();
  const url  = (listingUrl  || '').toLowerCase();

  // ── Determine profile ────────────────────────────────────────────────────────
  let profile: SellerProfile = 'unknown';

  // URL is the strongest signal
  const urlProfile = listingUrl ? detectFromUrl(listingUrl) : null;
  if (urlProfile) {
    profile = urlProfile;
  } else if (sellerType === 'private') {
    profile = 'private_party';
  } else if (sellerType === 'auction') {
    profile = 'auction';
  } else if (sellerType === 'dealer' || sellerName) {
    // Disambiguate dealer sub-types
    if (NATIONAL_LOT_PATTERNS.some(p => p.test(name))) {
      profile = 'national_lot';
    } else if (AUCTION_PATTERNS.some(p => p.test(name))) {
      profile = 'auction';
    } else {
      // Check for franchise signal: OEM brand + [of / city name / dealer word]
      const hasMakeName = FRANCHISE_DEALER_MAKES.some(m => name.includes(m));
      const hasDealerWord = /\b(of|automotive|motors?|auto|dealer|group)\b/i.test(name);
      profile = hasMakeName || hasDealerWord ? 'franchise_dealer' : 'independent_dealer';
    }
  }

  const domSignal = getDomSignal(daysOnMarket, profile);

  // ── Profile-specific intelligence ───────────────────────────────────────────
  switch (profile) {
    case 'national_lot':
      return {
        profile, emoji: '🏭',
        label: 'HIGH-VOLUME NATIONAL LOT',
        motivationRead: daysOnMarket != null && daysOnMarket > 30 ? 'Motivated' : 'Likely Flexible',
        motivationColor: daysOnMarket != null && daysOnMarket > 30 ? '#15803D' : '#D97706',
        negotiationApproach: 'Prices are algorithm-set — counter with specific comps from market median. Ask for OTD price upfront; doc fees and add-ons are the real margin.',
        greenFlags: [
          'Large inventory pressures them to move units',
          'Standardized process — no emotional anchoring',
          'Returns/remorse windows sometimes negotiable',
        ],
        redFlags: [
          'Prices rarely below algorithm floor without comp evidence',
          'Add-on products (warranty, protection) are high-margin traps',
          'Inspection limited — no lot test drives at some locations',
        ],
        daysOnMarketSignal: domSignal,
      };

    case 'franchise_dealer':
      return {
        profile, emoji: '🏪',
        label: 'FRANCHISE DEALER',
        motivationRead: daysOnMarket != null && daysOnMarket > 45 ? 'Motivated' : 'Holding Firm',
        motivationColor: daysOnMarket != null && daysOnMarket > 45 ? '#15803D' : '#DC2626',
        negotiationApproach: 'Invoice + holdback is the real floor. End of month = real urgency. Lead with a specific comp-based counter, not a percentage off.',
        greenFlags: [
          'CPO certification possible if same brand as lot',
          'Documented service records often available for trade-ins',
          'Known accountability — licensed, bonded, BBB pressure',
        ],
        redFlags: [
          'Finance office adds margin through rate markup and F&I products',
          'Manager games (the "let me check with my manager" play) are choreographed',
          'Holding charge if you leave and come back',
        ],
        daysOnMarketSignal: domSignal,
      };

    case 'independent_dealer':
      return {
        profile, emoji: '🔑',
        label: 'INDEPENDENT DEALER',
        motivationRead: 'Unknown — probe first',
        motivationColor: '#6B7280',
        negotiationApproach: 'Ask about their cost basis directly. As-is risk is highest here — get specific written disclosures. A PPI is worth the cost.',
        greenFlags: [
          'More price flexibility than franchise lots',
          'Smaller operation = owner often on site and empowered to deal',
          'May have specialty inventory not found on big lots',
        ],
        redFlags: [
          'As-is sales common — no recourse after purchase',
          'Service history often gaps — ask explicitly',
          'Title laundering risk is higher at small independent lots',
        ],
        daysOnMarketSignal: domSignal,
      };

    case 'private_party':
      return {
        profile, emoji: '👤',
        label: 'PRIVATE PARTY',
        motivationRead: daysOnMarket != null && daysOnMarket > 28
          ? 'Growing Motivation'
          : 'Emotionally Anchored',
        motivationColor: daysOnMarket != null && daysOnMarket > 28 ? '#D97706' : '#DC2626',
        negotiationApproach: 'Ask why they\'re selling before any numbers. Their answer tells you everything about timeline and flexibility. Emotional connection to the car = price anchor; life event (relocation, upgrade) = real motivation.',
        greenFlags: [
          'No dealer markup — true market price discovery',
          'Often know the car\'s real history first-hand',
          'More candid about issues than a dealer incentivized to hide them',
        ],
        redFlags: [
          'No warranty, no recourse — what you see is what you get',
          'May have deferred maintenance they\'re motivated to pass off',
          'Emotional anchoring on price can make negotiation slow',
        ],
        daysOnMarketSignal: domSignal,
      };

    case 'auction':
      return {
        profile, emoji: '🔨',
        label: 'AUCTION UNIT',
        motivationRead: 'Price is the market',
        motivationColor: '#7C3AED',
        negotiationApproach: 'No negotiation after the hammer. Do your bid ceiling math before: (fair value) − (transport $500–1,500) − (recon estimate $300–1,000) − (your risk premium) = max bid.',
        greenFlags: [
          'Transparent price discovery — market sets fair value in real time',
          'BaT/C&B: documented provenance often excellent',
          'Buyer\'s premium is known upfront — no hidden fees',
        ],
        redFlags: [
          'No test drive, no inspection at Copart/IAAI tow yard units',
          'Unknown mechanical state on tow yard — budget for surprises',
          'Transport costs are real and non-negotiable add-ons',
        ],
        daysOnMarketSignal: null,
      };

    default:
      return {
        profile: 'unknown', emoji: '❓',
        label: 'SELLER UNKNOWN',
        motivationRead: 'Unknown',
        motivationColor: '#6B7280',
        negotiationApproach: 'Establish seller type before engaging — ask directly whether this is a dealer or private sale. Changes the entire approach.',
        greenFlags: [],
        redFlags: ['Seller classification unavailable — proceed cautiously'],
        daysOnMarketSignal: domSignal,
      };
  }
}
