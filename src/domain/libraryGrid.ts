import { defaultFilters, matchesFilters, type LibraryFilters } from './libraryFilters.ts';
import { emptyPageFallback, patchFavorites } from './gridReturn.ts';
import { keyOf, type MemorySequence, type SequenceKey } from './memoryNavigation.ts';
import { validReferenceDay } from './onThisDay.ts';

export type GridRow = { id: string; sortDay: string; sortTime: string; photos: number; videos: number; favorite: number; day: string | null; dateConflict: number };
/** Reads up to 31 rows after `cursor` (30 to show, one to know whether a next page exists). */
export type FetchPage<T> = (cursor: SequenceKey | null, filters: LibraryFilters) => Promise<T[]>;
/** Reads the one row just before `key`, to start a page at the memory with that key. */
export type FetchBefore<T> = (key: SequenceKey, filters: LibraryFilters) => Promise<T[]>;

/** The grid's page, filters and history, kept apart from React so the timing between page reads and favourite saves
 * can be tested.
 *
 * Favourite saves can finish at any time: while a page read is in flight, after the viewer that started them has
 * closed, or before the browser renders again. Every completed save is recorded here (`saved`), whatever opened it,
 * and the visible rows are always the page as read with those saves applied. So a page read that started before a
 * save finished can never bring back the state the save replaced, and a save never depends on which viewer is open.
 * The record holds only this browser's completed writes: it is what the library now stores for those memories.
 *
 * Applying the record can hide rows but never add them: a memory favourited after a Favourites read was taken is not
 * in that read. So a Favourites read during which any save completed is read again, and so is the page shown when a
 * save adds a Favourites member it lacks. Emptiness is judged on the 30 rows shown, never on the lookahead row. */
export class LibraryGrid<T extends GridRow> {
  private readonly pages = new Map<string, T[]>();
  private readonly removed = new Set<string>();
  filters: LibraryFilters = { ...defaultFilters };
  cursor: SequenceKey | null = null;
  history: (SequenceKey | null)[] = [];
  loading = true;
  failed = false;
  private page: T[] = [];
  private more = false;
  private saved = new Map<string, boolean>();
  private request = 0;
  /** Completed saves so far; a read compares it before and after to know whether one finished meanwhile. */
  private saves = 0;
  private listeners = new Set<() => void>();
  private readonly fetchPage: FetchPage<T>;
  private readonly fetchBefore: FetchBefore<T>;

  static readonly REREADS = 3;

  constructor(fetchPage: FetchPage<T>, fetchBefore: FetchBefore<T>) { this.fetchPage = fetchPage; this.fetchBefore = fetchBefore; }

  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private changed() { for (const listener of [...this.listeners]) listener(); }

  /** The page as read, before saves are applied; its identity changes only when a new page is read. */
  get pageRows(): readonly T[] { return this.page; }
  /** What the grid shows: the page with every completed favourite save applied (hearts, and Favourites membership). */
  get rows(): T[] { return patchFavorites(this.page, this.saved, this.filters).filter(row => !this.removed.has(row.id)); }
  /** Virtualized scrolling keeps row metadata, never decoded images, for pages already visited. */
  get feedRows(): T[] {
    const seen = new Set<string>();
    return [...this.pages.values()].flatMap(page => patchFavorites(page, this.saved, this.filters))
      .filter(row => { if (seen.has(row.id) || this.removed.has(row.id)) return false; seen.add(row.id); return true; });
  }
  get hasNext(): boolean { return this.more; }

  /** Reads the current page. Superseded reads (a newer read, filter or page change started meanwhile) are ignored. */
  async load(): Promise<void> {
    const request = ++this.request;
    this.loading = true; this.failed = false; this.page = []; this.more = false; this.changed();
    for (let rereads = 0; ; ) {
      const saves = this.saves;
      let page: T[];
      try { page = await this.fetchPage(this.cursor, this.filters); }
      catch { if (request === this.request) { this.loading = false; this.failed = true; this.changed(); } return; }
      if (request !== this.request) return;
      // Re-reads are bounded (each save completes once); after REREADS the record still hides removed rows.
      const again = rereads < LibraryGrid.REREADS;
      // A save finished while this Favourites read was in flight: it may have added a member the read excluded.
      if (again && this.filters.favorites && this.saves !== saves) { rereads++; continue; }
      // The rows that would be shown are all gone after saves: read again rather than show an empty page.
      const shown = page.slice(0, 30);
      if (again && shown.length && !patchFavorites(shown, this.saved, this.filters).some(row => !this.removed.has(row.id))) { rereads++; continue; }
      const fallback = page.length ? null : emptyPageFallback(this.cursor, this.history);
      if (fallback) { this.cursor = fallback.cursor; this.history = fallback.history; continue; }
      this.page = page.slice(0, 30); this.pages.set(JSON.stringify(this.cursor), this.page);
      this.more = page.length > 30; this.loading = false; this.changed();
      return;
    }
  }

  /** A favourite save completed (from any viewer, open or closed). If it empties the page shown, the page is read
   * again: an empty first page then shows later matches; an empty later page steps back. */
  favoriteSaved(id: string, favorite: boolean): void {
    this.saved.set(id, favorite); this.saves++;
    this.changed();
    if (this.loading) return; // The read in flight sees the new count and reads again if it matters.
    const emptied = this.page.length > 0 && !this.rows.length;
    const added = this.filters.favorites && favorite && !this.page.some(row => row.id === id);
    if (emptied || added) void this.load();
  }

  memoryDeleted(id: string): void { this.removed.add(id); this.saves++; this.changed(); if (!this.loading && !this.rows.length) void this.load(); }
  refresh(): Promise<void> { this.pages.clear(); this.removed.clear(); this.saved.clear(); this.cursor = null; this.history = []; return this.load(); }
  setFilters(filters: LibraryFilters): Promise<void> { this.filters = { ...filters }; return this.refresh(); }
  /** Refresh only an active On this day scope. The UI defers this while fullscreen is open, then calls it on Back. */
  refreshDay(day: string): Promise<void> | null {
    if (!validReferenceDay(day)) throw new Error('invalid-reference-day');
    if (!this.filters.onThisDay || this.filters.onThisDay === day) return null;
    return this.setFilters({ ...this.filters, month: '', onThisDay: day });
  }
  retry(): Promise<void> { return this.load(); }
  nextPage(): Promise<void> {
    const last = this.page[this.page.length - 1];
    if (!this.more || !last) return Promise.resolve();
    this.history = [...this.history, this.cursor]; this.cursor = keyOf(last); // A key, valid even if saves hid that row.
    return this.load();
  }
  previousPage(): Promise<void> {
    if (!this.history.length) return Promise.resolve();
    this.cursor = this.history[this.history.length - 1]!; this.history = this.history.slice(0, -1);
    return this.load();
  }

  /** The continuous grid stays at its original scroll position on Back. Extend towards the last viewed memory,
   * keeping every earlier page reachable. Bound the work even after thousands of viewer moves or a deleted anchor;
   * scrolling can fetch the rest normally. A newer read/filter/refresh supersedes this extension. */
  async extendFeedTo(last: GridRow): Promise<void> {
    for (let pages = 0; pages < 4; pages++) {
      if (this.loading || this.failed || !this.more || this.feedRows.some(row => row.id === last.id)) return;
      const expected = this.request + 1;
      await this.nextPage();
      if (this.request !== expected) return;
    }
  }

  /** Legacy paged-grid return. The continuous browser uses extendFeedTo instead.
   * Back from the viewer on `last`. On this page: the page stays (scroll position too); saves are already applied,
   * and an emptied page was already re-read. Elsewhere: a page starting at `last` opens, and Previous returns here. */
  async closedViewer(last: GridRow): Promise<'kept' | 'jumped'> {
    if (this.page.some(row => row.id === last.id)) return 'kept';
    const request = ++this.request, from = this.cursor, past = this.history;
    this.pages.clear();
    let before: T[];
    try { before = await this.fetchBefore(keyOf(last), this.filters); }
    catch { if (request === this.request) await this.load(); return 'jumped'; }
    if (request !== this.request) return 'jumped';
    const start = before[0] ? keyOf(before[0]) : null;
    this.history = start ? [...past, from] : []; this.cursor = start;
    await this.load();
    return 'jumped';
  }
}

/** What the library browser runs when a favourite save completes: the grid always records it, whichever viewer
 * started it and whether or not one is still open; the open sequence (read at call time, so a viewer that just
 * closed is fine either way) updates its loaded row. */
export function favoriteSavedHandler<T extends GridRow>(grid: LibraryGrid<T>, openSequence: () => MemorySequence<T> | null) {
  return (id: string, favorite: boolean) => {
    grid.favoriteSaved(id, favorite);
    const open = openSequence(), loaded = open?.row(id);
    if (open && loaded) { const updated = { ...loaded, favorite: favorite ? 1 : 0 }; open.update(updated, matchesFilters(updated, grid.filters)); }
  };
}
