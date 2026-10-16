import { fromCreateEvent, prefetchFields } from '../engine/prefetch.js';
import type { Workflow } from '@crmagents/shared';
import { config } from '../config.js';
import { pool } from '../db.js';
import { startRunAsync } from '../engine/service.js';
import { triggersOf } from '../engine/watcher.js';
import { SalesforceClient } from '../salesforce/client.js';

// Real-time triggers: Salesforce Change Data Capture over the Streaming API (CometD long-polling, no extra
// libraries). One connection per org carries every object its real-time agents watch. Replay ids are stored so a
// restart resumes where it left off; while a stream is unhealthy the 60-second watcher covers those agents.

export const LOCK_ID = 727002;
const HEALTHY_MS = 3 * 60_000;

/** "Case" -> "CaseChangeEvent", "Claim__c" -> "Claim__ChangeEvent". Pure; tested. */
export function changeEventFor(object: string): string {
  return object.endsWith('__c') ? `${object.slice(0, -3)}__ChangeEvent` : `${object}ChangeEvent`;
}

export interface ChangeHeader { entityName: string; changeType: string; recordIds: string[]; commitUser?: string; changedFields?: string[] }

/** Which agents and records a change event starts. Pure; tested. */
export function routeEvent(h: ChangeHeader, agents: { id: string; object: string; event: string; changed?: string[] }[], ownUserId: string | null): { workflowId: string; recordId: string }[] {
  const type = h.changeType.replace(/^GAP_/, '');
  if (!['CREATE', 'UPDATE', 'UNDELETE', 'DELETE'].includes(type)) return [];
  // Our own writes come back as events; skipping them stops agents from triggering themselves.
  if (type !== 'CREATE' && ownUserId && h.commitUser && h.commitUser.slice(0, 15) === ownUserId.slice(0, 15)) return [];
  // Compound fields come as "Name.FirstName": the watched field is the part before the dot.
  const changed = new Set((h.changedFields ?? []).map((f) => f.split('.')[0].toLowerCase()));
  const out: { workflowId: string; recordId: string }[] = [];
  for (const a of agents) {
    if (a.object !== h.entityName) continue;
    const ok = a.event === 'created' ? type === 'CREATE'
      : a.event === 'deleted' ? type === 'DELETE'
      : a.event === 'updated' ? type === 'UPDATE'
      : type !== 'DELETE'; // created or updated
    if (!ok) continue;
    // "Only when these fields change" (gap events carry no field list: let them through).
    if (type === 'UPDATE' && a.changed?.length && !h.changeType.startsWith('GAP_') && !a.changed.some((f) => changed.has(f.toLowerCase()))) continue;
    for (const id of h.recordIds) out.push({ workflowId: a.id, recordId: id });
  }
  return out;
}

/** Turn on Change Data Capture for an object (Tooling API). Already-on is fine. */
export async function enableCdc(sf: SalesforceClient, object: string) {
  const entity = changeEventFor(object);
  try {
    await sf.tooling('POST', '/sobjects/PlatformEventChannelMember', { FullName: `ChangeEvents_${entity}`, Metadata: { eventChannel: 'ChangeEvents', selectedEntity: entity } });
  } catch (e) {
    const msg = String(e instanceof Error ? e.message : e);
    if (/DUPLICATE|already exists|duplicate value/i.test(msg)) return;
    if (/LIMIT|maximum/i.test(msg)) throw new Error(`Salesforce allows only a few objects for real-time changes in this edition, and the limit is reached. Turn one off in Setup → Change Data Capture, or keep this agent on 1-minute checks.`);
    throw new Error(`Couldn't turn on real-time changes for ${object}: ${msg.replace(/^Salesforce \w+ \S+ -> /, '').slice(0, 200)}`);
  }
}

/** Salesforce editions include change events for 5 objects unless the org buys more. */
const CDC_INCLUDED = 5;

/**
 * Turns on real-time changes for an object when that costs the customer nothing: the object is already enabled,
 * or at least two of the org's change-event slots are free (one is always left for their own use).
 * Returns whether real-time is on. Best effort: never throws.
 */
export async function autoEnableCdc(sf: SalesforceClient, object: string): Promise<boolean> {
  try {
    const entity = changeEventFor(object);
    const r = await sf.toolingQuery<{ SelectedEntity: string }>("SELECT SelectedEntity FROM PlatformEventChannelMember WHERE EventChannel = 'ChangeEvents'");
    const selected = r.records.map((x) => x.SelectedEntity);
    if (selected.includes(entity)) return true;
    if (CDC_INCLUDED - selected.length < 2) return false;
    await enableCdc(sf, object);
    return true;
  } catch {
    return false;
  }
}

interface Live { id: string; tenant_id: string; graph: Workflow; sf_user_id: string | null }

class OrgStream {
  private stopped = false;
  private clientId = '';
  private cookies = '';
  private channels = new Set<string>();
  constructor(readonly tenantId: string, private onError: (e: string) => void) {}

  private async post(sf: SalesforceClient, body: unknown[], retried = false): Promise<any[]> {
    const { instanceUrl, token } = await sf.session(retried);
    const res = await fetch(`${instanceUrl}/cometd/${config.sf.apiVersion.replace(/^v/, '')}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(this.cookies ? { Cookie: this.cookies } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(130_000),
    });
    const set = res.headers.getSetCookie?.() ?? [];
    if (set.length) this.cookies = set.map((c) => c.split(';')[0]).join('; ');
    if (res.status === 401 && !retried) return this.post(sf, body, true);
    if (!res.ok) throw new Error(`Streaming ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return res.json() as Promise<any[]>;
  }

  async run(channels: string[]) {
    const sf = await SalesforceClient.forTenant(this.tenantId);
    while (!this.stopped) {
      try {
        const [hs] = await this.post(sf, [{ channel: '/meta/handshake', version: '1.0', minimumVersion: '1.0', supportedConnectionTypes: ['long-polling'], ext: { replay: true } }]);
        if (!hs?.successful) throw new Error(`Handshake failed: ${hs?.error ?? 'unknown'}`);
        this.clientId = hs.clientId;
        const { rows } = await pool.query('select channel, replay_id from stream_state where tenant_id=$1', [this.tenantId]);
        const replay = Object.fromEntries(channels.map((c) => [c, Number(rows.find((r) => r.channel === c)?.replay_id ?? -1)]));
        for (const c of channels) {
          const [sub] = await this.post(sf, [{ channel: '/meta/subscribe', clientId: this.clientId, subscription: c, ext: { replay: { [c]: replay[c] } } }]);
          if (!sub?.successful) throw new Error(`Subscribe to ${c} failed: ${sub?.error ?? 'unknown'}`);
          this.channels.add(c);
        }
        await this.mark(channels, null);
        while (!this.stopped) {
          const msgs = await this.post(sf, [{ channel: '/meta/connect', clientId: this.clientId, connectionType: 'long-polling' }]);
          for (const m of msgs) {
            if (m.channel === '/meta/connect') {
              if (!m.successful) throw new Error(m.error ?? 'connect failed'); // re-handshake
              continue;
            }
            if (m.data?.payload?.ChangeEventHeader) await this.handle(m.channel, m.data.payload.ChangeEventHeader, m.data.event?.replayId, m.data.payload);
          }
          await this.mark(channels, null);
        }
      } catch (e) {
        if (this.stopped) return;
        const msg = String(e instanceof Error ? e.message : e);
        this.onError(msg);
        await this.mark(channels, msg);
        await new Promise((r) => setTimeout(r, 15_000));
      }
    }
  }

  private async handle(channel: string, h: ChangeHeader, replayId?: number, payload: Record<string, unknown> = {}) {
    const { rows } = await pool.query(
      `select w.id, w.graph, t.sf_user_id from workflows w join tenants t on t.id = w.tenant_id
       where w.tenant_id=$1 and w.live and w.realtime`, [this.tenantId]);
    const agents = rows.flatMap((r) => triggersOf(r.graph).map((t) => ({ id: r.id, object: t.object, event: t.event, changed: t.changed })));
    for (const job of routeEvent(h, agents, rows[0]?.sf_user_id ?? null)) {
      // A "created" event carries every field with a value: the run can skip fetching the record.
      const graph = rows.find((r) => r.id === job.workflowId)?.graph;
      const fields = h.changeType === 'CREATE' && graph ? prefetchFields(graph, h.entityName) : null;
      const prefetched = fields?.length && h.recordIds.length === 1 ? fromCreateEvent(payload, fields) : null;
      const deleted = h.changeType.replace(/^GAP_/, '') === 'DELETE';
      await startRunAsync(this.tenantId, job.workflowId, { recordId: job.recordId, objectApiName: h.entityName, ...(deleted ? { deleted: true } : {}), ...(prefetched ? { prefetched } : {}) }).catch(() => undefined);
    }
    if (replayId !== undefined) {
      await pool.query(
        `insert into stream_state (tenant_id, channel, replay_id, error, updated_at) values ($1,$2,$3,null,now())
         on conflict (tenant_id, channel) do update set replay_id=excluded.replay_id, error=null, updated_at=now()`, [this.tenantId, channel, replayId]);
    }
  }

  private async mark(channels: string[], error: string | null) {
    for (const c of channels) {
      await pool.query(
        `insert into stream_state (tenant_id, channel, error, updated_at) values ($1,$2,$3,now())
         on conflict (tenant_id, channel) do update set error=excluded.error, updated_at=now()`, [this.tenantId, c, error]);
    }
  }

  stop() { this.stopped = true; }
}

const streams = new Map<string, { key: string; s: OrgStream }>();

/** Start, restart or stop org streams so they match the live real-time agents. Called every watcher tick. */
export async function syncStreams(log: { error: (o: unknown, m: string) => void }) {
  const { rows } = await pool.query(
    `select w.id, w.tenant_id, w.graph, t.sf_user_id from workflows w join tenants t on t.id = w.tenant_id
     where w.live and w.realtime and t.setup_status = 'ready'`);
  const want = new Map<string, Set<string>>();
  for (const w of rows as Live[]) {
    for (const t of triggersOf(w.graph)) (want.get(w.tenant_id) ?? want.set(w.tenant_id, new Set()).get(w.tenant_id)!).add(`/data/${changeEventFor(t.object)}`);
  }
  for (const [tenant, cur] of streams) {
    const chans = want.get(tenant);
    if (!chans || [...chans].sort().join(',') !== cur.key) { cur.s.stop(); streams.delete(tenant); }
  }
  for (const [tenant, chans] of want) {
    if (streams.has(tenant)) continue;
    const key = [...chans].sort().join(',');
    const s = new OrgStream(tenant, (e) => log.error({ tenant, err: e }, 'stream error'));
    streams.set(tenant, { key, s });
    void s.run([...chans]);
  }
}

/** Is this org's stream for the object up and recently heard from? The watcher polls when not. */
export async function streamHealthy(tenantId: string, object: string): Promise<boolean> {
  const { rows } = await pool.query('select error, updated_at from stream_state where tenant_id=$1 and channel=$2', [tenantId, `/data/${changeEventFor(object)}`]);
  return !!rows[0] && !rows[0].error && Date.now() - new Date(rows[0].updated_at).getTime() < HEALTHY_MS;
}
