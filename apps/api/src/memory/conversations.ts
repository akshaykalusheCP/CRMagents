import { pool } from '../db.js';

// Saved conversations: each chat with an assistant, per person, so it can be picked up again (in the app or on the
// same record in Salesforce). Kept as long as the workspace's retention setting says.

export interface ConvRef { accountId: string; tenantId: string; agentId: string | null; userKey: string; channel: 'app' | 'salesforce'; recordId?: string | null }

/** The conversation to add to: the given one if it's this person's, else a new one titled by the question. */
export async function ensureConversation(ref: ConvRef, conversationId: string | null | undefined, question: string): Promise<string> {
  if (conversationId) {
    const { rows } = await pool.query('select id from conversations where id=$1 and tenant_id=$2 and user_key=$3', [conversationId, ref.tenantId, ref.userKey.toLowerCase()]);
    if (rows[0]) return rows[0].id;
  }
  const title = question.replace(/\s+/g, ' ').trim().slice(0, 80);
  const { rows } = await pool.query(
    'insert into conversations (account_id, tenant_id, agent_id, user_key, channel, record_id, title) values ($1,$2,$3,$4,$5,$6,$7) returning id',
    [ref.accountId, ref.tenantId, ref.agentId, ref.userKey.toLowerCase(), ref.channel, ref.recordId ?? null, title]);
  return rows[0].id;
}

export async function addMessages(conversationId: string, msgs: { role: 'user' | 'assistant'; text: string; runId?: string | null }[]) {
  for (const m of msgs) await pool.query('insert into conversation_messages (conversation_id, role, text, run_id) values ($1,$2,$3,$4)', [conversationId, m.role, m.text.slice(0, 20_000), m.runId ?? null]);
  await pool.query('update conversations set updated_at=now() where id=$1', [conversationId]);
}

/** The last turns of a conversation, oldest first (what the assistant is given as history). */
export async function conversationHistory(conversationId: string, limit = 20) {
  const { rows } = await pool.query('select role, text from (select id, role, text from conversation_messages where conversation_id=$1 order by id desc limit $2) x order by id', [conversationId, limit]);
  return rows as { role: 'user' | 'assistant'; text: string }[];
}

export async function listConversations(tenantId: string, userKey: string, o: { agentId?: string; recordId?: string; noRecord?: boolean; limit?: number } = {}) {
  const { rows } = await pool.query(
    `select c.id, c.title, c.channel, c.record_id as "recordId", c.agent_id as "agentId", a.name as "agentName", c.updated_at as "updatedAt",
            (select count(*)::int from conversation_messages m where m.conversation_id = c.id) as messages
     from conversations c left join agents a on a.id = c.agent_id
     where c.tenant_id=$1 and c.user_key=$2 and ($3::uuid is null or c.agent_id=$3) and ($4::text is null or left(c.record_id,15)=left($4,15)) and (not $6::boolean or c.record_id is null)
     order by c.updated_at desc limit $5`,
    [tenantId, userKey.toLowerCase(), o.agentId ?? null, o.recordId ?? null, Math.min(o.limit ?? 30, 100), !!o.noRecord]);
  return rows.filter((r) => r.messages > 0);
}

export async function getConversation(tenantId: string, userKey: string, id: string) {
  const { rows } = await pool.query('select id, title, channel, record_id as "recordId", agent_id as "agentId", updated_at as "updatedAt" from conversations where id=$1 and tenant_id=$2 and user_key=$3', [id, tenantId, userKey.toLowerCase()]);
  if (!rows[0]) throw Object.assign(new Error('Conversation not found'), { statusCode: 404 });
  const { rows: msgs } = await pool.query('select role, text, created_at as "createdAt" from conversation_messages where conversation_id=$1 order by id', [id]);
  return { ...rows[0], messages: msgs };
}

export async function deleteConversation(tenantId: string, userKey: string, id: string) {
  await pool.query('delete from conversations where id=$1 and tenant_id=$2 and user_key=$3', [id, tenantId, userKey.toLowerCase()]);
}
