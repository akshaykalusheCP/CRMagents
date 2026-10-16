import { NODE_DEF_BY_TYPE, type Workflow } from '@crmagents/shared';
import { pool } from '../db.js';
import { enableCdc, LOCK_ID as STREAM_LOCK, streamHealthy, syncStreams } from '../smart/stream.js';
import { SalesforceClient } from '../salesforce/client.js';
import { purgeOldRuns, recoverRuns } from '../trust/recovery.js';

let lastPurge = 0;
import { cachedInsights, snapshotDue } from '../insights/metrics.js';
import { startRunAsync, wakeRuns } from './service.js';

// Server-side triggers without any Salesforce package: every minute, each live workflow asks its org for records
// created (or changed) since the last check and starts a run per record. The cursor is stored, so restarts lose
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
export function watchQuery(object: string, event: TriggerEvent, cursor: Date): { soql: string; field: string } {
  const field = event === 'created' ? 'CreatedDate' : 'SystemModstamp';
  const at = cursor.toISOString().replace(/\.\d{3}Z$/, 'Z');
  return { soql: `SELECT Id, ${field}, LastModifiedById FROM ${object} WHERE ${field} >= ${at} ORDER BY ${field} ASC LIMIT ${BATCH}`, field };
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
  id: string; tenant_id: string; graph: Workflow; watch_cursor: Date; watch_seen: string[]; sf_user_id: string | null; realtime?: boolean;
}

async function tickWorkflow(w: LiveRow) {
  const sched = w.graph.nodes.find((n) => n.type === 'trigger.schedule');
  if (sched) {
    const now = new Date();
    if (scheduleDue(String(sched.config.every ?? 'day'), String(sched.config.at ?? '08:00'), new Date(w.watch_cursor), now)) {
      await pool.query('update workflows set watch_cursor=$2, watch_error=null where id=$1', [w.id, now]); // claim the slot first
      await startRunAsync(w.tenant_id, w.id, { input: `Scheduled run ${now.toISOString()}` });
    }
    return;
  }
  const trig = triggerOf(w.graph);
  if (!trig) {
    await pool.query("update workflows set watch_error='Needs a Salesforce record trigger with an object' where id=$1", [w.id]);
    return;
  }
  // Real-time agents: the change stream starts their runs. Keep the cursor current so polling takes over cleanly
  // (no backlog, no duplicates) if the stream goes down.
  if (w.realtime && await streamHealthy(w.tenant_id, trig.object)) {
    await pool.query("update workflows set watch_cursor=now(), watch_seen='[]', watch_error=null where id=$1", [w.id]);
    return;
  }
  const sf = await SalesforceClient.forTenant(w.tenant_id);
  const { soql, field } = watchQuery(trig.object, trig.event, new Date(w.watch_cursor));
  const { records } = await sf.query(soql);
  const plan = pickNew(records as WatchRecord[], field, new Date(w.watch_cursor), w.watch_seen, trig.event, w.sf_user_id);
  let { cursor, seenAtCursor } = plan;
  for (const [i, id] of plan.run.entries()) {
    try {
      await startRunAsync(w.tenant_id, w.id, { recordId: id, objectApiName: trig.object });
    } catch (e) {
      // Rate limit or budget: keep the cursor before this record so it and the rest run next tick.
      if ((e as { statusCode?: number }).statusCode === 429) { ({ cursor, seenAtCursor } = plan.checkpoints[i]); break; }
      throw e;
    }
  }
  const atCursor = seenAtCursor;
  await pool.query('update workflows set watch_cursor=$2, watch_seen=$3, watch_error=null where id=$1', [w.id, cursor, JSON.stringify(atCursor)]);
}

async function tick() {
  const db = await pool.connect();
  try {
    const { rows: lock } = await db.query('select pg_try_advisory_lock($1) as ok', [LOCK_ID]);
    if (!lock[0].ok) return; // another instance is polling
    try {
      const { rows } = await db.query(
        `select w.id, w.tenant_id, w.graph, w.watch_cursor, w.watch_seen, w.realtime, t.sf_user_id
         from workflows w join tenants t on t.id = w.tenant_id
         where w.live and t.setup_status = 'ready'`,
      );
      for (const w of rows as LiveRow[]) {
        await tickWorkflow(w).catch((e) => pool.query('update workflows set watch_error=$2 where id=$1', [w.id, String(e instanceof Error ? e.message : e).slice(0, 500)]));
      }
      // Wait steps that are over.
      await wakeRuns().catch(() => undefined);
      // Runs that stopped mid-way (restart, crash): resume when safe, otherwise mark them for an admin.
      await recoverRuns({ error: () => {} }).catch(() => undefined);
      // Hourly: clear old run details per each workspace's retention setting.
      if (Date.now() - lastPurge > 3600_000) { lastPurge = Date.now(); await purgeOldRuns().catch(() => undefined); }
      // Once a day per org: record the key business numbers (no AI) so Insights can show trends.
      const { rows: orgs } = await db.query("select id from tenants where setup_status = 'ready'");
      for (const o of orgs) {
        if (await snapshotDue(o.id)) await cachedInsights(o.id, await SalesforceClient.forTenant(o.id), 30, true).catch(() => undefined);
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
    await pool.query("update workflows set live=true, live_since=now(), watch_cursor=now(), watch_seen='[]', watch_error=null where id=$1", [workflowId]);
    return { live: true, object: trig.object, event: trig.event };
  }
  await pool.query('update workflows set live=false, watch_error=null where id=$1', [workflowId]);
  return { live: false };
}
