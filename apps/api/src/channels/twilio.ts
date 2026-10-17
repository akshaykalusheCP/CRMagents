import { hasFeature } from '../plans.js';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { pool } from '../db.js';
import { overLimit } from '../ratelimit.js';
import { getSetting } from '../settings.js';
import { websiteSpec } from '../agent/publicChat.js';
import { runAgent } from '../agent/runner.js';
import { normalizeConfig, selfServiceExec } from '../agent/selfService.js';
import { SalesforceClient } from '../salesforce/client.js';

// Text messages through the company's own Twilio account: SMS and WhatsApp.
// In: a customer texts the company's number; Twilio calls /public/twilio/<assistant key>; the request is checked
// with Twilio's signature, answered at once (Twilio waits only 15 s), and the assistant's reply follows as a new
// message. The assistant has the same public rules and tools as on the website, and remembers the conversation
// per phone number for 24 hours.
// Out: the "Send text message" step of an agent.

const PER_MINUTE = 6;   // messages per phone number
const PER_DAY = 2000;   // messages per assistant
const MEMORY_HOURS = 24;
const MAX_TEXT = 1500;  // Twilio splits long SMS; WhatsApp allows ~4096

const TEXT_RULES = `You are replying by text message (SMS or WhatsApp). Keep replies short: two or three sentences, under 600 characters.
No tables, headings or links in markdown; plain text and simple lists only.`;

export interface TwilioAccount { sid: string; token: string; sms: string; whatsapp: string }

export async function twilioAccount(accountId: string): Promise<TwilioAccount | null> {
  const [sid, token, sms, whatsapp] = await Promise.all(['twilioSid', 'twilioToken', 'twilioSms', 'twilioWhatsapp'].map((k) => getSetting(accountId, k as 'twilioSid')));
  return sid && token ? { sid, token, sms: sms ?? '', whatsapp: whatsapp ?? '' } : null;
}

/** Twilio's request signature: HMAC-SHA1 of the full URL followed by each POST field name and value, sorted by name. Pure; tested. */
export function twilioSignature(token: string, url: string, params: Record<string, string>): string {
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join('');
  return createHmac('sha1', token).update(Buffer.from(data, 'utf-8')).digest('base64');
}

export function validTwilioSignature(token: string, url: string, params: Record<string, string>, given: string): boolean {
  const want = Buffer.from(twilioSignature(token, url, params));
  const got = Buffer.from(given ?? '');
  return want.length === got.length && timingSafeEqual(want, got);
}

/** Markdown from the assistant as a text message: WhatsApp bold is *x*, SMS has none. Pure; tested. */
export function asText(md: string, channel: 'sms' | 'whatsapp'): string {
  let t = md.replace(/\r/g, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '$1: $2')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^\s*[-*]\s+/gm, '• ');
  t = channel === 'whatsapp' ? t.replace(/\*\*([^*]+)\*\*/g, '*$1*') : t.replace(/\*\*([^*]+)\*\*/g, '$1');
  t = t.replace(/\n{3,}/g, '\n\n').trim();
  return t.length > MAX_TEXT ? `${t.slice(0, MAX_TEXT - 1)}…` : t;
}

/** A stable conversation id per assistant and phone number (website-style session for self-service). */
export function sessionIdFor(agentId: string, address: string): string {
  const h = createHash('sha256').update(`${agentId}|${address}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** Send one text (SMS, or WhatsApp when `channel` says so) from the workspace's Twilio number. */
export async function sendText(accountId: string, m: { to: string; body: string; channel: 'sms' | 'whatsapp'; from?: string }) {
  const tw = await twilioAccount(accountId);
  if (!tw) throw new Error('Connect Twilio first (Settings → AI & spending → Text messages).');
  const bare = m.to.replace(/^whatsapp:/, '').replace(/[\s()-]/g, '');
  if (!/^\+\d{7,15}$/.test(bare)) throw new Error(`"${m.to}" is not a phone number in international format, like +14155550100.`);
  const from = m.from ?? (m.channel === 'whatsapp' ? tw.whatsapp : tw.sms);
  if (!from) throw new Error(`Add your Twilio ${m.channel === 'whatsapp' ? 'WhatsApp sender' : 'SMS number'} in Settings first.`);
  const wa = (n: string) => (n.startsWith('whatsapp:') ? n : `whatsapp:${n}`);
  const body = new URLSearchParams({
    To: m.channel === 'whatsapp' ? wa(bare) : bare,
    From: m.channel === 'whatsapp' ? wa(from) : from,
    Body: asText(m.body, m.channel),
  });
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(tw.sid)}/Messages.json`, {
    method: 'POST',
    headers: { Authorization: `Basic ${Buffer.from(`${tw.sid}:${tw.token}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const j = (await res.json().catch(() => ({}))) as { sid?: string; message?: string };
  if (!res.ok) throw new Error(`Twilio: ${j.message ?? res.status}`);
  return { sid: j.sid };
}

/** The address Twilio should call for an assistant. */
export const twilioWebhookUrl = (publicKey: string) => `${config.bridgeUrl.replace(/\/$/, '')}/public/twilio/${publicKey}`;

async function byKey(key: string) {
  const { rows } = await pool.query(
    `select a.id, a.tenant_id, a.name, a.system_prompt, a.public_cases, a.public_config, a.sms_enabled, t.account_id, acc.name as company
     from agents a join tenants t on t.id = a.tenant_id join accounts acc on acc.id = t.account_id where a.public_key=$1`, [key]);
  return rows[0] as { id: string; tenant_id: string; name: string; system_prompt: string; public_cases: boolean; public_config: unknown; sms_enabled: boolean; account_id: string; company: string } | undefined;
}

const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

export function registerTwilio(app: FastifyInstance) {
  // Twilio posts form fields. Only its webhook accepts them: everything else takes JSON only, which a plain
  // cross-site HTML form can't send.
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (req, body, done) => {
    if (!req.url.startsWith('/public/twilio/')) return done(Object.assign(new Error('Unsupported content type'), { statusCode: 415 }), undefined);
    done(null, Object.fromEntries(new URLSearchParams(String(body ?? ''))));
  });

  app.post('/public/twilio/:key', { bodyLimit: 64_000 }, async (req, reply) => {
    const key = (req.params as { key: string }).key;
    const a = await byKey(key);
    const tw = a && await twilioAccount(a.account_id);
    if (!a || !tw) return reply.code(404).send();
    const params = (req.body ?? {}) as Record<string, string>;
    // Checked against the address Twilio was given (our public URL), not what the proxy forwarded.
    if (!validTwilioSignature(tw.token, twilioWebhookUrl(key), params, String(req.headers['x-twilio-signature'] ?? ''))) {
      req.log.warn('twilio signature mismatch');
      return reply.code(403).send();
    }
    reply.header('Content-Type', 'text/xml');
    if (!(await hasFeature(a.account_id, 'textMessages'))) return EMPTY_TWIML;
    const fromRaw = String(params.From ?? ''), toRaw = String(params.To ?? ''), text = String(params.Body ?? '').trim();
    if (!a.sms_enabled || !fromRaw || !text) return EMPTY_TWIML;
    const channel: 'sms' | 'whatsapp' = fromRaw.startsWith('whatsapp:') ? 'whatsapp' : 'sms';
    const address = fromRaw.replace(/^whatsapp:/, '');
    if (await overLimit(`text|${a.id}|${address}`, PER_MINUTE, 60)) return EMPTY_TWIML;
    if (await overLimit(`text|day|${a.id}|${new Date().toISOString().slice(0, 10)}`, PER_DAY, 86_400)) return EMPTY_TWIML;
    // Answer in the background: Twilio gives up after 15 seconds.
    void answer(a, { channel, address, to: toRaw.replace(/^whatsapp:/, ''), text }).catch((e) => req.log.warn({ err: String(e) }, 'text reply failed'));
    return EMPTY_TWIML;
  });
}

async function answer(a: NonNullable<Awaited<ReturnType<typeof byKey>>>, m: { channel: 'sms' | 'whatsapp'; address: string; to: string; text: string }) {
  const { rows } = await pool.query(
    `select role, text from channel_messages where agent_id=$1 and address=$2 and created_at > now() - ($3 || ' hours')::interval
     order by created_at desc limit 20`, [a.id, m.address, String(MEMORY_HOURS)]);
  const history = rows.reverse() as { role: 'user' | 'assistant'; text: string }[];
  await pool.query('insert into channel_messages (agent_id, channel, address, role, text) values ($1,$2,$3,$4,$5)', [a.id, m.channel, m.address, 'user', m.text.slice(0, 4000)]);
  const sessionId = sessionIdFor(a.id, m.address);
  const transcript = [...history, { role: 'user', text: m.text }].map((x) => `${x.role === 'user' ? `Customer (${m.address})` : a.name}: ${x.text}`).join('\n\n');
  const exec = selfServiceExec({ agentId: a.id, sessionId, config: normalizeConfig(a.public_config), sf: () => SalesforceClient.forTenant(a.tenant_id), transcript, companyName: a.company || 'account' });
  const spec = websiteSpec(a);
  let reply: string;
  try {
    const r = await runAgent(a.tenant_id, { ...spec, systemPrompt: `${spec.systemPrompt}\n\n${TEXT_RULES}\nThe customer is texting from ${m.address}.` }, m.text, undefined, history,
      { startedBy: m.channel, exec, meta: { channel: m.channel, sessionId, address: m.address } });
    reply = r.output;
  } catch {
    reply = 'Sorry, I can\'t answer right now. Please try again a little later.';
  }
  await pool.query('insert into channel_messages (agent_id, channel, address, role, text) values ($1,$2,$3,$4,$5)', [a.id, m.channel, m.address, 'assistant', reply.slice(0, 4000)]);
  await sendText(a.account_id, { to: m.address, body: reply, channel: m.channel, from: m.to || undefined });
}
