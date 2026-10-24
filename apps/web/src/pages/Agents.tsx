import { PublicChatSettings } from '../components/PublicChat';
import { AssistantTests, type TestDraft } from '../components/AssistantTests';
import { Loader2, Plus, Send, History, Trash2, Bookmark } from 'lucide-react';
import { Markdown } from '../components/Markdown';
import { AttachButton, ImageChips, addImages, forUpload, pastedFiles, type PickedImage } from '../components/ImageAttach';
import { MicButton, SpeakButton, speak } from '../components/Voice';
import { useEffect, useState } from 'react';
import { api, type Agent, type Tenant, type ToolInfo, type Remembered, type Conversation } from '../api';
import { Empty, Panel, Status, toast, useConfirm } from '../components/ui';

// Assistants answer questions when asked (in the app, or from Salesforce). List on the left, the selected one on the right.

const blank = { name: '', systemPrompt: '', tools: [] as string[] };
const TOOL_NAME: Record<string, string> = {
  soql_query: 'Query records (SOQL)', get_record: 'Read a record', describe_object: 'See an object\'s fields',
  create_task: 'Create a task', update_record: 'Update a record', create_record: 'Create a record',
};
const toolName = (n: string) => TOOL_NAME[n] ?? n.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

export function AgentsPage({ tenant, goConnections, startNew }: { tenant?: Tenant; goConnections: () => void; startNew?: number }) {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [tools, setTools] = useState<ToolInfo[]>([]);
  const [sel, setSel] = useState<Agent | null>(null); // id '' = new
  const [saved, setSaved] = useState<string>('');
  const [confirmUI, ask] = useConfirm();
  const [err, setErr] = useState('');
  const [input, setInput] = useState('');
  const [thread, setThread] = useState<{ role: 'user' | 'assistant'; text: string; remembered?: Remembered[]; images?: string[] }[]>([]);
  const [images, setImages] = useState<PickedImage[]>([]);
  const [readAloud, setReadAloud] = useState(() => { try { return localStorage.getItem('nimbus-read-aloud') === '1'; } catch { return false; } });
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [past, setPast] = useState<Conversation[] | null>(null);
  const [testDraft, setTestDraft] = useState<TestDraft | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => tenant && api.agents(tenant.id).then(setAgents).catch((e) => setErr(e.message));
  useEffect(() => { api.tools().then(setTools).catch(() => {}); }, []);
  useEffect(() => { setSel(null); load(); }, [tenant?.id]);
  // "Create → Assistant" on the Agents page opens a blank assistant.
  useEffect(() => { if (startNew) pick({ id: '', ...blank } as Agent); }, [startNew]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!tenant) return <Panel><Empty title="No org connected" body="Assistants work with a connected Salesforce org." action={<button className="sm" onClick={goConnections}>Connect Salesforce</button>} /></Panel>;

  const pick = (a: Agent) => { setSel(a); setSaved(JSON.stringify(a)); setErr(''); setThread([]); setConversationId(null); setPast(null); };
  const newChat = () => { setThread([]); setConversationId(null); };
  const showPast = async () => {
    if (!sel?.id) return;
    if (past) { setPast(null); return; }
    try { setPast(await api.conversations(tenant.id, sel.id)); } catch (e) { toast((e as Error).message, 'bad'); }
  };
  const openChat = async (id: string) => {
    try {
      const c = await api.conversation(tenant.id, id);
      setThread(c.messages.map((m) => ({ role: m.role, text: m.text })));
      setConversationId(c.id); setPast(null);
    } catch (e) { toast((e as Error).message, 'bad'); }
  };
  const forget = async (msgIndex: number, r: Remembered) => {
    if (!r.id) return;
    try {
      await api.deleteMemory(r.id);
      setThread((t) => t.map((m, i) => (i === msgIndex ? { ...m, remembered: (m.remembered ?? []).filter((x) => x.id !== r.id) } : m)));
      toast('Forgotten');
    } catch (e) { toast((e as Error).message, 'bad'); }
  };
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
  const run = async (spoken?: string) => {
    const q = (spoken ?? input).trim() || (images.length ? 'What does this show?' : '');
    if (!sel?.id || !q) return;
    const before = thread;
    const sent = images;
    setThread([...before, { role: 'user', text: q, images: sent.map((i) => i.preview) }]); setInput(''); setImages([]); setBusy(true);
    try {
      const r = await api.run(tenant.id, sel.id, q, before.slice(-20).map(({ role, text }) => ({ role, text })), conversationId, forUpload(sent));
      setConversationId(r.conversationId);
      setThread((t) => [...t, { role: 'assistant', text: r.output, remembered: r.remembered }]);
      if (readAloud) speak(r.output);
    }
    catch (e) { setThread((t) => [...t, { role: 'assistant', text: 'Error: ' + (e as Error).message }]); }
    setBusy(false);
  };
  const toggle = (n: string) => sel && setSel({ ...sel, tools: sel.tools.includes(n) ? sel.tools.filter((x) => x !== n) : [...sel.tools, n] });

  return (
    <div className="smart-col">
      {confirmUI}
      <Panel flush>
        <div className="inbox">
          <div className="inbox-list" role="listbox" aria-label="Assistants">
            <div className="list-head"><b>Assistants</b><button className="sm" onClick={() => pick({ id: '', ...blank } as Agent)}><Plus size={14} /> New assistant</button></div>
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
                  <div className="row between"><h3>Try it</h3>
                    <div className="row" style={{ gap: 12 }}>
                      <button className="link-btn" onClick={() => void showPast()}><History size={14} /> {past ? 'Hide past chats' : 'Past chats'}</button>
                      {thread.length > 0 && <button className="link-btn" onClick={newChat}>New conversation</button>}
                    </div>
                  </div>
                  {past && (
                    <ul className="past-chats">
                      {past.length === 0 && <li className="muted small">No saved chats with this assistant yet.</li>}
                      {past.map((c) => (
                        <li key={c.id}>
                          <button className={'past-chat' + (c.id === conversationId ? ' on' : '')} onClick={() => void openChat(c.id)}>
                            <b>{c.title || 'Untitled'}</b>
                            <span>{c.channel === 'salesforce' ? 'In Salesforce' : 'Here'} · {c.messages} messages · {new Date(c.updatedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
                          </button>
                          <button className="ghost icon sm" aria-label="Delete chat" title="Delete chat" onClick={() => void api.deleteConversation(tenant.id, c.id).then(() => { setPast((p) => p && p.filter((x) => x.id !== c.id)); if (c.id === conversationId) newChat(); })}><Trash2 size={14} /></button>
                        </li>
                      ))}
                    </ul>
                  )}
                  {thread.length > 0 && (
                    <div className="thread">{thread.map((m, i) => <div key={i} className={'msg ' + (m.role === 'user' ? 'me' : 'ai')}>{m.role === 'user' ? <div className="bubble">{!!m.images?.length && <span className="bubble-imgs">{m.images.map((src) => <img key={src} src={src} alt="" />)}</span>}{m.text}</div> : <>
                      <Markdown className="bubble" text={m.text} />
                      {!m.text.startsWith('Error:') && <SpeakButton text={m.text} />}
                      {(m.remembered ?? []).map((r, j) => (
                        <span key={j} className="mem-saved">
                          <Bookmark size={12} /> {r.kind === 'record' ? 'Noted on the record' : r.kind === 'team' ? 'Saved to team memory' : 'Saved to memory'}: {r.text}
                          {r.id && <button className="link-btn" onClick={() => void forget(i, r)}>Forget</button>}
                        </span>
                      ))}
                      {i > 0 && thread[i - 1].role === 'user' && !m.text.startsWith('Error:') && (
                        <button className="link-btn save-test" onClick={() => setTestDraft({ question: thread[i - 1].text, expect: m.text, n: Date.now() })}>Save as a test</button>
                      )}
                    </>}</div>)}
                      {busy && <div className="msg ai"><div className="bubble typing"><Loader2 size={14} className="spin" /> Looking it up…</div></div>}</div>
                  )}
                  <ImageChips images={images} onChange={setImages} />
                  <div className="agent-start"
                    onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); }}
                    onDrop={async (e) => { if (e.dataTransfer.files.length) { e.preventDefault(); setImages(await addImages(images, e.dataTransfer.files)); } }}>
                    <input id="as-q" value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void run(); }}
                      onPaste={async (e) => { const f = pastedFiles(e); if (f.length) { e.preventDefault(); setImages(await addImages(images, f)); } }}
                      placeholder={images.length ? 'Ask about the image…' : thread.length ? 'Ask a follow-up…' : 'e.g. How many open cases do we have by priority? (or attach a screenshot)'} />
                    <AttachButton images={images} onChange={setImages} />
                    <MicButton value={input} onChange={setInput} onDone={(v) => void run(v)} label="Ask by voice" />
                    <button className="primary" disabled={busy || (!input.trim() && !images.length)} onClick={() => void run()} aria-label="Ask">{busy ? <Loader2 size={15} className="spin" /> : <Send size={15} />}</button>
                  </div>
                  <label className="check read-aloud"><input type="checkbox" checked={readAloud} onChange={(e) => { setReadAloud(e.target.checked); try { localStorage.setItem('nimbus-read-aloud', e.target.checked ? '1' : '0'); } catch { /* private window */ } }} /> Read answers aloud</label>

                </div>
              )}
              {sel.id && <AssistantTests tenantId={tenant!.id} agentId={sel.id} draft={testDraft} />}
              {sel.id && <PublicChatSettings tenantId={tenant!.id} agentId={sel.id} />}
            </div>
          ) : (
            <div className="inbox-detail"><Empty title="Pick an assistant" body="Or create a new one. Assistants answer questions; automations act on records by themselves." /></div>
          )}
        </div>
      </Panel>
    </div>
  );
}
