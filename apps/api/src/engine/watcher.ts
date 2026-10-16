import { NODE_DEF_BY_TYPE, type Workflow } from '@crmagents/shared';
import { pool } from '../db.js';
import { autoEnableCdc, enableCdc, LOCK_ID as STREAM_LOCK, streamHealthy, syncStreams } from '../smart/stream.js';
import { SalesforceClient } from '../salesforce/client.js';
import { purgeOldRuns, recoverRuns } from '../trust/recovery.js';
import { allowed, apiLevel, pollMinutes } from '../salesforce/limits.js';
import { prefetchFields } from './prefetch.js';

let lastPurge = 0;
import { cachedInsights, snapshotDue } from '../insights/metrics.js';
import { startQueued, startRunAsync, wakeRuns } from './service.js';

// Server-side triggers without any Salesforce package: live workflows ask their org for records created (or
// changed) since the last check and start a run per record (every minute while busy, less often when quiet). The cursor is stored, so restarts lose
// nothing; records changed by CRMagents itself are skipped, so an agent updating its own record can't loop.

const INTERVAL_MS = Number(process.env.WATCH_INTERVAL_SEC ?? 60) * 1000;
const BATCH = 25; // records per workflow per tick; the rest are picked up next tick
const LOCK_ID = 727_001; // one poller across API instances

export type TriggerEvent = 'created' | 'created or updated';

export function triggerOf(graph: Workflow): { object: string; event: TriggerEvent } | null {
  const t = graph.nodes.find((n) => n.type === 'trigger.salesforce');
  const object = String(t?.config.objectApiName ?? '').trim();
  if (!object || !/^\w+$/.test(object)) return null;
  return { object, event: t?.config.event === 'created or updated' ? 'created or updated' : 'created' };
}

/** SOQL for records since the cursor (inclusive; already-seen ids at the cursor are skipped by the caller). */
export function watchQuery(object: string, event: TriggerEvent, cursor: Date, extra: string[] = [], limit = BATCH): { soql: string; field: string } {
  const field = event === 'created' ? 'CreatedDate' : 'SystemModstamp';
  const at = cursor.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const base = ['Id', field, 'LastModifiedById'];
  const cols = [...base, ...extra.filter((f) => !base.some((b) => b.toLowerCase() === f.toLowerCase()))];
  return { soql: `SELECT ${cols.join(', ')} FROM ${object} WHERE ${field} >= ${at} ORDER BY ${field} ASC LIMIT ${limit}`, field };
}

/** Most recent scheduled slot at or before `now` (UTC). Hourly: top of the hour; daily: HH:MM; weekly: Monday HH:MM. */
export function lastSlot(every: string, at: string, now: Date): Date {
  const [h, m] = /^(\d{1,2}):(\d{2})$/.test(at) ? at.split(':').map(Number) : [8, 0];
  const d = new Date(now);
  if (every === 'hour') { d.setUTCMinutes(0, 0, 0); return d; }
  d.setUTCHours(h, m, 0, 0);
  if (every === 'week') {
    const back = (d.getUTCDay() + 6) % 7; // days since Monday
    d.setUTCDate(d.getUTCDate() - back);
    if (d > now) d.setUTCDate(d.getUTCDate() - 7);
    return d;
  }
  if (d > now) d.setUTCDate(d.getUTCDate() - 1);
  return d;
}

/** A scheduled workflow is due when a slot has passed since it last ran (or since it was turned on). */
export function scheduleDue(every: string, at: string, lastRun: Date, now = new Date()): boolean {
  return lastSlot(every, at, now) > lastRun;
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
}

/** Scheduled agents: start a run when their slot comes up (no Salesforce call). */
async function tickSchedule(w: LiveRow, sched: { config: Record<string, any> }) {
  const now = new Date();
  if (scheduleDue(String(sched.config.every ?? 'day'), String(sched.config.at ?? '08:00'), new Date(w.watch_cursor), now)) {
    await pool.query('update workflows set watch_cursor=$2, watch_error=null where id=$1', [w.id, now]); // claim the slot first
    await startRunAsync(w.tenant_id, w.id, { input: `Scheduled run ${now.toISOString()}` });
  }
}

/**
 * Agents watching the same object for the same event in one org share a single query per check, which also
 * selects the fields their first step reads. Checks slow down when nothing has changed for a while and when the
 * org's API allowance runs low (limits.ts), and stop near the limit.
 */
async function tickGroup(tenantId: string, object: string, event: TriggerEvent, group: LiveRow[]) {
  const now = Date.now();
  if (!group.some((w) => !w.poll_next_at || new Date(w.poll_next_at).getTime() <= now)) return;
  const level = apiLevel(tenantId);
  if (!allowed(level, 'trigger')) {
    await pool.query("update workflows set watch_error=$2 where id = any($1)", [group.map((w) => w.id), 'Paused: this org has used over 95% of its daily Salesforce API allowance. Checks resume automatically.']);
    return;
  }
  const sf = await SalesforceClient.forTenant(tenantId);
  const minCursor = new Date(Math.min(...group.map((w) => new Date(w.watch_cursor).getTime())));
  // Fields every member's first step reads; a member that reads all fields fetches its record itself.
  const wanted = group.map((w) => prefetchFields(w.graph, object));
  const extra = [...new Set(wanted.flatMap((f) => f ?? []))];
  const limit = BATCH * Math.min(group.length, 4);
  let q = watchQuery(object, event, minCursor, extra, limit);
  let records: WatchRecord[];
  let fetched = extra;
  try {
    records = (await sf.query(q.soql)).records as WatchRecord[];
  } catch (e) {
    if (!extra.length || !/INVALID_FIELD|No such column/i.test(String(e))) throw e;
    // A field was removed from the org: check without prefetching (each run then fetches its record).
    q = watchQuery(object, event, minCursor, [], limit);
    records = (await sf.query(q.soql)).records as WatchRecord[];
    fetched = [];
  }
  let anyNew = false;
  for (const [i, w] of group.entries()) {
    const cur = new Date(w.watch_cursor);
    // The shared query starts at the oldest cursor: each agent only looks at records from its own cursor on.
    const mine = records.filter((r) => new Date(String(r[q.field])).getTime() >= cur.getTime());
    const plan = pickNew(mine, q.field, cur, w.watch_seen, event, w.sf_user_id);
    let { cursor, seenAtCursor } = plan;
    const fields = wanted[i] && fetched.length ? wanted[i]! : null;
    for (const [j, id] of plan.run.entries()) {
      anyNew = true;
      const rec = fields?.length ? mine.find((r) => r.Id === id) : undefined;
      try {
        await startRunAsync(w.tenant_id, w.id, { recordId: id, objectApiName: object, ...(rec ? { prefetched: { fields: fields!, record: pick(rec, fields!) } } : {}) });
      } catch (e) {
        // Rate limit or budget: keep the cursor before this record so it and the rest run next tick.
        if ((e as { statusCode?: number }).statusCode === 429) { ({ cursor, seenAtCursor } = plan.checkpoints[j]); break; }
        throw e;
      }
    }
    await pool.query('update workflows set watch_cursor=$2, watch_seen=$3, watch_error=null where id=$1', [w.id, cursor, JSON.stringify(seenAtCursor)]);
  }
  // A full page means more is waiting: keep checking every minute.
  const busy = anyNew || records.length >= limit;
  for (const w of group) {
    const idle = busy ? 0 : w.poll_idle + 1;
    const mins = pollMinutes(level, idle);
    await pool.query("update workflows set poll_idle=$2, poll_next_at=now() + ($3 || ' minutes')::interval where id=$1", [w.id, idle, String(mins)]);
  }
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
  const groups = new Map<string, LiveRow[]>();
  for (const w of rows) {
    const sched = w.graph.nodes.find((n) => n.type === 'trigger.schedule');
    if (sched) { await tickSchedule(w, sched).catch((e) => fail(w.id, e)); continue; }
    const trig = triggerOf(w.graph);
    if (!trig) { await fail(w.id, 'Needs a Salesforce record trigger with an object'); continue; }
    // Started from Salesforce by a deployed Flow: Salesforce pushes each record, no checking needed.
    if (w.sf_flow_name) continue;
    // Real-time agents: the change stream starts their runs. Keep the cursor current so polling takes over cleanly
    // (no backlog, no duplicates) if the stream goes down.
    if (w.realtime && await streamHealthy(w.tenant_id, trig.object)) {
      await pool.query("update workflows set watch_cursor=now(), watch_seen='[]', watch_error=null, poll_idle=0, poll_next_at=null where id=$1", [w.id]);
      continue;
    }
    const k = `${w.tenant_id}|${trig.object}|${trig.event}`;
    groups.set(k, [...(groups.get(k) ?? []), w]);
  }
  for (const [k, group] of groups) {
    const [tenantId, object, event] = k.split('|') as [string, string, TriggerEvent];
    await tickGroup(tenantId, object, event, group).catch((e) => Promise.all(group.map((w) => fail(w.id, e))));
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
        `select w.id, w.tenant_id, w.graph, w.watch_cursor, w.watch_seen, w.realtime, w.sf_flow_name, w.poll_idle, w.poll_next_at, t.sf_user_id
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
      if (Date.now() - lastPurge > 3600_000) { lastPurge = Date.now(); await purgeOldRuns().catch(() => undefined); }
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
    const trig = triggerOf(rows[0].graph);
    if (!trig) throw new Error('Real-time works for agents started by a Salesforce record.');
    await enableCdc(await SalesforceClient.forTenant(tenantId), trig.object);
  }
  await pool.query('update workflows set realtime=$2 where id=$1', [workflowId, on]);
  return { realtime: on };
}

/** Turn a workflow's server-side trigger on (from now, no backfill) or off. */
export async function setLive(tenantId: string, workflowId: string, on: boolean) {
  const { rows } = await pool.query('select graph from workflows where id=$1 and tenant_id=$2', [workflowId, tenantId]);
  if (!rows[0]) throw Object.assign(new Error('workflow not found'), { statusCode: 404 });
  if (on) {
    if ((rows[0].graph as Workflow).nodes.some((n) => n.type === 'trigger.schedule')) {
      // Scheduled agents: first run at the next slot after turning on.
      await pool.query("update workflows set live=true, live_since=now(), watch_cursor=now(), watch_seen='[]', watch_error=null where id=$1", [workflowId]);
      return { live: true, object: '', event: 'schedule' };
    }
    const trig = triggerOf(rows[0].graph);
    if (!trig) throw new Error('Add a Salesforce record trigger with an object (for example Case) first.');
    if (!NODE_DEF_BY_TYPE['trigger.salesforce']) throw new Error('unsupported');
    // Validate the object/fields once so a typo fails now, not silently every minute.
    const sf = await SalesforceClient.forTenant(tenantId);
    await sf.query(watchQuery(trig.object, trig.event, new Date()).soql);
    // Real-time change events cost no API calls per change: use them when the org has room for this object.
    const realtime = await autoEnableCdc(sf, trig.object);
    await pool.query(
      "update workflows set live=true, live_since=now(), watch_cursor=now(), watch_seen='[]', watch_error=null, poll_idle=0, poll_next_at=null, realtime=(realtime or $2) where id=$1",
      [workflowId, realtime]);
    return { live: true, object: trig.object, event: trig.event, realtime };
  }
  await pool.query('update workflows set live=false, watch_error=null where id=$1', [workflowId]);
  return { live: false };
}
