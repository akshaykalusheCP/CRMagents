import { pool } from '../db.js';
import type { DescribeField, GlobalObject, SalesforceClient } from './client.js';

// Org schema for the workflow builder: cached for a day per org so drafting costs no Salesforce calls.
const TTL_HOURS = 24;

async function cached<T>(tenantId: string, key: string, load: () => Promise<T>): Promise<T> {
  const { rows } = await pool.query(
    `select data from sf_schema_cache where tenant_id=$1 and key=$2 and fetched_at > now() - ($3 || ' hours')::interval`,
    [tenantId, key, String(TTL_HOURS)],
  );
  if (rows[0]) return rows[0].data as T;
  const data = await load();
  await pool.query(
    `insert into sf_schema_cache (tenant_id, key, data) values ($1,$2,$3)
     on conflict (tenant_id, key) do update set data=excluded.data, fetched_at=now()`,
    [tenantId, key, JSON.stringify(data)],
  );
  return data;
}

const NOISE = /(__Share|__History|__Feed|__Tag|ChangeEvent|__ChangeEvent|__mdt|__e|__x|__b)$/;

/** Business objects a workflow can start from or write to. */
export async function objects(tenantId: string, sf: SalesforceClient): Promise<GlobalObject[]> {
  const all = await cached(tenantId, 'global', async () =>
    (await sf.describeGlobal()).map(({ name, label, labelPlural, queryable, createable, custom }) => ({ name, label, labelPlural, queryable, createable, custom })));
  return all.filter((o) => o.queryable && !NOISE.test(o.name));
}

const SYSTEM_FIELDS = new Set(['IsDeleted', 'SystemModstamp', 'LastViewedDate', 'LastReferencedDate', 'MasterRecordId', 'CreatedById', 'LastModifiedById', 'ConnectionReceivedId', 'ConnectionSentId', 'PhotoUrl', 'Jigsaw', 'JigsawContactId', 'CleanStatus']);

export async function fields(tenantId: string, sf: SalesforceClient, object: string): Promise<DescribeField[]> {
  const all = await cached(tenantId, `fields:${object}`, async () =>
    (await sf.describe(object)).map(({ name, label, type, updateable, createable, referenceTo, picklistValues }) => ({
      name, label, type, updateable, createable, referenceTo,
      picklistValues: picklistValues?.filter((p) => p.active).map((p) => ({ value: p.value, active: true })),
    })));
  return all.filter((f) => !SYSTEM_FIELDS.has(f.name) && f.type !== 'address' && f.type !== 'location');
}

const CORE = ['Case', 'Lead', 'Account', 'Contact', 'Opportunity', 'Task', 'Campaign', 'Contract', 'Order', 'Product2', 'Quote'];

/** Objects the request mentions by name or label (most specific first), plus the core objects as fallbacks. */
export function detectObjects(request: string, all: GlobalObject[]): { mentioned: string[]; candidates: string[] } {
  const text = ` ${request.toLowerCase().replace(/[^a-z0-9_ ]/g, ' ')} `;
  const hits: { name: string; at: number; len: number }[] = [];
  for (const o of all) {
    for (const term of [o.name, o.label, o.labelPlural]) {
      const t = term.toLowerCase().replace(/__c$/, '').replace(/_/g, ' ');
      if (t.length < 3) continue;
      const at = text.indexOf(` ${t} `) >= 0 ? text.indexOf(` ${t} `) : text.indexOf(` ${t}s `);
      if (at >= 0) { hits.push({ name: o.name, at, len: t.length }); break; }
    }
  }
  hits.sort((a, b) => a.at - b.at || b.len - a.len);
  const mentioned = [...new Set(hits.map((h) => h.name))];
  const custom = all.filter((o) => o.custom).map((o) => o.name);
  const known = new Set(all.map((o) => o.name));
  const candidates = [...new Set([...mentioned, ...CORE.filter((c) => known.has(c)), ...custom])].slice(0, 60);
  return { mentioned, candidates };
}
