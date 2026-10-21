/** Previous/next navigation through the filtered library in the grid's order, without loading the whole library.
 *
 * A bounded window of rows is kept around the open memory. It starts as the grid page the memory was opened from;
 * when the open memory is the last loaded one in a direction, the next batch is fetched from that edge's sort key
 * (a strict cursor, so nothing repeats or is skipped across database pages). Rows beyond `keep` are dropped from the
 * far side and fetched again if needed. */
export type SequenceKey = { day: string; time: string; id: string };
export type SequenceRow = { id: string; sortDay: string; sortTime: string };
export type Direction = 'next' | 'previous';
/** Rows after (or before) the anchor in display order, nearest first, under the active filters. */
export type FetchAdjacent<T> = (anchor: SequenceKey, direction: Direction, limit: number) => Promise<T[]>;
/** ready: the neighbour is loaded. unknown: not loaded yet. loading. end: there is none. error: the last fetch failed. */
export type NeighbourState = 'ready' | 'unknown' | 'loading' | 'end' | 'error';
export type MoveResult = 'moved' | 'end' | 'error' | 'stale';

export const keyOf = (row: SequenceRow): SequenceKey => ({ day: row.sortDay, time: row.sortTime, id: row.id });

export class MemorySequence<T extends SequenceRow> {
  private rows: T[];
  private index: number;
  private leaving = false;
  private ended: Record<Direction, boolean> = { next: false, previous: false };
  private failed: Record<Direction, boolean> = { next: false, previous: false };
  private loads: Record<Direction, Promise<void> | null> = { next: null, previous: null };
  private listeners = new Set<() => void>();
  /** Fetches made, for tests and diagnostics. */
  fetches = 0;

  private readonly fetch: FetchAdjacent<T>;
  private readonly options: { batch: number; keep: number };

  constructor(rows: readonly T[], index: number, fetch: FetchAdjacent<T>, options = { batch: 20, keep: 60 }) {
    if (!(index >= 0 && index < rows.length)) throw new Error('invalid-index');
    if (!(options.batch >= 1 && options.batch <= 100 && options.keep >= 3)) throw new Error('invalid-options');
    // Start from at most `keep` rows around the opened memory (a grid page can be larger).
    const from = Math.max(0, Math.min(index - Math.floor(options.keep / 2), rows.length - options.keep));
    this.rows = rows.slice(from, from + options.keep); this.index = index - from; this.fetch = fetch; this.options = options;
  }

  get current(): T { return this.rows[this.index]!; }
  /** Loaded row IDs in order; for tests. */
  ids(): string[] { return this.rows.map(row => row.id); }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private changed() { for (const listener of [...this.listeners]) listener(); }

  private hasLoaded(direction: Direction): boolean {
    return direction === 'next' ? this.index < this.rows.length - 1 : this.index > 0;
  }
  state(direction: Direction): NeighbourState {
    if (this.hasLoaded(direction)) return 'ready';
    if (this.loads[direction]) return 'loading';
    if (this.ended[direction]) return 'end';
    return this.failed[direction] ? 'error' : 'unknown';
  }

  /** Replaces a loaded memory's data (for example after a favourite change, which can finish after the user moved on).
   * The open memory stays open even if it no longer matches the active filters, but leaves the sequence as soon as
   * the user moves away, so it is not shown again; any other loaded memory that no longer matches leaves at once. */
  update(row: T, stillMatches: boolean): void {
    const at = this.rows.findIndex(item => item.id === row.id);
    if (at < 0) return;
    if (at === this.index) { this.rows[at] = row; this.leaving = !stillMatches; }
    else if (stillMatches) this.rows[at] = row;
    else { this.rows.splice(at, 1); if (at < this.index) this.index--; }
    this.changed();
  }

  /** Moves one memory. Loads the next batch first if needed. Never moves twice for one call. */
  async move(direction: Direction): Promise<MoveResult> {
    const from = this.current.id;
    if (!this.hasLoaded(direction)) {
      await this.load(direction);
      if (this.current.id !== from) return 'stale'; // Another move happened meanwhile.
      if (!this.hasLoaded(direction)) return this.ended[direction] ? 'end' : 'error';
    }
    const target = direction === 'next' ? this.index + 1 : this.index - 1;
    if (this.leaving) {
      // Drop the memory that left the filtered library; the target shifts down if it was after it.
      this.rows.splice(this.index, 1);
      this.index = direction === 'next' ? target - 1 : target;
      this.leaving = false;
    } else this.index = target;
    this.trim(direction);
    this.changed();
    // Keep one neighbour ready in the direction of travel.
    if (!this.hasLoaded(direction) && !this.ended[direction]) void this.load(direction);
    return 'moved';
  }

  /** Loads the neighbours of the open memory that are not loaded yet; used when the viewer opens. */
  prepare(): void {
    for (const direction of ['previous', 'next'] as const) if (!this.hasLoaded(direction) && !this.ended[direction]) void this.load(direction);
  }

  private load(direction: Direction): Promise<void> {
    const running = this.loads[direction];
    if (running) return running;
    const edge = direction === 'next' ? this.rows[this.rows.length - 1]! : this.rows[0]!;
    this.failed[direction] = false;
    const task = (async () => {
      try {
        this.fetches++;
        const batch = await this.fetch(keyOf(edge), direction, this.options.batch);
        // The window may have been trimmed or changed meanwhile; only an unchanged edge can take this batch.
        const stillEdge = direction === 'next' ? this.rows[this.rows.length - 1] : this.rows[0];
        if (stillEdge?.id !== edge.id) return;
        const known = new Set(this.rows.map(row => row.id));
        const fresh = batch.filter(row => !known.has(row.id));
        if (direction === 'next') this.rows.push(...fresh);
        else { this.rows.unshift(...fresh.reverse()); this.index += fresh.length; }
        if (batch.length < this.options.batch) this.ended[direction] = true;
      } catch { this.failed[direction] = true; }
      finally { this.loads[direction] = null; this.changed(); }
    })();
    this.loads[direction] = task;
    this.changed();
    return task;
  }

  /** Keeps at most `keep` rows, dropping from the side away from the direction of travel. */
  private trim(direction: Direction): void {
    const excess = this.rows.length - this.options.keep;
    if (excess <= 0) return;
    if (direction === 'next') {
      const drop = Math.min(excess, this.index - 1); // Keep the previous neighbour.
      if (drop > 0) { this.rows.splice(0, drop); this.index -= drop; this.ended.previous = false; }
    } else {
      const drop = Math.min(excess, this.rows.length - this.index - 2);
      if (drop > 0) { this.rows.splice(this.rows.length - drop, drop); this.ended.next = false; }
    }
  }
}
