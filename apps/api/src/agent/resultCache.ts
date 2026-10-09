import { createHash } from 'node:crypto';
import { pool } from '../db.js';
import { getSetting } from '../settings.js';

// Answers to AI calls whose output depends only on the prompt (no live-data tools) are reused when the exact
// same request comes again within the TTL: re-runs and repeat triggers on unchanged records cost nothing.

export interface ResultCache {
  get(key: string): Promise<string | null>;
  set(key: string, text: string): Promise<void>;
}

export const DEFAULT_CACHE_HOURS = 24;

export function cacheKey(parts: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

/** undefined when reuse is turned off for the workspace (setting 0). */
export async function dbResultCache(accountId: string): Promise<ResultCache | undefined> {
  const raw = (await getSetting(accountId, 'aiCacheHours'))?.trim();
  const hours = raw === undefined || raw === '' ? DEFAULT_CACHE_HOURS : Number(raw);
  if (!Number.isFinite(hours) || hours <= 0) return undefined;
  // Keys include the workspace, so one workspace can never read another's answers.
  const scoped = (k: string) => cacheKey({ accountId, k });
  return {
    async get(key) {
      const { rows } = await pool.query(
        `select text from ai_result_cache where key=$1 and account_id=$2 and created_at > now() - ($3 || ' hours')::interval`,
        [scoped(key), accountId, String(hours)],
      );
      return rows[0]?.text ?? null;
    },
    async set(key, text) {
      await pool.query(
        `insert into ai_result_cache (key, account_id, text) values ($1,$2,$3)
         on conflict (key) do update set text=excluded.text, created_at=now()`,
        [scoped(key), accountId, text],
      );
      // Opportunistic cleanup of entries far past any TTL.
      if (Math.random() < 0.02) await pool.query("delete from ai_result_cache where created_at < now() - interval '30 days'");
    },
  };
}
