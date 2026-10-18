import { Platform } from 'react-native';
import { requireOptionalNativeModule } from 'expo';
import { openDatabaseAsync } from 'expo-sqlite';
import { ImportStore, type Receipt } from '../storage/importStore';
import type { OriginalCopier } from '../import/runImport';
type Result = { ok: boolean; code?: string };
export type LocalVideo = { uri: string; width?: number; height?: number; rotation?: number };
interface NativeImporter {
  originalVideo?(hash: string, bytes: number): Promise<Result & LocalVideo>;
  openImportArchive(uri: string, hash: string, remaining: number): Promise<Result>;
  preserveImportEntry(path: string): Promise<Result & Receipt>;
  verifyOriginal(hash: string, bytes: number): Promise<Result>;
  originalUri?(hash: string, bytes: number): Promise<Result & { uri: string }>;
  closeImportArchive(): Promise<Result>;
}
function native(): NativeImporter {
  if (Platform.OS !== 'android') throw new Error('import-unavailable-ios');
  const module = requireOptionalNativeModule<NativeImporter>('SnarchiveSources');
  if (!module?.openImportArchive) throw new Error('native-build-required'); return module;
}
function checked<T extends Result>(result: T): T { if (!result.ok) throw new Error(result.code ?? 'import-failed'); return result; }
export const originalCopier: OriginalCopier = {
  async open(uri, hash, remaining) { checked(await native().openImportArchive(uri, hash, remaining)); },
  async preserve(path) { return checked(await native().preserveImportEntry(path)); },
  async verify(hash, bytes) { checked(await native().verifyOriginal(hash, bytes)); },
  async close() { checked(await native().closeImportArchive()); },
};
let opening: Promise<ImportStore> | undefined;
export function openImportStore(): Promise<ImportStore> {
  if (!opening) opening = (async () => {
    const db = await openDatabaseAsync('snarchive-library.db');
    try { const store = new ImportStore(db); await store.initialize(); return store; }
    catch { await db.closeAsync(); throw new Error('library-unavailable'); }
  })().catch(error => { opening = undefined; throw error; });
  return opening;
}

export async function originalUri(receipt: Receipt): Promise<string> {
  const module = native();
  if (!module.originalUri) throw new Error('native-build-required');
  return checked(await module.originalUri(receipt.sha256, receipt.bytes)).uri;
}

export async function originalVideo(receipt: Receipt): Promise<LocalVideo> {
  const module = native();
  if (!module.originalVideo) throw new Error('native-build-required');
  return checked(await module.originalVideo(receipt.sha256, receipt.bytes));
}
