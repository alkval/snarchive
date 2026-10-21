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

/** A page read back empty although it is not the first: step back to the page before it (whose rows come earlier),
 * keeping the filters. Null when the first page is empty: the filtered library really is empty. */
export function emptyPageFallback<C>(cursor: C | null, history: readonly (C | null)[]): { cursor: C | null; history: (C | null)[] } | null {
  if (cursor === null) return null;
  return { cursor: history.length ? history[history.length - 1]! : null, history: history.slice(0, -1) };
}
