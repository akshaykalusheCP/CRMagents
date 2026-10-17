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
  } = {},
) {
  const accountId = await accountOf(tenantId);
  checkRunRate(accountId);
  const client = await aiClient(accountId, { tenantId });
  const sf = await SalesforceClient.forTenant(tenantId);
  const { masker, limits } = await runTrust(accountId);
  const remote: { exec?: (name: string, input: unknown) => Promise<unknown> | undefined } = {};
  const llm = createLlm('', sf, spendGuard(accountId), client, await dbResultCache(accountId), { masker, limits, exec: (n, i) => remote.exec?.(n, i) });

  const { rows } = await pool.query(
    'insert into runs (tenant_id, agent_id, input, started_by) values ($1,$2,$3,$4) returning id',
    [tenantId, agent.id ?? null, JSON.stringify({ userInput, context, ...(opts.meta ?? {}) }), opts.startedBy ?? null],
  );
  const runId = rows[0].id as string;
  sf.journal = journalFor({ tenantId, runId, agentId: agent.id ?? null });
  if (opts.inOrg) remote.exec = remoteExecutor(runId, sf.journal);
  else if (opts.exec) remote.exec = opts.exec;
  opts.onStarted?.(runId);
  try {
    const r = await aiContext.run({ tenantId, runId }, async () => llm.agent({
      system: agent.systemPrompt,
      prompt: context ? `${userInput}\n\nContext:\n${JSON.stringify(context)}` : userInput,
      // Once guides are uploaded, every assistant can look things up in them (read-only, no AI cost).
      tools: !agent.tools.includes('search_knowledge') && (await hasKnowledge(accountId)) ? [...agent.tools, 'search_knowledge'] : agent.tools,
      history,
    }));
    await pool.query(
      `update runs set status='done', output=$2, trace=$3, input_tokens=$4, output_tokens=$5,
         cache_read_tokens=$6, cache_write_tokens=$7, cost_usd=$8 where id=$1`,
      [runId, masker ? masker.unmaskText(r.text) : r.text, JSON.stringify(r.trace), r.usage.input, r.usage.output, r.usage.cacheRead, r.usage.cacheWrite, r.usage.costUsd],
    );
    return { runId, output: masker ? masker.unmaskText(r.text) : r.text };
  } catch (e) {
    await pool.query(`update runs set status='error', output=$2 where id=$1`, [runId, e instanceof Error ? e.message : String(e)]);
    throw e;
  } finally {
    endRemote(runId);
  }
}
