import { decodePreview, encodePreview, MAX_PREVIEW_CHARS, type SavedPreview } from './previewCodec.ts';
export interface SqlConnection {
  execAsync(sql: string): Promise<void>;
  runAsync(sql: string, ...params: (string | number | null)[]): Promise<unknown>;
  getFirstAsync<T>(sql: string, ...params: (string | number | null)[]): Promise<T | null>;
  getAllAsync<T>(sql: string, ...params: (string | number | null)[]): Promise<T[]>;
}
export interface SqlDatabase extends SqlConnection {
  withExclusiveTransactionAsync(work: (transaction: SqlConnection) => Promise<void>): Promise<void>;
}

/** One atomic checkpoint of the preview. This is deliberately not the imported-media schema. */
export class PreviewStore {
  private readonly db: SqlDatabase;
  constructor(db: SqlDatabase) { this.db = db; }
  async initialize(): Promise<void> {
    await this.db.execAsync('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
    await this.db.withExclusiveTransactionAsync(async tx => {
      const row = await tx.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
      if (row?.user_version === 1) return;
      if (row?.user_version !== 0) throw new Error('unsupported-database-version');
      await tx.execAsync(`CREATE TABLE preview_checkpoint (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        payload TEXT NOT NULL,
        saved_at TEXT NOT NULL
      ); PRAGMA user_version = 1;`);
    });
  }
  async load(): Promise<SavedPreview | null> {
    let result: SavedPreview | null = null;
    await this.db.withExclusiveTransactionAsync(async tx => {
      const size = await tx.getFirstAsync<{ size: number }>('SELECT length(payload) AS size FROM preview_checkpoint WHERE id = 1');
      if (!size) return;
      if (size.size > MAX_PREVIEW_CHARS) throw new Error('invalid-saved-preview');
      const row = await tx.getFirstAsync<{ payload: string }>('SELECT payload FROM preview_checkpoint WHERE id = 1');
      if (!row) throw new Error('invalid-saved-preview');
      result = decodePreview(row.payload);
    });
    return result;
  }
  async save(saved: SavedPreview): Promise<void> {
    const payload = encodePreview(saved);
    await this.db.withExclusiveTransactionAsync(async tx => {
      await tx.runAsync(`INSERT INTO preview_checkpoint (id, payload, saved_at) VALUES (1, ?, ?)
        ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, saved_at = excluded.saved_at`, payload, new Date().toISOString());
    });
  }
}
