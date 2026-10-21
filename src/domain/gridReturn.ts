import { matchesFilters, type LibraryFilters } from './libraryFilters.ts';

type GridRow = { id: string; photos: number; videos: number; favorite: number; day: string | null; dateConflict: number };

/** Applies favourite changes made in the viewer to a grid page in place: updates hearts, and drops rows that no
 * longer match the filters (a Favourites page losing its unfavourited memories). */
export function patchFavorites<T extends GridRow>(rows: readonly T[], changes: ReadonlyMap<string, boolean>, filters: LibraryFilters): T[] {
  return rows.flatMap(row => {
    const favorite = changes.get(row.id);
    if (favorite === undefined) return [row];
    const updated = { ...row, favorite: favorite ? 1 : 0 };
    return matchesFilters(updated, filters) ? [updated] : [];
  });
}

/** What the grid does when the viewer closes on `lastId`:
 * keep — the memory is on this page: the page stays as it was (scroll position too), patched with favourite changes;
 * reload — patching would leave the page empty, but other matches may exist before or after it: read it again;
 * jump — the memory is on another page: open a page starting there. */
export function returnToGrid<T extends GridRow>(rows: readonly T[], lastId: string, changes: ReadonlyMap<string, boolean>, filters: LibraryFilters):
  { kind: 'keep'; rows: T[] } | { kind: 'reload' } | { kind: 'jump' } {
  if (!rows.some(row => row.id === lastId)) return { kind: 'jump' };
  if (!changes.size) return { kind: 'keep', rows: [...rows] };
  const patched = patchFavorites(rows, changes, filters);
  return patched.length ? { kind: 'keep', rows: patched } : { kind: 'reload' };
}

/** A page read back empty although it is not the first: step back to the page before it (whose rows come earlier),
 * keeping the filters. Null when the first page is empty: the filtered library really is empty. */
export function emptyPageFallback<C>(cursor: C | null, history: readonly (C | null)[]): { cursor: C | null; history: (C | null)[] } | null {
  if (cursor === null) return null;
  return { cursor: history.length ? history[history.length - 1]! : null, history: history.slice(0, -1) };
}
