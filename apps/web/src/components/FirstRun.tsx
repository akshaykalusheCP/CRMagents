import { Check, ChevronRight, Database, Loader2, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { USE_CASES } from '@crmagents/shared';
import { api, type SampleStatus, type Settings, type Tenant } from '../api';
import { toast } from './ui';

// The guided first run on Home: one step at a time, each with one clear action, from connecting Salesforce to an
// agent turned on. A test org can be filled with sample data so the starter agents have real work to show.
// Hidden once everything is done, or when the person hides it (remembered per org in this browser).

const STARTERS = ['case-triage', 'lead-scoring', 'stale-deals'].map((id) => USE_CASES.find((u) => u.id === id)!).filter(Boolean);
const hiddenKey = (t?: Tenant) => `crm-firstrun-hidden:${t?.id ?? 'none'}`;
const read = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const write = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private window: fine */ } };

export function FirstRun({ tenant, settings, agents, tried, live, isAdmin, openSettings, openAgents, newAgent }: {
  tenant?: Tenant; settings?: Settings; agents: number; tried: boolean; live: number; isAdmin: boolean;
  openSettings: (section: 'orgs' | 'ai', connect?: boolean) => void; openAgents: () => void; newAgent: (request?: string) => void;
}) {
  const [sample, setSample] = useState<SampleStatus | 'none'>();
  const [loading, setLoading] = useState(false);
  const [hidden, setHidden] = useState(() => read(hiddenKey(tenant)) === '1');
  const [skipData, setSkipData] = useState(() => read(`${hiddenKey(tenant)}:data`) === '1');
  const ready = tenant?.setup_status === 'ready';
  useEffect(() => {
    setHidden(read(hiddenKey(tenant)) === '1'); setSkipData(read(`${hiddenKey(tenant)}:data`) === '1');
    if (!ready || !tenant) { setSample(undefined); return; }
    api.sampleStatus(tenant.id).then(setSample).catch(() => setSample('none'));
  }, [tenant?.id, ready]); // eslint-disable-line react-hooks/exhaustive-deps

  const st = sample && sample !== 'none' ? sample : null;
  const testOrg = !!st?.allowed;
  const dataDone = !testOrg || !!st?.loaded || skipData || agents > 0;
  const steps = [
    { id: 'connect', title: 'Connect Salesforce', done: ready, why: "Log in on Salesforce's own page. Nothing is installed and nothing changes in your org." },
    { id: 'ai', title: 'Connect AI', done: !!settings?.aiReady || !!settings?.anthropicKey?.set || !!settings?.providerKey?.set, why: 'Agents use AI to read and decide. Add your AI key; you set a daily spending limit.' },
    { id: 'data', title: 'Give agents something to work on', done: dataDone, why: 'This is a test org. Fill it with realistic accounts, deals, cases and leads: urgent cases to triage, leads to score, overdue deals to chase. Removable in one click.' },
    { id: 'agent', title: 'Pick a first agent', done: agents > 0, why: 'Start from a proven job. The builder fits it to your fields; nothing runs until you turn it on.' },
    { id: 'try', title: 'Try it on a record', done: tried, why: 'Open your agent and press Test: it runs on one record and shows every step and change before anything is live.' },
    { id: 'on', title: 'Turn it on', done: live > 0, why: 'Switch it on when you trust it. Changes can be undone, and risky ones wait for approval.' },
  ].filter((s) => s.id !== 'data' || testOrg);
  const left = steps.filter((s) => !s.done).length;
  if (hidden || left === 0) return null;
  const current = steps.find((s) => !s.done)!;

  const loadData = async () => {
    if (!tenant) return;
    setLoading(true);
    try {
      const r = await api.loadSample(tenant.id);
      const n = Object.values(r.counts).reduce((a, b) => a + b, 0);
      toast(r.failures.length ? `Added ${n} records; some were refused by your org's rules: ${r.failures[0]}` : `Added ${n} sample records`, r.failures.length ? 'bad' : 'ok');
      setSample(await api.sampleStatus(tenant.id));
    } catch (e) { toast((e as Error).message, 'bad'); }
    setLoading(false);
  };
  const action = () => {
    switch (current.id) {
      case 'connect': return <button className="primary cta sm" onClick={() => openSettings('orgs', true)}>Connect Salesforce <ChevronRight size={14} /></button>;
      case 'ai': return <button className="primary cta sm" onClick={() => openSettings('ai')}>Add AI key <ChevronRight size={14} /></button>;
      case 'data': return <div className="fr-actions">
        {isAdmin ? <button className="primary cta sm" disabled={loading} onClick={() => void loadData()}>{loading ? <Loader2 size={14} className="spin" /> : <Database size={14} />} {loading ? 'Adding about 60 records…' : 'Load sample data'}</button> : <span className="muted small">Ask an admin to load sample data.</span>}
        <button className="ghost sm" onClick={() => { write(`${hiddenKey(tenant)}:data`, '1'); setSkipData(true); }}>Skip: use my own data</button>
      </div>;
      case 'agent': return <div className="fr-starters">{STARTERS.map((u) => (
        <button key={u.id} className="fr-starter" onClick={() => newAgent(u.request)}><span className="uc-area">{u.area}</span><b>{u.title}</b><span>{u.problem}</span><em>{u.cost} / run</em></button>
      ))}</div>;
      default: return <button className="primary cta sm" onClick={openAgents}>{current.id === 'try' ? 'Open my agent' : 'Go to agents'} <ChevronRight size={14} /></button>;
    }
  };
  const doneN = steps.length - left;
  return (
    <section className="fr" aria-label="Getting started">
      <header>
        <div><h2>Get your first agent working</h2><span className="muted small">{doneN} of {steps.length} done · about 10 minutes</span></div>
        <button className="ghost icon sm" aria-label="Hide getting started" title="Hide" onClick={() => { write(hiddenKey(tenant), '1'); setHidden(true); }}><X size={15} /></button>
      </header>
      <div className="fr-bar" aria-hidden><i style={{ width: `${(doneN / steps.length) * 100}%` }} /></div>
      <ol>
        {steps.map((s, i) => (
          <li key={s.id} className={s.done ? 'done' : s === current ? 'now' : ''}>
            <span className="fr-n">{s.done ? <Check size={13} /> : i + 1}</span>
            <div className="fr-body">
              <b>{s.title}</b>
              {s === current && <><p>{s.why}</p>{action()}</>}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
