import { defaultFilters, validFilters, type LibraryFilters } from '../domain/libraryFilters.ts';
import type { SqlDatabase, SqlConnection } from './previewStore.ts';
import { encodePreview, decodePreview } from './previewCodec.ts';
import { mergeSourceInventories, type SourceInventory } from '../import/sourceInventory.ts';
import { canonicalFolderSource, folderInventoryHash, isCanonicalFolderSource } from '../import/sourceEvidence.ts';
/** zip: hash is the archive's SHA-256. folder: hash is the folder's inventory hash (folderInventoryHash). */
export type JobKind = 'zip' | 'folder';
export type Receipt = { sha256: string; relativePath: string; bytes: number };
export type ImportItem = { ordinal: number; relative_path: string; memory_id: string; role: string; state: 'pending' | 'done'; object_hash: string | null; bytes: number | null };
export type ImportSummary = { files: number; objects: number; memories: number; unfinished: number; conflicts: number };
function check(ok: unknown): asserts ok { if (!ok) throw new Error('invalid-import-state'); }
/** Bump with each migration. The backup snapshot pins the version it covers; a test fails when they diverge. */
export const LIBRARY_SCHEMA_VERSION = 5;
export function validateReceipt(value: Receipt): void {
  check(/^[a-f0-9]{64}$/.test(value.sha256));
  check(value.relativePath === `objects/${value.sha256.slice(0, 2)}/${value.sha256}`);
  check(Number.isSafeInteger(value.bytes) && value.bytes >= 0 && value.bytes <= 8 * 1024 ** 3);
}
export type LibraryRow = { id: string; day: string | null; instant: string | null; dateConflict: number; photos: number; videos: number; overlays: number };
export type LibraryCursor = { day: string; time: string; id: string };
export type ChronologicalRow = LibraryRow & { favorite: number; sortDay: string; sortTime: string };
export type LibraryObject = Receipt & { role: 'photo' | 'video' | 'overlay' };
/** Derives date-index rows from a source's evidence. Shared by planning and restore, so both index alike. */
export async function indexDates(tx: SqlConnection, source: SourceInventory) {
  const evidence = [
    ...source.files.map(file => ({ id: file.memorySourceId, date: file.captureDate })),
    ...source.metadata.flatMap(result => result.records.map(row => ({ id: row.memorySourceId, date: row.captureDate }))),
  ];
  for (const { id, date } of evidence) {
    if (id && date.kind !== 'unknown') await tx.runAsync('INSERT OR IGNORE INTO library_dates(memory_id,kind,value,day) VALUES (?,?,?,?)', id, date.kind, date.kind === 'instant' ? date.utc : date.date, date.kind === 'instant' ? date.utc.slice(0, 10) : date.date);
  }
}
/** Schema 5, and the end of every restore. Folder jobs planned by schema 4 (commit 307eda2) were keyed by their
 * evidence in the provider's listing order. Jobs are visited in key order; each one not in canonical order is
 * rewritten in canonical order under its canonical key, and each item keeps its state and object, found by its path
 * (unique per job), at its new ordinal. If the canonical key already belongs to a folder job (the same folder planned
 * twice from different listings), the two are merged where they agree: a file done in either becomes done. If both
 * completed a file with different objects, the listing-order job is kept apart, unchanged, under its own key, so both
 * observations, their objects and associations, and its pending files survive; a backup writes it as it is, and a
 * restore keeps it apart again by this same rule. A new scan matches only the canonical job. */
export async function canonicalizeFolderJobs(tx: SqlConnection): Promise<void> {
  const jobs = await tx.getAllAsync<{ hash: string }>("SELECT hash FROM import_jobs WHERE kind='folder' ORDER BY hash");
  for (const { hash } of jobs) {
    const job = await tx.getFirstAsync<{ plan_json: string }>('SELECT plan_json FROM import_jobs WHERE hash=?', hash);
    if (!job) continue; // Merged into another job earlier in this loop.
    const source = decodePreview(job.plan_json).preview.sources[0]!;
    const key = folderInventoryHash(source);
    if (key === hash && isCanonicalFolderSource(source)) continue;
    const canonical = canonicalFolderSource(source);
    const order = new Map(canonical.files.map((file, ordinal) => [file.relativePath, ordinal]));
    const items = await tx.getAllAsync<{ relative_path: string; state: string; object_hash: string | null }>('SELECT relative_path,state,object_hash FROM import_items WHERE job_hash=?', hash);
    check(items.length === order.size && items.every(item => order.has(item.relative_path)));
    const target = key === hash ? null : await tx.getFirstAsync<{ kind: string; state: string }>('SELECT kind,state FROM import_jobs WHERE hash=?', key);
    if (!target) {
      const plan = encodePreview({ preview: mergeSourceInventories([], canonical), sourceIds: new Map([[`folder:${key}`, canonical.sourceId]]) });
      await tx.runAsync('UPDATE import_jobs SET hash=?,plan_json=? WHERE hash=?', key, plan, hash);
      // Two steps, so no intermediate ordinal collides with another item's: first out of range, then into place.
      await tx.runAsync('UPDATE import_items SET job_hash=?,ordinal=-1-ordinal WHERE job_hash=?', key, hash);
      for (const item of items) await tx.runAsync('UPDATE import_items SET ordinal=? WHERE job_hash=? AND relative_path=?', order.get(item.relative_path)!, key, item.relative_path);
      continue;
    }
    if (target.kind !== 'folder') continue;
    const theirs = new Map((await tx.getAllAsync<{ relative_path: string; state: string; object_hash: string | null }>(
      'SELECT relative_path,state,object_hash FROM import_items WHERE job_hash=?', key)).map(item => [item.relative_path, item]));
    const compatible = items.every(item => { const other = theirs.get(item.relative_path);
      return other && !(item.state === 'done' && other.state === 'done' && item.object_hash !== other.object_hash); });
    if (!compatible) continue;
    for (const item of items) {
      if (item.state === 'done' && theirs.get(item.relative_path)!.state === 'pending') {
        await tx.runAsync("UPDATE import_items SET state='done',object_hash=? WHERE job_hash=? AND relative_path=?", item.object_hash, key, item.relative_path);
      }
    }
    await tx.runAsync('DELETE FROM import_items WHERE job_hash=?', hash);
    await tx.runAsync('DELETE FROM import_jobs WHERE hash=?', hash);
    const pending = await tx.getFirstAsync("SELECT 1 FROM import_items WHERE job_hash=? AND state='pending' LIMIT 1", key);
    const anyDone = await tx.getFirstAsync("SELECT 1 FROM import_items WHERE job_hash=? AND state='done' LIMIT 1", key);
    const state = !pending ? 'completed' : anyDone && target.state === 'planned' ? 'paused' : target.state;
    await tx.runAsync('UPDATE import_jobs SET state=? WHERE hash=?', state, key);
  }
}
/** A source as the saved-preview codec stores it: allowlisted fields in a fixed key order. */
export function normalizeSource(source: SourceInventory): SourceInventory {
  return decodePreview(encodePreview({ preview: mergeSourceInventories([], source), sourceIds: new Map([[`folder:${'0'.repeat(64)}`, source.sourceId]]) })).preview.sources[0]!;
}
export class ImportStore {
  private db: SqlDatabase;
  constructor(db: SqlDatabase) { this.db = db; }
  /** The library connection, for read-only queries elsewhere (the originals check). */
  get database(): SqlDatabase { return this.db; }
  async initialize() {
    await this.db.execAsync('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
    await this.db.withExclusiveTransactionAsync(async tx => {
      const version = await tx.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
      if (version?.user_version === LIBRARY_SCHEMA_VERSION) return;
      check(version && [0, 1, 2, 3, 4].includes(version.user_version));
      if (version.user_version < 2) {
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
      }
      if (version.user_version < 3) await tx.execAsync('CREATE TABLE library_favorites(memory_id TEXT PRIMARY KEY);');
      // Schema 4 (section 21): a job is a ZIP archive or an extracted folder. Existing jobs are all ZIP jobs.
      if (version.user_version < 4) await tx.execAsync("ALTER TABLE import_jobs ADD COLUMN kind TEXT NOT NULL DEFAULT 'zip' CHECK(kind IN ('zip','folder'));");
      // Schema 5 (section 21 review): folder evidence in canonical order, independent of provider listing order.
      await canonicalizeFolderJobs(tx);
      await tx.execAsync('PRAGMA user_version = 5;');
    });
  }
  async plan(hash: string, source: SourceInventory): Promise<void> {
    check(/^[a-f0-9]{64}$/.test(hash));
    await this.insertPlan(hash, 'zip', source);
  }
  /** Plans an extracted folder from its saved scan, in canonical order (files by path, metadata by content), keyed by
   * its inventory hash. A second scan of an unchanged folder finds the same job, however the provider listed it, and
   * so does a preview saved before evidence was canonical; a changed folder is a different plan. */
  async planFolder(source: SourceInventory): Promise<string> {
    const canonical = canonicalFolderSource(normalizeSource(source));
    const hash = folderInventoryHash(canonical);
    await this.insertPlan(hash, 'folder', canonical);
    return hash;
  }
  /** A planned folder job's normalized source, or null if hash is not a folder job. */
  async folderPlan(hash: string): Promise<SourceInventory | null> {
    const row = await this.db.getFirstAsync<{ plan_json: string }>("SELECT plan_json FROM import_jobs WHERE hash=? AND kind='folder'", hash);
    return row ? decodePreview(row.plan_json).preview.sources[0]! : null;
  }
  private async insertPlan(hash: string, kind: JobKind, source: SourceInventory): Promise<void> {
    const json = encodePreview({ preview: mergeSourceInventories([], source), sourceIds: new Map([[`${kind}:${hash}`, source.sourceId]]) });
    const normalized = decodePreview(json).preview.sources[0]!;
    await this.db.withExclusiveTransactionAsync(async tx => {
      const existing = await tx.getFirstAsync<{ kind: string }>('SELECT kind FROM import_jobs WHERE hash = ?', hash);
      // An archive's bytes, or a folder's inventory, fix the persisted plan: an existing job is reused, never replaced.
      if (existing) { check(existing.kind === kind); return; }
      await tx.runAsync('INSERT INTO import_jobs(hash,state,plan_json,kind) VALUES (?,\'planned\',?,?)', hash, json, kind);
      await indexDates(tx, normalized);
      for (const [ordinal, file] of normalized.files.entries()) {
        await tx.runAsync('INSERT INTO import_items(job_hash,ordinal,relative_path,memory_id,role,date_json) VALUES (?,?,?,?,?,?)', hash, ordinal, file.relativePath, file.memorySourceId, file.role, JSON.stringify(file.captureDate));
      }
    });
  }
  async item(hash: string, after: number): Promise<ImportItem | null> {
    return this.db.getFirstAsync<ImportItem>(`SELECT i.ordinal,i.relative_path,i.memory_id,i.role,i.state,i.object_hash,o.bytes FROM import_items i LEFT JOIN stored_objects o ON o.hash=i.object_hash WHERE i.job_hash=? AND i.ordinal>? ORDER BY i.ordinal LIMIT 1`, hash, after);
  }
  async hasPending(hash: string): Promise<boolean> {
    return !!(await this.db.getFirstAsync("SELECT 1 FROM import_items WHERE job_hash=? AND state='pending' LIMIT 1", hash));
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
        EXISTS(SELECT 1 FROM library_favorites WHERE memory_id=m.id) AS favorite,
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
  async chronologicalPage(after: LibraryCursor | null = null, limit = 30, filters: LibraryFilters = defaultFilters): Promise<ChronologicalRow[]> {
    check(Number.isInteger(limit) && limit >= 1 && limit <= 100);
    check(validFilters(filters));
    const row = await this.db.getFirstAsync<{ data: string }>(`WITH facts AS (
      SELECT m.id,
        EXISTS(SELECT 1 FROM library_favorites WHERE memory_id=m.id) AS favorite,
        (SELECT min(day) FROM library_dates WHERE memory_id=m.id) AS day,
        (SELECT min(value) FROM library_dates WHERE memory_id=m.id AND kind='instant') AS instant,
        (SELECT CASE WHEN count(DISTINCT day)>1 OR count(DISTINCT CASE WHEN kind='instant' THEN value END)>1 THEN 1 ELSE 0 END FROM library_dates WHERE memory_id=m.id) AS dateConflict,
        (SELECT count(*) FROM memory_objects WHERE memory_id=m.id AND role='photo') AS photos,
        (SELECT count(*) FROM memory_objects WHERE memory_id=m.id AND role='video') AS videos,
        (SELECT count(*) FROM memory_objects WHERE memory_id=m.id AND role='overlay') AS overlays
      FROM memories m WHERE EXISTS(SELECT 1 FROM memory_objects WHERE memory_id=m.id AND role!='overlay')
    ), ordered AS (
      SELECT *, CASE WHEN dateConflict=0 THEN coalesce(day,'') ELSE '' END AS sortDay,
        CASE WHEN dateConflict=0 THEN coalesce(instant,'') ELSE '' END AS sortTime FROM facts
    ) SELECT json_group_array(json_object('id',id,'day',day,'instant',instant,'dateConflict',dateConflict,
      'favorite',favorite,'photos',photos,'videos',videos,'overlays',overlays,'sortDay',sortDay,'sortTime',sortTime)) AS data FROM (
      SELECT * FROM ordered WHERE (?=1 OR sortDay<? OR (sortDay=? AND sortTime<?) OR (sortDay=? AND sortTime=? AND id>?))
        AND (?='all' OR (?='photos' AND photos>0) OR (?='videos' AND videos>0))
        AND (?=0 OR favorite=1) AND (?='' OR (dateConflict=0 AND substr(day,1,7)=?))
      ORDER BY sortDay DESC,sortTime DESC,id ASC LIMIT ?
    )`, after ? 0 : 1, after?.day ?? '', after?.day ?? '', after?.time ?? '', after?.day ?? '', after?.time ?? '', after?.id ?? '', filters.media, filters.media, filters.media, filters.favorites ? 1 : 0, filters.month, filters.month, limit);
    return JSON.parse(row?.data ?? '[]') as ChronologicalRow[];
  }
  async setFavorite(id: string, favorite: boolean): Promise<void> {
    check(typeof favorite === 'boolean');
    await this.db.withExclusiveTransactionAsync(async tx => {
      check(await tx.getFirstAsync("SELECT 1 FROM memory_objects WHERE memory_id=? AND role!='overlay' LIMIT 1", id));
      if (favorite) await tx.runAsync('INSERT OR IGNORE INTO library_favorites(memory_id) VALUES (?)', id);
      else await tx.runAsync('DELETE FROM library_favorites WHERE memory_id=?', id);
    });
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
