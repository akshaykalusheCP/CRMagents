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

// ---- Lessons from approvals ----
// A person's note on an approval ("wrong team: billing questions go to Finance") is kept with what the agent proposed.
// The agent's AI steps see the few closest lessons next time, so it stops repeating a rejected idea.

export interface Lesson { id: string; approved: boolean; proposal: string; note: string; decidedBy: string | null; createdAt: string }

export async function addLesson(tenantId: string, workflowId: string, runId: string, approved: boolean, proposal: string, note: string, decidedBy?: string) {
  const n = note.trim();
  if (!n) return;
  await pool.query(
    'insert into agent_lessons (tenant_id, workflow_id, run_id, approved, proposal, note, decided_by) values ($1,$2,$3,$4,$5,$6,$7)',
    [tenantId, workflowId, runId, approved, proposal.trim().slice(0, 1500) || '(no summary)', n.slice(0, 500), decidedBy ?? null],
  );
}

/** The lessons for an agent as a prompt section, closest to `text` first ('' when there are none). Pure; tested. */
export function lessonPrompt(text: string, lessons: Pick<Lesson, 'approved' | 'proposal' | 'note'>[], k = 4): string {
  const ranked = rankExamples(text, lessons.map((l) => ({ input: l.proposal, label: JSON.stringify(l) })), k).map((e) => JSON.parse(e.label) as Lesson);
  // Nothing close: the latest few still say how this team decides.
  const shown = ranked.length ? ranked : lessons.slice(0, Math.min(2, k));
  if (!shown.length) return '';
  return `How your team decided on this agent's earlier proposals (follow their judgement):\n${shown.map((l) =>
    `- ${l.approved ? 'Approved' : 'Rejected'}: "${l.proposal.replace(/\s+/g, ' ').slice(0, 240)}". Their note: "${l.note.replace(/\s+/g, ' ').slice(0, 300)}"`).join('\n')}`;
}

export function lessonsFor(workflowId: string) {
  return async (text: string): Promise<string> => {
    const { rows } = await pool.query('select approved, proposal, note from agent_lessons where workflow_id=$1 order by created_at desc limit 200', [workflowId]);
    return lessonPrompt(text, rows);
  };
}

export async function listLessons(tenantId: string, workflowId: string): Promise<Lesson[]> {
  const { rows } = await pool.query(
    `select id::text, approved, proposal, note, decided_by as "decidedBy", created_at as "createdAt" from agent_lessons
     where tenant_id=$1 and workflow_id=$2 order by created_at desc limit 100`, [tenantId, workflowId]);
  return rows;
}

export async function deleteLesson(tenantId: string, workflowId: string, id: string) {
  await pool.query('delete from agent_lessons where tenant_id=$1 and workflow_id=$2 and id=$3', [tenantId, workflowId, id]);
}
