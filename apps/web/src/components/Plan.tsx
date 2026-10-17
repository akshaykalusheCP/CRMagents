import { ArrowUpCircle, Lock } from 'lucide-react';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { FEATURE_LABEL, PLAN_DEFS, planFor, type Feature } from '@crmagents/shared';
import { api, type Me, type PlanId, type PlanSummary } from '../api';
import { toast } from './ui';

// The workspace's plan in the app: what's included (locked pages show what to upgrade to), the trial banner and
// the upgrade prompt that opens when an action isn't part of the plan. The server is what enforces all of it.

interface PlanCtx { plan: PlanSummary | null; has: (f: Feature) => boolean; reload: () => void; openPlans: () => void }
const Ctx = createContext<PlanCtx>({ plan: null, has: () => true, reload: () => {}, openPlans: () => {} });
export const usePlan = () => useContext(Ctx);

/** The plan, loaded once signed in; App holds it so it can lock pages itself. */
export function usePlanState(signedIn: boolean) {
  const [plan, setPlan] = useState<PlanSummary | null>(null);
  const reload = () => { api.plan().then(setPlan).catch(() => setPlan(null)); };
  useEffect(() => { if (signedIn) reload(); }, [signedIn]);
  // Until the plan is known, nothing is shown as locked (the server decides anyway).
  const has = (f: Feature) => !plan || (!plan.trialEnded && plan.features.includes(f));
  return { plan, has, reload };
}

export function PlanProvider({ children, value }: { children: ReactNode; value: PlanCtx }) {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** A small tag for things a higher plan unlocks. */
export function PlanTag({ feature }: { feature: Feature }) {
  const { has } = usePlan();
  if (has(feature)) return null;
  return <span className="plan-tag" title={`Part of ${PLAN_DEFS[planFor(feature)].name}`}>{PLAN_DEFS[planFor(feature)].name}</span>;
}

/** Shown instead of a page the plan doesn't include. */
export function LockedPage({ feature, title }: { feature: Feature; title: string }) {
  const { openPlans, plan } = usePlan();
  const up = planFor(feature);
  return (
    <div className="pg">
      <div className="locked">
        <span className="locked-ico"><Lock size={18} /></span>
        <h2>{title} {plan?.trialEnded ? 'is paused' : `is part of ${PLAN_DEFS[up].name}`}</h2>
        <p>{plan?.trialEnded ? 'Your free trial has ended. Choose a plan to pick up where you left off; nothing has been deleted.' : `${FEATURE_LABEL[feature]} come with the ${PLAN_DEFS[up].name} plan and above.`.replace(' come with', /s$| and /.test(FEATURE_LABEL[feature]) ? ' come with' : ' comes with')}</p>
        <button className="primary" onClick={openPlans}>See plans</button>
      </div>
    </div>
  );
}

/** Days left in the trial, or that it ended. */
export function TrialBanner() {
  const { plan, openPlans } = usePlan();
  if (!plan || plan.plan !== 'basic' || !plan.trialEndsAt) return null;
  const days = Math.max(0, Math.ceil((new Date(plan.trialEndsAt).getTime() - Date.now()) / 86_400_000));
  return (
    <div className={'trial-bar' + (plan.trialEnded ? ' ended' : '')} role="status">
      <span>{plan.trialEnded ? 'Your free trial has ended: agents are paused, nothing is deleted.' : `Free trial: ${days} day${days === 1 ? '' : 's'} left.`}</span>
      <button className="link-btn" onClick={openPlans}>{plan.trialEnded ? 'Choose a plan' : 'See plans'}</button>
    </div>
  );
}

/** Opens when an action isn't part of the plan (the server answered 402). */
export function UpgradePrompt({ me }: { me: Me }) {
  const { openPlans, plan } = usePlan();
  const [d, setD] = useState<{ message: string; upgrade?: PlanId } | null>(null);
  const [sent, setSent] = useState(false);
  useEffect(() => {
    const on = (e: Event) => { const x = (e as CustomEvent).detail ?? {}; setSent(false); setD({ message: x.message ?? 'This is part of a higher plan.', upgrade: x.plan?.upgrade }); };
    window.addEventListener('crmagents:upgrade', on);
    return () => window.removeEventListener('crmagents:upgrade', on);
  }, []);
  if (!d) return null;
  const admin = ['owner', 'admin'].includes(me.role);
  const target = d.upgrade && d.upgrade !== plan?.plan ? d.upgrade : null;
  const request = async () => {
    if (!target) return;
    try { await api.requestUpgrade(target); setSent(true); } catch (e) { toast((e as Error).message, 'bad'); }
  };
  return (
    <div className="modal" onClick={() => setD(null)}>
      <div className="confirm-card upgrade-card" role="alertdialog" aria-labelledby="up-title" onClick={(e) => e.stopPropagation()}>
        <span className="locked-ico"><ArrowUpCircle size={16} /></span>
        <h2 id="up-title">{target ? `Upgrade to ${PLAN_DEFS[target].name}` : 'Not on your plan'}</h2>
        <div className="confirm-body">{sent ? `Thanks: we'll be in touch to move ${me.accountName} to ${target ? PLAN_DEFS[target].name : 'a new plan'}.` : d.message}</div>
        <div className="confirm-actions">
          <button onClick={() => { setD(null); openPlans(); }}>See plans</button>
          {!sent && target && (admin ? <button className="primary" onClick={() => void request()}>Ask for {PLAN_DEFS[target].name}</button> : <span className="muted small">Ask a workspace admin to upgrade.</span>)}
          {sent && <button className="primary" onClick={() => setD(null)}>Done</button>}
        </div>
      </div>
    </div>
  );
}
