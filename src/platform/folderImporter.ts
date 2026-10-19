import { Platform } from 'react-native';
import { requireOptionalNativeModule } from 'expo';
import type { Receipt } from '../storage/importStore';
import { FolderStepError, type FolderCopier, type FolderScan } from '../import/runFolderImport';
type Result = { ok: boolean; code?: string; storeCleanupFailed?: boolean };
interface NativeFolder {
  openFolderImport(uri: string): Promise<Result & Partial<FolderScan>>;
  prepareFolderImport(paths: string[], remaining: number): Promise<Result>;
  preserveFolderEntry(path: string): Promise<Result & Partial<Receipt>>;
  confirmOriginal(hash: string, bytes: number): Promise<Result>;
  closeFolderImport(): Promise<Result>;
}
function native(): NativeFolder {
  if (Platform.OS !== 'android') throw new FolderStepError('import-unavailable-ios');
  const module = requireOptionalNativeModule<NativeFolder>('SnarchiveSources');
  if (!module?.openFolderImport) throw new FolderStepError('native-build-required'); return module;
}
function checked<T extends Result>(result: T): T {
  if (!result.ok) throw new FolderStepError(result.code ?? 'import-failed', !!result.storeCleanupFailed);
  return result;
}
/** Android folder preservation through the Storage Access Framework tree the user chose for this run. */
export const folderCopier: FolderCopier = {
  async open(uri) {
    const scan = checked(await native().openFolderImport(uri));
    return { entries: scan.entries ?? [], metadataBytes: scan.metadataBytes ?? 0, visitedEntries: scan.visitedEntries ?? 0, sizes: scan.sizes ?? [] };
  },
  async prepare(pending, remaining) { checked(await native().prepareFolderImport(pending, remaining)); },
  async preserve(path) {
    const result = checked(await native().preserveFolderEntry(path));
    return { sha256: result.sha256!, relativePath: result.relativePath!, bytes: result.bytes! };
  },
  async confirm(hash, bytes) { checked(await native().confirmOriginal(hash, bytes)); },
  async close() { checked(await native().closeFolderImport()); },
};
