import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';
import { pool } from '../db.js';
import { parseActionKey } from '../salesforce/actions.js';
import type { SalesforceClient } from '../salesforce/client.js';

// Customer self-service for website chat. A visitor proves their email with a one-time code sent from the org;
// after that the assistant can show *their* records, update the details the admin allowed and run the actions
// the admin allowed (for example a "start a return" Flow), and hand the conversation to a person.
// Identity lives on the server (public_sessions), never in what the AI says: every tool reads it from there.

const CODE_TTL_MS = 10 * 60_000;
const MAX_ATTEMPTS = 5;
const MAX_CODES_PER_SESSION = 3;
const MAX_CODES_PER_EMAIL_HOUR = 5;
const NAME = /^[A-Za-z][A-Za-z0-9_]*$/;
const EMAIL = /^[^@\s'"\\]+@[^@\s'"\\]+\.[^@\s'"\\]+$/;

export interface RecordSpec {
  object: string;
  label: string;
  /** How a record belongs to the visitor: their Contact, their Account, or an email field on the record. */
  match: 'contact' | 'account' | 'email';
  emailField?: string;
  fields: string[];
}
export interface SelfServiceConfig {
  verify: boolean;
  records: RecordSpec[];
  actions: { key: string; label: string; description?: string }[];
  /** Contact fields visitors may change themselves. */
  updatable: string[];
  handoff: boolean;
}

export const DEFAULT_CONFIG: SelfServiceConfig = {
  verify: false,
  records: [{ object: 'Case', label: 'Your cases', match: 'contact', fields: ['CaseNumber', 'Subject', 'Status', 'Priority', 'LastModifiedDate'] }],
  actions: [],
  updatable: [],
  handoff: true,
};

/** Only well-formed names get through; anything odd is dropped. Pure; tested. */
export function normalizeConfig(raw: unknown): SelfServiceConfig {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<SelfServiceConfig>;
  const records = (Array.isArray(r.records) ? r.records : DEFAULT_CONFIG.records).flatMap((x) => {
    if (!x || !NAME.test(String(x.object)) || !['contact', 'account', 'email'].includes(x.match)) return [];
    const fields = (Array.isArray(x.fields) ? x.fields : []).map(String).filter((f) => NAME.test(f)).slice(0, 15);
    if (x.match === 'email' && !NAME.test(String(x.emailField ?? ''))) return [];
    return [{ object: x.object, label: String(x.label || x.object).slice(0, 60), match: x.match, ...(x.match === 'email' ? { emailField: x.emailField } : {}), fields: fields.length ? fields : ['Name'] }];
  }).slice(0, 8);
  const actions = (Array.isArray(r.actions) ? r.actions : []).flatMap((a) => (a && parseActionKey(String(a.key)) ? [{ key: String(a.key), label: String(a.label || a.key).slice(0, 60), description: a.description ? String(a.description).slice(0, 200) : undefined }] : [])).slice(0, 10);
  const updatable = (Array.isArray(r.updatable) ? r.updatable : []).map(String).filter((f) => NAME.test(f)).slice(0, 15);
  return { verify: !!r.verify, records, actions, updatable, handoff: r.handoff !== false };
}

/** The tools a website assistant gets with this configuration. Pure; tested. */
export function selfServiceTools(c: SelfServiceConfig): string[] {
  const t: string[] = [];
  if (c.verify) {
    t.push('send_code', 'verify_code');
    if (c.records.length) t.push('my_records');
    if (c.updatable.length) t.push('update_my_details');
    if (c.actions.length) t.push('run_customer_action');
  }
  if (c.handoff) t.push('talk_to_person');
  return t;
}

/** What the assistant is told it can do for visitors. Pure; tested. */
export function selfServicePrompt(c: SelfServiceConfig): string {
  if (!c.verify && !c.handoff) return '';
  const lines: string[] = [];
  if (c.verify) {
    lines.push('Visitors can see their own information after proving their email: ask for it, call send_code, then ask for the 6-digit code from their inbox and call verify_code. Never show or change anything about a visitor before verify_code succeeds, and never take an email or name the visitor types as proof.');
    if (c.records.length) lines.push(`After verifying, my_records can show: ${c.records.map((r) => `"${r.label}"`).join(', ')}.`);
    if (c.updatable.length) lines.push(`update_my_details can change these details of theirs: ${c.updatable.join(', ')}. Confirm the new values before changing them.`);
    if (c.actions.length) lines.push(`run_customer_action can do these for them (confirm first): ${c.actions.map((a) => `${a.key} = ${a.label}${a.description ? ` (${a.description})` : ''}`).join('; ')}.`);
  }
  if (c.handoff) lines.push('If they ask for a person, or you can\'t help, call talk_to_person with a one-line summary: a person from the team will reply by email.');
  return lines.join('\n');
}

const hash = (sessionId: string, code: string) => createHash('sha256').update(`${config.tokenEncKey.toString('hex')}|${sessionId}|${code}`).digest('hex');
const maskEmail = (e: string) => e.replace(/^(.)[^@]*(@.*)$/, '$1•••$2');

interface Session {
  id: string; agent_id: string; email: string | null; code_hash: string | null; code_sent_at: Date | null; codes_sent: number;
  attempts: number; verified_at: Date | null; contact_id: string | null; account_id: string | null; name: string | null;
}

async function sessionFor(id: string, agentId: string): Promise<Session> {
  await pool.query('insert into public_sessions (id, agent_id) values ($1,$2) on conflict (id) do nothing', [id, agentId]);
  const { rows } = await pool.query('select * from public_sessions where id=$1', [id]);
  if (!rows[0] || rows[0].agent_id !== agentId) throw new Error('Please reload the page and try again.');
  return rows[0];
}

export interface SelfServiceContext {
  agentId: string;
  sessionId: string | null;
  config: SelfServiceConfig;
  sf: () => Promise<SalesforceClient>;
  /** The conversation so far, for a hand-off to a person. */
  transcript: string;
  companyName: string;
}

/** Runs the self-service tools for one website conversation; other tools are left to the normal runner. */
export function selfServiceExec(ctx: SelfServiceContext) {
  const need = () => {
    if (!ctx.sessionId) throw new Error('Please reload the page and try again.');
    return sessionFor(ctx.sessionId, ctx.agentId);
  };
  const verified = async () => {
    const s = await need();
    if (!s.verified_at) throw new Error('The visitor has not verified their email yet. Ask for their email and use send_code first.');
    return s;
  };
  const tools: Record<string, (input: any) => Promise<unknown>> = {
    async send_code({ email }) {
      const e = String(email ?? '').trim().toLowerCase();
      if (!EMAIL.test(e)) throw new Error('Ask for a valid email address.');
      const s = await need();
      if (s.codes_sent >= MAX_CODES_PER_SESSION) throw new Error('Too many codes sent in this chat. Ask the visitor to try again later.');
      const { rows } = await pool.query("select count(*)::int n from public_sessions where lower(email)=$1 and code_sent_at > now() - interval '1 hour'", [e]);
      if (rows[0].n >= MAX_CODES_PER_EMAIL_HOUR) throw new Error('Too many codes were sent to this email recently. Ask them to try again in an hour.');
      const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
      // A new email always starts unverified.
      await pool.query(
        `update public_sessions set email=$2, code_hash=$3, code_sent_at=now(), codes_sent=codes_sent+1, attempts=0,
           verified_at=null, contact_id=null, account_id=null, name=null where id=$1`, [s.id, e, hash(s.id, code)]);
      const sf = await ctx.sf();
      await sf.runAction('standard', 'emailSimple', {
        emailAddresses: e,
        emailSubject: `Your ${ctx.companyName} verification code: ${code}`,
        emailBody: `Your verification code is ${code}.\n\nIt expires in 10 minutes. If you didn't ask for it, you can ignore this email.`,
      }).catch(() => { throw new Error('The code could not be sent right now. Offer to have a person reply by email instead.'); });
      return `Code sent to ${maskEmail(e)}. Ask the visitor for the 6-digit code.`;
    },

    async verify_code({ code }) {
      const s = await need();
      if (!s.code_hash || !s.code_sent_at) throw new Error('No code was sent yet. Use send_code first.');
      if (s.attempts >= MAX_ATTEMPTS) throw new Error('Too many wrong codes. Ask the visitor to request a new code.');
      if (Date.now() - new Date(s.code_sent_at).getTime() > CODE_TTL_MS) throw new Error('The code has expired. Offer to send a new one.');
      const given = hash(s.id, String(code ?? '').replace(/\D/g, ''));
      if (!timingSafeEqual(Buffer.from(given), Buffer.from(s.code_hash))) {
        await pool.query('update public_sessions set attempts=attempts+1 where id=$1', [s.id]);
        throw new Error('That code is not right. Ask them to check it.');
      }
      const sf = await ctx.sf();
      const c = await sf.query(`SELECT Id, AccountId, FirstName FROM Contact WHERE Email = '${s.email}' ORDER BY LastModifiedDate DESC LIMIT 1`);
      const contact = c.records[0] as { Id: string; AccountId?: string; FirstName?: string } | undefined;
      await pool.query('update public_sessions set verified_at=now(), code_hash=null, contact_id=$2, account_id=$3, name=$4 where id=$1',
        [s.id, contact?.Id ?? null, contact?.AccountId ?? null, contact?.FirstName ?? null]);
      return contact ? `Verified. The visitor is ${contact.FirstName ?? 'a known customer'}.` : 'Verified, but there is no customer record with this email, so only things linked to the email itself can be shown.';
    },

    async my_records({ kind }) {
      const s = await verified();
      const want = String(kind ?? '').toLowerCase();
      const spec = ctx.config.records.find((r) => r.label.toLowerCase() === want || r.object.toLowerCase() === want) ?? (ctx.config.records.length === 1 ? ctx.config.records[0] : undefined);
      if (!spec) throw new Error(`Say which: ${ctx.config.records.map((r) => r.label).join(', ')}`);
      const where = spec.match === 'contact' ? (s.contact_id ? `ContactId = '${s.contact_id}'` : null)
        : spec.match === 'account' ? (s.account_id ? `AccountId = '${s.account_id}'` : null)
        : `${spec.emailField} = '${s.email}'`;
      if (!where) return `No ${spec.label.toLowerCase()} found: there is no customer record for this email.`;
      const sf = await ctx.sf();
      const r = await sf.query(`SELECT ${[...new Set(['Id', ...spec.fields])].join(', ')} FROM ${spec.object} WHERE ${where} ORDER BY LastModifiedDate DESC LIMIT 20`);
      if (!r.records.length) return `No ${spec.label.toLowerCase()} found.`;
      return { [spec.label]: r.records.map(({ Id: _id, ...rest }: Record<string, unknown>) => rest) };
    },

    async update_my_details({ fields }) {
      const s = await verified();
      if (!s.contact_id) throw new Error('There is no customer record for this email to update.');
      const values = Object.fromEntries(Object.entries((fields ?? {}) as Record<string, unknown>).filter(([k]) => ctx.config.updatable.includes(k)));
      const refused = Object.keys(fields ?? {}).filter((k) => !ctx.config.updatable.includes(k));
      if (!Object.keys(values).length) throw new Error(`Only these can be changed here: ${ctx.config.updatable.join(', ')}`);
      await (await ctx.sf()).updateRecord('Contact', s.contact_id, values);
      return `Updated ${Object.keys(values).join(', ')}.${refused.length ? ` Not changed (not allowed here): ${refused.join(', ')}.` : ''}`;
    },

    async run_customer_action({ action, inputs }) {
      const s = await verified();
      const allowed = ctx.config.actions.find((a) => a.key === action);
      const key = allowed && parseActionKey(allowed.key);
      if (!key) throw new Error(`That isn't available. Available: ${ctx.config.actions.map((a) => a.label).join(', ')}`);
      // Who the visitor is comes from the verified session, never from the conversation.
      const merged = { ...(inputs ?? {}), contactId: s.contact_id, accountId: s.account_id, customerEmail: s.email };
      const out = await (await ctx.sf()).runAction(key.kind, key.name, merged);
      return { done: allowed!.label, ...out };
    },

    async talk_to_person({ summary, email }) {
      const s = ctx.sessionId ? await need() : null;
      const contactEmail = s?.verified_at ? s.email : (EMAIL.test(String(email ?? '')) ? String(email).toLowerCase() : null);
      if (!contactEmail) throw new Error('Ask for their email so the team can reply.');
      const sf = await ctx.sf();
      const r = await sf.createRecord('Case', {
        Subject: `Website chat: ${String(summary ?? 'Visitor asked for a person').slice(0, 200)}`,
        Description: `${s?.verified_at ? 'Email verified in chat.' : 'Email NOT verified.'}\n\n${ctx.transcript}`.slice(0, 32_000),
        Origin: 'Web', SuppliedEmail: contactEmail,
        ...(s?.verified_at && s.contact_id ? { ContactId: s.contact_id } : {}),
      });
      const c = await sf.getRecord('Case', r.id, ['CaseNumber']);
      return `A person will reply to ${maskEmail(contactEmail)} by email. Case number ${(c as { CaseNumber?: string }).CaseNumber}.`;
    },
  };
  return (name: string, input: unknown): Promise<unknown> | undefined => tools[name]?.(input ?? {});
}
