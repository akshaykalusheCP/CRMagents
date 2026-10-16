import { pool } from './db.js';

// Fixed-window counters kept in Postgres, so every API instance sees the same counts (login attempts, website
// chat, reset emails). One statement per hit.

/** Count one hit on `key`; true when it is over `max` in the current window of `windowSec`. */
export async function overLimit(key: string, max: number, windowSec: number): Promise<boolean> {
  const { rows } = await pool.query(
    `insert into rate_limits (key, n, reset_at) values ($1, 1, now() + ($2 || ' seconds')::interval)
     on conflict (key) do update set
       n = case when rate_limits.reset_at < now() then 1 else rate_limits.n + 1 end,
       reset_at = case when rate_limits.reset_at < now() then excluded.reset_at else rate_limits.reset_at end
     returning n`, [key.slice(0, 300), String(windowSec)]);
  return rows[0].n > max;
}

/** Forget a key (e.g. after a successful login). */
export async function clearLimit(key: string) {
  await pool.query('delete from rate_limits where key=$1', [key.slice(0, 300)]);
}

export async function purgeLimits() {
  await pool.query('delete from rate_limits where reset_at < now()');
}
