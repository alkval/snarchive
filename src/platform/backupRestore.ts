import { Platform } from 'react-native';
import { requireOptionalNativeModule } from 'expo';
import { openDatabaseAsync } from 'expo-sqlite';
import { runRestore, type RestoreBridge, type RestoreOutcome, type RestoreProgress } from '../backup/restoreBackup';

export { RestoreFailure, type RestoreOutcome, type RestoreProgress } from '../backup/restoreBackup';
type NativeRestore = RestoreBridge & { cancel(): void };
function native(): NativeRestore {
  const module = requireOptionalNativeModule<NativeRestore>('SnarchiveSources');
  if (Platform.OS !== 'android' || !module?.beginBackupRestore) throw new Error('native-build-required');
  return module;
}
export function cancelBackupRestore() { if (Platform.OS === 'android') requireOptionalNativeModule<NativeRestore>('SnarchiveSources')?.cancel(); }

/** Restores a backup into the library. Its own connection holds the exclusive merge transaction, as the backup
 * snapshot does; the app's main connection sees the result once it commits. */
export async function restoreBackupDocument(uri: string, cancelled: () => boolean, progress: (state: RestoreProgress) => void): Promise<RestoreOutcome> {
  const bridge = native();
  const db = await openDatabaseAsync('snarchive-library.db', { useNewConnection: true });
  try { return await runRestore(bridge, db, uri, cancelled, progress); }
  finally { await db.closeAsync(); }
}
