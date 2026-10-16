import { purgeLimits } from '../ratelimit.js';
import { tzOffset } from '../tz.js';
export { tzOffset };
import { NODE_DEF_BY_TYPE, type Workflow } from '@crmagents/shared';
import { pool } from '../db.js';
import { autoEnableCdc, enableCdc, LOCK_ID as STREAM_LOCK, streamHealthy, syncStreams } from '../smart/stream.js';
import { SalesforceClient } from '../salesforce/client.js';
import { purgeOldRuns, recoverRuns } from '../trust/recovery.js';
import { allowed, apiLevel, pollMinutes } from '../salesforce/limits.js';
import { prefetchFields } from './prefetch.js';
import { syncDue } from '../knowledge/sync.js';

let lastPurge = 0;
import { cachedInsights, snapshotDue } from '../insights/metrics.js';
import { startQueued, startRunAsync, wakeRuns } from './service.js';

// Server-side triggers without any Salesforce package: live workflows ask their org for records created (or
// changed) since the last check and start a run per record (every minute while busy, less often when quiet). The cursor is stored, so restarts lose
// nothing; records changed by CRMagents itself are skipped, so an agent updating its own record can't loop.

const INTERVAL_MS = Number(process.env.WATCH_INTERVAL_SEC ?? 60) * 1000;
const BATCH = 25; // records per workflow per tick; the rest are picked up next tick
const LOCK_ID = 727_001; // one poller across API instances

export type TriggerEvent = 'created' | 'created or updated' | 'updated' | 'deleted';
export const TRIGGER_EVENTS: TriggerEvent[] = ['created', 'created or updated', 'updated', 'deleted'];

export interface RecordTrigger {
  object: string;
  event: TriggerEvent;
  /** Run only when one of these fields changed (empty = any change). */
  changed: string[];
}

/** Every object a workflow's record trigger watches ("Case, Lead" = both). */
export function triggersOf(graph: Workflow): RecordTrigger[] {
  const t = graph.nodes.find((n) => n.type === 'trigger.salesforce');
  if (!t) return [];
  const objects = String(t.config.objectApiName ?? '').split(',').map((o) => o.trim()).filter(Boolean);
  if (!objects.length || objects.some((o) => !/^\w+$/.test(o))) return [];
  const event = TRIGGER_EVENTS.includes(t.config.event) ? (t.config.event as TriggerEvent) : 'created';
  const changed = event === 'created' || event === 'deleted' ? [] : String(t.config.changedFields ?? '').split(',').map((f) => f.trim()).filter((f) => /^\w+$/.test(f));
  return [...new Set(objects)].map((object) => ({ object, event, changed }));
}

/** The first watched object (for features that work on one object). */
export function triggerOf(graph: Workflow): RecordTrigger | null {
  return triggersOf(graph)[0] ?? null;
}

/** SOQL for records since the cursor (inclusive; already-seen ids at the cursor are skipped by the caller). */
export function watchQuery(object: string, event: TriggerEvent, cursor: Date, extra: string[] = [], limit = BATCH): { soql: string; field: string; deleted: boolean } {
  const field = event === 'created' ? 'CreatedDate' : 'SystemModstamp';
  const at = cursor.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const base = ['Id', field, 'LastModifiedById', ...(event === 'updated' ? ['CreatedDate'] : [])];
  const cols = [...base, ...extra.filter((f) => !base.some((b) => b.toLowerCase() === f.toLowerCase()))];
  // Deleted records are read from the Recycle Bin (ALL ROWS query endpoint).
  const where = event === 'deleted' ? `IsDeleted = true AND ${field} >= ${at}` : `${field} >= ${at}`;
  return { soql: `SELECT ${cols.join(', ')} FROM ${object} WHERE ${where} ORDER BY ${field} ASC LIMIT ${limit}`, field, deleted: event === 'deleted' };
}

/** "updated" leaves out records that were only created (not changed since). Pure; tested. */
export function isUpdate(r: Record<string, unknown>): boolean {
  const created = Date.parse(String(r.CreatedDate ?? ''));
  const modified = Date.parse(String(r.SystemModstamp ?? ''));
  return Number.isFinite(created) && Number.isFinite(modified) && modified - created > 2000;
}

/** Whether a watched field differs from the last values seen; unknown records count as unchanged. Pure; tested. */
export function fieldsChanged(changed: string[], before: Record<string, unknown> | undefined, now: Record<string, unknown>): boolean {
  if (!changed.length) return true;
  if (!before) return false;
  const val = (r: Record<string, unknown>, f: string) => {
    const k = Object.keys(r).find((x) => x.toLowerCase() === f.toLowerCase());
    const v = k ? r[k] : null;
    return v === undefined || v === '' ? null : v;
  };
  return changed.some((f) => JSON.stringify(val(before, f)) !== JSON.stringify(val(now, f)));
}

/**
 * Most recent scheduled slot at or before `now`, in the schedule's time zone. Hourly: top of the hour; daily:
 * HH:MM; weekly: Monday HH:MM. Pure; tested.
 */
export function lastSlot(every: string, at: string, now: Date, tz = 'UTC'): Date {
  const [h, m] = /^(\d{1,2}):(\d{2})$/.test(at) ? at.split(':').map(Number) : [8, 0];
  const off = tzOffset(now, tz);
  // Work on the local wall clock (as if it were UTC), then convert back.
  const local = new Date(now.getTime() + off * 60_000);
  const d = new Date(local);
  if (every === 'hour') d.setUTCMinutes(0, 0, 0);
  else {
    d.setUTCHours(h, m, 0, 0);
    if (every === 'week') {
      const back = (d.getUTCDay() + 6) % 7; // days since Monday
      d.setUTCDate(d.getUTCDate() - back);
      if (d > local) d.setUTCDate(d.getUTCDate() - 7);
    } else if (d > local) d.setUTCDate(d.getUTCDate() - 1);
  }
  const guess = new Date(d.getTime() - off * 60_000);
  // Daylight-saving change between the slot and now: use the offset at the slot itself.
  const offAtSlot = tzOffset(guess, tz);
  return offAtSlot === off ? guess : new Date(d.getTime() - offAtSlot * 60_000);
}

/** A scheduled workflow is due when a slot has passed since it last ran (or since it was turned on). */
export function scheduleDue(every: string, at: string, lastRun: Date, now = new Date(), tz = 'UTC'): boolean {
  return lastSlot(every, at, now, tz) > lastRun;
}

export interface WatchRecord { Id: string; LastModifiedById?: string; [k: string]: unknown }

/**
 * Decides which records to run and where the cursor moves. The query is inclusive (>= cursor), so records at the
 * cursor timestamp that were already handled (in `seen`) are skipped; ids at the new cursor are remembered.
 * `checkpoints[i]` is the state to save if running record i fails, so nothing is skipped or run twice.
 */
export function pickNew(records: WatchRecord[], field: string, cursor: Date, seen: string[], event: TriggerEvent, ownUserId: string | null) {
  const run: string[] = [];
  const checkpoints: { cursor: Date; seenAtCursor: string[] }[] = [];
  let cur = cursor;
  let atCur = [...seen];
  for (const r of records) {
    const ts = new Date(String(r[field]));
    const already = ts.getTime() <= cur.getTime() && atCur.includes(r.Id);
    const own = event !== 'created' && !!ownUserId && String(r.LastModifiedById ?? '').slice(0, 15) === ownUserId.slice(0, 15);
    if (!already && !own) {
      checkpoints.push({ cursor: cur, seenAtCursor: [...atCur] });
      run.push(r.Id);
    }
    if (ts.getTime() > cur.getTime()) { cur = ts; atCur = []; }
    if (!atCur.includes(r.Id)) atCur.push(r.Id);
  }
  return { run, checkpoints, cursor: cur, seenAtCursor: atCur };
}

interface LiveRow {
  id: string; tenant_id: string; graph: Workflow; watch_cursor: Date; watch_seen: string[]; sf_user_id: string | null;
  realtime?: boolean; sf_flow_name?: string | null; poll_idle: number; poll_next_at: Date | null;
  watch_state: Record<string, { cursor: string; seen: string[] }>;
}

/** Scheduled agents: start a run when their slot comes up (no Salesforce call). */
async function tickSchedule(w: LiveRow, sched: { config: Record<string, any> }) {
  const now = new Date();
  if (scheduleDue(String(sched.config.every ?? 'day'), String(sched.config.at ?? '08:00'), new Date(w.watch_cursor), now, String(sched.config.tz || 'UTC'))) {
    await pool.query('update workflows set watch_cursor=$2, watch_error=null where id=$1', [w.id, now]); // claim the slot first
    await startRunAsync(w.tenant_id, w.id, { input: `Scheduled run ${now.toISOString()}` });
  }
}

/** Where a workflow's checks of one object/event stand. Older rows kept one cursor for their single object. */
function stateOf(w: LiveRow, key: string): { cursor: Date; seen: string[] } {
  const s = w.watch_state?.[key];
  if (s) return { cursor: new Date(s.cursor), seen: s.seen ?? [] };
  return { cursor: new Date(w.watch_cursor), seen: Object.keys(w.watch_state ?? {}).length ? [] : (w.watch_seen ?? []) };
}

async function saveState(id: string, key: string, cursor: Date, seen: string[]) {
  await pool.query(
    "update workflows set watch_state = watch_state || jsonb_build_object($2::text, jsonb_build_object('cursor', $3::text, 'seen', $4::jsonb)), watch_error=null where id=$1",
    [id, key, cursor.toISOString(), JSON.stringify(seen)]);
}

/**
 * Agents watching the same object for the same event in one org share a single query per check, which also
 * selects the fields their first step reads (and the fields they watch for changes). Checks slow down when
 * nothing has changed for a while and when the org's API allowance runs low (limits.ts), and stop near the limit.
 */
async function tickGroup(tenantId: string, object: string, event: TriggerEvent, group: { w: LiveRow; trig: RecordTrigger }[]) {
  const key = `${object}|${event}`;
  const level = apiLevel(tenantId);
  if (!allowed(level, 'trigger')) {
    await pool.query('update workflows set watch_error=$2 where id = any($1)', [group.map((g) => g.w.id), 'Paused: this org has used over 95% of its daily Salesforce API allowance. Checks resume automatically.']);
    return false;
  }
  const sf = await SalesforceClient.forTenant(tenantId);
  const states = group.map((g) => stateOf(g.w, key));
  const minCursor = new Date(Math.min(...states.map((x) => x.cursor.getTime())));
  // Fields every member's first step reads; a member that reads all fields fetches its record itself.
  const wanted = group.map((g) => prefetchFields(g.w.graph, object));
  const extra = [...new Set([...wanted.flatMap((f) => f ?? []), ...group.flatMap((g) => g.trig.changed)])];
  const limit = BATCH * Math.min(group.length, 4);
  const run = (soql: string) => (event === 'deleted' ? sf.queryWithDeleted(soql) : sf.query(soql));
  let q = watchQuery(object, event, minCursor, extra, limit);
  let records: WatchRecord[];
  let fetched = extra;
  try {
    records = (await run(q.soql)).records as WatchRecord[];
  } catch (e) {
    if (!extra.length || !/INVALID_FIELD|No such column/i.test(String(e))) throw e;
    // A field was removed from the org: check without prefetching (each run then fetches its record).
    q = watchQuery(object, event, minCursor, [], limit);
    records = (await run(q.soql)).records as WatchRecord[];
    fetched = [];
  }
  let anyNew = false;
  for (const [i, { w, trig }] of group.entries()) {
    const cur = states[i].cursor;
    // The shared query starts at the oldest cursor: each agent only looks at records from its own cursor on.
    const mine = records.filter((r) => new Date(String(r[q.field])).getTime() >= cur.getTime());
    const plan = pickNew(mine, q.field, cur, states[i].seen, event, w.sf_user_id);
    let { cursor, seenAtCursor } = plan;
    // "Only when these fields change": compare with the values seen last time.
    let before = new Map<string, Record<string, unknown>>();
    if (trig.changed.length && fetched.length && mine.length) {
      const { rows } = await pool.query('select record_id, vals from trigger_values where workflow_id=$1 and record_id = any($2)', [w.id, mine.map((r) => r.Id)]);
      before = new Map(rows.map((r) => [r.record_id as string, r.vals as Record<string, unknown>]));
    }
    const fields = wanted[i] && fetched.length ? wanted[i]! : null;
    for (const [j, id] of plan.run.entries()) {
      const rec = mine.find((r) => r.Id === id)!;
      if (event === 'updated' && !isUpdate(rec)) continue;
      if (trig.changed.length && fetched.length && !fieldsChanged(trig.changed, before.get(id), rec)) continue;
      anyNew = true;
      try {
        await startRunAsync(w.tenant_id, w.id, {
          recordId: id, objectApiName: object, ...(event === 'deleted' ? { deleted: true } : {}),
          ...(fields?.length ? { prefetched: { fields, record: pick(rec, fields) } } : {}),
        });
      } catch (e) {
        // Rate limit or budget: keep the cursor before this record so it and the rest run next tick.
        if ((e as { statusCode?: number }).statusCode === 429) { ({ cursor, seenAtCursor } = plan.checkpoints[j]); break; }
        throw e;
      }
    }
    if (trig.changed.length && fetched.length && mine.length) await rememberValues(w.id, mine, trig.changed);
    await saveState(w.id, key, cursor, seenAtCursor);
  }
  // A full page means more is waiting: keep checking every minute.
  return anyNew || records.length >= limit;
}

/** Last-seen values of the watched fields, to tell a real change from any other edit. */
export async function rememberValues(workflowId: string, records: Record<string, unknown>[], fields: string[]) {
  if (!records.length) return;
  const ids: string[] = [];
  const vals: string[] = [];
  for (const r of records) {
    ids.push(String(r.Id));
    vals.push(JSON.stringify(pick(r, fields)));
  }
  await pool.query(
    `insert into trigger_values (workflow_id, record_id, vals, updated_at)
     select $1, x.id, x.v::jsonb, now() from unnest($2::text[], $3::text[]) as x(id, v)
     on conflict (workflow_id, record_id) do update set vals=excluded.vals, updated_at=now()`,
    [workflowId, ids, vals]);
}

function pick(r: Record<string, unknown>, fields: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const k = Object.keys(r).find((x) => x.toLowerCase() === f.toLowerCase());
    if (k) out[k] = r[k];
  }
  return out;
}

async function tickLive(rows: LiveRow[]) {
  const groups = new Map<string, { w: LiveRow; trig: RecordTrigger }[]>();
  const now = Date.now();
  for (const w of rows) {
    const sched = w.graph.nodes.find((n) => n.type === 'trigger.schedule');
    if (sched) { await tickSchedule(w, sched).catch((e) => fail(w.id, e)); continue; }
    // Webhook agents start when called; agents with a deployed Flow are pushed by Salesforce: nothing to check.
    if (w.graph.nodes.some((n) => n.type === 'trigger.webhook') || w.sf_flow_name) continue;
    const trigs = triggersOf(w.graph);
    if (!trigs.length) { await fail(w.id, 'Needs a Salesforce record trigger with an object'); continue; }
    if (w.poll_next_at && new Date(w.poll_next_at).getTime() > now) continue;
    for (const trig of trigs) {
      // Real-time agents: the change stream starts their runs. Keep the cursor current so polling takes over
      // cleanly (no backlog, no duplicates) if the stream goes down.
      if (w.realtime && await streamHealthy(w.tenant_id, trig.object)) {
        await saveState(w.id, `${trig.object}|${trig.event}`, new Date(), []);
        continue;
      }
      const k = `${w.tenant_id}|${trig.object}|${trig.event}`;
      groups.set(k, [...(groups.get(k) ?? []), { w, trig }]);
    }
  }
  const busy = new Map<string, boolean>();
  const levels = new Map<string, number>();
  for (const [k, group] of groups) {
    const [tenantId, object, event] = k.split('|') as [string, string, TriggerEvent];
    levels.set(tenantId, apiLevel(tenantId));
    const b = await tickGroup(tenantId, object, event, group).catch(async (e) => { await Promise.all(group.map((g) => fail(g.w.id, e))); return false; });
    for (const g of group) busy.set(g.w.id, (busy.get(g.w.id) ?? false) || b);
  }
  for (const [id, b] of busy) {
    const w = rows.find((r) => r.id === id)!;
    const idle = b ? 0 : w.poll_idle + 1;
    const mins = pollMinutes(levels.get(w.tenant_id) ?? 0, idle);
    await pool.query("update workflows set poll_idle=$2, poll_next_at=now() + ($3 || ' minutes')::interval where id=$1", [id, idle, String(mins)]);
  }
}

const fail = (id: string, e: unknown) =>
  pool.query('update workflows set watch_error=$2 where id=$1', [id, String(e instanceof Error ? e.message : e).slice(0, 500)]);

async function tick() {
  const db = await pool.connect();
  try {
    const { rows: lock } = await db.query('select pg_try_advisory_lock($1) as ok', [LOCK_ID]);
    if (!lock[0].ok) return; // another instance is polling
    try {
      const { rows } = await db.query(
        `select w.id, w.tenant_id, w.graph, w.watch_cursor, w.watch_seen, w.watch_state, w.realtime, w.sf_flow_name, w.poll_idle, w.poll_next_at, t.sf_user_id
         from workflows w join tenants t on t.id = w.tenant_id
         where w.live and t.setup_status = 'ready'`,
      );
      await tickLive(rows as LiveRow[]);
      // Runs queued by bulk starts from Salesforce, as the per-minute limit allows.
      await startQueued().catch(() => undefined);
      // Wait steps that are over.
      await wakeRuns().catch(() => undefined);
      // Runs that stopped mid-way (restart, crash): resume when safe, otherwise mark them for an admin.
      await recoverRuns({ error: () => {} }).catch(() => undefined);
      // Hourly: clear old run details per each workspace's retention setting.
      if (Date.now() - lastPurge > 3600_000) {
        lastPurge = Date.now();
        await purgeOldRuns().catch(() => undefined);
        await purgeLimits().catch(() => undefined);
        // Knowledge articles and Files libraries from Salesforce: refreshed once a day.
        await syncDue().catch(() => undefined);
      }
      // Once a day per org: record the key business numbers (no AI) so Insights can show trends. Optional work:
      // skipped while the org's API allowance is running low.
      const { rows: orgs } = await db.query("select id from tenants where setup_status = 'ready'");
      for (const o of orgs) {
        if (allowed(apiLevel(o.id), 'background') && await snapshotDue(o.id)) await cachedInsights(o.id, await SalesforceClient.forTenant(o.id), 30, true).catch(() => undefined);
      }
    } finally {
      await db.query('select pg_advisory_unlock($1)', [LOCK_ID]);
    }
  } finally {
    db.release();
  }
}

export function startWatcher(log: { error: (o: unknown, m: string) => void }) {
  const run = () => tick().catch((e) => log.error({ err: String(e) }, 'watcher tick failed'));
  setTimeout(run, 5_000);
  // Real-time streams: one process owns them (a session-level lock held for the life of the process).
  void (async () => {
    const db = await pool.connect();
    const { rows } = await db.query('select pg_try_advisory_lock($1) as ok', [STREAM_LOCK]);
    if (!rows[0].ok) { db.release(); return; }
    const sync = () => syncStreams(log).catch((e) => log.error({ err: String(e) }, 'stream sync failed'));
    setTimeout(sync, 3_000);
    setInterval(sync, INTERVAL_MS);
  })().catch((e) => log.error({ err: String(e) }, 'stream startup failed'));
  return setInterval(run, INTERVAL_MS);
}

/** Real-time on: turn on Change Data Capture for the agent's object; off: back to 1-minute checks. */
export async function setRealtime(tenantId: string, workflowId: string, on: boolean) {
  const { rows } = await pool.query('select graph from workflows where id=$1 and tenant_id=$2', [workflowId, tenantId]);
  if (!rows[0]) throw Object.assign(new Error('workflow not found'), { statusCode: 404 });
  if (on) {
    const trigs = triggersOf(rows[0].graph);
    if (!trigs.length) throw new Error('Real-time works for agents started by a Salesforce record.');
    const sf = await SalesforceClient.forTenant(tenantId);
    for (const t of trigs) await enableCdc(sf, t.object);
  }
  await pool.query('update workflows set realtime=$2 where id=$1', [workflowId, on]);
  return { realtime: on };
}

/** Turn a workflow's server-side trigger on (from now, no backfill) or off. */
export async function setLive(tenantId: string, workflowId: string, on: boolean) {
  const { rows } = await pool.query('select graph from workflows where id=$1 and tenant_id=$2', [workflowId, tenantId]);
  if (!rows[0]) throw Object.assign(new Error('workflow not found'), { statusCode: 404 });
  const graph = rows[0].graph as Workflow;
  const reset = "live=true, live_since=now(), watch_cursor=now(), watch_seen='[]', watch_state='{}', watch_error=null, paused_reason=null, poll_idle=0, poll_next_at=null";
  if (on) {
    if (graph.nodes.some((n) => n.type === 'trigger.schedule')) {
      // Scheduled agents: first run at the next slot after turning on.
      await pool.query(`update workflows set ${reset} where id=$1`, [workflowId]);
      return { live: true, object: '', event: 'schedule' };
    }
    if (graph.nodes.some((n) => n.type === 'trigger.webhook')) {
      await pool.query(`update workflows set ${reset} where id=$1`, [workflowId]);
      return { live: true, object: '', event: 'webhook' };
    }
    const trigs = triggersOf(graph);
    if (!trigs.length) throw new Error('Add a Salesforce record trigger with an object (for example Case) first.');
    if (!NODE_DEF_BY_TYPE['trigger.salesforce']) throw new Error('unsupported');
    // Validate the objects/fields once so a typo fails now, not silently every minute.
    const sf = await SalesforceClient.forTenant(tenantId);
    for (const t of trigs) {
      const q = watchQuery(t.object, t.event, new Date(), t.changed);
      await (q.deleted ? sf.queryWithDeleted(q.soql) : sf.query(q.soql));
    }
    // Real-time change events cost no API calls per change: use them when the org has room for every object.
    let realtime = true;
    for (const t of trigs) realtime = (await autoEnableCdc(sf, t.object)) && realtime;
    await pool.query(`update workflows set ${reset}, realtime=(realtime or $2) where id=$1`, [workflowId, realtime]);
    // "Only when these fields change": remember today's values of recently edited records, so the first change
    // after turning on is recognised (a few calls once, a Bulk API job for big objects).
    await pool.query('delete from trigger_values where workflow_id=$1', [workflowId]);
    for (const t of trigs.filter((x) => x.changed.length)) {
      const since = new Date(Date.now() - 90 * 86_400_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
      const recent = await sf.queryAll(`SELECT Id, ${t.changed.join(', ')} FROM ${t.object} WHERE SystemModstamp >= ${since}`, 50_000).catch(() => null);
      if (recent) for (let i = 0; i < recent.records.length; i += 5000) await rememberValues(workflowId, recent.records.slice(i, i + 5000), t.changed);
    }
    return { live: true, object: trigs.map((t) => t.object).join(', '), event: trigs[0].event, realtime };
  }
  await pool.query('update workflows set live=false, watch_error=null, paused_reason=null where id=$1', [workflowId]);
  await pool.query('delete from trigger_values where workflow_id=$1', [workflowId]);
  return { live: false };
}
