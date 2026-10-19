import { CheckCircle2, KeyRound, Loader2, MoreHorizontal, Plus, Star, XCircle, Zap } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, type AiKey, type AiKeyInput, type Me } from '../api';
import { Drawer, Menu, Panel, Status, toast, useConfirm } from './ui';

// AI keys: several keys (any provider), one primary that everything uses, backups tried in order when the primary
// fails (bad key, no credit, rate limits, provider down). Test any key, even before saving it.

const PROVIDERS: { id: AiKey['provider']; label: string; hint: string }[] = [
  { id: 'anthropic', label: 'Claude (Anthropic)', hint: 'Recommended and tested most. Keys start with sk-ant-.' },
  { id: 'openai', label: 'OpenAI', hint: 'Keys start with sk-.' },
  { id: 'gemini', label: 'Google Gemini', hint: 'Keys from Google AI Studio (AIza…).' },
  { id: 'compatible', label: 'Other (OpenAI-compatible)', hint: 'Azure OpenAI, Mistral, DeepSeek, a model you host…' },
];
const NAME = Object.fromEntries(PROVIDERS.map((p) => [p.id, p.label])) as Record<AiKey['provider'], string>;
const ago = (d: string) => { const m = (Date.now() - Date.parse(d)) / 60000; return m < 1 ? 'just now' : m < 60 ? `${Math.round(m)} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`; };
type TestResult = Awaited<ReturnType<typeof api.testAiKey>>;

export function AiKeys({ me }: { me?: Me }) {
  const admin = !me || me.role === 'owner' || me.role === 'admin';
  const [data, setData] = useState<{ keys: AiKey[]; platformDefault: boolean }>();
  const [busy, setBusy] = useState<string>('');
  const [edit, setEdit] = useState<AiKey | 'new' | null>(null);
  const [confirmUi, ask] = useConfirm();
  const load = () => api.aiKeys().then(setData).catch((e) => toast((e as Error).message, 'bad'));
  useEffect(() => { void load(); }, []);

  const run = async (id: string, f: () => Promise<unknown>, ok?: string) => {
    setBusy(id);
    try { await f(); if (ok) toast(ok); } catch (e) { toast((e as Error).message, 'bad'); }
    setBusy(''); await load();
  };
  const test = (k: AiKey) => run(`test-${k.id}`, async () => {
    const r = await api.testAiKey(k.id);
    toast(r.ok ? `${k.label} works · ${r.ms} ms · ${r.model}` : `${k.label}: ${r.error}`, r.ok ? 'ok' : 'bad');
  });
  const testAll = async () => {
    setBusy('test-all');
    let ok = 0;
    for (const k of data?.keys ?? []) { const r = await api.testAiKey(k.id).catch(() => ({ ok: false })); if (r.ok) ok++; }
    setBusy(''); await load();
    toast(`${ok} of ${data?.keys.length ?? 0} keys work`, ok === data?.keys.length ? 'ok' : 'bad');
  };
  const remove = async (k: AiKey) => {
    const others = (data?.keys ?? []).filter((x) => x.id !== k.id);
    const yes = await ask({ title: `Remove "${k.label}"?`, danger: true, confirm: 'Remove key',
      body: k.primary ? (others.length ? `It's the primary key: "${others.find((x) => x.backup)?.label ?? others[0].label}" takes over.` : 'It\'s your only key: AI steps stop until you add another.') : 'The key is deleted from Nimbus. It still works at the provider until you revoke it there.' });
    if (yes) await run(`rm-${k.id}`, () => api.removeAiKey(k.id), 'Key removed');
  };

  if (!data) return <Panel title="AI keys"><p className="muted small" style={{ margin: 0 }}>Loading…</p></Panel>;
  const keys = data.keys;
  return (
    <Panel title="AI keys" action={admin ? <div className="row" style={{ gap: 6 }}>
      {keys.length > 1 && <button className="sm" disabled={!!busy} onClick={() => void testAll()}>{busy === 'test-all' ? <Loader2 size={14} className="spin" /> : <Zap size={14} />} Test all</button>}
      <button className="sm primary" onClick={() => setEdit('new')}><Plus size={14} /> Add key</button>
    </div> : undefined}>
      {confirmUi}
      <p className="muted small" style={{ margin: '0 0 12px' }}>Everything uses the <b>primary</b> key. If it fails (bad key, no credit, rate limits, provider down), <b>backups</b> are tried in order so agents keep running. Every attempt shows in the Trust center's AI log. A test sends a few tokens (well under a cent).</p>
      {keys.length === 0 ? (
        <div className="aik-empty"><KeyRound size={20} /><div><b>No keys yet</b><span>{data.platformDefault ? 'AI currently uses the default key provided for this workspace. Add your own to control the provider and spending.' : 'Add a key to turn on agents, assistants and insights.'}</span></div>{admin && <button className="primary sm" onClick={() => setEdit('new')}><Plus size={14} /> Add key</button>}</div>
      ) : (
        <ul className="aik-list">
          {keys.map((k) => (
            <li key={k.id} className={k.primary ? 'primary' : ''}>
              <div className="aik-main">
                <div className="aik-title"><b>{k.label}</b>{k.primary ? <Status tone="ok">Primary</Status> : k.backup ? <Status tone="info">Backup {keys.filter((x) => x.backup).findIndex((x) => x.id === k.id) + 1}</Status> : <Status tone="neutral">Not in use</Status>}</div>
                <span className="aik-sub">{NAME[k.provider]}{k.model ? ` · ${k.model}` : ''}{k.fastModel && k.fastModel !== k.model ? ` / ${k.fastModel}` : ''} · <code>{k.hint}</code></span>
                <span className="aik-test">
                  {k.lastTest ? (k.lastTest.ok
                    ? <><CheckCircle2 size={13} className="ok" /> Works · {k.lastTest.ms} ms · {k.lastTest.model} · tested {ago(k.lastTest.at)}</>
                    : <><XCircle size={13} className="bad" /> Failed {ago(k.lastTest.at)}: {k.lastError?.message ?? 'see the AI log'}</>)
                    : <span className="muted">Not tested yet</span>}
                  {k.lastError && (!k.lastTest || Date.parse(k.lastError.at) > Date.parse(k.lastTest.at)) && k.lastTest?.ok && <span className="aik-warn">Last failure {ago(k.lastError.at)}: {k.lastError.message}</span>}
                  {k.lastUsedAt && <span className="muted"> · last used {ago(k.lastUsedAt)}</span>}
                </span>
              </div>
              {admin && <div className="aik-actions">
                <button className="sm" disabled={!!busy} onClick={() => void test(k)}>{busy === `test-${k.id}` ? <Loader2 size={14} className="spin" /> : <Zap size={14} />} Test</button>
                {!k.primary && <button className="sm" disabled={!!busy} onClick={() => void run(`p-${k.id}`, () => api.makePrimaryAiKey(k.id), `${k.label} is now the primary key`)}><Star size={14} /> Make primary</button>}
                <Menu align="right" trigger={() => <button className="ghost icon sm" aria-label={`More for ${k.label}`}><MoreHorizontal size={16} /></button>}>
                  {(close) => <>
                    {!k.primary && <button className="mi" onClick={() => { close(); void run(`b-${k.id}`, () => api.updateAiKey(k.id, { backup: !k.backup }), k.backup ? 'No longer a backup' : 'Added as a backup'); }}>{k.backup ? 'Stop using as backup' : 'Use as backup'}</button>}
                    <button className="mi" onClick={() => { close(); setEdit(k); }}>Edit</button>
                    <div className="msep" />
                    <button className="mi danger" onClick={() => { close(); void remove(k); }}>Remove</button>
                  </>}
                </Menu>
              </div>}
            </li>
          ))}
        </ul>
      )}
      {edit && <KeyDrawer k={edit === 'new' ? null : edit} first={keys.length === 0} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); void load(); }} />}
    </Panel>
  );
}

function KeyDrawer({ k, first, onClose, onSaved }: { k: AiKey | null; first: boolean; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState<AiKeyInput & { makePrimary: boolean }>({
    label: k?.label ?? '', provider: k?.provider ?? 'anthropic', key: '', baseUrl: k?.baseUrl ?? '', model: k?.model ?? '', fastModel: k?.fastModel ?? '',
    priceIn: k?.priceIn ?? undefined, priceOut: k?.priceOut ?? undefined, workspaceId: k?.workspaceId ?? '', makePrimary: first,
  });
  const [busy, setBusy] = useState('');
  const [result, setResult] = useState<TestResult | null>(null);
  const [err, setErr] = useState('');
  const set = (p: Partial<typeof f>) => { setF({ ...f, ...p }); setResult(null); setErr(''); };
  const other = f.provider !== 'anthropic';
  const body = (): AiKeyInput => ({ label: f.label.trim() || `${NAME[f.provider]} key`, provider: f.provider, key: f.key.trim(), baseUrl: f.baseUrl?.trim() || '', model: f.model?.trim() || undefined, fastModel: f.fastModel?.trim() || undefined, priceIn: f.priceIn, priceOut: f.priceOut, workspaceId: f.workspaceId?.trim() || undefined });
  const test = async () => {
    setBusy('test'); setErr('');
    try {
      // A new key (or a newly typed one) is tested as typed; otherwise the saved key is tested.
      setResult(f.key.trim() ? await api.testNewAiKey(body()) : k ? await api.testAiKey(k.id) : { ok: false, ms: 0, model: '', error: 'Paste the key first.' });
    } catch (e) { setErr((e as Error).message); }
    setBusy('');
  };
  const save = async () => {
    setBusy('save'); setErr('');
    try {
      if (k) {
        const b = body(); const { key, provider: _p, ...rest } = b;
        await api.updateAiKey(k.id, key ? { ...rest, key } : rest);
        toast('Key updated');
      } else {
        if (!f.key.trim()) throw new Error('Paste the API key.');
        await api.addAiKey({ ...body(), makePrimary: f.makePrimary });
        toast(f.makePrimary ? 'Key added as primary' : 'Key added');
      }
      onSaved();
    } catch (e) { setErr((e as Error).message); }
    setBusy('');
  };
  return (
    <Drawer open title={k ? `Edit "${k.label}"` : 'Add an AI key'} sub={k ? `${NAME[k.provider]} · ${k.hint}` : 'Stored encrypted; only a short hint is ever shown again.'} onClose={onClose}
      footer={<div className="row" style={{ gap: 8, justifyContent: 'flex-end', width: '100%' }}>
        <button onClick={() => void test()} disabled={!!busy}>{busy === 'test' ? <Loader2 size={14} className="spin" /> : <Zap size={14} />} Test</button>
        <button className="primary" onClick={() => void save()} disabled={!!busy}>{busy === 'save' ? <Loader2 size={14} className="spin" /> : null} {k ? 'Save changes' : 'Save key'}</button>
      </div>}>
      <div className="form aik-form">
        <label className="fl">Name<input value={f.label} onChange={(e) => set({ label: e.target.value })} placeholder={`e.g. ${NAME[f.provider]} · production`} maxLength={60} /></label>
        {!k && <label className="fl">Provider
          <select value={f.provider} onChange={(e) => set({ provider: e.target.value as AiKey['provider'] })}>{PROVIDERS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}</select>
          <span className="muted small">{PROVIDERS.find((p) => p.id === f.provider)?.hint}</span>
        </label>}
        <label className="fl">API key<input type="password" autoComplete="off" value={f.key} onChange={(e) => set({ key: e.target.value })} placeholder={k ? `${k.hint} saved · paste a new key to replace it` : f.provider === 'anthropic' ? 'sk-ant-…' : f.provider === 'gemini' ? 'AIza…' : 'sk-…'} /></label>
        {f.provider === 'anthropic' && <label className="fl">Workspace ID <span className="muted small">optional · only for user keys (sk-ant-usr-…)</span><input value={f.workspaceId ?? ''} onChange={(e) => set({ workspaceId: e.target.value })} placeholder="wrkspc_…" /></label>}
        {f.provider === 'compatible' && <label className="fl">Base URL <span className="muted small">ends before /chat/completions</span><input value={f.baseUrl ?? ''} onChange={(e) => set({ baseUrl: e.target.value })} placeholder="https://api.example.com/v1" /></label>}
        {other && <>
          <div className="row" style={{ gap: 10 }}>
            <label className="fl" style={{ flex: 1 }}>Model<input value={f.model ?? ''} onChange={(e) => set({ model: e.target.value })} placeholder={f.provider === 'openai' ? 'gpt-…' : f.provider === 'gemini' ? 'gemini-…' : 'model name'} /></label>
            <label className="fl" style={{ flex: 1 }}>Low-cost model <span className="muted small">optional</span><input value={f.fastModel ?? ''} onChange={(e) => set({ fastModel: e.target.value })} placeholder="for sorting tasks" /></label>
          </div>
          <div className="row" style={{ gap: 10 }}>
            <label className="fl" style={{ flex: 1 }}>Input price <span className="muted small">USD per 1M tokens</span><input inputMode="decimal" value={f.priceIn ?? ''} onChange={(e) => set({ priceIn: e.target.value === '' ? undefined : Number(e.target.value) })} placeholder="5" /></label>
            <label className="fl" style={{ flex: 1 }}>Output price <span className="muted small">USD per 1M tokens</span><input inputMode="decimal" value={f.priceOut ?? ''} onChange={(e) => set({ priceOut: e.target.value === '' ? undefined : Number(e.target.value) })} placeholder="15" /></label>
          </div>
          <p className="muted small" style={{ margin: 0 }}>Prices keep spending and the daily budget right. Reading scanned PDFs always uses a Claude key.</p>
        </>}
        {!k && !first && <label className="check"><input type="checkbox" checked={f.makePrimary} onChange={(e) => set({ makePrimary: e.target.checked })} /> Make this the primary key</label>}
        {result && <div className={'aik-result ' + (result.ok ? 'ok' : 'bad')}>{result.ok ? <><CheckCircle2 size={16} /> <span><b>It works.</b> {result.model} answered in {result.ms} ms.</span></> : <><XCircle size={16} /> <span><b>It didn't work.</b> {result.error}</span></>}</div>}
        {err && <div className="err">{err}</div>}
      </div>
    </Drawer>
  );
}
