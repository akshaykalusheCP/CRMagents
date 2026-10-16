import { config } from '../config.js';
import { decrypt, encrypt } from '../crypto.js';
import { pool } from '../db.js';
import { getSfConfig } from '../settings.js';
import { markExhausted, recordUsage, seedUsage } from './limits.js';
import { parseCsv } from './csv.js';

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
    readonly tenantId: string,
    readonly accountId: string,
    private own: { clientId: string; clientSecret: string } | undefined,
    readonly instanceUrl: string,
  ) {}

  static async forTenant(tenantId: string): Promise<SalesforceClient> {
    const { rows } = await pool.query(
      'select account_id, sf_instance_url, sf_client_id, sf_client_secret_enc, api_used, api_max, api_checked_at from tenants where id = $1',
      [tenantId],
    );
    if (!rows[0]) throw new Error('Unknown tenant');
    seedUsage(tenantId, rows[0].api_used, rows[0].api_max, rows[0].api_checked_at);
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

  /**
   * One HTTP request to the org. `path` is relative to /services/data/vXX unless it starts with /services/.
   * Every response reports the org's API usage, which feeds the budget (limits.ts).
   */
  private async request(method: string, path: string, o: { body?: string; type?: string; accept?: string } = {}, retried = false): Promise<Response> {
    this.calls++;
    const url = path.startsWith('/services/') ? `${this.instanceUrl}${path}` : `${this.instanceUrl}/services/data/${config.sf.apiVersion}${path}`;
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${await this.token()}`,
        ...(o.body !== undefined ? { 'Content-Type': o.type ?? 'application/json' } : {}),
        ...(o.accept ? { Accept: o.accept } : {}),
      },
      body: o.body,
    });
    recordUsage(this.tenantId, res.headers.get('sforce-limit-info'));
    if (res.status === 401 && !retried) {
      // Access token expired or was revoked early: drop it and retry once with a fresh one.
      accessCache.delete(this.tenantId);
      return this.request(method, path, o, true);
    }
    if (!res.ok) {
      const text = await res.text();
      if (res.status === 403 && /REQUEST_LIMIT_EXCEEDED/.test(text)) {
        markExhausted(this.tenantId);
        throw Object.assign(new Error('This Salesforce org has used its whole daily API allowance. CRMagents resumes automatically as the allowance frees up over the next hours.'), { statusCode: 429 });
      }
      throw new Error(`Salesforce ${method} ${path.split('?')[0]} -> ${res.status}: ${text}`);
    }
    return res;
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.request(method, path, body === undefined ? {} : { body: JSON.stringify(body) });
    return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
  }

  /** API calls this client has made (for tests and run logs). */
  calls = 0;

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

  /**
   * One page of results (up to 2,000 rows). Queries started together (Promise.all) go to Salesforce as one
   * composite batch of up to 25, which counts as a single API call.
   */
  query(soql: string): Promise<{ totalSize: number; records: any[]; done?: boolean; nextRecordsUrl?: string }> {
    return new Promise((resolve, reject) => {
      this.queued.push({ soql, resolve, reject });
      if (this.queued.length === 1) setImmediate(() => void this.flushQueries());
    }).then((r: any) => ({ totalSize: r.totalSize, records: r.records.map((x: unknown) => compactRecord(x)), done: r.done, nextRecordsUrl: r.nextRecordsUrl }));
  }

  private queued: { soql: string; resolve: (v: unknown) => void; reject: (e: unknown) => void }[] = [];

  private async flushQueries() {
    const all = this.queued.splice(0);
    for (let i = 0; i < all.length; i += BATCH_SIZE) {
      const part = all.slice(i, i + BATCH_SIZE);
      if (part.length === 1) {
        await this.call('GET', `/query?q=${encodeURIComponent(part[0].soql)}`).then(part[0].resolve, part[0].reject);
        continue;
      }
      try {
        const r = await this.call<{ results: { statusCode: number; result: any }[] }>('POST', '/composite/batch', {
          haltOnError: false,
          batchRequests: part.map((q) => ({ method: 'GET', url: `${config.sf.apiVersion}/query?q=${encodeURIComponent(q.soql)}` })),
        });
        part.forEach((q, j) => {
          const one = r.results[j];
          if (one && one.statusCode < 300) q.resolve(one.result);
          else q.reject(new Error(`Salesforce query -> ${one?.statusCode}: ${JSON.stringify(one?.result ?? '').slice(0, 500)}`));
        });
      } catch (e) {
        for (const q of part) q.reject(e);
      }
    }
  }

  /**
   * All rows up to `max`, using the cheapest way for the size: one call up to 2,000 rows, following pages up to
   * BULK_OVER rows, and a Bulk API 2.0 job above that (a few calls for any number of rows).
   */
  async queryAll(soql: string, max = 50_000): Promise<{ totalSize: number; records: any[]; via: 'rest' | 'bulk' }> {
    const first = await this.query(soql);
    if (first.done !== false || first.records.length >= max) return { totalSize: first.totalSize, records: first.records.slice(0, max), via: 'rest' };
    if (first.totalSize > BULK_OVER && max > BULK_OVER && !/\b(count|sum|avg|min|max)\s*\(|\bgroup\s+by\b|\(\s*select\b/i.test(soql)) {
      try {
        const records = await this.bulkQuery(soql, max);
        return { totalSize: first.totalSize, records, via: 'bulk' };
      } catch { /* some queries can't run in bulk (e.g. certain relationship fields): page through instead */ }
    }
    const records = [...first.records];
    let next = first.nextRecordsUrl;
    while (next && records.length < max) {
      const page = await this.call<{ records: unknown[]; nextRecordsUrl?: string }>('GET', next);
      records.push(...page.records.map((x) => compactRecord(x)));
      next = page.nextRecordsUrl;
    }
    return { totalSize: first.totalSize, records: records.slice(0, max), via: 'rest' };
  }

  /** Bulk API 2.0 query: create the job, wait for it, read the CSV results in large pages. */
  async bulkQuery(soql: string, max = 1_000_000, timeoutMs = 10 * 60_000): Promise<any[]> {
    const job = await this.call<{ id: string }>('POST', '/jobs/query', { operation: 'query', query: soql });
    await this.waitForJob(`/jobs/query/${job.id}`, timeoutMs);
    const out: any[] = [];
    let locator = '';
    do {
      const res = await this.request('GET', `/jobs/query/${job.id}/results?maxRecords=${Math.min(max - out.length, 100_000)}${locator ? `&locator=${locator}` : ''}`, { accept: 'text/csv' });
      out.push(...csvToRecords(await res.text()));
      locator = res.headers.get('sforce-locator') ?? 'null';
    } while (locator && locator !== 'null' && out.length < max);
    return out.slice(0, max);
  }

  private async waitForJob(path: string, timeoutMs: number): Promise<any> {
    const start = Date.now();
    for (let wait = 1000; ; wait = Math.min(wait * 2, 10_000)) {
      const j = await this.call<{ state: string; errorMessage?: string }>('GET', path);
      if (j.state === 'JobComplete') return j;
      if (j.state === 'Failed' || j.state === 'Aborted') throw new Error(`Salesforce bulk job ${j.state.toLowerCase()}: ${j.errorMessage ?? ''}`);
      if (Date.now() - start > timeoutMs) throw new Error('Salesforce bulk job is taking too long');
      await new Promise((r) => setTimeout(r, wait));
    }
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

  /** Files attached to a record (latest versions), newest first. */
  async listFiles(recordId: string): Promise<RecordFile[]> {
    if (!/^[a-zA-Z0-9]{15,18}$/.test(recordId)) throw new Error('Bad record Id');
    const r = await this.query(
      `SELECT ContentDocumentId, ContentDocument.Title, ContentDocument.FileExtension, ContentDocument.ContentSize, ContentDocument.LatestPublishedVersionId, ContentDocument.LastModifiedDate FROM ContentDocumentLink WHERE LinkedEntityId = '${recordId}' ORDER BY ContentDocument.LastModifiedDate DESC LIMIT 50`);
    return r.records.map((x: any) => ({
      documentId: x.ContentDocumentId, versionId: x.ContentDocument?.LatestPublishedVersionId, title: x.ContentDocument?.Title ?? '',
      extension: String(x.ContentDocument?.FileExtension ?? '').toLowerCase(), size: Number(x.ContentDocument?.ContentSize ?? 0),
    }));
  }

  /** A file's bytes (one call). */
  async downloadFile(versionId: string): Promise<Buffer> {
    if (!/^068[a-zA-Z0-9]{12,15}$/.test(versionId)) throw new Error('Bad file version Id');
    const res = await this.request('GET', `/sobjects/ContentVersion/${versionId}/VersionData`);
    return Buffer.from(await res.arrayBuffer());
  }

  /** Attaches a new file to a record. */
  async attachFile(recordId: string, title: string, fileName: string, data: Buffer) {
    const r = await this.call<{ id: string }>('POST', '/sobjects/ContentVersion', {
      Title: title.slice(0, 255), PathOnClient: fileName, VersionData: data.toString('base64'), FirstPublishLocationId: recordId,
    });
    return { versionId: r.id };
  }

  deleteRecord(sobject: string, id: string) {
    return this.call<void>('DELETE', `/sobjects/${encodeURIComponent(sobject)}/${encodeURIComponent(id)}`);
  }

  /** Creates or updates by an external Id field: no lookup call needed to know whether the record exists. */
  async upsertRecord(sobject: string, externalIdField: string, externalId: string, fields: Record<string, unknown>) {
    const r = await this.call<{ id: string; created: boolean } | undefined>('PATCH', `/sobjects/${encodeURIComponent(sobject)}/${encodeURIComponent(externalIdField)}/${encodeURIComponent(externalId)}`, fields);
    return { id: r?.id ?? '', created: r?.created ?? false };
  }

  /** Deleted records too (the Recycle Bin keeps them 15 days): one page of an ALL ROWS query. */
  async queryWithDeleted(soql: string) {
    const r = await this.call<{ totalSize: number; records: unknown[] }>('GET', `/queryAll?q=${encodeURIComponent(soql)}`);
    return { totalSize: r.totalSize, records: r.records.map((x) => compactRecord(x)) as any[] };
  }

  /**
   * Many creates/updates at once, each succeeding or failing on its own. Up to 200 records go in one
   * sObject Collections call; more than BULK_OVER of one kind go through a Bulk API 2.0 job.
   * Results come back in the same order as `ops`.
   */
  async saveMany(ops: SaveOp[]): Promise<SaveResult[]> {
    const results: SaveResult[] = new Array(ops.length);
    const groups = new Map<string, number[]>();
    ops.forEach((op, i) => {
      const k = `${op.kind}:${op.sobject}`;
      groups.set(k, [...(groups.get(k) ?? []), i]);
    });
    for (const [k, idx] of groups) {
      const kind = k.split(':')[0] as SaveOp['kind'];
      const sobject = k.slice(kind.length + 1);
      if (idx.length > BULK_OVER && kind !== 'delete') {
        const r = await this.bulkSave(kind, sobject, idx.map((i) => ops[i]));
        idx.forEach((i, j) => { results[i] = r[j]; });
        continue;
      }
      for (let c = 0; c < idx.length; c += COLLECTION_SIZE) {
        const part = idx.slice(c, c + COLLECTION_SIZE);
        if (kind === 'delete') {
          const r = await this.call<{ id?: string; success: boolean; errors: { message: string; statusCode: string }[] }[]>(
            'DELETE', `/composite/sobjects?allOrNone=false&ids=${part.map((i) => encodeURIComponent(String(ops[i].id))).join(',')}`);
          part.forEach((i, j) => {
            const x = r[j];
            results[i] = x?.success ? { ok: true, id: ops[i].id } : { ok: false, error: x?.errors?.map((e) => `${e.statusCode}: ${e.message}`).join('; ') || 'Failed' };
          });
          continue;
        }
        const r = await this.call<{ id?: string; success: boolean; errors: { message: string; statusCode: string }[] }[]>(
          kind === 'create' ? 'POST' : 'PATCH', '/composite/sobjects', {
            allOrNone: false,
            records: part.map((i) => ({ attributes: { type: sobject }, ...ops[i].fields, ...(kind === 'update' ? { Id: ops[i].id } : {}) })),
          },
        );
        part.forEach((i, j) => {
          const x = r[j];
          results[i] = x?.success ? { ok: true, id: x.id ?? ops[i].id } : { ok: false, error: x?.errors?.map((e) => `${e.statusCode}: ${e.message}`).join('; ') || 'Failed' };
        });
      }
    }
    return results;
  }

  /** Bulk API 2.0 ingest (insert/update) for large volumes. */
  private async bulkSave(kind: SaveOp['kind'], sobject: string, ops: SaveOp[]): Promise<SaveResult[]> {
    const cols = [...new Set(ops.flatMap((o) => Object.keys(o.fields)))];
    const header = kind === 'update' ? ['Id', ...cols] : cols;
    // A field an op doesn't set stays empty (Bulk API leaves it unchanged); an explicit null clears it.
    const cell = (o: SaveOp, h: string) => (h === 'Id' ? csvCell(o.id) : Object.prototype.hasOwnProperty.call(o.fields, h) && o.fields[h] !== undefined ? csvCell(o.fields[h]) : '');
    const csv = [header.join(','), ...ops.map((o) => header.map((h) => cell(o, h)).join(','))].join('\n');
    const job = await this.call<{ id: string }>('POST', '/jobs/ingest', { object: sobject, operation: kind === 'create' ? 'insert' : 'update', contentType: 'CSV', lineEnding: 'LF' });
    await this.request('PUT', `/jobs/ingest/${job.id}/batches`, { body: csv, type: 'text/csv' });
    await this.call('PATCH', `/jobs/ingest/${job.id}`, { state: 'UploadComplete' });
    await this.waitForJob(`/jobs/ingest/${job.id}`, 30 * 60_000);
    // Successes and failures come back as separate files in no fixed order: updates match by Id,
    // inserts by the row as sent.
    const ok = csvToRecords(await (await this.request('GET', `/jobs/ingest/${job.id}/successfulResults`, { accept: 'text/csv' })).text(), false);
    const bad = csvToRecords(await (await this.request('GET', `/jobs/ingest/${job.id}/failedResults`, { accept: 'text/csv' })).text(), false);
    const key = (r: Record<string, unknown>) => (kind === 'update' ? String(r.Id ?? r.sf__Id ?? '').slice(0, 15) : cols.map((h) => String(r[h] ?? '')).join('\u0001'));
    const sent = (o: SaveOp) => (kind === 'update' ? String(o.id).slice(0, 15) : cols.map((h) => (o.fields[h] === null || o.fields[h] === undefined ? '' : typeof o.fields[h] === 'object' ? JSON.stringify(o.fields[h]) : String(o.fields[h]))).join('\u0001'));
    const okByKey = new Map<string, string[]>();
    for (const r of ok) okByKey.set(key(r), [...(okByKey.get(key(r)) ?? []), String(r.sf__Id ?? '')]);
    const badByKey = new Map(bad.map((r) => [key(r), String(r.sf__Error ?? 'Failed')]));
    return ops.map((o) => {
      const ids = okByKey.get(sent(o));
      if (ids?.length) return { ok: true, id: ids.shift() || o.id };
      return { ok: false, error: badByKey.get(sent(o)) ?? 'Not processed' };
    });
  }
}

const BATCH_SIZE = 25; // composite batch: subrequests per call
const COLLECTION_SIZE = 200; // sObject Collections: records per call
/** Above this many rows/records, a Bulk API 2.0 job uses fewer calls than paging or collections. */
export const BULK_OVER = 10_000;

export interface RecordFile { documentId: string; versionId: string; title: string; extension: string; size: number }

export interface SaveOp { kind: 'create' | 'update' | 'delete'; sobject: string; id?: string; fields: Record<string, unknown> }
export interface SaveResult { ok: boolean; id?: string; error?: string }

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '#N/A'; // Bulk API: explicit null
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Bulk CSV rows as records like the REST API returns them: "Account.Name" becomes { Account: { Name } }. */
export function csvToRecords(text: string, compact = true): any[] {
  const rows = parseCsv(text);
  if (rows.length < 2) return [];
  const [head, ...data] = rows;
  return data.map((r) => {
    const rec: Record<string, any> = {};
    head.forEach((h, i) => {
      const v = r[i] ?? '';
      if (compact && v === '') return;
      const parts = h.split('.');
      let at = rec;
      for (const p of parts.slice(0, -1)) at = at[p] ??= {};
      at[parts[parts.length - 1]] = v;
    });
    return rec;
  });
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
