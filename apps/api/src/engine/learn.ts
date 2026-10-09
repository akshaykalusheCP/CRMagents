import { pool } from '../db.js';

// Learning from the admin: corrected or confirmed AI decisions become examples for that workflow block.
// The closest examples are picked in code (word overlap, no AI) and added to the prompt (~200 tokens).

export interface Example { input: string; label: string; source?: string }

const STOP = new Set(['the', 'and', 'for', 'with', 'this', 'that', 'from', 'have', 'has', 'was', 'are', 'not', 'but', 'you', 'our', 'your', 'subject', 'description']);
const words = (t: string) => new Set(t.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !STOP.has(w)));

/** The k examples most similar to `text` (Jaccard word overlap); corrections win ties over confirmations. */
export function rankExamples(text: string, examples: Example[], k = 4): Example[] {
  const q = words(text);
  if (!q.size) return [];
  return examples
    .map((e) => {
      const w = words(e.input);
      let inter = 0;
      for (const x of w) if (q.has(x)) inter++;
      const score = inter / (q.size + w.size - inter || 1) + (e.source === 'correction' ? 0.001 : 0);
      return { e, score };
    })
    .filter((x) => x.score > 0.001)
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map((x) => x.e);
}

export async function addExample(tenantId: string, workflowId: string, nodeId: string, input: string, label: string, source: 'correction' | 'confirmed') {
  // One example per input per block: a newer judgement replaces the older one.
  await pool.query('delete from ai_examples where workflow_id=$1 and node_id=$2 and input=$3', [workflowId, nodeId, input]);
  await pool.query(
    'insert into ai_examples (tenant_id, workflow_id, node_id, input, label, source) values ($1,$2,$3,$4,$5,$6)',
    [tenantId, workflowId, nodeId, input.slice(0, 2000), label, source],
  );
}

/** Example lookup for one workflow, used by the classify block at run time. */
export function examplesFor(workflowId: string) {
  return async (nodeId: string, text: string): Promise<Example[]> => {
    const { rows } = await pool.query(
      'select input, label, source from ai_examples where workflow_id=$1 and node_id=$2 order by created_at desc limit 300',
      [workflowId, nodeId],
    );
    return rankExamples(text, rows);
  };
}

export async function exampleCount(workflowId: string): Promise<number> {
  const { rows } = await pool.query('select count(*)::int as n from ai_examples where workflow_id=$1', [workflowId]);
  return rows[0].n;
}
