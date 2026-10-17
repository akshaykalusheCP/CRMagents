import { pool } from '../db.js';
import { getSetting } from '../settings.js';
import { Masker } from '../trust/mask.js';

// Memory: what assistants and agents carry from one conversation or run to the next.
// - Personal memories: about one person ("I own the enterprise accounts", "keep answers short").
// - Team memories: how the business works ("a hot deal is over $100k closing this quarter").
// - Record notes: short facts agents keep on a Salesforce record ("customer prefers email").
// Never customers' personal data: anything that looks like an email, phone, card or ID number is refused.
// Everything is visible and deletable on the Memory page, and memory can be switched off per workspace.

export const MAX_MEMORY = 300;
export const MAX_NOTE = 400;
const MAX_IN_PROMPT = 15;

export async function memoryOn(accountId: string) {
  return (await getSetting(accountId, 'memoryEnabled')) !== 'off';
}

/** Why a memory can't be saved (personal data, too long, empty), or null. Pure; tested. */
export function refuseMemory(text: string, max = MAX_MEMORY): string | null {
  const t = text.trim();
  if (!t) return 'Nothing to remember.';
  if (t.length > max) return `Keep it under ${max} characters: one fact or preference.`;
  const m = new Masker();
  if (m.maskText(t) !== t) return 'Memories can\'t hold personal data such as emails, phone numbers, card or ID numbers. Save the preference without them.';
  return null;
}

const STOP = new Set(['the', 'and', 'for', 'with', 'this', 'that', 'from', 'have', 'has', 'was', 'are', 'not', 'but', 'you', 'our', 'your', 'what', 'how', 'who', 'when', 'show', 'give', 'tell', 'can', 'all', 'any', 'about', 'please']);
const words = (t: string) => new Set(t.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !STOP.has(w)));

/** The memories worth adding to this question: all of them when there are few, else the closest. Pure; tested. */
export function pickMemories<T extends { text: string }>(question: string, all: T[], max = MAX_IN_PROMPT): T[] {
  if (all.length <= max) return all;
  const q = words(question);
  return all.map((m, i) => {
    const w = words(m.text);
    let inter = 0;
    for (const x of w) if (q.has(x)) inter++;
    return { m, score: inter / (w.size || 1) - i * 1e-6 };
  }).sort((a, b) => b.score - a.score).slice(0, max).map((x) => x.m);
}

export interface MemoryRow { id: string; scope: 'personal' | 'team'; owner: string | null; text: string; source: string; createdBy: string | null; uses: number; lastUsedAt: string | null; createdAt: string }

export async function listMemories(accountId: string, userKey: string): Promise<MemoryRow[]> {
  const { rows } = await pool.query(
    `select id, scope, owner, text, source, created_by as "createdBy", uses, last_used_at as "lastUsedAt", created_at as "createdAt"
     from memories where account_id=$1 and (scope='team' or owner=$2) order by scope, created_at desc limit 500`, [accountId, userKey.toLowerCase()]);
  return rows;
}

export async function addMemory(accountId: string, m: { scope: 'personal' | 'team'; owner?: string; text: string; source: 'user' | 'assistant'; createdBy: string }) {
  const why = refuseMemory(m.text);
  if (why) throw Object.assign(new Error(why), { statusCode: 400 });
  const text = m.text.trim();
  // The same fact twice is one memory.
  const { rows: dup } = await pool.query('select id from memories where account_id=$1 and scope=$2 and coalesce(owner,\'\')=coalesce($3,\'\') and lower(text)=lower($4)', [accountId, m.scope, m.owner?.toLowerCase() ?? null, text]);
  if (dup[0]) return { id: dup[0].id as string, text, duplicate: true };
  const { rows: n } = await pool.query('select count(*)::int n from memories where account_id=$1 and (scope=\'team\' or owner=$2)', [accountId, m.owner?.toLowerCase() ?? '']);
  if (n[0].n >= 500) throw Object.assign(new Error('Memory is full (500). Remove old ones on the Memory page.'), { statusCode: 400 });
  const { rows } = await pool.query(
    'insert into memories (account_id, scope, owner, text, source, created_by) values ($1,$2,$3,$4,$5,$6) returning id',
    [accountId, m.scope, m.scope === 'personal' ? m.owner?.toLowerCase() ?? null : null, text, m.source, m.createdBy.toLowerCase()]);
  return { id: rows[0].id as string, text, duplicate: false };
}

export async function updateMemory(accountId: string, id: string, userKey: string, text: string, canTeam: boolean) {
  const why = refuseMemory(text);
  if (why) throw Object.assign(new Error(why), { statusCode: 400 });
  const r = await pool.query(
    `update memories set text=$4, updated_at=now() where id=$1 and account_id=$2 and ((scope='personal' and owner=$3) or (scope='team' and $5))`,
    [id, accountId, userKey.toLowerCase(), text.trim(), canTeam]);
  if (!r.rowCount) throw Object.assign(new Error('Not found, or not yours to change'), { statusCode: 404 });
}

export async function deleteMemory(accountId: string, id: string, userKey: string, canTeam: boolean) {
  const r = await pool.query(
    `delete from memories where id=$1 and account_id=$2 and ((scope='personal' and owner=$3) or (scope='team' and $4))`,
    [id, accountId, userKey.toLowerCase(), canTeam]);
  if (!r.rowCount) throw Object.assign(new Error('Not found, or not yours to remove'), { statusCode: 404 });
}

// ---- Record notes ----
export async function addRecordNote(tenantId: string, recordId: string, note: string, author: string, runId?: string | null) {
  const why = refuseMemory(note, MAX_NOTE);
  if (why) throw new Error(why);
  if (!/^[a-zA-Z0-9]{15,18}$/.test(recordId)) throw new Error('Give the record Id (15 or 18 characters).');
  const { rows: dup } = await pool.query('select 1 from record_notes where tenant_id=$1 and left(record_id,15)=left($2,15) and lower(note)=lower($3)', [tenantId, recordId, note.trim()]);
  if (dup.length) return;
  await pool.query('insert into record_notes (tenant_id, record_id, note, author, run_id) values ($1,$2,$3,$4,$5)', [tenantId, recordId, note.trim(), author, runId ?? null]);
}

export async function recordNotes(tenantId: string, recordId: string, limit = 10) {
  const { rows } = await pool.query(
    'select id, record_id as "recordId", note, author, created_at as "createdAt" from record_notes where tenant_id=$1 and left(record_id,15)=left($2,15) order by created_at desc limit $3',
    [tenantId, recordId, limit]);
  return rows as { id: number; recordId: string; note: string; author: string | null; createdAt: string }[];
}

export async function listRecordNotes(accountId: string, limit = 200) {
  const { rows } = await pool.query(
    `select n.id, n.tenant_id as "tenantId", n.record_id as "recordId", n.note, n.author, n.created_at as "createdAt"
     from record_notes n join tenants t on t.id = n.tenant_id where t.account_id=$1 order by n.created_at desc limit $2`, [accountId, limit]);
  return rows;
}

export async function deleteRecordNote(accountId: string, id: number) {
  await pool.query('delete from record_notes n using tenants t where n.id=$1 and t.id = n.tenant_id and t.account_id=$2', [id, accountId]);
}

/** What an assistant is told it remembers, for one question. Marks the memories used. */
export async function memoryPrompt(accountId: string, tenantId: string, userKey: string, question: string, recordId?: string | null) {
  if (!(await memoryOn(accountId))) return { text: '', ids: [] as string[] };
  const all = await listMemories(accountId, userKey);
  const team = pickMemories(question, all.filter((m) => m.scope === 'team'));
  const mine = pickMemories(question, all.filter((m) => m.scope === 'personal'));
  const notes = recordId ? await recordNotes(tenantId, recordId) : [];
  const ids = [...team, ...mine].map((m) => m.id);
  if (ids.length) await pool.query('update memories set uses=uses+1, last_used_at=now() where id = any($1)', [ids]);
  const parts: string[] = [];
  if (team.length) parts.push(`How this team works (team memory):\n${team.map((m) => `- ${m.text}`).join('\n')}`);
  if (mine.length) parts.push(`About the person asking (their memory):\n${mine.map((m) => `- ${m.text}`).join('\n')}`);
  if (notes.length) parts.push(`Notes agents kept on this record:\n${notes.map((n) => `- ${n.note} (${n.author ?? 'agent'}, ${new Date(n.createdAt).toISOString().slice(0, 10)})`).join('\n')}`);
  return { text: parts.join('\n\n'), ids };
}

export const MEMORY_RULES = `MEMORY
- Use what you remember below when it helps; don't repeat it back unless asked.
- When the person states a lasting preference or fact about themselves or how the team works ("I manage the West region", "always show amounts in EUR", "remember that..."), call remember. Use scope "team" only for business definitions that apply to everyone; otherwise "personal".
- When you learn a lasting fact about a Salesforce record that will matter next time (for example "customer prefers email", "already asked for the invoice"), call remember_about_record.
- Never store customers' personal data (emails, phone numbers, addresses, card or ID numbers) in memory.`;
