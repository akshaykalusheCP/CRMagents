import { tzOffset } from '../tz.js';
import type { SalesforceClient } from './client.js';

// Meetings on the calendar Salesforce already has: Event records (which Outlook / Google sync fills in for most
// teams). Free times are working hours in each owner's own time zone, minus their events; booking creates an
// Event owned by them, linked to the lead or contact, after checking the time is still free.

export interface SlotOptions {
  from: Date;
  days: number;
  durationMin: number;
  tz: string;
  workStart?: number; // hour, local
  workEnd?: number;
  stepMin?: number;
  max?: number;
  perDay?: number;
  noticeMin?: number;
}
export interface Busy { start: number; end: number }

const ID = /^[a-zA-Z0-9]{15,18}$/;
const EMAIL = /^[^@\s'"\\]+@[^@\s'"\\]+\.[^@\s'"\\]+$/;

/** Calendar date and weekday (0 = Sunday) of a moment in a time zone. */
function localDay(at: Date, tz: string) {
  const local = new Date(at.getTime() + tzOffset(at, tz) * 60_000);
  return { y: local.getUTCFullYear(), m: local.getUTCMonth(), d: local.getUTCDate(), wd: local.getUTCDay() };
}

/** The UTC moment of a local wall-clock time in a time zone. */
function atLocal(y: number, m: number, d: number, minutes: number, tz: string): Date {
  const guess = Date.UTC(y, m, d, 0, minutes);
  const off = tzOffset(new Date(guess), tz);
  const t = guess - off * 60_000;
  // Correct once more across a daylight-saving change.
  const off2 = tzOffset(new Date(t), tz);
  return new Date(off2 === off ? t : guess - off2 * 60_000);
}

/** Free starting times: weekdays, working hours, not overlapping anything busy. Pure; tested. */
export function computeSlots(busy: Busy[], o: SlotOptions): Date[] {
  const ws = (o.workStart ?? 9) * 60, we = (o.workEnd ?? 17) * 60, step = o.stepMin ?? 30;
  const max = o.max ?? 6, perDay = o.perDay ?? 2, earliest = o.from.getTime() + (o.noticeMin ?? 120) * 60_000;
  const out: Date[] = [];
  for (let i = 0; i <= o.days && out.length < max; i++) {
    const { y, m, d, wd } = localDay(new Date(o.from.getTime() + i * 86_400_000), o.tz);
    if (wd === 0 || wd === 6) continue;
    let today = 0;
    for (let min = ws; min + o.durationMin <= we && today < perDay && out.length < max; min += step) {
      const s = atLocal(y, m, d, min, o.tz);
      const e = s.getTime() + o.durationMin * 60_000;
      if (s.getTime() < earliest) continue;
      if (busy.some((b) => b.start < e && b.end > s.getTime())) continue;
      // Spread the day's choices: after one slot, the next is at least two hours later.
      if (today && out.length && s.getTime() - out[out.length - 1].getTime() < 120 * 60_000) continue;
      out.push(s);
      today++;
    }
  }
  return out;
}

/** "Tue 21 Oct, 10:00" in a time zone. */
export function slotLabel(at: Date, tz: string) {
  try {
    return new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at).replace(/,? (\d\d:\d\d)$/, ', $1');
  } catch { return at.toISOString(); }
}

export interface Owner { id: string; name: string; email: string; tz: string }

/** Salesforce users by Id or email (active only). */
export async function findOwners(sf: SalesforceClient, who: string[]): Promise<Owner[]> {
  const ids = who.filter((w) => ID.test(w)).map((w) => `'${w}'`);
  const emails = who.filter((w) => EMAIL.test(w)).map((w) => `'${w.toLowerCase().replace(/'/g, '')}'`);
  if (!ids.length && !emails.length) return [];
  const where = [ids.length ? `Id IN (${ids.join(',')})` : '', emails.length ? `Email IN (${emails.join(',')})` : ''].filter(Boolean).join(' OR ');
  const r = await sf.query(`SELECT Id, Name, Email, TimeZoneSidKey FROM User WHERE IsActive = true AND (${where}) LIMIT 20`);
  return r.records.map((u: any) => ({ id: u.Id, name: u.Name, email: u.Email, tz: u.TimeZoneSidKey || 'UTC' }));
}

async function busyOf(sf: SalesforceClient, ownerIds: string[], from: Date, to: Date): Promise<Map<string, Busy[]>> {
  const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const r = await sf.query(
    `SELECT OwnerId, StartDateTime, EndDateTime, IsAllDayEvent, ActivityDate FROM Event
     WHERE OwnerId IN (${ownerIds.map((i) => `'${i}'`).join(',')}) AND ShowAs != 'Free'
       AND ((StartDateTime < ${iso(to)} AND EndDateTime > ${iso(from)}) OR (IsAllDayEvent = true AND ActivityDate >= ${iso(from).slice(0, 10)} AND ActivityDate <= ${iso(to).slice(0, 10)}))
     LIMIT 2000`);
  const out = new Map<string, Busy[]>();
  for (const e of r.records as any[]) {
    const list = out.get(e.OwnerId) ?? [];
    if (e.IsAllDayEvent && e.ActivityDate) {
      const s = Date.parse(`${e.ActivityDate}T00:00:00Z`) - 14 * 3600_000; // whole day in any zone
      list.push({ start: s, end: s + 52 * 3600_000 });
    } else list.push({ start: Date.parse(e.StartDateTime), end: Date.parse(e.EndDateTime) });
    out.set(e.OwnerId, list);
  }
  return out;
}

export interface Slot { start: string; label: string; ownerId: string; ownerName: string; tz: string }

/** Next free times across one or more owners (round-robin: earliest free person first). */
export async function freeTimes(sf: SalesforceClient, owners: Owner[], o: { days?: number; durationMin?: number; max?: number } = {}): Promise<Slot[]> {
  if (!owners.length) throw new Error('No active Salesforce user found to book with.');
  const days = Math.min(Math.max(o.days ?? 7, 1), 30), durationMin = Math.min(Math.max(o.durationMin ?? 30, 15), 240), max = Math.min(o.max ?? 6, 12);
  const from = new Date();
  const busy = await busyOf(sf, owners.map((x) => x.id), from, new Date(from.getTime() + (days + 1) * 86_400_000));
  const all: Slot[] = [];
  for (const ow of owners) {
    for (const s of computeSlots(busy.get(ow.id) ?? [], { from, days, durationMin, tz: ow.tz, max })) {
      all.push({ start: s.toISOString(), label: `${slotLabel(s, ow.tz)} (${ow.tz})`, ownerId: ow.id, ownerName: ow.name, tz: ow.tz });
    }
  }
  // One owner per moment, earliest first.
  const seen = new Set<string>();
  return all.sort((a, b) => a.start.localeCompare(b.start)).filter((s) => !seen.has(s.start) && seen.add(s.start)).slice(0, max);
}

/** Create the meeting after checking the owner is still free then. */
export async function bookMeeting(sf: SalesforceClient, b: { ownerId: string; start: string; durationMin?: number; subject: string; whoId?: string; whatId?: string; description?: string; location?: string }) {
  const start = new Date(b.start);
  if (Number.isNaN(start.getTime())) throw new Error('Give the start time as an ISO date-time, e.g. 2026-10-21T10:00:00Z.');
  if (start.getTime() < Date.now() + 5 * 60_000) throw new Error('That time has passed. Find new times first.');
  if (!ID.test(b.ownerId)) throw new Error('Owner must be a Salesforce user Id.');
  const durationMin = Math.min(Math.max(b.durationMin ?? 30, 15), 480);
  const end = new Date(start.getTime() + durationMin * 60_000);
  const busy = (await busyOf(sf, [b.ownerId], start, end)).get(b.ownerId) ?? [];
  if (busy.some((x) => x.start < end.getTime() && x.end > start.getTime())) throw new Error('That time was just taken. Find new times and offer them again.');
  const fields: Record<string, unknown> = {
    OwnerId: b.ownerId, Subject: b.subject.slice(0, 255), StartDateTime: start.toISOString(), EndDateTime: end.toISOString(),
    ...(b.whoId && ID.test(b.whoId) ? { WhoId: b.whoId } : {}), ...(b.whatId && ID.test(b.whatId) ? { WhatId: b.whatId } : {}),
    ...(b.description ? { Description: b.description.slice(0, 32_000) } : {}), ...(b.location ? { Location: b.location.slice(0, 255) } : {}),
  };
  const r = await sf.createRecord('Event', fields);
  return { eventId: r.id, start: start.toISOString(), end: end.toISOString() };
}
