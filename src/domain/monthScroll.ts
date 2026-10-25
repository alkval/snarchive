export type MonthBucket = { month: string; count: number };
export function monthAtFraction(months: readonly MonthBucket[], fraction: number): number {
  if (!months.length) return -1;
  const target = Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0)) * months.reduce((n, m) => n + m.count, 0);
  let sum = 0;
  for (let i = 0; i < months.length; i++) { sum += months[i]!.count; if (target < sum) return i; }
  return months.length - 1;
}
export function monthFraction(months: readonly MonthBucket[], month: string): number {
  const index = months.findIndex(item => item.month === month);
  if (index <= 0) return 0;
  if (index === months.length - 1) return 1;
  const total = months.reduce((n, m) => n + m.count, 0);
  return months.slice(0, index).reduce((n, m) => n + m.count, 0) / Math.max(1, total);
}
export function monthTitle(month: string): string {
  if (!month) return 'Unknown dates';
  return new Intl.DateTimeFormat(undefined, { month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${month}-01T00:00:00Z`));
}
