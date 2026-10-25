/** Small per-viewer cache of URI/size metadata. It owns no player and reads no original bytes into JS. */
export class ViewerMediaCache<T> {
  private entries = new Map<string, { promise: Promise<T>; value?: T }>();
  private listeners = new Set<() => void>();
  private readonly read: (id: string) => Promise<T>;
  private readonly keep: number;
  constructor(read: (id: string) => Promise<T>, keep = 5) {
    if (!Number.isInteger(keep) || keep < 1) throw new Error('invalid-cache-size');
    this.read = read; this.keep = keep;
  }
  peek(id: string): T | undefined { return this.entries.get(id)?.value; }
  subscribe(fn: () => void) { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  load(id: string): Promise<T> {
    const existing = this.entries.get(id);
    if (existing) { this.entries.delete(id); this.entries.set(id, existing); return existing.promise; }
    const entry: { promise: Promise<T>; value?: T } = { promise: Promise.resolve().then(() => this.read(id)) };
    this.entries.set(id, entry);
    while (this.entries.size > this.keep) this.entries.delete(this.entries.keys().next().value!);
    entry.promise = entry.promise.then(value => { entry.value = value; if (this.entries.get(id) === entry) this.listeners.forEach(fn => fn()); return value; },
      error => { if (this.entries.get(id) === entry) this.entries.delete(id); throw error; });
    return entry.promise;
  }
}
