import {
  addEdge, Background, BackgroundVariant, Controls, MarkerType, MiniMap, ReactFlow, ReactFlowProvider,
  useEdgesState, useNodesState, useReactFlow, type Connection, type Edge,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  ArrowLeft, PenLine, Check, ChevronDown, ChevronUp, CloudUpload, FlaskConical, GitCompare, History, LayoutList, MoreHorizontal, Network, Loader2, MousePointerClick, Play, Power, Save, Search, Trash2, X, Zap,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { CATEGORY_COLORS, NODE_DEFS, NODE_DEF_BY_TYPE, type Category, type Workflow, type WFNode } from '@crmagents/shared';
import { api, localTz, type BacktestResult, type Draft, type Preview, type RegressionResult, type RunResult, type ToolInfo } from '../api';
import { BacktestView, RegressionView, ResultModal, Working } from './Smart';
import { Menu, toast, useConfirm } from './ui';
import { Inspector } from './Inspector';
import { StepsView } from './StepsView';
import { NodeTile } from './nodeIcons';
import { WorkflowNode, type WFRFNode } from './WorkflowNode';

const nodeTypes = { card: WorkflowNode };
const EDGE_DEFAULTS = { type: 'smoothstep', markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 } };

const ID_PREFIX: Record<string, string> = {
  'trigger.schedule': 'trigger',
  'trigger.manual': 'trigger', 'trigger.salesforce': 'trigger', 'ai.agent': 'ai_agent', 'ai.classify': 'ai_classify',
  'ai.extract': 'ai_extract', 'sf.query': 'sf_query', 'sf.getRecord': 'sf_get', 'sf.createRecord': 'sf_create',
  'sf.updateRecord': 'sf_update', 'sf.createTask': 'sf_task', 'logic.branch': 'branch', 'logic.loop': 'loop',
  'logic.approval': 'approval', 'http.request': 'http', 'notify.slack': 'slack', 'util.set': 'set', 'util.output': 'output',
  'knowledge.playbook': 'playbook', 'crm.applyActions': 'apply',
};

const toRF = (w: Workflow): { nodes: WFRFNode[]; edges: Edge[] } => ({
  nodes: w.nodes.map((n) => ({ id: n.id, type: 'card', position: n.position, data: { type: n.type, label: n.label, config: n.config } })),
  edges: w.edges.map((e) => ({ id: e.id, source: e.source, target: e.target, sourceHandle: e.sourceHandle ?? 'out', ...EDGE_DEFAULTS })),
});

const fromRF = (nodes: WFRFNode[], edges: Edge[], meta?: Workflow['meta']): Workflow => ({
  ...(meta ? { meta } : {}),
  nodes: nodes.map((n): WFNode => ({ id: n.id, type: n.data.type, label: n.data.label || undefined, position: n.position, config: n.data.config })),
  edges: edges.map((e) => ({ id: e.id, source: e.source, target: e.target, sourceHandle: e.sourceHandle ?? 'out' })),
});

interface Props {
  tenantId: string;
  id: string | null; // null = unsaved
  initialName: string;
  initialGraph: Workflow;
  onBack: () => void;
  onSaved: (id: string) => void;
  onDeleted: () => void;
  /** Present when the workflow was just drafted from a plain-English request. */
  aiDraft?: Draft;
  /** Whether Nimbus is watching Salesforce for this agent's trigger. */
  initialLive?: boolean;
  /** Started by Salesforce change events instead of 1-minute checks. */
  initialRealtime?: boolean;
}

const STATUS_BADGE: Record<string, string> = { done: 'ok', error: 'err', waiting: 'warn', running: 'accent' };

function Editor({ tenantId, id, initialName, initialGraph, onBack, onSaved, onDeleted, aiDraft, initialLive, initialRealtime }: Props) {
  const init = useMemo(() => toRF(initialGraph), [initialGraph]);
  const [nodes, setNodes, onNodesChange] = useNodesState<WFRFNode>(init.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(init.edges);
  const [name, setName] = useState(initialName);
  const [dirty, setDirty] = useState(id === null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  const [tools, setTools] = useState<ToolInfo[]>([]);
  const [run, setRun] = useState<RunResult | null>(null);
  const [running, setRunning] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [query, setQuery] = useState('');
  const [trig, setTrig] = useState({
    input: '', recordId: aiDraft?.sample?.recordId ?? '', objectApiName: aiDraft?.sample?.objectApiName ?? '', context: '',
  });
  const [meta, setMeta] = useState<Workflow['meta']>(initialGraph.meta);
  const [ai, setAi] = useState<Draft | undefined>(aiDraft);
  const [aiOpen, setAiOpen] = useState(!!aiDraft);
  const [change, setChange] = useState('');
  const [refining, setRefining] = useState(false);
  const [aiErr, setAiErr] = useState('');
  const [handEdited, setHandEdited] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewErr, setPreviewErr] = useState('');
  const [live, setLive] = useState<boolean>(!!initialLive);
  const [confirmUI, ask] = useConfirm();
  const [realtime, setRealtimeOn] = useState<boolean>(!!initialRealtime);
  const [bt, setBt] = useState<BacktestResult | 'loading' | { error: string } | null>(null);
  const [reg, setReg] = useState<RegressionResult | 'loading' | { error: string } | null>(null);
  const [view, setView] = useState<'steps' | 'canvas'>(() => { try { return localStorage.getItem('builderView') === 'canvas' ? 'canvas' : 'steps'; } catch { return 'steps'; } });
  const [tested, setTested] = useState(false);
  useEffect(() => { try { localStorage.setItem('builderView', view); } catch { /* ignore */ } }, [view]);
  const [deploying, setDeploying] = useState(false);
  const [taught, setTaught] = useState<Record<string, string>>({}); // recordId:nodeId -> label the admin gave
  const [exampleTotal, setExampleTotal] = useState<number | null>(null);

  // Admin feedback on a preview decision becomes a learned example for that block.
  const teach = async (recordId: string, d: { nodeId: string; input: string; value: string }, label: string) => {
    if (!id) return;
    const key = `${recordId}:${d.nodeId}`;
    try {
      const r = await api.feedback(tenantId, id, { nodeId: d.nodeId, input: d.input, label, source: label === d.value ? 'confirmed' : 'correction' });
      setTaught((t) => ({ ...t, [key]: label }));
      setExampleTotal(r.examples);
    } catch (e) { setPreviewErr((e as Error).message); }
  };
  const { screenToFlowPosition } = useReactFlow();

  useEffect(() => { api.tools().then(setTools).catch(() => {}); }, []);

  const selected = nodes.find((n) => n.selected);
  const touch = () => { setDirty(true); setMsg(''); setHandEdited(true); };

  const addNode = useCallback((type: string, pos?: { x: number; y: number }) => {
    const prefix = ID_PREFIX[type] ?? 'node';
    setNodes((ns) => {
      let i = 1;
      while (ns.some((n) => n.id === `${prefix}_${i}`)) i++;
      const def = NODE_DEF_BY_TYPE[type];
      const config: Record<string, any> = {};
      def.fields.forEach((f) => { if (f.default !== undefined) config[f.key] = f.default; });
      const p = pos ?? { x: 80 + ns.length * 40, y: 80 + ns.length * 30 };
      return [...ns.map((n) => ({ ...n, selected: false })), { id: `${prefix}_${i}`, type: 'card', position: p, selected: true, data: { type, config } } as WFRFNode];
    });
    touch();
  }, [setNodes]);

  // Steps view: add a block just before the final "Finish" step and wire it in.
  const insertStep = (type: string) => {
    const prefix = ID_PREFIX[type] ?? 'node';
    let i = 1;
    while (nodes.some((n) => n.id === `${prefix}_${i}`)) i++;
    const id = `${prefix}_${i}`;
    const config: Record<string, any> = {};
    NODE_DEF_BY_TYPE[type].fields.forEach((f) => { if (f.default !== undefined) config[f.key] = f.default; });
    const isExit = (nid: string) => { const inc = edges.filter((e) => e.target === nid); return inc.length > 0 && inc.every((e) => e.sourceHandle === 'false' || e.sourceHandle === 'rejected'); };
    const finish = nodes.filter((n) => n.data.type === 'util.output' && !isExit(n.id)).sort((a, b) => b.position.x - a.position.x)[0];
    const into = finish ? edges.find((e) => e.target === finish.id && e.sourceHandle !== 'false' && e.sourceHandle !== 'rejected') : undefined;
    const last = [...nodes].sort((a, b) => b.position.x - a.position.x)[0];
    const pos = finish ? { ...finish.position } : { x: (last?.position.x ?? 0) + 280, y: last?.position.y ?? 120 };
    setNodes((ns) => [
      ...ns.map((n) => ({ ...n, selected: false, ...(finish && n.id === finish.id ? { position: { ...n.position, x: n.position.x + 280 } } : {}) })),
      { id, type: 'card', position: pos, selected: true, data: { type, config } } as WFRFNode,
    ]);
    setEdges((es) => {
      const mk = (source: string, target: string, handle = 'out') => ({ id: `${source}:${handle}->${target}`, source, target, sourceHandle: handle, ...EDGE_DEFAULTS });
      if (finish && into) return [...es.filter((e) => e.id !== into.id), mk(into.source, id, into.sourceHandle ?? 'out'), mk(id, finish.id)];
      return last ? [...es, mk(last.id, id)] : es;
    });
    touch();
  };

  const selectNode = (nid: string) => setNodes((ns) => ns.map((n) => ({ ...n, selected: n.id === nid })));

  const isValidConnection = useCallback((c: Connection | Edge) => {
    if (!c.source || !c.target || c.source === c.target) return false;
    const targetNode = nodes.find((n) => n.id === c.target);
    if (!targetNode || NODE_DEF_BY_TYPE[targetNode.data.type]?.category === 'Trigger') return false;
    // reject if the target can already reach the source (would create a cycle)
    const seen = new Set<string>();
    const stack = [c.target];
    while (stack.length) {
      const cur = stack.pop()!;
      if (cur === c.source) return false;
      if (seen.has(cur)) continue;
      seen.add(cur);
      edges.forEach((e) => e.source === cur && stack.push(e.target));
    }
    return true;
  }, [nodes, edges]);

  const onConnect = useCallback((c: Connection) => {
    setEdges((es) => addEdge(
      { ...c, id: `${c.source}:${c.sourceHandle ?? 'out'}->${c.target}`, ...EDGE_DEFAULTS },
      es.filter((e) => !(e.source === c.source && e.sourceHandle === c.sourceHandle && e.target === c.target)),
    ));
    touch();
  }, [setEdges]);

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const type = e.dataTransfer.getData('application/crmagents-node');
    if (type) addNode(type, screenToFlowPosition({ x: e.clientX - 120, y: e.clientY - 30 }));
  };

  const patchSelected = (patch: { label?: string; config?: Record<string, any> }) => {
    setNodes((ns) => ns.map((n) => (n.selected ? { ...n, data: { ...n.data, ...patch } } : n)));
    touch();
  };

  const deleteSelected = () => {
    if (!selected) return;
    setNodes((ns) => ns.filter((n) => n.id !== selected.id));
    setEdges((es) => es.filter((e) => e.source !== selected.id && e.target !== selected.id));
    touch();
  };

  // Which earlier nodes can the selected node reference?
  const { refs, inLoop } = useMemo(() => {
    if (!selected) return { refs: [], inLoop: false };
    const anc = new Set<string>();
    const stack = [selected.id];
    while (stack.length) {
      const cur = stack.pop()!;
      edges.forEach((e) => { if (e.target === cur && !anc.has(e.source)) { anc.add(e.source); stack.push(e.source); } });
    }
    const list = nodes.filter((n) => anc.has(n.id) && !n.data.type.startsWith('trigger.')).map((n) => {
      const def = NODE_DEF_BY_TYPE[n.data.type];
      return { id: n.id, label: n.data.label || def.label, keys: def.outputs };
    });
    return { refs: list, inLoop: nodes.some((n) => anc.has(n.id) && n.data.type === 'logic.loop') };
  }, [selected, nodes, edges]);

  const save = async (graphOverride?: Workflow): Promise<string | null> => {
    const body = { name: name.trim() || 'Untitled workflow', graph: graphOverride ?? fromRF(nodes, edges, meta) };
    setSaving(true);
    try {
      let wid = id;
      if (wid) await api.saveWorkflow(tenantId, wid, body);
      else wid = (await api.createWorkflow(tenantId, body)).id;
      setDirty(false);
      setMsg('');
      if (!id) onSaved(wid);
      return wid;
    } catch (e) { setMsg((e as Error).message); return null; }
    finally { setSaving(false); }
  };

  // Ctrl/Cmd+S saves.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); if (dirty) void save(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const showStatuses = (r: RunResult | null) => {
    setNodes((ns) => ns.map((n) => {
      if (!r) return { ...n, data: { ...n.data, status: undefined } };
      const mine = r.steps.filter((s) => s.nodeId === n.id);
      const status = mine.some((s) => s.status === 'error') ? 'error' : mine.some((s) => s.status === 'waiting') ? 'waiting' : mine.length ? 'ok' : 'skipped';
      return { ...n, data: { ...n.data, status } };
    }));
  };

  const doRun = async () => {
    setDrawer(true);
    setRunning(true); setRun(null); showStatuses(null);
    try {
      const wid = dirty || !id ? await save() : id;
      if (!wid) return;
      let context: unknown;
      if (trig.context.trim()) { try { context = JSON.parse(trig.context); } catch { throw new Error('Context must be valid JSON'); } }
      const r = await api.runWorkflow(tenantId, wid, {
        input: trig.input || undefined, recordId: trig.recordId || undefined, objectApiName: trig.objectApiName || undefined, context,
      });
      setRun(r); showStatuses(r); setTested(true);
    } catch (e) { setRun({ runId: '', status: 'error', output: '', error: (e as Error).message, steps: [] }); }
    finally { setRunning(false); }
  };

  const decide = async (approve: boolean) => {
    if (!run) return;
    setRunning(true);
    try { const r = await api.decide(tenantId, run.runId, approve); setRun(r); showStatuses(r); }
    catch (e) { setRun({ ...run, status: 'error', error: (e as Error).message }); }
    finally { setRunning(false); }
  };

  // Change the draft in plain English; the plan is rebuilt and recompiled, replacing the canvas.
  const refine = async () => {
    const plan = ai?.plan ?? meta?.plan;
    if (!change.trim() || !plan) return;
    if (handEdited && !(await ask({ title: 'Rebuild from the AI plan?', body: 'This replaces your manual changes on the canvas.', confirm: 'Rebuild' }))) return;
    setRefining(true); setAiErr('');
    try {
      const d = await api.draftWorkflow(tenantId, change.trim(), plan);
      const g = toRF(d.workflow);
      setNodes(g.nodes); setEdges(g.edges); setMeta(d.workflow.meta); setAi(d);
      if (d.sample) setTrig((t) => ({ ...t, recordId: d.sample!.recordId, objectApiName: d.sample!.objectApiName }));
      setChange(''); setDirty(true); setHandEdited(false); setRun(null);
    } catch (e) { setAiErr((e as Error).message); }
    finally { setRefining(false); }
  };

  // Dry run on the newest records: AI runs for real, nothing is written.
  const tryOnRecords = async () => {
    setPreviewing(true); setPreviewErr(''); setPreview(null);
    try {
      const wid = dirty || !id ? await save() : id;
      if (!wid) return;
      setPreview(await api.previewWorkflow(tenantId, wid, 10));
      setTested(true);
    } catch (e) { setPreviewErr((e as Error).message); }
    finally { setPreviewing(false); }
  };
  const hasRecordTrigger = nodes.some((n) => n.data.type === 'trigger.salesforce' && String(n.data.config.objectApiName ?? '').trim());

  const triggerObject = String(nodes.find((n) => n.data.type === 'trigger.salesforce')?.data.config.objectApiName ?? '').trim();
  const triggerEvent = String(nodes.find((n) => n.data.type === 'trigger.salesforce')?.data.config.event ?? 'created');
  const schedule = nodes.find((n) => n.data.type === 'trigger.schedule')?.data.config;
  const canTurnOn = !!triggerObject || !!schedule;

  // What would it have done over the last 30 days? (Saves first so the replay uses what's on screen.)
  const replay = async () => {
    const wid = dirty || !id ? await save() : id;
    if (!wid) return;
    setBt('loading');
    try { setBt(await api.backtest(tenantId, wid)); } catch (e) { setBt({ error: (e as Error).message }); }
  };
  // Before saving an edit: what comes out differently on recent real runs.
  const checkEdit = async () => {
    if (!id) return;
    setReg('loading');
    try { setReg(await api.regression(tenantId, id, fromRF(nodes, edges, meta))); } catch (e) { setReg({ error: (e as Error).message }); }
  };
  const toggleRealtime = async () => {
    if (!id) return;
    setMsg('');
    try { const r = await api.setRealtime(tenantId, id, !realtime); setRealtimeOn(r.realtime); }
    catch (e) { setMsg((e as Error).message); }
  };
  const whenText = schedule ? `every ${schedule.every ?? 'day'}${schedule.every === 'hour' ? '' : ` at ${schedule.at || '08:00'} ${schedule.tz || 'UTC'}`}` : `for every ${triggerObject} that is ${triggerEvent} in Salesforce`;
  // Turn on = Nimbus checks Salesforce every minute for matching records. Nothing is installed in the org.
  // On-demand agents have nothing to "turn on": offer to run them on a schedule instead.
  const manualTrigger = nodes.find((n) => n.data.type === 'trigger.manual');
  const [sched, setSched] = useState<{ every: 'hour' | 'day' | 'week'; at: string } | null>(null);
  const scheduleAndTurnOn = async () => {
    if (!sched || !manualTrigger) return;
    const config = { every: sched.every, at: sched.at, tz: localTz() };
    const next = nodes.map((n) => (n.id === manualTrigger.id ? { ...n, data: { ...n.data, type: 'trigger.schedule', label: 'Schedule', config } } : n));
    setDeploying(true); setMsg('');
    try {
      const wid = await save(fromRF(next, edges, meta));
      if (!wid) return;
      setNodes(next);
      await api.setLive(tenantId, wid, true);
      setLive(true);
      setSched(null);
      toast(`Turned on: runs every ${sched.every}${sched.every === 'hour' ? '' : ` at ${sched.at} (${localTz()})`}`);
    } catch (e) { setMsg((e as Error).message); }
    finally { setDeploying(false); }
  };

  const turnOn = async () => {
    if (!canTurnOn && manualTrigger) { setSched({ every: 'week', at: '08:00' }); return; }
    if (!(await ask({ title: `Turn on "${name}"?`, body: <>From now on it runs {whenText}. Changes still wait for approval if the agent has an approval step.</>, confirm: 'Turn on' }))) return;
    setDeploying(true); setMsg('');
    try {
      const wid = dirty || !id ? await save() : id;
      if (!wid) return;
      await api.setLive(tenantId, wid, true);
      setLive(true);
      toast('Agent turned on');
    } catch (e) { setMsg((e as Error).message); }
    finally { setDeploying(false); }
  };
  const turnOff = async () => {
    if (!id || !(await ask({ title: 'Turn this agent off?', body: 'It stops reacting to new records. Nothing else changes, and you can turn it back on any time.', confirm: 'Turn off' }))) return;
    setDeploying(true);
    try { await api.setLive(tenantId, id, false); setLive(false); toast('Agent turned off', 'info'); }
    catch (e) { setMsg((e as Error).message); }
    finally { setDeploying(false); }
  };

  const remove = async () => {
    if (id && await ask({ title: `Delete "${name}"?`, body: 'The agent is removed. Its past runs stay in Activity.', confirm: 'Delete agent', danger: true })) { await api.deleteWorkflow(tenantId, id); toast('Agent deleted', 'info'); onDeleted(); }
  };

  const back = async () => { if (!dirty || await ask({ title: 'Leave without saving?', body: 'Your changes to this agent will be lost.', confirm: 'Leave', danger: true })) onBack(); };

  const q = query.trim().toLowerCase();
  const visibleDefs = NODE_DEFS.filter((d) => !q || d.label.toLowerCase().includes(q) || d.description.toLowerCase().includes(q));
  const categories = Array.from(new Set(visibleDefs.map((d) => d.category))) as Category[];
  const tokens = run?.usage ? run.usage.input + run.usage.cacheRead + run.usage.cacheWrite + run.usage.output : 0;

  // The AI draft summary + "change something" box; floats over the canvas or sits above the steps.
  const aiPanel = (mode: 'float' | 'inline') => !ai ? null : !aiOpen ? (
    <button className={mode === 'float' ? 'ai-reopen' : 'ai-reopen inline'} onClick={() => setAiOpen(true)}><PenLine size={14} /> AI draft</button>
  ) : (
    <div className={'ai-panel' + (mode === 'inline' ? ' inline' : '')}>
      <div className="row between">
        <div className="row"><b>AI draft</b></div>
        <button className="ghost icon sm" onClick={() => setAiOpen(false)} title="Hide"><X size={14} /></button>
      </div>
      <ul className="ai-summary">{ai.summary.map((l, i) => <li key={i}>{l}</li>)}</ul>
      <div className="row small" style={{ flexWrap: 'wrap', gap: 6 }}>
        <span className="badge ok">≈ ${ai.estimateUsd < 0.0001 ? '0' : ai.estimateUsd.toFixed(4)} per run</span>
        {ai.sample && <span className="badge">Test record ready: {ai.sample.objectApiName}</span>}
        <span className="muted">drafted for ${ai.builderCostUsd.toFixed(4)}</span>
      </div>
      {ai.questions.map((q, i) => <div key={`q${i}`} className="ai-note">❓ {q}</div>)}
      {ai.warnings.map((w, i) => <div key={`w${i}`} className="ai-note">⚠️ {w}</div>)}
      {ai.errors.length > 0 && <div className="ai-note err">Couldn't fully fix: {ai.errors.join('; ')}</div>}
      <div className="row">
        <input
          placeholder="Change something, e.g. also post to Slack for billing cases"
          value={change} onChange={(e) => setChange(e.target.value)} disabled={refining}
          onKeyDown={(e) => { if (e.key === 'Enter') void refine(); }}
        />
        <button className="primary" onClick={refine} disabled={refining || !change.trim()}>
          {refining ? <Loader2 size={14} className="spin" /> : 'Apply'}
        </button>
      </div>
      {aiErr && <div className="err">{aiErr}</div>}
      <span className="muted small">Check the steps, press Test run (a real record is filled in), then Turn on.</span>
    </div>
  );

  return (
    <div className="builder">
      <div className="ed-top">
        <div className="ed-title">
          <button className="ghost icon" onClick={() => void back()} title="Back" aria-label="Back"><ArrowLeft size={16} /></button>
          <input className="wf-name" value={name} onChange={(e) => { setName(e.target.value); touch(); }} aria-label="Agent name" />
          <span className={'save-state' + (dirty ? ' dirty' : '')}>
            {saving ? <><Loader2 size={13} className="spin" /> Saving…</> : msg ? <span className="err">{msg}</span> : dirty ? <>● Unsaved</> : id ? <><Check size={13} /> Saved</> : 'Not saved yet'}
          </span>
        </div>
        <div className="ed-actions">
          <div className="seg" role="tablist" aria-label="View">
            <button role="tab" aria-selected={view === 'steps'} className={view === 'steps' ? 'on' : ''} onClick={() => setView('steps')} title="Plain-English steps"><LayoutList size={14} /> Steps</button>
            <button role="tab" aria-selected={view === 'canvas'} className={view === 'canvas' ? 'on' : ''} onClick={() => setView('canvas')} title="Free-form canvas (advanced)"><Network size={14} /> Canvas</button>
          </div>
          <span className="ed-sep" />
          <Menu align="right" trigger={() => (
            <button disabled={previewing || running || bt === 'loading'}>
              {previewing || running || bt === 'loading' ? <Loader2 size={14} className="spin" /> : <FlaskConical size={14} />} Test <ChevronDown size={14} />
            </button>
          )}>
            {(close) => <>
              <button className="mi" disabled={!hasRecordTrigger} onClick={() => { close(); void tryOnRecords(); }}><FlaskConical size={15} /><span>Try on 10 records<small>Newest records, nothing written</small></span></button>
              <button className="mi" disabled={!canTurnOn} onClick={() => { close(); void replay(); }}><History size={15} /><span>Replay last 30 days<small>What it would have done last month</small></span></button>
              <button className="mi" disabled={nodes.length === 0} onClick={() => { close(); void doRun(); }}><Play size={15} /><span>Test run<small>One real run, with approval if it has one</small></span></button>
            </>}
          </Menu>
          {id && dirty && <button onClick={() => void checkEdit()} title="Compare this edit with the agent's recent real runs"><GitCompare size={14} /> Check changes</button>}
          <button className={dirty || !id ? 'primary' : ''} onClick={() => void save()} disabled={(!dirty && !!id) || saving}><Save size={14} /> Save</button>
          {live ? (
            <button onClick={() => void turnOff()} disabled={deploying} title={`Runs ${whenText}${realtime ? ' (real-time)' : ''}. Click to turn off.`}><span className="dot ok" /> On</button>
          ) : (
            <button onClick={() => void turnOn()} disabled={deploying || (!canTurnOn && !manualTrigger)} title={canTurnOn ? `Run automatically ${whenText}` : manualTrigger ? 'Runs when you ask. Turn on to run it on a schedule.' : 'Needs a trigger first'}>
              {deploying ? <Loader2 size={14} className="spin" /> : <Power size={14} />} Turn on
            </button>
          )}
          {id && (
            <Menu align="right" trigger={() => <button className="ghost icon" aria-label="More"><MoreHorizontal size={16} /></button>}>
              {(close) => <button className="mi danger" onClick={() => { close(); void remove(); }}><Trash2 size={15} /> Delete agent</button>}
            </Menu>
          )}
        </div>
      </div>
      {confirmUI}
      {sched && (
        <div className="modal" onClick={() => setSched(null)}>
          <div className="confirm-card" role="dialog" aria-labelledby="sched-title" onClick={(e) => e.stopPropagation()}>
            <h2 id="sched-title">How often should it run?</h2>
            <div className="confirm-body">"{name}" runs only when someone runs it. To run it by itself, pick a schedule. You can still run it by hand any time.</div>
            <div className="seg" role="radiogroup" aria-label="How often" style={{ alignSelf: 'flex-start' }}>
              {(['hour', 'day', 'week'] as const).map((e) => <button key={e} role="radio" aria-checked={sched.every === e} className={sched.every === e ? 'on' : ''} onClick={() => setSched({ ...sched, every: e })}>Every {e}</button>)}
            </div>
            {sched.every !== 'hour' && (
              <label className="row" style={{ gap: 10, fontSize: 14 }}>At
                <input id="sched-at" type="time" value={sched.at} onChange={(e) => setSched({ ...sched, at: e.target.value || '08:00' })} style={{ width: 130 }} />
                <span className="muted small">{localTz()}{sched.every === 'week' ? ', on Mondays' : ''}</span>
              </label>
            )}
            <div className="confirm-actions">
              <button onClick={() => setSched(null)}>Cancel</button>
              <button className="primary" autoFocus disabled={deploying} onClick={() => void scheduleAndTurnOn()}>{deploying ? <Loader2 size={14} className="spin" /> : <Power size={14} />} Turn on</button>
            </div>
          </div>
        </div>
      )}

      <div className={'builder-body' + (view === 'steps' ? ' steps-mode' : '')}>
        {view === 'canvas' && <div className="palette">
          <div className="palette-search">
            <div className="search">
              <Search size={14} />
              <input placeholder="Search blocks" value={query} onChange={(e) => setQuery(e.target.value)} />
            </div>
          </div>
          {categories.map((c) => (
            <div key={c} className="pal-group">
              <div className="pal-cat"><i style={{ background: CATEGORY_COLORS[c] }} />{c}</div>
              {visibleDefs.filter((d) => d.category === c).map((d) => (
                <div
                  key={d.type} className="pal-item" draggable title={d.description}
                  onDragStart={(e) => e.dataTransfer.setData('application/crmagents-node', d.type)}
                  onClick={() => addNode(d.type)}
                >
                  <NodeTile type={d.type} />
                  <div className="pal-text"><b style={{ fontWeight: 500 }}>{d.label}</b><span>{d.description}</span></div>
                </div>
              ))}
            </div>
          ))}
          {categories.length === 0 && <div className="pad muted small">No blocks match “{query}”.</div>}
        </div>}

        <div className="canvas-wrap">
          {view === 'steps' && (
            <div className="steps-scroll">
              {ai && aiPanel('inline')}
              {nodes.length > 0 ? (
                <StepsView nodes={nodes} edges={edges} selectedId={selected?.id} onSelect={selectNode} onAdd={insertStep} />
              ) : (
                <div className="empty" style={{ maxWidth: 520, margin: '40px auto' }}>
                  <span className="empty-icon"><MousePointerClick size={20} /></span>
                  <b style={{ color: 'var(--text)' }}>How should this agent start?</b>
                  <div className="row">
                    <button onClick={() => addNode('trigger.salesforce')}><NodeTile type="trigger.salesforce" /> When a Salesforce record arrives</button>
                    <button onClick={() => addNode('trigger.manual')}><NodeTile type="trigger.manual" /> When I run it</button>
                  </div>
                </div>
              )}
            </div>
          )}
          {view === 'canvas' && <div className="canvas" onDrop={onDrop} onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }}>
            <ReactFlow
              nodes={nodes} edges={edges} nodeTypes={nodeTypes}
              onNodesChange={(c) => { onNodesChange(c); if (c.some((x) => x.type === 'position' || x.type === 'remove')) touch(); }}
              onEdgesChange={(c) => { onEdgesChange(c); if (c.some((x) => x.type === 'remove')) touch(); }}
              onConnect={onConnect} isValidConnection={isValidConnection}
              fitView fitViewOptions={{ maxZoom: 1, minZoom: 0.6, padding: 0.25 }} deleteKeyCode={['Backspace', 'Delete']}
              defaultEdgeOptions={EDGE_DEFAULTS} proOptions={{ hideAttribution: true }}
            >
              <Background variant={BackgroundVariant.Dots} gap={18} size={1.4} color="var(--canvas-dot)" />
              <Controls showInteractive={false} position="bottom-left" />
              <MiniMap pannable zoomable position="bottom-right" nodeColor={(n) => CATEGORY_COLORS[NODE_DEF_BY_TYPE[(n as WFRFNode).data.type]?.category ?? 'Utility']} />
            </ReactFlow>
            {ai && aiPanel('float')}
            {nodes.length === 0 && (
              <div className="canvas-empty">
                <div className="empty">
                  <span className="empty-icon"><MousePointerClick size={20} /></span>
                  <b style={{ color: 'var(--text)' }}>Start with a trigger</b>
                  <span className="small">Drag blocks from the left, or click one to add it. Connect blocks by dragging from the right dot of one to another.</span>
                  <div className="row">
                    <button onClick={() => addNode('trigger.salesforce')}><NodeTile type="trigger.salesforce" /> Salesforce record</button>
                    <button onClick={() => addNode('trigger.manual')}><NodeTile type="trigger.manual" /> Manual</button>
                  </div>
                </div>
              </div>
            )}
          </div>}

          <div className="drawer">
            <div className="drawer-head" onClick={() => setDrawer((d) => !d)}>
              <Play size={14} color="var(--accent)" />
              <b>Test run</b>
              {run && <span className={'badge ' + (STATUS_BADGE[run.status] ?? '')}>{run.status}</span>}
              {running && <Loader2 size={14} className="spin" />}
              {run?.usage && tokens > 0 && (
                <span className="muted small">{tokens.toLocaleString()} tokens{run.usage.cacheRead ? ` (${run.usage.cacheRead.toLocaleString()} cached)` : ''} · ${run.usage.costUsd.toFixed(4)}</span>
              )}
              <span className="spacer" />
              {drawer ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
            </div>
            {drawer && (
              <div className="drawer-body">
                <div className="run-inputs">
                  <label>Input<input placeholder="trigger.input" value={trig.input} onChange={(e) => setTrig({ ...trig, input: e.target.value })} /></label>
                  <label>Record Id<input placeholder="001…" value={trig.recordId} onChange={(e) => setTrig({ ...trig, recordId: e.target.value })} /></label>
                  <label>Object<input placeholder="Account" value={trig.objectApiName} onChange={(e) => setTrig({ ...trig, objectApiName: e.target.value })} /></label>
                  <label>Context (JSON)<input placeholder='{"key": "value"}' value={trig.context} onChange={(e) => setTrig({ ...trig, context: e.target.value })} /></label>
                  <button className="primary" onClick={doRun} disabled={running || nodes.length === 0}>
                    {running ? <Loader2 size={14} className="spin" /> : <Play size={14} />} Run
                  </button>
                </div>

                {run?.status === 'waiting' && (
                  <div className="approval">
                    <b>Waiting for approval</b>
                    <span className="small">{String((run.steps.find((s) => s.status === 'waiting')?.output as { message?: string } | undefined)?.message ?? '')}</span>
                    <div className="row">
                      <button className="primary" onClick={() => decide(true)} disabled={running}>Approve</button>
                      <button onClick={() => decide(false)} disabled={running}>Reject</button>
                    </div>
                  </div>
                )}
                {run?.error && <div className="err">{run.error}</div>}
                {run?.output && !run.error && (
                  <div>
                    <div className="label">Result</div>
                    <pre className="out">{run.output}</pre>
                  </div>
                )}
                {run && run.steps.length > 0 && (
                  <div>
                    <div className="label">Steps</div>
                    <div className="timeline">
                      {run.steps.map((s, i) => (
                        <details key={i}>
                          <summary>
                            <span className={'dot ' + s.status} />
                            <NodeTile type={s.type} />
                            <span>{nodes.find((n) => n.id === s.nodeId)?.data.label || NODE_DEF_BY_TYPE[s.type]?.label || s.label}{s.iteration !== undefined ? ` · item ${s.iteration + 1}` : ''}</span>
                            {s.reused && <span className="badge ok" title="Identical input seen recently: earlier answer reused, no tokens spent">reused · $0</span>}
                            {s.error && <span className="err small">{s.error}</span>}
                            <span className="t-ms">{s.ms} ms</span>
                          </summary>
                          <pre className="out">{JSON.stringify(s.output ?? s.error, null, 2)}{s.trace?.length ? '\n\ntools: ' + s.trace.map((t) => `${t.ok ? '✓' : '✗'} ${t.tool}`).join(', ') : ''}</pre>
                        </details>
                      ))}
                    </div>
                  </div>
                )}
                {!run && !running && <span className="muted small">Fill in what the trigger receives, then run. Results show here and on each block.</span>}
              </div>
            )}
          </div>
        </div>

        <div className="inspector-panel">
          {selected
            ? <Inspector
                key={selected.id} node={selected} tools={tools} refs={refs} inLoop={inLoop}
                steps={run?.steps.filter((s) => s.nodeId === selected.id) ?? []}
                onChange={patchSelected} onDelete={deleteSelected}
              />
            : (
              <div className="insp-empty">
                <b style={{ color: 'var(--text)' }}>No block selected</b>
                <span>Select a block on the canvas to edit its settings and see its last run output.</span>
                <span className="small">Tips: drag from a block's right dot to connect it · Delete removes the selection · Ctrl/⌘+S saves.</span>
                <span className="small">{nodes.length} blocks · {edges.length} connections</span>
              </div>
            )}
        </div>
      </div>
      {bt && (
        <ResultModal title="Replay: the last 30 days" sub="What this agent would have done if it had been on. Nothing was written to Salesforce." onClose={() => setBt(null)}>
          {bt === 'loading' ? <Working text="Replaying on a sample of last month's records…" /> : 'error' in bt ? <div className="err">{bt.error}</div> : <BacktestView b={bt} />}
        </ResultModal>
      )}
      {reg && (
        <ResultModal title="Check changes" sub="Your unsaved edit, replayed on this agent's recent real runs. Nothing was written to Salesforce." onClose={() => setReg(null)}
          footer={reg !== 'loading' && !('error' in reg) ? <><button onClick={() => setReg(null)}>Keep editing</button><button className="primary" onClick={() => { setReg(null); void save(); }}>Save</button></> : undefined}>
          {reg === 'loading' ? <Working text="Replaying recent runs with your edit…" /> : 'error' in reg ? <div className="err">{reg.error}</div> : <RegressionView r={reg} />}
        </ResultModal>
      )}
      {(preview || previewErr) && (
        <div className="modal" onClick={() => { setPreview(null); setPreviewErr(''); }}>
          <div className="modal-card wide" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <div>
                <h3>Preview on {preview ? `${preview.rows.length} recent ${preview.object} records` : 'recent records'}</h3>
                <p className="muted small" style={{ margin: '4px 0 0' }}>AI ran for real; <b>nothing was written</b> to Salesforce. "Would" shows what a live run does.</p>
              </div>
              <button className="ghost icon" onClick={() => { setPreview(null); setPreviewErr(''); }} aria-label="Close"><X size={16} /></button>
            </div>
            {previewErr && <div className="err">{previewErr}</div>}
            {preview && (
              <>
                <div className="row small" style={{ gap: 8, marginBottom: 10 }}>
                  <span className="badge ok">Total ${preview.totalCostUsd.toFixed(4)}</span>
                  <span className="badge">≈ ${preview.avgCostUsd.toFixed(5)} per record</span>
                  <span className="badge">{preview.rows.filter((r) => r.wouldDo.length).length} would change something</span>
                  <span className="badge">{preview.rows.filter((r) => /^Skipped/.test(r.result) && !r.wouldDo.length).length} skipped by rules (no AI)</span>
                  {preview.rows.some((r) => r.decisions.length) && (
                    <span className="muted">Confirm ✓ or pick the right answer: it learns from you{exampleTotal !== null ? ` (${exampleTotal} examples saved)` : ''}.</span>
                  )}
                </div>
                <table className="preview-table">
                  <thead><tr><th>Record</th><th>AI decided</th><th>Would do</th><th>Cost</th></tr></thead>
                  <tbody>
                    {preview.rows.map((r) => (
                      <tr key={r.recordId} className={r.status === 'error' ? 'is-error' : ''}>
                        <td><b>{r.label}</b></td>
                        <td>
                          {r.decisions.map((x) => {
                            const key = `${r.recordId}:${x.nodeId}`;
                            const given = taught[key];
                            return (
                              <div key={x.nodeId} className="decision">
                                <select value={given ?? x.value} onChange={(e) => void teach(r.recordId, x, e.target.value)} title="Pick the right answer to teach it">
                                  {x.categories.map((c) => <option key={c} value={c}>{c}</option>)}
                                </select>
                                {given
                                  ? <span className="badge ok">{given === x.value ? 'confirmed' : 'corrected'}</span>
                                  : <button className="sm" onClick={() => void teach(r.recordId, x, x.value)} title="This is right">✓</button>}
                                {x.examplesUsed > 0 && <span className="muted small" title="Past decisions it learned from">learned from {x.examplesUsed}</span>}
                              </div>
                            );
                          })}
                          {!r.decisions.length && <span className="muted">–</span>}
                        </td>
                        <td>
                          {r.error ? <span className="err">{r.error}</span>
                            : r.wouldDo.length ? r.wouldDo.map((w, i) => (
                              <details key={i}><summary>{w.action}</summary><pre className="out">{JSON.stringify(w.detail, null, 2)}</pre></details>
                            ))
                            : <span className="muted">{r.result.slice(0, 120)}</span>}
                        </td>
                        <td className="mono">${r.costUsd.toFixed(5)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function WorkflowEditor(props: Props) {
  return <ReactFlowProvider><Editor {...props} /></ReactFlowProvider>;
}
