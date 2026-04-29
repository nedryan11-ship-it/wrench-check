import re
with open('patched_page.tsx', 'r') as f:
    text = f.read()

# Path to gem block:
idx_gem = text.find('PATH TO GEM')
idx_insight = text.find('{/* Full Analysis Breakdowns */}')

# 1. Remove the old CHAT CONTINUATION completely
chat_cont_start = text.find('{/* ── CHAT CONTINUATION ─────────────────────────────────────── */}')
if chat_cont_start > -1:
    # Scan forward to find the end of the chat container div
    # It ends before {/* ── DEBUG RAW DATA ── */}
    debug_start = text.find('{/* ── DEBUG RAW DATA ── */}', chat_cont_start)
    if debug_start > -1:
        text = text[:chat_cont_start] + text[debug_start:]

# 2. Inject CarFax / PPI upload + Chat inside Path to Gem
# We identify the Negotiation signal rendering line
neg_start = text.find(' {/* Negotiation signal */}')
if neg_start > -1:
    neg_end = text.find('</div>', text.find('</div>', text.find('</div>', text.find('</div>', neg_start)+1)+1)+1) + 6
    
    upload_and_chat_block = """
                                  {/* Action Center: Uploads & Chat */}
                                  <div style={{ marginTop: 16 }}>
                                    <div style={{ fontSize: 10, fontWeight: 800, color: '#B45309', letterSpacing: '0.08em', marginBottom: 8 }}>
                                      {v.market_mid && v.price && (v.price < v.market_mid * 0.95) ? '⚡ MOVE NOW' : '🤝 NEGOTIATE / ACTION'}
                                    </div>
                                    
                                    {/* Inline File Uploads for Missing Data */}
                                    <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
                                      {!v.documents?.some((d: any) => d.doc_type === 'carfax' || d.type === 'carfax') && (
                                        <label style={{ flex: 1, minWidth: 140, display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', background: '#fff', borderRadius: 8, border: '1px dashed #F59E0B', cursor: 'pointer' }}>
                                          <span style={{ fontSize: 16 }}>⬆️</span>
                                          <div>
                                            <div style={{ fontSize: 11, fontWeight: 700, color: '#92400E' }}>Upload CARFAX</div>
                                            <div style={{ fontSize: 10, color: '#B45309' }}>PDF or image</div>
                                          </div>
                                          <input type="file" style={{ display: 'none' }} accept=".pdf,.png,.jpg,.jpeg" onChange={(e) => { if (e.target.files?.[0]) handleFile(v.id, 'carfax', e.target.files[0]) }} />
                                        </label>
                                      )}
                                      {!v.documents?.some((d: any) => d.doc_type === 'ppi' || d.type === 'ppi') && (
                                        <label style={{ flex: 1, minWidth: 140, display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', background: '#fff', borderRadius: 8, border: '1px dashed #F59E0B', cursor: 'pointer' }}>
                                          <span style={{ fontSize: 16 }}>⬆️</span>
                                          <div>
                                            <div style={{ fontSize: 11, fontWeight: 700, color: '#92400E' }}>Upload PPI</div>
                                            <div style={{ fontSize: 10, color: '#B45309' }}>Inspection Report</div>
                                          </div>
                                          <input type="file" style={{ display: 'none' }} accept=".pdf,.png,.jpg,.jpeg" onChange={(e) => { if (e.target.files?.[0]) handleFile(v.id, 'ppi', e.target.files[0]) }} />
                                        </label>
                                      )}
                                    </div>

                                    {/* Chat Integration */}
                                    <div style={{ background: '#FFF7ED', display: 'flex', padding: 4, borderRadius: 8, border: '1px solid #FDE68A' }}>
                                      <input 
                                        placeholder={payMethod === 'finance' ? "Ask about cash flow, rates, or negotiate..." : "Ask what to text the dealer, or 'is this a rust risk?'"}
                                        style={{ flex: 1, border: 'none', background: 'transparent', padding: '10px 12px', fontSize: 13, outline: 'none', color: '#78350F' }}
                                        value={chatInputs[v.id] || ''}
                                        onChange={e => setChatInputs(prev => ({...prev, [v.id]: e.target.value}))}
                                        onKeyDown={e => { if (e.key === 'Enter') handleChat(v.id) }}
                                      />
                                      <button onClick={() => handleChat(v.id)} disabled={navigatorLoading[v.id]} style={{ padding: '0 16px', background: '#F59E0B', color: '#fff', border: 'none', borderRadius: 6, fontWeight: 700, cursor: 'pointer', opacity: navigatorLoading[v.id] ? 0.6 : 1 }}>
                                        {navigatorLoading[v.id] ? '...' : '→'}
                                      </button>
                                    </div>
                                    
                                    {/* Chat History rendered below input inside the Gem logic */}
                                    {(navigatorChat[v.id]?.length ?? 0) > 1 && (
                                      <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 200, overflowY: 'auto' }}>
                                        {(navigatorChat[v.id] || []).slice(1).map((msg, mi) => (
                                          <div key={mi} style={{ display: 'flex', gap: 8, justifyContent: msg.role === 'user' ? 'flex-end' : 'flex-start' }}>
                                            <div style={{ background: msg.role === 'user' ? '#FDE68A' : '#FEF3C7', padding: '8px 12px', borderRadius: '8px', fontSize: 12, color: '#78350F', maxWidth: '90%' }}>
                                              {msg.content}
                                            </div>
                                          </div>
                                        ))}
                                      </div>
                                    )}
                                  </div>"""
                                  
    text = text[:neg_start] + upload_and_chat_block + text[neg_end:]

with open('patched_page2.tsx', 'w') as f:
    f.write(text)
print("Complete")
