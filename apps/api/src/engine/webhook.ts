import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Workflow } from '@crmagents/shared';
import { config } from '../config.js';
import { decrypt, encrypt } from '../crypto.js';
import { pool } from '../db.js';
import { startRunAsync } from './service.js';

// Webhook trigger: other systems (forms, ServiceNow, Jira, the customer's own app) start an agent by sending a
// request to its address with its secret. The JSON they send is {{trigger.body}} in the agent.

export function webhookUrl(workflowId: string) {
  return `${config.bridgeUrl.replace(/\/$/, '')}/hooks/${workflowId}`;
}

/** The agent's secret, created on first use. `rotate` replaces it (the old one stops working at once). */
export async function webhookSecret(tenantId: string, workflowId: string, rotate = false): Promise<string> {
  const { rows } = await pool.query('select webhook_secret_enc from workflows where id=$1 and tenant_id=$2', [workflowId, tenantId]);
  if (!rows[0]) throw Object.assign(new Error('workflow not found'), { statusCode: 404 });
  if (rows[0].webhook_secret_enc && !rotate) return decrypt(rows[0].webhook_secret_enc);
  const secret = `whsec_${randomBytes(24).toString('base64url')}`;
  await pool.query('update workflows set webhook_secret_enc=$2 where id=$1', [workflowId, encrypt(secret)]);
  return secret;
}

/** Value at a dotted path ("ticket.caseId"). Pure; tested. */
export function atPath(body: unknown, path: string): unknown {
  return path.split('.').filter(Boolean).reduce<unknown>((v, k) => (v && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined), body);
}

const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export function registerWebhooks(app: FastifyInstance) {
  // Not under /api: no login. The secret is the credential (header, or ?key= for tools that can't set headers).
  app.post('/hooks/:id', { bodyLimit: 1_000_000 }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const q = req.query as { key?: string; wait?: string };
    const bearer = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    const given = String(req.headers['x-crmagents-secret'] ?? '') || bearer || String(q.key ?? '');
    const { rows } = await pool.query('select tenant_id, graph, live, webhook_secret_enc from workflows where id=$1', [id]);
    const w = rows[0];
    // Same answer for unknown agents and wrong secrets: nothing to learn by guessing.
    if (!w || !w.webhook_secret_enc || !given || !same(decrypt(w.webhook_secret_enc), given)) return reply.code(401).send({ error: 'Unknown agent or wrong secret' });
    const trig = (w.graph as Workflow).nodes.find((n) => n.type === 'trigger.webhook');
    if (!trig) return reply.code(409).send({ error: 'This agent is not started by a webhook' });
    if (!w.live) return reply.code(409).send({ error: 'This agent is turned off' });
    const body = req.body ?? {};
    const recordId = trig.config.recordIdPath ? String(atPath(body, String(trig.config.recordIdPath)) ?? '') : '';
    const wait = Math.min(Math.max(Number(q.wait) || 0, 0), 60) * 1000;
    const run = await startRunAsync(w.tenant_id, id, {
      body,
      input: typeof body === 'string' ? body : JSON.stringify(body).slice(0, 20_000),
      ...(/^[a-zA-Z0-9]{15,18}$/.test(recordId) ? { recordId, objectApiName: String(trig.config.objectApiName ?? '') || undefined } : {}),
    }, wait, 'webhook');
    return reply.code(202).send({ runId: run.runId, status: run.status, ...(wait ? { output: run.output } : {}) });
  });
}
