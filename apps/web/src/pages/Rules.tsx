import { Loader2, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, type RuleRow, type Tenant } from '../api';
import { Empty, Panel, Status, Table, toast, type Column } from '../components/ui';

// Workspace rules: write a sentence, the AI turns it into a check once, and code enforces it before every write.

const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const EXAMPLES = ['Never email customers on weekends', "Don't change accounts owned by the Enterprise team", 'Never update closed cases', 'No Slack messages between 22:00 and 07:00'];

function scope(r: RuleRow['rule']) {
  const parts: string[] = [];
  parts.push(r.actions.includes('any') ? 'Any change' : r.actions.join(', '));
  if (r.objects.length) parts.push(`on ${r.objects.join(', ')}`);
  if (r.when.length) parts.push(`when ${r.when.map((w) => `${w.field} ${w.operator.replace('_', ' ')} ${w.value}`.trim()).join(' and ')}`);
  if (r.days.length) parts.push(r.days.map((d) => DAY[d]).join('/'));
  if (r.hours) parts.push(`${String(r.hours.from).padStart(2, '0')}:00–${String(r.hours.to).padStart(2, '0')}:00 ${r.timezone}`);
  return parts.join(' · ');
}

export function RulesPage({ tenant }: { tenant?: Tenant }) {
  const [rules, setRules] = useState<RuleRow[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => { if (tenant) api.rules(tenant.id).then(setRules).catch((e) => setErr(e.message)); }, [tenant?.id]);
  if (!tenant) return <Panel><Empty title="No org connected" body="Rules apply to the agents of a connected org." /></Panel>;

  const add = async (t = text) => {
    if (t.trim().length < 8) return;
    setBusy(true); setErr('');
    try { const r = await api.addRule(tenant.id, t.trim()); setRules((x) => [...x, r]); setText(''); toast('Rule added: enforced from now on'); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  };
  const toggle = async (r: RuleRow) => { await api.toggleRule(tenant.id, r.id, !r.enabled); setRules((x) => x.map((y) => (y.id === r.id ? { ...y, enabled: !y.enabled } : y))); };
  const remove = async (r: RuleRow) => { await api.deleteRule(tenant.id, r.id); setRules((x) => x.filter((y) => y.id !== r.id)); };

  const cols: Column<RuleRow>[] = [
    { key: 'rule', header: 'Rule', render: (r) => <div className="cell-main"><b>{r.rule.summary}</b><span className="cell-sub">{scope(r.rule)}</span></div> },
    { key: 'on', header: 'Status', render: (r) => <button className="link-btn" onClick={() => void toggle(r)} title={r.enabled ? 'Turn off' : 'Turn on'}>{r.enabled ? <Status tone="ok">Enforced</Status> : <Status tone="neutral">Off</Status>}</button> },
    { key: 'x', header: '', align: 'right', render: (r) => <button className="ghost icon sm" onClick={() => void remove(r)} aria-label="Delete rule"><Trash2 size={14} /></button> },
  ];

  return (
    <div className="smart-col">
      <form className="panel rule-add" onSubmit={(e) => { e.preventDefault(); void add(); }}>
        <label htmlFor="rule-text" className="metric-label">Add a rule in plain English</label>
        <div className="agent-start">
          <input id="rule-text" value={text} onChange={(e) => setText(e.target.value)} placeholder="e.g. Never email customers on weekends" disabled={busy} />
          <button type="submit" className="primary" disabled={busy || text.trim().length < 8}>{busy ? <Loader2 size={14} className="spin" /> : 'Add rule'}</button>
        </div>
        <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>{EXAMPLES.map((x) => <button type="button" key={x} className="chip example" onClick={() => setText(x)}>{x}</button>)}</div>
        {err && <div className="err">{err}</div>}
      </form>
      <Panel flush>
        <Table columns={cols} rows={rules} rowKey={(r) => r.id} empty={<Empty title="No rules yet" body="Agents follow the steps you build. Rules add limits that hold for every agent, like quiet hours or records that must never change." />} />
      </Panel>
    </div>
  );
}
