const fs = require('fs');

let page = fs.readFileSync('app/hunt/page.tsx', 'utf8');

// We need to inject WrenchScoreGauge
if (!page.includes('WrenchScoreGauge')) {
  page += `
// ─── WrenchScore gauge (SVG semicircle, CarGurus-inspired) ────────────────────────
function WrenchScoreGauge({ score, size = 100 }: { score: number; size?: number }) {
  const R     = 40;
  const cx    = 50;
  const cy    = 52;
  const circ  = Math.PI * R; // semicircle circumference
  const pct   = Math.max(0, Math.min(1, score / 100));
  // Score color: red(<50) → orange(50-64) → yellow(65-74) → green(75+)
  const gaugeColor = score >= 75 ? "#16A34A" : score >= 65 ? "#CA8A04" : score >= 50 ? "#EA580C" : "#DC2626";
  // Needle angle: -180° (left) to 0° (right) mapped to score 0–100
  const angleDeg  = -180 + pct * 180;
  const angleRad  = (angleDeg * Math.PI) / 180;
  const needleLen = 32;
  const nx = cx + needleLen * Math.cos(angleRad);
  const ny = cy + needleLen * Math.sin(angleRad);

  return (
    <svg width={size} height={size * 0.6} viewBox="0 0 100 60" style={{ display: "block" }}>
      {/* Track */}
      <path d={"M 10 52 A 40 40 0 0 1 90 52"} fill="none" stroke="#E2E8F0" strokeWidth="10" strokeLinecap="round" />
      {/* Filled arc */}
      <path d={"M 10 52 A 40 40 0 0 1 90 52"} fill="none" stroke={gaugeColor} strokeWidth="10" strokeLinecap="round" strokeDasharray={\`\${pct * circ} \${circ}\`} />
      {/* Needle */}
      <line x1={cx} y1={cy} x2={nx} y2={ny} stroke="#1E293B" strokeWidth="2" strokeLinecap="round" />
      <circle cx={cx} cy={cy} r="3.5" fill="#1E293B" />
      {/* Score label */}
      <text x={cx} y={cy - 8} textAnchor="middle" fontSize="13" fontWeight="800" fill={gaugeColor}>{score}</text>
    </svg>
  );
}
`;
}

// We need to replace the mapped expanded block.
const expandStart = page.indexOf("{/* EXPANDED REPORT CARD */}");
const expandEnd = page.indexOf("</div>\n                      )}");

const newExpandedUI = `{/* EXPANDED REPORT CARD (WrenchScore UI Wrapper) */}
                      {isExpanded && (
                        <div style={{ background: v.tier === 'gem' ? "linear-gradient(135deg, #0F172A, #1E293B)" : "#FFFFFF", borderTop: \`1px solid \${BORDER}\`, padding: 0 }}>
                           
                           {/* Replica of the beautiful Report Card Header */}
                           <div style={{ padding: "20px", borderBottom: \`1px solid \${v.tier==='gem' ? '#334155' : BORDER}\` }}>
                             
                             <div style={{ display: "flex", gap: 16, alignItems: "flex-start" }}>
                               {v.score && (
                                 <div style={{ flexShrink: 0, textAlign: 'center' }}>
                                   <WrenchScoreGauge score={v.score} size={90} />
                                 </div>
                               )}
                               
                               <div style={{ flex: 1 }}>
                                 <div style={{ display: "inline-flex", alignItems: "center", padding: "4px 12px", borderRadius: 99, background: v.tier==='gem' ? '#064E3B' : v.tier==='watch'? '#FFFBEB' : '#FEF2F2', marginBottom: 8 }}>
                                   <span style={{ fontWeight: 800, fontSize: 13, color: v.tier==='gem' ? '#34D399' : v.tier==='watch'? '#B45309' : '#B91C1C' }}>
                                     {v.tier==='gem' ? "💎 Gem" : v.tier==='watch' ? "👁 Watch" : "❌ Pass"}
                                   </span>
                                 </div>
                                 <div style={{ fontSize: 13, fontWeight: 600, color: v.tier==='gem' ? '#94A3B8' : TEXT2, marginBottom: 8 }}>{expertTake}</div>
                                 
                                 <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 16 }}>
                                   {v.year === 2018 ? <span style={{ padding: "3px 8px", borderRadius: 99, fontSize: 10, fontWeight: 700, background: '#F0FDF4', color: '#15803D', border: '1px solid #86EFAC' }}>⭐ Excellent reliability</span> : null}
                                   {(!v.location || !v.location.match(/ohio|michigan|new york|ny|pa|pennsylvania|illinois|indiana|minnesota|wisconsin|connecticut|new jersey|mass/i)) && <span style={{ padding: "3px 8px", borderRadius: 99, fontSize: 10, fontWeight: 700, background: '#F0FDF4', color: '#15803D', border: '1px solid #86EFAC' }}>🌵 Rust-free</span>}
                                   <span style={{ padding: "3px 8px", borderRadius: 99, fontSize: 10, fontWeight: 700, background: '#EFF6FF', color: '#1D4ED8', border: '1px solid #BFDBFE' }}>📋 AI Verified</span>
                                 </div>

                                 <div style={{ display: "flex", gap: 20, flexWrap: "wrap" }}>
                                   {v.price && (
                                     <div>
                                       <div style={{ fontSize: 9, fontWeight: 700, color: v.tier==='gem' ? '#64748B' : TEXT3, letterSpacing: "0.1em" }}>ASKING</div>
                                       <div style={{ fontSize: 16, fontWeight: 800, color: v.tier==='gem' ? '#F8FAFC' : TEXT1 }}>{fmt$(v.price)}</div>
                                     </div>
                                   )}
                                   {v.market_mid && (
                                     <div>
                                       <div style={{ fontSize: 9, fontWeight: 700, color: v.tier==='gem' ? '#64748B' : TEXT3, letterSpacing: "0.1em" }}>MARKET MED.</div>
                                       <div style={{ fontSize: 16, fontWeight: 800, color: v.tier==='gem' ? '#94A3B8' : TEXT2 }}>{fmt$(v.market_mid)}</div>
                                     </div>
                                   )}
                                   {v.price && v.market_mid && (
                                     <div>
                                       <div style={{ fontSize: 9, fontWeight: 700, color: v.tier==='gem' ? '#64748B' : TEXT3, letterSpacing: "0.1em" }}>VS MARKET</div>
                                       <div style={{ fontSize: 16, fontWeight: 800, color: (v.market_mid - v.price) > 0 ? '#22C55E' : '#EF4444' }}>{(v.market_mid - v.price) > 0 ? \`-\${fmt$(v.market_mid - v.price)}\` : \`+\${fmt$(v.price - v.market_mid)}\`}</div>
                                     </div>
                                   )}
                                 </div>
                               </div>
                             </div>
                           </div>

                           <div style={{ padding: "20px", display: "flex", flexDirection: "column", gap: 16 }}>
                             {/* Narrative */}
                             {aiData?.vehicleNarrative && (
                               <div style={{ fontSize: 13, color: v.tier==='gem' ? '#CBD5E1' : TEXT2, fontStyle: "italic", lineHeight: 1.55, borderLeft: \`3px solid \${ACCENT}\`, paddingLeft: 10 }}>
                                 {aiData.vehicleNarrative}
                               </div>
                             )}

                             {/* Full Analysis Breakdowns */}
                             <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginTop: 12 }}>
                               {redFlags.length > 0 && (
                                 <div style={{ padding: 16, background: v.tier==='gem' ? '#1E293B' : "#FEF2F2", borderRadius: 12, border: \`1px solid \${v.tier==='gem' ? '#334155' : '#FECACA'}\` }}>
                                   <div style={{ fontSize: 10, fontWeight: 800, color: v.tier==='gem' ? '#F87171' : "#EF4444", letterSpacing: "0.08em", marginBottom: 12 }}>⚠ CRITICAL WATCHOUTS</div>
                                   <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                                     {redFlags.map((w, i) => (
                                       <div key={i} style={{ fontSize: 12, color: v.tier==='gem' ? '#F1F5F9' : "#991B1B", lineHeight: 1.4 }}>
                                         • {w.text} {w.estimatedCost ? \`(~\${fmt$(w.estimatedCost)})\` : ''}
                                       </div>
                                     ))}
                                   </div>
                                 </div>
                               )}
                               
                               {repairs.length > 0 && (
                                 <div style={{ padding: 16, background: v.tier==='gem' ? '#1E293B' : "#FFFBEB", borderRadius: 12, border: \`1px solid \${v.tier==='gem' ? '#334155' : '#FDE68A'}\` }}>
                                   <div style={{ fontSize: 10, fontWeight: 800, color: v.tier==='gem' ? '#FCD34D' : "#B45309", letterSpacing: "0.08em", marginBottom: 12 }}>💸 MAINTENANCE EXPOSURE</div>
                                   <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                                     {repairs.map((r, i) => (
                                       <div key={i} style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: v.tier==='gem' ? '#F1F5F9' : "#92400E" }}>
                                         <span>{r.name}</span>
                                         <span style={{ fontWeight: 700 }}>{fmt$(r.costLow || 0)}–{fmt$(r.costHigh || 0)}</span>
                                       </div>
                                     ))}
                                   </div>
                                 </div>
                               )}
                             </div>
                             
                             <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 16 }}>
                               <button onClick={(e) => handleDelete(v.id, e)} style={{ background: "none", border: "none", fontSize: 12, fontWeight: 700, color: v.tier==='gem' ? '#EF4444' : "#EF4444", cursor: "pointer", padding: 0 }}>DELETE FOREVER</button>
                               <a href={v.listing_url} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()} style={{ fontSize: 12, fontWeight: 700, color: v.tier==='gem' ? '#60A5FA' : ACCENT, textDecoration: "none" }}>VIEW LISTING ↗</a>
                             </div>
                           </div>
                        </div>`;

page = page.substring(0, expandStart) + newExpandedUI + page.substring(expandEnd);

fs.writeFileSync('app/hunt/page.tsx', page, 'utf8');
