import type { SqlDatabase, SqlConnection } from './previewStore.ts';
import { encodePreview, decodePreview } from './previewCodec.ts';
import { mergeSourceInventories, type SourceInventory } from '../import/sourceInventory.ts';
export type Receipt = { sha256: string; relativePath: string; bytes: number };
export type ImportItem = { ordinal: number; relative_path: string; memory_id: string; role: string; state: 'pending' | 'done'; object_hash: string | null; bytes: number | null };
export type ImportSummary = { files: number; objects: number; memories: number; unfinished: number; conflicts: number };
function check(ok: unknown): asserts ok { if (!ok) throw new Error('invalid-import-state'); }
export function validateReceipt(value: Receipt): void {
  check(/^[a-f0-9]{64}$/.test(value.sha256));
  check(value.relativePath === `objects/${value.sha256.slice(0, 2)}/${value.sha256}`);
  check(Number.isSafeInteger(value.bytes) && value.bytes >= 0 && value.bytes <= 8 * 1024 ** 3);
}
export type LibraryRow = { id: string; day: string | null; instant: string | null; dateConflict: number; photos: number; videos: number; overlays: number };
export type LibraryObject = Receipt & { role: 'photo' | 'video' | 'overlay' };
async function indexDates(tx: SqlConnection, source: SourceInventory) {
  const evidence = [
    ...source.files.map(file => ({ id: file.memorySourceId, date: file.captureDate })),
    ...source.metadata.flatMap(result => result.records.map(row => ({ id: row.memorySourceId, date: row.captureDate }))),
  ];
  for (const { id, date } of evidence) {
    if (id && date.kind !== 'unknown') await tx.runAsync('INSERT OR IGNORE INTO library_dates(memory_id,kind,value,day) VALUES (?,?,?,?)', id, date.kind, date.kind === 'instant' ? date.utc : date.date, date.kind === 'instant' ? date.utc.slice(0, 10) : date.date);
  }
}
export class ImportStore {
  private db: SqlDatabase;
  constructor(db: SqlDatabase) { this.db = db; }
  async initialize() {
    await this.db.execAsync('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
    await this.db.withExclusiveTransactionAsync(async tx => {
      const version = await tx.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
      if (version?.user_version === 2) return;
      check(version?.user_version === 0 || version?.user_version === 1);
      if (version.user_version === 0) await tx.execAsync(`
        CREATE TABLE import_jobs (hash TEXT PRIMARY KEY, state TEXT NOT NULL CHECK(state IN ('planned','running','paused','completed')), plan_json TEXT NOT NULL);
        CREATE TABLE import_items (job_hash TEXT NOT NULL, ordinal INTEGER NOT NULL, relative_path TEXT NOT NULL, memory_id TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('photo','video','overlay')), date_json TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','done')), object_hash TEXT, PRIMARY KEY(job_hash,ordinal), UNIQUE(job_hash,relative_path), CHECK((state='pending' AND object_hash IS NULL) OR (state='done' AND object_hash IS NOT NULL)));
        CREATE TABLE stored_objects (hash TEXT PRIMARY KEY, relative_path TEXT NOT NULL UNIQUE, bytes INTEGER NOT NULL CHECK(bytes >= 0));
        CREATE TABLE memories (id TEXT PRIMARY KEY);
        CREATE TABLE memory_objects (memory_id TEXT NOT NULL, role TEXT NOT NULL, object_hash TEXT NOT NULL, PRIMARY KEY(memory_id,role,object_hash));
        CREATE INDEX items_job_state ON import_items(job_hash,state,ordinal);
      `);
      await tx.execAsync(`CREATE TABLE library_dates(memory_id TEXT NOT NULL, kind TEXT NOT NULL, value TEXT NOT NULL, day TEXT NOT NULL, PRIMARY KEY(memory_id,kind,value));
        CREATE INDEX memory_objects_by_memory ON memory_objects(memory_id,role);
        CREATE INDEX import_items_by_memory ON import_items(memory_id);
      `);
      let after = '';
      while (true) {
        const job = await tx.getFirstAsync<{ hash: string; plan_json: string }>('SELECT hash,plan_json FROM import_jobs WHERE hash>? ORDER BY hash LIMIT 1', after);
        if (!job) break;
        for (const source of decodePreview(job.plan_json).preview.sources) await indexDates(tx, source);
        after = job.hash;
      }
      await tx.execAsync('PRAGMA user_version = 2;');
    });
  }
  async plan(hash: string, source: SourceInventory): Promise<void> {
    check(/^[a-f0-9]{64}$/.test(hash));
    const json = encodePreview({ preview: mergeSourceInventories([], source), sourceIds: new Map([[`zip:${hash}`, source.sourceId]]) });
    const normalized = decodePreview(json).preview.sources[0]!;
    await this.db.withExclusiveTransactionAsync(async tx => {
      const existing = await tx.getFirstAsync('SELECT hash FROM import_jobs WHERE hash = ?', hash);
      if (existing) return; // An archive's bytes, and therefore its persisted plan, are immutable.
      await tx.runAsync('INSERT INTO import_jobs(hash,state,plan_json) VALUES (?,\'planned\',?)', hash, json);
      await indexDates(tx, normalized);
      for (const [ordinal, file] of normalized.files.entries()) {
        await tx.runAsync('INSERT INTO import_items(job_hash,ordinal,relative_path,memory_id,role,date_json) VALUES (?,?,?,?,?,?)', hash, ordinal, file.relativePath, file.memorySourceId, file.role, JSON.stringify(file.captureDate));
      }
    });
  }
  async item(hash: string, after: number): Promise<ImportItem | null> {
    return this.db.getFirstAsync<ImportItem>(`SELECT i.ordinal,i.relative_path,i.memory_id,i.role,i.state,i.object_hash,o.bytes FROM import_items i LEFT JOIN stored_objects o ON o.hash=i.object_hash WHERE i.job_hash=? AND i.ordinal>? ORDER BY i.ordinal LIMIT 1`, hash, after);
  }
  async copiedBytes(hash: string): Promise<number> {
    const row = await this.db.getFirstAsync<{ bytes: number }>('SELECT coalesce(sum(o.bytes),0) AS bytes FROM import_items i JOIN stored_objects o ON o.hash=i.object_hash WHERE i.job_hash=?', hash);
    return row?.bytes ?? 0;
  }
  async state(hash: string, state: 'running' | 'paused' | 'completed') {
    await this.db.withExclusiveTransactionAsync(async tx => {
      check(await tx.getFirstAsync('SELECT hash FROM import_jobs WHERE hash=?', hash));
      if (state === 'completed') check(!(await tx.getFirstAsync('SELECT ordinal FROM import_items WHERE job_hash=? AND state=\'pending\' LIMIT 1', hash)));
      await tx.runAsync('UPDATE import_jobs SET state=? WHERE hash=?', state, hash);
    });
  }
  async commit(hash: string, ordinal: number, receipt: Receipt): Promise<void> {
    validateReceipt(receipt);
    await this.db.withExclusiveTransactionAsync(async tx => {
      const item = await tx.getFirstAsync<ImportItem>('SELECT * FROM import_items WHERE job_hash=? AND ordinal=?', hash, ordinal); check(item);
      if (item.state === 'done') { check(item.object_hash === receipt.sha256); return; }
      await tx.runAsync('INSERT INTO stored_objects(hash,relative_path,bytes) VALUES (?,?,?) ON CONFLICT(hash) DO NOTHING', receipt.sha256, receipt.relativePath, receipt.bytes);
      const stored = await tx.getFirstAsync<{ bytes: number; relative_path: string }>('SELECT bytes,relative_path FROM stored_objects WHERE hash=?', receipt.sha256);
      check(stored?.bytes === receipt.bytes && stored.relative_path === receipt.relativePath);
      await tx.runAsync('INSERT OR IGNORE INTO memories(id) VALUES (?)', item.memory_id);
      await tx.runAsync('INSERT OR IGNORE INTO memory_objects(memory_id,role,object_hash) VALUES (?,?,?)', item.memory_id, item.role, receipt.sha256);
      await tx.runAsync('UPDATE import_items SET state=\'done\',object_hash=? WHERE job_hash=? AND ordinal=?', receipt.sha256, hash, ordinal);
    });
  }
  /** Stable ID order; only committed base objects are visible. Each page is bounded. */
  async page(after = '', limit = 30): Promise<LibraryRow[]> {
    check(Number.isInteger(limit) && limit >= 1 && limit <= 100);
    const row = await this.db.getFirstAsync<{ data: string }>(`SELECT json_group_array(json_object(
      'id',id,'day',day,'instant',instant,'dateConflict',dateConflict,'photos',photos,'videos',videos,'overlays',overlays)) AS data FROM (
      SELECT m.id,
        (SELECT min(day) FROM library_dates WHERE memory_id=m.id) AS day,
        (SELECT min(value) FROM library_dates WHERE memory_id=m.id AND kind='instant') AS instant,
        (SELECT CASE WHEN count(DISTINCT day)>1 OR count(DISTINCT CASE WHEN kind='instant' THEN value END)>1 THEN 1 ELSE 0 END FROM library_dates WHERE memory_id=m.id) AS dateConflict,
        (SELECT count(*) FROM memory_objects WHERE memory_id=m.id AND role='photo') AS photos,
        (SELECT count(*) FROM memory_objects WHERE memory_id=m.id AND role='video') AS videos,
        (SELECT count(*) FROM memory_objects WHERE memory_id=m.id AND role='overlay') AS overlays
      FROM memories m WHERE m.id>? AND EXISTS(SELECT 1 FROM memory_objects WHERE memory_id=m.id AND role!='overlay') ORDER BY m.id LIMIT ?
    )`, after, limit);
    return JSON.parse(row?.data ?? '[]') as LibraryRow[];
  }
  async objects(id: string): Promise<LibraryObject[]> {
    // Three are enough to detect ambiguity. Never load an unbounded collection of variants.
    const row = await this.db.getFirstAsync<{ data: string }>(`SELECT json_group_array(json_object('role',role,'sha256',hash,'relativePath',relative_path,'bytes',bytes)) AS data FROM (
      SELECT m.role,o.hash,o.relative_path,o.bytes FROM memory_objects m JOIN stored_objects o ON o.hash=m.object_hash WHERE m.memory_id=? ORDER BY CASE WHEN m.role='overlay' THEN 1 ELSE 0 END,m.role,o.hash LIMIT 3
    )`, id);
    return JSON.parse(row?.data ?? '[]') as LibraryObject[];
  }
  async summary(): Promise<ImportSummary> {
    const row = await this.db.getFirstAsync<ImportSummary>(`SELECT
      (SELECT count(*) FROM import_items WHERE state='done') AS files,
      (SELECT count(*) FROM stored_objects) AS objects,
      (SELECT count(DISTINCT memory_id) FROM memory_objects WHERE role != 'overlay') AS memories,
      (SELECT count(*) FROM import_jobs WHERE state != 'completed') AS unfinished,
      (SELECT count(DISTINCT memory_id) FROM (SELECT memory_id, CASE WHEN role='overlay' THEN 'overlay' ELSE 'base' END AS layer FROM memory_objects GROUP BY memory_id,layer HAVING count(DISTINCT object_hash)>1 OR count(DISTINCT role)>1)) AS conflicts`);
    check(row); return { ...row };
  }
}
