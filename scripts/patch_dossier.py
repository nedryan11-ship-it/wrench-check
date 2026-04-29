#!/usr/bin/env python3
"""Replace dossier PPI/Photos sections with confidence bar upgrades."""
import re

with open('/Users/nedryan/Documents/wrench-check/app/hunt/page.tsx', 'r') as f:
    content = f.read()

# ── Replace PPI section through end of Photo result section ──────────────────
# Find start: the "{/* PPI upload */}" comment
ppi_marker = '                                     {/* PPI upload */}'
# Find end: the closing "                                     )}" after photo result
# The section ends with the closing )} of the photo result conditional
# We find the photo result block and its closing
photo_end_marker = '                                     )}\n                                   </div>'

ppi_idx = content.find(ppi_marker)
end_idx = content.find(photo_end_marker, ppi_idx)

if ppi_idx == -1:
    print("ERROR: PPI marker not found")
    exit(1)
if end_idx == -1:
    print("ERROR: Photo end marker not found")
    exit(1)

print(f"PPI start: char {ppi_idx}, end: char {end_idx}")

NEW_SECTION = r"""                                     {/* PPI upload */}
                                     {!(v.documents||[]).find((d:any) => d.type==='ppi') && (
                                       <label style={{ flex: 1, minWidth: 140, display: 'flex', flexDirection: 'column', gap: 4, padding: '9px 12px', background: v.tier==='gem'?'#0F172A':'#fff', borderRadius: 8, border: `1px dashed ${v.tier==='gem'?'#475569':BORDER}`, cursor: 'pointer' }}>
                                         <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                           <span style={{ fontSize: 13 }}>🔧</span>
                                           <div style={{ flex: 1 }}>
                                             <div style={{ fontSize: 11, fontWeight: 700, color: v.tier==='gem'?'#CBD5E1':TEXT1 }}>PPI / Inspection</div>
                                             <div style={{ fontSize: 10, color: '#B45309', fontWeight: 600 }}>⚠ No mechanic sign-off on file</div>
                                           </div>
                                         </div>
                                         <div style={{ height: 4, background: '#E2E8F0', borderRadius: 99 }}>
                                           <div style={{ height: '100%', width: '0%', background: '#3B82F6', borderRadius: 99 }} />
                                         </div>
                                         <div style={{ fontSize: 9, color: TEXT3 }}>Upload inspection report to unlock +15% confidence</div>
                                         <input type="file" accept=".pdf,.png,.jpg,.jpeg,.webp,.heic" style={{display:'none'}}
                                           onChange={async (e) => { const f = e.target.files?.[0]; if(f) await attachDocument(v.id, f, 'ppi'); }} />
                                       </label>
                                     )}

                                     {/* Photo scan */}
                                     {!v.photo_intel?.condition && v.listing_url && !v.listing_url.startsWith('manual_') && (
                                       <button onClick={e => { e.stopPropagation(); scanPhotos(v.id); }} disabled={scanningPhotosId===v.id}
                                         style={{ flex: 1, minWidth: 140, display: 'flex', flexDirection: 'column', gap: 4, padding: '9px 12px', background: v.tier==='gem'?'#0F172A':'#fff', borderRadius: 8, border: `1px dashed ${v.tier==='gem'?'#475569':BORDER}`, cursor: 'pointer', textAlign: 'left' }}>
                                         <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                           <span style={{ fontSize: 13 }}>{scanningPhotosId===v.id ? '⏳' : '📸'}</span>
                                           <div style={{ flex: 1 }}>
                                             <div style={{ fontSize: 11, fontWeight: 700, color: v.tier==='gem'?'#CBD5E1':TEXT1 }}>{scanningPhotosId===v.id ? 'Scanning…' : 'Scan Photos'}</div>
                                             <div style={{ fontSize: 10, color: '#B45309', fontWeight: 600 }}>⚠ Visual condition not assessed</div>
                                           </div>
                                         </div>
                                         <div style={{ height: 4, background: '#E2E8F0', borderRadius: 99 }}>
                                           <div style={{ height: '100%', width: scanningPhotosId===v.id ? '50%' : '0%', background: '#8B5CF6', borderRadius: 99, transition: 'width 1s' }} />
                                         </div>
                                         <div style={{ fontSize: 9, color: TEXT3 }}>Run to check for rust, leaks, and frame condition</div>
                                       </button>
                                     )}

                                     {/* Photo result — with mechanical coverage bars */}
                                     {v.photo_intel?.condition && (() => {
                                       const pi = v.photo_intel;
                                       const cov = pi.mechanicalCoverage;
                                       const covered = cov ? [cov.engineBayVisible, cov.suspensionVisible, cov.undercarriageVisible, cov.frameRailsVisible, cov.odometerVisible].filter(Boolean).length : 0;
                                       const coverPct = cov ? Math.round((covered / 5) * 100) : 50;
                                       const isFlag = pi.condition === 'flag';
                                       const isFair = pi.condition === 'fair';
                                       const flagColor = isFlag ? '#B91C1C' : isFair ? '#B45309' : '#15803D';
                                       const flagBg = isFlag ? '#FEF2F2' : isFair ? '#FFFBEB' : '#F0FDF4';
                                       const flagBorder = isFlag ? '#FECACA' : isFair ? '#FDE68A' : '#86EFAC';
                                       return (
                                         <div style={{ flex: 1, minWidth: 160, display: 'flex', flexDirection: 'column', gap: 4, padding: '9px 12px', background: flagBg, borderRadius: 8, border: `1px solid ${flagBorder}` }}>
                                           <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                             <span style={{ fontSize: 13 }}>{isFlag ? '⚠️' : '📸'}</span>
                                             <div style={{ flex: 1 }}>
                                               <div style={{ fontSize: 11, fontWeight: 800, color: flagColor }}>
                                                 {pi.grade && <span style={{ marginRight: 4 }}>Grade {pi.grade}</span>}
                                                 {pi.gradeLabel?.slice(0, 28) || `Photos: ${pi.condition}`}
                                               </div>
                                             </div>
                                           </div>
                                           <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                             <div style={{ flex: 1, height: 4, background: '#E2E8F0', borderRadius: 99 }}>
                                               <div style={{ height: '100%', width: `${coverPct}%`, background: coverPct >= 60 ? '#16A34A' : coverPct >= 30 ? '#F59E0B' : '#EF4444', borderRadius: 99, transition: 'width 0.5s' }} />
                                             </div>
                                             <div style={{ fontSize: 9, color: '#6B7280', whiteSpace: 'nowrap', fontWeight: 700 }}>{covered}/5 areas</div>
                                           </div>
                                           {pi.missingAreas?.length > 0 && (
                                             <div style={{ fontSize: 9, color: '#B45309', fontWeight: 600 }}>📋 Ask: {(pi.missingAreas[0] ?? '').split('—')[0].replace('not photographed', '').trim().slice(0, 45)}</div>
                                           )}
                                         </div>
                                       );
                                     })()}
                                   </div>"""

# Replace from ppi_marker to (and including) the end_idx + length of photo_end_marker
replace_end = end_idx + len(photo_end_marker)
content = content[:ppi_idx] + NEW_SECTION + content[replace_end:]
with open('/Users/nedryan/Documents/wrench-check/app/hunt/page.tsx', 'w') as f:
    f.write(content)
print("SUCCESS: Replaced PPI/Scan/Photo sections with confidence bar versions")
