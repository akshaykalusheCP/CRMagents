import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Workflow } from '@crmagents/shared';
import { config } from './config.js';
import { decrypt, encrypt } from './crypto.js';
import { pool } from './db.js';
import { decideRun, getRun, startRunAsync } from './engine/service.js';
import { SalesforceClient } from './salesforce/client.js';

declare module 'fastify' {
  interface FastifyRequest { rawBody?: string; sfTenant?: { tenantId: string; accountId: string } }
}

const MAX_SKEW_MS = 5 * 60_000;

export async function ensureSecret(tenantId: string): Promise<string> {
  const { rows } = await pool.query('select sf_signing_secret_enc from tenants where id=$1', [tenantId]);
  if (!rows[0]) throw new Error('Unknown tenant');
  if (rows[0].sf_signing_secret_enc) return decrypt(rows[0].sf_signing_secret_enc);
  const secret = randomBytes(32).toString('base64url');
  await pool.query('update tenants set sf_signing_secret_enc=$2 where id=$1 and sf_signing_secret_enc is null', [tenantId, encrypt(secret)]);
  // Re-read in case a concurrent call won the race.
  const again = await pool.query('select sf_signing_secret_enc from tenants where id=$1', [tenantId]);
  return decrypt(again.rows[0].sf_signing_secret_enc);
}

/** What Apex signs: timestamp.METHOD.pathWithQuery.body, HMAC-SHA256, hex. */
export function sign(secret: string, ts: string, method: string, url: string, body: string): string {
  return createHmac('sha256', secret).update(`${ts}.${method.toUpperCase()}.${url}.${body}`).digest('hex');
}

/** Write base URL + secret into the org's CRMagents_Config__c (needs the package components installed). */
export async function provisionOrg(tenantId: string): Promise<{ ok: true }> {
  const secret = await ensureSecret(tenantId);
  const { rows } = await pool.query('select sf_org_id from tenants where id=$1', [tenantId]);
  const orgId: string = rows[0].sf_org_id;
  const sf = await SalesforceClient.forTenant(tenantId);
  const fields = { Base_Url__c: config.bridgeUrl, Signing_Secret__c: secret };
  try {
    const existing = await sf.query(`SELECT Id FROM CRMagents_Config__c WHERE SetupOwnerId = '${orgId}' LIMIT 1`);
    if (existing.records.length) await sf.updateRecord('CRMagents_Config__c', (existing.records[0] as { Id: string }).Id, fields);
    else await sf.createRecord('CRMagents_Config__c', { SetupOwnerId: orgId, ...fields });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/INVALID_TYPE|sObject type|NOT_FOUND/i.test(msg)) throw new Error('The CRMagents package is not installed in this org yet.');
    throw e;
  }
  return { ok: true };
}

export function registerSfBridge(app: FastifyInstance) {
  // Keep the raw body so signatures can be verified exactly as Apex produced them.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    req.rawBody = body as string;
    if (!body) return done(null, {});
    try { done(null, JSON.parse(body as string)); } catch (e) { done(Object.assign(e as Error, { statusCode: 400 }), undefined); }
  });

  app.addHook('preHandler', async (req, reply) => {
    if (!req.url.startsWith('/sf/v1/')) return;
    const h = req.headers;
    const org = String(h['x-crm-org'] ?? '');
    const ts = String(h['x-crm-timestamp'] ?? '');
    const sig = String(h['x-crm-signature'] ?? '');
    if (!org || !ts || !sig || Math.abs(Date.now() - Number(ts)) > MAX_SKEW_MS) return reply.code(401).send({ error: 'unauthorized' });

    const { rows } = await pool.query('select id, account_id, sf_signing_secret_enc from tenants where sf_org_id=$1 and sf_signing_secret_enc is not null', [org]);
    const given = Buffer.from(sig, 'hex');
    for (const t of rows) {
      const expected = Buffer.from(sign(decrypt(t.sf_signing_secret_enc), ts, req.method, req.url, req.rawBody ?? ''), 'hex');
      if (expected.length === given.length && timingSafeEqual(expected, given)) {
        req.sfTenant = { tenantId: t.id, accountId: t.account_id };
        return;
      }
    }
    return reply.code(401).send({ error: 'unauthorized' });
  });

  app.get('/sf/v1/workflows', async (req) => {
    const object = String((req.query as { object?: string }).object ?? '').toLowerCase();
    const { rows } = await pool.query('select id, name, graph from workflows where tenant_id=$1 order by name', [req.sfTenant!.tenantId]);
    return rows
      .filter((w) => {
        const triggers = (w.graph as Workflow).nodes.filter((n) => n.type === 'trigger.salesforce');
        if (!triggers.length) return false;
        if (!object) return true;
        return triggers.some((t) => !t.config.objectApiName || String(t.config.objectApiName).toLowerCase() === object);
      })
      .map((w) => ({ id: w.id, name: w.name }));
  });

  const runBody = z.object({
    workflowId: z.string().uuid(),
    recordId: z.string().max(18).optional(),
    objectApiName: z.string().max(80).optional(),
    input: z.string().max(20_000).optional(),
    context: z.unknown().optional(),
    waitSeconds: z.number().min(0).max(90).optional(),
  });

  app.post('/sf/v1/run', async (req) => {
    const b = runBody.parse(req.body);
    return startRunAsync(req.sfTenant!.tenantId, b.workflowId, {
      input: b.input, recordId: b.recordId, objectApiName: b.objectApiName, context: b.context,
    }, (b.waitSeconds ?? 0) * 1000);
  });

  app.get('/sf/v1/runs/:id', async (req) => getRun(req.sfTenant!.tenantId, (req.params as { id: string }).id));

  app.post('/sf/v1/runs/:id/decision', async (req) => {
    const { approve } = z.object({ approve: z.boolean() }).parse(req.body);
    await decideRun(req.sfTenant!.tenantId, (req.params as { id: string }).id, approve);
    return getRun(req.sfTenant!.tenantId, (req.params as { id: string }).id);
  });
}
