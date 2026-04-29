import re

with open('/Users/nedryan/Documents/wrench-check/app/hunt/page.tsx', 'r') as f:
    text = f.read()

# 1. State Injections
state_block = """  // ── Deletion & Financing ──
  const [deletedIds, setDeletedIds] = useState<Record<string, NodeJS.Timeout>>({});
  const [deletedVisually, setDeletedVisually] = useState<Record<string, boolean>>({});
  const [payMethod, setPayMethod] = useState<'cash'|'finance'>('cash');

  const handleDelete = (id: string, make: string, model: string) => {
    setDeletedVisually(prev => ({...prev, [id]: true}));
    const timer = setTimeout(async () => {
      try {
        await fetch(`/api/hunt/${id}`, { method: 'DELETE' });
        setVehicles(prev => prev.filter(v => v.id !== id));
      } catch(e) {}
    }, 5000);
    setDeletedIds(prev => ({...prev, [id]: timer}));
  };

  const undoDelete = (id: string) => {
    clearTimeout(deletedIds[id]);
    setDeletedVisually(prev => { const next = {...prev}; delete next[id]; return next; });
    setDeletedIds(prev => { const next = {...prev}; delete next[id]; return next; });
  };
"""

text = text.replace("  const [scoutChatHistory", state_block + "\n  const [scoutChatHistory")

# 2. Add Financing Toggle next to Tabs
tabs_header = """            <button onClick={() => setViewTab('inbox')} style={{ background: 'none', border: 'none', fontSize: 13, fontWeight: 800, color: viewTab === 'inbox' ? '#334155' : '#94A3B8', padding: '6px 12px', cursor: 'pointer', borderBottom: viewTab === 'inbox' ? '2px solid #334155' : '2px solid transparent' }}>
              Inbox {scoutLeads.length > 0 && <span style={{ background: '#22C55E', color: '#fff', fontSize: 10, padding: '2px 6px', borderRadius: 99, marginLeft: 4 }}>{scoutLeads.length}</span>}
            </button>"""

new_tabs_header = tabs_header + """
            <div style={{ marginLeft: 'auto', display: 'flex', background: '#E2E8F0', borderRadius: 8, padding: 3 }}>
              <button onClick={() => setPayMethod('cash')} style={{ background: payMethod === 'cash' ? '#fff' : 'transparent', border: 'none', fontSize: 11, fontWeight: 800, color: payMethod === 'cash' ? '#1E293B' : '#64748B', padding: '4px 12px', borderRadius: 6, cursor: 'pointer', boxShadow: payMethod === 'cash' ? '0 1px 3px rgba(0,0,0,0.1)' : 'none' }}>CASH</button>
              <button onClick={() => setPayMethod('finance')} style={{ background: payMethod === 'finance' ? '#fff' : 'transparent', border: 'none', fontSize: 11, fontWeight: 800, color: payMethod === 'finance' ? '#1E293B' : '#64748B', padding: '4px 12px', borderRadius: 6, cursor: 'pointer', boxShadow: payMethod === 'finance' ? '0 1px 3px rgba(0,0,0,0.1)' : 'none' }}>FINANCE</button>
            </div>"""

text = text.replace(tabs_header, new_tabs_header)

# 3. Add Trash Can to unexpanded view header
# Find the header row end where toggleRow happens
rank_badge = """{/* Ranking badge */}"""
trash_btn = """                        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 12 }}>
                          {v.score && <WrenchScoreGauge score={v.score} size={60} />}
                          <button onClick={(e) => { e.stopPropagation(); handleDelete(v.id, v.make, v.model); }} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 16, opacity: 0.3, padding: '4px 8px' }} onMouseOver={e=>e.currentTarget.style.opacity='1'} onMouseOut={e=>e.currentTarget.style.opacity='0.3'}>🗑</button>
                        </div>"""

# Replace the existing right-side container that previously had the score
raw_score_block = """                        <div style={{ marginLeft: 'auto' }}>
                          {v.score ? <WrenchScoreGauge score={v.score} size={60} /> : <div style={{ fontSize: 10, color: TEXT3, fontWeight: 700 }}>n/a</div>}
                        </div>"""
new_score_block = """                        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 12 }}>
                          {v.score ? <WrenchScoreGauge score={v.score} size={60} /> : <div style={{ fontSize: 10, color: TEXT3, fontWeight: 700 }}>n/a</div>}
                          <button onClick={(e) => { e.stopPropagation(); handleDelete(v.id, v.make, v.model); }} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 16, opacity: 0.3, padding: '4px 8px' }} onMouseOver={e=>e.currentTarget.style.opacity='1'} onMouseOut={e=>e.currentTarget.style.opacity='0.3'}>🗑</button>
                        </div>"""
if raw_score_block in text:
    text = text.replace(raw_score_block, new_score_block)

# Hide deleted items visually
text = text.replace("                  .map((v, rankIdx) => {", "                  .filter(v => !deletedVisually[v.id])\n                  .map((v, rankIdx) => {")

# 4. Remove DOSSIER SECTION
dossier_start = text.find("{/* DOSSIER SECTION */}")
if dossier_start != -1:
    # Find the end of it (up to AI Deal Insight maybe, or end of div)
    # The dossier ends right before Navigator Chat usually, but we are moving Navigator chat.
    # We will just regex it out carefully
    pass

with open('/Users/nedryan/Documents/wrench-check/app/hunt/page.tsx', 'w') as f:
    f.write(text)

