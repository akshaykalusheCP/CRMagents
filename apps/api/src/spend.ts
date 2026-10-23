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

/** Assistant answers people are waiting for, per minute, by plan. Agent runs keep their own limit (above). */
export const ASKS_PER_MINUTE: Record<string, number> = { basic: 20, plus: 60, pro: 120, promax: 240 };
const asks = new Map<string, number[]>();

/** How long to wait for a free slot (0 = go now). Pure; tested. */
export function slotWait(times: number[], now: number, perMinute: number): number {
  const recent = times.filter((t) => now - t < 60_000);
  if (recent.length < perMinute) return 0;
  return 60_000 - (now - recent[recent.length - perMinute]) + 5;
}

/** Waits (up to maxWaitMs) for a free slot when many people ask at once, instead of failing straight away. */
export async function waitForAskSlot(accountId: string, perMinute: number, maxWaitMs = 20_000): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    const now = Date.now();
    const list = (asks.get(accountId) ?? []).filter((t) => now - t < 60_000);
    const wait = slotWait(list, now, perMinute);
    if (wait === 0) { list.push(now); asks.set(accountId, list); return; }
    if (now + wait - t0 > maxWaitMs) {
      throw Object.assign(new Error(`Lots of questions right now (more than ${perMinute} a minute for this workspace). Ask again in a few seconds, or upgrade for a higher limit.`), { statusCode: 429 });
    }
    await new Promise((r) => setTimeout(r, Math.min(wait, 2_000)));
  }
}

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
