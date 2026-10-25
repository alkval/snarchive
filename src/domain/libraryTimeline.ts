import { defaultFilters, type LibraryFilters } from './libraryFilters.ts';
import { validReferenceDay } from './onThisDay.ts';

export type TimelineEntry = { id: string; group: string };
type DisplayRow = { id: string; favorite: number };
/** A complete, small position index; only nearby display facts are read, and no images are held here. Index and
 * row generations prevent delayed reads from reviving old filters, deleted memories or completed favourite writes. */
export class LibraryTimeline<T extends DisplayRow> {
  entries: readonly TimelineEntry[] = [];
  filters: LibraryFilters = { ...defaultFilters };
  loading = true;
  failed = false;
  rowsFailed = false;
  revision = 0;
  private generation = 0;
  private saves = 0;
  private saved = new Map<string, boolean>();
  private removed = new Set<string>();
  private cache = new Map<string, T>();
  private positions = new Map<string, number>();
  private wanted: string[] = [];
  private unavailable = new Set<string>();
  private running = false;
  private disposed = false;
  private listeners = new Set<() => void>();
  private readonly readIndex: (filters: LibraryFilters) => Promise<TimelineEntry[]>;
  private readonly readRows: (ids: readonly string[]) => Promise<T[]>;
  constructor(readIndex: (filters: LibraryFilters) => Promise<TimelineEntry[]>, readRows: (ids: readonly string[]) => Promise<T[]>) {
    this.readIndex = readIndex; this.readRows = readRows;
  }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private changed() { for (const listener of this.listeners) listener(); }
  dispose() { this.disposed = true; this.generation++; this.wanted = []; this.listeners.clear(); }
  row(id: string): T | undefined { return this.cache.get(id); }
  get visibleRows(): T[] { return this.wanted.flatMap(id => this.cache.has(id) ? [this.cache.get(id)!] : []); }
  get cachedRows(): number { return this.cache.size; }
  async load(): Promise<void> {
    if (this.disposed) return;
    const generation = ++this.generation, filters = { ...this.filters };
    this.loading = true; this.failed = false; this.changed();
    try {
      let entries: TimelineEntry[] = [];
      for (let attempt = 0; ; attempt++) {
        const saves = this.saves;
        entries = await this.readIndex(filters);
        if (this.disposed || generation !== this.generation) return;
        if (!filters.favorites || this.saves === saves || attempt === 3) break;
      }
      this.entries = entries.filter(entry => !this.removed.has(entry.id) && (!filters.favorites || this.saved.get(entry.id) !== false));
      this.positions = new Map(this.entries.map((entry, index) => [entry.id, index]));
      this.cache.clear(); this.unavailable.clear(); this.rowsFailed = false;
      this.wanted = this.wanted.filter(id => this.positions.has(id));
      if (!this.wanted.length) this.wanted = this.entries.slice(0, 45).map(entry => entry.id);
      this.revision++; this.loading = false; this.changed(); void this.pump();
    } catch {
      if (generation === this.generation && !this.disposed) { this.loading = false; this.failed = true; this.changed(); }
    }
  }
  refresh(): Promise<void> { this.saved.clear(); this.removed.clear(); return this.load(); }
  setFilters(filters: LibraryFilters): Promise<void> {
    this.filters = { ...filters }; this.entries = []; this.positions.clear(); this.wanted = []; this.cache.clear();
    return this.load();
  }
  refreshDay(day: string): Promise<void> | null {
    if (!validReferenceDay(day)) throw new Error('invalid-reference-day');
    if (!this.filters.onThisDay || this.filters.onThisDay === day) return null;
    return this.setFilters({ ...this.filters, month: '', onThisDay: day });
  }
  favoriteSaved(id: string, favorite: boolean): void {
    if (this.disposed) return;
    this.saved.set(id, favorite); this.saves++;
    const row = this.cache.get(id); if (row) this.cache.set(id, { ...row, favorite: favorite ? 1 : 0 });
    this.changed();
    if (this.filters.favorites && !this.loading) void this.load();
  }
  memoryDeleted(id: string): void { this.removed.add(id); this.saves++; this.cache.delete(id); void this.load(); }
  /** Header-only/empty reports leave the last useful window alone. Work follows the latest viewport, not every
   * intermediate date crossed during a fast drag. A single read runs at a time, with at most 60 requested IDs. */
  show(ids: readonly string[]): void {
    const at = ids.map(id => this.positions.get(id)).find(index => index !== undefined);
    if (at === undefined) return;
    this.wanted = this.entries.slice(Math.max(0, at - 9), at + 45).map(entry => entry.id);
    for (const id of this.wanted) {
      const row = this.cache.get(id); if (row) { this.cache.delete(id); this.cache.set(id, row); }
    }
    this.trim(); void this.pump();
  }
  retryRows(): void { this.unavailable.clear(); this.rowsFailed = false; this.changed(); void this.pump(); }
  private trim() {
    const pinned = new Set(this.wanted);
    for (const id of this.cache.keys()) { if (this.cache.size <= 180) break; if (!pinned.has(id)) this.cache.delete(id); }
  }
  private async pump(): Promise<void> {
    if (this.running || this.loading || this.disposed) return;
    this.running = true;
    try {
      while (!this.loading && !this.disposed) {
        const ids = this.wanted.filter(id => !this.cache.has(id) && !this.unavailable.has(id)).slice(0, 60);
        if (!ids.length) return;
        const generation = this.generation;
        try {
          const rows = await this.readRows(ids);
          if (generation !== this.generation) continue;
          const byId = new Map(rows.map(row => [row.id, row]));
          for (const id of ids) {
            const row = byId.get(id);
            if (!row) { this.unavailable.add(id); this.rowsFailed = true; continue; }
            const favorite = this.saved.get(id);
            this.cache.set(id, favorite === undefined ? row : { ...row, favorite: favorite ? 1 : 0 });
          }
          this.trim(); this.changed();
        } catch {
          if (generation !== this.generation) continue;
          for (const id of ids) this.unavailable.add(id);
          this.rowsFailed = true; this.changed();
        }
      }
    } finally { this.running = false; }
  }
}
