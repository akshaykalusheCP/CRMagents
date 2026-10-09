import { useEffect, useState } from 'react';
import { api, type Agent, type Tenant, type ToolInfo } from '../api';

const blank = { name: '', systemPrompt: '', tools: [] as string[] };

export function AgentsPage({ tenant, goConnections }: { tenant?: Tenant; goConnections: () => void }) {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [tools, setTools] = useState<ToolInfo[]>([]);
  const [sel, setSel] = useState<Agent | null>(null); // id '' = new
  const [msg, setMsg] = useState('');
  const [input, setInput] = useState('');
  const [out, setOut] = useState('');
  const [busy, setBusy] = useState(false);

  const load = () => tenant && api.agents(tenant.id).then(setAgents).catch((e) => setMsg(e.message));
  useEffect(() => { api.tools().then(setTools).catch(() => {}); }, []);
  useEffect(() => { setSel(null); load(); }, [tenant?.id]);

  if (!tenant) return <div className="page"><div className="card warn">Connect a Salesforce org first. <button onClick={goConnections}>Connections</button></div></div>;

  const save = async () => {
    if (!sel) return;
    try {
      if (sel.id) await api.updateAgent(tenant.id, sel);
      else { const { id } = await api.createAgent(tenant.id, sel); setSel({ ...sel, id }); }
      setMsg('Saved.'); load();
    } catch (e) { setMsg((e as Error).message); }
  };

  const run = async () => {
    if (!sel?.id) return;
    setBusy(true); setOut('');
    try { setOut((await api.run(tenant.id, sel.id, input)).output); }
    catch (e) { setOut('Error: ' + (e as Error).message); }
    setBusy(false);
  };

  const toggle = (n: string) => sel && setSel({ ...sel, tools: sel.tools.includes(n) ? sel.tools.filter((x) => x !== n) : [...sel.tools, n] });

  return (
    <div className="page split">
      <div className="list">
        <button className="primary" onClick={() => { setSel({ id: '', ...blank }); setMsg(''); setOut(''); }}>+ New agent</button>
        {agents.map((a) => (
          <button key={a.id} className={'item' + (sel?.id === a.id ? ' active' : '')} onClick={() => { setSel(a); setMsg(''); setOut(''); }}>{a.name}</button>
        ))}
      </div>

      {sel ? (
        <div className="editor">
          <label>Name<input value={sel.name} onChange={(e) => setSel({ ...sel, name: e.target.value })} /></label>
          <label>Instructions<textarea rows={8} value={sel.systemPrompt} onChange={(e) => setSel({ ...sel, systemPrompt: e.target.value })} placeholder="You are a support triage assistant. Look up the case and..." /></label>
          <div>
            <div className="label">Tools</div>
            {tools.map((t) => (
              <label key={t.name} className="row tool">
                <input type="checkbox" checked={sel.tools.includes(t.name)} onChange={() => toggle(t.name)} />
                <span><b>{t.name}</b> {t.write && <span className="badge warn">writes data</span>}<br /><span className="muted small">{t.description}</span></span>
              </label>
            ))}
          </div>
          <div className="row">
            <button className="primary" onClick={save}>Save</button>
            {sel.id && <button className="danger" onClick={async () => { if (confirm('Delete agent?')) { await api.deleteAgent(tenant.id, sel.id); setSel(null); load(); } }}>Delete</button>}
            <span className="muted">{msg}</span>
          </div>

          {sel.id && (
            <section className="card">
              <h3>Test run</h3>
              <textarea rows={3} value={input} onChange={(e) => setInput(e.target.value)} placeholder="e.g. How many open cases do we have by priority?" />
              <button className="primary" disabled={busy || !input} onClick={run}>{busy ? 'Running…' : 'Run'}</button>
              {out && <pre className="out">{out}</pre>}
            </section>
          )}
        </div>
      ) : <div className="muted pad">Select or create an agent.</div>}
    </div>
  );
}
