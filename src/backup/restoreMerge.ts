import type { SqlConnection } from '../storage/previewStore.ts';
import { indexDates, LIBRARY_SCHEMA_VERSION } from '../storage/importStore.ts';
import { decodePreview, encodePreview } from '../storage/previewCodec.ts';
import { mergeSourceInventories } from '../import/sourceInventory.ts';
import type { SourceInventory } from '../import/sourceInventory.ts';
import type { ValidRecord } from './manifest.ts';
import { canonicalFolderSource, folderInventoryHash, sourceEvidence } from '../import/sourceEvidence.ts';

/** What a restore changed in the library, as opposed to what the backup contains. */
export type RestoreChanges = {
  /** Memories that gained their first preserved photo or video. */
  memoriesAdded: number;
  /** New (memory, role, object) associations, including variants and overlays. */
  associationsAdded: number;
  /** Original objects newly recorded in the library. */
  objectsAdded: number;
  favoritesAdded: number;
  sourcesAdded: number;
  /** Existing source jobs that gained preserved files. */
  sourcesUpdated: number;
  /** Inventory files that became preserved (pending before, or new with a source). */
  filesPreserved: number;
};
export class RestoreError extends Error {}
function check(ok: unknown, code = 'restore-conflict'): asserts ok { if (!ok) throw new RestoreError(code); }
const BATCH = 100;

export { sourceEvidence };

type Item = { relativePath: string; memoryId: string; role: string; dateJson: string; state: 'pending' | 'done'; objectHash: string | null };
/** hash: the job key in this library; written: the key in the backup (they differ only for a folder record written in
 * listing order by 307eda2). ordinals maps the backup's file ordinals to the job's, for folders; null for archives. */
type SourceRecord = { kind: 'zip' | 'folder'; hash: string; written: string; saved: Extract<ValidRecord, { type: 'source' }>['saved']; inventory: string; ordinals: number[] | null };
type Source = { kind: 'zip' | 'folder'; hash: string; isNew: boolean; state: string; items: Item[]; plan: string; source: SourceRecord; completed: number };
type Counts = { base: number; associations: number; objects: number; favorites: number; jobs: number; done: number };

/** Applies validated backup records to the library inside the caller's exclusive transaction. Additive only:
 * nothing is deleted or overwritten, completed work never regresses, and an archive already in the library
 * must agree exactly with the backup's inventory and preserved files, or the whole restore is rejected. */
export class RestoreMerge {
  private readonly tx: SqlConnection;
  private before: Counts | null = null;
  private current: Source | null = null;
  private sourcesUpdated = 0;
  private filesPreserved = 0;
  private objectRows: [string, number][] = [];
  private associations: [string, string, string][] = [];
  private favorites: string[] = [];

  constructor(tx: SqlConnection) { this.tx = tx; }

  private async counts(): Promise<Counts> {
    const row = await this.tx.getFirstAsync<Counts>(`SELECT
      (SELECT count(DISTINCT memory_id) FROM memory_objects WHERE role!='overlay') AS base,
      (SELECT count(*) FROM memory_objects) AS associations,
      (SELECT count(*) FROM stored_objects) AS objects,
      (SELECT count(*) FROM library_favorites) AS favorites,
      (SELECT count(*) FROM import_jobs) AS jobs,
      (SELECT count(*) FROM import_items WHERE state='done') AS done`);
    check(row, 'restore-failed'); return row;
  }

  async begin(): Promise<void> {
    const version = await this.tx.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
    check(version?.user_version === LIBRARY_SCHEMA_VERSION, 'restore-schema-unsupported');
    this.before = await this.counts();
  }

  async apply(record: ValidRecord): Promise<void> {
    check(this.before, 'restore-failed');
    switch (record.type) {
      case 'object':
        this.objectRows.push([record.sha256, record.bytes]);
        if (this.objectRows.length >= BATCH) await this.flushObjects();
        return;
      case 'source':
        await this.flushObjects(); await this.closeSource();
        return this.openSource({ kind: 'zip', hash: record.archiveSha256, written: record.archiveSha256, saved: record.saved, inventory: record.inventory, ordinals: null });
      case 'folder': {
        await this.flushObjects(); await this.closeSource();
        // Folder jobs are stored in canonical order under their canonical key, whatever order the backup listed them in.
        const listed = record.saved.preview.sources[0]!, canonical = canonicalFolderSource(listed), key = folderInventoryHash(listed);
        const position = new Map(canonical.files.map((file, ordinal) => [file.relativePath, ordinal]));
        const inventory = encodePreview({ preview: mergeSourceInventories([], canonical), sourceIds: new Map([[`folder:${key}`, canonical.sourceId]]) });
        return this.openSource({ kind: 'folder', hash: key, written: record.inventorySha256, saved: decodePreview(inventory), inventory,
          ordinals: listed.files.map(file => position.get(file.relativePath)!) });
      }
      case 'preserved': return this.observe(record.archiveSha256, record);
      case 'folder-preserved': return this.observe(record.inventorySha256, record);
      case 'favorite':
        await this.closeSource();
        this.favorites.push(record.memoryId);
        if (this.favorites.length >= BATCH) await this.flushFavorites();
        return;
    }
  }

  /** Stored-object rows: inserted if absent; an existing row must describe the same bytes. */
  private async flushObjects() {
    const rows = this.objectRows; this.objectRows = [];
    if (!rows.length) return;
    await this.tx.runAsync(`INSERT INTO stored_objects(hash,relative_path,bytes) VALUES ${rows.map(() => '(?,?,?)').join(',')} ON CONFLICT(hash) DO NOTHING`,
      ...rows.flatMap(([hash, bytes]) => [hash, `objects/${hash.slice(0, 2)}/${hash}`, bytes]));
    const stored = await this.tx.getAllAsync<{ hash: string; bytes: number; relative_path: string }>(
      `SELECT hash,bytes,relative_path FROM stored_objects WHERE hash IN (${rows.map(() => '?').join(',')})`, ...rows.map(([hash]) => hash));
    const byHash = new Map(stored.map(row => [row.hash, row]));
    for (const [hash, bytes] of rows) {
      const row = byHash.get(hash);
      check(row && row.bytes === bytes && row.relative_path === `objects/${hash.slice(0, 2)}/${hash}`);
    }
  }

  private async openSource(record: SourceRecord) {
    const files = record.saved.preview.sources[0]!.files;
    const backupItems: Item[] = files.map(file => ({ relativePath: file.relativePath, memoryId: file.memorySourceId, role: file.role,
      dateJson: JSON.stringify(file.captureDate), state: 'pending', objectHash: null }));
    const job = await this.tx.getFirstAsync<{ state: string; plan_json: string; kind: string }>('SELECT state,plan_json,kind FROM import_jobs WHERE hash=?', record.hash);
    if (!job) { this.current = { kind: record.kind, hash: record.hash, isNew: true, state: 'planned', items: backupItems, plan: record.inventory, source: record, completed: 0 }; return; }
    check(job.kind === record.kind); // A ZIP and a folder never share a job, even if their keys collided.
    // Same archive bytes must mean the same evidence. Compare the whole codec-normalized inventory, metadata included,
    // ignoring only the per-device label; the existing plan is kept, so anything the backup adds would otherwise be lost.
    let existingSource: SourceInventory;
    try { existingSource = decodePreview(job.plan_json).preview.sources[0]!; } catch { throw new RestoreError('restore-conflict'); }
    const evidence = (source: SourceInventory) => sourceEvidence(record.kind === 'folder' ? canonicalFolderSource(source) : source);
    check(evidence(existingSource) === evidence(record.saved.preview.sources[0]!));
    const existing = await this.tx.getAllAsync<{ ordinal: number; relative_path: string; memory_id: string; role: string; date_json: string; state: 'pending' | 'done'; object_hash: string | null }>(
      'SELECT ordinal,relative_path,memory_id,role,date_json,state,object_hash FROM import_items WHERE job_hash=? ORDER BY ordinal', record.hash);
    check(existing.length === backupItems.length);
    const items = existing.map((row, index) => {
      const mine = backupItems[index]!;
      check(row.ordinal === index && row.relative_path === mine.relativePath && row.memory_id === mine.memoryId && row.role === mine.role && row.date_json === mine.dateJson);
      return { ...mine, state: row.state, objectHash: row.object_hash };
    });
    this.current = { kind: record.kind, hash: record.hash, isNew: false, state: job.state, items, plan: job.plan_json, source: record, completed: 0 };
  }

  private async observe(hash: string, record: Extract<ValidRecord, { type: 'preserved' | 'folder-preserved' }>) {
    const source = this.current;
    check(source && source.source.written === hash && source.kind === (record.type === 'preserved' ? 'zip' : 'folder'), 'restore-failed');
    const ordinal = source.source.ordinals ? source.source.ordinals[record.ordinal] : record.ordinal;
    check(ordinal !== undefined, 'restore-failed');
    const item = source.items[ordinal];
    check(item && item.memoryId === record.memoryId && item.role === record.role, 'restore-failed');
    if (item.state === 'done') {
      // Completed work never changes: the same file must already be preserved with the same bytes.
      check(item.objectHash === record.sha256);
    } else {
      item.state = 'done'; item.objectHash = record.sha256; source.completed++;
      if (!source.isNew) await this.tx.runAsync("UPDATE import_items SET state='done',object_hash=? WHERE job_hash=? AND ordinal=? AND state='pending'", record.sha256, source.hash, ordinal);
    }
    this.associations.push([record.memoryId, record.role, record.sha256]);
    if (this.associations.length >= BATCH) await this.flushAssociations();
  }

  private async closeSource() {
    const source = this.current; this.current = null;
    if (!source) return;
    const pending = source.items.some(item => item.state === 'pending');
    const done = source.items.some(item => item.state === 'done');
    if (source.isNew) {
      const state = !pending ? 'completed' : done ? 'paused' : 'planned';
      await this.tx.runAsync('INSERT INTO import_jobs(hash,state,plan_json,kind) VALUES (?,?,?,?)', source.hash, state, source.plan, source.kind);
      for (let index = 0; index < source.items.length; index += BATCH) {
        const slice = source.items.slice(index, index + BATCH);
        await this.tx.runAsync(`INSERT INTO import_items(job_hash,ordinal,relative_path,memory_id,role,date_json,state,object_hash) VALUES ${slice.map(() => '(?,?,?,?,?,?,?,?)').join(',')}`,
          ...slice.flatMap((item, offset) => [source.hash, index + offset, item.relativePath, item.memoryId, item.role, item.dateJson, item.state, item.objectHash]));
      }
      await indexDates(this.tx, source.source.saved.preview.sources[0]!);
    } else if (source.completed > 0) {
      this.sourcesUpdated++;
      // Only ever forward: planned work with preserved files is paused (resumable); nothing pending is completed.
      const state = !pending ? 'completed' : source.state === 'planned' ? 'paused' : source.state;
      if (state !== source.state) await this.tx.runAsync('UPDATE import_jobs SET state=? WHERE hash=?', state, source.hash);
    }
    this.filesPreserved += source.completed;
    await this.flushAssociations();
  }

  private async flushAssociations() {
    const rows = this.associations; this.associations = [];
    if (!rows.length) return;
    const memories = [...new Set(rows.map(([memory]) => memory))];
    await this.tx.runAsync(`INSERT OR IGNORE INTO memories(id) VALUES ${memories.map(() => '(?)').join(',')}`, ...memories);
    await this.tx.runAsync(`INSERT OR IGNORE INTO memory_objects(memory_id,role,object_hash) VALUES ${rows.map(() => '(?,?,?)').join(',')}`, ...rows.flat());
  }

  private async flushFavorites() {
    const rows = this.favorites; this.favorites = [];
    if (!rows.length) return;
    await this.tx.runAsync(`INSERT OR IGNORE INTO library_favorites(memory_id) VALUES ${rows.map(() => '(?)').join(',')}`, ...rows);
  }

  /** Flushes everything, re-checks the library invariants the exporter relies on, and reports the changes. */
  async finish(): Promise<RestoreChanges> {
    check(this.before, 'restore-failed');
    await this.flushObjects(); await this.closeSource(); await this.flushAssociations(); await this.flushFavorites();
    // The same consistency rules writeBackupSnapshot enforces, so a restored library can always be exported.
    check(!await this.tx.getFirstAsync(`SELECT 1 FROM memory_objects m WHERE NOT EXISTS (
      SELECT 1 FROM import_items i WHERE i.state='done' AND i.memory_id=m.memory_id AND i.role=m.role AND i.object_hash=m.object_hash) LIMIT 1`), 'restore-failed');
    check(!await this.tx.getFirstAsync(`SELECT 1 FROM library_favorites f WHERE NOT EXISTS (
      SELECT 1 FROM memory_objects m WHERE m.memory_id=f.memory_id AND m.role!='overlay') LIMIT 1`), 'restore-failed');
    check(!await this.tx.getFirstAsync(`SELECT 1 FROM import_items i WHERE i.state='done' AND NOT EXISTS (
      SELECT 1 FROM stored_objects o WHERE o.hash=i.object_hash) LIMIT 1`), 'restore-failed');
    const after = await this.counts(), before = this.before;
    return {
      memoriesAdded: after.base - before.base, associationsAdded: after.associations - before.associations,
      objectsAdded: after.objects - before.objects, favoritesAdded: after.favorites - before.favorites,
      sourcesAdded: after.jobs - before.jobs, sourcesUpdated: this.sourcesUpdated, filesPreserved: this.filesPreserved,
    };
  }
}
