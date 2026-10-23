import { ArrowRight, Check, Database, Download, FileText, Lock, Printer, Server, ShieldAlert, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, leaveTo, type ActivityRow, type AiCallDetail, type AiCallRow, type Me, type TrustFacts } from '../api';
import { Drawer, PageHeader, Panel, SkeletonRows, Table, toast, useConfirm } from '../components/ui';

// Trust Center: how this workspace's Salesforce data is handled, shown from live settings rather than promises:
// what goes where, every safeguard and its current state, every AI call exactly as sent, who did what, and the
// workspace's own data to export or delete. Printable as a report for a security review.

const PROVIDER: Record<string, { name: string; policy: string; link: string }> = {
  anthropic: { name: 'Anthropic (Claude)', policy: 'Anthropic does not use data sent through its API to train its models (Anthropic Commercial Terms).', link: 'https://www.anthropic.com/legal/commercial-terms' },
  openai: { name: 'OpenAI', policy: 'OpenAI does not train its models on API data by default.', link: 'https://openai.com/enterprise-privacy/' },
  gemini: { name: 'Google Gemini', policy: 'On paid Gemini API plans, Google does not use prompts or responses to improve its products.', link: 'https://ai.google.dev/gemini-api/terms' },
  compatible: { name: 'Your own AI provider', policy: 'Data handling follows your agreement with that provider: check its terms.', link: '' },
};
const when = (d: string) => new Date(d).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const content = (c: unknown): string => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((p: any) => p.text ?? (p.tool ? `[tool ${p.tool}] ${p.input ?? ''}` : p.result !== undefined ? `[tool result] ${p.result}` : JSON.stringify(p))).join('\n\n') : JSON.stringify(c, null, 2));

export function TrustPage({ me }: { me: Me }) {
  const [f, setF] = useState<TrustFacts>();
  const [calls, setCalls] = useState<AiCallRow[]>();
  const [activity, setActivity] = useState<ActivityRow[]>();
  const [open, setOpen] = useState<AiCallDetail | null>(null);
  const [view, setView] = useState<'ai' | 'activity'>('ai');
  const [confirmUi, ask] = useConfirm();

  useEffect(() => {
    api.trust().then(setF).catch((e) => toast((e as Error).message, 'bad'));
    api.aiCalls().then(setCalls).catch(() => setCalls([]));
    api.activity().then(setActivity).catch(() => setActivity([]));
  }, []);

  const admin = ['owner', 'admin'].includes(me.role);
  const p = PROVIDER[f?.ai.provider ?? 'anthropic'] ?? PROVIDER.compatible;
  const checks: { ok: boolean; title: string; detail: string }[] = f ? [
    { ok: f.masking.on, title: f.masking.on ? 'Personal data is masked before the AI sees it' : 'Personal data masking is off', detail: f.masking.on ? `Emails, phone numbers, card numbers, SSNs and IBANs${f.masking.extraFields.length ? `, plus ${f.masking.extraFields.join(', ')}` : ''} are swapped for placeholders like [EMAIL_1]. ${f.ai.maskedValues30d.toLocaleString()} values were masked in the last 30 days. Salesforce still gets the real values. Images people attach (and images read from files) go to the AI as they are: text inside an image can't be masked.` : 'Turn it on in Settings → AI & spending.' },
    { ok: f.ai.provider !== 'compatible', title: `AI provider: ${p.name}`, detail: p.policy },
    { ok: f.retentionDays > 0 && f.retentionDays <= 90, title: f.retentionDays ? `Run details and AI calls are deleted after ${f.retentionDays} days` : 'Run details are kept with no time limit', detail: 'Inputs, AI replies and tool results are cleared on schedule; only status, cost and timing stay.' },
    { ok: f.agents.liveWriting === 0 || f.agents.liveWritingAsking === f.agents.liveWriting, title: `${f.agents.liveWritingAsking} of ${f.agents.liveWriting} live agents that change data ask a person first`, detail: 'Agents can be set to wait for an approval before every change; rules and field limits are checked in code either way.' },
    { ok: true, title: 'Every change can be undone', detail: `Old values are kept for every record an agent changes. ${f.changes30d.toLocaleString()} changes in the last 30 days, ${f.undone30d} undone. People's later edits are never overwritten.` },
    { ok: f.rules > 0, title: `${f.rules} rule${f.rules === 1 ? '' : 's'} for agents`, detail: 'Things agents must never do, or must ask about, checked by code before every change.' },
    { ok: f.agents.capped > 0 || f.agents.live === 0, title: `Spending is capped`, detail: `Each run stops at ${f.limits.aiCalls} AI calls and ${f.limits.tokens.toLocaleString()} tokens; the workspace at $${f.limits.dailyBudgetUsd} a day; ${f.agents.capped} agent${f.agents.capped === 1 ? ' has' : 's have'} a monthly cap.` },
    { ok: true, title: 'Access by role', detail: Object.entries(f.team).map(([r, n]) => `${n} ${r}${n > 1 ? 's' : ''}`).join(', ') + '. Approvers can\'t change agents; only admins see settings and the team. Whoever starts a run can\'t approve it when there is someone else to ask.' },
    { ok: f.alerts, title: f.alerts ? 'Admins are alerted when something goes wrong' : 'Alert emails are off', detail: 'Agents failing again and again are paused automatically; disconnected orgs are reported.' },
    { ok: true, title: f.memory?.on === false ? 'Memory is off' : 'Memory is visible and deletable', detail: f.memory?.on === false ? 'Assistants and agents don\'t keep anything between conversations.' : `${f.memory?.team ?? 0} team and ${f.memory?.personal ?? 0} personal memories, ${f.memory?.recordNotes ?? 0} notes on records. Anything that looks like personal data is refused. Everyone sees and can delete their own on the Memory page.` },
    { ok: true, title: 'Secrets are encrypted', detail: 'Salesforce tokens and API keys are encrypted at rest (AES-256-GCM); passwords are stored as scrypt hashes; every change is signed between Salesforce and Nimbus.' },
  ] : [];

  const openCall = async (id: number) => { try { setOpen(await api.aiCall(id)); } catch (e) { toast((e as Error).message, 'bad'); } };
  const exportAll = () => leaveTo('/api/trust/export');
  const del = async () => {
    const ok = await ask({ title: 'Delete this workspace?', danger: true, confirm: 'Delete everything',
      body: <>Nimbus' access to every connected Salesforce org is revoked, then all agents, assistants, runs, logs, guides and users of <b>{me.accountName}</b> are deleted. Nothing is deleted in Salesforce. This can't be undone; export first if you need a copy.</> });
    if (!ok) return;
    const typed = window.prompt(`Type the company name to confirm: ${me.accountName}`);
    if (typed === null) return;
    try { await api.deleteWorkspace(typed); window.location.href = '/'; } catch (e) { toast((e as Error).message, 'bad'); }
  };

  return (
    <div className="pg trust">
      {confirmUi}
      <PageHeader title="Trust center" description="How your Salesforce data is handled, shown from this workspace's live settings."
        actions={<><button onClick={() => window.print()}><Printer size={15} /> Print report</button>{admin && <button onClick={exportAll}><Download size={15} /> Export all data</button>}</>} />

      <section className="tr-flow" aria-label="How your data flows">
        <div className="tr-node"><Database size={18} /><b>Your Salesforce</b><span>Records stay here. Nimbus reads only the fields a step needs, with the access you gave it ({f?.salesforce.scopes.join(', ') ?? 'api, refresh_token'}).</span></div>
        <ArrowRight className="tr-arrow" size={18} />
        <div className="tr-node"><Server size={18} /><b>Nimbus</b><span>Keeps your agents, run logs ({f ? `${f.retentionDays || '∞'} days` : '…'}), the change log for undo, and encrypted keys. Masks personal data before anything goes to the AI.</span></div>
        <ArrowRight className="tr-arrow" size={18} />
        <div className="tr-node"><Lock size={18} /><b>{p.name}</b><span>Gets only the text of one step, masked. {p.policy}{p.link && <> <a href={p.link} target="_blank" rel="noreferrer">Their terms</a></>}</span></div>
      </section>

      <Panel title="Safeguards, as set right now" className="tour-safeguards">
        {!f ? <SkeletonRows rows={5} cols={2} /> : (
          <ul className="tr-checks">
            {checks.map((c) => (
              <li key={c.title}>{c.ok ? <Check size={16} className="ok" /> : <ShieldAlert size={16} className="warn" />}<div><b>{c.title}</b><span>{c.detail}</span></div></li>
            ))}
          </ul>
        )}
      </Panel>

      <div className="ptabs tr-tabs" role="tablist">
        <button role="tab" aria-selected={view === 'ai'} className={view === 'ai' ? 'on' : ''} onClick={() => setView('ai')}>What the AI saw</button>
        <button role="tab" aria-selected={view === 'activity'} className={view === 'activity' ? 'on' : ''} onClick={() => setView('activity')}>Who did what</button>
      </div>

      {view === 'ai' ? (
        <Panel flush title={`AI calls${f ? ` · ${f.ai.calls30d.toLocaleString()} in the last 30 days` : ''}`} action={<span className="muted small">Exactly as sent, after masking. Click one to read it.</span>}>
          {!calls ? <SkeletonRows rows={5} cols={5} /> : (
            <Table rows={calls} rowKey={(c) => String(c.id)} onRowClick={(c) => void openCall(c.id)}
              empty={<p className="muted small" style={{ padding: 16, margin: 0 }}>No AI calls recorded yet.</p>}
              columns={[
                { key: 'when', header: 'When', width: '140px', render: (c) => <span className="muted">{when(c.createdAt)}</span> },
                { key: 'for', header: 'For', render: (c) => <span>{c.purpose}{c.error && <span className="tr-err"> · failed</span>}</span> },
                { key: 'model', header: 'Model', hideSm: true, render: (c) => <code>{c.model}</code> },
                { key: 'masked', header: 'Masked', align: 'right', width: '90px', render: (c) => (c.maskedValues ? <span className="tr-mask">{c.maskedValues}</span> : <span className="muted">0</span>) },
                { key: 'tok', header: 'Tokens', align: 'right', width: '100px', hideSm: true, render: (c) => (c.inputTokens + c.outputTokens).toLocaleString() },
                { key: 'cost', header: 'Cost', align: 'right', width: '80px', render: (c) => `$${c.costUsd.toFixed(c.costUsd < 0.01 ? 4 : 2)}` },
              ]} />
          )}
        </Panel>
      ) : (
        <Panel flush title="Activity" action={<span className="muted small">Every change made in Nimbus, sign-ins included.</span>}>
          {!activity ? <SkeletonRows rows={5} cols={4} /> : (
            <Table rows={activity} rowKey={(a) => String(a.id)}
              empty={<p className="muted small" style={{ padding: 16, margin: 0 }}>Nothing recorded yet.</p>}
              columns={[
                { key: 'when', header: 'When', width: '140px', render: (a) => <span className="muted">{when(a.createdAt)}</span> },
                { key: 'who', header: 'Who', render: (a) => a.user ?? 'System' },
                { key: 'what', header: 'What', render: (a) => <span>{a.action}{a.target ? <span className="muted"> · {a.target}</span> : null}</span> },
                { key: 'ip', header: 'From', width: '130px', hideSm: true, render: (a) => <span className="muted small">{a.ip ?? ''}</span> },
              ]} />
          )}
        </Panel>
      )}

      <Panel title="Your data">
        <div className="tr-data">
          <div><b>Export everything</b><span>Agents, assistants, runs, the change log, AI calls and activity as one JSON file.</span>{admin ? <button className="sm" onClick={exportAll}><Download size={14} /> Export</button> : <span className="muted small">Admins can export.</span>}</div>
          <div><b>Delete the workspace</b><span>Revokes Nimbus' access to your Salesforce orgs, then deletes everything here. Nothing in Salesforce is deleted.</span>{me.role === 'owner' ? <button className="sm danger" onClick={() => void del()}><Trash2 size={14} /> Delete workspace</button> : <span className="muted small">Owners can delete.</span>}</div>
          <div><b>Disconnect an org</b><span>Removes one org and revokes its access, from Settings → Salesforce orgs.</span></div>
        </div>
      </Panel>

      <Drawer open={!!open} onClose={() => setOpen(null)} title={open ? `AI call · ${when(open.createdAt)}` : ''} sub={open && <span>{open.model} · {open.maskedValues} value{open.maskedValues === 1 ? '' : 's'} masked</span>}>
        {open && <>
          <p className="muted small" style={{ marginTop: 0 }}><FileText size={13} /> This is what was sent to {PROVIDER[open.provider]?.name ?? open.provider}, after masking. Long parts are shortened here.</p>
          {open.request.system ? <div className="dsec"><h3>Instructions</h3><pre className="tr-pre">{content(open.request.system)}</pre></div> : null}
          {open.request.messages.map((m, i) => <div key={i} className="dsec"><h3>{m.role === 'user' ? 'Sent' : 'Earlier reply'}</h3><pre className="tr-pre">{content(m.content)}</pre></div>)}
          {open.request.tools.length > 0 && <p className="small muted">Tools it could use: {open.request.tools.join(', ')}</p>}
          <div className="dsec"><h3>{open.error ? 'Failed' : 'Reply'}</h3><pre className="tr-pre">{open.error ?? content(open.response?.content)}</pre></div>
        </>}
      </Drawer>
    </div>
  );
}
