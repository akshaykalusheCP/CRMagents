import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { decrypt, encrypt } from '../crypto.js';
import { pool } from '../db.js';
import { getSetting, setSetting } from '../settings.js';
import { anthropicClient } from './llm.js';
import { openAiCompatible, type AiClient, type Provider } from './provider.js';
import { withAiLog } from '../trust/aiLog.js';
import { audit } from '../trust/audit.js';

// AI keys: a workspace keeps several (Claude, OpenAI, Gemini, any OpenAI-compatible service), tests them, and picks
// one primary that everything uses. Backup keys are tried in order when the primary fails for a reason another key
// can fix (bad key, no credit, rate limit, provider down). Keys are encrypted; only a short hint is ever shown.

export const BASE_URLS: Record<Exclude<Provider, 'anthropic' | 'compatible'>, string> = {
  openai: 'https://api.openai.com/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai',
};
export const PROVIDER_LABEL: Record<Provider, string> = { anthropic: 'Claude (Anthropic)', openai: 'OpenAI', gemini: 'Google Gemini', compatible: 'OpenAI-compatible' };
const TEST_MODEL_CLAUDE = 'claude-haiku-5-5';

export interface KeyConfig {
  provider: Provider; key: string; baseUrl?: string | null; model?: string | null; fastModel?: string | null;
  priceIn?: number | null; priceOut?: number | null; workspaceId?: string | null;
}
interface KeyRow {
  id: string; label: string; provider: Provider; key_enc: string; key_hint: string; base_url: string | null; model: string | null; fast_model: string | null;
  price_in: string | null; price_out: string | null; workspace_id: string | null; is_primary: boolean; is_backup: boolean; sort: number;
  last_test_at: Date | null; last_test_ok: boolean | null; last_test_ms: number | null; last_test_model: string | null; last_error: string | null; last_error_at: Date | null; last_used_at: Date | null; created_at: Date;
}

/** "sk-ant-…a9F2": enough to tell keys apart, useless to anyone else. Pure; tested. */
export function keyHint(key: string) {
  const k = key.trim();
  if (k.length <= 10) return '••••';
  const head = (/^(sk-ant-[a-z0-9]+-|sk-proj-|sk-|AIza|re_)/.exec(k)?.[0] ?? k.slice(0, 3));
  return `${head}…${k.slice(-4)}`;
}

/** Which failures another key could fix (worth trying a backup). A bad request would fail on every key. Pure; tested. */
export function canFailOver(e: unknown) {
  const err = e as { status?: number; statusCode?: number; message?: string };
  const status = err?.status ?? err?.statusCode;
  if (status && [401, 402, 403, 404, 408, 429, 500, 502, 503, 504, 529].includes(status)) return true;
  return /credit|quota|insufficient|billing|overloaded|rate.?limit|invalid.*(api.?key|x-api-key)|authentication|permission|timed? ?out|ECONN|fetch failed/i.test(err?.message ?? String(e));
}

/** A provider's error, in words a person can act on. Pure; tested. */
export function explainError(e: unknown) {
  const err = e as { status?: number; message?: string };
  const m = err?.message ?? String(e);
  const s = err?.status;
  if (s === 401 || /invalid.*(api.?key|x-api-key)|incorrect api key|authentication/i.test(m)) return 'The provider rejected this key (wrong, revoked or expired).';
  if (s === 402 || /credit|insufficient|billing|quota/i.test(m)) return 'This key has no credit left (or its billing is not set up).';
  if (s === 403 || /permission/i.test(m)) return 'This key is not allowed to use this model or workspace.';
  if (s === 404 || /model.*(not.?found|does not exist)|unknown model|no longer available/i.test(m)) {
    // Providers that retire a model often name its replacement ("…use models/gemini-3.8-flash…").
    const next = /\buse (?:models\/)?([a-z0-9][\w.-]*[a-z0-9])\b/i.exec(m)?.[1];
    return next ? `This model is no longer available for this key. Choose ${next} instead.` : 'The model name was not found for this key.';
  }
  if (s === 429 || /rate.?limit/i.test(m)) return 'The provider is rate limiting this key right now.';
  if (s === 529 || /overloaded/i.test(m)) return 'The provider is overloaded right now; try again shortly.';
  if (/ENOTFOUND|ECONN|fetch failed|timed? ?out/i.test(m)) return 'Could not reach the provider (check the base URL).';
  return m.replace(/\s+/g, ' ').slice(0, 240);
}

export function clientFor(c: KeyConfig): AiClient {
  if (c.provider === 'anthropic') return anthropicClient(c.key, c.workspaceId || undefined);
  const baseUrl = c.provider === 'compatible' ? c.baseUrl : BASE_URLS[c.provider];
  if (!baseUrl) throw Object.assign(new Error('Add the provider\'s base URL.'), { statusCode: 400 });
  if (!c.model) throw Object.assign(new Error('Add the model name.'), { statusCode: 400 });
  return openAiCompatible({ baseUrl, key: c.key, model: c.model, fastModel: c.fastModel || c.model, priceIn: Number(c.priceIn) || 5, priceOut: Number(c.priceOut) || 15 });
}

const configOf = (r: KeyRow): KeyConfig => ({ provider: r.provider, key: decrypt(r.key_enc), baseUrl: r.base_url, model: r.model, fastModel: r.fast_model, priceIn: r.price_in == null ? null : Number(r.price_in), priceOut: r.price_out == null ? null : Number(r.price_out), workspaceId: r.workspace_id });

/** A tiny real request (a few tokens) through this key: OK with time and model, or the provider's reason. */
export async function testKey(accountId: string, c: KeyConfig) {
  const model = c.provider === 'anthropic' ? TEST_MODEL_CLAUDE : (c.model ?? '');
  const t0 = Date.now();
  try {
    const client = withAiLog(clientFor(c), accountId, c.provider, { purpose: 'Testing an AI key' });
    const res: any = await client.messages.create({ model, max_tokens: 8, messages: [{ role: 'user', content: 'Reply with the single word OK.' }] } as never);
    const text = (res.content ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('').trim();
    return { ok: true as const, ms: Date.now() - t0, model: res.model ?? model, reply: text.slice(0, 40) };
  } catch (e) {
    return { ok: false as const, ms: Date.now() - t0, model, error: explainError(e) };
  }
}

const one = async (accountId: string, id: string) => {
  const { rows } = await pool.query('select * from ai_keys where id=$1 and account_id=$2', [id, accountId]);
  if (!rows[0]) throw Object.assign(new Error('Key not found'), { statusCode: 404 });
  return rows[0] as KeyRow;
};

/** Keys saved the old way (one Claude key, one "other provider" key) become keys in the list, once. */
export async function adoptLegacyKeys(accountId: string) {
  const { rows } = await pool.query('select count(*)::int n from ai_keys where account_id=$1', [accountId]);
  if (rows[0].n > 0) return;
  // Only this workspace's own settings move; a platform default stays a default (used when the list is empty).
  const own = async (k: 'anthropicKey' | 'providerKey') => (await pool.query('select 1 from settings where account_id=$1 and key=$2', [accountId, k])).rowCount ? getSetting(accountId, k) : undefined;
  const provider = ((await getSetting(accountId, 'aiProvider')) || 'anthropic') as Provider;
  const claude = await own('anthropicKey'), other = await own('providerKey');
  const adds: { label: string; c: KeyConfig; primary: boolean }[] = [];
  if (claude) adds.push({ label: 'Claude key', c: { provider: 'anthropic', key: claude, workspaceId: await getSetting(accountId, 'anthropicWorkspaceId') }, primary: provider === 'anthropic' });
  if (other && provider !== 'anthropic') adds.push({ label: `${PROVIDER_LABEL[provider]} key`, primary: true, c: { provider, key: other, baseUrl: await getSetting(accountId, 'aiBaseUrl'), model: await getSetting(accountId, 'aiModel'), fastModel: await getSetting(accountId, 'aiFastModel'), priceIn: Number(await getSetting(accountId, 'aiPriceIn')) || null, priceOut: Number(await getSetting(accountId, 'aiPriceOut')) || null } });
  if (adds.length && !adds.some((a) => a.primary)) adds[0].primary = true;
  for (const [i, a] of adds.entries()) await insertKey(accountId, a.label, a.c, 'moved from earlier settings', a.primary, i);
}

async function insertKey(accountId: string, label: string, c: KeyConfig, by: string, primary: boolean, sort: number) {
  const { rows } = await pool.query(
    `insert into ai_keys (account_id, label, provider, key_enc, key_hint, base_url, model, fast_model, price_in, price_out, workspace_id, is_primary, sort, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) returning id`,
    [accountId, label, c.provider, encrypt(c.key.trim()), keyHint(c.key), c.baseUrl || null, c.model || null, c.fastModel || null, c.priceIn ?? null, c.priceOut ?? null, c.workspaceId || null, primary, sort, by]);
  return rows[0].id as string;
}

/** The keys to use, primary first then backups in order; empty = none set (the platform default may apply). */
export async function activeKeys(accountId: string) {
  await adoptLegacyKeys(accountId);
  const { rows } = await pool.query('select * from ai_keys where account_id=$1 and (is_primary or is_backup) order by is_primary desc, sort, created_at', [accountId]);
  return rows as KeyRow[];
}

/** The primary's provider (for the Trust center and the call log). */
export async function primaryProvider(accountId: string): Promise<Provider | null> {
  const k = (await activeKeys(accountId))[0];
  return k ? k.provider : null;
}

/** A Claude key for Claude-only work (reading scanned PDFs): the primary if it's Claude, else any Claude key. */
export async function claudeKey(accountId: string) {
  await adoptLegacyKeys(accountId);
  const { rows } = await pool.query("select * from ai_keys where account_id=$1 and provider='anthropic' order by is_primary desc, is_backup desc, sort limit 1", [accountId]);
  if (rows[0]) return { key: decrypt(rows[0].key_enc), workspaceId: rows[0].workspace_id as string | null };
  const key = await getSetting(accountId, 'anthropicKey');
  return key ? { key, workspaceId: (await getSetting(accountId, 'anthropicWorkspaceId')) ?? null } : null;
}

/** One client over the primary and its backups: each request tries them in order while the failure is one another
 *  key could fix. Every attempt is in the AI call log; a switch is noted on the key that failed. */
/** Try each attempt in order; move on only when another key could fix the failure. Pure; tested. */
export async function inOrder<T>(attempts: { id: string; run: () => Promise<T> }[], seen: { used?: (id: string) => void; failed?: (id: string, e: unknown) => void } = {}): Promise<T> {
  let last: unknown;
  for (const [i, a] of attempts.entries()) {
    try { const r = await a.run(); seen.used?.(a.id); return r; } catch (e) {
      last = e; seen.failed?.(a.id, e);
      if (i === attempts.length - 1 || !canFailOver(e)) throw e;
    }
  }
  throw last;
}

export function failoverClient(accountId: string, keys: KeyRow[], ctx: Parameters<typeof withAiLog>[3] = {}): AiClient {
  const clients = keys.map((k) => ({ k, c: withAiLog(clientFor(configOf(k)), accountId, k.provider, ctx) }));
  // A Claude model name means nothing to another provider: there it maps to that key's own models (provider.ts).
  const create = (params: any, options?: any) => inOrder(clients.map(({ k, c }) => ({ id: k.id, run: () => (c.messages.create as any)(params, options) })), {
    used: (id) => void pool.query('update ai_keys set last_used_at=now() where id=$1', [id]).catch(() => undefined),
    failed: (id, e) => void pool.query('update ai_keys set last_error=$2, last_error_at=now() where id=$1', [id, explainError(e)]).catch(() => undefined),
  });
  const primary = clients[0].c.messages;
  return { messages: new Proxy(primary, { get: (t, p) => (p === 'create' ? create : (t as any)[p]) }) } as AiClient;
}

const keyBody = z.object({
  label: z.string().trim().min(1).max(60),
  provider: z.enum(['anthropic', 'openai', 'gemini', 'compatible']),
  key: z.string().trim().min(8, 'Paste the API key').max(500),
  baseUrl: z.string().trim().url('Base URL must be a full https:// address').max(300).optional().or(z.literal('')),
  model: z.string().trim().max(120).optional(),
  fastModel: z.string().trim().max(120).optional(),
  priceIn: z.coerce.number().min(0).max(1000).optional(),
  priceOut: z.coerce.number().min(0).max(1000).optional(),
  workspaceId: z.string().trim().max(80).optional(),
});
const needsModel = (b: { provider: string; model?: string; baseUrl?: string }) => {
  if (b.provider !== 'anthropic' && !b.model) throw Object.assign(new Error('Add the model name for this provider.'), { statusCode: 400 });
  if (b.provider === 'compatible' && !b.baseUrl) throw Object.assign(new Error('Add the provider\'s base URL.'), { statusCode: 400 });
};

function view(r: KeyRow) {
  return {
    id: r.id, label: r.label, provider: r.provider, hint: r.key_hint, baseUrl: r.base_url, model: r.model, fastModel: r.fast_model,
    priceIn: r.price_in == null ? null : Number(r.price_in), priceOut: r.price_out == null ? null : Number(r.price_out), workspaceId: r.workspace_id,
    primary: r.is_primary, backup: r.is_backup, sort: r.sort,
    lastTest: r.last_test_at ? { at: r.last_test_at, ok: r.last_test_ok, ms: r.last_test_ms, model: r.last_test_model } : null,
    lastError: r.last_error ? { at: r.last_error_at, message: r.last_error } : null, lastUsedAt: r.last_used_at, createdAt: r.created_at,
  };
}

export function registerAiKeys(app: FastifyInstance) {
  app.get('/api/ai-keys', async (req) => {
    const a = req.user!.accountId;
    await adoptLegacyKeys(a);
    const { rows } = await pool.query('select * from ai_keys where account_id=$1 order by is_primary desc, is_backup desc, sort, created_at', [a]);
    const platformDefault = !rows.length && !!(await getSetting(a, 'anthropicKey') || await getSetting(a, 'providerKey'));
    return { keys: (rows as KeyRow[]).map(view), platformDefault };
  });

  // Test a key before saving it (nothing is stored).
  app.post('/api/ai-keys/test', async (req) => {
    const b = keyBody.omit({ label: true }).parse(req.body);
    needsModel(b);
    return testKey(req.user!.accountId, { ...b, baseUrl: b.baseUrl || null });
  });

  app.post('/api/ai-keys', async (req) => {
    const u = req.user!;
    const b = keyBody.extend({ makePrimary: z.boolean().optional() }).parse(req.body);
    needsModel(b);
    const { rows } = await pool.query('select count(*)::int n, coalesce(max(sort), -1)::int s, bool_or(is_primary) p from ai_keys where account_id=$1', [u.accountId]);
    const primary = !!b.makePrimary || !rows[0].p;
    const client = await pool.connect();
    try {
      await client.query('begin');
      if (primary) await client.query('update ai_keys set is_primary=false where account_id=$1', [u.accountId]);
      await client.query('commit');
    } finally { client.release(); }
    const id = await insertKey(u.accountId, b.label, { ...b, baseUrl: b.baseUrl || null }, u.email, primary, rows[0].s + 1);
    await audit(u.accountId, u.email, `Added AI key "${b.label}" (${PROVIDER_LABEL[b.provider]})${primary ? ' as primary' : ''}`, {});
    return view(await one(u.accountId, id));
  });

  app.put('/api/ai-keys/:id', async (req) => {
    const u = req.user!;
    const r = await one(u.accountId, (req.params as { id: string }).id);
    const b = keyBody.partial().extend({ backup: z.boolean().optional(), sort: z.number().int().min(0).max(1000).optional() }).parse(req.body);
    const merged = { provider: r.provider, model: b.model ?? r.model ?? undefined, baseUrl: b.baseUrl ?? r.base_url ?? undefined };
    needsModel(merged);
    await pool.query(
      `update ai_keys set label=coalesce($3,label), key_enc=coalesce($4,key_enc), key_hint=coalesce($5,key_hint), base_url=coalesce($6,base_url), model=coalesce($7,model),
         fast_model=coalesce($8,fast_model), price_in=coalesce($9,price_in), price_out=coalesce($10,price_out), workspace_id=coalesce($11,workspace_id),
         is_backup=case when is_primary then false else coalesce($12,is_backup) end, sort=coalesce($13,sort),
         last_test_at=case when $4::text is null then last_test_at end, last_test_ok=case when $4::text is null then last_test_ok end
       where id=$1 and account_id=$2`,
      [r.id, u.accountId, b.label ?? null, b.key ? encrypt(b.key.trim()) : null, b.key ? keyHint(b.key) : null, b.baseUrl || null, b.model || null, b.fastModel || null,
        b.priceIn ?? null, b.priceOut ?? null, b.workspaceId || null, b.backup ?? null, b.sort ?? null]);
    if (b.key) await audit(u.accountId, u.email, `Replaced the AI key "${r.label}"`, {});
    return view(await one(u.accountId, r.id));
  });

  app.post('/api/ai-keys/:id/primary', async (req) => {
    const u = req.user!;
    const r = await one(u.accountId, (req.params as { id: string }).id);
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query('update ai_keys set is_primary=false where account_id=$1 and is_primary', [u.accountId]);
      await client.query('update ai_keys set is_primary=true, is_backup=false where id=$1', [r.id]);
      await client.query('commit');
    } catch (e) { await client.query('rollback'); throw e; } finally { client.release(); }
    // Settings that describe "the provider" follow the primary (Trust center, call log).
    await setSetting(u.accountId, 'aiProvider', r.provider === 'anthropic' ? '' : r.provider);
    await audit(u.accountId, u.email, `Made "${r.label}" the primary AI key`, {});
    return { ok: true };
  });

  // The saved key, optionally with settings changed in the form but not saved yet (model, base URL, workspace).
  app.post('/api/ai-keys/:id/test', async (req) => {
    const u = req.user!;
    const r = await one(u.accountId, (req.params as { id: string }).id);
    const o = z.object({ model: z.string().trim().max(200).optional(), baseUrl: z.string().trim().max(500).optional(), workspaceId: z.string().trim().max(200).optional() }).parse(req.body ?? {});
    const saved = configOf(r);
    const c = { ...saved, model: o.model || saved.model, baseUrl: o.baseUrl || saved.baseUrl, workspaceId: o.workspaceId || saved.workspaceId };
    const draft = c.model !== saved.model || c.baseUrl !== saved.baseUrl || c.workspaceId !== saved.workspaceId;
    const t = await testKey(u.accountId, c);
    if (draft) return t; // not what's saved: the key's status stays as it was
    await pool.query('update ai_keys set last_test_at=now(), last_test_ok=$2, last_test_ms=$3, last_test_model=$4, last_error=case when $2 then last_error else $5 end, last_error_at=case when $2 then last_error_at else now() end where id=$1',
      [r.id, t.ok, t.ms, t.model, t.ok ? null : t.error]);
    return t;
  });

  app.delete('/api/ai-keys/:id', async (req) => {
    const u = req.user!;
    const r = await one(u.accountId, (req.params as { id: string }).id);
    await pool.query('delete from ai_keys where id=$1', [r.id]);
    if (r.is_primary) {
      // The first backup (or any remaining key) takes over, so agents keep running.
      const { rows } = await pool.query('select id, label, provider from ai_keys where account_id=$1 order by is_backup desc, sort, created_at limit 1', [u.accountId]);
      if (rows[0]) {
        await pool.query('update ai_keys set is_primary=true, is_backup=false where id=$1', [rows[0].id]);
        await setSetting(u.accountId, 'aiProvider', rows[0].provider === 'anthropic' ? '' : rows[0].provider);
      }
    }
    // Keys from the old single-key settings must not come back after being removed here.
    await setSetting(u.accountId, r.provider === 'anthropic' ? 'anthropicKey' : 'providerKey', '');
    await audit(u.accountId, u.email, `Removed the AI key "${r.label}"`, {});
    return { ok: true };
  });
}
