import type { SqlConnection } from './previewStore.ts';

export const DETAIL_SECTIONS = ['originals', 'dates', 'sources'] as const;
export type DetailSection = typeof DETAIL_SECTIONS[number];
export type DetailKey = { key1: string; key2: string | number };
export type DetailRow = DetailKey & (
  | { section: 'originals'; role: string; hash: string; path: string; bytes: number }
  | { section: 'dates'; kind: string; value: string; day: string }
  | { section: 'sources'; kind: string; path: string; role: string; state: string; hash: string | null }
);
export const DETAILS_PAGE_SIZE = 20;

/** Indexed, read-only evidence queries. One extra row establishes the next edge; no plan JSON or file is read.
 * The cursor is a key, so it need not still be a member. Reverse reads use exactly the reversed order. */
export async function readMemoryDetails(db: SqlConnection, id: string, section: DetailSection,
  anchor: DetailKey | null, direction: 'next' | 'previous'): Promise<DetailRow[]> {
  const specs = {
    originals: { from: 'memory_objects m JOIN stored_objects o ON o.hash=m.object_hash', id: 'm.memory_id',
      first: 'm.role', second: 'm.object_hash', fields: 'm.role,o.hash,o.relative_path AS path,o.bytes' },
    dates: { from: 'library_dates d', id: 'd.memory_id', first: 'd.kind', second: 'd.value', fields: 'd.kind,d.value,d.day' },
    sources: { from: 'import_items i JOIN import_jobs j ON j.hash=i.job_hash', id: 'i.memory_id',
      first: 'i.job_hash', second: 'i.ordinal', fields: 'j.kind,i.relative_path AS path,i.role,i.state,i.object_hash AS hash' },
  };
  if (!Object.hasOwn(specs, section)) throw new Error('invalid-details-section');
  const s = specs[section], reverse = direction === 'previous', order = reverse ? 'DESC' : 'ASC', op = reverse ? '<' : '>';
  return db.getAllAsync<DetailRow>(`SELECT '${section}' AS section,${s.first} AS key1,${s.second} AS key2,${s.fields}
    FROM ${s.from} WHERE ${s.id}=? AND (? IS NULL OR ${s.first}${op}? OR (${s.first}=? AND ${s.second}${op}?))
    ORDER BY ${s.first} ${order},${s.second} ${order} LIMIT ${DETAILS_PAGE_SIZE + 1}`,
  id, anchor?.key1 ?? null, anchor?.key1 ?? null, anchor?.key1 ?? null, anchor?.key2 ?? null);
}
