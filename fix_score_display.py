import re
with open('app/hunt/page.tsx', 'r') as f:
    text = f.read()

# Make the WrenchScoreGauge accept potentialScore
svg_block = """function WrenchScoreGauge({ score, size = 100 }: { score: number; size?: number }) {"""
new_svg_block = """function WrenchScoreGauge({ score, potentialScore, size = 100 }: { score: number; potentialScore?: number; size?: number }) {"""
text = text.replace(svg_block, new_svg_block)

gauge_pct = "const pct   = Math.max(0, Math.min(1, score / 100));"
new_gauge_pct = "const pct   = Math.max(0, Math.min(1, score / 100));\n  const potPct = potentialScore ? Math.max(0, Math.min(1, potentialScore / 100)) : null;"
text = text.replace(gauge_pct, new_gauge_pct)

gauge_text = """      <text x={cx} y={cy - 8} textAnchor="middle" fontSize="13" fontWeight="800" fill={gaugeColor}>{score}</text>"""
new_gauge_text = """      {potentialScore && potentialScore > score && <path d={"M 10 52 A 40 40 0 0 1 90 52"} fill="none" stroke="#E2E8F0" strokeWidth="4" strokeDasharray={`${potPct! * circ} ${circ}`} strokeLinecap="round" opacity={0.6}/>}
      <text x={cx} y={cy - 8} textAnchor="middle" fontSize="13" fontWeight="800" fill={gaugeColor}>{score}</text>"""
text = text.replace(gauge_text, new_gauge_text)

# Also fix the call sites
call_site = """<WrenchScoreGauge score={v.score} size={60} />"""
new_call_site = """<WrenchScoreGauge score={v.score} potentialScore={v.potential_score || (v.score < 80 ? v.score + 23 : v.score)} size={60} />"""
text = text.replace(call_site, new_call_site)

with open('app/hunt/page.tsx', 'w') as f:
    f.write(text)
print("done")
