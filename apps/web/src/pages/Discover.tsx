import { ArrowRight, CheckCircle2, GraduationCap, Loader2, Power, Radar, FlaskConical, XCircle } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, type Discovery, type Opportunity, type Proof, type Tenant } from '../api';
import { Empty, PageHeader, Status, toast } from '../components/ui';
import { XrayPanel } from '../components/Xray';
import { LockedPage, PlanTag, usePlan } from '../components/Plan';

// What to automate, from the org's own data: a quick scan (counting only, no AI) finds the repetitive work, then
// each opportunity can be built into an agent and proven on real records: what it would have done, and how often
// it agrees with the team. Nothing is written and nothing goes live until someone turns it on.

const hours = (h: number) => (h < 0.1 ? 'under 0.1 h' : `${h.toLocaleString(undefined, { maximumFractionDigits: 1 })} h`);
const money = (n: number) => `$${Math.round(n).toLocaleString()}`;
const pct = (r: number | null | undefined) => (r == null ? '–' : `${Math.round(r * 100)}%`);
const detailText = (d: unknown) => (d && typeof d === 'object' ? Object.entries(d as Record<string, unknown>).filter(([k]) => !/Id$/.test(k)).map(([k, v]) => `${k}: ${String(v).slice(0, 80)}`).join(' · ') : String(d ?? '').split('\n')[0].slice(0, 160));

export function DiscoverPage({ tenant, openAgents }: { tenant?: Tenant; openAgents: () => void }) {
  const [d, setD] = useState<Discovery | null | undefined>(undefined);
  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [view, setView] = useState<'work' | 'xray'>('work');
  const { has } = usePlan();

  useEffect(() => { setD(undefined); if (tenant) api.discovery(tenant.id).then(setD).catch(() => setD(null)); }, [tenant?.id]);
  if (!tenant) return <div className="pg"><PageHeader title="Discover" description="Connect a Salesforce org first." /></div>;

  const scan = async () => {
    setScanning(true);
    try { const r = await api.scanOrg(tenant.id); setD(r); setOpen(null); } catch (e) { toast((e as Error).message, 'bad'); }
    setScanning(false);
  };
  const prove = async (o: Opportunity) => {
    setBusy(o.id); setOpen(o.id);
    try {
      const p = await api.prove(tenant.id, o.id);
      setD((x) => x && { ...x, builds: { ...x.builds, [o.id]: { opportunity: o.id, workflowId: p.workflowId, proof: p, name: p.name, live: false } } });
    } catch (e) { toast((e as Error).message, 'bad'); }
    setBusy(null);
  };
  const learn = async (o: Opportunity) => {
    setBusy(`learn-${o.id}`);
    try {
      const p = await api.learnFromTeam(tenant.id, o.id);
      setD((x) => x && { ...x, builds: { ...x.builds, [o.id]: { ...x.builds[o.id], proof: p } } });
      toast(`Learned from ${p.learned} of your team's decisions`);
    } catch (e) { toast((e as Error).message, 'bad'); }
    setBusy(null);
  };
  const turnOn = async (o: Opportunity, workflowId: string) => {
    setBusy(`on-${o.id}`);
    try {
      await api.setLive(tenant.id, workflowId, true);
      setD((x) => x && { ...x, builds: { ...x.builds, [o.id]: { ...x.builds[o.id], live: true } } });
      toast('Agent turned on');
    } catch (e) { toast((e as Error).message, 'bad'); }
    setBusy(null);
  };

  return (
    <div className="pg">
      <PageHeader title="Discover" description="What your team does by hand that an agent could do, found in your own Salesforce data and proven on your own records." />
      <div className="ptabs dc-tabs" role="tablist">
        <button role="tab" aria-selected={view === 'work'} className={view === 'work' ? 'on' : ''} onClick={() => setView('work')}>Hand work</button>
        <button role="tab" aria-selected={view === 'xray'} className={view === 'xray' ? 'on' : ''} onClick={() => setView('xray')}>Automation X-ray<PlanTag feature="xray" /></button>
      </div>
      {view === 'xray' ? (has('xray') ? <XrayPanel tenant={tenant} openAgents={openAgents} /> : <LockedPage feature="xray" title="The Automation X-ray" />) : <>
      <section className="dc-hero">
        <div className="dc-hero-main">
          {d ? <>
            <div className="dc-big">{hours(d.totalHours)}<small> a month</small></div>
            <p>of hand work found in <b>{tenant.sf_username ?? 'this org'}</b>, worth about <b>{money(d.totalHours * d.hourlyRate)}</b> a month at ${d.hourlyRate}/hour.
              <span className="muted"> Scanned {new Date(d.scannedAt).toLocaleString()} · {d.checked} checks · counts only, no record data left Salesforce.</span></p>
          </> : <>
            <div className="dc-big dc-q">What should you automate?</div>
            <p>A 10-second scan counts the repetitive work in this org: cases sorted by hand, emails waiting for replies, leads nobody touched, deals gone quiet. No AI, no cost.</p>
          </>}
        </div>
        <button className="primary" onClick={() => void scan()} disabled={scanning || d === undefined}>
          {scanning ? <Loader2 size={15} className="spin" /> : <Radar size={15} />} {d ? 'Scan again' : 'Scan my org'}
        </button>
      </section>

      {d && !d.opportunities.length && <Empty title="Nothing repetitive found" body="This org has little hand work in the areas we check. Try again once it has more activity." />}

      <div className="dc-list">
        {d?.opportunities.map((o, i) => {
          const b = d.builds[o.id];
          const p = b?.proof;
          const isOpen = open === o.id || (!!p && open === null && i === 0);
          return (
            <article key={o.id} className={'dc-card' + (isOpen ? ' open' : '')}>
              <div className="dc-row">
                <div className="dc-rank">{i + 1}</div>
                <div className="dc-main">
                  <div className="dc-title"><b>{o.title}</b><span className="dc-area">{o.area}</span>{b?.live && <Status tone="ok">On</Status>}</div>
                  <span className="dc-evidence">{o.evidence}</span>
                </div>
                <div className="dc-hours"><b>{hours(o.hoursPerMonth)}</b><span>{money(o.valuePerMonth)} / month</span></div>
                <div className="dc-actions">
                  {p ? <button className="sm" onClick={() => setOpen(isOpen ? '' : o.id)}>{isOpen ? 'Hide proof' : 'See proof'}</button>
                    : <button className="sm" onClick={() => void prove(o)} disabled={!!busy}><PlanTag feature="prove" />{busy === o.id ? <Loader2 size={14} className="spin" /> : <FlaskConical size={14} />} Build &amp; prove</button>}
                </div>
              </div>

              {busy === o.id && (
                <div className="dc-proving"><Loader2 size={16} className="spin" /> Building the agent for this org, then replaying it on your real records. Nothing is written. About 30–60 seconds.</div>
              )}

              {isOpen && p && b && (
                <div className="dc-proof">
                  <div className="dc-metrics">
                    <div><small>Replayed on</small><b>{p.ok} of {p.replayed}</b><span>real records</span></div>
                    {p.agreement && <div className={'dc-agree ' + ((p.agreement.rate ?? 0) >= 0.8 ? 'good' : (p.agreement.rate ?? 0) >= 0.6 ? 'mid' : 'low')}>
                      <small>Agrees with your team</small><b>{pct(p.agreement.rate)}</b>
                      <span>{p.agreement.matched} of {p.agreement.checked} choices{p.agreementBefore ? ` · was ${pct(p.agreementBefore.rate)} before learning` : ''}</span>
                    </div>}
                    <div><small>Saves</small><b>{hours(p.hoursPerMonth)}</b><span>{money(p.valuePerMonth)} a month</span></div>
                    <div><small>AI cost</small><b>~${p.monthlyCostUsd < 1 ? p.monthlyCostUsd.toFixed(2) : Math.round(p.monthlyCostUsd)}</b><span>a month · proof cost ${p.costUsd.toFixed(3)}</span></div>
                  </div>

                  <div className="dc-cols">
                    <div>
                      <h4>{p.name}</h4>
                      <ol className="dc-steps">{p.summary.map((s, j) => <li key={j}>{s}</li>)}</ol>
                    </div>
                    <div>
                      {p.agreement?.examples.length ? <>
                        <h4>Its choices vs your team's</h4>
                        <table className="dc-cmp"><thead><tr><th>Record</th><th>Field</th><th>Agent</th><th>Team</th><th /></tr></thead>
                          <tbody>{p.agreement.examples.slice(0, 8).map((e, j) => (
                            <tr key={j}><td><a href={`${tenant.sf_instance_url}/${e.recordId}`} target="_blank" rel="noreferrer">{p.rows.find((r) => r.recordId === e.recordId)?.label.split(' · ')[0] ?? e.recordId.slice(-6)}</a></td>
                              <td>{e.field}</td><td>{e.agent}</td><td>{e.team}</td><td>{e.same ? <CheckCircle2 size={15} className="ok" /> : <XCircle size={15} className="bad" />}</td></tr>
                          ))}</tbody></table>
                      </> : <>
                        <h4>What it would have done</h4>
                        <ul className="dc-would">{p.rows.slice(0, 5).map((r) => (
                          <li key={r.recordId}><b>{r.label}</b>{r.status === 'error' ? <span className="bad">{r.error}</span> : r.wouldDo.length ? r.wouldDo.slice(0, 2).map((w, j) => <span key={j}>{w.action}{detailText(w.detail) ? `: ${detailText(w.detail)}` : ''}</span>) : <span className="muted">Nothing to do</span>}</li>
                        ))}</ul>
                      </>}
                    </div>
                  </div>

                  <div className="dc-foot">
                    {p.agreement && !p.learned && <button className="sm" onClick={() => void learn(o)} disabled={!!busy}>{busy === `learn-${o.id}` ? <Loader2 size={14} className="spin" /> : <GraduationCap size={14} />} Learn from my team's past decisions</button>}
                    {p.learned ? <span className="muted small">Learned from {p.learned} past decisions (never the replayed records)</span> : null}
                    <span style={{ flex: 1 }} />
                    <button className="sm" onClick={openAgents}>Open in Agents <ArrowRight size={14} /></button>
                    {b.workflowId && !b.live && <button className="primary sm" onClick={() => void turnOn(o, b.workflowId!)} disabled={!!busy}>{busy === `on-${o.id}` ? <Loader2 size={14} className="spin" /> : <Power size={14} />} Turn on</button>}
                  </div>
                </div>
              )}
            </article>
          );
        })}
      </div>
      </>}
    </div>
  );
}
