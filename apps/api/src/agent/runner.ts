import { pool } from '../db.js';
import { SalesforceClient } from '../salesforce/client.js';
import { getSetting } from '../settings.js';
import { checkRunRate, spendGuard } from '../spend.js';
import { accountOf } from '../tenants.js';
import { anthropicClient, createLlm } from './llm.js';
import { dbResultCache } from './resultCache.js';
import { runTrust } from '../trust/policy.js';
import { hasKnowledge } from '../knowledge/store.js';

export interface AgentSpec {
  id?: string;
  systemPrompt: string;
  tools: string[];
}

// Standalone single-agent run (the "Single agents" page). Workflows use the engine instead.
export async function runAgent(tenantId: string, agent: AgentSpec, userInput: string, context?: unknown, history?: { role: 'user' | 'assistant'; text: string }[], opts: { onStarted?: (runId: string) => void } = {}) {
  const accountId = await accountOf(tenantId);
  checkRunRate(accountId);
  const apiKey = await getSetting(accountId, 'anthropicKey');
  if (!apiKey) throw new Error('Anthropic API key is not configured. Add it in Settings.');
  const sf = await SalesforceClient.forTenant(tenantId);
  const workspaceId = await getSetting(accountId, 'anthropicWorkspaceId');
  const { masker, limits } = await runTrust(accountId);
  const llm = createLlm(apiKey, sf, spendGuard(accountId), anthropicClient(apiKey, workspaceId), await dbResultCache(accountId), { masker, limits });

  const { rows } = await pool.query(
    'insert into runs (tenant_id, agent_id, input) values ($1,$2,$3) returning id',
    [tenantId, agent.id ?? null, JSON.stringify({ userInput, context })],
  );
  const runId = rows[0].id as string;
  opts.onStarted?.(runId);
  try {
    const r = await llm.agent({
      system: agent.systemPrompt,
      prompt: context ? `${userInput}\n\nContext:\n${JSON.stringify(context)}` : userInput,
      // Once guides are uploaded, every assistant can look things up in them (read-only, no AI cost).
      tools: !agent.tools.includes('search_knowledge') && (await hasKnowledge(accountId)) ? [...agent.tools, 'search_knowledge'] : agent.tools,
      history,
    });
    await pool.query(
      `update runs set status='done', output=$2, trace=$3, input_tokens=$4, output_tokens=$5,
         cache_read_tokens=$6, cache_write_tokens=$7, cost_usd=$8 where id=$1`,
      [runId, masker ? masker.unmaskText(r.text) : r.text, JSON.stringify(r.trace), r.usage.input, r.usage.output, r.usage.cacheRead, r.usage.cacheWrite, r.usage.costUsd],
    );
    return { runId, output: masker ? masker.unmaskText(r.text) : r.text };
  } catch (e) {
    await pool.query(`update runs set status='error', output=$2 where id=$1`, [runId, e instanceof Error ? e.message : String(e)]);
    throw e;
  }
}
