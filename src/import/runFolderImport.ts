import type { ImportStore, Receipt } from '../storage/importStore.ts';
import { encodePreview, decodePreview } from '../storage/previewCodec.ts';
import { folderInventoryHash } from './sourceEvidence.ts';
import { inventoryFromSnapshot, mergeSourceInventories, type DirectorySnapshot } from './sourceInventory.ts';

/** This run's scan of the reselected folder; sizes[i] is the provider-reported length of entries[i], or -1. */
export type FolderScan = DirectorySnapshot & { sizes: number[] };
/** A failed native step: its code, and whether a partly written original was left in the store's staging. */
export class FolderStepError extends Error {
  readonly storeCleanupFailed: boolean;
  constructor(code: string, storeCleanupFailed = false) { super(code); this.storeCleanupFailed = storeCleanupFailed; }
}
/** The native folder session (Android). Media bytes never cross this boundary. */
export interface FolderCopier {
  /** Scans the chosen tree again and keeps, natively, each file's document and provider facts for this run. */
  open(uri: string): Promise<FolderScan>;
  /** Checks free space for the pending files' reported sizes and sets the byte budget. */
  prepare(pending: string[], remaining: number): Promise<void>;
  preserve(path: string): Promise<Receipt>;
  confirm(hash: string, bytes: number): Promise<void>;
  close(): Promise<void>;
}
/** Per-file failures that leave the file pending for a later run; anything else stops the run. */
const RETRYABLE = new Set(['source-missing', 'source-changed', 'source-unreadable']);
export type FolderOutcome = {
  /** Files copied (or verified and reused) and committed by this run, and completed files confirmed. */
  preserved: number; confirmed: number;
  /** Files left pending: gone, changed while being read, or unreadable. A later run retries them. */
  skipped: { missing: number; changed: number; unreadable: number };
  /** Completed files whose current reported size differs from the preserved original; the original is kept. */
  changedSincePreserved: number;
  /** True when no file of the job remains pending. */
  complete: boolean;
  storeCleanupFailed: boolean;
};
/** A run that stopped: nothing after the last committed file was recorded. Committed files stay committed. */
export class FolderImportFailure extends Error {
  readonly storeCleanupFailed: boolean; readonly preserved: number;
  constructor(code: string, storeCleanupFailed: boolean, preserved: number) { super(code); this.storeCleanupFailed = storeCleanupFailed; this.preserved = preserved; }
}

/** Preserves a planned folder job from the folder the user chose for this run. The folder must scan to the same
 * inventory hash as the plan ("folder-changed" otherwise), so a different or edited folder is never imported into it.
 * Each file commits on its own after its original is durable; a completed file is only confirmed, never re-read. */
export async function runFolderImport(store: ImportStore, copier: FolderCopier, hash: string, uri: string,
  stopped: () => boolean, progress: (files: number) => void): Promise<FolderOutcome> {
  const check = () => { if (stopped()) throw new FolderStepError('cancelled'); };
  const plan = await store.folderPlan(hash);
  if (!plan) throw new FolderImportFailure('invalid-import-state', false, 0);
  const outcome: FolderOutcome = { preserved: 0, confirmed: 0, skipped: { missing: 0, changed: 0, unreadable: 0 }, changedSincePreserved: 0, complete: false, storeCleanupFailed: false };
  let opened = false;
  try {
    check();
    await store.state(hash, 'running');
    const scan = await copier.open(uri); opened = true;
    const sizes = new Map(scan.entries.map((entry, index) => [entry.path, scan.sizes[index] ?? -1]));
    // The same label as the plan, so the comparison is of evidence only; the hash ignores the label anyway.
    let current;
    try {
      const source = inventoryFromSnapshot(scan, plan.sourceId);
      current = decodePreview(encodePreview({ preview: mergeSourceInventories([], source), sourceIds: new Map([[`folder:${hash}`, plan.sourceId]]) })).preview.sources[0]!;
    } catch { throw new FolderStepError('folder-changed'); }
    if (folderInventoryHash(current) !== hash) throw new FolderStepError('folder-changed');
    const pending: string[] = [];
    for (let ordinal = -1; ;) { const item = await store.item(hash, ordinal); if (!item) break; if (item.state === 'pending') pending.push(item.relative_path); ordinal = item.ordinal; }
    await copier.prepare(pending, 64 * 1024 ** 3 - await store.copiedBytes(hash));
    let ordinal = -1, count = 0, remaining = 0;
    for (;;) {
      check(); const item = await store.item(hash, ordinal); if (!item) break;
      if (item.state === 'done') {
        if (item.object_hash === null || item.bytes === null) throw new FolderStepError('stored-object-corrupt');
        await copier.confirm(item.object_hash, item.bytes); outcome.confirmed++;
        const reported = sizes.get(item.relative_path) ?? -1;
        if (reported >= 0 && reported !== item.bytes) outcome.changedSincePreserved++;
      } else {
        let receipt: Receipt | null = null;
        try { receipt = await copier.preserve(item.relative_path); }
        catch (error) {
          if (!(error instanceof FolderStepError) || !RETRYABLE.has(error.message) || stopped()) throw error;
          if (error.storeCleanupFailed) outcome.storeCleanupFailed = true;
          outcome.skipped[error.message === 'source-missing' ? 'missing' : error.message === 'source-changed' ? 'changed' : 'unreadable']++;
          remaining++;
        }
        // Even if cancellation arrived after finalization, commit this complete file before stopping.
        if (receipt) { await store.commit(hash, item.ordinal, receipt); outcome.preserved++; }
      }
      ordinal = item.ordinal; progress(++count);
    }
    check(); await copier.close(); opened = false;
    outcome.complete = remaining === 0;
    await store.state(hash, outcome.complete ? 'completed' : 'paused');
    return outcome;
  } catch (error) {
    // A stopped run never moves a job backwards: one with nothing pending stays completed.
    await store.hasPending(hash).then(pending => store.state(hash, pending ? 'paused' : 'completed')).catch(() => {});
    if (opened) { opened = false; await copier.close().catch(() => {}); }
    const step = error instanceof FolderStepError ? error : null;
    throw new FolderImportFailure(stopped() ? 'cancelled' : error instanceof Error ? error.message : 'import-failed',
      outcome.storeCleanupFailed || !!step?.storeCleanupFailed, outcome.preserved);
  } finally { if (opened) await copier.close().catch(() => {}); }
}
