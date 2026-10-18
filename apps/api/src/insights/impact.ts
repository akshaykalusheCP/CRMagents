import { WRITE_NODE_TYPES } from '@crmagents/shared';
import { pool } from '../db.js';
import { getSetting, setSetting } from '../settings.js';

// Impact: what the agents did for the business over a period, the time that saved and what it cost. Built only
// from what Nimbus recorded (runs, their steps, suggestions); the minutes per item are assumptions the
// workspace can change, and the page shows them next to the numbers.

export interface Assumptions {
  /** Cost of an hour of a person's time, in USD. */
  hourlyRate: number;
  minutes: {
    /** A record created or updated, a task, a Flow run, a file attached. */
    change: number;
    /** A judgement or text an AI step produced (sorting, extracting, writing, researching). */
    aiStep: number;
    /** An email reply sent to a customer by an agent. */
    replySent: number;
    /** A suggestion a person used (sent or marked helpful). */
    suggestionUsed: number;
    /** A question an assistant answered. */
    answer: number;
    /** A website chat solved without handing it to a person. */
    chat: number;
  };
}

export const DEFAULT_ASSUMPTIONS: Assumptions = {
  hourlyRate: 30,
  minutes: { change: 2, aiStep: 4, replySent: 6, suggestionUsed: 8, answer: 3, chat: 6 },
};

export async function getAssumptions(accountId: string): Promise<Assumptions> {
  const rate = Number(await getSetting(accountId, 'impactHourlyRate'));
  let minutes = DEFAULT_ASSUMPTIONS.minutes;
  try { minutes = { ...minutes, ...JSON.parse((await getSetting(accountId, 'impactMinutes')) ?? '{}') }; } catch { /* defaults */ }
  return { hourlyRate: rate > 0 ? rate : DEFAULT_ASSUMPTIONS.hourlyRate, minutes };
}

export async function setAssumptions(accountId: string, a: Assumptions) {
  await setSetting(accountId, 'impactHourlyRate', String(a.hourlyRate));
  await setSetting(accountId, 'impactMinutes', JSON.stringify(a.minutes));
}

interface StepLike { type: string; status: string; output?: Record<string, any> }
interface RunRow {
  id: string; status: string; workflow_id: string | null; agent_id: string | null; started_by: string | null; name: string | null;
  steps: StepLike[] | null; trace: { tool?: string; ok?: boolean }[] | null; cost: number; created_at: Date; decided_at: Date | null; sid: string | null;
}

/** What one agent run did. Pure; tested. */
export function countSteps(steps: StepLike[]) {
  let changes = 0, aiSteps = 0, repliesSent = 0, approved = 0, rejected = 0;
  for (const s of steps ?? []) {
    if (s.status !== 'ok') continue;
    const o = s.output ?? {};
    if (o.wouldDo || o.skipped) continue;
    if (s.type === 'logic.approval') { if (o.approved === true) approved++; else if (o.approved === false) rejected++; continue; }
    if (s.type === 'sf.emailReply') { if (o.sent === true) repliesSent++; continue; }
    if (s.type.startsWith('ai.')) aiSteps++;
    else if (WRITE_NODE_TYPES.includes(s.type)) changes++;
  }
  return { changes, aiSteps, repliesSent, approved, rejected };
}

const day = (d: Date) => new Date(d).toISOString().slice(0, 10);

async function window(tenantId: string, from: Date, to: Date, a: Assumptions) {
  const { rows } = await pool.query(
    `select r.id, r.status, r.workflow_id, r.agent_id, r.started_by, coalesce(w.name, ag.name) as name, r.steps, r.trace,
            r.cost_usd::float as cost, r.created_at, r.decided_at, r.input->>'sessionId' as sid
     from runs r left join workflows w on w.id = r.workflow_id left join agents ag on ag.id = r.agent_id
     where r.tenant_id=$1 and r.created_at >= $2 and r.created_at < $3 and coalesce(r.started_by, '') not like 'test:%' order by r.created_at limit 50000`, [tenantId, from, to]);
  const sug = (await pool.query(
    `select kind, status from suggestions where tenant_id=$1 and created_at >= $2 and created_at < $3`, [tenantId, from, to])).rows as { kind: string; status: string }[];

  const m = a.minutes;
  const t = { runs: 0, ok: 0, failed: 0, waiting: 0, changes: 0, aiSteps: 0, repliesSent: 0, answers: 0, approved: 0, rejected: 0, agentCost: 0, otherCost: 0, minutes: 0 };
  const sessions = new Map<string, boolean>(); // website conversation -> handed to a person
  const agents = new Map<string, { id: string; name: string; kind: 'agent' | 'assistant'; runs: number; ok: number; changes: number; minutes: number; cost: number }>();
  const daily = new Map<string, { runs: number; minutes: number }>();
  const decisionMinutes: number[] = [];

  for (const r of rows as RunRow[]) {
    const kind = r.workflow_id ? 'agent' : r.agent_id ? (['website', 'sms', 'whatsapp'].includes(r.started_by ?? '') ? 'website' : 'assistant') : 'other';
    if (kind === 'other') { t.otherCost += r.cost; continue; }
    t.runs++; t.agentCost += r.cost;
    if (r.status === 'done') t.ok++; else if (r.status === 'error') t.failed++; else if (r.status === 'waiting' || r.status === 'sleeping') t.waiting++;
    let minutes = 0;
    if (kind === 'agent') {
      const c = countSteps(r.steps ?? []);
      t.changes += c.changes; t.aiSteps += c.aiSteps; t.repliesSent += c.repliesSent; t.approved += c.approved; t.rejected += c.rejected;
      minutes = c.changes * m.change + c.aiSteps * m.aiStep + c.repliesSent * m.replySent;
      if (r.decided_at) decisionMinutes.push((new Date(r.decided_at).getTime() - new Date(r.created_at).getTime()) / 60_000);
    } else if (kind === 'assistant') {
      if (r.status === 'done') { t.answers++; minutes = m.answer; }
    } else {
      const handed = (r.trace ?? []).some((x) => x.tool === 'talk_to_person' && x.ok);
      const key = r.sid ?? r.id;
      sessions.set(key, (sessions.get(key) ?? false) || handed);
    }
    t.minutes += minutes;
    const d = daily.get(day(r.created_at)) ?? { runs: 0, minutes: 0 };
    d.runs++; d.minutes += minutes;
    daily.set(day(r.created_at), d);
    if (kind !== 'website') {
      const id = (r.workflow_id ?? r.agent_id)!;
      const g = agents.get(id) ?? { id, name: r.name ?? 'Agent', kind: kind === 'agent' ? 'agent' : 'assistant', runs: 0, ok: 0, changes: 0, minutes: 0, cost: 0 };
      g.runs++; if (r.status === 'done') g.ok++; g.minutes += minutes; g.cost += r.cost;
      if (kind === 'agent') g.changes += countSteps(r.steps ?? []).changes;
      agents.set(id, g);
    }
  }
  // Website chats: each conversation solved without a person saves a person's chat.
  const conversations = sessions.size;
  const handedOff = [...sessions.values()].filter(Boolean).length;
  t.minutes += (conversations - handedOff) * m.chat;
  // Suggestions a person used (sent the reply or marked it helpful).
  const used = sug.filter((s) => s.status === 'sent' || s.status === 'helpful').length;
  t.minutes += used * m.suggestionUsed;
  decisionMinutes.sort((x, y) => x - y);

  return {
    totals: t,
    website: { conversations, handedOff, resolvedRate: conversations ? (conversations - handedOff) / conversations : null },
    suggestions: {
      total: sug.length, used, helpful: sug.filter((s) => s.status === 'helpful').length, notHelpful: sug.filter((s) => s.status === 'not_helpful').length,
      repliesSuggested: sug.filter((s) => s.kind === 'email_reply').length, repliesSentByPeople: sug.filter((s) => s.kind === 'email_reply' && s.status === 'sent').length,
    },
    approvals: { approved: t.approved, rejected: t.rejected, medianMinutes: decisionMinutes.length ? Math.round(decisionMinutes[Math.floor(decisionMinutes.length / 2)]) : null },
    agents: [...agents.values()].sort((x, y) => y.minutes - x.minutes || y.runs - x.runs),
    daily,
  };
}

export async function impact(tenantId: string, accountId: string, days: number) {
  const a = await getAssumptions(accountId);
  const to = new Date();
  const from = new Date(to.getTime() - days * 86_400_000);
  const prevFrom = new Date(from.getTime() - days * 86_400_000);
  const [cur, prev] = await Promise.all([window(tenantId, from, to, a), window(tenantId, prevFrom, from, a)]);
  const value = (min: number) => (min / 60) * a.hourlyRate;
  const series: { date: string; runs: number; hours: number }[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = day(new Date(to.getTime() - i * 86_400_000));
    const x = cur.daily.get(d);
    series.push({ date: d, runs: x?.runs ?? 0, hours: +((x?.minutes ?? 0) / 60).toFixed(2) });
  }
  const cost = cur.totals.agentCost + cur.totals.otherCost;
  return {
    days, from: from.toISOString(), to: to.toISOString(), assumptions: a,
    hoursSaved: cur.totals.minutes / 60, valueUsd: value(cur.totals.minutes), costUsd: cost,
    roi: cost > 0 ? value(cur.totals.minutes) / cost : null,
    previous: { hoursSaved: prev.totals.minutes / 60, runs: prev.totals.runs, costUsd: prev.totals.agentCost + prev.totals.otherCost, changes: prev.totals.changes },
    runs: { total: cur.totals.runs, ok: cur.totals.ok, failed: cur.totals.failed, waiting: cur.totals.waiting },
    work: { changes: cur.totals.changes, aiSteps: cur.totals.aiSteps, repliesSent: cur.totals.repliesSent, answers: cur.totals.answers },
    cost: { agents: cur.totals.agentCost, other: cur.totals.otherCost, perRun: cur.totals.runs ? cur.totals.agentCost / cur.totals.runs : 0 },
    website: cur.website, suggestions: cur.suggestions, approvals: cur.approvals,
    agents: cur.agents.slice(0, 25).map((g) => ({ ...g, hours: g.minutes / 60, value: value(g.minutes) })),
    series,
  };
}
