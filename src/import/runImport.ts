import { ImportStore, type Receipt } from '../storage/importStore.ts';
export interface OriginalCopier {
  open(uri: string, hash: string, remaining: number): Promise<void>;
  preserve(path: string): Promise<Receipt>;
  verify(hash: string, bytes: number): Promise<void>;
  close(): Promise<void>;
}
/** Per-file commit boundary. Retrying an uncommitted file verifies/reuses any finalized bytes. */
export async function runImport(store: ImportStore, copier: OriginalCopier, hash: string, uri: string,
  stopped: () => boolean, progress: (files: number) => void): Promise<void> {
  const check = () => { if (stopped()) throw new Error('cancelled'); };
  let opened = false;
  try {
    check();
    await store.state(hash, 'running');
    await copier.open(uri, hash, 64 * 1024 ** 3 - await store.copiedBytes(hash)); opened = true;
    let ordinal = -1, count = 0;
    for (;;) {
      check(); const item = await store.item(hash, ordinal); if (!item) break;
      if (item.state === 'done') {
        if (item.object_hash === null || item.bytes === null) throw new Error('stored-object-corrupt');
        await copier.verify(item.object_hash, item.bytes);
      } else {
        const receipt = await copier.preserve(item.relative_path);
        // Even if cancellation arrived after finalization, commit this complete file before stopping.
        await store.commit(hash, item.ordinal, receipt);
      }
      ordinal = item.ordinal; progress(++count);
    }
    check(); await copier.close(); opened = false;
    await store.state(hash, 'completed');
  } catch (error) {
    await store.state(hash, 'paused'); throw error;
  } finally { if (opened) await copier.close(); }
}
