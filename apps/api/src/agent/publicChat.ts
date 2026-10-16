import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { pool } from '../db.js';
import { runAgent } from './runner.js';
import { DEFAULT_CONFIG, normalizeConfig, selfServiceExec, selfServicePrompt, selfServiceTools } from './selfService.js';
import { SalesforceClient } from '../salesforce/client.js';
import { WIDGET_JS } from './widget.js';

// Website chat: an assistant answering the public on the customer's own website or Experience Cloud site.
// Visitors get only what's safe in public: the company's guides, opening a case, and the status of their own case
// (case number + the email it was opened with). No other Salesforce data is reachable. Rate-limited per visitor
// and per assistant, and every answer counts toward the workspace's AI budget.

const PER_MINUTE = 12; // messages per visitor (IP)
const PER_DAY = 2000; // messages per assistant
const MAX_TURNS = 20;

const PUBLIC_RULES = `You are chatting with a member of the public on the company's website.
- Answer only from the company's guides (search_knowledge). If they don't cover it, say so and offer to open a case.
- Never claim to see the visitor's account, orders or records unless they verified their email in this chat with the code (when that is offered).
- Before opening a case, ask for their name, email and a short description, and confirm.
- Keep answers short and friendly: one or two sentences, then a few short bullets if needed.`;

const visitors = new Map<string, number[]>();
const daily = new Map<string, { day: string; n: number }>();

function limited(ip: string, key: string): string | null {
  const now = Date.now();
  const recent = (visitors.get(ip) ?? []).filter((t) => now - t < 60_000);
  if (recent.length >= PER_MINUTE) return 'Too many messages. Please wait a minute.';
  recent.push(now);
  visitors.set(ip, recent);
  if (visitors.size > 50_000) visitors.clear();
  const day = new Date().toISOString().slice(0, 10);
  const d = daily.get(key);
  const n = d && d.day === day ? d.n : 0;
  if (n >= PER_DAY) return 'This chat is busy right now. Please try again later.';
  daily.set(key, { day, n: n + 1 });
  return null;
}

/** Whether a website may use the chat: listed origins only, or any when none are listed. Pure; tested. */
export function originAllowed(origin: string | undefined, list: string): boolean {
  const allowed = list.split(/[\s,]+/).map((o) => o.trim().replace(/\/$/, '').toLowerCase()).filter(Boolean);
  if (!allowed.length) return true;
  if (!origin) return false;
  const o = origin.replace(/\/$/, '').toLowerCase();
  return allowed.some((a) => a === o || (a.startsWith('*.') && o.endsWith(a.slice(1)) && /^https:\/\//.test(o)));
}

async function byKey(key: string) {
  const { rows } = await pool.query(
    `select a.id, a.tenant_id, a.name, a.system_prompt, a.public_enabled, a.public_origins, a.public_cases, a.public_greeting, a.public_config, acc.name as company
     from agents a join tenants t on t.id = a.tenant_id join accounts acc on acc.id = t.account_id where a.public_key=$1`, [key]);
  return rows[0] as { id: string; tenant_id: string; name: string; system_prompt: string; public_enabled: boolean; public_origins: string; public_cases: boolean; public_greeting: string; public_config: unknown; company: string } | undefined;
}

function cors(req: FastifyRequest, reply: FastifyReply, origins: string) {
  const origin = req.headers.origin;
  if (!originAllowed(origin, origins)) return false;
  reply.header('Access-Control-Allow-Origin', origin ?? '*');
  reply.header('Vary', 'Origin');
  reply.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  reply.header('Access-Control-Allow-Headers', 'Content-Type');
  return true;
}

export function registerPublicChat(app: FastifyInstance) {
  app.get('/public/widget.js', async (_req, reply) => {
    reply.header('Content-Type', 'application/javascript; charset=utf-8').header('Cache-Control', 'public, max-age=300');
    return WIDGET_JS;
  });

  app.options('/public/chat/:key', async (req, reply) => {
    const a = await byKey((req.params as { key: string }).key);
    if (!a || !cors(req, reply, a.public_origins)) return reply.code(403).send();
    return reply.code(204).send();
  });

  app.get('/public/chat/:key', async (req, reply) => {
    const a = await byKey((req.params as { key: string }).key);
    if (!a || !a.public_enabled) return reply.code(404).send({ error: 'Chat not available' });
    if (!cors(req, reply, a.public_origins)) return reply.code(403).send({ error: 'This website may not use this chat' });
    return { name: a.name, greeting: a.public_greeting || `Hi! I'm ${a.name}. How can I help?` };
  });

  app.post('/public/chat/:key', { bodyLimit: 100_000 }, async (req, reply) => {
    const key = (req.params as { key: string }).key;
    const a = await byKey(key);
    if (!a || !a.public_enabled) return reply.code(404).send({ error: 'Chat not available' });
    if (!cors(req, reply, a.public_origins)) return reply.code(403).send({ error: 'This website may not use this chat' });
    const b = z.object({
      messages: z.array(z.object({ role: z.enum(['user', 'assistant']), text: z.string().max(2000) })).min(1).max(40),
      /** The widget's conversation id (identity for self-service lives on the server under it). */
      sessionId: z.string().uuid().optional(),
    }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'Bad message' });
    const busy = limited(req.ip, key);
    if (busy) return reply.code(429).send({ error: busy });
    const msgs = b.data.messages.slice(-MAX_TURNS);
    const last = msgs[msgs.length - 1];
    if (last.role !== 'user' || !last.text.trim()) return reply.code(400).send({ error: 'Say something' });
    try {
      const cfg = normalizeConfig(a.public_config);
      const transcript = msgs.map((m) => `${m.role === 'user' ? 'Visitor' : a.name}: ${m.text}`).join('\n\n');
      const exec = selfServiceExec({ agentId: a.id, sessionId: b.data.sessionId ?? null, config: cfg, sf: () => SalesforceClient.forTenant(a.tenant_id), transcript, companyName: a.company || 'account' });
      const r = await runAgent(a.tenant_id, {
        id: a.id,
        systemPrompt: [a.system_prompt, PUBLIC_RULES, selfServicePrompt(cfg)].filter(Boolean).join('\n\n'),
        tools: ['search_knowledge', ...(a.public_cases ? ['open_case', 'case_status'] : []), ...selfServiceTools(cfg)],
      }, last.text, undefined, msgs.slice(0, -1), { startedBy: 'website', exec });
      return { answer: r.output };
    } catch (e) {
      req.log.warn({ err: String(e) }, 'public chat failed');
      return reply.code(503).send({ error: 'Sorry, I can\'t answer right now. Please try again later.' });
    }
  });
}

/** Turn website chat on/off for an assistant; the key is created on first use. */
export async function setPublicChat(tenantId: string, agentId: string, b: { enabled: boolean; origins: string; cases: boolean; greeting: string; selfService?: unknown }) {
  const { rows } = await pool.query('select public_key from agents where id=$1 and tenant_id=$2', [agentId, tenantId]);
  if (!rows[0]) throw Object.assign(new Error('assistant not found'), { statusCode: 404 });
  const key = rows[0].public_key ?? `pc_${randomBytes(18).toString('base64url')}`;
  await pool.query('update agents set public_key=$2, public_enabled=$3, public_origins=$4, public_cases=$5, public_greeting=$6, public_config=coalesce($7, public_config) where id=$1',
    [agentId, key, b.enabled, b.origins.slice(0, 2000), b.cases, b.greeting.slice(0, 300), b.selfService === undefined ? null : JSON.stringify(normalizeConfig(b.selfService))]);
  return publicChatInfo(tenantId, agentId);
}

export async function publicChatInfo(tenantId: string, agentId: string) {
  const { rows } = await pool.query('select public_key, public_enabled, public_origins, public_cases, public_greeting, public_config from agents where id=$1 and tenant_id=$2', [agentId, tenantId]);
  const a = rows[0];
  if (!a) throw Object.assign(new Error('assistant not found'), { statusCode: 404 });
  const base = config.bridgeUrl.replace(/\/$/, '');
  return {
    enabled: a.public_enabled, origins: a.public_origins, cases: a.public_cases, greeting: a.public_greeting,
    selfService: { ...DEFAULT_CONFIG, ...normalizeConfig(Object.keys(a.public_config ?? {}).length ? a.public_config : DEFAULT_CONFIG) },
    snippet: a.public_key ? `<script src="${base}/public/widget.js" data-crmagents-key="${a.public_key}" async></script>` : '',
  };
}
