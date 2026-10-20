import type { SqlDatabase } from '../storage/previewStore.ts';
import { decodePreview, encodePreview, MAX_PREVIEW_CHARS } from '../storage/previewCodec.ts';
import { validateReceipt, type JobKind, type Receipt } from '../storage/importStore.ts';
import { listedFolderHash } from '../import/sourceEvidence.ts';

export const MAX_MANIFEST_BYTES = 128 * 1024 * 1024;
export const MAX_BACKUP_OBJECTS = 100_000;
export const MAX_BACKUP_BYTES = 64 * 1024 ** 3;
/** The library schema this format covers. A new migration must extend the snapshot (and this) first. */
export const BACKUP_SCHEMA_VERSION = 5;
/** Version 1 has ZIP sources only; version 2 adds extracted-folder sources (section 21). The writer uses version 1
 * whenever the library has no folder job, so those backups stay readable by version-1 readers. */
export const BACKUP_FORMAT_VERSION = 2;
/** Rows per query: each query is a native round trip inside the exclusive transaction. */
const BATCH = 500;
/** The sink writes to private staging, never directly to a user-visible completed backup.
 * object() spools the same object catalog for the native ZIP writer. Neither method finalizes it. */
export interface SnapshotSink {
  line(jsonLine: string): Promise<void>;
  object(receipt: Receipt): Promise<void>;
}
function check(ok: unknown): asserts ok { if (!ok) throw new Error('invalid-backup-snapshot'); }
// JSON.stringify escapes lone surrogates; count UTF-8 without a Node/DOM dependency on mobile.
function utf8Bytes(text: string): number {
  let bytes = 0;
  for (const char of text) { const point = char.codePointAt(0)!; bytes += point < 128 ? 1 : point < 2048 ? 2 : point < 65536 ? 3 : 4; }
  return bytes;
}

/** One database snapshot; only immutable object files are read after this transaction ends.
 * Streams records, retaining at most one validated source plan in JS memory. */
export async function writeBackupSnapshot(db: SqlDatabase, sink: SnapshotSink, cancelled: () => boolean = () => false): Promise<void> {
  let bytes = 0, records = 0, objects = 0, originalBytes = 0;
  const stop = () => { if (cancelled()) throw new Error('cancelled'); };
  const emit = async (value: object) => {
    stop(); const line = JSON.stringify(value) + '\n'; bytes += utf8Bytes(line);
    check(bytes <= MAX_MANIFEST_BYTES && ++records <= 1_000_000);
    await sink.line(line); stop();
  };
  await db.withExclusiveTransactionAsync(async tx => {
    if ((await tx.getFirstAsync<{ user_version: number }>('PRAGMA user_version'))?.user_version !== BACKUP_SCHEMA_VERSION) throw new Error('backup-schema-unsupported');
    // Refuse a lossy snapshot if an association cannot be traced back to its preserved observation.
    check(!await tx.getFirstAsync(`SELECT 1 FROM memory_objects m WHERE NOT EXISTS (
      SELECT 1 FROM import_items i WHERE i.state='done' AND i.memory_id=m.memory_id AND i.role=m.role AND i.object_hash=m.object_hash) LIMIT 1`));
    check(!await tx.getFirstAsync(`SELECT 1 FROM library_favorites f WHERE NOT EXISTS (
      SELECT 1 FROM memory_objects m WHERE m.memory_id=f.memory_id AND m.role!='overlay') LIMIT 1`));
    check(!await tx.getFirstAsync('SELECT 1 FROM import_items i WHERE NOT EXISTS (SELECT 1 FROM import_jobs j WHERE j.hash=i.job_hash) LIMIT 1'));
    const folders = !!await tx.getFirstAsync("SELECT 1 FROM import_jobs WHERE kind='folder' LIMIT 1");
    check(!await tx.getFirstAsync("SELECT 1 FROM import_jobs WHERE kind NOT IN ('zip','folder') LIMIT 1"));
    await emit({ type: 'header', format: 'snarchive-backup', version: folders ? 2 : 1 });
    let after = '';
    while (true) {
      stop();
      const rows = await tx.getAllAsync<Receipt>(`SELECT hash AS sha256,relative_path AS relativePath,bytes FROM stored_objects WHERE hash>? ORDER BY hash LIMIT ${BATCH}`, after);
      for (const row of rows) {
        validateReceipt(row); originalBytes += row.bytes;
        check(++objects <= MAX_BACKUP_OBJECTS && originalBytes <= MAX_BACKUP_BYTES);
        await emit({ type: 'object', ...row }); await sink.object(row); after = row.sha256;
      }
      if (rows.length < BATCH) break;
    }
    // ZIP sources, then folder sources, each in hash order with its preserved observations.
    for (const kind of ['zip', 'folder'] as JobKind[]) {
      after = '';
      while (true) {
        stop();
        const info = await tx.getFirstAsync<{ hash: string; size: number }>('SELECT hash,length(plan_json) AS size FROM import_jobs WHERE kind=? AND hash>? ORDER BY hash LIMIT 1', kind, after);
        if (!info) break;
        check(/^[a-f0-9]{64}$/.test(info.hash) && info.size <= MAX_PREVIEW_CHARS);
        const row = await tx.getFirstAsync<{ plan_json: string }>('SELECT plan_json FROM import_jobs WHERE hash=?', info.hash); check(row);
        const saved = decodePreview(row.plan_json);
        check(saved.sourceIds.size === 1 && saved.sourceIds.has(`${kind}:${info.hash}`));
        const source = saved.preview.sources[0]!;
        // A folder job's key must be the hash of its inventory as written, so a reader can verify the record. Jobs are in
        // canonical order (schema 5); one kept in listing order by that migration is written as it is, and still checks.
        if (kind === 'folder') check(listedFolderHash(source) === info.hash);
        // Re-encode allowlisted fields, stripping anything outside the saved-preview schema.
        const inventory = JSON.parse(encodePreview(saved));
        await emit(kind === 'zip' ? { type: 'source', archiveSha256: info.hash, inventory } : { type: 'folder', inventorySha256: info.hash, inventory });
        let ordinal = -1;
        while (true) {
          stop();
          const items = await tx.getAllAsync<{ ordinal: number; relative_path: string; memory_id: string; role: string; object_hash: string | null; state: string; bytes: number | null; linked: number }>(`SELECT i.ordinal,i.relative_path,i.memory_id,i.role,i.object_hash,i.state,o.bytes,
            EXISTS(SELECT 1 FROM memory_objects m WHERE m.memory_id=i.memory_id AND m.role=i.role AND m.object_hash=i.object_hash) AS linked
            FROM import_items i LEFT JOIN stored_objects o ON o.hash=i.object_hash WHERE job_hash=? AND ordinal>? ORDER BY ordinal LIMIT ${BATCH}`, info.hash, ordinal);
          for (const item of items) {
            check(item.ordinal === ordinal + 1);
            const file = source.files[item.ordinal];
            check(file && file.relativePath === item.relative_path && file.memorySourceId === item.memory_id && file.role === item.role);
            if (item.state === 'done') {
              check(item.object_hash && /^[a-f0-9]{64}$/.test(item.object_hash) && item.bytes !== null && item.linked === 1);
              await emit(kind === 'zip'
                ? { type: 'preserved', archiveSha256: info.hash, ordinal: item.ordinal, memoryId: item.memory_id, role: item.role, sha256: item.object_hash }
                : { type: 'folder-preserved', inventorySha256: info.hash, ordinal: item.ordinal, memoryId: item.memory_id, role: item.role, sha256: item.object_hash });
            } else check(item.state === 'pending' && item.object_hash === null);
            ordinal = item.ordinal;
          }
          if (items.length < BATCH) break;
        }
        check(ordinal + 1 === source.files.length); after = info.hash;
      }
    }
    after = '';
    while (true) {
      stop(); const rows = await tx.getAllAsync<{ memory_id: string }>(`SELECT memory_id FROM library_favorites WHERE memory_id>? ORDER BY memory_id LIMIT ${BATCH}`, after);
      for (const row of rows) { await emit({ type: 'favorite', memoryId: row.memory_id }); after = row.memory_id; }
      if (rows.length < BATCH) break;
    }
    await emit({ type: 'end', records, objects, originalBytes });
  });
}
