import { pool } from '../db.js';
import type { Change, Journal, SalesforceClient } from '../salesforce/client.js';

// Undo: put back what an agent changed. Every create, update and delete it made through CRMagents was logged with
// the values it replaced (salesforce/client.ts). Undoing goes newest first:
// - an update gets its old values back, but only for fields that still hold the agent's value: if a person
//   changed a field since, their change wins and the field is listed as skipped;
// - a created record is deleted (to the Recycle Bin), unless someone else edited it since;
// - a deleted record comes back from the Recycle Bin (kept 15 days).
// Emails, text messages, Slack posts and Flow/Apex actions can't be called back; they are listed as such.

export function journalFor(o: { tenantId: string; runId: string; workflowId?: string | null; agentId?: string | null }): Journal {
  return async (changes: Change[]) => {
    if (!changes.length) return;
    const v: unknown[] = [];
    const rows = changes.map((c, i) => {
      v.push(o.tenantId, o.runId, o.workflowId ?? null, o.agentId ?? null, c.op, c.object, c.recordId, c.before ? JSON.stringify(c.before) : null, c.after ? JSON.stringify(c.after) : null, c.undoable);
      const b = i * 10;
      return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9},$${b + 10})`;
    });
    await pool.query(`insert into run_changes (tenant_id, run_id, workflow_id, agent_id, op, object, record_id, before, after, undoable) values ${rows.join(',')}`, v);
  };
}

const DATEISH = /^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/;
const same = (a: unknown, b: unknown) => {
  const n = (x: unknown) => (x === undefined || x === '' ? null : typeof x === 'number' || typeof x === 'boolean' ? String(x) : x);
  if (JSON.stringify(n(a)) === JSON.stringify(n(b))) return true;
  // Salesforce writes dates back in its own format: 2026-10-20T10:00:00.000+0000 is 2026-10-20T10:00:00Z.
  if (typeof a === 'string' && typeof b === 'string' && DATEISH.test(a) && DATEISH.test(b)) {
    const t = (s: string) => Date.parse(s.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
    return t(a) === t(b);
  }
  return false;
};

/** For an update: which fields to put back, and which a person changed since. Pure; tested. */
export function restorePlan(before: Record<string, unknown>, after: Record<string, unknown>, now: Record<string, unknown>) {
  const restore: Record<string, unknown> = {};
  const skipped: string[] = [];
  for (const [f, old] of Object.entries(before)) {
    if (!(f in after)) continue;
    if (same(now[f], old)) continue; // already back
    if (same(now[f], after[f]) || (typeof after[f] === 'string' && typeof now[f] === 'string' && (now[f] as string).startsWith(after[f] as string))) restore[f] = old;
    else skipped.push(f);
  }
  return { restore, skipped };
}

export interface ChangeRow {
  id: number; run_id: string; op: 'create' | 'update' | 'delete'; object: string; record_id: string;
  before: Record<string, unknown> | null; after: Record<string, unknown> | null; undoable: boolean; undone_at: Date | null; created_at: Date;
}

export async function listChanges(tenantId: string, where: { runId?: string; workflowId?: string; since?: Date }) {
  const { rows } = await pool.query(
    `select c.id, c.run_id, c.op, c.object, c.record_id, c.before, c.after, c.undoable, c.undone_at, c.undone_by, c.undo_result, c.created_at,
            coalesce(w.name, a.name) as agent_name
     from run_changes c left join workflows w on w.id = c.workflow_id left join agents a on a.id = c.agent_id
     where c.tenant_id=$1 and ($2::uuid is null or c.run_id=$2) and ($3::uuid is null or c.workflow_id=$3) and ($4::timestamptz is null or c.created_at >= $4)
     order by c.created_at desc, c.id desc limit 2000`, [tenantId, where.runId ?? null, where.workflowId ?? null, where.since ?? null]);
  return rows;
}

/** Steps of a run that went outside Salesforce records and can't be undone. */
export async function notUndoable(tenantId: string, runIds: string[]): Promise<{ runId: string; label: string }[]> {
  if (!runIds.length) return [];
  const { rows } = await pool.query('select id, steps from runs where tenant_id=$1 and id = any($2)', [tenantId, runIds]);
  const KINDS: Record<string, string> = { 'sf.emailReply': 'Email reply', 'notify.sms': 'Text message', 'notify.slack': 'Slack message', 'sf.action': 'Salesforce action (Flow/Apex)', 'http.request': 'Web request' };
  const out: { runId: string; label: string }[] = [];
  for (const r of rows) {
    for (const s of (r.steps ?? []) as { type: string; status: string; label?: string; output?: { sent?: boolean; wouldDo?: string } }[]) {
      if (s.status !== 'ok' || !KINDS[s.type] || s.output?.wouldDo || (s.type === 'sf.emailReply' && s.output?.sent !== true)) continue;
      out.push({ runId: r.id, label: `${KINDS[s.type]}${s.label ? `: ${s.label}` : ''}` });
    }
  }
  return out;
}

export interface UndoReport { restored: number; deleted: number; recovered: number; skipped: { recordId: string; object: string; why: string }[]; failed: { recordId: string; object: string; error: string }[] }

/** Undo logged changes (newest first). */
export async function undoChanges(tenantId: string, sf: SalesforceClient, changeIds: number[], who: string): Promise<UndoReport> {
  const { rows } = await pool.query(
    'select * from run_changes where tenant_id=$1 and id = any($2) and undone_at is null order by created_at desc, id desc', [tenantId, changeIds]);
  const rep: UndoReport = { restored: 0, deleted: 0, recovered: 0, skipped: [], failed: [] };
  const done = async (id: number, result: string) => pool.query('update run_changes set undone_at=now(), undone_by=$2, undo_result=$3 where id=$1', [id, who, result]);
  // Several changes to one record: the oldest "before" is what to go back to.
  const seen = new Set<string>();
  // Records this undo itself changed (their LastModifiedDate is ours now), and ones where a person's edit was kept.
  const touched = new Set<string>(), personKept = new Set<string>();
  for (const c of rows as ChangeRow[]) {
    const key = `${c.object}:${c.record_id}`;
    try {
      if (!/^[A-Za-z]\w*$/.test(c.object) || !/^[a-zA-Z0-9]{15,18}$/.test(c.record_id)) throw new Error('Not a valid record');
      if (!c.undoable) { rep.skipped.push({ recordId: c.record_id, object: c.object, why: 'The old values could not be read when it changed' }); continue; }
      if (c.op === 'update') {
        const older = (rows as ChangeRow[]).filter((x) => x.op === 'update' && `${x.object}:${x.record_id}` === key);
        if (seen.has(key)) { await done(c.id, 'Covered by an earlier change'); continue; }
        seen.add(key);
        const before: Record<string, unknown> = {}, after: Record<string, unknown> = {};
        for (const x of older.reverse()) { for (const [f, v] of Object.entries(x.before ?? {})) if (!(f in before)) before[f] = v; }
        Object.assign(after, ...older.map((x) => x.after ?? {}));
        const fields = Object.keys(before).filter((f) => /^\w+$/.test(f));
        const now = (await sf.query(`SELECT Id, ${fields.join(', ')} FROM ${c.object} WHERE Id = '${c.record_id}'`)).records[0] as Record<string, unknown> | undefined;
        if (!now) { rep.skipped.push({ recordId: c.record_id, object: c.object, why: 'The record no longer exists' }); continue; }
        const plan = restorePlan(before, after, now);
        if (Object.keys(plan.restore).length) {
          const j = sf.journal; sf.journal = undefined; // putting things back is not a new change to log
          try { await sf.updateRecord(c.object, c.record_id, plan.restore); } finally { sf.journal = j; }
          rep.restored++;
          touched.add(key);
        }
        if (plan.skipped.length) personKept.add(key);
        if (plan.skipped.length) rep.skipped.push({ recordId: c.record_id, object: c.object, why: `Changed by someone since, kept: ${plan.skipped.join(', ')}` });
        for (const x of older) await done(x.id, plan.skipped.length ? `Restored except ${plan.skipped.join(', ')}` : 'Restored');
      } else if (c.op === 'create') {
        if (c.object === 'ContentVersion') {
          const v = (await sf.query(`SELECT ContentDocumentId FROM ContentVersion WHERE Id = '${c.record_id}'`)).records[0] as { ContentDocumentId?: string } | undefined;
          if (v?.ContentDocumentId) { const j = sf.journal; sf.journal = undefined; try { await sf.deleteRecord('ContentDocument', v.ContentDocumentId); } finally { sf.journal = j; } }
        } else {
          const r = (await sf.query(`SELECT Id, CreatedDate, LastModifiedDate, LastModifiedById, CreatedById FROM ${c.object} WHERE Id = '${c.record_id}'`).catch(() => ({ records: [] }))).records[0] as { LastModifiedById?: string; CreatedById?: string; CreatedDate?: string; LastModifiedDate?: string } | undefined;
          if (!r) { await done(c.id, 'Already gone'); continue; }
          // Edited by someone after the agent's last change to it (and not by this undo)? Then it stays.
          const { rows: last } = await pool.query('select max(created_at) as at from run_changes where tenant_id=$1 and object=$2 and left(record_id,15)=left($3,15)', [tenantId, c.object, c.record_id]);
          const agentLast = last[0]?.at ? new Date(last[0].at).getTime() : 0;
          const editedLater = !touched.has(key) && r.LastModifiedDate && Date.parse(r.LastModifiedDate.replace(/([+-]\d{2})(\d{2})$/, '$1:$2')) > agentLast + 5000;
          if (personKept.has(key) || editedLater || (r.LastModifiedById && r.CreatedById && r.LastModifiedById !== r.CreatedById && !touched.has(key))) {
            rep.skipped.push({ recordId: c.record_id, object: c.object, why: 'Someone else edited this new record since, so it was kept' });
            continue;
          }
          const j = sf.journal; sf.journal = undefined;
          try { await sf.deleteRecord(c.object, c.record_id); } finally { sf.journal = j; }
        }
        rep.deleted++;
        await done(c.id, 'Deleted (in the Recycle Bin for 15 days)');
      } else {
        const [r] = await sf.undelete([c.record_id]);
        if (!r?.ok) throw new Error(r?.error ?? 'Not in the Recycle Bin any more');
        rep.recovered++;
        await done(c.id, 'Brought back from the Recycle Bin');
      }
    } catch (e) {
      rep.failed.push({ recordId: c.record_id, object: c.object, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return rep;
}
