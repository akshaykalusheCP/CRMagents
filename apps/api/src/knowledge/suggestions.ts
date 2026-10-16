import { pool } from '../db.js';

// Suggestions an agent saved against a Salesforce record. They are advice, not changes: nothing in
// Salesforce is touched until a person uses them, so saving one never needs an approval.

export interface Suggestion {
  id: string;
  recordId: string;
  objectName: string;
  title: string;
  body: string;
  sources: { title: string; section: string }[];
  status: 'new' | 'helpful' | 'not_helpful' | 'dismissed';
  agentName: string | null;
  decidedBy: string | null;
  createdAt: string;
}

export async function saveSuggestion(tenantId: string, s: { recordId: string; objectName?: string; title?: string; body: string; sources?: unknown[]; workflowId?: string; runId?: string }) {
  const { rows } = await pool.query(
    `insert into suggestions (tenant_id, record_id, object_name, title, body, sources, workflow_id, run_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
    [tenantId, s.recordId, s.objectName ?? '', (s.title ?? '').slice(0, 200), s.body.slice(0, 20_000), JSON.stringify(s.sources ?? []), s.workflowId ?? null, s.runId ?? null],
  );
  return rows[0].id as string;
}

/** Latest suggestions for one record (dismissed ones are hidden). */
export async function recordSuggestions(tenantId: string, recordId: string, limit = 5): Promise<Suggestion[]> {
  // Salesforce shows 18-character Ids in some places and 15 in others: match both.
  const short = recordId.slice(0, 15);
  const { rows } = await pool.query(
    `select s.id, s.record_id as "recordId", s.object_name as "objectName", s.title, s.body, s.sources, s.status,
            w.name as "agentName", s.decided_by as "decidedBy", s.created_at as "createdAt"
     from suggestions s left join workflows w on w.id = s.workflow_id
     where s.tenant_id=$1 and left(s.record_id, 15)=$2 and s.status <> 'dismissed'
     order by s.created_at desc limit $3`,
    [tenantId, short, limit],
  );
  return rows;
}

export async function listSuggestions(tenantId: string, limit = 50): Promise<Suggestion[]> {
  const { rows } = await pool.query(
    `select s.id, s.record_id as "recordId", s.object_name as "objectName", s.title, s.body, s.sources, s.status,
            w.name as "agentName", s.decided_by as "decidedBy", s.created_at as "createdAt"
     from suggestions s left join workflows w on w.id = s.workflow_id
     where s.tenant_id=$1 order by s.created_at desc limit $2`,
    [tenantId, limit],
  );
  return rows;
}

export async function markSuggestion(tenantId: string, id: string, status: 'helpful' | 'not_helpful' | 'dismissed', who?: string) {
  const r = await pool.query(
    'update suggestions set status=$3, decided_by=$4, decided_at=now() where id=$2 and tenant_id=$1',
    [tenantId, id, status, who?.toLowerCase() ?? null],
  );
  if (!r.rowCount) throw Object.assign(new Error('Suggestion not found'), { statusCode: 404 });
}
