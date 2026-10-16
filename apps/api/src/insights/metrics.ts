import { allowed, apiLevel, assertBudget } from '../salesforce/limits.js';
import { pool } from '../db.js';
import type { SalesforceClient } from '../salesforce/client.js';

// Business metrics computed entirely in code from Salesforce aggregate queries - no AI tokens.
// Each block is optional: if an object/field doesn't exist or isn't accessible, it is skipped.

export type Format = 'currency' | 'number' | 'percent' | 'days';

export interface Kpi {
  id: string;
  label: string;
  value: number;
  previous?: number;
  format: Format;
  /** Whether a rise is good news (drives the arrow colour/label). */
  goodWhen: 'up' | 'down';
  hint?: string;
}
export interface Chart { id: string; title: string; kind: 'bar' | 'line'; format: Format; data: { label: string; value: number }[] }
export interface List {
  id: string; title: string; columns: string[]; rows: (string | number)[][];
  /** Plain-English agent request that would fix what this list shows ("Fix with an agent"). */
  fix?: string;
  note?: string;
}
export interface Insights {
  periodDays: number;
  currency: string;
  generatedAt: string;
  sections: { id: string; title: string; kpis: Kpi[]; charts: Chart[]; lists: List[] }[];
}

type Row = Record<string, any>;
const num = (v: unknown) => (typeof v === 'number' ? v : Number(v ?? 0) || 0);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** SOQL windows: the current period and the same-length period before it. */
function windows(n: number) {
  return {
    dtNow: `= LAST_N_DAYS:${n}`,
    dtPrev: (f: string) => `${f} = LAST_N_DAYS:${n * 2} AND ${f} < LAST_N_DAYS:${n}`,
    dNow: (f: string) => `${f} = LAST_N_DAYS:${n} AND ${f} <= TODAY`,
    dPrev: (f: string) => `${f} = LAST_N_DAYS:${n * 2} AND ${f} < LAST_N_DAYS:${n}`,
  };
}

async function safe<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try { return await fn(); } catch { return undefined; }
}

export async function computeInsights(sf: SalesforceClient, periodDays: number): Promise<Insights> {
  const w = windows(periodDays);
  const q = async (soql: string) => (await sf.query(soql)).records as Row[];
  const one = async (soql: string) => (await q(soql))[0] ?? {};
  // Every section starts at once, so their queries reach Salesforce together as composite batches
  // (one API call per 25 queries) instead of one call each.
  const currencyP = safe(async () => String((await one('SELECT DefaultCurrencyIsoCode FROM Organization')).DefaultCurrencyIsoCode ?? ''));
  const sections: Insights['sections'] = [];

  // ---------- Sales ----------
  const salesP = safe(async () => {
    const [openP, wonNow, wonPrev, lostNow, byStage, monthly, closingSoon, stale, topOpen, topAccounts, pastDue] = await Promise.all([
      one('SELECT COUNT(Id) c, SUM(Amount) s FROM Opportunity WHERE IsClosed = false'),
      one(`SELECT COUNT(Id) c, SUM(Amount) s FROM Opportunity WHERE IsWon = true AND ${w.dNow('CloseDate')}`),
      one(`SELECT COUNT(Id) c, SUM(Amount) s FROM Opportunity WHERE IsWon = true AND ${w.dPrev('CloseDate')}`),
      one(`SELECT COUNT(Id) c FROM Opportunity WHERE IsClosed = true AND IsWon = false AND ${w.dNow('CloseDate')}`),
      q('SELECT StageName, COUNT(Id) c, SUM(Amount) s FROM Opportunity WHERE IsClosed = false GROUP BY StageName ORDER BY SUM(Amount) DESC NULLS LAST LIMIT 12'),
      q('SELECT CALENDAR_YEAR(CloseDate) y, CALENDAR_MONTH(CloseDate) m, SUM(Amount) s FROM Opportunity WHERE IsWon = true AND (CloseDate = LAST_N_MONTHS:5 OR CloseDate = THIS_MONTH) GROUP BY CALENDAR_YEAR(CloseDate), CALENDAR_MONTH(CloseDate)'),
      one('SELECT COUNT(Id) c, SUM(Amount) s FROM Opportunity WHERE IsClosed = false AND CloseDate = NEXT_N_DAYS:30'),
      one('SELECT COUNT(Id) c FROM Opportunity WHERE IsClosed = false AND LastModifiedDate < LAST_N_DAYS:30'),
      q('SELECT Name, Account.Name, StageName, Amount, CloseDate FROM Opportunity WHERE IsClosed = false ORDER BY Amount DESC NULLS LAST LIMIT 5'),
      q(`SELECT Account.Name a, SUM(Amount) s FROM Opportunity WHERE IsWon = true AND ${w.dNow('CloseDate')} GROUP BY Account.Name ORDER BY SUM(Amount) DESC NULLS LAST LIMIT 5`),
      one('SELECT COUNT(Id) c, SUM(Amount) s FROM Opportunity WHERE IsClosed = false AND CloseDate < TODAY'),
    ]);
    const won = num(wonNow.c);
    const lost = num(lostNow.c);
    // Six calendar months ending this month, zero-filled so gaps show as zero rather than vanish.
    const now = new Date();
    const series = Array.from({ length: 6 }, (_, i) => {
      const d = new Date(now.getFullYear(), now.getMonth() - 5 + i, 1);
      const hit = monthly.find((r) => num(r.y) === d.getFullYear() && num(r.m) === d.getMonth() + 1);
      return { label: `${MONTHS[d.getMonth()]}${d.getMonth() === 0 ? ` ${d.getFullYear()}` : ''}`, value: num(hit?.s) };
    });
    return {
      id: 'sales', title: 'Sales',
      kpis: [
        { id: 'won_revenue', label: `Won revenue, last ${periodDays} days`, value: num(wonNow.s), previous: num(wonPrev.s), format: 'currency', goodWhen: 'up', hint: `${won} deals won` },
        { id: 'open_pipeline', label: 'Open pipeline', value: num(openP.s), format: 'currency', goodWhen: 'up', hint: `${num(openP.c)} open deals` },
        { id: 'win_rate', label: `Win rate, last ${periodDays} days`, value: won + lost ? won / (won + lost) : 0, format: 'percent', goodWhen: 'up', hint: `${won} won, ${lost} lost` },
        { id: 'avg_deal', label: 'Average won deal', value: won ? num(wonNow.s) / won : 0, previous: num(wonPrev.c) ? num(wonPrev.s) / num(wonPrev.c) : undefined, format: 'currency', goodWhen: 'up' },
        { id: 'closing_soon', label: 'Closing in next 30 days', value: num(closingSoon.s), format: 'currency', goodWhen: 'up', hint: `${num(closingSoon.c)} deals` },
        { id: 'stale_deals', label: 'Open deals untouched 30+ days', value: num(stale.c), format: 'number', goodWhen: 'down' },
        { id: 'past_due', label: 'Open deals past their close date', value: num(pastDue.s), format: 'currency', goodWhen: 'down', hint: `${num(pastDue.c)} deals` },
      ] as Kpi[],
      charts: [
        { id: 'won_by_month', title: 'Won revenue by month', kind: 'line', format: 'currency', data: series },
        { id: 'pipeline_by_stage', title: 'Open pipeline by stage', kind: 'bar', format: 'currency', data: byStage.map((r) => ({ label: String(r.StageName ?? 'None'), value: num(r.s) })) },
      ] as Chart[],
      lists: [
        { id: 'top_open', title: 'Biggest open deals', columns: ['Deal', 'Account', 'Stage', 'Amount', 'Close date'], rows: topOpen.map((r) => [r.Name, r.Account?.Name ?? '', r.StageName, num(r.Amount), r.CloseDate]) },
        { id: 'top_accounts', title: `Top accounts by won revenue, last ${periodDays} days`, columns: ['Account', 'Won revenue'], rows: topAccounts.map((r) => [r.a ?? '(no account)', num(r.s)]) },
      ] as List[],
    };
  });

  // ---------- Forecast (this quarter) ----------
  const forecastP = safe(async () => {
    const [wonQtd, openQ, hist] = await Promise.all([
      one('SELECT COUNT(Id) c, SUM(Amount) s FROM Opportunity WHERE IsWon = true AND CloseDate = THIS_QUARTER'),
      q('SELECT StageName, COUNT(Id) c, SUM(Amount) s, AVG(Probability) p FROM Opportunity WHERE IsClosed = false AND CloseDate = THIS_QUARTER AND CloseDate >= TODAY GROUP BY StageName'),
      one('SELECT COUNT(Id) c, SUM(Amount) s FROM Opportunity WHERE IsClosed = true AND CloseDate = LAST_N_DAYS:365'),
    ]);
    const wonLastYear = await one('SELECT COUNT(Id) c FROM Opportunity WHERE IsWon = true AND CloseDate = LAST_N_DAYS:365');
    const closed = num(hist.c);
    // Your own track record beats the stage probabilities typed into Salesforce; fall back to those without history.
    const winRate = closed >= 5 ? num(wonLastYear.c) / closed : undefined;
    const won = num(wonQtd.s);
    const open = openQ.reduce((a, r) => a + num(r.s), 0);
    const weighted = openQ.reduce((a, r) => a + num(r.s) * (winRate ?? num(r.p) / 100), 0);
    const commit = openQ.filter((r) => num(r.p) >= 90).reduce((a, r) => a + num(r.s), 0);
    return {
      id: 'forecast', title: 'This quarter forecast',
      kpis: [
        { id: 'fc_likely', label: 'Likely revenue this quarter', value: won + weighted, format: 'currency', goodWhen: 'up', hint: winRate !== undefined ? `won so far + open deals × your ${Math.round(winRate * 100)}% win rate (last 12 months)` : 'won so far + open deals × their stage probability' },
        { id: 'fc_won', label: 'Won so far this quarter', value: won, format: 'currency', goodWhen: 'up', hint: `${num(wonQtd.c)} deals` },
        { id: 'fc_best', label: 'Best case (everything open closes)', value: won + open, format: 'currency', goodWhen: 'up', hint: `${openQ.reduce((a, r) => a + num(r.c), 0)} open deals due this quarter` },
        { id: 'fc_commit', label: 'Committed (90%+ probability)', value: won + commit, format: 'currency', goodWhen: 'up' },
      ] as Kpi[],
      charts: [
        { id: 'fc_by_stage', title: 'Open deals due this quarter, by stage', kind: 'bar', format: 'currency', data: openQ.sort((a, b) => num(b.s) - num(a.s)).map((r) => ({ label: String(r.StageName), value: num(r.s) })) },
      ] as Chart[],
      lists: [] as List[],
    };
  });

  // ---------- Deal risk radar (rules in code; reasons are shown, not a black box) ----------
  const riskP = safe(async () => {
    const base = 'Id, Name, Account.Name, Owner.Name, Amount, StageName, CloseDate, Probability, LastActivityDate, LastModifiedDate';
    let deals: Row[];
    try { deals = await q(`SELECT ${base}, LastStageChangeDate, PushCount FROM Opportunity WHERE IsClosed = false ORDER BY Amount DESC NULLS LAST LIMIT 200`); }
    catch { deals = await q(`SELECT ${base} FROM Opportunity WHERE IsClosed = false ORDER BY Amount DESC NULLS LAST LIMIT 200`); }
    const scored = deals.map((d) => ({ d, ...scoreDeal(d) })).filter((x) => x.score >= 30).sort((a, b) => b.score - a.score || num(b.d.Amount) - num(a.d.Amount));
    const atRisk = scored.reduce((a, x) => a + num(x.d.Amount), 0);
    return {
      id: 'risk', title: 'Deal risk radar',
      kpis: [
        { id: 'risk_count', label: 'Open deals at risk', value: scored.length, format: 'number', goodWhen: 'down', hint: `of ${deals.length} open deals` },
        { id: 'risk_amount', label: 'Pipeline at risk', value: atRisk, format: 'currency', goodWhen: 'down' },
      ] as Kpi[],
      charts: [] as Chart[],
      lists: [{
        id: 'risk_deals', title: 'Riskiest open deals',
        columns: ['Deal', 'Account', 'Owner', 'Amount', 'Risk', 'Why'],
        rows: scored.slice(0, 10).map((x) => [x.d.Name, x.d.Account?.Name ?? '', x.d.Owner?.Name ?? '', num(x.d.Amount), `${x.score}/100`, x.reasons.join('; ')]),
        note: 'Scored from close date, activity, time in stage and how often the close date moved.',
        fix: 'Every morning, find open opportunities whose close date has passed or that have had no activity for 30 days, and create a follow-up task for the opportunity owner asking them to update the next step and close date.',
      }] as List[],
    };
  });

  // ---------- Leads ----------
  const leadsP = safe(async () => {
    const [newNow, newPrev, convNow, bySource, open] = await Promise.all([
      one(`SELECT COUNT(Id) c FROM Lead WHERE CreatedDate ${w.dtNow}`),
      one(`SELECT COUNT(Id) c FROM Lead WHERE ${w.dtPrev('CreatedDate')}`),
      one(`SELECT COUNT(Id) c FROM Lead WHERE IsConverted = true AND ${w.dNow('ConvertedDate')}`),
      q(`SELECT LeadSource, COUNT(Id) c FROM Lead WHERE CreatedDate ${w.dtNow} GROUP BY LeadSource ORDER BY COUNT(Id) DESC LIMIT 10`),
      one('SELECT COUNT(Id) c FROM Lead WHERE IsConverted = false'),
    ]);
    const created = num(newNow.c);
    return {
      id: 'leads', title: 'Leads',
      kpis: [
        { id: 'new_leads', label: `New leads, last ${periodDays} days`, value: created, previous: num(newPrev.c), format: 'number', goodWhen: 'up' },
        { id: 'converted', label: `Converted, last ${periodDays} days`, value: num(convNow.c), format: 'number', goodWhen: 'up', hint: created ? `${Math.round((num(convNow.c) / created) * 100)}% of new leads` : undefined },
        { id: 'open_leads', label: 'Leads not yet converted', value: num(open.c), format: 'number', goodWhen: 'down' },
      ] as Kpi[],
      charts: [
        { id: 'leads_by_source', title: `New leads by source, last ${periodDays} days`, kind: 'bar', format: 'number', data: bySource.map((r) => ({ label: String(r.LeadSource ?? 'Unknown'), value: num(r.c) })) },
      ] as Chart[],
      lists: [] as List[],
    };
  });

  // ---------- Service ----------
  const serviceP = safe(async () => {
    const [newNow, newPrev, open, byPriority, closed, oldest] = await Promise.all([
      one(`SELECT COUNT(Id) c FROM Case WHERE CreatedDate ${w.dtNow}`),
      one(`SELECT COUNT(Id) c FROM Case WHERE ${w.dtPrev('CreatedDate')}`),
      one('SELECT COUNT(Id) c FROM Case WHERE IsClosed = false'),
      q('SELECT Priority, COUNT(Id) c FROM Case WHERE IsClosed = false GROUP BY Priority ORDER BY COUNT(Id) DESC'),
      q(`SELECT CreatedDate, ClosedDate FROM Case WHERE IsClosed = true AND ClosedDate ${w.dtNow} LIMIT 2000`),
      q('SELECT CaseNumber, Subject, Priority, CreatedDate FROM Case WHERE IsClosed = false ORDER BY CreatedDate ASC LIMIT 5'),
    ]);
    // Resolution time can't be computed in SOQL; average it here from closed cases.
    const durations = closed.map((r) => (Date.parse(r.ClosedDate) - Date.parse(r.CreatedDate)) / 86_400_000).filter((d) => d >= 0);
    const avgDays = durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : 0;
    return {
      id: 'service', title: 'Customer service',
      kpis: [
        { id: 'new_cases', label: `New cases, last ${periodDays} days`, value: num(newNow.c), previous: num(newPrev.c), format: 'number', goodWhen: 'down' },
        { id: 'open_cases', label: 'Open cases', value: num(open.c), format: 'number', goodWhen: 'down' },
        { id: 'resolution', label: `Avg time to close, last ${periodDays} days`, value: avgDays, format: 'days', goodWhen: 'down', hint: `${durations.length} cases closed` },
      ] as Kpi[],
      charts: [
        { id: 'open_by_priority', title: 'Open cases by priority', kind: 'bar', format: 'number', data: byPriority.map((r) => ({ label: String(r.Priority ?? 'None'), value: num(r.c) })) },
      ] as Chart[],
      lists: [
        { id: 'oldest_open', title: 'Oldest open cases', columns: ['Case', 'Subject', 'Priority', 'Opened'], rows: oldest.map((r) => [r.CaseNumber, r.Subject ?? '', r.Priority ?? '', String(r.CreatedDate).slice(0, 10)]),
          fix: 'When a case has been open for more than 14 days, create a task for the case owner to update the customer and either resolve or escalate the case.' },
      ] as List[],
    };
  });

  // ---------- Team activity ----------
  const activityP = safe(async () => {
    const [overdue, doneNow] = await Promise.all([
      one('SELECT COUNT(Id) c FROM Task WHERE IsClosed = false AND ActivityDate < TODAY'),
      one(`SELECT COUNT(Id) c FROM Task WHERE IsClosed = true AND LastModifiedDate ${w.dtNow}`),
    ]);
    return {
      id: 'activity', title: 'Team activity',
      kpis: [
        { id: 'overdue_tasks', label: 'Overdue tasks', value: num(overdue.c), format: 'number', goodWhen: 'down' },
        { id: 'tasks_done', label: `Tasks completed, last ${periodDays} days`, value: num(doneNow.c), format: 'number', goodWhen: 'up' },
      ] as Kpi[],
      charts: [] as Chart[],
      lists: [] as List[],
    };
  });

  const currency = (await currencyP) || 'USD';
  for (const sct of await Promise.all([salesP, forecastP, riskP, leadsP, serviceP, activityP])) if (sct) sections.push(sct);

  return { periodDays, currency, generatedAt: new Date().toISOString(), sections };
}

/** Cached for 15 minutes per org and period; "Refresh" bypasses the cache. */
export async function cachedInsights(tenantId: string, sf: SalesforceClient, periodDays: number, refresh = false): Promise<Insights> {
  const key = `insights:${periodDays}`;
  if (!refresh) {
    const { rows } = await pool.query(
      "select data from sf_schema_cache where tenant_id=$1 and key=$2 and fetched_at > now() - interval '15 minutes'", [tenantId, key],
    );
    if (rows[0]) return rows[0].data as Insights;
  }
  if (!allowed(apiLevel(tenantId), 'background')) {
    // The org is close to its API limit: show the last numbers rather than spend calls on a refresh.
    const { rows } = await pool.query('select data from sf_schema_cache where tenant_id=$1 and key=$2', [tenantId, key]);
    if (rows[0]) return { ...(rows[0].data as Insights), stale: true } as Insights;
    assertBudget(tenantId, 'background');
  }
  // About 25 queries, started together: they go to Salesforce as one or two composite batch calls.
  const data = await computeInsights(sf, periodDays);
  await saveSnapshot(tenantId, data);
  await addHistory(tenantId, data);
  await pool.query(
    `insert into sf_schema_cache (tenant_id, key, data) values ($1,$2,$3)
     on conflict (tenant_id, key) do update set data=excluded.data, fetched_at=now()`,
    [tenantId, key, JSON.stringify(data)],
  );
  return data;
}

// ---------- Daily snapshots: history built by CRMagents ----------
const SNAPSHOT_KPIS: Record<string, string> = {
  open_pipeline: 'Open pipeline', fc_likely: 'Likely revenue this quarter', risk_amount: 'Pipeline at risk',
  open_cases: 'Open cases', open_leads: 'Leads not yet converted', overdue_tasks: 'Overdue tasks',
};

export async function saveSnapshot(tenantId: string, ins: Insights) {
  const data: Record<string, number> = {};
  for (const s of ins.sections) for (const k of s.kpis) if (k.id in SNAPSHOT_KPIS) data[k.id] = k.value;
  if (!Object.keys(data).length) return;
  await pool.query(
    `insert into kpi_snapshots (tenant_id, day, data) values ($1, current_date, $2)
     on conflict (tenant_id, day) do update set data = excluded.data`,
    [tenantId, JSON.stringify(data)],
  );
}

/** Adds "over time" charts once at least two days of snapshots exist. */
export async function addHistory(tenantId: string, ins: Insights) {
  const { rows } = await pool.query(
    "select day, data from kpi_snapshots where tenant_id=$1 and day > current_date - 90 order by day", [tenantId],
  );
  const note = rows.length < 2 ? `CRMagents records these numbers daily; trends appear from tomorrow (${rows.length} day so far).` : undefined;
  const label = (d: Date) => `${MONTHS[d.getMonth()]} ${d.getDate()}`;
  const charts: Chart[] = rows.length < 2 ? [] : ['open_pipeline', 'risk_amount', 'open_cases'].filter((k) => rows.some((r) => r.data[k] !== undefined)).map((k) => ({
    id: `hist_${k}`, title: `${SNAPSHOT_KPIS[k]} over time`, kind: 'line' as const,
    format: k === 'open_cases' ? ('number' as const) : ('currency' as const),
    data: rows.map((r) => ({ label: label(new Date(r.day)), value: num(r.data[k]) })),
  }));
  ins.sections.push({ id: 'history', title: 'Trends (recorded by CRMagents)', kpis: [], charts, lists: note ? [{ id: 'hist_note', title: 'History', columns: [], rows: [], note }] : [] });
}

/** Called daily by the background loop so history accumulates even if nobody opens Insights. */
export async function snapshotDue(tenantId: string): Promise<boolean> {
  const { rowCount } = await pool.query('select 1 from kpi_snapshots where tenant_id=$1 and day = current_date', [tenantId]);
  return !rowCount;
}

/** Deal risk by transparent rules; every point added comes with a reason the owner can act on. */
export function scoreDeal(d: Row, today = Date.now()): { score: number; reasons: string[] } {
  const days = (v?: string) => (v ? Math.floor((today - Date.parse(v)) / 86_400_000) : undefined);
  const reasons: string[] = [];
  let score = 0;
  const sinceClose = days(d.CloseDate); // positive = close date is in the past
  if (sinceClose !== undefined && sinceClose > 0) { score += 40; reasons.push(`close date passed ${sinceClose} days ago`); }
  const quiet = days(d.LastActivityDate);
  if (quiet === undefined) { score += 20; reasons.push('no logged activity'); }
  else if (quiet > 30) { score += 25; reasons.push(`no activity for ${quiet} days`); }
  else if (quiet > 14) { score += 10; reasons.push(`quiet for ${quiet} days`); }
  const stuck = days(d.LastStageChangeDate);
  if (stuck !== undefined && stuck > 60) { score += 15; reasons.push(`in "${d.StageName}" for ${stuck} days`); }
  if (num(d.PushCount) >= 2) { score += 15; reasons.push(`close date pushed ${num(d.PushCount)} times`); }
  if (sinceClose !== undefined && sinceClose <= 0 && sinceClose >= -14 && num(d.Probability) < 50) {
    score += 15; reasons.push(`closing in ${-sinceClose} days at ${num(d.Probability)}% probability`);
  }
  return { score: Math.min(score, 100), reasons };
}
