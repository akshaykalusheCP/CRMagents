import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computeSlots, slotLabel } from './meetings.js';

// Monday 2026-10-19 06:00 UTC = 11:30 in Kolkata.
const MON = new Date('2026-10-19T06:00:00Z');

test('meetings: free times are in working hours of the owner\'s zone, on weekdays, after the notice', () => {
  const s = computeSlots([], { from: MON, days: 6, durationMin: 30, tz: 'Asia/Kolkata', max: 20, perDay: 20, noticeMin: 120 });
  // First slot: 13:30 local (2 hours' notice from 11:30), i.e. 08:00 UTC.
  assert.equal(s[0].toISOString(), '2026-10-19T08:00:00.000Z');
  for (const x of s) {
    const local = new Date(x.getTime() + 330 * 60_000);
    const min = local.getUTCHours() * 60 + local.getUTCMinutes();
    assert.ok(min >= 9 * 60 && min + 30 <= 17 * 60, x.toISOString());
    assert.ok(![0, 6].includes(local.getUTCDay()), 'no weekends');
  }
  // Slots on the same day are at least two hours apart.
  assert.ok(s[1].getTime() - s[0].getTime() >= 120 * 60_000);
});

test('meetings: busy events are skipped and daylight saving is handled', () => {
  const busy = [{ start: Date.parse('2026-10-19T08:00:00Z'), end: Date.parse('2026-10-19T09:00:00Z') }];
  const s = computeSlots(busy, { from: MON, days: 0, durationMin: 30, tz: 'Asia/Kolkata', max: 5, perDay: 5 });
  assert.ok(s.every((x) => x.getTime() >= busy[0].end || x.getTime() + 30 * 60_000 <= busy[0].start));
  // New York switches to winter time on 2026-11-01: 9:00 local is 13:00 UTC before, 14:00 UTC after.
  const ny1 = computeSlots([], { from: new Date('2026-10-30T12:00:00Z'), days: 0, durationMin: 30, tz: 'America/New_York', max: 1, noticeMin: 0 });
  const ny2 = computeSlots([], { from: new Date('2026-11-02T12:00:00Z'), days: 0, durationMin: 30, tz: 'America/New_York', max: 1, noticeMin: 0 });
  assert.equal(ny1[0].toISOString(), '2026-10-30T13:00:00.000Z');
  assert.equal(ny2[0].toISOString(), '2026-11-02T14:00:00.000Z');
  assert.match(slotLabel(ny2[0], 'America/New_York'), /Mon 2 Nov, 09:00/);
});
