import { matchesOnThisDay, validReferenceDay } from './onThisDay.ts';

export type LibraryFilters = { media: 'all' | 'photos' | 'videos'; favorites: boolean; month: string; onThisDay?: string };
export const defaultFilters: LibraryFilters = { media: 'all', favorites: false, month: '' };
export function validFilters(value: LibraryFilters): boolean {
  return ['all', 'photos', 'videos'].includes(value.media) && typeof value.favorites === 'boolean'
    && (value.month === '' || /^(?!0000)\d{4}-(0[1-9]|1[0-2])$/.test(value.month))
    && (value.onThisDay === undefined || value.onThisDay === '' || (value.month === '' && validReferenceDay(value.onThisDay)));
}
/** Whether a row belongs to the filtered library, by the same rules as the grid's query. */
export function matchesFilters(row: { photos: number; videos: number; favorite: number; day: string | null; dateConflict: number }, filters: LibraryFilters): boolean {
  if (filters.media === 'photos' && !(row.photos > 0)) return false;
  if (filters.media === 'videos' && !(row.videos > 0)) return false;
  if (filters.favorites && row.favorite !== 1) return false;
  if (filters.onThisDay && (row.dateConflict !== 0 || !matchesOnThisDay(row.day, filters.onThisDay))) return false;
  return filters.month === '' || (row.dateConflict === 0 && row.day?.slice(0, 7) === filters.month);
}
