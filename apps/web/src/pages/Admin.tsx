import { ExternalLink, Search } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { PLAN_DEFS } from '@crmagents/shared';
import { api, type AdminAccount, type AdminAccountDetail, type AdminOverview, type AdminPayment, type AdminRequest, type AdminUser, type PlanId } from '../api';
import { Drawer, Facts, PageHeader, Panel, SkeletonRows, Status, Table, Trend, toast, type Tone } from '../components/ui';

// Super admin (CRMagents staff only): every workspace, who signed up, which plan, the subscription and who bought
// it, payments, people, orgs, usage and requests. Plan changes and trial extensions are recorded with who did them.

type View = 'overview' | 'workspaces' | 'users' | 'payments' | 'requests';
const PLANS: PlanId[] = ['basic', 'plus', 'pro', 'promax'];
const day = (d: string | null) => (d ? new Date(d).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' }) : '–');
const ago = (d: string | null) => {
  if (!d) return 'never';
  const m = (Date.now() - new Date(d).getTime()) / 60_000;
  return m < 60 ? `${Math.max(1, Math.round(m))} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
};
const usd = (cents: number | null, cur?: string | null) => (cents == null ? '–' : `${!cur || cur.toLowerCase() === 'usd' ? '$' : `${cur.toUpperCase()} `}${(cents / 100).toLocaleString(undefined, { maximumFractionDigits: 2 })}`);
const trialLeft = (d: string | null) => (d ? Math.ceil((new Date(d).getTime() - Date.now()) / 86_400_000) : null);
const subTone = (s: string | null): Tone => (!s ? 'neutral' : s === 'active' || s === 'trialing' ? 'ok' : s === 'past_due' ? 'warn' : 'bad');
const PAY_LABEL: Record<string, string> = { payment_succeeded: 'Payment', payment_failed: 'Payment failed', subscription_started: 'Subscribed', subscription_changed: 'Subscription changed', subscription_canceled: 'Cancelled', refund: 'Refund' };

function PlanCell({ a }: { a: { plan: PlanId; trialEndsAt: string | null } }) {
  const left = a.plan === 'basic' ? trialLeft(a.trialEndsAt) : null;
  return <span className="adm-plan"><b>{PLAN_DEFS[a.plan].name}</b>{left !== null && <Status tone={left <= 0 ? 'bad' : left <= 3 ? 'warn' : 'info'}>{left <= 0 ? 'trial ended' : `trial ${left}d left`}</Status>}</span>;
}

function WorkspaceDrawer({ id, onClose, onChanged }: { id: string | null; onClose: () => void; onChanged: () => void }) {
  const [d, setD] = useState<AdminAccountDetail | null>(null);
  const [plan, setPlan] = useState<PlanId>('basic');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const load = () => { if (id) api.adminAccount(id).then((x) => { setD(x); setPlan(x.account.plan); }).catch((e) => toast((e as Error).message, 'bad')); };
  useEffect(() => { setD(null); setReason(''); load(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = async () => {
    if (!d || plan === d.account.plan) return;
    if (!window.confirm(`Move "${d.account.name}" from ${PLAN_DEFS[d.account.plan].name} to ${PLAN_DEFS[plan].name}?${plan === 'basic' ? ' This starts a new 14-day trial.' : ''}${d.subscription?.status === 'active' ? ' They have an active Stripe subscription: change it in Stripe too.' : ''}`)) return;
    setBusy(true);
    try { await api.adminSetPlan(d.account.id, plan, reason); toast('Plan changed'); setReason(''); load(); onChanged(); } catch (e) { toast((e as Error).message, 'bad'); }
    setBusy(false);
  };
  const extend = async (days: number) => {
    if (!d) return;
    try { await api.adminExtendTrial(d.account.id, days); toast(`Trial extended by ${days} days`); load(); onChanged(); } catch (e) { toast((e as Error).message, 'bad'); }
  };
  return (
    <Drawer open={!!id} onClose={onClose} title={d?.account.name ?? 'Workspace'} sub={d && <><PlanCell a={d.account} /><span>since {day(d.account.createdAt)}</span></>}>
      {!d ? <SkeletonRows rows={6} cols={2} /> : <>
        <div className="dsec">
          <h3>Plan</h3>
          <div className="adm-actions">
            <select value={plan} onChange={(e) => setPlan(e.target.value as PlanId)} aria-label="Plan">{PLANS.map((p) => <option key={p} value={p}>{PLAN_DEFS[p].name}</option>)}</select>
            <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (e.g. paid by invoice #123)" aria-label="Reason" />
            <button className="primary sm" onClick={() => void save()} disabled={busy || plan === d.account.plan}>Change plan</button>
          </div>
          {d.account.plan === 'basic' && <div className="row" style={{ gap: 8, marginTop: 8 }}><span className="muted small">Extend trial:</span><button className="sm" onClick={() => void extend(7)}>+7 days</button><button className="sm" onClick={() => void extend(14)}>+14 days</button></div>}
          {d.account.requestedPlan && <p className="small" style={{ margin: '8px 0 0' }}><Status tone="warn">Asked for {PLAN_DEFS[d.account.requestedPlan].name}</Status></p>}
          <Facts items={[
            ['Usage', `${d.plan.usage.orgs} orgs · ${d.plan.usage.users} people · ${d.plan.usage.liveAgents} live agents · ${d.plan.usage.assistants} assistants`],
            ['AI, last 30 days', `${Number(d.usage30.runs ?? 0).toLocaleString()} runs · $${Number(d.usage30.cost ?? 0).toFixed(2)}`],
            ['Plan set by', d.account.planSetBy ?? '–'],
          ]} />
        </div>
        <div className="dsec">
          <h3>Subscription</h3>
          {d.subscription?.status ? <Facts items={[
            ['Plan', `${d.subscription.plan ? PLAN_DEFS[d.subscription.plan].name : '–'}${d.subscription.interval ? `, ${d.subscription.interval === 'year' ? 'yearly' : 'monthly'}` : ''}`],
            ['Price', `${usd(d.subscription.amountCents, d.subscription.currency)}${d.subscription.interval ? ` / ${d.subscription.interval}` : ''}`],
            ['Status', <Status key="s" tone={subTone(d.subscription.status)}>{d.subscription.status.replace('_', ' ')}{d.subscription.cancelAtPeriodEnd ? ', cancels at period end' : ''}</Status>],
            ['Bought by', d.subscription.purchasedBy ?? '–'],
            ['Started', day(d.subscription.startedAt)],
            [d.subscription.cancelAtPeriodEnd ? 'Ends' : 'Renews', day(d.subscription.renewsAt)],
            ['Stripe customer', d.subscription.customerId ?? '–'],
          ]} /> : <p className="muted small" style={{ margin: 0 }}>No paid subscription.</p>}
        </div>
        <div className="dsec">
          <h3>People ({d.members.length}{d.invites.length ? ` + ${d.invites.length} invited` : ''})</h3>
          <ul className="adm-list">
            {d.members.map((m) => <li key={m.email}><b>{m.email}</b><span>{m.role} · last sign-in {ago(m.lastLoginAt)} · joined {day(m.createdAt)}</span></li>)}
            {d.invites.map((m) => <li key={m.email}><b>{m.email}</b><span>invited as {m.role} by {m.invitedBy ?? '–'} · expires {day(m.expiresAt)}</span></li>)}
          </ul>
        </div>
        <div className="dsec">
          <h3>Salesforce orgs ({d.orgs.length})</h3>
          <ul className="adm-list">{d.orgs.map((o, i) => <li key={i}><b>{o.username ?? o.url}</b><span>{o.url} · {o.status}{o.usePackage ? ' · package' : ''} · connected {day(o.connectedAt)}</span></li>)}{!d.orgs.length && <li className="muted small">None connected.</li>}</ul>
        </div>
        <div className="dsec">
          <h3>Payments</h3>
          <ul className="adm-list">{d.payments.map((p, i) => <li key={i}><b>{PAY_LABEL[p.type] ?? p.type} {p.amountCents != null ? `· ${usd(p.amountCents, p.currency)}` : ''}</b><span>{day(p.createdAt)}{p.plan ? ` · ${p.plan}` : ''}{p.detail ? ` · ${p.detail}` : ''}{p.invoiceUrl && <> · <a href={p.invoiceUrl} target="_blank" rel="noreferrer">invoice</a></>}</span></li>)}{!d.payments.length && <li className="muted small">No payments yet.</li>}</ul>
        </div>
        <div className="dsec">
          <h3>Plan history</h3>
          <ul className="adm-list">{d.planHistory.map((h, i) => <li key={i}><b>{h.from ? `${PLAN_DEFS[h.from as PlanId]?.name ?? h.from} → ` : ''}{PLAN_DEFS[h.to as PlanId]?.name ?? h.to}</b><span>{day(h.createdAt)} · {h.by}{h.reason ? ` · ${h.reason}` : ''}</span></li>)}{!d.planHistory.length && <li className="muted small">No changes recorded.</li>}</ul>
        </div>
        {d.requests.length > 0 && <div className="dsec"><h3>Requests</h3><ul className="adm-list">{d.requests.map((r) => <li key={r.id}><b>{r.topic} · {r.status}</b><span>{day(r.createdAt)} · {r.message}</span></li>)}</ul></div>}
        <div className="dsec">
          <h3>Recent activity</h3>
          <ul className="adm-list">{d.activity.map((a, i) => <li key={i}><b>{a.action}{a.target ? ` · ${a.target}` : ''}</b><span>{a.user ?? 'system'} · {ago(a.createdAt)}</span></li>)}</ul>
        </div>
      </>}
    </Drawer>
  );
}

export function AdminPage() {
  const [view, setView] = useState<View>('overview');
  const [ov, setOv] = useState<AdminOverview>();
  const [accounts, setAccounts] = useState<AdminAccount[]>();
  const [users, setUsers] = useState<AdminUser[]>();
  const [payments, setPayments] = useState<AdminPayment[]>();
  const [requests, setRequests] = useState<AdminRequest[]>();
  const [open, setOpen] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [planFilter, setPlanFilter] = useState<'' | PlanId | 'paying' | 'trial'>('');

  const loadAll = () => {
    api.adminOverview().then(setOv).catch((e) => toast((e as Error).message, 'bad'));
    api.adminAccounts().then(setAccounts).catch(() => setAccounts([]));
    api.adminRequests().then(setRequests).catch(() => setRequests([]));
  };
  useEffect(loadAll, []);
  useEffect(() => {
    if (view === 'users' && !users) api.adminUsers().then(setUsers).catch(() => setUsers([]));
    if (view === 'payments' && !payments) api.adminPayments().then(setPayments).catch(() => setPayments([]));
  }, [view]); // eslint-disable-line react-hooks/exhaustive-deps

  const needle = q.trim().toLowerCase();
  const shownAccounts = useMemo(() => (accounts ?? []).filter((a) =>
    (!needle || [a.name, a.owner, a.purchasedBy].some((x) => x?.toLowerCase().includes(needle)))
    && (!planFilter || (planFilter === 'paying' ? !!a.subStatus && ['active', 'trialing', 'past_due'].includes(a.subStatus) : planFilter === 'trial' ? a.plan === 'basic' : a.plan === planFilter))), [accounts, needle, planFilter]);
  const shownUsers = useMemo(() => (users ?? []).filter((u) => !needle || u.email.toLowerCase().includes(needle) || u.accountName.toLowerCase().includes(needle)), [users, needle]);
  const openRequests = (requests ?? []).filter((r) => r.status === 'new').length;

  const updateRequest = async (r: AdminRequest, status: string, notes?: string) => {
    try { await api.adminUpdateRequest(r.id, status, notes); setRequests((rs) => rs?.map((x) => (x.id === r.id ? { ...x, status, notes: notes ?? x.notes } : x))); toast('Saved'); } catch (e) { toast((e as Error).message, 'bad'); }
  };

  return (
    <div className="pg">
      <PageHeader title="Super admin" description="Every workspace, plan, subscription and request. Only CRMagents staff can see this page." />
      <div className="ptabs adm-tabs" role="tablist">
        {(['overview', 'workspaces', 'users', 'payments', 'requests'] as View[]).map((v) => (
          <button key={v} role="tab" aria-selected={view === v} className={view === v ? 'on' : ''} onClick={() => setView(v)}>
            {v[0].toUpperCase() + v.slice(1)}{v === 'requests' && openRequests > 0 && <span className="count">{openRequests}</span>}{v === 'workspaces' && accounts ? <span className="muted"> · {accounts.length}</span> : null}
          </button>
        ))}
      </div>

      {(view === 'workspaces' || view === 'users') && (
        <div className="adm-filters">
          <div className="adm-search"><Search size={15} /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder={view === 'users' ? 'Search people or workspaces' : 'Search workspace, owner or buyer'} aria-label="Search" /></div>
          {view === 'workspaces' && (
            <select value={planFilter} onChange={(e) => setPlanFilter(e.target.value as typeof planFilter)} aria-label="Filter">
              <option value="">All plans</option><option value="paying">Paying</option><option value="trial">On trial (Basic)</option>
              {PLANS.map((p) => <option key={p} value={p}>{PLAN_DEFS[p].name}</option>)}
            </select>
          )}
        </div>
      )}

      {view === 'overview' && (!ov ? <Panel><SkeletonRows rows={4} cols={4} /></Panel> : <>
        {!ov.billingConfigured && <div className="banner warn"><div><b>Online payment is off</b><span>Add the Stripe keys and price ids (STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, STRIPE_PRICE_PLUS_MONTHLY …) to turn on checkout. Until then, change plans here after a request.</span></div></div>}
        <div className="adm-kpis">
          <div><small>Workspaces</small><b>{ov.signups.total}</b><span>+{ov.signups.d7} this week · +{ov.signups.d30} in 30 days</span></div>
          <div><small>Monthly recurring revenue</small><b>${Math.round(ov.mrr).toLocaleString()}</b><span>{ov.subscriptions} paying subscription{ov.subscriptions === 1 ? '' : 's'}{ov.paymentIssues ? ` · ${ov.paymentIssues} with payment issues` : ''}</span></div>
          <div><small>Trials</small><b>{ov.trials.active}</b><span>{ov.trials.ending} ending in 3 days · {ov.trials.ended} ended</span></div>
          <div><small>People</small><b>{ov.users.total}</b><span>{ov.users.active7} signed in this week</span></div>
          <div><small>AI usage, 30 days</small><b>${Number(ov.ai.cost30 ?? 0).toFixed(2)}</b><span>{ov.ai.runs30.toLocaleString()} runs</span></div>
          <div className={ov.openRequests ? 'hot' : ''}><small>Open requests</small><b>{ov.openRequests}</b><span><button className="link-btn" onClick={() => setView('requests')}>Review requests</button></span></div>
        </div>
        <div className="adm-grid">
          <Panel title="Workspaces by plan">
            <ul className="adm-bars">
              {PLANS.map((p) => {
                const n = ov.plans[p] ?? 0;
                return <li key={p}><span>{PLAN_DEFS[p].name}</span><i style={{ width: `${ov.signups.total ? (n / ov.signups.total) * 100 : 0}%` }} /><b>{n}</b></li>;
              })}
            </ul>
          </Panel>
          <Panel title="Sign-ups, last 30 days">
            <Trend points={ov.series.map((s) => ({ label: s.day.slice(5), value: s.signups }))} format={(v) => `${v} sign-up${v === 1 ? '' : 's'}`} height={160} />
          </Panel>
        </div>
      </>)}

      {view === 'workspaces' && (
        <Panel flush>
          {!accounts ? <SkeletonRows rows={6} cols={6} /> : (
            <Table rows={shownAccounts} rowKey={(a) => a.id} onRowClick={(a) => setOpen(a.id)} selected={open ?? undefined}
              empty={<p className="muted small" style={{ padding: 16, margin: 0 }}>No workspaces match.</p>}
              columns={[
                { key: 'name', header: 'Workspace', render: (a) => <span className="adm-ws"><b>{a.name}</b><span>{a.owner ?? '–'}</span></span> },
                { key: 'plan', header: 'Plan', width: '170px', render: (a) => <span className="adm-ws"><PlanCell a={a} />{a.requestedPlan && <span className="adm-ask">asked for {PLAN_DEFS[a.requestedPlan].name}</span>}</span> },
                { key: 'sub', header: 'Subscription', width: '170px', hideSm: true, render: (a) => (a.subStatus ? <span className="adm-ws"><Status tone={subTone(a.subStatus)}>{a.subStatus.replace('_', ' ')}</Status><span>{usd(a.subAmountCents)}{a.subInterval ? ` / ${a.subInterval}` : ''}{a.renewsAt ? ` · ${a.cancelAtPeriodEnd ? 'ends' : 'renews'} ${day(a.renewsAt)}` : ''}</span></span> : <span className="muted">–</span>) },
                { key: 'buyer', header: 'Bought by', width: '170px', hideSm: true, render: (a) => <span className="muted small">{a.purchasedBy ?? '–'}</span> },
                { key: 'use', header: 'Orgs · people · live', width: '130px', hideSm: true, render: (a) => `${a.orgs} · ${a.users} · ${a.liveAgents}` },
                { key: 'ai', header: 'AI 30d', width: '80px', align: 'right', hideSm: true, render: (a) => `$${Number(a.aiCost30 ?? 0).toFixed(2)}` },
                { key: 'seen', header: 'Last active', width: '110px', align: 'right', render: (a) => <span className="muted small">{ago(a.lastActive)}</span> },
              ]} />
          )}
        </Panel>
      )}

      {view === 'users' && (
        <Panel flush>
          {!users ? <SkeletonRows rows={6} cols={5} /> : (
            <Table rows={shownUsers} rowKey={(u) => u.id} onRowClick={(u) => setOpen(u.accountId)}
              empty={<p className="muted small" style={{ padding: 16, margin: 0 }}>Nobody matches.</p>}
              columns={[
                { key: 'email', header: 'Person', render: (u) => <b>{u.email}</b> },
                { key: 'ws', header: 'Workspace', render: (u) => u.accountName },
                { key: 'role', header: 'Role', width: '100px', render: (u) => u.role },
                { key: 'plan', header: 'Plan', width: '100px', hideSm: true, render: (u) => PLAN_DEFS[u.plan].name },
                { key: 'seen', header: 'Last sign-in', width: '120px', render: (u) => <span className="muted small">{ago(u.lastLoginAt)}</span> },
                { key: 'joined', header: 'Joined', width: '120px', hideSm: true, render: (u) => <span className="muted small">{day(u.createdAt)}</span> },
              ]} />
          )}
        </Panel>
      )}

      {view === 'payments' && (
        <Panel flush>
          {!payments ? <SkeletonRows rows={6} cols={5} /> : (
            <Table rows={payments} rowKey={(p) => String(p.id)} onRowClick={(p) => p.accountId && setOpen(p.accountId)}
              empty={<p className="muted small" style={{ padding: 16, margin: 0 }}>No payments yet. They appear here once Stripe is connected.</p>}
              columns={[
                { key: 'when', header: 'When', width: '130px', render: (p) => <span className="muted small">{day(p.createdAt)}</span> },
                { key: 'ws', header: 'Workspace', render: (p) => p.accountName ?? '–' },
                { key: 'type', header: 'What', render: (p) => <Status tone={p.type === 'payment_failed' || p.type === 'subscription_canceled' ? 'bad' : p.type === 'refund' ? 'warn' : 'ok'}>{PAY_LABEL[p.type] ?? p.type}</Status> },
                { key: 'plan', header: 'Plan', width: '90px', hideSm: true, render: (p) => p.plan ?? '–' },
                { key: 'amt', header: 'Amount', width: '110px', align: 'right', render: (p) => usd(p.amountCents, p.currency) },
                { key: 'inv', header: '', width: '80px', align: 'right', render: (p) => (p.invoiceUrl ? <a href={p.invoiceUrl} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>Invoice <ExternalLink size={12} /></a> : null) },
              ]} />
          )}
        </Panel>
      )}

      {view === 'requests' && (
        !requests ? <Panel><SkeletonRows rows={4} cols={3} /></Panel> : requests.length === 0 ? <Panel><p className="muted small" style={{ margin: 0 }}>No requests yet: they come from the Contact page, Pro Max "Contact sales" and in-app upgrade asks.</p></Panel> : (
          <ul className="adm-reqs">
            {requests.map((r) => (
              <li key={r.id} className={r.status === 'new' ? 'new' : ''}>
                <div className="adm-req-head">
                  <span><b>{r.name}</b> · <a href={`mailto:${r.email}`}>{r.email}</a>{r.company ? ` · ${r.company}` : ''}{r.size ? ` · ${r.size} users` : ''}</span>
                  <span className="muted small">{day(r.createdAt)}</span>
                </div>
                <div className="adm-req-tags"><Status tone="info">{r.topic}</Status><span className="muted small">from {r.source === 'contact' ? 'the Contact page' : r.source === 'upgrade' ? 'an in-app upgrade request' : 'the pricing page'}</span>
                  {r.accountId && <button className="link-btn small" onClick={() => setOpen(r.accountId)}>{r.accountName ?? 'workspace'}</button>}</div>
                {r.message && <p className="adm-req-msg">{r.message}</p>}
                <div className="adm-req-actions">
                  <select value={r.status} onChange={(e) => void updateRequest(r, e.target.value)} aria-label="Status">
                    {['new', 'contacted', 'won', 'lost', 'closed'].map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                  <input defaultValue={r.notes ?? ''} placeholder="Notes (only staff see these)" onBlur={(e) => { if (e.target.value !== (r.notes ?? '')) void updateRequest(r, r.status, e.target.value); }} aria-label="Notes" />
                  {r.handledBy && <span className="muted small">by {r.handledBy}</span>}
                </div>
              </li>
            ))}
          </ul>
        )
      )}

      <WorkspaceDrawer id={open} onClose={() => setOpen(null)} onChanged={loadAll} />
    </div>
  );
}
