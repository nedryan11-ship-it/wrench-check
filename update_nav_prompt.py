import re

with open('/Users/nedryan/Documents/wrench-check/app/api/hunt/[id]/navigator/route.ts', 'r') as f:
    text = f.read()

# 1. Provide the mathematical target here as well!
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
if "let targetNegotiation" not in text:
    text = text.replace("  const totalMaintenanceDebt = repairs.reduce((s: number, r: any) => s + (r.costHigh || r.estimatedCostHigh || r.estimatedCost || 0), 0);", math_calc)


# 2. Add targetNegotiation to contextLines
target_line = "v.gem_price_target ? `OUR FAIR VALUE TARGET: $${v.gem_price_target.toLocaleString()}` : \"\","
new_line = target_line + "\n    targetNegotiation,"
if "targetNegotiation" not in target_line and "targetNegotiation" not in text[text.find(target_line):]:
    text = text.replace(target_line, new_line)

# 3. Update the basePersona
old_persona = """  const basePersona = `You are a fiduciary automotive advisor acting as a "Deal Navigator."
Your goal is to help the user evaluate this specific vehicle, negotiate the best price, and avoid hidden risks.`"""

new_persona = """  const basePersona = `You are a fiduciary automotive deal strategist and master mechanic. 
Your tone is confident, direct, and slightly conversational, but your logic is strictly mathematical.
CRITICAL RULES:
1. Never give false-positive assurance. If a vehicle lacks a CARFAX or PPI, always remind the user that they are flying blind on condition or title history.
2. If discussing price, use the exact MATHEMATICAL GEM TARGET provided in your context to give concrete, dollar-specific negotiation advice. 
3. Draw upon your deep knowledge of model-specific failure modes (e.g., specific engine codes, transmission flaws) to guide the user's questions to the dealer.`"""

text = text.replace(old_persona, new_persona)

with open('/Users/nedryan/Documents/wrench-check/app/api/hunt/[id]/navigator/route.ts', 'w') as f:
    f.write(text)

print("Updated navigator prompt!")
