// ─────────────────────────────────────────────────────────────────────────────
// evaluateFollowUp — Post-conversation decision engine
// Takes original item context + user's follow-up answers from the shop
// Returns an updated verdict: approve | wait | second_opinion
// ─────────────────────────────────────────────────────────────────────────────

export async function evaluateFollowUp({
  item,
  followUp,
  shopContext
}: {
  item: {
    normalized_name: string;
    raw_text: string;
    price: number;
    price_position: string;
    urgency: string;
    flag_reason: string;
  };
  followUp: {
    severity: string;        // '1'|'2'|'3'|'4'|'5'|'not_sure'
    reasoning: string;       // 'mileage'|'visible_wear'|'leak_failure'|'symptoms'|'couldnt_explain'
    waitRisk: string;        // 'safe'|'might_worsen'|'could_damage'|'didnt_say'|'not_sure'
    notes: string;
  };
  shopContext?: {
    shop_grade?: string;
    quality_premium_allowed?: boolean;
    rating?: number;
  };
}): Promise<{
  verdict: 'approve' | 'wait' | 'second_opinion';
  recommendation: string;
  confidence: 'high' | 'medium' | 'low';
  explanation: string;
  next_step: string;
}> {
  const { severity, reasoning, waitRisk, notes } = followUp;
  const shopGrade = shopContext?.shop_grade || 'B';
  const itemName = item.normalized_name === 'Uncategorized Service' || item.normalized_name === 'Unclassified Service'
    ? item.raw_text
    : item.normalized_name;

  const sevNum = severity === 'not_sure' ? 0 : parseInt(severity) || 0;
  const isLowSev = sevNum > 0 && sevNum <= 2;
  const isHighSev = sevNum >= 4;
  const isMidSev = sevNum === 3;
  const isMileage = reasoning === 'mileage';
  const isPhysical = reasoning === 'visible_wear' || reasoning === 'leak_failure';
  const isLeak = reasoning === 'leak_failure';
  const isSymptoms = reasoning === 'symptoms';
  const couldntExplain = reasoning === 'couldnt_explain';
  const safeWait = waitRisk === 'safe';
  const mightWorsen = waitRisk === 'might_worsen';
  const couldDamage = waitRisk === 'could_damage';
  const aboveMarket = item.price_position === 'above_market';

  // ─────────────────────────────────────────────────────
  // RULE-BASED FAST PATH
  // ─────────────────────────────────────────────────────

  // Rule 1: Shop couldn't explain → always a red flag
  if (couldntExplain) {
    return {
      verdict: 'second_opinion',
      recommendation: "Get a second opinion before approving.",
      confidence: 'high',
      explanation: "If the shop couldn't clearly explain why this service is needed, that's a red flag. A reputable mechanic should always have a specific, evidence-based reason — not just a gut feel or schedule.",
      next_step: `Call one other shop and describe the ${itemName}. If they agree it's needed and can explain why, proceed. If not, decline until you have a clearer answer.`
    };
  }

  // Rule 2: Low severity + mileage trigger + safe to wait → postpone
  if ((isLowSev || severity === 'not_sure') && isMileage && (safeWait || waitRisk === 'not_sure' || waitRisk === 'didnt_say')) {
    return {
      verdict: 'wait',
      recommendation: "Safe to postpone — add it to your next service visit.",
      confidence: 'high',
      explanation: `Low severity and mileage-based triggers usually mean there's no active problem yet — just a scheduled interval recommendation. Since they said it's safe to wait, there's no real downside to delaying.`,
      next_step: `Decline for now and note it for your next scheduled service. If you start noticing ${itemName.toLowerCase().includes('fluid') ? 'any leaks, vibration, or handling changes' : 'any symptoms or warning lights'}, come back sooner.`
    };
  }

  // Rule 3: High severity + physical evidence + real wait risk → approve
  if (isHighSev && isPhysical && (couldDamage || mightWorsen)) {
    return {
      verdict: 'approve',
      recommendation: "The shop's explanation checks out — this is likely worth doing now.",
      confidence: 'high',
      explanation: `High severity with physical evidence (not just a mileage trigger) and a genuine risk if delayed is the right combination to act on. The mechanic's reasoning holds up.${shopGrade === 'A' ? " And given this shop's strong reputation, quality work is a reasonable expectation." : ''}`,
      next_step: `Approve the ${itemName}.${ aboveMarket && shopGrade !== 'A' ? ` The price is above market — it's worth quickly asking if they can come down slightly, but don't let the quote expire over a moderate delta.` : '' }`
    };
  }

  // Rule 4: Urgent leak + any wait risk → approve regardless of price
  if (isLeak && isHighSev) {
    return {
      verdict: 'approve',
      recommendation: "An active leak warrants immediate attention.",
      confidence: 'high',
      explanation: "Observed leaks or failures are not routine — they're active problems. Delaying a diagnosed leak can lead to cascading damage that costs significantly more to fix.",
      next_step: `Approve the repair. If the price seems high, ask them to show you the problem on the lift before signing off — but don't delay getting it fixed.`
    };
  }

  // Rule 5: Low severity + physical evidence + safe to wait → low priority proceed
  if (isLowSev && isPhysical && safeWait) {
    return {
      verdict: 'wait',
      recommendation: "Minor wear noted — you can schedule this without urgency.",
      confidence: 'medium',
      explanation: "There is visible evidence of wear, but severity is low and delaying is safe. This is the kind of thing to keep an eye on but doesn't need to happen today.",
      next_step: `Ask when they'd recommend revisiting it if you wait. Schedule it for your next service unless symptoms appear.`
    };
  }

  // Rule 6: Moderate + physical + could damage → soft approval
  if (isMidSev && isPhysical && couldDamage) {
    return {
      verdict: 'approve',
      recommendation: "I'd lean toward doing this — the risk of waiting is real.",
      confidence: 'medium',
      explanation: `Moderate severity with physical evidence and a real damage risk is worth acting on${aboveMarket ? ", even if the price is above market" : ""}. You're not at crisis level, but delaying increases the risk profile.`,
      next_step: `Approve, but ask the shop to show you exactly what they found${aboveMarket ? " and whether there's any flexibility on the price" : ""}.`
    };
  }

  // Rule 7: Symptoms reported + high severity → take seriously
  if (isSymptoms && isHighSev && (couldDamage || mightWorsen)) {
    return {
      verdict: 'approve',
      recommendation: "This sounds real — I'd take it seriously and approve.",
      confidence: 'medium',
      explanation: "When a service is flagged based on symptoms you've already noticed (not just a calendar interval), the risk of ignoring it goes up. Pay attention to this one.",
      next_step: `Approve. The symptoms you described match what the shop flagged — that alignment is a good signal that the recommendation is legitimate.`
    };
  }

  // Rule 8: Above market + Grade C shop + mileage → skeptical
  if (aboveMarket && shopGrade === 'C' && isMileage) {
    return {
      verdict: 'second_opinion',
      recommendation: "I'd hold off and get one more quote before approving this.",
      confidence: 'high',
      explanation: "This combination — routine trigger, above-market price, shop without a strong track record — is worth a second look. You're not obligated to approve this at the first ask.",
      next_step: "Politely decline for now and call one other shop. If they quote significantly less for the same service, that tells you everything."
    };
  }

  // ─────────────────────────────────────────────────────
  // AI FALLBACK for nuanced cases
  // ─────────────────────────────────────────────────────
  try {
    // Dynamic import to avoid circular dep issues
    const OpenAI = (await import('openai')).default;
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const prompt = `You are a calm, practical advisor helping someone decide whether to approve a car repair. You have full context. Speak like a trusted friend — clear, direct, and slightly opinionated. No generic advice.

Service: ${itemName}
Price: $${item.price} (${item.price_position.replace('_', ' ')})
Original urgency: ${item.urgency}
Shop grade: ${shopGrade}
Original reason it was flagged: ${item.flag_reason}

What the shop told them:
- Severity: ${severity === 'not_sure' ? 'Not sure' : severity + '/5'}
- Reasoning: ${reasoning.replace(/_/g, ' ')}
- Risk of waiting: ${waitRisk.replace(/_/g, ' ')}
- Additional notes: "${notes || 'None'}"

Based on all this context, give an updated verdict.

Return valid JSON only (no markdown):
{
  "verdict": "approve" | "wait" | "second_opinion",
  "recommendation": "One plain-English sentence — what you'd actually do",
  "confidence": "high" | "medium" | "low",
  "explanation": "2 sentences — ground it in their specific situation, not generic principles",
  "next_step": "1 concrete sentence on what to do right now"
}`;

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      max_tokens: 300,
    });

    const parsed = JSON.parse(completion.choices[0].message.content || '{}');
    return {
      verdict: parsed.verdict || 'second_opinion',
      recommendation: parsed.recommendation || 'More context needed.',
      confidence: parsed.confidence || 'low',
      explanation: parsed.explanation || '',
      next_step: parsed.next_step || 'Ask the shop for more details.',
    };
  } catch (aiErr) {
    console.error('[evaluateFollowUp] AI fallback failed:', aiErr);
    // Safe fallback
    return {
      verdict: 'second_opinion',
      recommendation: "More context needed before deciding.",
      confidence: 'low',
      explanation: "We weren't able to generate a definitive recommendation with the information provided. The situation isn't clear-cut.",
      next_step: "Ask the shop for one more specific detail — exactly what they saw or measured — then decide."
    };
  }
}
