import type { SpendGuard } from './agent/llm.js';
import { pool } from './db.js';
import { getSetting } from './settings.js';

// Spend guards so AI usage cannot run away: a per-workspace daily dollar budget, checked before every model
// request, and a cap on how many runs a workspace can start per minute (e.g. a Flow firing on a mass update).

export const DEFAULT_DAILY_BUDGET_USD = 2;
const RUNS_PER_MINUTE = 30;

/** null = no limit (setting "none"). */
export async function dailyBudgetUsd(accountId: string): Promise<number | null> {
  const raw = (await getSetting(accountId, 'dailyBudgetUsd'))?.trim().toLowerCase();
  if (raw === 'none') return null;
  const n = Number(raw);
  return raw && Number.isFinite(n) && n > 0 ? n : DEFAULT_DAILY_BUDGET_USD;
}

export async function spentLast24hUsd(accountId: string): Promise<number> {
  const { rows } = await pool.query(
    `select coalesce(sum(r.cost_usd), 0)::float as spent from runs r join tenants t on t.id = r.tenant_id
     where t.account_id = $1 and r.created_at > now() - interval '24 hours'`,
    [accountId],
  );
  return rows[0].spent as number;
}

export function spendGuard(accountId: string): SpendGuard {
  return async (spentThisRun) => {
    const budget = await dailyBudgetUsd(accountId);
    if (budget === null) return;
    const spent = (await spentLast24hUsd(accountId)) + spentThisRun;
    if (spent >= budget) {
      throw new Error(`Daily AI budget of $${budget.toFixed(2)} reached ($${spent.toFixed(2)} used in the last 24 hours). Raise it in Settings or try again later.`);
    }
  };
}

const recent = new Map<string, number[]>();

/** Throws (HTTP 429) when a workspace starts too many runs in a minute. In-memory: per API instance. */
export function checkRunRate(accountId: string): void {
  const now = Date.now();
  const list = (recent.get(accountId) ?? []).filter((t) => now - t < 60_000);
  if (list.length >= RUNS_PER_MINUTE) {
    throw Object.assign(new Error(`Too many runs: at most ${RUNS_PER_MINUTE} per minute per workspace. Try again shortly.`), { statusCode: 429 });
  }
  list.push(now);
  recent.set(accountId, list);
}
