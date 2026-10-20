import { Platform } from 'react-native';
import { requireOptionalNativeModule } from 'expo';
import { openImportStore } from './originalImporter';
import { reviewStorage, removeSelected, type StorageBridge, type StorageEntry } from '../integrity/storageCleanup';

type Native = StorageBridge & { cancel(): void };
function native(): Native {
  const module = requireOptionalNativeModule<Native>('SnarchiveSources');
  if (Platform.OS !== 'android' || !module?.beginStorageReview) throw new Error('native-build-required');
  return module;
}
export function cancelStorageWork() { if (Platform.OS === 'android') requireOptionalNativeModule<Native>('SnarchiveSources')?.cancel(); }
export async function reviewLibraryStorage(cancelled: () => boolean, progress: (listed: number) => void) {
  return reviewStorage((await openImportStore()).database, native(), cancelled, progress);
}
export async function removeStorageSelection(selection: readonly StorageEntry[], cancelled: () => boolean, progress: (done: number, total: number) => void) {
  return removeSelected((await openImportStore()).database, native(), selection, cancelled, progress);
}
