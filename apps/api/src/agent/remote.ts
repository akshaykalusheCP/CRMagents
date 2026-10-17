import { recordsToTable } from '../salesforce/table.js';
import { compactRecord, type Journal } from '../salesforce/client.js';

// Assistants answering inside Salesforce run their Salesforce tools there, as the person asking: the panel picks
// up each tool call, Apex runs it in user mode (their sharing, field permissions and name in the field history),
// and posts the result back. Nothing uses the org's API allowance, and nobody sees more through an assistant than
// they could see themselves.

/** Tools that run inside Salesforce when the question comes from Salesforce. */
export const IN_ORG_TOOLS = new Set(['soql_query', 'get_record', 'describe_object', 'create_record', 'update_record', 'delete_record', 'run_org_action', 'list_files']);

const WAIT_MS = 90_000; // the panel checks every 1–3 s; much longer means it was closed
const RESEND_MS = 15_000;

interface Call { id: string; name: string; input: unknown; sentAt: number }
interface Pending { calls: Call[]; waiters: Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }> }

const runs = new Map<string, Pending>();
let seq = 0;

/** A tool runner for one run: returns undefined for tools that stay on our side (knowledge search, run_agent). */
export function remoteExecutor(runId: string, journal?: Journal) {
  const p: Pending = { calls: [], waiters: new Map() };
  runs.set(runId, p);
  // Files are read on our side (Apex can't read PDFs), but only files Salesforce listed for this person.
  const visibleFiles = new Set<string>();
  return (name: string, input: unknown): Promise<unknown> | undefined => {
    if (name === 'read_file') {
      const id = String((input as { versionId?: string })?.versionId ?? '');
      return visibleFiles.has(id.slice(0, 15)) ? undefined : Promise.reject(new Error('Use list_files on the record first; only files you can see there can be read.'));
    }
    if (!IN_ORG_TOOLS.has(name)) return undefined;
    const id = `t${++seq}`;
    p.calls.push({ id, name, input, sentAt: 0 });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        p.waiters.delete(id);
        p.calls = p.calls.filter((c) => c.id !== id);
        reject(new Error('Salesforce did not run this step (the panel was probably closed).'));
      }, WAIT_MS);
      p.waiters.set(id, {
        resolve: (v) => {
          if (journal) void logInOrgChange(journal, name, input as Record<string, unknown>, v as Record<string, unknown>);
          if (name === 'list_files') for (const f of ((v as { files?: { versionId?: string }[] })?.files ?? [])) if (f.versionId) visibleFiles.add(f.versionId.slice(0, 15));
          resolve(formatResult(name, v));
        },
        reject, timer,
      });
    });
  };
}

/** A change Apex made as the person asking, in the change log (so it can be undone like any other). Pure-ish; tested. */
export function inOrgChange(name: string, input: Record<string, unknown>, result: Record<string, unknown>) {
  const object = String(result?.object ?? input?.sobject ?? '');
  if (name === 'create_record' && result?.id) return { op: 'create' as const, object, recordId: String(result.id), after: (input.fields as Record<string, unknown>) ?? {}, undoable: true };
  if (name === 'update_record' && input?.id) return { op: 'update' as const, object, recordId: String(input.id), before: (result?.before as Record<string, unknown>) ?? null, after: (input.fields as Record<string, unknown>) ?? {}, undoable: !!result?.before };
  if (name === 'delete_record' && input?.id) return { op: 'delete' as const, object, recordId: String(input.id), before: (result?.before as Record<string, unknown>) ?? null, undoable: true };
  return null;
}
async function logInOrgChange(journal: Journal, name: string, input: Record<string, unknown>, result: Record<string, unknown>) {
  const c = inOrgChange(name, input, result);
  if (c && c.object) await journal([c]).catch(() => undefined);
}

/** Tool calls waiting for Salesforce; a call handed out but not answered for a while is handed out again. */
export function takeCalls(runId: string): { id: string; name: string; input: unknown }[] {
  const p = runs.get(runId);
  if (!p) return [];
  const now = Date.now();
  const due = p.calls.filter((c) => !c.sentAt || now - c.sentAt > RESEND_MS);
  for (const c of due) c.sentAt = now;
  return due.map(({ id, name, input }) => ({ id, name, input }));
}

export function deliverResults(runId: string, results: { id: string; ok: boolean; result?: unknown; error?: string }[]): number {
  const p = runs.get(runId);
  if (!p) return 0;
  let n = 0;
  for (const r of results) {
    const w = p.waiters.get(r.id);
    if (!w) continue;
    clearTimeout(w.timer);
    p.waiters.delete(r.id);
    p.calls = p.calls.filter((c) => c.id !== r.id);
    if (r.ok) w.resolve(r.result); else w.reject(new Error(r.error || 'Failed in Salesforce'));
    n++;
  }
  return n;
}

export function endRemote(runId: string) {
  const p = runs.get(runId);
  if (!p) return;
  for (const w of p.waiters.values()) { clearTimeout(w.timer); w.reject(new Error('Run ended')); }
  runs.delete(runId);
}

const MAX_ROWS = 50;

/** Same shapes the AI gets when the tools run on our side. Pure; tested. */
export function formatResult(name: string, v: any): unknown {
  if (name === 'soql_query') {
    const records = (v?.records ?? []).map((r: unknown) => compactRecord(r)) as Record<string, unknown>[];
    const total = Number(v?.totalSize ?? records.length);
    const rows = records.slice(0, MAX_ROWS);
    const head = `${total} row(s)${rows.length < total ? `, showing ${rows.length}` : ''}`;
    return rows.length ? `${head} (CSV):\n${recordsToTable(rows)}` : head;
  }
  if (name === 'get_record') return compactRecord(v);
  if (name === 'describe_object') {
    const fields = (v?.fields ?? []) as { name: string; type: string; updateable: boolean; referenceTo?: string[]; picklist?: string[] }[];
    const withPicklists = fields.length < 15;
    const lines = fields.slice(0, 300).map((f) => {
      let t = f.type;
      if (f.type === 'reference' && f.referenceTo?.length) t = `reference(${f.referenceTo.join('|')})`;
      if (withPicklists && f.picklist?.length) t += ` [${f.picklist.join(', ')}]`;
      return `${f.name}: ${t}${f.updateable ? '' : ' (read-only)'}`;
    });
    return `${v?.sobject ?? ''} (${fields.length} fields you can see)\n${lines.join('\n')}`;
  }
  if (name === 'list_files') {
    const files = (v?.files ?? []) as { title: string; extension: string; size: number; versionId: string }[];
    return files.length ? files.map((f) => `${f.title}.${f.extension} (${Math.ceil(Number(f.size) / 1024)} KB) versionId=${f.versionId}`).join('\n') : 'No files on this record.';
  }
  return v;
}
