import { DatabaseSync } from 'node:sqlite';
import type { SqlConnection, SqlDatabase } from '../../src/storage/previewStore.ts';

export class LibraryDB implements SqlDatabase {
  raw: DatabaseSync;
  constructor(path = ':memory:') { this.raw = new DatabaseSync(path); }
  failSql = '';
  active = false;
  async execAsync(sql: string) { this.raw.exec(sql); }
  async runAsync(sql: string, ...p: (string | number | null)[]) {
    if (this.failSql && sql.includes(this.failSql)) throw new Error('injected-db-failure');
    this.raw.prepare(sql).run(...p);
  }
  async getFirstAsync<T>(sql: string, ...p: (string | number | null)[]) { return (this.raw.prepare(sql).get(...p) as T | undefined) ?? null; }
  async getAllAsync<T>(sql: string, ...p: (string | number | null)[]) { return this.raw.prepare(sql).all(...p) as T[]; }
  async withExclusiveTransactionAsync(work: (tx: SqlConnection) => Promise<void>) {
    this.raw.exec('BEGIN'); this.active = true;
    try { await work(this); this.raw.exec('COMMIT'); }
    catch (error) { this.raw.exec('ROLLBACK'); throw error; }
    finally { this.active = false; }
  }
}
