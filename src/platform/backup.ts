import { Platform } from 'react-native';
import { requireOptionalNativeModule } from 'expo';
import { openDatabaseAsync } from 'expo-sqlite';
import { writeBackupSnapshot } from '../backup/snapshot';
import { backupChunks, runBackup, type BackupStage } from '../backup/runBackup';
type Result = { ok: boolean; code?: string; canceled?: boolean };
interface NativeBackup {
  beginBackup(): Promise<Result>;
  appendBackupChunk(chunk: string): Promise<Result>;
  addBackupObject(hash: string, bytes: number): Promise<Result>;
  sealBackup(): Promise<Result>;
  chooseBackupDestination(): Promise<Result>;
  saveBackup(): Promise<Result>;
  endBackup(): Promise<Result>;
  recoverBackups(): Promise<Result>;
  cancel(): void;
}
function module(): NativeBackup {
  const native = requireOptionalNativeModule<NativeBackup>('SnarchiveSources');
  if (Platform.OS !== 'android' || !native?.beginBackup) throw new Error('native-build-required');
  return native;
}
function checked(result: Result) { if (!result.ok) throw new Error(result.code ?? 'backup-failed'); return result; }
export function cancelBackup() { if (Platform.OS === 'android') requireOptionalNativeModule<NativeBackup>('SnarchiveSources')?.cancel(); }
export async function recoverBackups() {
  if (Platform.OS !== 'android') return;
  const native = requireOptionalNativeModule<NativeBackup>('SnarchiveSources');
  if (native?.recoverBackups) checked(await native.recoverBackups());
}
export async function saveLibraryBackup(cancelled: () => boolean, progress: (stage: BackupStage) => void) {
  const native = module(); const db = await openDatabaseAsync('snarchive-library.db', { useNewConnection: true });
  try {
    return await runBackup(sink => writeBackupSnapshot(db, sink, cancelled), {
      async begin() { checked(await native.beginBackup()); },
      async line(line) { for (const chunk of backupChunks(line)) { if (cancelled()) throw new Error('cancelled'); checked(await native.appendBackupChunk(chunk)); } },
      async object(object) { checked(await native.addBackupObject(object.sha256, object.bytes)); },
      async seal() { checked(await native.sealBackup()); },
      async choose() { return !checked(await native.chooseBackupDestination()).canceled; },
      async save() { checked(await native.saveBackup()); },
      async end() { checked(await native.endBackup()); },
    }, cancelled, progress);
  } finally { await db.closeAsync(); }
}
