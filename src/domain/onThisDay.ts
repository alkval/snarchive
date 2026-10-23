/** A complete UTC calendar day, including the year that separates past years from this year. */
export function validReferenceDay(value: unknown): value is string {
  if (typeof value !== 'string' || !/^(?!0000)\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function utcDay(now = new Date()): string {
  const day = now.toISOString().slice(0, 10);
  if (!validReferenceDay(day)) throw new Error('invalid-reference-day');
  return day;
}

/** Matches only this month/day in strictly earlier years. February 29 has no substitute date. */
export function matchesOnThisDay(day: string | null, reference: string): boolean {
  return day !== null && day.slice(0, 4) < reference.slice(0, 4) && day.slice(5) === reference.slice(5);
}

type Schedule = (run: () => void, delay: number) => () => void;
/** One timer at the next UTC midnight. The UI also calls refresh on foreground; stop prevents late callbacks.
 * Injected clock/timer keep boundary tests independent of the machine's date and timezone. */
export function watchUTCDate(onDay: (day: string) => void, now = () => new Date(), schedule: Schedule = (run, delay) => {
  const timer = setTimeout(run, delay);
  return () => clearTimeout(timer);
}) {
  let stopped = false;
  let cancel = () => {};
  const refresh = () => {
    if (stopped) return;
    cancel();
    const instant = now(), day = utcDay(instant);
    onDay(day);
    const delay = new Date(`${day}T00:00:00.000Z`).getTime() + 86_400_000 - instant.getTime();
    cancel = schedule(refresh, Math.max(1, delay));
  };
  refresh();
  return { refresh, stop: () => { stopped = true; cancel(); } };
}
