export type LibraryFilters = { media: 'all' | 'photos' | 'videos'; favorites: boolean; month: string };
export const defaultFilters: LibraryFilters = { media: 'all', favorites: false, month: '' };
export function validFilters(value: LibraryFilters): boolean {
  return ['all', 'photos', 'videos'].includes(value.media) && typeof value.favorites === 'boolean'
    && (value.month === '' || /^(?!0000)\d{4}-(0[1-9]|1[0-2])$/.test(value.month));
}
