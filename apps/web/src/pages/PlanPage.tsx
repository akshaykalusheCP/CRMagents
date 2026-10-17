import { Check, Lock } from 'lucide-react';
import { useEffect, useState } from 'react';
import { FEATURE_LABEL, PLAN_DEFS, type Feature } from '@crmagents/shared';
import { api, type BillingStatus, type Me, type PlanId } from '../api';
import { usePlan } from '../components/Plan';
import { Meter, Panel, Status, toast } from '../components/ui';

// Settings → Plan: what this workspace is on, what it uses against its limits, what each plan adds, and asking for
// an upgrade. CRMagents staff (platform admins) also see every workspace and set its plan here.

const ORDER: PlanId[] = ['basic', 'plus', 'pro', 'promax'];
const ALL_FEATURES = Object.keys(FEATURE_LABEL) as Feature[];
const LIMIT_LABEL = { orgs: 'Salesforce orgs', users: 'People (incl. invitations)', liveAgents: 'Live agents', assistants: 'Assistants' } as const;

const money = (cents: number | null, cur: string | null) => (cents == null ? '' : `${(cur ?? 'usd').toUpperCase() === 'USD' ? '$' : `${(cur ?? '').toUpperCase()} `}${(cents / 100).toFixed(cents % 100 ? 2 : 0)}`);

export function PlanPage({ me, openAdmin }: { me: Me; openAdmin?: () => void }) {
  const { plan, reload } = usePlan();
  const [asked, setAsked] = useState<PlanId | null>(null);
  const [billing, setBilling] = useState<BillingStatus | null>(null);
  const [yearly, setYearly] = useState(false);
  const [paying, setPaying] = useState(false);
  useEffect(() => {
    reload();
    api.billing().then(setBilling).catch(() => setBilling(null));
    // Back from Stripe Checkout.
    const q = new URLSearchParams(location.search);
    const b = q.get('billing');
    if (b) {
      toast(b === 'success' ? 'Payment received: your plan updates in a moment' : 'Checkout cancelled: nothing was charged', b === 'success' ? 'ok' : 'info');
      q.delete('billing'); history.replaceState(null, '', `${location.pathname}${q.toString() ? `?${q}` : ''}`);
      if (b === 'success') setTimeout(() => { reload(); api.billing().then(setBilling).catch(() => {}); }, 2500);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const checkout = async (p: 'plus' | 'pro') => {
    setPaying(true);
    try { const r = await api.checkout(p, yearly ? 'year' : 'month'); window.location.href = r.url; } catch (e) { toast((e as Error).message, 'bad'); setPaying(false); }
  };
  const portal = async () => {
    try { const r = await api.billingPortal(); window.location.href = r.url; } catch (e) { toast((e as Error).message, 'bad'); }
  };
  const online = !!billing?.configured;
  const sub = billing?.subscription;
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

      {sub && (
        <Panel title="Subscription" action={admin && online ? <button className="sm" onClick={() => void portal()}>Manage billing</button> : undefined}>
          <div className="plan-sub">
            <div><small>Plan</small><b>{sub.plan ? PLAN_DEFS[sub.plan].name : '–'}{sub.interval ? `, ${sub.interval === 'year' ? 'yearly' : 'monthly'}` : ''}</b></div>
            <div><small>Price</small><b>{money(sub.amountCents, sub.currency)}{sub.interval ? ` / ${sub.interval}` : ''}</b></div>
            <div><small>Status</small><b><Status tone={sub.status === 'active' || sub.status === 'trialing' ? 'ok' : sub.status === 'past_due' ? 'warn' : 'bad'}>{sub.status.replace('_', ' ')}</Status></b></div>
            <div><small>{sub.cancelAtPeriodEnd ? 'Ends on' : 'Renews on'}</small><b>{sub.renewsAt ? new Date(sub.renewsAt).toLocaleDateString() : '–'}</b></div>
            <div><small>Bought by</small><b>{sub.purchasedBy ?? '–'}</b></div>
          </div>
        </Panel>
      )}

      <Panel flush title="What each plan includes" action={online ? (
        <div className="seg" role="radiogroup" aria-label="Billing period">
          <button role="radio" aria-checked={!yearly} className={!yearly ? 'on' : ''} onClick={() => setYearly(false)}>Monthly</button>
          <button role="radio" aria-checked={yearly} className={yearly ? 'on' : ''} onClick={() => setYearly(true)}>Yearly · 2 months free</button>
        </div>) : undefined}>
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
                    : ORDER.indexOf(p) > ORDER.indexOf(plan.plan) ? (!admin ? <span className="muted small">Ask an admin</span>
                      : p === 'promax' ? <a className="btn sm" href="/contact?topic=sales">Talk to sales</a>
                      : online && !sub ? <button className={p === 'pro' ? 'primary sm' : 'sm'} onClick={() => void checkout(p as 'plus' | 'pro')} disabled={paying}>Upgrade to {PLAN_DEFS[p].name}</button>
                      : online && sub ? <button className="sm" onClick={() => void portal()}>Change in billing</button>
                      : <button className={p === 'pro' ? 'primary sm' : 'sm'} onClick={() => void ask(p)} disabled={(asked ?? plan.requestedPlan) === p}>Ask for {PLAN_DEFS[p].name}</button>)
                    : null}
                </td>
              ))}</tr>
            </tbody>
          </table>
        </div>
        <p className="muted small" style={{ padding: '0 16px 14px', margin: 0 }}>{online ? 'Payments are handled securely by Stripe. Prices per workspace, before tax.' : 'Online payment is coming soon; for now we set up your plan with you after a request.'}</p>
      </Panel>

      {me.platformAdmin && openAdmin && <p className="muted small">You're CRMagents staff: <button className="link-btn" onClick={openAdmin}>open Super admin</button> to manage every workspace.</p>}
    </div>
  );
}
