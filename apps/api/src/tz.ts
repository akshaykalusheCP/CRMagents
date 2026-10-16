// Time zone arithmetic without a library (Intl knows every IANA zone).

/** Minutes the time zone is ahead of UTC at that moment (e.g. 330 for Asia/Kolkata). */
export function tzOffset(at: Date, tz: string): number {
  try {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
      .formatToParts(at).filter((x) => x.type !== 'literal').map((x) => [x.type, Number(x.value)]));
    return Math.round((Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - at.getTime()) / 60_000);
  } catch {
    return 0; // unknown zone: UTC
  }
}

