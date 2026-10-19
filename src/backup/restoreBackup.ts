import type { SqlDatabase } from '../storage/previewStore.ts';
import { BackupManifestValidator, type BackupPreview } from './manifest.ts';
import { RestoreMerge, type RestoreChanges } from './restoreMerge.ts';

/** A failed step keeps its code; the flags say which cleanup also failed on its path (see RestoreFailure). */
type Result = { ok: boolean; code?: string; cleanupFailed?: boolean; storeCleanupFailed?: boolean };
export type StoreProgress = { stored: number; total: number; added: number; reused: number; bytes: number; totalBytes: number; done: boolean };
/** The native restore session (Android). Media bytes never cross this boundary. */
export interface RestoreBridge {
  /** Opens the chosen document in restore mode: pass 1 also keeps a private, hashed copy of the manifest. */
  beginBackupRestore(uri: string): Promise<Result & { inPlace?: boolean }>;
  readBackupManifest(): Promise<Result & { text?: string; done?: boolean }>;
  declareBackupObjects(hashes: string[], sizes: number[]): Promise<Result>;
  sealBackupInspection(): Promise<Result>;
  /** Clears abandoned store staging (failing with store-staging-cleanup-failed if a part cannot be removed) and
   * checks free space for the objects not already in the library. */
  prepareBackupRestore(): Promise<Result & { missingBytes?: number }>;
  /** Verifies and stores the next objects; an existing local object is re-hashed, never overwritten. */
  storeBackupObjects(): Promise<Result & Partial<StoreProgress>>;
  /** The manifest again, from the private copy, hash-checked against pass 1. */
  readStagedManifest(): Promise<Result & { text?: string; done?: boolean }>;
  endBackupInspection(): Promise<Result>;
}
export type RestoreProgress = { stage: 'validating' } | ({ stage: 'objects' } & StoreProgress) | { stage: 'merging' };
/** files: originals written by this restore vs already present (re-hashed and reused). */
export type RestoreOutcome = { preview: BackupPreview; changes: RestoreChanges; files: { added: number; reused: number }; inPlace: boolean; cleanupFailed: boolean };
/** A restore that did not commit: nothing in the library changed. Verified originals may remain in the
 * content-addressed store without any library reference; a later restore re-checks and reuses them.
 * cleanupFailed: a private ZIP or manifest copy could not be deleted. storeCleanupFailed: a partly written original
 * was left in the store's staging; it is never used, and the next restore or import tries to remove it again. */
export class RestoreFailure extends Error {
  readonly cleanupFailed: boolean;
  readonly storeCleanupFailed: boolean;
  constructor(code: string, cleanupFailed: boolean, storeCleanupFailed = false) {
    super(code); this.cleanupFailed = cleanupFailed; this.storeCleanupFailed = storeCleanupFailed;
  }
}

class StepFailure extends Error {
  readonly cleanupFailed: boolean;
  readonly storeCleanupFailed: boolean;
  constructor(result: Result) {
    super(result.code ?? 'backup-unreadable'); this.cleanupFailed = !!result.cleanupFailed; this.storeCleanupFailed = !!result.storeCleanupFailed;
  }
}
function checked<T extends Result>(result: T): T { if (!result.ok) throw new StepFailure(result); return result; }
const DECLARE_BATCH = 500;

/** Validates the backup again in this session, makes every object durable, then applies the whole manifest in one
 * exclusive transaction. The transaction commit is the only point where the library changes; a cancellation
 * after it is not honoured, and the committed result is reported. */
export async function runRestore(bridge: RestoreBridge, db: SqlDatabase, uri: string, cancelled: () => boolean,
  progress: (state: RestoreProgress) => void): Promise<RestoreOutcome> {
  const stop = () => { if (cancelled()) throw new Error('cancelled'); };
  const opened = await bridge.beginBackupRestore(uri);
  if (!opened.ok) throw new RestoreFailure(cancelled() ? 'cancelled' : opened.code ?? 'backup-unreadable', !!opened.cleanupFailed);
  let preview: BackupPreview, changes: RestoreChanges | null = null;
  const files = { added: 0, reused: 0 };
  try {
    // Pass 1: the full Section 19 validation, in this session, on the bytes being restored.
    progress({ stage: 'validating' });
    const validator = new BackupManifestValidator();
    for (;;) {
      stop();
      const chunk = checked(await bridge.readBackupManifest());
      validator.push(chunk.text ?? '');
      const declared = validator.takeDeclarations();
      for (let index = 0; index < declared.length; index += DECLARE_BATCH) {
        stop(); const slice = declared.slice(index, index + DECLARE_BATCH);
        checked(await bridge.declareBackupObjects(slice.map(([hash]) => hash), slice.map(([, bytes]) => bytes)));
      }
      if (chunk.done) break;
    }
    preview = validator.finish();
    stop(); checked(await bridge.sealBackupInspection());
    stop(); checked(await bridge.prepareBackupRestore());
    // Pass 2: every object becomes durable in the store (verified; existing ones re-hashed, never replaced).
    for (;;) {
      stop();
      const state = checked(await bridge.storeBackupObjects());
      const step = { stored: state.stored ?? 0, total: state.total ?? 0, added: state.added ?? 0, reused: state.reused ?? 0, bytes: state.bytes ?? 0, totalBytes: state.totalBytes ?? 0, done: !!state.done };
      files.added = step.added; files.reused = step.reused;
      progress({ stage: 'objects', ...step });
      if (step.done) break;
    }
    // Pass 3: the same validated bytes, re-validated, applied atomically. Only local reads happen inside.
    stop(); progress({ stage: 'merging' });
    let prepared: RestoreChanges | null = null;
    await db.withExclusiveTransactionAsync(async tx => {
      const merge = new RestoreMerge(tx); await merge.begin();
      const again = new BackupManifestValidator({ keepRecords: true });
      for (;;) {
        stop();
        const chunk = checked(await bridge.readStagedManifest());
        again.push(chunk.text ?? '');
        for (const record of again.takeRecords()) await merge.apply(record);
        if (chunk.done) break;
      }
      const second = again.finish();
      if (JSON.stringify(second) !== JSON.stringify(preview)) throw new Error('backup-damaged');
      const result = await merge.finish();
      stop(); // The last point at which cancellation is honoured: nothing has been committed yet.
      prepared = result;
    });
    // Only now has the transaction committed; a failed COMMIT throws above and leaves changes unset.
    changes = prepared;
  } catch (error) {
    const closed = await bridge.endBackupInspection().catch(() => ({ ok: false }));
    if (changes) return { preview: preview!, changes, files, inPlace: !!opened.inPlace, cleanupFailed: !closed.ok }; // Committed before failing.
    // The step's own code stays the reason; cleanup failures on its path and at close are reported beside it.
    const step = error instanceof StepFailure ? error : null;
    throw new RestoreFailure(cancelled() ? 'cancelled' : error instanceof Error ? error.message : 'backup-unreadable',
      !closed.ok || !!step?.cleanupFailed, !!step?.storeCleanupFailed);
  }
  const closed = await bridge.endBackupInspection().catch(() => ({ ok: false }));
  return { preview, changes: changes!, files, inPlace: !!opened.inPlace, cleanupFailed: !closed.ok };
}
