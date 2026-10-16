import type { Workflow } from '@crmagents/shared';
import { pool } from '../db.js';
import type { SalesforceClient } from '../salesforce/client.js';

// Suggested agents: code looks for waste in the org ($0, a handful of COUNT queries) and turns each finding into a
// ready-to-build request. The admin never starts from a blank box.

export interface Suggestion {
  key: string;
  title: string;
  /** What we found, with the numbers. */
  finding: string;
  /** The plain-English request handed to the builder. */
  request: string;
  count: number;
  value?: number;
  /** Rough ranking: money first, then volume. */
  score: number;
  object: string;
}

interface Detector {
  key: string;
  object: string;
  soql: string;
  min: number;
  make: (n: number, amount: number) => Omit<Suggestion, 'key' | 'count' | 'value' | 'score' | 'object'>;
  /** Already covered when an agent with this trigger object and one of these node types exists. */
  coveredBy?: string[];
}

const money = (v: number) => (v >= 1_000_000 ? `$${(v / 1_000_000).toFixed(1)}M` : v >= 1000 ? `$${Math.round(v / 1000)}K` : `$${Math.round(v)}`);

export const DETECTORS: Detector[] = [
  {
    key: 'stale_deals', object: 'Opportunity', min: 3, coveredBy: ['sf.createTask'],
    soql: 'SELECT COUNT(Id) n, SUM(Amount) amt FROM Opportunity WHERE IsClosed = false AND (LastActivityDate = null OR LastActivityDate < LAST_N_DAYS:30)',
    make: (n, amt) => ({
      title: 'Follow up on stale deals',
      finding: `${n} open deals${amt ? ` worth ${money(amt)}` : ''} have had no activity in 30 days.`,
      request: 'Every Monday at 08:00, find open opportunities with no activity in the last 30 days and create a follow-up task for each owner with the deal name and amount.',
    }),
  },
  {
    key: 'past_due_deals', object: 'Opportunity', min: 3, coveredBy: ['sf.updateRecord', 'sf.createTask'],
    soql: 'SELECT COUNT(Id) n, SUM(Amount) amt FROM Opportunity WHERE IsClosed = false AND CloseDate < TODAY',
    make: (n, amt) => ({
      title: 'Clean up past-due deals',
      finding: `${n} open deals${amt ? ` (${money(amt)})` : ''} are past their close date, which skews the forecast.`,
      request: 'Every Monday, find open opportunities whose close date has passed and create a task for each owner asking them to update the close date or mark the deal lost.',
    }),
  },
  {
    key: 'uncontacted_leads', object: 'Lead', min: 5, coveredBy: ['sf.createTask', 'ai.extract', 'ai.classify'],
    soql: 'SELECT COUNT(Id) n FROM Lead WHERE IsConverted = false AND LastActivityDate = null AND CreatedDate < LAST_N_DAYS:2',
    make: (n) => ({
      title: 'Never let a lead go cold',
      finding: `${n} leads have never been contacted.`,
      request: 'When a lead is created, score it from 0 to 100 based on title, company and source, set its Rating, and create a call task for the owner if the score is above 60.',
    }),
  },
  {
    key: 'old_open_cases', object: 'Case', min: 3, coveredBy: ['sf.createTask', 'sf.updateRecord'],
    soql: 'SELECT COUNT(Id) n FROM Case WHERE IsClosed = false AND CreatedDate < LAST_N_DAYS:14',
    make: (n) => ({
      title: 'Chase cases open too long',
      finding: `${n} cases have been open for more than two weeks.`,
      request: 'Every day at 09:00, find open cases created more than 14 days ago and create a follow-up task for each owner with the case number and subject.',
    }),
  },
  {
    key: 'queue_cases', object: 'Case', min: 3, coveredBy: ['ai.classify', 'sf.updateRecord'],
    soql: "SELECT COUNT(Id) n FROM Case WHERE IsClosed = false AND Owner.Type = 'Queue'",
    make: (n) => ({
      title: 'Triage cases sitting in queues',
      finding: `${n} open cases are still owned by a queue.`,
      request: 'When a new case comes in, sort it into billing, technical, account access or other, set its priority, and create a follow-up task. Skip closed cases.',
    }),
  },
  {
    key: 'missing_amount', object: 'Opportunity', min: 3, coveredBy: ['sf.createTask'],
    soql: 'SELECT COUNT(Id) n FROM Opportunity WHERE IsClosed = false AND Amount = null',
    make: (n) => ({
      title: 'Fill in missing deal amounts',
      finding: `${n} open deals have no amount, so revenue reports undercount.`,
      request: 'When an opportunity is created or updated without an amount, create a task for the owner asking them to add the deal amount.',
    }),
  },
  {
    key: 'duplicate_accounts', object: 'Account', min: 2, coveredBy: ['sf.createTask'],
    soql: 'SELECT Name, COUNT(Id) n FROM Account GROUP BY Name HAVING COUNT(Id) > 1 LIMIT 200',
    make: (n) => ({
      title: 'Catch duplicate accounts',
      finding: `${n} account names appear more than once.`,
      request: 'When an account is created, look for existing accounts with the same name or website, and if one exists create a task for the owner to review the possible duplicate.',
    }),
  },
];

/** Does an existing agent already handle this? Pure; tested. */
export function covered(d: Pick<Detector, 'object' | 'coveredBy'>, graphs: Workflow[]): boolean {
  return graphs.some((g) => {
    const objects = new Set(g.nodes.map((n) => String(n.config.objectApiName ?? n.config.sobject ?? '')).concat(
      g.nodes.filter((n) => n.type === 'sf.query').map((n) => /\bFROM\s+(\w+)/i.exec(String(n.config.soql ?? ''))?.[1] ?? ''),
    ));
    return objects.has(d.object) && g.nodes.some((n) => d.coveredBy?.includes(n.type));
  });
}

const cache = new Map<string, { at: number; list: Suggestion[] }>();
const TTL = 6 * 3600_000;

export async function suggestAgents(tenantId: string, sf: SalesforceClient, refresh = false): Promise<Suggestion[]> {
  const hit = cache.get(tenantId);
  let list = hit && !refresh && Date.now() - hit.at < TTL ? hit.list : undefined;
  if (!list) {
    const found = await Promise.all(DETECTORS.map(async (d) => {
      try {
        const r = await sf.query(d.soql);
        const rows = r.records as { n?: number; amt?: number }[];
        // Grouped detectors (duplicates) count rows; the rest read the aggregate.
        const n = d.soql.includes('GROUP BY') ? rows.length : Number(rows[0]?.n ?? 0);
        const amt = Number(rows[0]?.amt ?? 0);
        if (n < d.min) return null;
        return { key: d.key, object: d.object, count: n, value: amt || undefined, score: (amt ? Math.log10(amt + 1) * 10 : 0) + Math.log10(n + 1) * 5, ...d.make(n, amt) };
      } catch { return null; } // object or field not in this org
    }));
    list = (found.filter(Boolean) as Suggestion[]).sort((a, b) => b.score - a.score);
    cache.set(tenantId, { at: Date.now(), list });
  }
  const [{ rows: dismissed }, { rows: flows }] = await Promise.all([
    pool.query('select key from suggestion_dismissals where tenant_id=$1', [tenantId]),
    pool.query('select graph from workflows where tenant_id=$1', [tenantId]),
  ]);
  const gone = new Set(dismissed.map((r) => r.key));
  const graphs = flows.map((f) => f.graph as Workflow);
  return list.filter((s) => !gone.has(s.key) && !covered(DETECTORS.find((d) => d.key === s.key)!, graphs));
}

export async function dismissSuggestion(tenantId: string, key: string) {
  await pool.query('insert into suggestion_dismissals (tenant_id, key) values ($1,$2) on conflict do nothing', [tenantId, key]);
}
