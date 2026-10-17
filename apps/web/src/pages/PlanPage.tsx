import { Check, Lock } from 'lucide-react';
import { useEffect, useState } from 'react';
import { FEATURE_LABEL, PLAN_DEFS, type Feature } from '@crmagents/shared';
import { api, type Me, type PlanId, type PlatformAccount } from '../api';
import { usePlan } from '../components/Plan';
import { Meter, Panel, Status, Table, toast } from '../components/ui';

// Settings → Plan: what this workspace is on, what it uses against its limits, what each plan adds, and asking for
// an upgrade. CRMagents staff (platform admins) also see every workspace and set its plan here.

const ORDER: PlanId[] = ['basic', 'plus', 'pro', 'promax'];
const ALL_FEATURES = Object.keys(FEATURE_LABEL) as Feature[];
const LIMIT_LABEL = { orgs: 'Salesforce orgs', users: 'People (incl. invitations)', liveAgents: 'Live agents', assistants: 'Assistants' } as const;

function PlatformAdmin() {
  const [rows, setRows] = useState<PlatformAccount[]>();
  const load = () => api.platformAccounts().then(setRows).catch((e) => toast((e as Error).message, 'bad'));
  useEffect(() => { void load(); }, []);
  const set = async (a: PlatformAccount, plan: PlanId) => {
    if (!window.confirm(`Set "${a.name}" to ${PLAN_DEFS[plan].name}?${plan === 'basic' ? ' This starts a new 14-day trial.' : ''}`)) return;
    try { await api.setAccountPlan(a.id, plan); toast(`${a.name} is now on ${PLAN_DEFS[plan].name}`); await load(); } catch (e) { toast((e as Error).message, 'bad'); }
  };
  return (
    <Panel flush title="All workspaces (CRMagents staff only)" action={<span className="muted small">Only platform admins see this.</span>}>
      <Table rows={rows ?? []} rowKey={(a) => a.id}
        empty={<p className="muted small" style={{ padding: 16, margin: 0 }}>{rows ? 'No workspaces.' : 'Loading…'}</p>}
        columns={[
          { key: 'name', header: 'Workspace', render: (a) => <span><b>{a.name}</b><br /><span className="muted small">{a.owner ?? ''}</span></span> },
          { key: 'use', header: 'Orgs · people', width: '120px', hideSm: true, render: (a) => `${a.orgs} · ${a.users}` },
          { key: 'req', header: 'Asked for', width: '110px', hideSm: true, render: (a) => (a.requestedPlan ? <Status tone="warn">{PLAN_DEFS[a.requestedPlan].name}</Status> : <span className="muted">–</span>) },
          { key: 'trial', header: 'Trial ends', width: '120px', hideSm: true, render: (a) => (a.plan === 'basic' && a.trialEndsAt ? new Date(a.trialEndsAt).toLocaleDateString() : <span className="muted">–</span>) },
          { key: 'plan', header: 'Plan', width: '150px', render: (a) => (
            <select className="sm" value={a.plan} onChange={(e) => void set(a, e.target.value as PlanId)} aria-label={`Plan for ${a.name}`}>
              {ORDER.map((p) => <option key={p} value={p}>{PLAN_DEFS[p].name}</option>)}
            </select>
          ) },
        ]} />
    </Panel>
  );
}

export function PlanPage({ me }: { me: Me }) {
  const { plan, reload } = usePlan();
  const [asked, setAsked] = useState<PlanId | null>(null);
  useEffect(reload, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (!plan) return <p className="muted">Loading…</p>;
  const admin = ['owner', 'admin'].includes(me.role);
  const days = plan.trialEndsAt ? Math.max(0, Math.ceil((new Date(plan.trialEndsAt).getTime() - Date.now()) / 86_400_000)) : null;
  const ask = async (p: PlanId) => {
    try { await api.requestUpgrade(p); setAsked(p); reload(); toast(`Request sent: we'll be in touch about ${PLAN_DEFS[p].name}`); } catch (e) { toast((e as Error).message, 'bad'); }
  };
  return (
    <div className="smart-col">
      <Panel title="Your plan">
        <div className="plan-now">
          <div><span className="plan-name">{plan.name}</span>
            {plan.plan === 'basic' && days !== null && <Status tone={plan.trialEnded ? 'bad' : 'warn'}>{plan.trialEnded ? 'Trial ended' : `Trial: ${days} day${days === 1 ? '' : 's'} left`}</Status>}
            {(plan.requestedPlan || asked) && <Status tone="info">Upgrade to {PLAN_DEFS[(asked ?? plan.requestedPlan)!].name} requested</Status>}
          </div>
          <div className="plan-meters">
            {(Object.keys(LIMIT_LABEL) as (keyof typeof LIMIT_LABEL)[]).map((k) => {
              const max = plan.limits[k];
              const used = plan.usage[k];
              return (
                <div key={k}>
                  <span className="small">{LIMIT_LABEL[k]}</span>
                  <b>{used}<span className="muted"> / {max ?? '∞'}</span></b>
                  {max !== null && <Meter value={used} max={max} label={LIMIT_LABEL[k]} />}
                </div>
              );
            })}
          </div>
          <p className="muted small" style={{ margin: 0 }}>Approvals, undo, masking, alerts and auto-pause are on every plan.</p>
        </div>
      </Panel>

      <Panel flush title="What each plan includes">
        <div className="tbl-wrap">
          <table className="tbl plan-cmp">
            <thead><tr><th></th>{ORDER.map((p) => <th key={p} className={p === plan.plan ? 'cur' : ''}>{PLAN_DEFS[p].name}{p === plan.plan ? ' (yours)' : ''}</th>)}</tr></thead>
            <tbody>
              {(Object.keys(LIMIT_LABEL) as (keyof typeof LIMIT_LABEL)[]).map((k) => (
                <tr key={k}><td>{LIMIT_LABEL[k]}</td>{ORDER.map((p) => <td key={p} className={p === plan.plan ? 'cur' : ''}>{Number.isFinite(PLAN_DEFS[p].limits[k]) ? PLAN_DEFS[p].limits[k] : 'Unlimited'}</td>)}</tr>
              ))}
              {ALL_FEATURES.map((f) => (
                <tr key={f}><td>{FEATURE_LABEL[f]}</td>{ORDER.map((p) => <td key={p} className={p === plan.plan ? 'cur' : ''}>{PLAN_DEFS[p].features.includes(f) ? <Check size={15} className="ok" /> : <Lock size={13} className="muted" />}</td>)}</tr>
              ))}
              <tr className="plan-cta"><td></td>{ORDER.map((p) => (
                <td key={p} className={p === plan.plan ? 'cur' : ''}>
                  {p === plan.plan ? <span className="muted small">Current</span>
                    : ORDER.indexOf(p) > ORDER.indexOf(plan.plan) ? (admin ? <button className={p === 'pro' ? 'primary sm' : 'sm'} onClick={() => void ask(p)} disabled={(asked ?? plan.requestedPlan) === p}>{p === 'promax' ? 'Talk to sales' : `Ask for ${PLAN_DEFS[p].name}`}</button> : <span className="muted small">Ask an admin</span>)
                    : null}
                </td>
              ))}</tr>
            </tbody>
          </table>
        </div>
        <p className="muted small" style={{ padding: '0 16px 14px', margin: 0 }}>Online payment is coming soon; for now we set up your plan with you after a request.</p>
      </Panel>

      {me.platformAdmin && <PlatformAdmin />}
    </div>
  );
}
