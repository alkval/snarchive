import type { SqlDatabase } from '../storage/previewStore.ts';
import { decodePreview, encodePreview, MAX_PREVIEW_CHARS } from '../storage/previewCodec.ts';
import { validateReceipt, type Receipt } from '../storage/importStore.ts';

export const MAX_MANIFEST_BYTES = 128 * 1024 * 1024;
export const MAX_BACKUP_OBJECTS = 100_000;
export const MAX_BACKUP_BYTES = 64 * 1024 ** 3;
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
    check((await tx.getFirstAsync<{ user_version: number }>('PRAGMA user_version'))?.user_version === 3);
    // Refuse a lossy snapshot if an association cannot be traced back to its preserved observation.
    check(!await tx.getFirstAsync(`SELECT 1 FROM memory_objects m WHERE NOT EXISTS (
      SELECT 1 FROM import_items i WHERE i.state='done' AND i.memory_id=m.memory_id AND i.role=m.role AND i.object_hash=m.object_hash) LIMIT 1`));
    check(!await tx.getFirstAsync(`SELECT 1 FROM library_favorites f WHERE NOT EXISTS (
      SELECT 1 FROM memory_objects m WHERE m.memory_id=f.memory_id AND m.role!='overlay') LIMIT 1`));
    check(!await tx.getFirstAsync('SELECT 1 FROM import_items i WHERE NOT EXISTS (SELECT 1 FROM import_jobs j WHERE j.hash=i.job_hash) LIMIT 1'));
    await emit({ type: 'header', format: 'snarchive-backup', version: 1 });
    let after = '';
    while (true) {
      stop();
      const row = await tx.getFirstAsync<Receipt>(`SELECT hash AS sha256,relative_path AS relativePath,bytes FROM stored_objects WHERE hash>? ORDER BY hash LIMIT 1`, after);
      if (!row) break;
      validateReceipt(row); originalBytes += row.bytes;
      check(++objects <= MAX_BACKUP_OBJECTS && originalBytes <= MAX_BACKUP_BYTES);
      await emit({ type: 'object', ...row }); await sink.object(row); after = row.sha256;
    }
    after = '';
    while (true) {
      stop();
      const info = await tx.getFirstAsync<{ hash: string; size: number }>('SELECT hash,length(plan_json) AS size FROM import_jobs WHERE hash>? ORDER BY hash LIMIT 1', after);
      if (!info) break;
      check(/^[a-f0-9]{64}$/.test(info.hash) && info.size <= MAX_PREVIEW_CHARS);
      const row = await tx.getFirstAsync<{ plan_json: string }>('SELECT plan_json FROM import_jobs WHERE hash=?', info.hash); check(row);
      const saved = decodePreview(row.plan_json);
      check(saved.sourceIds.size === 1 && saved.sourceIds.has(`zip:${info.hash}`));
      const source = saved.preview.sources[0]!;
      // Re-encode allowlisted fields, stripping anything outside the saved-preview schema.
      await emit({ type: 'source', archiveSha256: info.hash, inventory: JSON.parse(encodePreview(saved)) });
      let ordinal = -1;
      while (true) {
        stop();
        const item = await tx.getFirstAsync<{ ordinal: number; relative_path: string; memory_id: string; role: string; object_hash: string | null; state: string; bytes: number | null }>(`SELECT i.*,o.bytes FROM import_items i LEFT JOIN stored_objects o ON o.hash=i.object_hash WHERE job_hash=? AND ordinal>? ORDER BY ordinal LIMIT 1`, info.hash, ordinal);
        if (!item) break;
        check(item.ordinal === ordinal + 1);
        const file = source.files[item.ordinal];
        check(file && file.relativePath === item.relative_path && file.memorySourceId === item.memory_id && file.role === item.role);
        if (item.state === 'done') {
          check(item.object_hash && /^[a-f0-9]{64}$/.test(item.object_hash) && item.bytes !== null);
          check(await tx.getFirstAsync('SELECT 1 FROM memory_objects WHERE memory_id=? AND role=? AND object_hash=?', item.memory_id, item.role, item.object_hash));
          await emit({ type: 'preserved', archiveSha256: info.hash, ordinal: item.ordinal, memoryId: item.memory_id, role: item.role, sha256: item.object_hash });
        } else check(item.state === 'pending' && item.object_hash === null);
        ordinal = item.ordinal;
      }
      check(ordinal + 1 === source.files.length); after = info.hash;
    }
    after = '';
    while (true) {
      stop(); const row = await tx.getFirstAsync<{ memory_id: string }>('SELECT memory_id FROM library_favorites WHERE memory_id>? ORDER BY memory_id LIMIT 1', after);
      if (!row) break;
      await emit({ type: 'favorite', memoryId: row.memory_id }); after = row.memory_id;
    }
    await emit({ type: 'end', records, objects, originalBytes });
  });
}
