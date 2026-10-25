import type { ImportStore } from '../storage/importStore.ts';
import { removeSelected, type StorageBridge, type StorageEntry } from './storageCleanup.ts';
export interface MemoryDeleteBridge extends StorageBridge { evictStorageThumbnail(hash: string): Promise<{ ok: boolean; code?: string }>; }
export class MemoryDeleteFailure extends Error {
  readonly cleanupFailed: boolean;
  constructor(code: string, cleanupFailed: boolean, cause: unknown) { super(code, { cause }); this.cleanupFailed = cleanupFailed; }
}
export type DeleteOutcome = { deleted: true; cleanupFailed: boolean };
/** Commit the user's deletion before unlinking anything. A crash can leave an unused file, never a live row whose
 * file we removed. The existing storage remover re-proves every reference after reacquiring its native guard. */
export async function deleteLibraryMemory(store: ImportStore, bridge: MemoryDeleteBridge, id: string): Promise<DeleteOutcome> {
  const begin = await bridge.beginStorageReview('cleanup');
  if (!begin.ok) throw new Error(begin.code ?? 'storage-busy');
  let deleted = false, cleanupFailed = false, failure: unknown = null;
  const entries: StorageEntry[] = [], hashes = new Set<string>();
  try {
    const candidates = await store.deleteMemory(id); deleted = true;
    const paths = new Set(candidates.map(object => object.relativePath)); candidates.forEach(object => hashes.add(object.sha256));
    for (let after = ''; paths.size;) {
      const page = await bridge.reviewStoragePage('object', after, 500);
      if (!page.ok || !page.entries) { cleanupFailed = true; break; }
      for (const entry of page.entries) if (paths.delete(entry.path)) entries.push(entry);
      if (!page.next) break;
      if (page.next === after) { cleanupFailed = true; break; }
      after = page.next;
    }
  } catch (error) {
    if (!deleted) failure = error;
    else cleanupFailed = true;
  } finally {
    if (!(await bridge.endStorageReview().catch(() => ({ ok: false }))).ok) cleanupFailed = true;
  }
  if (failure) throw new MemoryDeleteFailure(failure instanceof Error ? failure.message : 'delete-failed', cleanupFailed, failure);
  if (!cleanupFailed && entries.length) {
    try {
      const report = await removeSelected(store.database, bridge, entries, () => false, () => {});
      cleanupFailed ||= !!(report.failed.length || report.notAttempted.length || report.warnings.length || report.cleanupFailed || report.skipped.some(item => item.reason === 'changed'));
    } catch { cleanupFailed = true; }
  }
  // Native cache eviction serializes with thumbnail creation. Do not leave derivatives of deleted, unshared bytes.
  if (hashes.size) {
    const opened = await bridge.beginStorageReview('cleanup').catch(() => ({ ok: false }));
    if (!opened.ok) cleanupFailed = true;
    else try { for (const hash of hashes) if (!(await bridge.evictStorageThumbnail(hash)).ok) cleanupFailed = true; }
    catch { cleanupFailed = true; }
    finally { if (!(await bridge.endStorageReview().catch(() => ({ ok: false }))).ok) cleanupFailed = true; }
  }
  return { deleted: true, cleanupFailed };
}
