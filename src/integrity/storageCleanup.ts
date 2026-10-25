import { lockObjectReferences } from '../storage/referenceLock.ts';
import type { SqlConnection, SqlDatabase } from '../storage/previewStore.ts';
import { LIBRARY_SCHEMA_VERSION } from '../storage/importStore.ts';

/** object: a file at objects/xx/hash. quarantine: a damaged copy kept by repair (quarantine/hash-millis-random.damaged). */
export type StorageKind = 'object' | 'quarantine';
/** A listed file. identity pins the exact file (file key, length, modification time); removal refuses any other. */
export type StorageEntry = { kind: StorageKind; path: string; hash: string; bytes: number; modified: number; identity: string };
type Result = { ok: boolean; code?: string };
/** The native side (Android). Lists and removes files only; it never decides that an object is unreferenced. */
export interface StorageBridge {
  /** scan: read-only. cleanup: also takes the store's cross-process writer lock until the session ends. Both hold the
   * shared operation guard, so no import, backup, restore, repair or check can run meanwhile. */
  beginStorageReview(mode: 'scan' | 'cleanup'): Promise<Result>;
  reviewStoragePage(kind: StorageKind, after: string, limit: number): Promise<Result & { entries?: StorageEntry[]; next?: string | null; unrecognized?: number }>;
  removeStorageEntry(kind: StorageKind, path: string, identity: string): Promise<Result & { outcome?: 'removed' | 'skipped'; reason?: string | null; warning?: string | null }>;
  endStorageReview(): Promise<Result>;
}
export class StorageReviewFailure extends Error {
  readonly cleanupFailed: boolean;
  constructor(code: string, cleanupFailed = false) { super(code); this.cleanupFailed = cleanupFailed; }
}
/** uncatalogued: object files no library table refers to. catalogued: object files the library refers to (protected,
 * never listed). unrecognized: other entries in those directories, which can never be selected. */
export type StorageReviewResult = { uncatalogued: StorageEntry[]; quarantine: StorageEntry[]; catalogued: number; unrecognized: number; cleanupFailed: boolean };
const PAGE = 500, QUERY = 200;

/** Any other schema is refused: this code knows which tables can refer to an object only for this version. */
async function requireSchema(db: SqlConnection | SqlDatabase): Promise<void> {
  const version = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  if (version?.user_version !== LIBRARY_SCHEMA_VERSION) throw new Error('storage-schema-unsupported');
}

/** The object hashes among these that anything in the library refers to: a catalog row (by hash, or by its path, in case
 * the two disagree), a memory association, or an import observation in any state. Absence of one kind of row never
 * makes another kind irrelevant. A failing query throws, so the caller fails closed. */
export async function referencedObjects(db: SqlConnection | SqlDatabase, hashes: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  for (let start = 0; start < hashes.length; start += QUERY) {
    const slice = hashes.slice(start, start + QUERY), marks = slice.map(() => '?').join(',');
    const byPath = new Map(slice.map(hash => [`objects/${hash.slice(0, 2)}/${hash}`, hash]));
    const catalog = await db.getAllAsync<{ hash: string; relative_path: string }>(
      `SELECT hash,relative_path FROM stored_objects WHERE hash IN (${marks}) OR relative_path IN (${marks})`, ...slice, ...byPath.keys());
    for (const row of catalog) { if (slice.includes(row.hash)) out.add(row.hash); const pathHash = byPath.get(row.relative_path); if (pathHash) out.add(pathHash); }
    for (const table of ['memory_objects', 'import_items']) {
      const rows = await db.getAllAsync<{ object_hash: string }>(`SELECT DISTINCT object_hash FROM ${table} WHERE object_hash IN (${marks})`, ...slice);
      for (const row of rows) out.add(row.object_hash);
    }
  }
  return out;
}

/** Lists removable candidates, read-only. Object files are kept only if no library table refers to them; quarantine
 * copies are all listed (nothing refers to them). Nothing is selected or removed here. */
export async function reviewStorage(db: SqlDatabase, bridge: StorageBridge, cancelled: () => boolean,
  progress: (listed: number) => void): Promise<StorageReviewResult> {
  try { await requireSchema(db); } catch { throw new StorageReviewFailure('storage-schema-unsupported'); }
  const began = await bridge.beginStorageReview('scan');
  if (!began.ok) throw new StorageReviewFailure(began.code ?? 'storage-review-failed');
  const result: StorageReviewResult = { uncatalogued: [], quarantine: [], catalogued: 0, unrecognized: 0, cleanupFailed: false };
  let failure: unknown = null;
  try {
    for (const kind of ['object', 'quarantine'] as const) {
      for (let after = ''; ;) {
        if (cancelled()) throw new Error('cancelled');
        const page = await bridge.reviewStoragePage(kind, after, PAGE);
        if (!page.ok || !page.entries) throw new Error(page.code ?? 'storage-review-failed');
        result.unrecognized += page.unrecognized ?? 0;
        if (kind === 'object') {
          let referenced: Set<string>;
          try { referenced = await referencedObjects(db, page.entries.map(entry => entry.hash)); } catch { throw new Error('library-check-failed'); }
          for (const entry of page.entries) { if (referenced.has(entry.hash)) result.catalogued++; else result.uncatalogued.push(entry); }
        } else result.quarantine.push(...page.entries);
        progress(result.uncatalogued.length + result.quarantine.length + result.catalogued);
        if (!page.next) break;
        after = page.next;
      }
    }
  } catch (error) { failure = error; }
  const ended = await bridge.endStorageReview().catch(() => ({ ok: false }));
  if (failure) throw new StorageReviewFailure(cancelled() ? 'cancelled' : failure instanceof Error ? failure.message : 'storage-review-failed', !ended.ok);
  result.cleanupFailed = !ended.ok;
  return result;
}

/** Per path: removed (with any warning: "sync-failed" means the file is gone but the directory sync failed); skipped
 * (reason "referenced": the library now refers to it; "missing"/"changed": not the file that was listed); failed (code,
 * file left as it was); notAttempted (the run stopped first: stopped holds the reason). */
export type CleanupReport = {
  removed: string[]; skipped: { path: string; reason: string }[]; failed: { path: string; code: string }[]; notAttempted: string[];
  warnings: { path: string; code: string }[]; stopped: string | null; cleanupFailed: boolean; bytesListed: number;
};
/** Failures of one entry; the next selected entry is still tried. Anything else stops the run. */
const PER_ENTRY = new Set(['unsafe-path', 'unsafe-storage-path', 'inaccessible', 'delete-failed', 'invalid-entry']);

/** Removes exactly the selected entries, one at a time, never others. For each, inside one exclusive database
 * transaction that stays open until the native removal returns (so no other connection can add a reference in
 * between): the schema is checked, an object is re-proved unreferenced, then native code re-validates the exact file
 * and removes it while holding the store's writer lock for the whole session. Nothing in the library changes. */
export async function removeSelected(db: SqlDatabase, bridge: StorageBridge, selection: readonly StorageEntry[],
  cancelled: () => boolean, progress: (done: number, total: number) => void): Promise<CleanupReport> {
  if (cancelled()) throw new StorageReviewFailure('cancelled');
  const began = await bridge.beginStorageReview('cleanup');
  if (!began.ok) throw new StorageReviewFailure(cancelled() ? 'cancelled' : began.code ?? 'storage-review-failed');
  const report: CleanupReport = { removed: [], skipped: [], failed: [], notAttempted: [], warnings: [], stopped: null, cleanupFailed: false,
    bytesListed: selection.reduce((n, entry) => n + entry.bytes, 0) };
  const stop = (code: string, index: number) => { report.stopped = cancelled() ? 'cancelled' : code; report.notAttempted.push(...selection.slice(index).map(entry => entry.path)); };
  try {
    for (const [index, entry] of selection.entries()) {
      progress(index, selection.length);
      if (cancelled()) { stop('cancelled', index); break; }
      let result: Awaited<ReturnType<StorageBridge['removeStorageEntry']>> | { ok: true; outcome: 'skipped'; reason: 'referenced' } | null = null;
      let proved = false;
      try {
        await db.withExclusiveTransactionAsync(async tx => {
          await lockObjectReferences(tx);
          await requireSchema(tx);
          if (entry.kind === 'object' && (await referencedObjects(tx, [entry.hash])).size > 0) { result = { ok: true, outcome: 'skipped', reason: 'referenced' }; return; }
          proved = true;
          result = await bridge.removeStorageEntry(entry.kind, entry.path, entry.identity);
        });
      } catch (error) {
        // A native result already obtained stands (the file may be gone). Otherwise either the proof failed (fail closed)
        // or the removal call itself was rejected; both stop the run with the rest untouched.
        if (!result) {
          stop(proved ? 'storage-review-failed' : error instanceof Error && error.message === 'storage-schema-unsupported' ? error.message : 'library-check-failed', index);
          break;
        }
      }
      const done = result as Awaited<ReturnType<StorageBridge['removeStorageEntry']>> | null;
      if (done?.ok && done.outcome === 'removed') { report.removed.push(entry.path); if (done.warning) report.warnings.push({ path: entry.path, code: done.warning }); continue; }
      if (done?.ok && done.outcome === 'skipped') { report.skipped.push({ path: entry.path, reason: done.reason ?? 'changed' }); continue; }
      const code = cancelled() ? 'cancelled' : done?.code ?? 'storage-review-failed';
      if (PER_ENTRY.has(code)) { report.failed.push({ path: entry.path, code }); continue; }
      stop(code, index); break;
    }
    progress(selection.length - report.notAttempted.length, selection.length);
  } finally {
    if (!(await bridge.endStorageReview().catch(() => ({ ok: false }))).ok) report.cleanupFailed = true;
  }
  return report;
}
