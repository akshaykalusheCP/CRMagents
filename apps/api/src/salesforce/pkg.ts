import { pool } from '../db.js';

// Two Nimbus packages exist side by side: the original one without a namespace (orgs that installed it keep it) and
// the namespaced one (every other org, including orgs that have their own namespace). Our object, field and action
// names in an org carry that package's prefix, e.g. nimbus__CRMagents_Config__c.

const cache = new Map<string, { ns: string; at: number }>();

/** The org's package namespace ('' for the original package). */
export async function pkgNs(tenantId: string): Promise<string> {
  const hit = cache.get(tenantId);
  if (hit && Date.now() - hit.at < 60_000) return hit.ns;
  const { rows } = await pool.query('select pkg_ns from tenants where id=$1', [tenantId]);
  const ns = String(rows[0]?.pkg_ns ?? '');
  cache.set(tenantId, { ns, at: Date.now() });
  return ns;
}

export async function setPkgNs(tenantId: string, ns: string): Promise<void> {
  await pool.query('update tenants set pkg_ns=$2 where id=$1', [tenantId, ns]);
  cache.set(tenantId, { ns, at: Date.now() });
}

/** A package component's API name in an org with this namespace. Pure; tested. */
export const pn = (ns: string, name: string) => (ns ? `${ns}__${name}` : name);

/** Field values keyed by their names in that org. Pure; tested. */
export const pnFields = (ns: string, fields: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(fields).map(([k, v]) => [/__c$/.test(k) ? pn(ns, k) : k, v]));

/** SOQL filter for one of our components by name, in the right namespace. Pure; tested. */
export const nsFilter = (ns: string) => (ns ? `NamespacePrefix = '${ns.replace(/\W/g, '')}'` : 'NamespacePrefix = null');
