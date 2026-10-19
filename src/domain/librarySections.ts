export type DatedRow = { id: string; day: string | null; instant: string | null; dateConflict: number };
export type LibrarySection<T> = { key: string; group: 'conflict' | 'unknown' | string; rows: T[] };

/** Splits a page into runs of consecutive rows that share a date group (a day, 'unknown' or 'conflict').
 * Never reorders rows. Unknown and conflicting dates share one sort position and are ordered by ID, so they
 * can alternate; each run's key therefore includes its position and first row, never the group alone. */
export function librarySections<T extends DatedRow>(rows: T[]): LibrarySection<T>[] {
  const sections: LibrarySection<T>[] = [];
  for (const row of rows) {
    const group = row.dateConflict ? 'conflict' : row.day ?? row.instant?.slice(0, 10) ?? 'unknown';
    const last = sections[sections.length - 1];
    if (last && last.group === group) last.rows.push(row);
    else sections.push({ key: `${sections.length}:${group}:${row.id}`, group, rows: [row] });
  }
  return sections;
}
