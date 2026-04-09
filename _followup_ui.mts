import * as fs from 'fs';
const path = '/Users/edwardryan/refi architect/app/app/audit/[id]/page.tsx';
let content = fs.readFileSync(path, 'utf8');

// ─────────────────────────────────────────────────
// STEP 1: Add followUps state after isTyping state
// ─────────────────────────────────────────────────
content = content.replace(
  '  const [isTyping, setIsTyping] = useState(false);\n',
  `  const [isTyping, setIsTyping] = useState(false);

  // Follow-up state — keyed by item index string
  type FollowUpInput = { severity: string; reasoning: string; waitRisk: string; notes: string; };
  type FollowUpResult = { verdict: string; recommendation: string; confidence: string; explanation: string; next_step: string; };
  type FollowUpEntry = { open: boolean; input: FollowUpInput; result?: FollowUpResult; loading: boolean; itemName: string; };
  const [followUps, setFollowUps] = useState<Record<string, FollowUpEntry>>({});

`
);

// ─────────────────────────────────────────────────
// STEP 2: Add follow-up handler functions before the return
// ─────────────────────────────────────────────────
content = content.replace(
  '  if (!caseData || !report) return (',
  `  // ─── Follow-up handlers ───
  const toggleFollowUp = (key: string) => {
    setFollowUps(prev => ({
      ...prev,
      [key]: prev[key]
        ? { ...prev[key], open: !prev[key].open }
        : { open: true, input: { severity: '', reasoning: '', waitRisk: '', notes: '' }, loading: false, itemName: key }
    }));
  };

  const updateFollowUpField = (key: string, field: keyof FollowUpInput, value: string) => {
    setFollowUps(prev => ({
      ...prev,
      [key]: {
        ...prev[key],
        input: { ...prev[key]?.input, [field]: value }
      }
    }));
  };

  const resetFollowUp = (key: string) => {
    setFollowUps(prev => ({
      ...prev,
      [key]: { ...prev[key], result: undefined, input: { severity: '', reasoning: '', waitRisk: '', notes: '' } }
    }));
  };

  const submitFollowUp = async (key: string, item: any, itemName: string) => {
    const fu = followUps[key];
    if (!fu?.input?.severity || !fu?.input?.reasoning || !fu?.input?.waitRisk) return;

    setFollowUps(prev => ({ ...prev, [key]: { ...prev[key], loading: true, itemName } }));
    try {
      const resp = await fetch('/api/followup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          case_id: caseId,
          item,
          followUp: fu.input,
          shopContext: report?.shop_context?.intelligence
        })
      });
      const result = await resp.json();
      setFollowUps(prev => ({
        ...prev,
        [key]: { ...prev[key], result, loading: false, open: false, itemName }
      }));
    } catch (err) {
      console.error('[follow-up submit]', err);
      setFollowUps(prev => ({ ...prev, [key]: { ...prev[key], loading: false } }));
    }
  };

  if (!caseData || !report) return (`
);

// ─────────────────────────────────────────────────
// STEP 3: Pass followUps to chat
// ─────────────────────────────────────────────────
content = content.replace(
  "body: JSON.stringify({ \n          case_id: caseId, \n          user_message: input,\n          report: report \n        })",
  "body: JSON.stringify({ \n          case_id: caseId, \n          user_message: input,\n          report: report,\n          followUps: followUps\n        })"
);

// ─────────────────────────────────────────────────
// STEP 4: Inject follow-up UI inside each Decision Box
// After: "If this were my car" section closing </div>
// Before: the </div> closing the p-7 space-y-6 container
// ─────────────────────────────────────────────────

// The target is the specific ending of the "if this were my car" section followed by the container close
const ifMyCarEnd = `                      {/* If this were my car */}
                      <div className="border-t border-slate-100 pt-5 flex gap-4 items-start">
                        <div className="w-8 h-8 rounded-lg bg-[#0D1C2E] flex items-center justify-center shrink-0 mt-0.5">
                          <span className="text-white text-[11px] font-black">★</span>
                        </div>
                        <div>
                          <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">If this were my car</p>
                          <p className="text-sm font-semibold text-[#0D1C2E] leading-relaxed">{myCarText}</p>
                        </div>
                      </div>

                    </div>
                  </div>
                );
              })}`;

const ifMyCarReplacement = `                      {/* If this were my car */}
                      <div className="border-t border-slate-100 pt-5 flex gap-4 items-start">
                        <div className="w-8 h-8 rounded-lg bg-[#0D1C2E] flex items-center justify-center shrink-0 mt-0.5">
                          <span className="text-white text-[11px] font-black">★</span>
                        </div>
                        <div>
                          <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">If this were my car</p>
                          <p className="text-sm font-semibold text-[#0D1C2E] leading-relaxed">{myCarText}</p>
                        </div>
                      </div>

                      {/* ──────────────────────────────────────── */}
                      {/* FOLLOW-UP FLOW                          */}
                      {/* ──────────────────────────────────────── */}
                      {(() => {
                        const fuKey = idx.toString();
                        const fu = followUps[fuKey];
                        const SEVERITY_OPTS = [
                          { value: '1', label: '1 · Very minor' },
                          { value: '2', label: '2 · Mild' },
                          { value: '3', label: '3 · Moderate' },
                          { value: '4', label: '4 · Serious' },
                          { value: '5', label: '5 · Urgent' },
                          { value: 'not_sure', label: 'Not sure' },
                        ];
                        const REASONING_OPTS = [
                          { value: 'mileage', label: 'Mileage / routine' },
                          { value: 'visible_wear', label: 'Visible wear' },
                          { value: 'leak_failure', label: 'Leak / failure seen' },
                          { value: 'symptoms', label: 'My symptoms' },
                          { value: 'couldnt_explain', label: "Couldn't explain" },
                        ];
                        const WAIT_OPTS = [
                          { value: 'safe', label: 'Safe to wait' },
                          { value: 'might_worsen', label: 'Might worsen slowly' },
                          { value: 'could_damage', label: 'Could cause damage' },
                          { value: 'didnt_say', label: "Didn't say" },
                          { value: 'not_sure', label: 'Not sure' },
                        ];
                        const Pill = ({ opts, field }: { opts: {value:string,label:string}[], field: keyof FollowUpInput }) => (
                          <div className="flex flex-wrap gap-1.5">
                            {opts.map(opt => (
                              <button
                                key={opt.value}
                                onClick={() => updateFollowUpField(fuKey, field, opt.value)}
                                className={\`px-3 py-1.5 rounded-full text-[11px] font-semibold border transition-all \${
                                  fu?.input?.[field] === opt.value
                                    ? 'bg-[#00236F] text-white border-[#00236F]'
                                    : 'bg-white text-slate-600 border-slate-200 hover:border-[#00236F]/30 hover:text-[#00236F]'
                                }\`}
                              >
                                {opt.label}
                              </button>
                            ))}
                          </div>
                        );

                        // STATE: RESULT shown
                        if (fu?.result) {
                          const verdictColor = fu.result.verdict === 'approve'
                            ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
                            : fu.result.verdict === 'wait'
                              ? 'bg-slate-50 border-slate-200 text-slate-800'
                              : 'bg-amber-50 border-amber-200 text-amber-800';
                          const verdictIcon = fu.result.verdict === 'approve' ? '✓' : fu.result.verdict === 'wait' ? '⏳' : '⚠';
                          return (
                            <div className="border-t border-slate-100 pt-5">
                              <p className="text-[10px] font-black text-[#00236F] uppercase tracking-widest mb-3">Updated take</p>
                              <div className={\`p-4 rounded-xl border \${verdictColor} mb-3\`}>
                                <div className="flex items-start gap-2 mb-2">
                                  <span className="text-base leading-none mt-0.5">{verdictIcon}</span>
                                  <p className="text-sm font-bold leading-snug">{fu.result.recommendation}</p>
                                </div>
                                <p className="text-xs leading-relaxed opacity-80 mb-3">{fu.result.explanation}</p>
                                <p className="text-xs font-semibold border-t border-current/10 pt-2 opacity-90">Next step: {fu.result.next_step}</p>
                              </div>
                              <button
                                onClick={() => resetFollowUp(fuKey)}
                                className="text-xs text-slate-400 hover:text-slate-600 transition-colors"
                              >
                                ↩ Update answers
                              </button>
                            </div>
                          );
                        }

                        // STATE: FORM open
                        if (fu?.open) {
                          const canSubmit = !!(fu?.input?.severity && fu?.input?.reasoning && fu?.input?.waitRisk) && !fu?.loading;
                          return (
                            <div className="border-t border-slate-100 pt-5 space-y-5">
                              <div className="flex items-center justify-between">
                                <p className="text-[10px] font-black text-[#00236F] uppercase tracking-widest">After talking to the shop</p>
                                <button onClick={() => toggleFollowUp(fuKey)} className="text-xs text-slate-400 hover:text-slate-600">✕ Cancel</button>
                              </div>
                              <div>
                                <p className="text-xs font-semibold text-slate-600 mb-2">How severe did they say it is?</p>
                                <Pill opts={SEVERITY_OPTS} field="severity" />
                              </div>
                              <div>
                                <p className="text-xs font-semibold text-slate-600 mb-2">What was their reasoning?</p>
                                <Pill opts={REASONING_OPTS} field="reasoning" />
                              </div>
                              <div>
                                <p className="text-xs font-semibold text-slate-600 mb-2">What did they say happens if you wait?</p>
                                <Pill opts={WAIT_OPTS} field="waitRisk" />
                              </div>
                              <div>
                                <p className="text-xs font-semibold text-slate-600 mb-2">Anything else they told you?</p>
                                <textarea
                                  className="w-full text-sm bg-slate-50 border border-slate-200 rounded-lg p-3 resize-none text-slate-700 placeholder:text-slate-400 focus:outline-none focus:border-[#00236F]/40 focus:ring-1 focus:ring-[#00236F]/20 transition-all"
                                  rows={2}
                                  placeholder="Optional — e.g. 'They showed me the fluid and it looked dark'"
                                  value={fu?.input?.notes || ''}
                                  onChange={(e) => updateFollowUpField(fuKey, 'notes', e.target.value)}
                                />
                              </div>
                              <button
                                onClick={() => submitFollowUp(fuKey, item, name)}
                                disabled={!canSubmit}
                                className="w-full bg-[#00236F] text-white py-3 rounded-xl text-sm font-bold disabled:opacity-30 disabled:cursor-not-allowed hover:bg-[#001855] transition-colors flex items-center justify-center gap-2"
                              >
                                {fu?.loading ? (
                                  <>
                                    <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                                    Updating recommendation...
                                  </>
                                ) : (
                                  <>
                                    Update recommendation
                                    <ArrowRight className="w-4 h-4" />
                                  </>
                                )}
                              </button>
                            </div>
                          );
                        }

                        // STATE: COLLAPSED (default)
                        return (
                          <div className="border-t border-slate-100 pt-4">
                            <button
                              onClick={() => toggleFollowUp(fuKey)}
                              className="group flex items-center gap-2 text-sm font-semibold text-slate-400 hover:text-[#00236F] transition-colors"
                            >
                              <span className="w-5 h-5 rounded-full border border-slate-200 group-hover:border-[#00236F]/30 flex items-center justify-center text-[10px] transition-colors">+</span>
                              After talking to the shop? Tell us what they said.
                            </button>
                          </div>
                        );
                      })()}

                    </div>
                  </div>
                );
              })}`;

if (content.includes(ifMyCarEnd)) {
  content = content.replace(ifMyCarEnd, ifMyCarReplacement);
  console.log('SUCCESS: Follow-up UI injected into decision boxes');
} else {
  console.error('ERROR: Could not find target block to inject follow-up UI');
  process.exit(1);
}

fs.writeFileSync(path, content);
// Count lines
const lineCount = content.split('\n').length;
console.log(`File now has ${lineCount} lines`);
