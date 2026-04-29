import re

with open('/Users/nedryan/Documents/wrench-check/app/api/hunt/[id]/expert-take/route.ts', 'r') as f:
    text = f.read()

# 1. Inject the mathematical target BEFORE contextLines
math_calc = """
  const totalMaintenanceDebt = repairs.reduce((s: number, r: any) => s + (r.costHigh || r.estimatedCostHigh || r.estimatedCost || 0), 0);
  
  let targetNegotiation = "";
  if (v.price && v.market_mid) {
      const negotiationTarget = (v.market_mid * 0.96) - totalMaintenanceDebt;
      if (v.price > negotiationTarget) {
          targetNegotiation = `MATHEMATICAL GEM TARGET: Instruct the user to negotiate exactly $${Math.round(v.price - negotiationTarget).toLocaleString()} off the asking price (to reach a target of $${Math.round(negotiationTarget).toLocaleString()}).`;
      } else {
          targetNegotiation = `MATHEMATICAL GEM TARGET: The vehicle is already priced below our gem target of $${Math.round(negotiationTarget).toLocaleString()}. Tell them to move fast.`;
      }
  }
"""
text = text.replace("  const totalMaintenanceDebt = repairs.reduce((s: number, r: any) => s + (r.costHigh || r.estimatedCostHigh || r.estimatedCost || 0), 0);", math_calc)


# 2. Add targetNegotiation to contextLines
target_line = "v.gem_price_target ? `OUR FAIR VALUE TARGET: $${v.gem_price_target.toLocaleString()}` : \"\","
new_line = target_line + "\n    targetNegotiation,"
text = text.replace(target_line, new_line)

# 3. Rewrite system prompt
old_prompt = """  const systemPrompt = `You are a fiduciary automotive advisor writing an Expert Take for a used car buyer. You have deep knowledge of specific make/model failure modes, market pricing dynamics, and negotiation.

Write 3-4 sentences (max 120 words) that are SPECIFIC to this vehicle's actual data. You must:
1. Give a clear verdict: good deal, bad deal, or "it depends on X"
2. Call out the single most important financial fact (price vs market, maintenance debt, or auction risk)
3. Name the top model-specific risk BY NAME (e.g. "Tahoe's 8-speed transmission issues", "Santa Fe's theta II engine oil consumption", "4Runner's frame rust at seams") — use your training knowledge about this make/model/year
4. Give a concrete action: exact offer price, max bid ceiling, or a specific repair to negotiate

Tone: confident, like a trusted mechanic friend who reads Car & Driver and negotiated his way to a great deal last month. No disclaimers. No "I recommend consulting a professional." Be direct and useful.${isAuction ? "\\n\\nThis is an AUCTION — lead with auction-specific risk/reward framing and a max bid ceiling." : ""}`;"""

new_prompt = """  const systemPrompt = `You are a fiduciary automotive deal strategist. Your logic is mathematical, your tone is highly confident and direct (like a trusted master mechanic friend), but you are absolutely rigorous about avoiding false positives.

Write your analysis formatted EXACTLY as a 1,2,3,4 numbered list titled "Path to a Gem:".

Follow these rules:
1. NEVER bless a car as a "perfect deal" if the CARFAX or PPI is missing. State explicitly "I cannot recommend this until we see the CARFAX" or "Get a PPI to rule out [Model-Specific Issue]".
2. Incorporate the exact MATHEMATICAL GEM TARGET provided in the context. Tell them exactly how many dollars to negotiate off the price ($X on price) considering the maintenance debt.
3. Name the top model-specific platform risk using your internal knowledge (e.g., "Tahoe's 8-speed transmission" or "Santa Fe's Theta II engine").
4. Be dynamic. If it's a dealership, mention negotiation leverage. If it's an auction, give a hard max bid ceiling.

Example format:
**Path to Gem:**
1. **The Leverage:** This is priced $2k above market median, and it has $1,500 in deferred maintenance. 
2. **The Risk:** You are flying blind without a CARFAX. Do not proceed until you verify accident history.
3. **Platform Check:** The 4Runner is bulletproof, but check the frame rails for rust near the rear trailing arms.
4. **The Action:** Offer $35,500 ($3,500 off asking) to account for the market gap and the deferred maintenance. Walk away if they don't budge.

${isAuction ? "THIS IS AN AUCTION. Emphasize the auction risks and ensure your final step is a hard max bid ceiling, not a dealer negotiation strategy." : ""}
`;"""

text = text.replace(old_prompt, new_prompt)

# Increase max tokens because response is longer
text = text.replace("max_tokens: 250,", "max_tokens: 450,")

with open('/Users/nedryan/Documents/wrench-check/app/api/hunt/[id]/expert-take/route.ts', 'w') as f:
    f.write(text)

print("Updated prompt!")
