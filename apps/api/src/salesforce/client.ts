import { config } from '../config.js';
import { decrypt, encrypt } from '../crypto.js';
import { pool } from '../db.js';
import { getSfConfig } from '../settings.js';

export const RECONNECT_MESSAGE =
  'The Salesforce login for this org has expired or was revoked. Reconnect the org on the Connections page.';

// Access tokens are shared per org across requests, and refreshes are single-flight: with refresh-token
// rotation every refresh returns a new refresh token and retires the old one, so two concurrent refreshes with
// the same token would lock the org out.
const accessCache = new Map<string, { token: string; expiresAt: number }>();
const refreshing = new Map<string, Promise<string>>();
const ACCESS_TTL_MS = 25 * 60_000;

/** Seed the cache with the access token from a fresh OAuth login (also drops any stale one). */
export function primeAccessToken(tenantId: string, token: string): void {
  accessCache.set(tenantId, { token, expiresAt: Date.now() + ACCESS_TTL_MS });
}

/** Forget the cached access token (tests, or after a disconnect). */
export function forgetAccessToken(tenantId: string): void {
  accessCache.delete(tenantId);
}

export class SalesforceClient {
  private constructor(
    private tenantId: string,
    private accountId: string,
    private own: { clientId: string; clientSecret: string } | undefined,
    private instanceUrl: string,
  ) {}

  static async forTenant(tenantId: string): Promise<SalesforceClient> {
    const { rows } = await pool.query(
      'select account_id, sf_instance_url, sf_client_id, sf_client_secret_enc from tenants where id = $1',
      [tenantId],
    );
    if (!rows[0]) throw new Error('Unknown tenant');
    return new SalesforceClient(
      tenantId,
      rows[0].account_id,
      rows[0].sf_client_id ? { clientId: rows[0].sf_client_id, clientSecret: rows[0].sf_client_secret_enc ? decrypt(rows[0].sf_client_secret_enc) : '' } : undefined,
      rows[0].sf_instance_url,
    );
  }

  /** Instance URL and a current access token, for the streaming client. `fresh` drops the cached token first. */
  async session(fresh = false): Promise<{ instanceUrl: string; token: string }> {
    if (fresh) accessCache.delete(this.tenantId);
    return { instanceUrl: this.instanceUrl, token: await this.token() };
  }

  private async token(): Promise<string> {
    const cached = accessCache.get(this.tenantId);
    if (cached && Date.now() < cached.expiresAt) return cached.token;
    let p = refreshing.get(this.tenantId);
    if (!p) {
      p = this.refresh().finally(() => refreshing.delete(this.tenantId));
      refreshing.set(this.tenantId, p);
    }
    return p;
  }

  private async refresh(): Promise<string> {
    const sf = this.own ?? (await getSfConfig(this.accountId));
    const db = await pool.connect();
    try {
      // Row lock: only one API instance refreshes an org at a time, and it reads the latest (rotated) token.
      await db.query('begin');
      const { rows } = await db.query('select refresh_token_enc from tenants where id=$1 for update', [this.tenantId]);
      if (!rows[0]) throw new Error('Unknown tenant');
      const refreshToken = decrypt(rows[0].refresh_token_enc);
      const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: sf.clientId });
      if (sf.clientSecret) body.set('client_secret', sf.clientSecret);
      const res = await fetch(`${this.instanceUrl}/services/oauth2/token`, { method: 'POST', body });
      if (!res.ok) {
        const text = await res.text();
        if (/invalid_grant/.test(text)) {
          // The org revoked or expired our access: flag it so the app shows "Reconnect" instead of failing silently.
          await db.query("update tenants set setup_status='error', setup_message=$2 where id=$1", [this.tenantId, RECONNECT_MESSAGE]);
          await db.query('commit');
          throw new Error(RECONNECT_MESSAGE);
        }
        throw new Error(`Salesforce token refresh failed: ${text}`);
      }
      const j = (await res.json()) as { access_token: string; refresh_token?: string };
      if (j.refresh_token && j.refresh_token !== refreshToken) {
        await db.query('update tenants set refresh_token_enc=$2 where id=$1', [this.tenantId, encrypt(j.refresh_token)]);
      }
      await db.query('commit');
      accessCache.set(this.tenantId, { token: j.access_token, expiresAt: Date.now() + ACCESS_TTL_MS });
      return j.access_token;
    } catch (e) {
      await db.query('rollback').catch(() => {});
      throw e;
    } finally {
      db.release();
    }
  }

  private async call<T>(method: string, path: string, body?: unknown, retried = false): Promise<T> {
    const res = await fetch(`${this.instanceUrl}/services/data/${config.sf.apiVersion}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${await this.token()}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401 && !retried) {
      // Access token expired or was revoked early: drop it and retry once with a fresh one.
      accessCache.delete(this.tenantId);
      return this.call<T>(method, path, body, true);
    }
    if (!res.ok) throw new Error(`Salesforce ${method} ${path} -> ${res.status}: ${await res.text()}`);
    return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
  }

  /** Any REST call under /services/data/vXX (e.g. /actions/standard/customNotificationAction). */
  rest<T = any>(method: string, path: string, body?: unknown) {
    return this.call<T>(method, path, body);
  }

  /** Tooling API (package installs, remote sites). `path` starts after /tooling, e.g. /sobjects/X. */
  tooling<T = any>(method: string, path: string, body?: unknown) {
    return this.call<T>(method, `/tooling${path}`, body);
  }

  toolingQuery<T = any>(soql: string) {
    return this.tooling<{ records: T[] }>('GET', `/query?q=${encodeURIComponent(soql)}`);
  }

  async query(soql: string) {
    const r = await this.call<{ totalSize: number; records: unknown[] }>('GET', `/query?q=${encodeURIComponent(soql)}`);
    return { totalSize: r.totalSize, records: r.records.map((x) => compactRecord(x)) };
  }

  /** All objects in the org (name, labels, flags). */
  async describeGlobal() {
    const r = await this.call<{ sobjects: GlobalObject[] }>('GET', '/sobjects');
    return r.sobjects;
  }

  async describe(sobject: string) {
    const d = await this.call<{ fields: DescribeField[] }>('GET', `/sobjects/${encodeURIComponent(sobject)}/describe`);
    return d.fields;
  }

  /** `fields` limits the response to those fields (fewer tokens downstream). */
  async getRecord(sobject: string, id: string, fields?: string[]) {
    const qs = fields?.length ? `?fields=${encodeURIComponent(fields.join(','))}` : '';
    const r = await this.call('GET', `/sobjects/${encodeURIComponent(sobject)}/${encodeURIComponent(id)}${qs}`);
    return compactRecord(r);
  }

  /** Invocable actions: the org's own Apex (@InvocableMethod), autolaunched Flows, and standard actions. */
  private actionPath(kind: ActionKind, name = '') {
    const base = kind === 'standard' ? '/actions/standard' : `/actions/custom/${kind}`;
    return name ? `${base}/${encodeURIComponent(name)}` : base;
  }

  async listActions(kind: ActionKind) {
    const r = await this.call<{ actions: { name: string; label: string; type: string }[] }>('GET', this.actionPath(kind));
    return r.actions ?? [];
  }

  describeAction(kind: ActionKind, name: string) {
    return this.call<ActionDescribe>('GET', this.actionPath(kind, name));
  }

  /** Runs one action with one set of inputs. Throws with Salesforce's message when it reports a failure. */
  async runAction(kind: ActionKind, name: string, inputs: Record<string, unknown>) {
    const r = await this.call<{ isSuccess: boolean; outputValues: Record<string, unknown> | null; errors: { message: string }[] | null }[]>(
      'POST', this.actionPath(kind, name), { inputs: [inputs] },
    );
    const first = r[0];
    if (!first?.isSuccess) throw new Error(first?.errors?.map((e) => e.message).join('; ') || `Action ${name} failed`);
    return compactRecord(first.outputValues ?? {}) as Record<string, unknown>;
  }

  createRecord(sobject: string, fields: Record<string, unknown>) {
    return this.call<{ id: string }>('POST', `/sobjects/${encodeURIComponent(sobject)}`, fields);
  }

  updateRecord(sobject: string, id: string, fields: Record<string, unknown>) {
    return this.call<void>('PATCH', `/sobjects/${encodeURIComponent(sobject)}/${encodeURIComponent(id)}`, fields);
  }
}

export type ActionKind = 'apex' | 'flow' | 'standard';
export interface ActionParam { name: string; label: string; type: string; required: boolean; description: string | null; sobjectType?: string | null }
export interface ActionDescribe { name: string; label: string; description: string | null; type: string; inputs: ActionParam[]; outputs: ActionParam[] }

export interface GlobalObject {
  name: string;
  label: string;
  labelPlural: string;
  queryable: boolean;
  createable: boolean;
  custom: boolean;
}

export interface DescribeField {
  name: string;
  label: string;
  type: string;
  updateable: boolean;
  createable?: boolean;
  referenceTo?: string[];
  picklistValues?: { value: string; active: boolean }[];
}

/**
 * Drop Salesforce's per-record `attributes` blobs and empty fields (recursively). Records go into AI prompts,
 * and on wide objects most fields are null, so this removes a large share of tokens without losing information.
 */
export function compactRecord(v: unknown): any {
  if (Array.isArray(v)) return v.map(compactRecord);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (k === 'attributes' || val === null || val === undefined || val === '') continue;
      out[k] = compactRecord(val);
    }
    return out;
  }
  return v;
}
