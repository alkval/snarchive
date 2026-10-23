// Query-only synthetic data. No provider, media, import receipts or device app data is read.
import { DatabaseSync } from 'node:sqlite';
import { ImportStore } from '../../src/storage/importStore.ts';
import type { SqlConnection } from '../../src/storage/previewStore.ts';

export class BenchmarkDatabase {
  readonly raw: DatabaseSync;
  queryTransform: ((sql: string) => string) | null = null;
  maxReturned = 0;
  lastQuery: { sql: string; params: (string | number | null)[] } | null = null;
  constructor(path = ':memory:') { this.raw = new DatabaseSync(path); }
  async execAsync(sql: string) { this.raw.exec(sql); }
  async runAsync(sql: string, ...params: (string | number | null)[]) { this.raw.prepare(sql).run(...params); }
  async getFirstAsync<T>(sql: string, ...params: (string | number | null)[]): Promise<T | null> {
    this.lastQuery = { sql, params };
    const row = (this.raw.prepare(this.queryTransform?.(sql) ?? sql).get(...params) as T | undefined) ?? null;
    const data = (row as { data?: string } | null)?.data;
    if (data) this.maxReturned = Math.max(this.maxReturned, (JSON.parse(data) as unknown[]).length);
    return row;
  }
  async getAllAsync<T>(sql: string, ...params: (string | number | null)[]) { return this.raw.prepare(sql).all(...params) as T[]; }
  async withExclusiveTransactionAsync(work: (tx: SqlConnection) => Promise<void>) {
    this.raw.exec('BEGIN IMMEDIATE');
    try { await work(this); this.raw.exec('COMMIT'); } catch (error) { this.raw.exec('ROLLBACK'); throw error; }
  }
}
export async function seedLibrary(db: BenchmarkDatabase, count: number): Promise<ImportStore> {
  if (!Number.isInteger(count) || count < 100 || count > 100_000) throw new Error('fixture-count-out-of-range');
  const store = new ImportStore(db); await store.initialize();
  const object = db.raw.prepare('INSERT INTO stored_objects VALUES(?,?,0)');
  const memory = db.raw.prepare('INSERT INTO memories VALUES(?)');
  const media = db.raw.prepare('INSERT INTO memory_objects VALUES(?,?,?)');
  const date = db.raw.prepare('INSERT INTO library_dates VALUES(?,?,?,?)');
  const favorite = db.raw.prepare('INSERT INTO library_favorites VALUES(?)');
  const hashes = [1, 2, 3, 4].map(n => n.toString(16).padStart(64, '0'));
  db.raw.exec('BEGIN IMMEDIATE');
  try {
    for (const hash of hashes) object.run(hash, `objects/${hash.slice(0, 2)}/${hash}`);
    for (let i = 0; i < count; i++) {
      const id = `bench-${String(i).padStart(8, '0')}`, mode = i % 20;
      memory.run(id);
      if (mode !== 4) media.run(id, mode === 3 ? 'overlay' : mode === 7 ? 'video' : 'photo', hashes[0]!);
      if (mode === 5) media.run(id, 'photo', hashes[1]!);
      if (mode === 6) media.run(id, 'video', hashes[2]!);
      if (mode % 3 === 0 && mode !== 3 && mode !== 4) media.run(id, 'overlay', hashes[3]!);
      const day = i % 10 === 0 ? '2020-10-24' : `${2015 + i % 11}-${String(1 + i % 12).padStart(2, '0')}-${String(1 + Math.floor(i / 12) % 28).padStart(2, '0')}`;
      if (mode !== 0) {
        date.run(id, 'date-only', day, day);
        if (i % 2 === 0) date.run(id, 'instant', `${day}T12:34:56.000Z`, day);
        if (mode === 1) date.run(id, 'date-only', '2000-01-01', '2000-01-01');
        if (mode === 2) date.run(id, 'instant', `${day}T13:34:56.000Z`, day);
      }
      if (i % 9 === 0) favorite.run(id);
    }
    db.raw.exec('COMMIT');
  } catch (error) { db.raw.exec('ROLLBACK'); throw error; }
  return store;
}
