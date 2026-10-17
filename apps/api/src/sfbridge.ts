import { ensureRemoteSite } from './salesforce/setup.js';
import { deliverResults, takeCalls } from './agent/remote.js';
import { markSuggestion, recordSuggestions } from './knowledge/suggestions.js';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Workflow } from '@crmagents/shared';
import { config } from './config.js';
import { decrypt, encrypt } from './crypto.js';
import { pool } from './db.js';
import { decideRun, getRun, queueRun, startQueued, startRunAsync } from './engine/service.js';
import { runAgent } from './agent/runner.js';
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
  // Salesforce only calls addresses listed in Remote Site Settings: when our address changes (new tunnel, new
  // host), the setting must change with it, or every panel shows "Unauthorized endpoint".
  await ensureRemoteSite(sf);
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

  /** Which agents to show: on-demand and scheduled ones everywhere ("Run now"); record agents for their object,
   * or all of them when there is no record (utility bar, home), marked as needing one. Pure enough to test. */
  const forObject = (w: { graph: Workflow }, object: string, hasRecord: boolean) => {
    const t = w.graph.nodes.find((n) => n.type.startsWith('trigger.'));
    if (!t) return false;
    if (t.type === 'trigger.manual' || t.type === 'trigger.schedule') return true;
    if (t.type !== 'trigger.salesforce') return false;
    if (!hasRecord) return true;
    return !object || !t.config.objectApiName || String(t.config.objectApiName).toLowerCase() === object;
  };
  const needsRecord = (g: Workflow) => {
    const t = g.nodes.find((n) => n.type === 'trigger.salesforce');
    return t ? String(t.config.objectApiName ?? 'record') : null;
  };
  const describeTrigger = (g: Workflow) => {
    const t = g.nodes.find((n) => n.type.startsWith('trigger.'));
    if (t?.type === 'trigger.salesforce') return `Runs on ${t.config.objectApiName ?? 'records'}`;
    if (t?.type === 'trigger.schedule') return `Every ${t.config.every ?? 'day'}${t.config.every === 'hour' ? '' : ` at ${t.config.at ?? '08:00'} UTC`} · can also run now`;
    return 'On demand';
  };
  const waitingMessage = (steps: { status: string; output?: { message?: string } }[] | null) =>
    String((steps ?? []).find((x) => x.status === 'waiting')?.output?.message ?? 'Approve this change?');

  // Everything the Salesforce panel needs for one record, in one callout.
  app.get('/sf/v1/home', async (req) => {
    const q = req.query as { object?: string; recordId?: string; user?: string };
    const tenantId = req.sfTenant!.tenantId;
    const object = String(q.object ?? '').toLowerCase();
    const recordId = /^[a-zA-Z0-9]{15,18}$/.test(String(q.recordId ?? '')) ? String(q.recordId) : null;
    const user = String(q.user ?? '').toLowerCase() || null;
    const [flows, assistants, approvals, recent] = await Promise.all([
      pool.query('select id, name, graph, live from workflows where tenant_id=$1 order by name', [tenantId]),
      pool.query('select id, name from agents where tenant_id=$1 order by name', [tenantId]),
      pool.query(
        `select r.id, r.steps, r.assigned_to, r.assigned_label, r.created_at, coalesce(w.name, 'Agent') as name, r.input->>'recordId' as record_id
         from runs r left join workflows w on w.id = r.workflow_id
         where r.tenant_id=$1 and r.status='waiting' and ((r.input->>'recordId') = $2 or (r.assigned_to is not null and r.assigned_to = $3))
         order by r.created_at desc limit 20`, [tenantId, recordId, user]),
      recordId
        ? pool.query(
          `select r.id, r.status, r.created_at, left(r.output, 300) as output, coalesce(w.name, a.name, 'Agent') as name
           from runs r left join workflows w on w.id = r.workflow_id left join agents a on a.id = r.agent_id
           where r.tenant_id=$1 and (r.input->>'recordId') = $2 order by r.created_at desc limit 5`, [tenantId, recordId])
        : Promise.resolve({ rows: [] as any[] }),
    ]);
    return {
      agents: flows.rows.filter((w) => forObject(w, object, !!recordId)).map((w) => {
        const obj = needsRecord(w.graph);
        return { id: w.id, name: w.name, live: !!w.live, trigger: describeTrigger(w.graph), needsRecord: !recordId && obj ? obj : null };
      }),
      totalAgents: flows.rows.length,
      assistants: assistants.rows,
      approvals: approvals.rows.map((r) => ({ runId: r.id, agent: r.name, message: waitingMessage(r.steps), assignedLabel: r.assigned_label ?? 'Anyone', forMe: !!user && r.assigned_to === user, createdAt: r.created_at, recordId: r.record_id })),
      recent: recent.rows.map((r) => ({ runId: r.id, agent: r.name, status: r.status, createdAt: r.created_at, output: r.output ?? '' })),
    };
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
    workflowId: z.string().uuid().optional(),
    workflowName: z.string().max(200).optional(),
    userEmail: z.string().max(200).optional(),
    recordId: z.string().max(18).optional(),
    objectApiName: z.string().max(80).optional(),
    input: z.string().max(20_000).optional(),
    context: z.unknown().optional(),
    waitSeconds: z.number().min(0).max(90).optional(),
    userId: z.string().regex(/^005[a-zA-Z0-9]{12,15}$/).optional(),
  });

  app.post('/sf/v1/run', async (req) => {
    const b = runBody.parse(req.body);
    const tenantId = req.sfTenant!.tenantId;
    // Flows can name the agent instead of pasting its id.
    let id = b.workflowId;
    if (!id && b.workflowName) {
      const { rows } = await pool.query('select id from workflows where tenant_id=$1 and lower(name)=lower($2) limit 1', [tenantId, b.workflowName.trim()]);
      id = rows[0]?.id;
    }
    if (!id) throw Object.assign(new Error(b.workflowName ? `No agent named "${b.workflowName}"` : 'Give an agent id or name'), { statusCode: 404 });
    // Paused after failing again and again: Flows that start it are refused until someone turns it back on.
    const { rows: p } = await pool.query('select paused_reason from workflows where id=$1 and tenant_id=$2', [id, tenantId]);
    if (p[0]?.paused_reason) throw Object.assign(new Error(`This agent is paused. ${p[0].paused_reason}`), { statusCode: 409 });
    return startRunAsync(tenantId, id, {
      input: b.input, recordId: b.recordId, objectApiName: b.objectApiName, context: b.context, sfUserId: b.userId,
    }, (b.waitSeconds ?? 0) * 1000, b.userEmail);
  });

  // Many records at once from a Flow (data loads): one callout starts them all, each run in the background.
  app.post('/sf/v1/run/batch', { bodyLimit: 5_000_000 }, async (req) => {
    const { items } = z.object({ items: z.array(runBody).min(1).max(2000) }).parse(req.body);
    const tenantId = req.sfTenant!.tenantId;
    const { rows } = await pool.query('select id, lower(name) as name, paused_reason from workflows where tenant_id=$1', [tenantId]);
    const results = [];
    for (const b of items) {
      const id = b.workflowId ?? rows.find((w) => w.name === b.workflowName?.trim().toLowerCase())?.id;
      if (!id) { results.push({ status: 'error', error: b.workflowName ? `No agent named "${b.workflowName}"` : 'Give an agent id or name' }); continue; }
      const paused = rows.find((w) => w.id === id)?.paused_reason;
      if (paused) { results.push({ status: 'error', error: `This agent is paused. ${paused}` }); continue; }
      try {
        results.push(await queueRun(tenantId, id, { input: b.input, recordId: b.recordId, objectApiName: b.objectApiName, context: b.context, sfUserId: b.userId }, b.userEmail));
      } catch (e) {
        results.push({ status: 'error', error: e instanceof Error ? e.message : String(e) });
      }
    }
    // As many as fit start now; the rest within the next minutes, in order.
    void startQueued().catch(() => undefined);
    return { results };
  });

  // Ask an assistant, optionally about a record (its fields go along as context, masked like everything else).
  const askBody = z.object({
    assistantId: z.string().uuid().optional(), assistantName: z.string().max(200).optional(),
    question: z.string().min(1).max(20_000), recordId: z.string().max(18).optional(), objectApiName: z.string().max(80).optional(),
    history: z.array(z.object({ role: z.enum(['user', 'assistant']), text: z.string().max(20_000) })).max(40).optional(),
    /** The record as read inside Salesforce (package 0.6+): no API call back to the org needed. */
    record: z.record(z.unknown()).optional(),
    /** Return a run id at once; the answer is read with GET /sf/v1/ask/:id. */
    async: z.boolean().optional(),
    /** Salesforce runs the assistant's Salesforce tools as the person asking (package 0.7+). */
    inOrg: z.boolean().optional(),
    userEmail: z.string().max(200).optional(),
  });
  const SYSTEM_FIELDS = /^(SystemModstamp|LastViewedDate|LastReferencedDate|IsDeleted|PhotoUrl|attributes)$/;
  app.post('/sf/v1/ask', { bodyLimit: 5_000_000 }, async (req) => {
    const b = askBody.parse(req.body);
    const tenantId = req.sfTenant!.tenantId;
    const { rows } = await pool.query(
      b.assistantId ? 'select id, system_prompt, tools from agents where tenant_id=$1 and id=$2' : 'select id, system_prompt, tools from agents where tenant_id=$1 and lower(name)=lower($2) limit 1',
      [tenantId, b.assistantId ?? b.assistantName ?? ''],
    );
    if (!rows[0]) throw Object.assign(new Error('Assistant not found'), { statusCode: 404 });
    let context: unknown;
    if (b.recordId && b.objectApiName && /^\w+$/.test(b.objectApiName)) {
      // Sent along by Salesforce when it can (read in-org, no API call); older packages: fetch it here.
      const rec = b.record ?? await (await SalesforceClient.forTenant(tenantId)).getRecord(b.objectApiName, b.recordId).catch(() => null) as Record<string, unknown> | null;
      // Enough of the record to answer about it, without sending every system field.
      if (rec) context = { record: { object: b.objectApiName, id: b.recordId, fields: Object.fromEntries(Object.entries(rec).filter(([k, v]) => !SYSTEM_FIELDS.test(k) && v !== null && v !== '').slice(0, 60)) } };
    }
    // Answers show in a narrow Salesforce panel: keep them short and scannable.
    const system = `${rows[0].system_prompt}

FORMAT (mandatory, overrides any other style instruction): you are answering in a narrow Salesforce side panel that people skim.
- First line: one sentence, at most 25 words, that directly answers what was asked.
- Then a blank line and 3 to 5 bullets ("- "), each at most 14 words. Facts or next actions only.
- Bold at most one short phrase per bullet. No headings, no sub-bullets, no tables, no closing remarks.
- Answer only what was asked; don't restate the whole record.${rows[0].tools?.includes('soql_query') ? `
- If the user gives a record number (e.g. Case Number 00001066, with leading zeros), look that record up with soql_query before answering.` : ''}
- When knowledge sections were used, end bullets with their number like [1] and add a last line "Sources: <document titles>".`;
    const spec = { id: rows[0].id, systemPrompt: system, tools: rows[0].tools };
    if (b.async) {
      // Answer in the background; the panel checks GET /sf/v1/ask/:id (short calls, nothing held open in Salesforce).
      const runId = await new Promise<string>((resolve, reject) => {
        runAgent(tenantId, spec, b.question, context, b.history, { onStarted: resolve, inOrg: b.inOrg, startedBy: b.userEmail?.toLowerCase() }).catch(reject);
      });
      return { runId, status: 'running' };
    }
    const r = await runAgent(tenantId, spec, b.question, context, b.history);
    return { answer: r.output, runId: r.runId };
  });

  app.get('/sf/v1/ask/:id', async (req) => {
    const { rows } = await pool.query('select status, output from runs where id=$1 and tenant_id=$2', [(req.params as { id: string }).id, req.sfTenant!.tenantId]);
    if (!rows[0]) throw Object.assign(new Error('Question not found'), { statusCode: 404 });
    const status = rows[0].status === 'done' ? 'done' : rows[0].status === 'error' ? 'error' : 'running';
    // Tool calls for Salesforce to run as the person asking.
    if (status === 'running') {
      const calls = takeCalls((req.params as { id: string }).id);
      if (calls.length) return { status: 'tool', calls };
    }
    return { status, ...(status === 'done' ? { answer: rows[0].output } : status === 'error' ? { error: rows[0].output } : {}) };
  });

  // Suggestions agents saved on a record, for the Suggestions card on its page.
  app.get('/sf/v1/suggestions', async (req) => {
    const { recordId } = z.object({ recordId: z.string().regex(/^[a-zA-Z0-9]{15,18}$/) }).parse(req.query);
    return recordSuggestions(req.sfTenant!.tenantId, recordId);
  });

  app.post('/sf/v1/suggestions/:id', async (req) => {
    const b = z.object({ status: z.enum(['helpful', 'not_helpful', 'dismissed', 'sent']), userEmail: z.string().max(200).optional() }).parse(req.body);
    await markSuggestion(req.sfTenant!.tenantId, (req.params as { id: string }).id, b.status, b.userEmail);
    return { ok: true };
  });

  app.post('/sf/v1/ask/:id/tools', { bodyLimit: 10_000_000 }, async (req) => {
    const { id } = req.params as { id: string };
    const own = await pool.query('select 1 from runs where id=$1 and tenant_id=$2', [id, req.sfTenant!.tenantId]);
    if (!own.rowCount) throw Object.assign(new Error('Question not found'), { statusCode: 404 });
    const { results } = z.object({ results: z.array(z.object({ id: z.string(), ok: z.boolean(), result: z.unknown().optional(), error: z.string().max(5000).optional() })).max(50) }).parse(req.body);
    return { accepted: deliverResults(id, results) };
  });

  app.get('/sf/v1/runs/:id', async (req) => getRun(req.sfTenant!.tenantId, (req.params as { id: string }).id));

  app.post('/sf/v1/runs/:id/decision', async (req) => {
    const { approve, note, userEmail } = z.object({ approve: z.boolean(), note: z.string().max(500).optional(), userEmail: z.string().max(200).optional() }).parse(req.body);
    await decideRun(req.sfTenant!.tenantId, (req.params as { id: string }).id, approve, note, userEmail?.toLowerCase());
    return getRun(req.sfTenant!.tenantId, (req.params as { id: string }).id);
  });
}
