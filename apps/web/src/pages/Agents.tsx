import { Loader2, Plus, Send } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, type Agent, type Tenant, type ToolInfo } from '../api';
import { Empty, Panel, Status, toast, useConfirm } from '../components/ui';

// Assistants answer questions when asked (in the app, or from Salesforce). List on the left, the selected one on the right.

const blank = { name: '', systemPrompt: '', tools: [] as string[] };
const TOOL_NAME: Record<string, string> = {
  soql_query: 'Query records (SOQL)', get_record: 'Read a record', describe_object: 'See an object\'s fields',
  create_task: 'Create a task', update_record: 'Update a record', create_record: 'Create a record',
};
const toolName = (n: string) => TOOL_NAME[n] ?? n.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

export function AgentsPage({ tenant, goConnections }: { tenant?: Tenant; goConnections: () => void }) {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [tools, setTools] = useState<ToolInfo[]>([]);
  const [sel, setSel] = useState<Agent | null>(null); // id '' = new
  const [saved, setSaved] = useState<string>('');
  const [confirmUI, ask] = useConfirm();
  const [err, setErr] = useState('');
  const [input, setInput] = useState('');
  const [out, setOut] = useState('');
  const [busy, setBusy] = useState(false);

  const load = () => tenant && api.agents(tenant.id).then(setAgents).catch((e) => setErr(e.message));
  useEffect(() => { api.tools().then(setTools).catch(() => {}); }, []);
  useEffect(() => { setSel(null); load(); }, [tenant?.id]);

  if (!tenant) return <Panel><Empty title="No org connected" body="Assistants work with a connected Salesforce org." action={<button className="sm" onClick={goConnections}>Connect Salesforce</button>} /></Panel>;

  const pick = (a: Agent) => { setSel(a); setSaved(JSON.stringify(a)); setErr(''); setOut(''); };
  const dirty = !!sel && JSON.stringify(sel) !== saved;
  const save = async () => {
    if (!sel) return;
    setErr('');
    try {
      if (sel.id) await api.updateAgent(tenant.id, sel);
      else { const { id } = await api.createAgent(tenant.id, sel); setSel({ ...sel, id }); setSaved(JSON.stringify({ ...sel, id })); }
      if (sel.id) setSaved(JSON.stringify(sel));
      toast('Assistant saved'); load();
    } catch (e) { setErr((e as Error).message); }
  };
  const remove = async () => {
    if (!sel?.id || !(await ask({ title: `Delete "${sel.name}"?`, body: 'It is removed for everyone in the workspace.', confirm: 'Delete', danger: true }))) return;
    await api.deleteAgent(tenant.id, sel.id); setSel(null); toast('Assistant deleted', 'info'); load();
  };
  const run = async () => {
    if (!sel?.id || !input.trim()) return;
    setBusy(true); setOut('');
    try { setOut((await api.run(tenant.id, sel.id, input)).output); }
    catch (e) { setOut('Error: ' + (e as Error).message); }
    setBusy(false);
  };
  const toggle = (n: string) => sel && setSel({ ...sel, tools: sel.tools.includes(n) ? sel.tools.filter((x) => x !== n) : [...sel.tools, n] });

  return (
    <div className="smart-col">
      {confirmUI}
      <Panel flush>
        <div className="inbox">
          <div className="inbox-list" role="listbox" aria-label="Assistants">
            <div className="list-head"><b>Assistants</b><button className="sm" onClick={() => pick({ id: '', ...blank } as Agent)}><Plus size={14} /> New</button></div>
            {agents.length === 0 && <Empty title="No assistants yet" body="An assistant answers questions about your Salesforce data, for example 'How many open cases by priority?'." />}
            {agents.map((a) => (
              <button key={a.id} role="option" aria-selected={sel?.id === a.id} className={'inbox-item' + (sel?.id === a.id ? ' on' : '')} onClick={() => pick(a)}>
                <span className="r1"><b>{a.name}</b><span className="t">{a.tools.length} tool{a.tools.length === 1 ? '' : 's'}</span></span>
                <span className="p">{a.systemPrompt || 'No instructions yet'}</span>
              </button>
            ))}
          </div>

          {sel ? (
            <div className="inbox-detail">
              <div className="form">
                <div className="frow"><div className="flabel"><b>Name</b></div>
                  <div className="ffield"><input id="as-name" value={sel.name} onChange={(e) => setSel({ ...sel, name: e.target.value })} placeholder="e.g. Support analyst" /></div></div>
                <div className="frow"><div className="flabel"><b>Instructions</b><span>What it is for and how to answer. Plain English.</span></div>
                  <div className="ffield"><textarea id="as-prompt" rows={6} value={sel.systemPrompt} onChange={(e) => setSel({ ...sel, systemPrompt: e.target.value })} placeholder="You help the support team. Look up cases and accounts and answer briefly with numbers." /></div></div>
                <div className="frow"><div className="flabel"><b>What it can use</b><span>Read tools are safe. Tools that change data are marked.</span></div>
                  <div className="ffield tool-grid">
                    {tools.map((t) => (
                      <label key={t.name} className={'tool-card' + (sel.tools.includes(t.name) ? ' on' : '')}>
                        <input type="checkbox" checked={sel.tools.includes(t.name)} onChange={() => toggle(t.name)} />
                        <span><b>{toolName(t.name)}</b>{t.write && <Status tone="warn">Changes data</Status>}<small>{t.description}</small></span>
                      </label>
                    ))}
                  </div></div>
              </div>
              {err && <div className="err">{err}</div>}
              <div className="row" style={{ gap: 8 }}>
                <button className="primary" onClick={() => void save()} disabled={!dirty || !sel.name.trim()}>{sel.id ? 'Save changes' : 'Create assistant'}</button>
                {sel.id && <button className="danger" onClick={() => void remove()}>Delete</button>}
              </div>

              {sel.id && (
                <div className="try">
                  <h3>Try it</h3>
                  <div className="agent-start">
                    <input id="as-q" value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void run(); }} placeholder="e.g. How many open cases do we have by priority?" />
                    <button className="primary" disabled={busy || !input.trim()} onClick={() => void run()} aria-label="Ask">{busy ? <Loader2 size={15} className="spin" /> : <Send size={15} />}</button>
                  </div>
                  {out && <pre className="output">{out}</pre>}
                </div>
              )}
            </div>
          ) : (
            <div className="inbox-detail"><Empty title="Pick an assistant" body="Or create a new one. Assistants answer questions; automations act on records by themselves." /></div>
          )}
        </div>
      </Panel>
    </div>
  );
}
