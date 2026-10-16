import cookie from '@fastify/cookie';
import Fastify from 'fastify';
import { z } from 'zod';
import { loadUser, registerAuth } from './auth.js';
import { provisionOrg, registerSfBridge } from './sfbridge.js';
import { dailyBudgetUsd } from './spend.js';
import { grantAccessToAll, setupOrg } from './salesforce/setup.js';
import { TOOLS } from './agent/tools.js';
import { validateWorkflow, type Workflow } from '@crmagents/shared';
import { runAgent } from './agent/runner.js';
import { cancelRun, resumeRun, decideRun, previewWorkflow, startRun } from './engine/service.js';
import { addExample, exampleCount } from './engine/learn.js';
import { deployWorkflow, undeployWorkflow } from './salesforce/deploy.js';
import { setLive, setRealtime, startWatcher } from './engine/watcher.js';
import { ask, runSoql, safeSoql, summarize } from './insights/ai.js';
import { cachedInsights } from './insights/metrics.js';
import { CHARTS, RANGES, draftDashboard, drill, runTiles, saveTiles, type Range, type TileSpec } from './insights/dashboards.js';
import { SalesforceClient } from './salesforce/client.js';
import { draftWorkflow } from './builder/service.js';
import { suggestAgents, dismissSuggestion } from './smart/suggest.js';
import { backtest } from './smart/backtest.js';
import { agentHealth, removeApproval } from './smart/trust.js';
import { applyFix, diagnoseRun } from './smart/repair.js';
import { orgAutomation } from './smart/orgAutomation.js';
import { compileRule, listRules } from './smart/policies.js';
import { regression } from './smart/regress.js';
import { builderChat } from './builder/chat.js';
import { listOrgActions } from './salesforce/actions.js';
import { addDocument, deleteDocument, extractText, listDocuments, looksScanned, MAX_UPLOAD_BYTES, searchKnowledge } from './knowledge/store.js';
import { ocrPdf } from './knowledge/ocr.js';
import { addSource, listSources, removeSource, syncSource } from './knowledge/sync.js';
import { listSuggestions, markSuggestion } from './knowledge/suggestions.js';
import { registerWebhooks, webhookSecret, webhookUrl } from './engine/webhook.js';
import { backfill, exportAgent, importAgent, listVersions, restoreVersion, saveVersion } from './engine/admin.js';
import { publicChatInfo, registerPublicChat, setPublicChat } from './agent/publicChat.js';
import { addToRecordPage, addToUtilityBar, listPages } from './salesforce/pages.js';
import { impact, setAssumptions } from './insights/impact.js';
import { config } from './config.js';
import { deleteTest, listTestRuns, listTests, recentQuestions, saveTest, startTestRun } from './agent/tests.js';
import { registerTeam } from './team.js';
import { registerTwilio } from './channels/twilio.js';
import { listAlerts, markAlertsRead } from './alerts.js';
import { migrate, pool } from './db.js';
import { buildAuthorizeUrl, handleCallback, redirectUri, validateOwnApp } from './salesforce/oauth.js';
import { getSetting, PLAIN_SETTINGS, setSetting, SETTING_KEYS, type SettingName } from './settings.js';

// Behind a proxy or tunnel (Render, ngrok): the visitor's address comes from X-Forwarded-For (website chat rate limits).
const app = Fastify({ logger: true, trustProxy: process.env.TRUST_PROXY !== 'false' });

await app.register(cookie);
registerSfBridge(app);
registerWebhooks(app);
registerPublicChat(app);
registerAuth(app);
registerTeam(app);
registerTwilio(app);

app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
  const code = err instanceof z.ZodError ? 400 : (err.statusCode ?? 500);
  reply.code(code).send({ error: err instanceof z.ZodError ? err.issues.map((i) => i.message).join('; ') : err.message });
});

app.get('/health', async () => ({ ok: true }));

// ---- OAuth (browser navigation, no API key) ----
app.get('/oauth/connect', async (req, reply) => {
  const user = await loadUser(req);
  if (!user) return reply.redirect(`${config.webUrl}/`);
  const { sandbox, domain } = req.query as { sandbox?: string; domain?: string };
  try {
    return reply.redirect(await buildAuthorizeUrl(user.accountId, !!sandbox, domain?.trim() || undefined));
  } catch (e) {
    return reply.redirect(`${config.webUrl}/?error=${encodeURIComponent((e as Error).message)}`);
  }
});

// POST so a Consumer Secret never appears in a URL or access log.
app.post('/api/oauth/start', async (req) => {
  const b = z.object({
    sandbox: z.boolean().optional(),
    domain: z.string().optional(),
    clientId: z.string().optional(),
    clientSecret: z.string().optional(),
  }).parse(req.body ?? {});
  const own = b.clientId?.trim() ? validateOwnApp({ clientId: b.clientId, clientSecret: b.clientSecret }) : undefined;
  return { url: await buildAuthorizeUrl(req.user!.accountId, !!b.sandbox, b.domain?.trim() || undefined, own) };
});

app.get('/oauth/callback', async (req, reply) => {
  const { code, state, error, error_description } = req.query as Record<string, string>;
  const back = (msg: string) => reply.redirect(`${config.webUrl}/?error=${encodeURIComponent(msg)}`);
  if (!code) {
    req.log.warn({ error, error_description }, 'Salesforce OAuth callback error');
    // Salesforce sends these when the org blocks or does not know the app.
    const notInstalled = /invalid_client|blocked|not.*installed|unapproved|OAUTH_APPROVAL/i.test(`${error} ${error_description}`);
    return back(notInstalled
      ? 'This Salesforce org has not installed or approved the CRMagents app yet. Ask a Salesforce admin to install it once, then connect again.'
      : (error_description ?? error ?? 'Salesforce login was cancelled'));
  }
  try {
    const tenantId = await handleCallback(code, state);
    void setupOrg(tenantId); // installs the package etc. in the background; the UI shows progress
    return reply.redirect(`${config.webUrl}/?connected=${tenantId}`);
  } catch (e) {
    return back((e as Error).message);
  }
});

app.get('/api/config', async () => ({
  installUrl: `https://login.salesforce.com/packaging/installPackage.apexp?p0=${config.packageVersionId}`,
  sandboxInstallUrl: `https://test.salesforce.com/packaging/installPackage.apexp?p0=${config.packageVersionId}`,
}));

// ---- Settings (values are write-only; GET only reports whether they are set) ----
app.get('/api/settings', async (req) => {
  const accountId = req.user!.accountId;
  const out: Record<string, unknown> = { callbackUrl: redirectUri() };
  for (const name of Object.keys(SETTING_KEYS) as SettingName[]) {
    const v = await getSetting(accountId, name);
    // sfClientId and loginUrl are not secret; show them so the form is editable.
    // Non-secret settings are returned as values so the form can show them.
    out[name] = PLAIN_SETTINGS.includes(name) ? (v ?? '') : { set: !!v };
  }
  return out;
});

const settingsBody = z.object({
  sfClientId: z.string().optional(),
  sfClientSecret: z.string().optional(),
  sfLoginUrl: z.string().url().optional().or(z.literal('')),
  anthropicKey: z.string().optional(),
  anthropicWorkspaceId: z.string().regex(/^(wrkspc_[A-Za-z0-9]+)?$/, 'Workspace ID looks like wrkspc_…').optional(),
  aiCacheHours: z.string().regex(/^(\d+(\.\d+)?)?$/, 'Hours must be a number (0 turns reuse off)').optional(),
  dailyBudgetUsd: z.string().regex(/^(none|\d+(\.\d+)?)?$/i, 'Budget must be a number of dollars, or "none"').optional(),
  maskPii: z.enum(['on', 'off', '']).optional(),
  maskFields: z.string().max(2000).regex(/^[\w\s,.]*$/, 'Field names are API names separated by commas').optional(),
  maxAiCalls: z.string().regex(/^(\d{1,4})?$/, 'A whole number').optional(),
  maxToolCalls: z.string().regex(/^(\d{1,4})?$/, 'A whole number').optional(),
  maxTokens: z.string().regex(/^(\d{1,8})?$/, 'A whole number').optional(),
  retentionDays: z.string().regex(/^(\d{1,4})?$/, 'A whole number of days (0 keeps everything)').optional(),
  aiProvider: z.enum(['anthropic', 'openai', 'gemini', 'compatible', '']).optional(),
  providerKey: z.string().max(500).optional(),
  aiBaseUrl: z.string().url('Base URL like https://api.example.com/v1').optional().or(z.literal('')),
  aiModel: z.string().max(100).regex(/^[\w.:/-]*$/, 'Model name, e.g. gpt-5').optional(),
  aiFastModel: z.string().max(100).regex(/^[\w.:/-]*$/, 'Model name').optional(),
  aiPriceIn: z.string().regex(/^(\d+(\.\d+)?)?$/, 'USD per million tokens').optional(),
  alertEmails: z.enum(['on', 'off', '']).optional(),
  twilioSid: z.string().regex(/^(AC[0-9a-fA-F]{32})?$/, 'Twilio Account SID starts with AC').optional(),
  twilioToken: z.string().max(100).optional(),
  twilioSms: z.string().regex(/^(\+\d{7,15})?$/, 'SMS number in international format, like +14155550100').optional(),
  twilioWhatsapp: z.string().regex(/^((whatsapp:)?\+\d{7,15})?$/, 'WhatsApp sender like +14155238886').optional(),
  autoPauseAfter: z.string().regex(/^(\d{1,2})?$/, 'A whole number of failures in a row (0 never pauses)').optional(),
  aiPriceOut: z.string().regex(/^(\d+(\.\d+)?)?$/, 'USD per million tokens').optional(),
  auditInSalesforce: z.enum(['on', 'off', '']).optional(),
});

app.put('/api/settings', async (req) => {
  const b = settingsBody.parse(req.body);
  for (const [k, v] of Object.entries(b)) {
    if (v !== undefined) await setSetting(req.user!.accountId, k as SettingName, v.trim());
  }
  return { ok: true };
});

// ---- Insights: business dashboard (numbers by code, words by AI) ----
const periodQ = z.object({ period: z.coerce.number().int().refine((n) => [7, 30, 90].includes(n), 'period must be 7, 30 or 90').default(30), refresh: z.string().optional() });

app.get('/api/tenants/:tenantId/insights', async (req) => {
  const { tenantId } = req.params as { tenantId: string };
  const q = periodQ.parse(req.query);
  return cachedInsights(tenantId, await SalesforceClient.forTenant(tenantId), q.period, !!q.refresh);
});

app.post('/api/tenants/:tenantId/insights/summary', async (req) => {
  const { tenantId } = req.params as { tenantId: string };
  const { period } = periodQ.parse(req.body ?? {});
  const ins = await cachedInsights(tenantId, await SalesforceClient.forTenant(tenantId), period);
  return summarize(tenantId, ins);
});

app.post('/api/tenants/:tenantId/insights/ask', async (req) => {
  const { tenantId } = req.params as { tenantId: string };
  const { question } = z.object({ question: z.string().trim().min(5).max(500) }).parse(req.body);
  return ask(tenantId, question);
});

// Pinned questions re-run their saved query on every load: no AI, always current.
app.get('/api/tenants/:tenantId/insights/tiles', async (req) => {
  const { tenantId } = req.params as { tenantId: string };
  const { rows } = await pool.query('select * from insight_tiles where tenant_id=$1 order by created_at', [tenantId]);
  const sf = await SalesforceClient.forTenant(tenantId);
  return Promise.all(rows.map(async (t) => {
    try { return { ...t, ...(await runSoql(sf, t.soql)) }; } catch (e) { return { ...t, columns: [], rows: [], error: e instanceof Error ? e.message : String(e) }; }
  }));
});

app.post('/api/tenants/:tenantId/insights/tiles', async (req) => {
  const { tenantId } = req.params as { tenantId: string };
  const b = z.object({
    title: z.string().min(1).max(200), question: z.string().max(500), soql: z.string().min(10).max(4000),
    chart: z.enum(['bar', 'line', 'table', 'number']), labelKey: z.string().max(200), valueKey: z.string().max(200),
  }).parse(req.body);
  const { rows } = await pool.query(
    'insert into insight_tiles (tenant_id, title, question, soql, chart, label_key, value_key) values ($1,$2,$3,$4,$5,$6,$7) returning id',
    [tenantId, b.title, b.question, safeSoql(b.soql), b.chart, b.labelKey, b.valueKey],
  );
  return { id: rows[0].id };
});

app.delete('/api/tenants/:tenantId/insights/tiles/:tileId', async (req) => {
  const { tenantId, tileId } = req.params as { tenantId: string; tileId: string };
  await pool.query('delete from insight_tiles where id=$1 and tenant_id=$2', [tileId, tenantId]);
  return { ok: true };
});

// ---- Dashboards built from a prompt ----
const rangeQ = z.object({ range: z.enum(RANGES).default('THIS_YEAR') });
const tileBody = z.object({
  title: z.string().min(1).max(200), question: z.string().max(1000).default(''), soql: z.string().min(10).max(4000),
  chart: z.enum(CHARTS), label_key: z.string().max(200).default(''), series_key: z.string().max(200).default(''),
  value_key: z.string().max(200).default(''), format: z.enum(['currency', 'number', 'percent']).default('number'),
  date_field: z.string().regex(/^([A-Za-z_]\w*)?$/).default(''), drill_soql: z.string().max(4000).default(''),
  size: z.enum(['third', 'half', 'full']).default('half'),
});
const dashBody = z.object({ name: z.string().min(1).max(200), description: z.string().max(1000).default(''), prompt: z.string().max(2000).default(''), tiles: z.array(tileBody).max(24) });

async function loadDashboard(tenantId: string, id: string) {
  const { rows } = await pool.query('select * from dashboards where id=$1 and tenant_id=$2', [id, tenantId]);
  if (!rows[0]) throw Object.assign(new Error('dashboard not found'), { statusCode: 404 });
  const tiles = await pool.query('select * from dashboard_tiles where dashboard_id=$1 order by position', [id]);
  return { ...rows[0], tiles: tiles.rows as (TileSpec & { id: string })[] };
}

app.get('/api/tenants/:tenantId/dashboards', async (req) => {
  const { rows } = await pool.query(
    `select d.id, d.name, d.description, d.updated_at, count(t.id)::int as tiles
     from dashboards d left join dashboard_tiles t on t.dashboard_id = d.id
     where d.tenant_id=$1 group by d.id order by d.updated_at desc`,
    [(req.params as { tenantId: string }).tenantId],
  );
  return rows;
});

app.post('/api/tenants/:tenantId/dashboards/draft', async (req) => {
  const { tenantId } = req.params as { tenantId: string };
  const b = z.object({ prompt: z.string().trim().min(5).max(2000), single: z.boolean().optional(), range: z.enum(RANGES).optional() }).parse(req.body);
  return draftDashboard(tenantId, b.prompt, { maxTiles: b.single ? 1 : 8, range: b.range });
});

app.post('/api/tenants/:tenantId/dashboards', async (req) => {
  const { tenantId } = req.params as { tenantId: string };
  const b = dashBody.parse(req.body);
  const { rows } = await pool.query('insert into dashboards (tenant_id, name, description, prompt) values ($1,$2,$3,$4) returning id', [tenantId, b.name, b.description, b.prompt]);
  await saveTiles(rows[0].id, b.tiles as TileSpec[]);
  return { id: rows[0].id };
});

app.get('/api/tenants/:tenantId/dashboards/:id', async (req) => {
  const { tenantId, id } = req.params as { tenantId: string; id: string };
  const { range } = rangeQ.parse(req.query);
  const d = await loadDashboard(tenantId, id);
  const refresh = (req.query as { refresh?: string }).refresh === '1';
  return { ...d, range, tiles: await runTiles(await SalesforceClient.forTenant(tenantId), d.tiles, range as Range, refresh) };
});

app.put('/api/tenants/:tenantId/dashboards/:id', async (req) => {
  const { tenantId, id } = req.params as { tenantId: string; id: string };
  const b = dashBody.parse(req.body);
  await loadDashboard(tenantId, id);
  await pool.query('update dashboards set name=$2, description=$3, updated_at=now() where id=$1', [id, b.name, b.description]);
  await saveTiles(id, b.tiles as TileSpec[]);
  return { ok: true };
});

app.delete('/api/tenants/:tenantId/dashboards/:id', async (req) => {
  const { tenantId, id } = req.params as { tenantId: string; id: string };
  await pool.query('delete from dashboards where id=$1 and tenant_id=$2', [id, tenantId]);
  return { ok: true };
});

// Run or drill tiles that aren't saved yet (draft preview, chart edits) — same SELECT-only guard as saved tiles.
app.post('/api/tenants/:tenantId/dashboards/run', async (req) => {
  const { tenantId } = req.params as { tenantId: string };
  const b = z.object({ tiles: z.array(tileBody.extend({ id: z.string().max(64).default('') })).max(24), range: z.enum(RANGES).default('THIS_YEAR') }).parse(req.body);
  return runTiles(await SalesforceClient.forTenant(tenantId), b.tiles as (TileSpec & { id: string })[], b.range as Range);
});

app.post('/api/tenants/:tenantId/dashboards/drill', async (req) => {
  const { tenantId } = req.params as { tenantId: string };
  const b = z.object({ tile: tileBody, label: z.string().max(500), range: z.enum(RANGES).default('THIS_YEAR') }).parse(req.body);
  return drill(await SalesforceClient.forTenant(tenantId), b.tile as TileSpec, b.label, b.range as Range);
});

app.get('/api/tenants/:tenantId/dashboards/:id/tiles/:tileId/drill', async (req) => {
  const { tenantId, id, tileId } = req.params as { tenantId: string; id: string; tileId: string };
  const q = z.object({ label: z.string().max(500), range: z.enum(RANGES).default('THIS_YEAR') }).parse(req.query);
  const d = await loadDashboard(tenantId, id);
  const tile = d.tiles.find((t: TileSpec & { id: string }) => t.id === tileId);
  if (!tile) throw Object.assign(new Error('tile not found'), { statusCode: 404 });
  return drill(await SalesforceClient.forTenant(tenantId), tile, q.label, q.range as Range);
});

// ---- Smart features ----
// Suggested agents found in the org's data ($0: count queries only).
app.get('/api/tenants/:tenantId/suggestions', async (req) => {
  const { tenantId } = req.params as { tenantId: string };
  const refresh = (req.query as { refresh?: string }).refresh === '1';
  return suggestAgents(tenantId, await SalesforceClient.forTenant(tenantId), refresh);
});
app.post('/api/tenants/:tenantId/suggestions/:key/dismiss', async (req) => {
  const { tenantId, key } = req.params as { tenantId: string; key: string };
  await dismissSuggestion(tenantId, z.string().max(60).parse(key));
  return { ok: true };
});

// What the agent would have done over the last 30 days (preview on a sample, scaled up).
app.post('/api/tenants/:tenantId/workflows/:id/backtest', async (req) => {
  const { tenantId, id } = req.params as { tenantId: string; id: string };
  return backtest(tenantId, id);
});

// Health per agent and earned-autonomy suggestions.
app.get('/api/tenants/:tenantId/agent-health', async (req) => agentHealth((req.params as { tenantId: string }).tenantId));
app.post('/api/tenants/:tenantId/workflows/:id/autonomy', async (req) => {
  const { tenantId, id } = req.params as { tenantId: string; id: string };
  z.object({ approval: z.literal(false) }).parse(req.body);
  const { rows } = await pool.query('select graph from workflows where id=$1 and tenant_id=$2', [id, tenantId]);
  if (!rows[0]) throw Object.assign(new Error('workflow not found'), { statusCode: 404 });
  const graph = removeApproval(rows[0].graph);
  validateWorkflow(graph);
  await pool.query('update workflows set graph=$3, updated_at=now() where id=$1 and tenant_id=$2', [id, tenantId, JSON.stringify(graph)]);
  return { ok: true, graph };
});

// Why a run failed, and a fix to the step when one is possible.
app.post('/api/tenants/:tenantId/runs/:runId/diagnose', async (req) => {
  const { tenantId, runId } = req.params as { tenantId: string; runId: string };
  return diagnoseRun(tenantId, runId);
});
app.post('/api/tenants/:tenantId/workflows/:id/apply-fix', async (req) => {
  const { tenantId, id } = req.params as { tenantId: string; id: string };
  const b = z.object({ nodeId: z.string().max(64), changes: z.record(z.string().max(4000)) }).parse(req.body);
  return applyFix(tenantId, id, b.nodeId, b.changes);
});

// Automation already in the org (Flows, Apex triggers, validation rules).
app.get('/api/tenants/:tenantId/org-automation', async (req) => {
  const { tenantId } = req.params as { tenantId: string };
  const a = await orgAutomation(tenantId, await SalesforceClient.forTenant(tenantId), (req.query as { refresh?: string }).refresh === '1');
  return { flows: a.flows.length, triggers: a.triggers.length, rules: a.rules.length, flowList: a.flows.slice(0, 100) };
});

// Workspace rules in plain English, enforced by code before every write.
app.get('/api/tenants/:tenantId/rules', async (req) => listRules((req.params as { tenantId: string }).tenantId));
app.post('/api/tenants/:tenantId/rules', async (req) => {
  const { tenantId } = req.params as { tenantId: string };
  const b = z.object({ text: z.string().trim().min(8).max(500), timezone: z.string().max(64).default('UTC') }).parse(req.body);
  const rule = await compileRule(tenantId, b.text, b.timezone);
  const { rows } = await pool.query('insert into policies (tenant_id, text, rule) values ($1,$2,$3) returning id, text, rule, enabled, created_at', [tenantId, b.text, JSON.stringify(rule)]);
  return rows[0];
});
app.patch('/api/tenants/:tenantId/rules/:id', async (req) => {
  const { tenantId, id } = req.params as { tenantId: string; id: string };
  const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body);
  await pool.query('update policies set enabled=$3 where id=$1 and tenant_id=$2', [id, tenantId, enabled]);
  return { ok: true };
});
app.delete('/api/tenants/:tenantId/rules/:id', async (req) => {
  const { tenantId, id } = req.params as { tenantId: string; id: string };
  await pool.query('delete from policies where id=$1 and tenant_id=$2', [id, tenantId]);
  return { ok: true };
});

// Before saving an edit: what would come out differently on recent real runs (nothing written).
app.post('/api/tenants/:tenantId/workflows/:id/regression', async (req) => {
  const { tenantId, id } = req.params as { tenantId: string; id: string };
  const { graph } = z.object({ graph: z.any() }).parse(req.body);
  validateWorkflow(graph);
  return regression(tenantId, id, graph);
});

// Fields each agent may change, per object (empty = no limit beyond workspace rules).
app.put('/api/tenants/:tenantId/workflows/:id/allowed-fields', async (req) => {
  const { tenantId, id } = req.params as { tenantId: string; id: string };
  const { allowed } = z.object({ allowed: z.record(z.array(z.string().regex(/^\w+$/)).max(200)) }).parse(req.body);
  const clean = Object.fromEntries(Object.entries(allowed).filter(([o, f]) => /^\w+$/.test(o) && f.length));
  await pool.query('update workflows set allowed_fields=$3 where id=$1 and tenant_id=$2', [id, tenantId, JSON.stringify(clean)]);
  return { allowed: clean };
});

// Give every active Salesforce user access to the CRMagents panel, button and Flow actions.
// Put CRMagents on Salesforce pages (utility bar, record pages) without App Builder.
app.get('/api/tenants/:tenantId/salesforce/pages', async (req) => {
  const { object } = req.query as { object?: string };
  return listPages(await SalesforceClient.forTenant((req.params as { tenantId: string }).tenantId), object);
});
app.post('/api/tenants/:tenantId/salesforce/pages/utility', async (req) => {
  const { pageId } = z.object({ pageId: z.string() }).parse(req.body);
  return addToUtilityBar(await SalesforceClient.forTenant((req.params as { tenantId: string }).tenantId), pageId);
});
app.post('/api/tenants/:tenantId/salesforce/pages/record', async (req) => {
  const b = z.object({ object: z.string().regex(/^\w+$/), pageId: z.string().optional() }).parse(req.body);
  const sf = await SalesforceClient.forTenant((req.params as { tenantId: string }).tenantId);
  return addToRecordPage(sf, b.object, sf.instanceUrl, b.pageId);
});

app.post('/api/tenants/:tenantId/grant-access', async (req) => grantAccessToAll((req.params as { tenantId: string }).tenantId));

// Real-time trigger (Change Data Capture) instead of 1-minute checks.
app.post('/api/tenants/:tenantId/workflows/:id/realtime', async (req) => {
  const { tenantId, id } = req.params as { tenantId: string; id: string };
  const { on } = z.object({ on: z.boolean() }).parse(req.body);
  return setRealtime(tenantId, id, on);
});

// ---- AI usage (last 24 hours, whole workspace) ----
app.get('/api/usage', async (req) => {
  const accountId = req.user!.accountId;
  const { rows } = await pool.query(
    `select count(*)::int as runs,
            coalesce(sum(r.input_tokens),0)::bigint as input, coalesce(sum(r.cache_read_tokens),0)::bigint as cache_read,
            coalesce(sum(r.cache_write_tokens),0)::bigint as cache_write, coalesce(sum(r.output_tokens),0)::bigint as output,
            coalesce(sum(r.cost_usd),0)::float as cost_usd
     from runs r join tenants t on t.id = r.tenant_id
     where t.account_id = $1 and r.created_at > now() - interval '24 hours'`,
    [accountId],
  );
  const u = rows[0];
  const promptTokens = Number(u.input) + Number(u.cache_read) + Number(u.cache_write);
  return {
    runs: u.runs,
    costUsd: u.cost_usd,
    budgetUsd: await dailyBudgetUsd(accountId),
    tokens: { input: Number(u.input), cacheRead: Number(u.cache_read), cacheWrite: Number(u.cache_write), output: Number(u.output) },
    cacheHitRate: promptTokens ? Number(u.cache_read) / promptTokens : null,
  };
});

// ---- Tenants (connected orgs) ----
app.get('/api/tenants', async (req) => {
  const { rows } = await pool.query(
    'select id, sf_org_id, sf_instance_url, sf_username, setup_status, setup_message, use_package, created_at, api_used, api_max, api_checked_at from tenants where account_id = $1 order by created_at desc',
    [req.user!.accountId],
  );
  return rows;
});

app.delete('/api/tenants/:tenantId', async (req) => {
  await pool.query('delete from tenants where id = $1', [(req.params as { tenantId: string }).tenantId]);
  return { ok: true };
});

// Writes our URL and this org's signing secret into the package's settings inside Salesforce.
app.post('/api/tenants/:tenantId/provision', async (req) => provisionOrg((req.params as { tenantId: string }).tenantId));

app.post('/api/tenants/:tenantId/setup', async (req) => {
  void setupOrg((req.params as { tenantId: string }).tenantId);
  return { ok: true };
});

// ---- Impact: time saved, value and cost ----
app.get('/api/tenants/:tenantId/impact', async (req) => {
  const { days } = z.object({ days: z.coerce.number().int().refine((d) => [7, 30, 90].includes(d), '7, 30 or 90 days').default(30) }).parse(req.query);
  return impact((req.params as { tenantId: string }).tenantId, req.user!.accountId, days);
});
// ---- Alerts (agents failing, orgs disconnected) ----
app.get('/api/alerts', async (req) => listAlerts(req.user!.accountId));
app.post('/api/alerts/read', async (req) => { await markAlertsRead(req.user!.accountId); return { ok: true }; });

app.put('/api/impact/assumptions', async (req) => {
  const n = z.number().min(0).max(600);
  const b = z.object({ hourlyRate: z.number().min(1).max(10_000), minutes: z.object({ change: n, aiStep: n, replySent: n, suggestionUsed: n, answer: n, chat: n }) }).parse(req.body);
  await setAssumptions(req.user!.accountId, b);
  return { ok: true };
});

// ---- Webhook trigger: address and secret for an agent ----
app.get('/api/tenants/:tenantId/workflows/:id/webhook', async (req) => {
  const { tenantId, id } = req.params as { tenantId: string; id: string };
  return { url: webhookUrl(id), secret: await webhookSecret(tenantId, id) };
});
app.post('/api/tenants/:tenantId/workflows/:id/webhook/rotate', async (req) => {
  const { tenantId, id } = req.params as { tenantId: string; id: string };
  return { url: webhookUrl(id), secret: await webhookSecret(tenantId, id, true) };
});

// ---- Knowledge base (per account: the same guides serve every connected org) ----
app.get('/api/knowledge', async (req) => listDocuments(req.user!.accountId));

app.post('/api/knowledge', { bodyLimit: Math.ceil(MAX_UPLOAD_BYTES * 1.4) }, async (req) => {
  const b = z.object({
    title: z.string().max(200).optional(),
    fileName: z.string().max(300).optional(),
    data: z.string().optional(), // base64 file contents
    text: z.string().max(2_000_000).optional(), // or pasted text
  }).refine((v) => v.data || v.text, 'Upload a file or paste some text').parse(req.body);
  let kind: 'pdf' | 'docx' | 'text' = 'text';
  let text = b.text ?? '';
  if (b.data) {
    const buf = Buffer.from(b.data, 'base64');
    if (buf.length > MAX_UPLOAD_BYTES) throw Object.assign(new Error('Files up to 15 MB'), { statusCode: 400 });
    try {
      let pages: number | undefined;
      ({ kind, text, pages } = await extractText(b.fileName ?? 'file.txt', buf));
      // A scan (pages that are only images): Claude reads the pages.
      if (kind === 'pdf' && looksScanned(text)) text = await ocrPdf(req.user!.accountId, buf, pages ?? 1, b.fileName ?? 'PDF');
    } catch (e) {
      throw Object.assign(new Error((e as Error).message || 'Could not read this file'), { statusCode: 400 });
    }
  }
  const title = b.title?.trim() || (b.fileName ?? 'Untitled').replace(/\.[a-z0-9]+$/i, '').replace(/[_-]+/g, ' ').trim();
  return addDocument(req.user!.accountId, { title, fileName: b.fileName, kind, text, createdBy: req.user!.email });
});

app.delete('/api/knowledge/:id', async (req) => {
  await deleteDocument(req.user!.accountId, (req.params as { id: string }).id);
  return { ok: true };
});

app.post('/api/knowledge/search', async (req) => {
  const b = z.object({ query: z.string().min(1).max(2000), limit: z.number().int().optional() }).parse(req.body);
  return searchKnowledge(req.user!.accountId, b.query, b.limit ?? 5);
});

// Knowledge that lives in Salesforce (Knowledge articles, Files libraries), synced daily.
app.get('/api/knowledge/sources', async (req) => listSources(req.user!.accountId));
app.post('/api/knowledge/sources', async (req) => {
  const b = z.object({ tenantId: z.string().uuid(), kind: z.enum(['articles', 'library']), library: z.string().max(255).optional() }).parse(req.body);
  const own = await pool.query('select 1 from tenants where id=$1 and account_id=$2', [b.tenantId, req.user!.accountId]);
  if (!own.rowCount) throw Object.assign(new Error('not found'), { statusCode: 404 });
  if (b.kind === 'library' && !b.library?.trim()) throw Object.assign(new Error('Name the Files library'), { statusCode: 400 });
  return addSource(req.user!.accountId, b.tenantId, b.kind, b.library?.trim());
});
app.post('/api/knowledge/sources/:id/sync', async (req) => {
  const { id } = req.params as { id: string };
  const own = await pool.query('select 1 from knowledge_sources where id=$1 and account_id=$2', [id, req.user!.accountId]);
  if (!own.rowCount) throw Object.assign(new Error('not found'), { statusCode: 404 });
  return syncSource(id);
});
app.delete('/api/knowledge/sources/:id', async (req) => {
  await removeSource(req.user!.accountId, (req.params as { id: string }).id);
  return { ok: true };
});

// ---- Suggestions saved on records ----
app.get('/api/tenants/:tenantId/record-suggestions', async (req) => listSuggestions((req.params as { tenantId: string }).tenantId));
app.post('/api/tenants/:tenantId/record-suggestions/:id', async (req) => {
  const { tenantId, id } = req.params as { tenantId: string; id: string };
  const b = z.object({ status: z.enum(['helpful', 'not_helpful', 'dismissed']) }).parse(req.body);
  await markSuggestion(tenantId, id, b.status, req.user!.email);
  return { ok: true };
});

// ---- Tools catalog ----
app.get('/api/tools', async () =>
  Object.entries(TOOLS).filter(([, t]) => !t.publicOnly).map(([name, t]) => ({
    name,
    description: 'description' in t.def && t.def.description ? t.def.description : 'Search the internet and read pages (company and person research, news, competitors). Answers cite their sources. About $0.01 per search.',
    write: t.write,
  })),
);

// ---- Agents ----
const agentBody = z.object({
  name: z.string().min(1),
  systemPrompt: z.string().default(''),
  tools: z.array(z.string().refine((t) => t in TOOLS && !TOOLS[t].publicOnly, 'unknown tool')).default([]),
});

app.get('/api/tenants/:tenantId/agents', async (req) => {
  const { rows } = await pool.query(
    `select id, name, system_prompt as "systemPrompt", tools, created_at from agents
     where tenant_id = $1 order by created_at desc`,
    [(req.params as { tenantId: string }).tenantId],
  );
  return rows;
});

app.post('/api/tenants/:tenantId/agents', async (req) => {
  const { tenantId } = req.params as { tenantId: string };
  const b = agentBody.parse(req.body);
  const { rows } = await pool.query(
    'insert into agents (tenant_id, name, system_prompt, tools) values ($1,$2,$3,$4) returning id',
    [tenantId, b.name, b.systemPrompt, b.tools],
  );
  return { id: rows[0].id };
});

app.put('/api/tenants/:tenantId/agents/:agentId', async (req) => {
  const { tenantId, agentId } = req.params as { tenantId: string; agentId: string };
  const b = agentBody.parse(req.body);
  const r = await pool.query(
    'update agents set name=$3, system_prompt=$4, tools=$5 where id=$2 and tenant_id=$1',
    [tenantId, agentId, b.name, b.systemPrompt, b.tools],
  );
  if (!r.rowCount) throw Object.assign(new Error('not found'), { statusCode: 404 });
  return { ok: true };
});

app.delete('/api/tenants/:tenantId/agents/:agentId', async (req) => {
  const { tenantId, agentId } = req.params as { tenantId: string; agentId: string };
  await pool.query('delete from agents where id=$2 and tenant_id=$1', [tenantId, agentId]);
  return { ok: true };
});

// Website chat for an assistant.
app.get('/api/tenants/:tenantId/agents/:agentId/public', async (req) => {
  const { tenantId, agentId } = req.params as { tenantId: string; agentId: string };
  return publicChatInfo(tenantId, agentId);
});
app.put('/api/tenants/:tenantId/agents/:agentId/public', async (req) => {
  const { tenantId, agentId } = req.params as { tenantId: string; agentId: string };
  const b = z.object({ enabled: z.boolean(), origins: z.string().max(2000).default(''), cases: z.boolean().default(true), greeting: z.string().max(300).default(''), selfService: z.unknown().optional(), sms: z.boolean().optional() }).parse(req.body);
  return setPublicChat(tenantId, agentId, b);
});

// Test sets for an assistant.
const ownAgent = async (tenantId: string, agentId: string) => {
  const r = await pool.query('select 1 from agents where id=$1 and tenant_id=$2', [agentId, tenantId]);
  if (!r.rowCount) throw Object.assign(new Error('Assistant not found'), { statusCode: 404 });
};
const testBody = z.object({
  question: z.string().trim().min(1, 'Write the question').max(2000),
  expect: z.string().max(4000).default(''),
  mustInclude: z.array(z.string().max(200)).max(10).default([]),
  mustNot: z.array(z.string().max(200)).max(10).default([]),
});
app.get('/api/tenants/:tenantId/agents/:agentId/tests', async (req) => {
  const { tenantId, agentId } = req.params as { tenantId: string; agentId: string };
  await ownAgent(tenantId, agentId);
  const [tests, runs] = await Promise.all([listTests(agentId), listTestRuns(agentId)]);
  return { tests, runs };
});
app.get('/api/tenants/:tenantId/agents/:agentId/tests/recent', async (req) => {
  const { tenantId, agentId } = req.params as { tenantId: string; agentId: string };
  await ownAgent(tenantId, agentId);
  return recentQuestions(tenantId, agentId);
});
app.post('/api/tenants/:tenantId/agents/:agentId/tests', async (req) => {
  const { tenantId, agentId } = req.params as { tenantId: string; agentId: string };
  await ownAgent(tenantId, agentId);
  return saveTest(agentId, testBody.parse(req.body));
});
app.put('/api/tenants/:tenantId/agents/:agentId/tests/:id', async (req) => {
  const { tenantId, agentId, id } = req.params as { tenantId: string; agentId: string; id: string };
  await ownAgent(tenantId, agentId);
  return saveTest(agentId, testBody.parse(req.body), id);
});
app.delete('/api/tenants/:tenantId/agents/:agentId/tests/:id', async (req) => {
  const { tenantId, agentId, id } = req.params as { tenantId: string; agentId: string; id: string };
  await ownAgent(tenantId, agentId);
  await deleteTest(agentId, id);
  return { ok: true };
});
app.post('/api/tenants/:tenantId/agents/:agentId/tests/run', async (req) => {
  const { tenantId, agentId } = req.params as { tenantId: string; agentId: string };
  const b = z.object({ channel: z.enum(['internal', 'website']).default('internal') }).parse(req.body ?? {});
  return startTestRun(tenantId, agentId, b.channel, req.user!.email);
});

const runBody = z.object({ input: z.string().min(1), context: z.unknown().optional(), history: z.array(z.object({ role: z.enum(['user', 'assistant']), text: z.string().max(20000) })).max(40).optional() });

app.post('/api/tenants/:tenantId/agents/:agentId/run', async (req, reply) => {
  const { tenantId, agentId } = req.params as { tenantId: string; agentId: string };
  const b = runBody.parse(req.body);
  const { rows } = await pool.query(
    'select id, system_prompt, tools from agents where id = $1 and tenant_id = $2',
    [agentId, tenantId],
  );
  if (!rows[0]) return reply.code(404).send({ error: 'agent not found' });
  return runAgent(
    tenantId,
    { id: rows[0].id, systemPrompt: rows[0].system_prompt, tools: rows[0].tools },
    b.input,
    b.context,
    b.history,
  );
});

// ---- Workflows ----
const wfBody = z.object({
  name: z.string().min(1),
  graph: z.object({ nodes: z.array(z.any()), edges: z.array(z.any()) }),
});

app.get('/api/tenants/:tenantId/workflows', async (req) => {
  const { rows } = await pool.query(
    'select id, name, graph, updated_at, sf_flow_name, sf_deployed_at, live, live_since, watch_error, paused_reason, realtime, allowed_fields from workflows where tenant_id=$1 order by updated_at desc',
    [(req.params as { tenantId: string }).tenantId],
  );
  return rows;
});

app.post('/api/tenants/:tenantId/workflows', async (req) => {
  const b = wfBody.parse(req.body);
  const { rows } = await pool.query(
    'insert into workflows (tenant_id, name, graph) values ($1,$2,$3) returning id',
    [(req.params as { tenantId: string }).tenantId, b.name, JSON.stringify(b.graph)],
  );
  await saveVersion(rows[0].id, b.name, b.graph, req.user!.email);
  return { id: rows[0].id };
});

app.put('/api/tenants/:tenantId/workflows/:id', async (req) => {
  const { tenantId, id } = req.params as { tenantId: string; id: string };
  const b = wfBody.parse(req.body);
  validateWorkflow(b.graph as Workflow);
  const r = await pool.query('update workflows set name=$3, graph=$4, updated_at=now() where id=$2 and tenant_id=$1', [
    tenantId, id, b.name, JSON.stringify(b.graph),
  ]);
  if (!r.rowCount) throw Object.assign(new Error('not found'), { statusCode: 404 });
  await saveVersion(id, b.name, b.graph, req.user!.email);
  return { ok: true };
});

app.delete('/api/tenants/:tenantId/workflows/:id', async (req) => {
  const { tenantId, id } = req.params as { tenantId: string; id: string };
  const r = await pool.query('delete from workflows where id=$2 and tenant_id=$1', [tenantId, id]);
  if (!r.rowCount) throw Object.assign(new Error('not found'), { statusCode: 404 });
  return { ok: true };
});

// Plain-English request -> validated workflow draft (not saved; the editor saves it).
app.post('/api/tenants/:tenantId/workflows/draft', async (req) => {
  const { tenantId } = req.params as { tenantId: string };
  const b = z.object({ request: z.string().trim().min(5, 'Describe what the workflow should do').max(2000), plan: z.any().optional(), timezone: z.string().max(60).optional() }).parse(req.body);
  return draftWorkflow(tenantId, b.request, b.plan, b.timezone);
});

// Build an agent by chatting: short clarifying questions, then a validated draft.
app.post('/api/tenants/:tenantId/builder/chat', async (req) => {
  const { tenantId } = req.params as { tenantId: string };
  const b = z.object({
    messages: z.array(z.object({ role: z.enum(['user', 'assistant']), text: z.string().max(4000) })).min(1).max(30),
    plan: z.any().optional(),
    timezone: z.string().max(60).optional(),
  }).parse(req.body);
  return builderChat(tenantId, b.messages, b.plan, b.timezone);
});

// The org's own automations an agent can use (invocable Apex, autolaunched Flows, standard actions).
app.get('/api/tenants/:tenantId/org-actions', async (req) => {
  const { tenantId } = req.params as { tenantId: string };
  return listOrgActions(tenantId, await SalesforceClient.forTenant(tenantId));
});

const triggerBody = z.object({
  input: z.string().optional(),
  recordId: z.string().optional(),
  objectApiName: z.string().optional(),
  context: z.unknown().optional(),
});

app.post('/api/tenants/:tenantId/workflows/:id/run', async (req) => {
  const { tenantId, id } = req.params as { tenantId: string; id: string };
  return startRun(tenantId, id, triggerBody.parse(req.body ?? {}), req.user!.email);
});

// Dry run on recent records: AI runs for real, nothing is written to Salesforce.
app.post('/api/tenants/:tenantId/workflows/:id/preview', async (req) => {
  const { tenantId, id } = req.params as { tenantId: string; id: string };
  const { limit } = z.object({ limit: z.number().int().min(1).max(20).optional() }).parse(req.body ?? {});
  return previewWorkflow(tenantId, id, limit ?? 10);
});

// Admin feedback on an AI decision: a correction or a confirmation becomes an example for that block.
app.post('/api/tenants/:tenantId/workflows/:id/feedback', async (req, reply) => {
  const { tenantId, id } = req.params as { tenantId: string; id: string };
  const b = z.object({
    nodeId: z.string().min(1), input: z.string().min(1).max(4000), label: z.string().min(1).max(200),
    source: z.enum(['correction', 'confirmed']),
  }).parse(req.body);
  const { rowCount } = await pool.query('select 1 from workflows where id=$1 and tenant_id=$2', [id, tenantId]);
  if (!rowCount) return reply.code(404).send({ error: 'workflow not found' });
  await addExample(tenantId, id, b.nodeId, b.input, b.label, b.source);
  return { ok: true, examples: await exampleCount(id) };
});

// Turn a workflow on/off: our server watches the org for new or changed records (no Salesforce package needed).
app.post('/api/tenants/:tenantId/workflows/:id/live', async (req) => {
  const { tenantId, id } = req.params as { tenantId: string; id: string };
  const { on } = z.object({ on: z.boolean() }).parse(req.body);
  return setLive(tenantId, id, on);
});

// Optional add-on: install the Salesforce package (record-page panel + Flow action) into an org.
app.post('/api/tenants/:tenantId/package', async (req) => {
  const { tenantId } = req.params as { tenantId: string };
  const { on } = z.object({ on: z.boolean() }).parse(req.body);
  await pool.query('update tenants set use_package=$2 where id=$1', [tenantId, on]);
  if (on) void setupOrg(tenantId);
  return { ok: true };
});

// One-click: create/remove the Salesforce Flow that runs this workflow whenever a record is created.
app.post('/api/tenants/:tenantId/workflows/:id/deploy', async (req) => {
  const { tenantId, id } = req.params as { tenantId: string; id: string };
  return deployWorkflow(tenantId, id);
});
app.delete('/api/tenants/:tenantId/workflows/:id/deploy', async (req) => {
  const { tenantId, id } = req.params as { tenantId: string; id: string };
  return undeployWorkflow(tenantId, id);
});

// Run on records that already exist (queued, newest first).
app.post('/api/tenants/:tenantId/workflows/:id/backfill', async (req) => {
  const { tenantId, id } = req.params as { tenantId: string; id: string };
  const b = z.object({ days: z.number().int().min(1).max(3650), limit: z.number().int().min(1).max(2000) }).parse(req.body);
  return backfill(tenantId, id, b.days, b.limit, req.user!.email);
});

// Version history, export and copying agents between orgs.
app.get('/api/tenants/:tenantId/workflows/:id/versions', async (req) => {
  const { tenantId, id } = req.params as { tenantId: string; id: string };
  return listVersions(tenantId, id);
});
app.post('/api/tenants/:tenantId/workflows/:id/versions/:vid/restore', async (req) => {
  const { tenantId, id, vid } = req.params as { tenantId: string; id: string; vid: string };
  return restoreVersion(tenantId, id, Number(vid), req.user!.email);
});
app.get('/api/tenants/:tenantId/workflows/:id/export', async (req) => {
  const { tenantId, id } = req.params as { tenantId: string; id: string };
  return exportAgent(tenantId, id);
});
app.post('/api/tenants/:tenantId/workflows/import', { bodyLimit: 5_000_000 }, async (req) => {
  const { tenantId } = req.params as { tenantId: string };
  const b = z.object({ format: z.literal('crmagents-agent@1').optional(), name: z.string().min(1).max(200), graph: z.any() }).parse(req.body);
  return importAgent(tenantId, { name: b.name, graph: b.graph }, req.user!.email);
});
app.post('/api/tenants/:tenantId/workflows/:id/copy', async (req) => {
  const { tenantId, id } = req.params as { tenantId: string; id: string };
  const { targetTenantId, name } = z.object({ targetTenantId: z.string().uuid(), name: z.string().max(200).optional() }).parse(req.body);
  const own = await pool.query('select 1 from tenants where id=$1 and account_id=$2', [targetTenantId, req.user!.accountId]);
  if (!own.rowCount) throw Object.assign(new Error('not found'), { statusCode: 404 });
  const ex = await exportAgent(tenantId, id);
  return importAgent(targetTenantId, { name: name || ex.name, graph: ex.graph }, req.user!.email);
});

app.post('/api/tenants/:tenantId/runs/:runId/decision', async (req) => {
  const { tenantId, runId } = req.params as { tenantId: string; runId: string };
  const { approve, note } = z.object({ approve: z.boolean(), note: z.string().max(500).optional() }).parse(req.body);
  return decideRun(tenantId, runId, approve, note, req.user!.email, req.user!.role);
});

// Stop a run (takes effect at the next step) or continue one that stopped mid-way.
app.post('/api/tenants/:tenantId/runs/:runId/cancel', async (req) => {
  const { tenantId, runId } = req.params as { tenantId: string; runId: string };
  return cancelRun(tenantId, runId, req.user!.email);
});
app.post('/api/tenants/:tenantId/runs/:runId/resume', async (req) => {
  const { tenantId, runId } = req.params as { tenantId: string; runId: string };
  return resumeRun(tenantId, runId);
});

app.get('/api/tenants/:tenantId/runs', async (req) => {
  const { rows } = await pool.query(
    `select r.id, r.status, r.input, r.output, r.trace, r.steps, r.input_tokens, r.output_tokens,
            r.cache_read_tokens, r.cache_write_tokens, r.cost_usd::float as cost_usd, r.created_at,
            coalesce(w.name, a.name, case when r.input ? 'builder' then 'AI builder' when r.input ? 'insights' then 'AI insights' end) as agent_name, r.workflow_id, r.decided_by, r.decision_note, r.decided_at, r.purged_at, r.started_by, r.assigned_to, r.assigned_label
     from runs r left join agents a on a.id = r.agent_id left join workflows w on w.id = r.workflow_id
     where r.tenant_id = $1 and ($2::text is null or r.status = $2) order by r.created_at desc limit 50`,
    [(req.params as { tenantId: string }).tenantId, (req.query as { status?: string }).status ?? null],
  );
  return rows;
});

await migrate();
startWatcher(app.log);
await app.listen({ port: config.port, host: '0.0.0.0' });
