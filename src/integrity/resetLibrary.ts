import { lockObjectReferences } from '../storage/referenceLock.ts';
import { LIBRARY_SCHEMA_VERSION } from '../storage/importStore.ts';
import type { SqlDatabase } from '../storage/previewStore.ts';
type Result = { ok: boolean; code?: string };
export interface ResetBridge {
  beginStorageReview(mode: 'cleanup'): Promise<Result>;
  clearLibraryFiles(): Promise<Result>;
  endStorageReview(): Promise<Result>;
}
export type ResetOutcome = { cleared: true; cleanupFailed: boolean };

/** The shared native guard and writer lock span the database commit AND cleanup. A crash or failed cleanup after
 * the commit leaves only unreferenced private files. No original export URI is ever passed to deletion. */
export async function resetLibrary(db: SqlDatabase, bridge: ResetBridge, clearPreview: () => Promise<void>): Promise<ResetOutcome> {
  const begin = await bridge.beginStorageReview('cleanup');
  if (!begin.ok) throw new Error(begin.code ?? 'storage-busy');
  let cleared = false, cleanupFailed = false;
  try {
    await db.withExclusiveTransactionAsync(async tx => {
      const version = await tx.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
      if (version?.user_version !== LIBRARY_SCHEMA_VERSION) throw new Error('storage-schema-unsupported');
      for (const table of ['memory_objects', 'import_items', 'import_jobs', 'library_favorites', 'library_dates', 'memories', 'stored_objects', 'memory_deletions']) {
        await tx.runAsync(`DELETE FROM ${table}`);
      }
    });
    cleared = true;
    try { await clearPreview(); } catch { cleanupFailed = true; }
    try {
      // Commit empty metadata first for crash safety. Then reserve the database writer before re-reading
      // references and hold it through unlink, so another connection cannot invalidate the proof.
      await db.withExclusiveTransactionAsync(async tx => {
        await lockObjectReferences(tx);
        const version = await tx.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
        if (version?.user_version !== LIBRARY_SCHEMA_VERSION) throw new Error('storage-schema-unsupported');
        const referenced = await tx.getFirstAsync(`SELECT 1 WHERE EXISTS(SELECT 1 FROM stored_objects)
          OR EXISTS(SELECT 1 FROM memory_objects) OR EXISTS(SELECT 1 FROM import_items WHERE object_hash IS NOT NULL)`);
        if (referenced) throw new Error('reset-library-changed');
        if (!(await bridge.clearLibraryFiles()).ok) cleanupFailed = true;
      });
    } catch { cleanupFailed = true; }
  } finally {
    // Cleanup cannot replace an unsuccessful database operation or turn a committed reset into an unchanged failure.
    if (!(await bridge.endStorageReview().catch(() => ({ ok: false }))).ok && cleared) cleanupFailed = true;
  }
  return { cleared: true, cleanupFailed };
}
