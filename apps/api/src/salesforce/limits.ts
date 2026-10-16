import { pool } from '../db.js';

// The org's daily API allowance is shared with every other integration the customer runs. Salesforce reports
// the running total on every REST response (Sforce-Limit-Info: api-usage=used/max), so tracking it costs nothing.
// As usage climbs, CRMagents gives way: optional work stops first, record checks slow down, and only work people
// are waiting on (writes, approvals, runs already started) continues near the limit.

export type Work =
  /** Writes, approvals, runs already started, questions someone is waiting on. Never held back by us. */
  | 'essential'
  /** Checking for new records (polling). Slows down at 50%, stops at 95%. */
  | 'trigger'
  /** Insights refreshes, dashboards, backtests, suggestions, live-update events. Stops at 80%. */
  | 'background';

export interface ApiUsage { used: number; max: number; at: number }

const usage = new Map<string, ApiUsage>();
const persisted = new Map<string, { at: number; level: number }>();
const PERSIST_EVERY_MS = 60_000;

export const LEVELS = [0.5, 0.8, 0.95] as const;

/** 0 = fine, 1 = over 50% (slow down), 2 = over 80% (essential + triggers only), 3 = over 95% (essential only). */
export function levelOf(u: ApiUsage | undefined): 0 | 1 | 2 | 3 {
  if (!u || !u.max) return 0;
  const f = u.used / u.max;
  return f >= LEVELS[2] ? 3 : f >= LEVELS[1] ? 2 : f >= LEVELS[0] ? 1 : 0;
}

/** "api-usage=1234/15000" (other entries may follow, comma-separated). Pure; tested. */
export function parseLimitInfo(header: string | null | undefined): { used: number; max: number } | null {
  // Not "per-app-api-usage=…", which can come first.
  const m = /(?:^|[\s,])api-usage=(\d+)\/(\d+)/.exec(header ?? '');
  return m ? { used: Number(m[1]), max: Number(m[2]) } : null;
}

export function recordUsage(tenantId: string, header: string | null | undefined): void {
  const p = parseLimitInfo(header);
  if (!p) return;
  const u = { ...p, at: Date.now() };
  usage.set(tenantId, u);
  const last = persisted.get(tenantId);
  const level = levelOf(u);
  // Saved at most once a minute, or right away when it crosses a level, so other instances and the UI see it.
  if (!last || Date.now() - last.at > PERSIST_EVERY_MS || last.level !== level) {
    persisted.set(tenantId, { at: Date.now(), level });
    void pool.query('update tenants set api_used=$2, api_max=$3, api_checked_at=now() where id=$1', [tenantId, u.used, u.max]).catch(() => undefined);
  }
}

/** Salesforce refused a call because the allowance is used up. */
export function markExhausted(tenantId: string): void {
  const u = usage.get(tenantId);
  recordUsage(tenantId, `api-usage=${u?.max || 1}/${u?.max || 1}`);
}

/** Seeds the in-memory figure from the database (another instance may have seen it) when ours is missing or older. */
export function seedUsage(tenantId: string, used: number | null, max: number | null, checkedAt: Date | null): void {
  if (!used || !max || !checkedAt) return;
  const at = new Date(checkedAt).getTime();
  // The allowance is a rolling 24 hours: an old reading says little about now.
  if (Date.now() - at > 3 * 3600_000) return;
  const cur = usage.get(tenantId);
  if (!cur || cur.at < at) usage.set(tenantId, { used, max, at });
}

export function apiUsage(tenantId: string): ApiUsage | undefined {
  return usage.get(tenantId);
}

export function apiLevel(tenantId: string): 0 | 1 | 2 | 3 {
  return levelOf(usage.get(tenantId));
}

export class ApiBudgetError extends Error {
  statusCode = 429;
}

/** Whether this kind of work may use the org's API right now. Pure; tested. */
export function allowed(level: number, work: Work): boolean {
  if (work === 'essential') return true;
  if (work === 'trigger') return level < 3;
  return level < 2;
}

/** Throws before optional work when the org is running low, with a message people can act on. */
export function assertBudget(tenantId: string, work: Work): void {
  const u = usage.get(tenantId);
  if (allowed(levelOf(u), work)) return;
  const pct = u ? Math.round((u.used / u.max) * 100) : 100;
  throw new ApiBudgetError(
    `Paused to protect this Salesforce org: ${pct}% of its daily API allowance is used (${u?.used.toLocaleString()} of ${u?.max.toLocaleString()}). ` +
    (work === 'background' ? 'Agents and approvals keep working; this view refreshes when usage drops.' : 'Only work people are waiting on continues until usage drops.'),
  );
}

/** How many minutes between record checks for an org: slower when usage is high or nothing has changed lately. Pure; tested. */
export function pollMinutes(level: number, idleChecks: number): number {
  const base = idleChecks >= 30 ? 5 : idleChecks >= 10 ? 2 : 1; // quiet for 10 / 30 minutes
  const slow = level >= 2 ? 10 : level === 1 ? 2 : 1;
  return Math.max(base, slow);
}
