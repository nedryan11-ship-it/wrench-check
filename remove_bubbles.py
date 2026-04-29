import re

with open('/Users/nedryan/Documents/wrench-check/app/hunt/page.tsx', 'r') as f:
    text = f.read()

# 1. Look for the Gap items block
gap_items = """                                  {/* Gap items */}
                                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }}>
                                    {!v.documents?.some((d: any) => d.doc_type === 'carfax') && (
                                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
                                        <span style={{ fontSize: 14 }}>🔴</span>
                                        <span style={{ flex: 1, color: '#78350F' }}>No CARFAX on file</span>
                                        <span style={{ fontWeight: 700, color: '#92400E' }}>+8 pts if clean</span>
                                      </div>
                                    )}
                                    {v.market_mid && v.price && v.price > v.market_mid * 0.97 && (
                                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
                                        <span style={{ fontSize: 14 }}>🟡</span>
                                        <span style={{ flex: 1, color: '#78350F' }}>Priced above market median</span>
                                        <span style={{ fontWeight: 700, color: '#92400E' }}>at ${Math.round(v.market_mid * 0.95).toLocaleString()} = gem-priced</span>
                                      </div>
                                    )}
                                    {v.enrichment_status !== 'complete' && (
                                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
                                        <span style={{ fontSize: 14 }}>🔵</span>
                                        <span style={{ flex: 1, color: '#78350F' }}>AI enrichment incomplete</span>
                                        <span style={{ fontWeight: 700, color: '#92400E' }}>+5–10 pts on full scan</span>
                                      </div>
                                    )}
                                    {!v.photo_intel && (
                                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
                                        <span style={{ fontSize: 14 }}>📸</span>
                                        <span style={{ flex: 1, color: '#78350F' }}>No photo analysis</span>
                                        <span style={{ fontWeight: 700, color: '#92400E' }}>condition unknown</span>
                                      </div>
                                    )}
                                  </div>"""

if "Gap items" in text:
    text = text.replace(gap_items, "                                  {/* Rendered dynamic AI Path to Gem step-by-step from Deal Insight (extracted upstream) */}")

with open('/Users/nedryan/Documents/wrench-check/app/hunt/page.tsx', 'w') as f:
    f.write(text)
    
print("Removed UI bubble gaps!")
