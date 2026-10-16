import { ArrowLeft, ArrowUp, CircleAlert, Clock, Filter, ListOrdered, Loader2, ShieldCheck, Sparkles, Wrench } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { NODE_DEF_BY_TYPE } from '@crmagents/shared';
import { api, type ChatMsg, type Draft } from '../api';
import { NodeTile } from './nodeIcons';

// Build an agent by chatting. Left: the conversation (the AI asks at most two short questions, answers are one
// tap). Right: the agent as it takes shape — when it runs, its rules, its steps, what it may use — so the admin
// sees what they're getting before opening the full editor to test and turn it on.

const EXAMPLES = [
  'When a new case comes in, sort it by type and create a follow-up task for the owner',
  'Every Monday, find deals with no activity in 14 days and create a task for each owner',
  'When a lead is created, score it from 0 to 100 and set its rating',
  'When an opportunity is Closed Won, email the account owner a short summary',
];

/** Plain label for what a step uses, including the org's own Flows and Apex. */
function useLabel(type: string, config: Record<string, unknown>): string {
  if (type === 'sf.action') {
    const [kind, name = ''] = String(config.action ?? '').split(':');
    const nice = name.replace(/^\w+?__/, '').replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2');
    return kind === 'standard' ? ({ emailSimple: 'Send email', chatterPost: 'Chatter post', submit: 'Submit for approval' } as Record<string, string>)[name] ?? nice
      : `${kind === 'flow' ? 'Flow' : 'Apex'}: ${nice}`;
  }
  if (type === 'sf.createRecord' || type === 'sf.updateRecord') return `${type === 'sf.createRecord' ? 'Create' : 'Update'} ${config.sobject ?? 'record'}`;
  return NODE_DEF_BY_TYPE[type]?.label ?? type;
}

const HIDDEN = new Set(['trigger.salesforce', 'trigger.manual', 'trigger.schedule', 'util.output', 'sf.getRecord', 'logic.branch', 'logic.approval', 'logic.loop']);

export function AgentBuilder({ tenantId, first, onBack, onOpen }: {
  tenantId: string; first?: string; onBack: () => void; onOpen: (d: Draft) => void;
}) {
  const [msgs, setMsgs] = useState<ChatMsg[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [spent, setSpent] = useState(0);
  const end = useRef<HTMLDivElement>(null);
  const draft = [...msgs].reverse().find((m) => m.draft)?.draft;

  useEffect(() => { end.current?.scrollIntoView({ behavior: 'smooth' }); }, [msgs, busy]);
  useEffect(() => { if (first?.trim()) void send(first); }, []);

  async function send(raw: string) {
    const t = raw.trim();
    if (t.length < 3 || busy) return;
    const next: ChatMsg[] = [...msgs, { role: 'user', text: t }];
    setMsgs(next); setText(''); setBusy(true); setErr('');
    try {
      const r = await api.builderChat(tenantId, next.map(({ role, text }) => ({ role, text })), draft?.plan);
      setSpent((s) => s + r.costUsd);
      setMsgs([...next, { role: 'assistant', text: r.reply, options: r.options, draft: r.draft }]);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setMsgs(msgs); setText(t); // let them retry without retyping
    } finally { setBusy(false); }
  }

  const lastAi = msgs[msgs.length - 1]?.role === 'assistant' ? msgs[msgs.length - 1] : undefined;

  return (
    <div className="ab">
      <section className="ab-chat" aria-label="Build with AI">
        <div className="ab-chat-head">
          <button className="ghost icon" onClick={onBack} title="Back to agents"><ArrowLeft size={16} /></button>
          <h3><Sparkles size={16} color="var(--accent)" /> Build with AI</h3>
          {spent > 0 && <span className="muted small" title="AI cost of building so far">${spent.toFixed(4)}</span>}
        </div>
        <div className="ab-msgs" aria-live="polite">
          {!msgs.length && (
            <div className="ab-welcome">
              <b>What should your agent do?</b>
              <span className="muted">Say it like you'd tell a colleague. I'll ask if something's missing, and I can use your org's own Flows and Apex.</span>
              <div className="ab-examples">
                {EXAMPLES.map((x) => <button key={x} className="chip example" onClick={() => void send(x)}>{x}</button>)}
              </div>
            </div>
          )}
          {msgs.map((m, i) => (
            <div key={i} className={'msg ' + (m.role === 'user' ? 'me' : 'ai')}>
              <div className="bubble">{m.text}</div>
              {m === lastAi && !!m.options?.length && !busy && (
                <div className="msg-options">
                  {m.options.map((o) => <button key={o} className="chip example" onClick={() => void send(o)}>{o}</button>)}
                </div>
              )}
            </div>
          ))}
          {busy && <div className="msg ai"><div className="bubble typing"><Loader2 size={14} className="spin" /> {draft ? 'Updating the agent…' : 'Reading your org…'}</div></div>}
          {err && <div className="card warn small">{err}</div>}
          <div ref={end} />
        </div>
        <form className="ab-input" onSubmit={(e) => { e.preventDefault(); void send(text); }}>
          <textarea rows={2} value={text} onChange={(e) => setText(e.target.value)} disabled={busy} autoFocus
            placeholder={draft ? 'Ask for a change, e.g. "also email the owner"' : lastAi?.options?.length ? 'Pick an answer above or type your own' : 'Describe your agent…'}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(text); } }} />
          <button type="submit" className="primary icon" disabled={busy || text.trim().length < 3} aria-label="Send"><ArrowUp size={16} /></button>
        </form>
      </section>

      <section className="ab-preview" aria-label="Agent preview">
        {!draft ? (
          <div className="ab-card ghosted">
            <div className="ab-card-name">Your agent</div>
            {[['When it runs', Clock], ['Only if', Filter], ['Steps', ListOrdered], ['Uses', Wrench]].map(([t, I]) => {
              const Icon = I as typeof Clock;
              return <div key={t as string} className="ab-sec"><div className="ab-sec-title"><Icon size={14} /> {t as string}</div><div className="ab-skel" /><div className="ab-skel short" /></div>;
            })}
            <p className="muted small" style={{ textAlign: 'center' }}>Your agent takes shape here as you chat.</p>
          </div>
        ) : <AgentCard draft={draft} onOpen={() => onOpen(draft)} />}
      </section>
    </div>
  );
}

function AgentCard({ draft, onOpen }: { draft: Draft; onOpen: () => void }) {
  const lines = draft.summary;
  const when = lines.filter((l) => /^Runs (when|every|on demand)/i.test(l));
  const only = lines.filter((l) => /^Only if /.test(l)).map((l) => l.replace(/^Only if /, ''));
  const approval = lines.some((l) => /approve/i.test(l));
  const steps = lines.filter((l) => !when.includes(l) && !/^Only if /.test(l) && !/approve/i.test(l));
  const uses = new Map<string, string>();
  for (const n of draft.workflow.nodes) if (!HIDDEN.has(n.type)) uses.set(useLabel(n.type, n.config), n.type);
  const perRun = draft.estimateUsd;

  return (
    <div className="ab-card">
      <div className="row between">
        <div className="ab-card-name">{draft.name}</div>
        <span className="badge" title="Estimated AI cost each time it runs">{perRun > 0 ? `~$${perRun < 0.01 ? perRun.toFixed(4) : perRun.toFixed(3)} per run` : 'No AI cost'}</span>
      </div>

      <div className="ab-sec"><div className="ab-sec-title"><Clock size={14} /> When it runs</div>{when.map((l) => <div key={l}>{l.replace(/^Runs /, '').replace(/^w/, 'W')}</div>)}</div>
      {only.length > 0 && <div className="ab-sec"><div className="ab-sec-title"><Filter size={14} /> Only if</div>{only.map((l) => <div key={l}>{l}</div>)}</div>}
      <div className="ab-sec">
        <div className="ab-sec-title"><ListOrdered size={14} /> Steps</div>
        <ol className="ab-steps">{steps.map((l, i) => <li key={i} className={l.startsWith('  ↳') ? 'sub' : ''}>{l.replace(/^\s*↳\s*/, '')}</li>)}</ol>
      </div>
      <div className="ab-sec">
        <div className="ab-sec-title"><Wrench size={14} /> Uses</div>
        <div className="ab-uses">{[...uses].map(([label, type]) => <span key={label} className="ab-use"><NodeTile type={type} /> {label}</span>)}</div>
      </div>
      {approval && <div className="ab-safe"><ShieldCheck size={16} /> Asks a person to approve before changing anything</div>}
      {[...draft.errors, ...draft.warnings].length > 0 && (
        <div className="ab-issues">{[...draft.errors, ...draft.warnings].map((w) => <div key={w}><CircleAlert size={14} /> {w}</div>)}</div>
      )}
      <div className="ab-actions">
        <span className="muted small">Next: try it on real records, then turn it on.</span>
        <button className="primary cta" onClick={onOpen}>Review &amp; test</button>
      </div>
    </div>
  );
}
