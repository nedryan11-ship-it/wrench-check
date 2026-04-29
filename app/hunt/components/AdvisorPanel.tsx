"use client";

import { useRef } from "react";
import ReactMarkdown from "react-markdown";

interface AdvisorFile {
  name: string;
  type: string;
  dataUrl: string;
}

interface AdvisorPanelProps {
  sessions: any[];
  activeSessionId: string | null;
  sessionsLoaded: boolean;
  chat: { role: string; content: string }[];
  loading: boolean;
  input: string;
  files: AdvisorFile[];
  onInputChange: (value: string) => void;
  onFilesChange: (updater: (prev: AdvisorFile[]) => AdvisorFile[]) => void;
  onSendMessage: (msg: string) => void;
  onCreateSession: () => Promise<void>;
  onSwitchSession: (sessionId: string) => void;
  endRef: React.RefObject<HTMLDivElement | null>;
}

export default function AdvisorPanel({
  sessions, activeSessionId, sessionsLoaded,
  chat, loading, input, files,
  onInputChange, onFilesChange, onSendMessage,
  onCreateSession, onSwitchSession, endRef,
}: AdvisorPanelProps) {
  const fileRef = useRef<HTMLInputElement>(null);

  return (
    <div style={{ display: 'flex', height: 'calc(100vh - 220px)', background: '#FAFBFF', borderRadius: 16, border: '1px solid #E0E7FF', overflow: 'hidden' }}>
      {/* Session sidebar */}
      <div style={{ width: 220, borderRight: '1px solid #E0E7FF', background: '#fff', display: 'flex', flexDirection: 'column', flexShrink: 0 }}>
        <div style={{ padding: '12px 14px', borderBottom: '1px solid #E0E7FF', display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ width: 28, height: 28, borderRadius: '50%', background: 'linear-gradient(135deg, #4F46E5, #7C3AED)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14 }}>🧠</div>
          <div style={{ fontSize: 13, fontWeight: 800, color: '#1E293B', flex: 1 }}>Advisor</div>
          <button
            onClick={async () => { await onCreateSession(); }}
            style={{ fontSize: 11, color: '#4F46E5', background: '#EEF2FF', border: '1px solid #C7D2FE', borderRadius: 6, padding: '3px 10px', cursor: 'pointer', fontWeight: 700, whiteSpace: 'nowrap' }}
          >+ New</button>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: '6px 0' }}>
          {sessions.map((s: any) => (
            <button
              key={s.id}
              onClick={() => onSwitchSession(s.id)}
              style={{
                display: 'block', width: '100%', textAlign: 'left', padding: '10px 14px', border: 'none', cursor: 'pointer',
                background: s.id === activeSessionId ? '#EEF2FF' : 'transparent',
                borderLeft: s.id === activeSessionId ? '3px solid #4F46E5' : '3px solid transparent',
                transition: 'all 0.1s',
              }}
            >
              <div style={{ fontSize: 12, fontWeight: s.id === activeSessionId ? 700 : 500, color: s.id === activeSessionId ? '#4F46E5' : '#334155', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {s.title || 'New conversation'}
              </div>
              <div style={{ fontSize: 10, color: '#94A3B8', marginTop: 2 }}>
                {new Date(s.updated_at || s.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
              </div>
            </button>
          ))}
          {sessions.length === 0 && sessionsLoaded && (
            <div style={{ padding: '20px 14px', fontSize: 11, color: '#94A3B8', textAlign: 'center' }}>No conversations yet</div>
          )}
        </div>
      </div>

      {/* Main chat panel */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {/* Header */}
        <div style={{ padding: '12px 20px', borderBottom: '1px solid #E0E7FF', background: '#fff', display: 'flex', alignItems: 'center', gap: 12 }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 800, color: '#1E293B' }}>
              {sessions.find((s: any) => s.id === activeSessionId)?.title || 'WrenchCheck Advisor'}
            </div>
            <div style={{ fontSize: 11, color: '#64748B' }}>Your board · your preferences · one conversation</div>
          </div>
        </div>

        {/* Messages */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          {chat.length === 0 && !loading && (
            <div style={{ textAlign: 'center', padding: '60px 20px', color: '#94A3B8' }}>
              <div style={{ fontSize: 48, marginBottom: 16 }}>🧠</div>
              <div style={{ fontSize: 16, fontWeight: 700, color: '#475569', marginBottom: 8 }}>Your deal broker is ready</div>
              <div style={{ fontSize: 13, lineHeight: 1.6, maxWidth: 400, margin: '0 auto', marginBottom: 20 }}>
                Ask about any car on your board, compare your top picks, get TCO estimates, challenge your rankings, or just say hi for a morning check-in.
              </div>
              <div style={{ display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
                {[
                  { label: '🧠 Morning check-in', msg: '' },
                  { label: '🔥 Compare my top 3', msg: 'Compare my top 3 Focus vehicles. Which is the best buy and why?' },
                  { label: '📊 Market trends', msg: 'Walk me through Land Cruiser 200-series pricing trends over the last 3 years. Where are we headed?' },
                  { label: '💰 What should I offer?', msg: `What should I offer on my #1 ranked vehicle? Give me a specific dollar number and the script for the call.` },
                ].map(({ label, msg }) => (
                  <button key={label} onClick={() => onSendMessage(msg)}
                    style={{ padding: '8px 16px', borderRadius: 99, fontSize: 12, fontWeight: 700, border: '1px solid #C7D2FE', background: '#EEF2FF', color: '#4F46E5', cursor: 'pointer', transition: 'all 0.15s' }}
                    onMouseEnter={e => { (e.target as HTMLElement).style.background = '#4F46E5'; (e.target as HTMLElement).style.color = '#fff'; }}
                    onMouseLeave={e => { (e.target as HTMLElement).style.background = '#EEF2FF'; (e.target as HTMLElement).style.color = '#4F46E5'; }}
                  >{label}</button>
                ))}
              </div>
            </div>
          )}

          {chat.map((msg, i) => (
            <div key={i} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', flexDirection: msg.role === 'user' ? 'row-reverse' : 'row' }}>
              <div style={{ width: 30, height: 30, borderRadius: '50%', background: msg.role === 'user' ? '#334155' : 'linear-gradient(135deg, #4F46E5, #7C3AED)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14, color: '#fff', flexShrink: 0 }}>
                {msg.role === 'user' ? '👤' : '🧠'}
              </div>
              <div style={{
                maxWidth: '85%', padding: '12px 16px',
                background: msg.role === 'user' ? '#1E293B' : '#fff',
                color: msg.role === 'user' ? '#E2E8F0' : '#1E293B',
                borderRadius: msg.role === 'user' ? '16px 16px 4px 16px' : '4px 16px 16px 16px',
                fontSize: 13, lineHeight: 1.75,
                border: msg.role === 'user' ? 'none' : '1px solid #E2E8F0',
                boxShadow: msg.role === 'user' ? 'none' : '0 1px 3px rgba(0,0,0,0.04)',
                ...(msg.role === 'user' ? { whiteSpace: 'pre-wrap' as const } : {}),
              }}>
                {msg.role === 'user' ? msg.content : (
                  <div className="advisor-md">
                    <ReactMarkdown
                      components={{
                        h1: ({children}) => <div style={{ fontSize: 16, fontWeight: 800, margin: '12px 0 6px' }}>{children}</div>,
                        h2: ({children}) => <div style={{ fontSize: 15, fontWeight: 800, margin: '10px 0 4px' }}>{children}</div>,
                        h3: ({children}) => <div style={{ fontSize: 14, fontWeight: 700, margin: '8px 0 4px' }}>{children}</div>,
                        p: ({children}) => <div style={{ margin: '4px 0' }}>{children}</div>,
                        strong: ({children}) => <strong style={{ fontWeight: 700 }}>{children}</strong>,
                        em: ({children}) => <em>{children}</em>,
                        ul: ({children}) => <ul style={{ margin: '4px 0', paddingLeft: 18 }}>{children}</ul>,
                        ol: ({children}) => <ol style={{ margin: '4px 0', paddingLeft: 18 }}>{children}</ol>,
                        li: ({children}) => <li style={{ margin: '2px 0' }}>{children}</li>,
                        hr: () => <div style={{ borderTop: '1px solid #E2E8F0', margin: '10px 0' }} />,
                        code: ({children, className}) => {
                          const isBlock = className?.includes('language-');
                          return isBlock
                            ? <pre style={{ background: '#F1F5F9', padding: 10, borderRadius: 8, fontSize: 12, overflow: 'auto', margin: '6px 0' }}><code>{children}</code></pre>
                            : <code style={{ background: '#F1F5F9', padding: '1px 5px', borderRadius: 4, fontSize: 12 }}>{children}</code>;
                        },
                        a: ({href, children}) => <a href={href} target="_blank" rel="noopener noreferrer" style={{ color: '#4F46E5', textDecoration: 'underline' }}>{children}</a>,
                        blockquote: ({children}) => <blockquote style={{ borderLeft: '3px solid #C7D2FE', paddingLeft: 12, margin: '6px 0', color: '#64748B' }}>{children}</blockquote>,
                      }}
                    >{msg.content}</ReactMarkdown>
                  </div>
                )}
              </div>
            </div>
          ))}

          {loading && (
            <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              <div style={{ width: 30, height: 30, borderRadius: '50%', background: 'linear-gradient(135deg, #4F46E5, #7C3AED)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14, color: '#fff' }}>🧠</div>
              <div style={{ fontSize: 13, color: '#64748B', fontStyle: 'italic' }}>Thinking…</div>
            </div>
          )}
          <div ref={endRef} />
        </div>

        {/* Input */}
        <div style={{ borderTop: '1px solid #E0E7FF', background: '#fff' }}>
          {/* File preview strip */}
          {files.length > 0 && (
            <div style={{ padding: '8px 16px 0', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {files.map((f, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '4px 8px', borderRadius: 8, background: '#EEF2FF', border: '1px solid #C7D2FE', fontSize: 11, color: '#4F46E5' }}>
                  {f.type.startsWith('image/') ? '🖼' : '📄'} {f.name.length > 25 ? f.name.slice(0, 22) + '…' : f.name}
                  <button onClick={() => onFilesChange(prev => prev.filter((_, j) => j !== i))} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 12, color: '#94A3B8', padding: 0, marginLeft: 2 }}>✕</button>
                </div>
              ))}
            </div>
          )}
          <div style={{ padding: '12px 16px', display: 'flex', gap: 8, alignItems: 'center' }}>
            {/* Hidden file input */}
            <input
              ref={fileRef}
              type="file"
              accept="image/*,.pdf"
              multiple
              style={{ display: 'none' }}
              onChange={e => {
                const selectedFiles = Array.from(e.target.files || []);
                selectedFiles.forEach(file => {
                  const reader = new FileReader();
                  reader.onload = () => {
                    onFilesChange(prev => [...prev, { name: file.name, type: file.type, dataUrl: reader.result as string }]);
                  };
                  reader.readAsDataURL(file);
                });
                e.target.value = '';
              }}
            />
            {/* Attach button */}
            <button
              onClick={() => fileRef.current?.click()}
              title="Attach image or PDF (CarFax, listing screenshot, etc.)"
              style={{ flexShrink: 0, width: 36, height: 36, borderRadius: 10, border: '1px solid #CBD5E1', background: '#F8FAFC', cursor: 'pointer', fontSize: 16, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            >📎</button>
            <input
              value={input}
              onChange={e => onInputChange(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && (input.trim() || files.length > 0)) { e.preventDefault(); onSendMessage(input); } }}
              onPaste={e => {
                const items = Array.from(e.clipboardData?.items || []);
                const imageItems = items.filter(item => item.type.startsWith('image/'));
                if (imageItems.length > 0) {
                  e.preventDefault();
                  imageItems.forEach(item => {
                    const blob = item.getAsFile();
                    if (!blob) return;
                    const reader = new FileReader();
                    reader.onload = () => {
                      onFilesChange(prev => [...prev, {
                        name: `pasted-image-${Date.now()}.${blob.type.split('/')[1] || 'png'}`,
                        type: blob.type,
                        dataUrl: reader.result as string,
                      }]);
                    };
                    reader.readAsDataURL(blob);
                  });
                }
              }}
              placeholder="Ask about any car, compare picks, or paste/attach a screenshot…"
              style={{ flex: 1, padding: '11px 16px', borderRadius: 12, border: '1px solid #C7D2FE', fontSize: 13, outline: 'none', background: '#FAFBFF', transition: 'border 0.15s' }}
              onFocus={e => (e.target as HTMLElement).style.borderColor = '#4F46E5'}
              onBlur={e => (e.target as HTMLElement).style.borderColor = '#C7D2FE'}
            />
            <button
              onClick={() => { if (input.trim() || files.length > 0) onSendMessage(input); }}
              disabled={loading || (!input.trim() && files.length === 0)}
              style={{ padding: '11px 20px', background: loading ? '#C7D2FE' : '#4F46E5', color: '#fff', border: 'none', borderRadius: 12, fontSize: 13, fontWeight: 700, cursor: loading ? 'default' : 'pointer', transition: 'all 0.15s' }}
            >
              {loading ? '…' : '↑ Send'}
            </button>
          </div>
        </div>
      </div> {/* end main chat panel */}
    </div>
  );
}
