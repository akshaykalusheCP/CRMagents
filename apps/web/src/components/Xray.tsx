import { AlertTriangle, ChevronDown, ChevronRight, Loader2, ScanSearch, Sparkles, Wand2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, type Tenant, type Xray } from '../api';
import { Markdown } from './Markdown';
import { Empty, Status, toast } from './ui';

// Automation X-ray: everything that runs when records are saved, per object, with the problems found in code:
// fields set by two automations, crowded objects, retired tools, clutter. Per object, the AI explains it in plain
// English and can draft one agent to replace it.

const KIND: Record<string, string> = { flow: 'Flow', process: 'Process Builder', workflow: 'Workflow Rule', trigger: 'Apex trigger' };
const TONE = { high: 'bad', medium: 'warn', low: 'neutral' } as const;
const SEV = { high: 'Fix', medium: 'Plan', low: 'Tidy' } as const;

export function XrayPanel({ tenant, openAgents }: { tenant: Tenant; openAgents: () => void }) {
  const [x, setX] = useState<Xray | null | undefined>(undefined);
  const [scanning, setScanning] = useState(false);
  const [openObj, setOpenObj] = useState<string | null>(null);
  const [explained, setExplained] = useState<Record<string, { summary: string; risks: string; replacement: string } | 'loading'>>({});
  const [drafted, setDrafted] = useState<Record<string, { name: string; summary: string[] } | 'loading'>>({});

  useEffect(() => { setX(undefined); api.xray(tenant.id).then(setX).catch(() => setX(null)); }, [tenant.id]);
  const scan = async () => {
    setScanning(true);
    try { setX(await api.scanXray(tenant.id)); } catch (e) { toast((e as Error).message, 'bad'); }
    setScanning(false);
  };
  const explain = async (o: string) => {
    setExplained((m) => ({ ...m, [o]: 'loading' }));
    try { const r = await api.explainObject(tenant.id, o); setExplained((m) => ({ ...m, [o]: r })); }
    catch (e) { toast((e as Error).message, 'bad'); setExplained((m) => { const n = { ...m }; delete n[o]; return n; }); }
  };
  const draft = async (o: string, request: string) => {
    setDrafted((m) => ({ ...m, [o]: 'loading' }));
    try { const r = await api.draftReplacement(tenant.id, request); setDrafted((m) => ({ ...m, [o]: r })); toast(`Drafted "${r.name}" (off)`); }
    catch (e) { toast((e as Error).message, 'bad'); setDrafted((m) => { const n = { ...m }; delete n[o]; return n; }); }
  };

  const counts = x ? { high: x.findings.filter((f) => f.severity === 'high').length, medium: x.findings.filter((f) => f.severity === 'medium').length, low: x.findings.filter((f) => f.severity === 'low').length } : null;
  return (
    <div className="xr">
      <section className="dc-hero">
        <div className="dc-hero-main xr-hero">
          {x ? <>
            <div className={'xr-score ' + (x.score >= 85 ? 'good' : x.score >= 60 ? 'mid' : 'low')}><b>{x.score}</b><span>/ 100</span></div>
            <div>
              <div className="xr-h">Automation health</div>
              <p>{x.automations.length} automations on {x.objects.length} objects · <b>{counts!.high}</b> to fix, <b>{counts!.medium}</b> to plan, <b>{counts!.low}</b> to tidy.
                <span className="muted"> Read from metadata only, no AI. Scanned {new Date(x.scannedAt).toLocaleString()}{x.flowsSkipped ? ` · ${x.flowsSkipped} flows not read in detail` : ''}.</span></p>
            </div>
          </> : <>
            <div className="dc-big dc-q">What runs when a record is saved?</div>
            <p>Reads every Flow, Process Builder, Workflow Rule and Apex trigger in this org and finds fields set by two automations, objects with too much going on, and tools Salesforce has retired.</p>
          </>}
        </div>
        <button className="primary" onClick={() => void scan()} disabled={scanning || x === undefined}>
          {scanning ? <Loader2 size={15} className="spin" /> : <ScanSearch size={15} />} {x ? 'Scan again' : 'X-ray my automation'}
        </button>
      </section>

      {x && !x.findings.length && <Empty title="No problems found" body="No overlapping field updates, crowded objects or retired tools." />}
      {x && x.findings.length > 0 && (
        <ul className="xr-findings">
          {x.findings.slice(0, 30).map((f, i) => (
            <li key={i}>
              <Status tone={TONE[f.severity]}>{SEV[f.severity]}</Status>
              <div><b>{f.title}</b><span>{f.detail}</span></div>
              <button className="link-btn" onClick={() => setOpenObj(f.object)}>{f.object}</button>
            </li>
          ))}
        </ul>
      )}

      {x && x.objects.length > 0 && <>
        <h3 className="xr-sec">By object</h3>
        <div className="xr-objects">
          {x.objects.map((o) => {
            const isOpen = openObj === o.object;
            const as = x.automations.filter((a) => a.object === o.object);
            const ex = explained[o.object];
            const dr = drafted[o.object];
            return (
              <div key={o.object} className={'xr-obj' + (isOpen ? ' open' : '')}>
                <button className="xr-obj-row" onClick={() => setOpenObj(isOpen ? null : o.object)} aria-expanded={isOpen}>
                  {isOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                  <b>{o.object}</b>
                  <span className="xr-kinds">{Object.entries(o.kinds).map(([k, n]) => `${n} ${KIND[k]}${n > 1 ? 's' : ''}`).join(' · ')}{o.rules ? ` · ${o.rules} validation rule${o.rules > 1 ? 's' : ''}` : ''}</span>
                  {o.findings > 0 && <span className="xr-flag"><AlertTriangle size={13} /> {o.findings}</span>}
                </button>
                {isOpen && (
                  <div className="xr-detail">
                    <ul className="xr-autos">
                      {as.map((a) => (
                        <li key={a.kind + a.name}>
                          <span className={'xr-kind k-' + a.kind}>{KIND[a.kind]}</span>
                          <div><b>{a.label}</b><span className="muted small">{a.event === 'any' ? 'on save' : `when ${a.event}`} · {a.timing}{a.order != null ? ` · order ${a.order}` : ''}</span>
                            {a.writes.length > 0 && <span className="small">Sets {a.writes.map((w) => `${w.object === o.object ? '' : `${w.object}: `}${w.fields.join(', ')}`).join('; ')}</span>}
                            {a.creates.length > 0 && <span className="small">Creates {a.creates.join(', ')}</span>}
                          </div>
                        </li>
                      ))}
                    </ul>
                    {!ex && <button className="sm" onClick={() => void explain(o.object)}><Sparkles size={14} /> Explain in plain English</button>}
                    {ex === 'loading' && <span className="row muted small"><Loader2 size={14} className="spin" /> Reading the automation…</span>}
                    {ex && ex !== 'loading' && (
                      <div className="xr-explain">
                        <h4>What happens when a {o.object} is saved</h4>
                        <Markdown text={ex.summary} />
                        {ex.risks && <><h4>Watch out for</h4><Markdown text={ex.risks} /></>}
                        {ex.replacement && (
                          <div className="xr-replace">
                            <h4>One agent instead</h4>
                            <p>{ex.replacement}</p>
                            {!dr && <button className="primary sm" onClick={() => void draft(o.object, ex.replacement)}><Wand2 size={14} /> Draft this agent (stays off)</button>}
                            {dr === 'loading' && <span className="row muted small"><Loader2 size={14} className="spin" /> Building it for this org…</span>}
                            {dr && dr !== 'loading' && <div className="xr-drafted"><b>Drafted "{dr.name}"</b>: {dr.summary.join(' · ')}. It is off: replay it on records, then turn it on and switch the old automations off. <button className="link-btn" onClick={openAgents}>Open in Agents</button></div>}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </>}
    </div>
  );
}
