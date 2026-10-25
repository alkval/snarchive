/** One thumbnail read at a time, even when a new viewport arrives during a read. Only URI strings (or a cached
 * failure) are retained. Current viewport entries are pinned; revisiting an overlapping window does no work. */
export class ThumbnailWindow<T extends { id: string }> {
  private rows: readonly T[] = [];
  private cache = new Map<string, string | null>();
  private running = false;
  private generation = 0;
  private listeners = new Set<() => void>();
  private readonly load: (row: T) => Promise<string | null>;
  private readonly capacity: number;
  constructor(load: (row: T) => Promise<string | null>, capacity = 128) {
    if (capacity < 60) throw new Error('thumbnail-window-too-small');
    this.load = load; this.capacity = capacity;
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener); return () => { this.listeners.delete(listener); };
  }
  get(id: string): string | null | undefined { return this.cache.get(id); }
  setRows(rows: readonly T[]): void {
    this.rows = rows.slice(0, 60);
    for (const row of this.rows) {
      if (!this.cache.has(row.id)) continue;
      const uri = this.cache.get(row.id)!;
      this.cache.delete(row.id); this.cache.set(row.id, uri);
    }
    this.trim(); void this.pump();
  }
  /** Imports/restores may change a memory's objects; discard old results, including a read still in flight. */
  reset(): void { this.generation++; this.cache.clear(); void this.pump(); }
  failed(id: string, uri: string): void {
    if (this.cache.get(id) !== uri) return;
    this.cache.set(id, null); this.changed();
  }
  private changed(): void { for (const listener of this.listeners) listener(); }
  private trim(): void {
    const pinned = new Set(this.rows.map(row => row.id));
    for (const id of this.cache.keys()) {
      if (this.cache.size <= this.capacity) break;
      if (!pinned.has(id)) this.cache.delete(id);
    }
  }
  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (;;) {
        const row = this.rows.find(item => !this.cache.has(item.id));
        if (!row) return;
        const generation = this.generation;
        let uri: string | null = null;
        try { uri = await this.load(row); } catch { /* A failure remains a placeholder until an explicit refresh. */ }
        if (generation !== this.generation) continue;
        this.cache.set(row.id, uri); this.trim();
        if (this.rows.some(item => item.id === row.id)) this.changed();
      }
    } finally { this.running = false; }
  }
}

/** SectionList may briefly report no visible cells while filling its render window. Keep the last thumbnail
 * window in that case instead of bouncing back to the first page. Header-only and stale callbacks do the same. */
export function visibleThumbnailRows<T extends { id: string }>(rows: readonly T[], visibleIds: readonly string[]): T[] | null {
  const ids = new Set(visibleIds);
  const first = rows.findIndex(row => ids.has(row.id));
  if (first < 0) return null;
  return rows.slice(Math.max(0, first - 9), Math.min(rows.length, first + 45));
}
