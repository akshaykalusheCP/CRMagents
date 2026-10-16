import { CheckCircle2, ClipboardCheck, History, Loader2, Pencil, Play, Plus, Trash2, XCircle } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api, type AssistantTest, type TestRun } from '../api';
import { Status, toast } from './ui';

// Test set for an assistant: real questions with what a good answer says. Run it after changing the instructions,
// tools or guides, before people (or website visitors) rely on the change. Tests read data but never change it.

export interface TestDraft { question: string; expect: string; n: number }
const words = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);
const empty = { question: '', expect: '', include: '', not: '' };

export function AssistantTests({ tenantId, agentId, draft }: { tenantId: string; agentId: string; draft?: TestDraft | null }) {
  const [websiteOn, setWebsiteOn] = useState(false);
  const [tests, setTests] = useState<AssistantTest[]>([]);
  const [runs, setRuns] = useState<TestRun[]>([]);
  const [form, setForm] = useState<typeof empty | null>(null);
  const [editing, setEditing] = useState<string | undefined>();
  const [recent, setRecent] = useState<{ question: string; answer: string }[] | null>(null);
  const [channel, setChannel] = useState<'internal' | 'website'>('internal');
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const formRef = useRef<HTMLDivElement>(null);

  const load = () => api.tests(tenantId, agentId).then((r) => { setTests(r.tests); setRuns(r.runs); return r; });
  useEffect(() => {
    setForm(null); setRecent(null); setOpen(null); setChannel('internal');
    void load().catch(() => {});
    // When it also answers on the website, tests can ask as a visitor (public rules and tools).
    api.publicChat(tenantId, agentId).then((c) => setWebsiteOn(c.enabled)).catch(() => setWebsiteOn(false));
  }, [agentId]); // eslint-disable-line react-hooks/exhaustive-deps
  // "Save as test" from the Try-it conversation.
  useEffect(() => {
    if (!draft) return;
    setEditing(undefined);
    setForm({ question: draft.question, expect: draft.expect, include: '', not: '' });
    setTimeout(() => formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 50);
  }, [draft?.n]); // eslint-disable-line react-hooks/exhaustive-deps

  const running = runs[0]?.status === 'running';
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => void load().then((r) => {
      if (r.runs[0]?.status !== 'running') toast(`Tests finished: ${r.runs[0].passed} of ${r.runs[0].total} passed`, r.runs[0].passed === r.runs[0].total ? 'ok' : 'bad');
    }).catch(() => {}), 2500);
    return () => clearInterval(t);
  }, [running]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async () => {
    if (!form) return;
    setBusy(true);
    try {
      await api.saveTest(tenantId, agentId, { question: form.question, expect: form.expect, mustInclude: words(form.include), mustNot: words(form.not) }, editing);
      setForm(null); setEditing(undefined);
      await load();
      toast(editing ? 'Test saved' : 'Test added');
    } catch (e) { toast((e as Error).message, 'bad'); }
    setBusy(false);
  };
  const run = async () => {
    setBusy(true);
    try { await api.runTests(tenantId, agentId, channel); await load(); setOpen(null); }
    catch (e) { toast((e as Error).message, 'bad'); }
    setBusy(false);
  };
  const last = runs[0];
  const lastResult = (id: string) => last?.results.find((r) => r.testId === id);

  return (
    <div className="try at">
      <div className="row between">
        <h3 className="row" style={{ gap: 6 }}><ClipboardCheck size={16} /> Tests</h3>
        <div className="row" style={{ gap: 8 }}>
          {websiteOn && (
            <select className="sm" value={channel} onChange={(e) => setChannel(e.target.value as 'internal' | 'website')} aria-label="Ask as">
              <option value="internal">As your team</option>
              <option value="website">As a website visitor</option>
            </select>
          )}
          <button className="primary sm" onClick={() => void run()} disabled={busy || running || !tests.length}>
            {running ? <Loader2 size={14} className="spin" /> : <Play size={14} />} {running ? `Running ${last.results.length}/${last.total}` : `Run ${tests.length || ''} test${tests.length === 1 ? '' : 's'}`}
          </button>
        </div>
      </div>
      <p className="muted small" style={{ margin: 0 }}>
        Questions people really ask, with what a good answer says. Run them after you change the instructions, tools or guides.
        Tests read your data but never change it, open cases or email anyone.
      </p>

      {last && last.status !== 'running' && (
        <div className={'at-summary ' + (last.status === 'error' ? 'bad' : last.passed === last.total ? 'ok' : 'bad')}>
          {last.status === 'error' ? <XCircle size={16} /> : last.passed === last.total ? <CheckCircle2 size={16} /> : <XCircle size={16} />}
          <span>
            {last.status === 'error' ? `The test run failed: ${last.results[0]?.error ?? 'unknown error'}` : <><b>{last.passed} of {last.total} passed</b>{last.channel === 'website' ? ' as a website visitor' : ''}</>}
            <span className="muted"> · {new Date(last.createdAt).toLocaleString()} · ${last.costUsd.toFixed(3)}</span>
          </span>
          {runs.length > 1 && <span className="at-trend" title="Earlier runs"><History size={13} /> {runs.slice(1, 6).map((r) => `${r.passed}/${r.total}`).join('  ')}</span>}
        </div>
      )}

      {tests.length > 0 && (
        <ul className="at-list">
          {tests.map((t) => {
            const r = lastResult(t.id);
            return (
              <li key={t.id} className={open === t.id ? 'open' : ''}>
                <button className="at-row" onClick={() => setOpen(open === t.id ? null : t.id)} aria-expanded={open === t.id}>
                  {r ? (r.pass ? <CheckCircle2 size={16} className="at-ok" /> : <XCircle size={16} className="at-bad" />) : running ? <Loader2 size={16} className="spin muted" /> : <span className="at-dot" />}
                  <span className="at-q">{t.question}</span>
                  {r && !r.pass && <span className="at-why">{r.reasons[0]}</span>}
                </button>
                {open === t.id && (
                  <div className="at-detail">
                    {t.expect && <div><small>A good answer</small><p>{t.expect}</p></div>}
                    {(t.mustInclude.length > 0 || t.mustNot.length > 0) && (
                      <div className="at-words">
                        {t.mustInclude.map((w) => <Status key={'i' + w} tone="ok">says “{w}”</Status>)}
                        {t.mustNot.map((w) => <Status key={'n' + w} tone="bad">never “{w}”</Status>)}
                      </div>
                    )}
                    {r && <div><small>Last answer{r.tools.length ? ` · used ${r.tools.join(', ')}` : ''}</small><p className="at-answer">{r.answer || '(no answer)'}</p>
                      {r.reasons.length > 0 && <ul className="at-reasons">{r.reasons.map((x, i) => <li key={i}>{x}</li>)}</ul>}</div>}
                    <div className="row" style={{ gap: 6 }}>
                      <button className="sm" onClick={() => { setEditing(t.id); setForm({ question: t.question, expect: t.expect, include: t.mustInclude.join(', '), not: t.mustNot.join(', ') }); }}><Pencil size={13} /> Edit</button>
                      <button className="sm ghost" onClick={() => void api.deleteTest(tenantId, agentId, t.id).then(load).then(() => toast('Test removed'))}><Trash2 size={13} /> Remove</button>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {form ? (
        <div className="at-form form" ref={formRef}>
          <div className="frow"><div className="flabel"><b>Question</b></div>
            <div className="ffield"><input value={form.question} onChange={(e) => setForm({ ...form, question: e.target.value })} placeholder="e.g. How long do refunds take?" autoFocus /></div></div>
          <div className="frow"><div className="flabel"><b>A good answer</b><span>What it should say, in your words. Checked for meaning, not exact wording. Optional.</span></div>
            <div className="ffield"><textarea rows={3} value={form.expect} onChange={(e) => setForm({ ...form, expect: e.target.value })} placeholder="Refunds reach the card in 5-7 business days after we receive the item." /></div></div>
          <div className="frow"><div className="flabel"><b>Must say</b><span>Words or numbers, separated by commas.</span></div>
            <div className="ffield"><input value={form.include} onChange={(e) => setForm({ ...form, include: e.target.value })} placeholder="5-7 business days" /></div></div>
          <div className="frow"><div className="flabel"><b>Must never say</b><span>For example a promise you can't keep.</span></div>
            <div className="ffield"><input value={form.not} onChange={(e) => setForm({ ...form, not: e.target.value })} placeholder="guarantee, free shipping" /></div></div>
          <div className="row" style={{ gap: 8 }}>
            <button className="primary sm" onClick={() => void save()} disabled={busy || !form.question.trim()}>{editing ? 'Save test' : 'Add test'}</button>
            <button className="sm" onClick={() => { setForm(null); setEditing(undefined); }}>Cancel</button>
          </div>
        </div>
      ) : (
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <button className="sm" onClick={() => { setEditing(undefined); setForm({ ...empty }); }}><Plus size={14} /> Add a test</button>
          <button className="sm ghost" onClick={() => void api.recentQuestions(tenantId, agentId).then(setRecent).catch((e) => toast((e as Error).message, 'bad'))}>Pick from recent questions</button>
        </div>
      )}

      {recent && !form && (
        <div className="at-recent">
          {recent.length === 0 ? <span className="muted small">No new questions yet. Ask it something above, or wait until people use it.</span> : recent.map((q) => (
            <button key={q.question} className="at-pick" onClick={() => { setRecent(null); setEditing(undefined); setForm({ question: q.question, expect: q.answer, include: '', not: '' }); }}>
              <b>{q.question}</b><span>{q.answer.slice(0, 140)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
