import { aiClient } from './provider.js';
import { pool } from '../db.js';
import { SalesforceClient } from '../salesforce/client.js';
import { checkRunRate, spendGuard } from '../spend.js';
import { accountOf } from '../tenants.js';
import { createLlm } from './llm.js';
import { dbResultCache } from './resultCache.js';
import { runTrust } from '../trust/policy.js';
import { hasKnowledge } from '../knowledge/store.js';
import { endRemote, remoteExecutor } from './remote.js';
import { journalFor } from '../trust/undo.js';
import { aiContext } from '../trust/aiLog.js';
import { audit } from '../trust/audit.js';
import { addMemory, addRecordNote, MEMORY_RULES, memoryOn, memoryPrompt } from '../memory/store.js';
import { addMessages, conversationHistory, ensureConversation } from '../memory/conversations.js';

export interface AgentSpec {
  id?: string;
  systemPrompt: string;
  tools: string[];
}

// Standalone single-agent run (the "Single agents" page). Workflows use the engine instead.
export async function runAgent(
  tenantId: string, agent: AgentSpec, userInput: string, context?: unknown, history?: { role: 'user' | 'assistant'; text: string }[],
  opts: {
    onStarted?: (runId: string) => void;
    /** Salesforce tools run inside Salesforce as the person asking. */ inOrg?: boolean;
    startedBy?: string;
    /** Stored with the run (not shown to the AI), e.g. the website conversation it belongs to. */
    meta?: Record<string, unknown>;
    /** Runs some tools itself (website chat self-service); undefined = the normal tool. */
    exec?: (name: string, input: unknown) => Promise<unknown> | undefined;
    /** A person's conversation: saved, and with memory (theirs, the team's, the record's). */
    memory?: { userKey: string; canWriteTeam: boolean; channel: 'app' | 'salesforce'; conversationId?: string | null; recordId?: string | null };
  } = {},
) {
  const accountId = await accountOf(tenantId);
  checkRunRate(accountId);
  const client = await aiClient(accountId, { tenantId });
  const sf = await SalesforceClient.forTenant(tenantId);
  const { masker, limits } = await runTrust(accountId);
  const remote: { exec?: (name: string, input: unknown) => Promise<unknown> | undefined } = {};
  const llm = createLlm('', sf, spendGuard(accountId), client, await dbResultCache(accountId), { masker, limits, exec: (n, i) => remote.exec?.(n, i) });

  // Memory: the saved conversation (its history when the caller has none), what this person and the team asked to
  // be remembered, and the notes agents kept on the record.
  const mem = opts.memory;
  let conversationId: string | null = null;
  const remembered: { kind: 'personal' | 'team' | 'record'; text: string; id?: string; recordId?: string }[] = [];
  let systemPrompt = agent.systemPrompt;
  let tools = agent.tools;
  if (mem && agent.id) {
    conversationId = await ensureConversation({ accountId, tenantId, agentId: agent.id, userKey: mem.userKey, channel: mem.channel, recordId: mem.recordId }, mem.conversationId, userInput);
    if (!history?.length) history = await conversationHistory(conversationId);
    if (await memoryOn(accountId)) {
      const mp = await memoryPrompt(accountId, tenantId, mem.userKey, userInput, mem.recordId);
      systemPrompt = [agent.systemPrompt, MEMORY_RULES, mp.text].filter(Boolean).join('\n\n');
      tools = [...new Set([...agent.tools, 'remember', 'remember_about_record'])];
    }
  }

  const { rows } = await pool.query(
    'insert into runs (tenant_id, agent_id, input, started_by) values ($1,$2,$3,$4) returning id',
    [tenantId, agent.id ?? null, JSON.stringify({ userInput, context, ...(opts.meta ?? {}) }), opts.startedBy ?? null],
  );
  const runId = rows[0].id as string;
  sf.journal = journalFor({ tenantId, runId, agentId: agent.id ?? null });
  if (opts.inOrg) remote.exec = remoteExecutor(runId, sf.journal);
  else if (opts.exec) remote.exec = opts.exec;
  if (mem) {
    const inner = remote.exec;
    const agentName = agent.id ? ((await pool.query('select name from agents where id=$1', [agent.id])).rows[0]?.name ?? 'Assistant') : 'Assistant';
    remote.exec = (name, input) => {
      const i = (input ?? {}) as Record<string, unknown>;
      if (name === 'remember') return (async () => {
        const team = i.scope === 'team' && mem.canWriteTeam;
        const r = await addMemory(accountId, { scope: team ? 'team' : 'personal', owner: mem.userKey, text: String(i.text ?? ''), source: 'assistant', createdBy: mem.userKey });
        if (!r.duplicate) {
          remembered.push({ kind: team ? 'team' : 'personal', text: r.text, id: r.id });
          await audit(accountId, mem.userKey, team ? 'Assistant saved a team memory' : 'Assistant saved a personal memory', { target: r.text, tenantId });
        }
        return i.scope === 'team' && !team ? `Saved for ${mem.userKey} only: team memories are kept by builders and admins.` : r.duplicate ? 'Already remembered.' : 'Remembered.';
      })();
      if (name === 'remember_about_record') return (async () => {
        await addRecordNote(tenantId, String(i.record_id ?? ''), String(i.note ?? ''), agentName, runId);
        remembered.push({ kind: 'record', text: String(i.note ?? '').trim(), recordId: String(i.record_id ?? '') });
        return 'Noted on the record.';
      })();
      return inner?.(name, input);
    };
  }
  opts.onStarted?.(runId);
  try {
    const r = await aiContext.run({ tenantId, runId }, async () => llm.agent({
      system: systemPrompt,
      prompt: context ? `${userInput}\n\nContext:\n${JSON.stringify(context)}` : userInput,
      // Once guides are uploaded, every assistant can look things up in them (read-only, no AI cost).
      tools: !tools.includes('search_knowledge') && (await hasKnowledge(accountId)) ? [...tools, 'search_knowledge'] : tools,
      history,
    }));
    await pool.query(
      `update runs set status='done', output=$2, trace=$3, input_tokens=$4, output_tokens=$5,
         cache_read_tokens=$6, cache_write_tokens=$7, cost_usd=$8 where id=$1`,
      [runId, masker ? masker.unmaskText(r.text) : r.text, JSON.stringify(r.trace), r.usage.input, r.usage.output, r.usage.cacheRead, r.usage.cacheWrite, r.usage.costUsd],
    );
    const output = masker ? masker.unmaskText(r.text) : r.text;
    if (conversationId) await addMessages(conversationId, [{ role: 'user', text: userInput }, { role: 'assistant', text: output, runId }]);
    return { runId, output, conversationId, remembered };
  } catch (e) {
    await pool.query(`update runs set status='error', output=$2 where id=$1`, [runId, e instanceof Error ? e.message : String(e)]);
    throw e;
  } finally {
    endRemote(runId);
  }
}
