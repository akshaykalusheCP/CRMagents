import { AlertTriangle, ArrowLeft, ArrowUpDown, Building2, ChevronDown, ChevronUp, CreditCard, Download, ExternalLink, Inbox, LayoutDashboard, LineChart, MoreHorizontal, RefreshCw, ScrollText, Search, Settings2, Trash2, Users, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { PLAN_DEFS } from '@crmagents/shared';
import { api, type AdminAccount, type AdminAccountDetail, type AdminOverview, type AdminRequest, type AdminRevenue, type AdminUser, type Health, type Me, type PlanId, type Stage, type StaffLogItem } from '../api';
import { LogoMark } from '../components/Logo';
import { Meter, SkeletonRows, Status, Toaster, Trend, toast, type Tone } from '../components/ui';

// Staff console (CRMagents staff only): a back office for tracking every client. Its own layout, dense tables,
// and "who needs attention today" first. The server answers "Not found" to anyone else.

type View = 'overview' | 'workspaces' | 'users' | 'revenue' | 'requests' | 'log' | 'settings';
const PLANS: PlanId[] = ['basic', 'plus', 'pro', 'promax'];
const STAGE: Record<Stage, { label: string; tone: Tone }> = {
  trial: { label: 'Trial', tone: 'info' }, expired: { label: 'Trial ended', tone: 'neutral' }, paying: { label: 'Paying', tone: 'ok' },
  past_due: { label: 'Past due', tone: 'warn' }, churned: { label: 'Churned', tone: 'bad' }, comped: { label: 'Set by staff', tone: 'neutral' },
};
const HEALTH: Record<Health, { label: string; cls: string }> = { active: { label: 'Active', cls: 'ok' }, quiet: { label: 'Quiet', cls: 'warn' }, at_risk: { label: 'At risk', cls: 'bad' } };
const REQ_COLS = ['new', 'contacted', 'won', 'lost', 'closed'] as const;
const day = (d: string | null | undefined) => (d ? new Date(d).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' }) : '–');
const ago = (d: string | null | undefined) => {
  if (!d) return 'never';
  const m = (Date.now() - new Date(d).getTime()) / 60_000;
  return m < 60 ? `${Math.max(1, Math.round(m))}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
};
const money = (n: number) => `$${n.toLocaleString(undefined, { maximumFractionDigits: n < 100 ? 2 : 0 })}`;
const cents = (c: number | null, cur?: string | null) => (c == null ? '–' : `${!cur || cur.toLowerCase() === 'usd' ? '$' : `${cur.toUpperCase()} `}${(c / 100).toLocaleString(undefined, { maximumFractionDigits: 2 })}`);
const trialLeft = (d: string | null) => (d ? Math.ceil((new Date(d).getTime() - Date.now()) / 86_400_000) : null);

function Change({ v, invert }: { v: number; invert?: boolean }) {
  if (!Number.isFinite(v) || v === 0) return <span className="sc-chg flat">no change</span>;
  const up = v > 0;
  return <span className={'sc-chg ' + ((up !== !!invert) ? 'up' : 'down')}>{up ? '▲' : '▼'} {Math.round(Math.abs(v) * 100)}%</span>;
}

function StagePill({ s }: { s: Stage }) { return <Status tone={STAGE[s].tone}>{STAGE[s].label}</Status>; }
function HealthDot({ h }: { h: Health }) { return <span className={'sc-health ' + HEALTH[h].cls}><i />{HEALTH[h].label}</span>; }

/** A small popover menu for a row. */
function RowMenu({ items }: { items: { label: string; run: () => void; hidden?: boolean }[] }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="sc-menu" onClick={(e) => e.stopPropagation()}>
      <button className="sc-icon" aria-label="Actions" onClick={() => setOpen((o) => !o)}><MoreHorizontal size={16} /></button>
      {open && <><div className="sc-scrim" onClick={() => setOpen(false)} /><div className="sc-pop">
        {items.filter((i) => !i.hidden).map((i) => <button key={i.label} onClick={() => { setOpen(false); i.run(); }}>{i.label}</button>)}
      </div></>}
    </span>
  );
}

type SortKey = 'name' | 'stage' | 'plan' | 'health' | 'mrr' | 'lastActive' | 'aiCost30' | 'createdAt';
function SortHead({ k, label, sort, setSort, align }: { k: SortKey; label: string; sort: [SortKey, 1 | -1]; setSort: (s: [SortKey, 1 | -1]) => void; align?: 'right' }) {
  const on = sort[0] === k;
  return (
    <th style={{ textAlign: align ?? 'left' }}>
      <button className={'sc-sort' + (on ? ' on' : '')} onClick={() => setSort([k, on ? (sort[1] === 1 ? -1 : 1) : (k === 'name' ? 1 : -1)])}>
        {label}{on ? (sort[1] === 1 ? <ChevronUp size={12} /> : <ChevronDown size={12} />) : <ArrowUpDown size={11} className="dim" />}
      </button>
    </th>
  );
}

// ---------- Overview ----------
function Overview({ ov, open, go }: { ov: AdminOverview; open: (id: string) => void; go: (v: View) => void }) {
  const k = ov.kpis;
  const groups: { title: string; items: AdminOverview['attention']['trialsEnding']; tone: 'bad' | 'warn' | 'info' }[] = [
    { title: 'Payment failed', items: ov.attention.paymentFailed, tone: 'bad' },
    { title: 'Paying, but at risk', items: ov.attention.churnRisk, tone: 'bad' },
    { title: 'Trials ending in 3 days', items: ov.attention.trialsEnding, tone: 'warn' },
    { title: 'Asked to upgrade', items: ov.attention.upgradeAsks, tone: 'info' },
    { title: 'Salesforce org disconnected', items: ov.attention.disconnected, tone: 'warn' },
  ];
  const attention = groups.filter((g) => g.items.length);
  const top = ov.funnel[0]?.n || 1;
  return (
    <>
      {!ov.billingConfigured && <div className="sc-note"><CreditCard size={15} /> Online payment is off: add the Stripe keys and prices to turn on checkout. Until then, set plans on a client's page.</div>}
      <div className="sc-kpis">
        <div><small>Workspaces</small><b>{k.workspaces.value}</b><span>{k.workspaces.sub} · <Change v={k.workspaces.change} /> sign-ups</span></div>
        <div><small>MRR</small><b>{money(k.mrr.value)}</b><span>{money(k.mrr.arr)} a year · {k.mrr.paying} paying{k.mrr.pastDue ? ` · ${k.mrr.pastDue} past due` : ''}</span></div>
        <div><small>Collected, 30 days</small><b>{money(k.revenue.value)}</b><span><Change v={k.revenue.change} /> vs previous 30</span></div>
        <div><small>On trial</small><b>{k.trials.value}</b><span>{k.trials.ending} ending soon · {k.trials.expired} ended</span></div>
        <div><small>People</small><b>{k.people.value}</b><span>{k.people.active7} signed in this week · <Change v={k.people.change} /></span></div>
        <div><small>AI usage, 30 days</small><b>{money(k.ai.value)}</b><span>{k.ai.runs.toLocaleString()} runs · <Change v={k.ai.change} /></span></div>
      </div>

      <div className="sc-cols">
        <section className="sc-card">
          <header><h2>Needs attention today</h2>{k.requests > 0 && <button className="sc-link" onClick={() => go('requests')}>{k.requests} open request{k.requests === 1 ? '' : 's'}</button>}</header>
          {attention.length === 0 ? <p className="sc-empty">Nothing needs attention. Every client is in good shape.</p> : attention.map((g) => (
            <div key={g.title} className="sc-att">
              <h3 className={g.tone}>{g.tone === 'bad' && <AlertTriangle size={13} />}{g.title}<span>{g.items.length}</span></h3>
              <ul>{g.items.slice(0, 6).map((a) => <li key={g.title + a.id}><button onClick={() => open(a.id)}><b>{a.name}</b><span>{a.owner ?? ''}</span><em>{a.why}</em></button></li>)}</ul>
            </div>
          ))}
        </section>
        <section className="sc-card">
          <header><h2>Activation funnel</h2><span className="sc-muted">all workspaces</span></header>
          <ul className="sc-funnel">
            {ov.funnel.map((f, i) => (
              <li key={f.step}>
                <span>{f.step}</span>
                <i style={{ width: `${Math.max(2, (f.n / top) * 100)}%` }} />
                <b>{f.n}</b>
                <em>{i === 0 ? '' : `${Math.round((f.n / Math.max(ov.funnel[i - 1].n, 1)) * 100)}% of previous`}</em>
              </li>
            ))}
          </ul>
          <header style={{ marginTop: 18 }}><h2>By stage</h2></header>
          <div className="sc-stagegrid">
            {(Object.keys(STAGE) as Stage[]).map((s) => <button key={s} onClick={() => go('workspaces')}><StagePill s={s} /><b>{ov.stages[s] ?? 0}</b></button>)}
          </div>
        </section>
      </div>
      <section className="sc-card">
        <header><h2>Sign-ups, last 30 days</h2><span className="sc-muted">{PLANS.map((p) => `${PLAN_DEFS[p].name} ${ov.plans[p] ?? 0}`).join(' · ')}</span></header>
        <Trend points={ov.series.map((s) => ({ label: s.day.slice(5), value: s.signups }))} format={(v) => `${v} sign-up${v === 1 ? '' : 's'}`} height={150} />
      </section>
    </>
  );
}

// ---------- Workspaces ----------
type Chip = 'all' | Stage | 'asked' | 'at_risk';
function Workspaces({ rows, open, reload }: { rows: AdminAccount[]; open: (id: string) => void; reload: () => void }) {
  const [chip, setChip] = useState<Chip>('all');
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<[SortKey, 1 | -1]>(['createdAt', -1]);
  const count = (c: Chip) => rows.filter((a) => match(a, c)).length;
  function match(a: AdminAccount, c: Chip) {
    return c === 'all' ? true : c === 'asked' ? !!a.requestedPlan : c === 'at_risk' ? a.health === 'at_risk' : a.stage === c;
  }
  const needle = q.trim().toLowerCase();
  const shown = useMemo(() => {
    const order: Record<string, number> = { trial: 0, expired: 1, paying: 2, past_due: 3, churned: 4, comped: 5, basic: 0, plus: 1, pro: 2, promax: 3, active: 0, quiet: 1, at_risk: 2 };
    const val = (a: AdminAccount): string | number => {
      switch (sort[0]) {
        case 'name': return a.name.toLowerCase();
        case 'stage': return order[a.stage];
        case 'plan': return order[a.plan];
        case 'health': return order[a.health];
        case 'mrr': return a.mrr;
        case 'aiCost30': return Number(a.aiCost30);
        case 'lastActive': return a.lastActive ? Date.parse(a.lastActive) : 0;
        default: return Date.parse(a.createdAt);
      }
    };
    return rows.filter((a) => match(a, chip) && (!needle || [a.name, a.owner, a.purchasedBy, a.staffOwner, ...(a.tags ?? [])].some((x) => x?.toLowerCase().includes(needle))))
      .sort((x, y) => { const a = val(x), b = val(y); return (a < b ? -1 : a > b ? 1 : 0) * sort[1]; });
  }, [rows, chip, needle, sort]); // eslint-disable-line react-hooks/exhaustive-deps
  const chips: { id: Chip; label: string }[] = [
    { id: 'all', label: 'All' }, { id: 'trial', label: 'Trial' }, { id: 'paying', label: 'Paying' }, { id: 'past_due', label: 'Past due' },
    { id: 'asked', label: 'Asked to upgrade' }, { id: 'at_risk', label: 'At risk' }, { id: 'expired', label: 'Trial ended' }, { id: 'churned', label: 'Churned' }, { id: 'comped', label: 'Set by staff' },
  ];
  const extend = async (a: AdminAccount) => {
    try { await api.adminExtendTrial(a.id, 7); toast(`${a.name}: trial extended by 7 days`); reload(); } catch (e) { toast((e as Error).message, 'bad'); }
  };
  return (
    <>
      <div className="sc-toolbar">
        <div className="sc-chips">{chips.map((c) => <button key={c.id} className={chip === c.id ? 'on' : ''} onClick={() => setChip(c.id)}>{c.label}<span>{count(c.id)}</span></button>)}</div>
        <div className="sc-tools">
          <div className="sc-filter"><Search size={14} /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter by name, owner, buyer or tag" aria-label="Filter" /></div>
          <a className="sc-btn" href="/api/platform/accounts.csv"><Download size={14} /> CSV</a>
        </div>
      </div>
      <div className="sc-tablewrap">
        <table className="sc-table">
          <thead><tr>
            <SortHead k="name" label="Workspace" sort={sort} setSort={setSort} />
            <SortHead k="stage" label="Stage" sort={sort} setSort={setSort} />
            <SortHead k="plan" label="Plan" sort={sort} setSort={setSort} />
            <SortHead k="health" label="Health" sort={sort} setSort={setSort} />
            <SortHead k="mrr" label="MRR" sort={sort} setSort={setSort} align="right" />
            <th>Bought by</th>
            <th className="num">Orgs · people · live</th>
            <SortHead k="aiCost30" label="AI 30d" sort={sort} setSort={setSort} align="right" />
            <SortHead k="lastActive" label="Last active" sort={sort} setSort={setSort} align="right" />
            <SortHead k="createdAt" label="Joined" sort={sort} setSort={setSort} align="right" />
            <th />
          </tr></thead>
          <tbody>
            {shown.map((a) => {
              const left = a.stage === 'trial' ? trialLeft(a.trialEndsAt) : null;
              return (
                <tr key={a.id} onClick={() => open(a.id)} tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter') open(a.id); }}>
                  <td><span className="sc-ws"><b>{a.name}</b><span>{a.owner ?? '–'}</span>{(a.tags?.length || a.staffOwner) ? <span className="sc-tags">{a.tags?.map((t) => <i key={t}>{t}</i>)}{a.staffOwner && <em>· {a.staffOwner.split('@')[0]}</em>}</span> : null}</span></td>
                  <td><StagePill s={a.stage} />{left !== null && <span className="sc-sub">{left > 0 ? `${left}d left` : 'ends today'}</span>}{a.requestedPlan && <span className="sc-sub ask">asked {PLAN_DEFS[a.requestedPlan].name}</span>}</td>
                  <td>{PLAN_DEFS[a.plan].name}</td>
                  <td><HealthDot h={a.health} /></td>
                  <td className="num">{a.mrr ? money(a.mrr) : '–'}{a.subInterval && <span className="sc-sub">{a.subInterval === 'year' ? 'yearly' : 'monthly'}</span>}</td>
                  <td className="sc-trunc">{a.purchasedBy ?? '–'}</td>
                  <td className="num">{a.orgs} · {a.users} · {a.liveAgents}</td>
                  <td className="num">${Number(a.aiCost30 ?? 0).toFixed(2)}</td>
                  <td className="num">{ago(a.lastActive)}</td>
                  <td className="num">{day(a.createdAt)}</td>
                  <td><RowMenu items={[
                    { label: 'Open', run: () => open(a.id) },
                    { label: 'Extend trial by 7 days', run: () => void extend(a), hidden: a.plan !== 'basic' },
                    { label: 'Copy owner email', run: () => { if (a.owner) void navigator.clipboard?.writeText(a.owner).then(() => toast('Copied')); }, hidden: !a.owner },
                    { label: 'Change plan…', run: () => open(a.id) },
                  ]} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {!shown.length && <p className="sc-empty">No workspaces match.</p>}
      </div>
    </>
  );
}

// ---------- One client ----------
type ClientTab = 'summary' | 'people' | 'orgs' | 'billing' | 'timeline' | 'notes';
function Client({ id, staff, back, changed }: { id: string; staff: string[]; back: () => void; changed: () => void }) {
  const [d, setD] = useState<AdminAccountDetail | null>(null);
  const [tab, setTab] = useState<ClientTab>('summary');
  const [plan, setPlan] = useState<PlanId>('basic');
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [tagDraft, setTagDraft] = useState('');
  const load = () => api.adminAccount(id).then((x) => { setD(x); setPlan(x.account.plan); }).catch((e) => toast((e as Error).message, 'bad'));
  useEffect(() => { setD(null); setTab('summary'); void load(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!d) return <SkeletonRows rows={8} cols={3} />;
  const a = d.account;
  const left = a.plan === 'basic' ? trialLeft(a.trialEndsAt) : null;
  const savePlan = async () => {
    if (plan === a.plan || !window.confirm(`Move "${a.name}" from ${PLAN_DEFS[a.plan].name} to ${PLAN_DEFS[plan].name}?${plan === 'basic' ? ' This starts a new 14-day trial.' : ''}${d.subscription?.status === 'active' ? ' They have an active Stripe subscription: change it in Stripe too.' : ''}`)) return;
    try { await api.adminSetPlan(a.id, plan, reason); toast('Plan changed'); setReason(''); await load(); changed(); } catch (e) { toast((e as Error).message, 'bad'); }
  };
  const extend = async (n: number) => { try { await api.adminExtendTrial(a.id, n); toast(`Trial extended by ${n} days`); await load(); changed(); } catch (e) { toast((e as Error).message, 'bad'); } };
  const meta = async (b: { tags?: string[]; staffOwner?: string | null }) => { try { await api.adminSetMeta(a.id, b); await load(); changed(); } catch (e) { toast((e as Error).message, 'bad'); } };
  const addTag = () => { const t = tagDraft.trim().toLowerCase(); if (!t) return; setTagDraft(''); void meta({ tags: [...(a.tags ?? []), t] }); };
  const addNote = async () => { if (!note.trim()) return; try { await api.adminAddNote(a.id, note); setNote(''); await load(); toast('Note added'); } catch (e) { toast((e as Error).message, 'bad'); } };
  const tabs: { id: ClientTab; label: string; n?: number }[] = [
    { id: 'summary', label: 'Summary' }, { id: 'people', label: 'People', n: d.members.length }, { id: 'orgs', label: 'Orgs', n: d.orgs.length },
    { id: 'billing', label: 'Billing', n: d.payments.length }, { id: 'timeline', label: 'Timeline' }, { id: 'notes', label: 'Notes', n: d.notes.length },
  ];
  return (
    <>
      <button className="sc-back" onClick={back}><ArrowLeft size={14} /> Workspaces</button>
      <div className="sc-client-head">
        <div>
          <h2>{a.name}</h2>
          <div className="sc-client-meta"><StagePill s={a.stage} /><span>{PLAN_DEFS[a.plan].name}</span><HealthDot h={a.health} />{left !== null && <span>{left > 0 ? `${left} days of trial left` : 'trial ended'}</span>}<span>joined {day(a.createdAt)}</span><span>owner {a.owner ?? '–'}</span></div>
        </div>
        <div className="sc-client-own">
          <label>Looked after by
            <select value={a.staffOwner ?? ''} onChange={(e) => void meta({ staffOwner: e.target.value || null })}>
              <option value="">Nobody yet</option>{staff.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>
        </div>
      </div>
      <div className="sc-tagrow">
        {(a.tags ?? []).map((t) => <span key={t} className="sc-tag">{t}<button aria-label={`Remove ${t}`} onClick={() => void meta({ tags: a.tags.filter((x) => x !== t) })}><X size={11} /></button></span>)}
        <input value={tagDraft} onChange={(e) => setTagDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') addTag(); }} placeholder="+ tag (partner, enterprise lead…)" aria-label="Add tag" maxLength={30} />
      </div>
      <div className="sc-tabs">{tabs.map((t) => <button key={t.id} className={tab === t.id ? 'on' : ''} onClick={() => setTab(t.id)}>{t.label}{t.n ? <span>{t.n}</span> : null}</button>)}</div>

      {tab === 'summary' && <div className="sc-cols">
        <section className="sc-card">
          <header><h2>Plan</h2>{a.requestedPlan && <Status tone="warn">Asked for {PLAN_DEFS[a.requestedPlan].name}</Status>}</header>
          <div className="sc-planrow">
            <select value={plan} onChange={(e) => setPlan(e.target.value as PlanId)} aria-label="Plan">{PLANS.map((p) => <option key={p} value={p}>{PLAN_DEFS[p].name}</option>)}</select>
            <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason, e.g. paid by invoice #123" aria-label="Reason" />
            <button className="sc-btn primary" onClick={() => void savePlan()} disabled={plan === a.plan}>Change plan</button>
          </div>
          {a.plan === 'basic' && <div className="sc-inline"><span className="sc-muted">Extend trial</span><button className="sc-btn" onClick={() => void extend(7)}>+7 days</button><button className="sc-btn" onClick={() => void extend(14)}>+14 days</button></div>}
          <div className="sc-meters">
            {(['orgs', 'users', 'liveAgents', 'assistants'] as const).map((k) => {
              const max = d.plan.limits[k];
              return <div key={k}><small>{{ orgs: 'Orgs', users: 'People', liveAgents: 'Live agents', assistants: 'Assistants' }[k]}</small><b>{d.plan.usage[k]}<span> / {max ?? '∞'}</span></b>{max !== null && <Meter value={d.plan.usage[k]} max={max} />}</div>;
            })}
          </div>
        </section>
        <section className="sc-card">
          <header><h2>At a glance</h2></header>
          <dl className="sc-dl">
            <dt>Subscription</dt><dd>{d.subscription?.status ? <><Status tone={d.subscription.status === 'active' ? 'ok' : d.subscription.status === 'past_due' ? 'warn' : 'bad'}>{d.subscription.status.replace('_', ' ')}</Status> {cents(d.subscription.amountCents, d.subscription.currency)}{d.subscription.interval ? ` / ${d.subscription.interval}` : ''}</> : 'None'}</dd>
            <dt>Bought by</dt><dd>{d.subscription?.purchasedBy ?? '–'}</dd>
            <dt>{d.subscription?.cancelAtPeriodEnd ? 'Ends' : 'Renews'}</dt><dd>{day(d.subscription?.renewsAt)}</dd>
            <dt>AI, 30 days</dt><dd>{Number(d.usage30.runs ?? 0).toLocaleString()} runs · ${Number(d.usage30.cost ?? 0).toFixed(2)}</dd>
            <dt>Last active</dt><dd>{ago(a.lastActive)}</dd>
            <dt>Agent turned on</dt><dd>{a.everLive ? 'Yes' : 'Not yet'}</dd>
            <dt>Plan set by</dt><dd>{a.planSetBy ?? '–'}</dd>
          </dl>
          {d.notes[0] && <div className="sc-lastnote"><small>Latest note · {d.notes[0].author} · {ago(d.notes[0].createdAt)}</small><p>{d.notes[0].text}</p></div>}
        </section>
      </div>}

      {tab === 'people' && <section className="sc-card flush"><table className="sc-table">
        <thead><tr><th>Person</th><th>Role</th><th className="num">Last sign-in</th><th className="num">Joined</th></tr></thead>
        <tbody>{d.members.map((m) => <tr key={m.email} className="static"><td><b>{m.email}</b></td><td>{m.role}</td><td className="num">{ago(m.lastLoginAt)}</td><td className="num">{day(m.createdAt)}</td></tr>)}
          {d.invites.map((m) => <tr key={m.email} className="static"><td>{m.email} <span className="sc-sub">invited by {m.invitedBy ?? '–'}</span></td><td>{m.role}</td><td className="num">invited</td><td className="num">expires {day(m.expiresAt)}</td></tr>)}</tbody>
      </table></section>}

      {tab === 'orgs' && <section className="sc-card flush">{d.orgs.length === 0 ? <p className="sc-empty">No Salesforce org connected yet.</p> : <table className="sc-table">
        <thead><tr><th>Org</th><th>Status</th><th>Package</th><th className="num">Connected</th></tr></thead>
        <tbody>{d.orgs.map((o, i) => <tr key={i} className="static"><td><b>{o.username ?? '–'}</b><span className="sc-sub">{o.url}</span></td><td><Status tone={o.status === 'ready' ? 'ok' : o.status === 'error' ? 'bad' : 'warn'}>{o.status}</Status>{o.status === 'error' && o.message && <span className="sc-sub">{o.message}</span>}</td><td>{o.usePackage ? 'Installed' : '–'}</td><td className="num">{day(o.connectedAt)}</td></tr>)}</tbody>
      </table>}</section>}

      {tab === 'billing' && <>
        <section className="sc-card">
          <header><h2>Subscription</h2></header>
          {d.subscription?.status ? <dl className="sc-dl two">
            <dt>Plan</dt><dd>{d.subscription.plan ? PLAN_DEFS[d.subscription.plan].name : '–'}{d.subscription.interval ? `, ${d.subscription.interval === 'year' ? 'yearly' : 'monthly'}` : ''}</dd>
            <dt>Price</dt><dd>{cents(d.subscription.amountCents, d.subscription.currency)}</dd>
            <dt>Status</dt><dd>{d.subscription.status.replace('_', ' ')}{d.subscription.cancelAtPeriodEnd ? ', cancels at period end' : ''}</dd>
            <dt>Bought by</dt><dd>{d.subscription.purchasedBy ?? '–'}</dd>
            <dt>Started</dt><dd>{day(d.subscription.startedAt)}</dd>
            <dt>{d.subscription.cancelAtPeriodEnd ? 'Ends' : 'Renews'}</dt><dd>{day(d.subscription.renewsAt)}</dd>
            <dt>Stripe customer</dt><dd>{d.subscription.customerId ?? '–'}</dd>
          </dl> : <p className="sc-empty">No paid subscription{a.stage === 'comped' ? ': the plan was set by staff.' : '.'}</p>}
        </section>
        <section className="sc-card flush"><header className="pad"><h2>Payments</h2></header>{d.payments.length === 0 ? <p className="sc-empty">No payments yet.</p> : <table className="sc-table">
          <thead><tr><th>When</th><th>What</th><th>Plan</th><th className="num">Amount</th><th /></tr></thead>
          <tbody>{d.payments.map((p, i) => <tr key={i} className="static"><td>{day(p.createdAt)}</td><td>{p.type.replace(/_/g, ' ')}{p.detail && <span className="sc-sub">{p.detail}</span>}</td><td>{p.plan ?? '–'}</td><td className="num">{cents(p.amountCents, p.currency)}</td><td className="num">{p.invoiceUrl && <a href={p.invoiceUrl} target="_blank" rel="noreferrer">Invoice <ExternalLink size={11} /></a>}</td></tr>)}</tbody>
        </table>}</section>
      </>}

      {tab === 'timeline' && <section className="sc-card">
        <ol className="sc-timeline">{d.timeline.map((t, i) => (
          <li key={i} className={t.kind}><span className="dot" /><div><b>{t.text}</b><span>{day(t.at)}{t.by ? ` · ${t.by}` : ''}{t.detail ? ` · ${t.detail}` : ''}</span></div></li>
        ))}</ol>
      </section>}

      {tab === 'notes' && <section className="sc-card">
        <div className="sc-noteadd"><textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="A note only CRMagents staff see: calls, promises, context" rows={3} /><button className="sc-btn primary" onClick={() => void addNote()} disabled={!note.trim()}>Add note</button></div>
        <ul className="sc-notes">{d.notes.map((n) => <li key={n.id}><div><small>{n.author} · {ago(n.createdAt)}</small><p>{n.text}</p></div><button className="sc-icon" aria-label="Delete note" onClick={() => void api.adminDeleteNote(n.id).then(load)}><Trash2 size={14} /></button></li>)}
          {!d.notes.length && <li className="sc-empty">No notes yet.</li>}</ul>
      </section>}
    </>
  );
}

// ---------- Users ----------
function UsersView({ users, open }: { users: AdminUser[]; open: (id: string) => void }) {
  const [q, setQ] = useState('');
  const [role, setRole] = useState('');
  const [activity, setActivity] = useState('');
  const n = q.trim().toLowerCase();
  const shown = users.filter((u) => (!n || u.email.toLowerCase().includes(n) || u.accountName.toLowerCase().includes(n)) && (!role || u.role === role)
    && (!activity || (activity === 'week' ? !!u.lastLoginAt && Date.now() - Date.parse(u.lastLoginAt) < 7 * 86_400_000 : activity === 'month' ? !u.lastLoginAt || Date.now() - Date.parse(u.lastLoginAt) > 30 * 86_400_000 : !u.lastLoginAt)));
  return (
    <>
      <div className="sc-toolbar">
        <div className="sc-tools grow">
          <div className="sc-filter"><Search size={14} /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter by email or workspace" aria-label="Filter" /></div>
          <select value={role} onChange={(e) => setRole(e.target.value)} aria-label="Role"><option value="">Any role</option>{['owner', 'admin', 'builder', 'approver'].map((r) => <option key={r} value={r}>{r}</option>)}</select>
          <select value={activity} onChange={(e) => setActivity(e.target.value)} aria-label="Activity"><option value="">Any activity</option><option value="week">Signed in this week</option><option value="month">Not seen for 30+ days</option><option value="never">Never signed in</option></select>
          <span className="sc-muted">{shown.length} people</span>
        </div>
      </div>
      <div className="sc-tablewrap"><table className="sc-table">
        <thead><tr><th>Person</th><th>Workspace</th><th>Role</th><th>Plan</th><th className="num">Last sign-in</th><th className="num">Joined</th></tr></thead>
        <tbody>{shown.map((u) => <tr key={u.id} onClick={() => open(u.accountId)}><td><b>{u.email}</b></td><td>{u.accountName}</td><td>{u.role}</td><td>{PLAN_DEFS[u.plan].name}</td><td className="num">{ago(u.lastLoginAt)}</td><td className="num">{day(u.createdAt)}</td></tr>)}</tbody>
      </table>{!shown.length && <p className="sc-empty">Nobody matches.</p>}</div>
    </>
  );
}

// ---------- Revenue ----------
function Revenue({ r, open }: { r: AdminRevenue; open: (id: string) => void }) {
  const max = Math.max(1, ...r.byMonth.map((m) => m.cents));
  return (
    <>
      <div className="sc-kpis three">
        <div><small>MRR</small><b>{money(r.mrr)}</b><span>monthly recurring revenue</span></div>
        <div><small>ARR</small><b>{money(r.arr)}</b><span>MRR × 12</span></div>
        <div><small>Paying clients</small><b>{r.paying}</b><span>{r.subscriptions.filter((s) => s.cancelAtPeriodEnd).length} cancelling at period end</span></div>
      </div>
      <section className="sc-card">
        <header><h2>Collected per month</h2><span className="sc-muted">payments received through Stripe</span></header>
        <div className="sc-bars">{r.byMonth.map((m) => (
          <div key={m.month} title={`${m.month}: ${cents(m.cents)} · ${m.started} new · ${m.canceled} cancelled`}>
            <span className="v">{m.cents ? cents(m.cents) : ''}</span><i style={{ height: `${(m.cents / max) * 100}%` }} /><span className="l">{new Date(`${m.month}-01`).toLocaleDateString([], { month: 'short' })}</span>
            <span className="n">{m.started ? `+${m.started}` : ''}{m.canceled ? ` −${m.canceled}` : ''}</span>
          </div>
        ))}</div>
        {!r.billingConfigured && <p className="sc-empty">Stripe isn't connected yet, so nothing is collected online.</p>}
      </section>
      <section className="sc-card flush"><header className="pad"><h2>Subscriptions</h2></header>{r.subscriptions.length === 0 ? <p className="sc-empty">No subscriptions yet.</p> : <table className="sc-table">
        <thead><tr><th>Workspace</th><th>Plan</th><th>Status</th><th className="num">MRR</th><th>Bought by</th><th className="num">Renews</th></tr></thead>
        <tbody>{r.subscriptions.map((s) => <tr key={s.id} onClick={() => open(s.id)}><td><b>{s.name}</b></td><td>{PLAN_DEFS[s.plan].name}{s.interval ? `, ${s.interval === 'year' ? 'yearly' : 'monthly'}` : ''}</td><td><Status tone={s.status === 'active' ? 'ok' : s.status === 'past_due' ? 'warn' : 'bad'}>{s.status.replace('_', ' ')}</Status></td><td className="num">{money(s.mrr)}</td><td>{s.purchasedBy ?? '–'}</td><td className="num">{s.cancelAtPeriodEnd ? `ends ${day(s.renewsAt)}` : day(s.renewsAt)}</td></tr>)}</tbody>
      </table>}</section>
    </>
  );
}

// ---------- Requests ----------
function Requests({ rows, staff, open, update }: { rows: AdminRequest[]; staff: string[]; open: (id: string) => void; update: (r: AdminRequest, b: { status?: string; notes?: string; assignedTo?: string | null }) => void }) {
  const [sel, setSel] = useState<number | null>(rows.find((r) => r.status === 'new')?.id ?? rows[0]?.id ?? null);
  const r = rows.find((x) => x.id === sel) ?? null;
  const [notes, setNotes] = useState(r?.notes ?? '');
  useEffect(() => { setNotes(r?.notes ?? ''); }, [sel]); // eslint-disable-line react-hooks/exhaustive-deps
  const SOURCE: Record<string, string> = { contact: 'Contact page', upgrade: 'In-app upgrade', pricing: 'Pricing page' };
  if (!rows.length) return <p className="sc-empty">No requests yet: they come from the Contact page, "Contact sales" on pricing and in-app upgrade asks.</p>;
  return (
    <div className="sc-board">
      <div className="sc-cols5">
        {REQ_COLS.map((c) => {
          const list = rows.filter((x) => x.status === c);
          return (
            <div key={c} className="sc-col">
              <h3>{c}<span>{list.length}</span></h3>
              {list.map((x) => (
                <button key={x.id} className={'sc-reqcard' + (x.id === sel ? ' on' : '')} onClick={() => setSel(x.id)}>
                  <b>{x.name}</b><span>{x.company || x.accountName || x.email}</span>
                  <em><Status tone="info">{x.topic}</Status>{x.assignedTo ? ` ${x.assignedTo.split('@')[0]}` : ''}</em>
                </button>
              ))}
            </div>
          );
        })}
      </div>
      {r && <aside className="sc-pane">
        <header><div><h2>{r.name}</h2><span><a href={`mailto:${r.email}`}>{r.email}</a>{r.company ? ` · ${r.company}` : ''}{r.size ? ` · ${r.size} users` : ''}</span></div></header>
        <div className="sc-inline"><Status tone="info">{r.topic}</Status><span className="sc-muted">{SOURCE[r.source] ?? r.source} · {day(r.createdAt)}</span>{r.accountId && <button className="sc-link" onClick={() => open(r.accountId!)}>{r.accountName ?? 'Open workspace'}</button>}</div>
        {r.message && <p className="sc-msg">{r.message}</p>}
        <div className="sc-statusbtns">{REQ_COLS.map((c) => <button key={c} className={r.status === c ? 'on' : ''} onClick={() => update(r, { status: c })}>{c}</button>)}</div>
        <label className="sc-field">Assigned to
          <select value={r.assignedTo ?? ''} onChange={(e) => update(r, { assignedTo: e.target.value || null })}><option value="">Nobody</option>{staff.map((s) => <option key={s} value={s}>{s}</option>)}</select>
        </label>
        <label className="sc-field">Notes (staff only)
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={4} />
        </label>
        <div className="sc-inline"><button className="sc-btn primary" onClick={() => update(r, { notes })} disabled={notes === (r.notes ?? '')}>Save notes</button>{r.handledBy && <span className="sc-muted">last updated by {r.handledBy}</span>}</div>
      </aside>}
    </div>
  );
}

// ---------- Staff log ----------
function StaffLog({ rows, open }: { rows: StaffLogItem[]; open: (id: string) => void }) {
  if (!rows.length) return <p className="sc-empty">Nothing yet: plan changes, trial extensions, notes and request updates by staff show here.</p>;
  return (
    <div className="sc-tablewrap"><table className="sc-table">
      <thead><tr><th>When</th><th>Who</th><th>Workspace</th><th>What</th><th>Detail</th></tr></thead>
      <tbody>{rows.map((x, i) => <tr key={i} onClick={() => x.accountId && open(x.accountId)} className={x.accountId ? '' : 'static'}><td>{day(x.at)} <span className="sc-sub">{ago(x.at)}</span></td><td>{x.by ?? '–'}</td><td>{x.accountName ?? '–'}</td><td>{x.what}</td><td className="sc-trunc">{x.detail ?? ''}</td></tr>)}</tbody>
    </table></div>
  );
}

// ---------- Platform settings ----------
function PlatformSettings({ me, billing }: { me: Me; billing: boolean }) {
  const [mail, setMail] = useState<Awaited<ReturnType<typeof api.adminEmail>>>();
  const [key, setKey] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState(me.email);
  const [busy, setBusy] = useState(false);
  const load = () => api.adminEmail().then((m) => { setMail(m); setFrom(m.from); }).catch((e) => toast((e as Error).message, 'bad'));
  useEffect(() => { void load(); }, []);
  const save = async (b: { resendKey?: string; mailFrom?: string }) => {
    setBusy(true);
    try { await api.adminSetEmail(b); setKey(''); toast('Saved'); await load(); } catch (e) { toast((e as Error).message, 'bad'); }
    setBusy(false);
  };
  const test = async () => {
    setBusy(true);
    try { const r = await api.adminTestEmail(to); toast(r.ok ? `Test email sent to ${to}` : `Not sent: ${r.error}`, r.ok ? 'ok' : 'bad'); } catch (e) { toast((e as Error).message, 'bad'); }
    setBusy(false);
  };
  if (!mail) return <SkeletonRows rows={4} cols={2} />;
  return (
    <>
      <section className="sc-card">
        <header><h2>Email</h2>{mail.configured ? <Status tone="ok">Sending through Resend</Status> : <Status tone="warn">Not set up</Status>}</header>
        <p className="sc-muted" style={{ margin: '0 0 14px' }}>Invitations, password resets and alerts. Until this is set, each workspace's mail goes out through its own connected Salesforce org, and admins can copy invite and reset links by hand. Get a key at resend.com after verifying your sending domain there.</p>
        <div className="sc-form">
          <label className="sc-field">Resend API key {mail.keyHint && <span className="sc-muted">current: {mail.keyHint}</span>}
            <span className="sc-inline" style={{ marginTop: 0 }}><input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder={mail.configured ? 'Paste a new key to replace it' : 're_...'} autoComplete="off" />
              <button className="sc-btn primary" disabled={busy || !key.trim()} onClick={() => void save({ resendKey: key })}>Save key</button>
              {mail.configured && <button className="sc-btn" disabled={busy} onClick={() => { if (window.confirm('Remove the email key? Mail falls back to each workspace\'s Salesforce org.')) void save({ resendKey: '' }); }}>Remove</button>}</span>
          </label>
          <label className="sc-field">From address
            <span className="sc-inline" style={{ marginTop: 0 }}><input value={from} onChange={(e) => setFrom(e.target.value)} placeholder="CRMagents <hello@yourdomain.com>" />
              <button className="sc-btn" disabled={busy || from === mail.from} onClick={() => void save({ mailFrom: from })}>Save</button></span>
          </label>
          <label className="sc-field">Send a test email
            <span className="sc-inline" style={{ marginTop: 0 }}><input value={to} onChange={(e) => setTo(e.target.value)} type="email" />
              <button className="sc-btn" disabled={busy || !mail.configured || !to.includes('@')} onClick={() => void test()}>Send test</button></span>
          </label>
        </div>
      </section>
      <section className="sc-card">
        <header><h2>Online payment</h2>{billing ? <Status tone="ok">Stripe connected</Status> : <Status tone="neutral">Off</Status>}</header>
        <p className="sc-muted" style={{ margin: 0 }}>{billing ? 'Customers can buy Plus and Pro from the app; subscriptions and payments show under Revenue.' : 'Checkout is off until the server has the Stripe keys and prices: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET and STRIPE_PRICE_PLUS_MONTHLY / _YEARLY, STRIPE_PRICE_PRO_MONTHLY / _YEARLY. They are set where the app is hosted, not here, so they never pass through a browser.'}</p>
      </section>
    </>
  );
}

// ---------- Global search ----------
function GlobalSearch({ open }: { open: (id: string) => void }) {
  const [q, setQ] = useState('');
  const [res, setRes] = useState<Awaited<ReturnType<typeof api.adminSearch>> | null>(null);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); ref.current?.focus(); } };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);
  useEffect(() => {
    if (q.trim().length < 2) { setRes(null); return; }
    const t = setTimeout(() => { api.adminSearch(q).then(setRes).catch(() => setRes(null)); }, 200);
    return () => clearTimeout(t);
  }, [q]);
  const pick = (id: string) => { setQ(''); setRes(null); open(id); };
  return (
    <div className="sc-search">
      <Search size={15} />
      <input ref={ref} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search workspaces and people" aria-label="Search" onKeyDown={(e) => { if (e.key === 'Escape') { setQ(''); setRes(null); } }} />
      <kbd>⌘K</kbd>
      {res && <div className="sc-results">
        {res.workspaces.length === 0 && res.users.length === 0 && <p className="sc-empty">No matches.</p>}
        {res.workspaces.length > 0 && <><h4>Workspaces</h4>{res.workspaces.map((w) => <button key={w.id} onClick={() => pick(w.id)}><b>{w.name}</b><span>{PLAN_DEFS[w.plan].name} · {w.owner ?? ''}</span></button>)}</>}
        {res.users.length > 0 && <><h4>People</h4>{res.users.map((u) => <button key={u.email} onClick={() => pick(u.accountId)}><b>{u.email}</b><span>{u.role} · {u.accountName}</span></button>)}</>}
      </div>}
    </div>
  );
}

// ---------- Console ----------
export function AdminConsole({ me, onExit }: { me: Me; onExit: () => void }) {
  const [view, setView] = useState<View>('overview');
  const [client, setClient] = useState<string | null>(null);
  const [ov, setOv] = useState<AdminOverview>();
  const [accounts, setAccounts] = useState<AdminAccount[]>();
  const [users, setUsers] = useState<AdminUser[]>();
  const [revenue, setRevenue] = useState<AdminRevenue>();
  const [requests, setRequests] = useState<AdminRequest[]>();
  const [log, setLog] = useState<StaffLogItem[]>();
  const [staff, setStaff] = useState<string[]>([]);
  const load = () => {
    api.adminOverview().then(setOv).catch((e) => toast((e as Error).message, 'bad'));
    api.adminAccounts().then(setAccounts).catch(() => setAccounts([]));
    api.adminRequests().then(setRequests).catch(() => setRequests([]));
  };
  useEffect(() => { load(); api.adminStaff().then(setStaff).catch(() => {}); }, []);
  useEffect(() => {
    if (view === 'users') api.adminUsers().then(setUsers).catch(() => setUsers([]));
    if (view === 'revenue') api.adminRevenue().then(setRevenue).catch(() => {});
    if (view === 'log') api.adminStaffLog().then(setLog).catch(() => setLog([]));
  }, [view]);
  const open = (id: string) => { setClient(id); setView('workspaces'); };
  const go = (v: View) => { setClient(null); setView(v); };
  const updateRequest = async (r: AdminRequest, b: { status?: string; notes?: string; assignedTo?: string | null }) => {
    try { await api.adminUpdateRequest(r.id, b); setRequests((rs) => rs?.map((x) => (x.id === r.id ? { ...x, ...b, handledBy: me.email } as AdminRequest : x))); toast('Saved'); load(); } catch (e) { toast((e as Error).message, 'bad'); }
  };
  const openReq = (requests ?? []).filter((r) => r.status === 'new').length;
  const NAV: { id: View; label: string; icon: ReactNode; n?: number }[] = [
    { id: 'overview', label: 'Overview', icon: <LayoutDashboard size={16} /> },
    { id: 'workspaces', label: 'Workspaces', icon: <Building2 size={16} />, n: accounts?.length },
    { id: 'users', label: 'People', icon: <Users size={16} /> },
    { id: 'revenue', label: 'Revenue', icon: <LineChart size={16} /> },
    { id: 'requests', label: 'Requests', icon: <Inbox size={16} />, n: openReq || undefined },
    { id: 'log', label: 'Staff log', icon: <ScrollText size={16} /> },
    { id: 'settings', label: 'Settings', icon: <Settings2 size={16} /> },
  ];
  const title = client ? 'Client' : NAV.find((n) => n.id === view)!.label;
  return (
    <div className="sc">
      <aside className="sc-side">
        <div className="sc-brand"><span className="brand-mark"><LogoMark size={13} /></span>CRMagents<span className="sc-staff">Staff</span></div>
        <nav>{NAV.map((n) => <button key={n.id} className={view === n.id && !(client && n.id !== 'workspaces') ? 'on' : ''} onClick={() => go(n.id)}>{n.icon}<span>{n.label}</span>{n.n ? <em>{n.n}</em> : null}</button>)}</nav>
        <div className="sc-side-foot">
          <span>{me.email}</span>
          <button onClick={onExit}><ArrowLeft size={14} /> Back to app</button>
        </div>
      </aside>
      <div className="sc-main">
        <header className="sc-top">
          <h1>{title}</h1>
          <GlobalSearch open={open} />
          <button className="sc-icon" aria-label="Refresh" title="Refresh" onClick={() => { load(); toast('Refreshed', 'info'); }}><RefreshCw size={15} /></button>
        </header>
        <div className="sc-body">
          {client ? <Client id={client} staff={staff} back={() => setClient(null)} changed={load} />
            : view === 'overview' ? (ov ? <Overview ov={ov} open={open} go={go} /> : <SkeletonRows rows={6} cols={4} />)
            : view === 'workspaces' ? (accounts ? <Workspaces rows={accounts} open={open} reload={load} /> : <SkeletonRows rows={8} cols={6} />)
            : view === 'users' ? (users ? <UsersView users={users} open={open} /> : <SkeletonRows rows={8} cols={5} />)
            : view === 'revenue' ? (revenue ? <Revenue r={revenue} open={open} /> : <SkeletonRows rows={6} cols={4} />)
            : view === 'requests' ? (requests ? <Requests rows={requests} staff={staff} open={open} update={(r, b) => void updateRequest(r, b)} /> : <SkeletonRows rows={6} cols={4} />)
            : view === 'settings' ? <PlatformSettings me={me} billing={ov?.billingConfigured ?? false} />
            : (log ? <StaffLog rows={log} open={open} /> : <SkeletonRows rows={6} cols={4} />)}
        </div>
      </div>
      <Toaster />
    </div>
  );
}
