import { DETAILS_PAGE_SIZE, type DetailKey, type DetailRow, type DetailSection } from '../storage/memoryDetails.ts';

export type DetailsRead = (section: DetailSection, anchor: DetailKey | null, direction: 'next' | 'previous') => Promise<DetailRow[]>;
/** One bounded page, no growing history. A failed read retries its own cursor. Switching sections or closing
 * invalidates outstanding reads; rapid page taps cannot advance twice while the first read is outstanding. */
export class MemoryDetails {
  section: DetailSection = 'originals';
  rows: DetailRow[] = [];
  loading = true;
  failed = false;
  hasNext = false;
  hasPrevious = false;
  private request = 0;
  private closed = false;
  private anchor: DetailKey | null = null;
  private direction: 'next' | 'previous' = 'next';
  private listeners = new Set<() => void>();
  private read: DetailsRead;
  constructor(read: DetailsRead) { this.read = read; }
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private changed() { for (const listener of this.listeners) listener(); }
  close() { this.closed = true; this.request++; this.listeners.clear(); }
  open(): Promise<void> { this.closed = false; return this.load(); }
  async load(): Promise<void> {
    if (this.closed) return;
    const request = ++this.request, section = this.section, anchor = this.anchor, direction = this.direction;
    this.loading = true; this.failed = false; this.rows = []; this.hasNext = false; this.hasPrevious = false; this.changed();
    try {
      const fetched = await this.read(section, anchor, direction);
      if (this.closed || request !== this.request) return;
      const more = fetched.length > DETAILS_PAGE_SIZE;
      this.rows = fetched.slice(0, DETAILS_PAGE_SIZE);
      if (direction === 'previous') this.rows.reverse();
      this.hasNext = direction === 'next' ? more : anchor !== null;
      this.hasPrevious = direction === 'previous' ? more : anchor !== null;
    } catch { if (this.closed || request !== this.request) return; this.failed = true; }
    this.loading = false; this.changed();
  }
  select(section: DetailSection): Promise<void> {
    this.section = section; this.anchor = null; this.direction = 'next'; return this.load();
  }
  move(direction: 'next' | 'previous'): Promise<void> {
    if (this.loading || this.failed || !(direction === 'next' ? this.hasNext : this.hasPrevious)) return Promise.resolve();
    const edge = direction === 'next' ? this.rows.at(-1) : this.rows[0];
    if (!edge) return Promise.resolve();
    this.anchor = { key1: edge.key1, key2: edge.key2 }; this.direction = direction; return this.load();
  }
}
