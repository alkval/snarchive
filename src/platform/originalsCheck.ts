import { Platform } from 'react-native';
import { requireOptionalNativeModule } from 'expo';
import { openImportStore } from './originalImporter';
import { runOriginalsCheck, runBackupRepair, affectedMemories, type CheckBridge, type RepairBridge, type CheckProgress, type Problem, type RepairProgress } from '../integrity/originals';
import { runExportRepair, type ExportKind, type ExportRepairBridge } from '../integrity/exportRepair';

type Native = CheckBridge & RepairBridge & ExportRepairBridge & { cancel(): void };
function native(): Native {
  const module = requireOptionalNativeModule<Native>('SnarchiveSources');
  if (Platform.OS !== 'android' || !module?.beginOriginalCheck) throw new Error('native-build-required');
  return module;
}
export function cancelOriginalsWork() { if (Platform.OS === 'android') requireOptionalNativeModule<Native>('SnarchiveSources')?.cancel(); }
export async function checkLibraryOriginals(cancelled: () => boolean, progress: (state: CheckProgress) => void) {
  return runOriginalsCheck((await openImportStore()).database, native(), cancelled, progress);
}
export async function describeProblems(hashes: string[]) { return affectedMemories((await openImportStore()).database, hashes); }
export function repairFromBackup(uri: string, problems: readonly Problem[], cancelled: () => boolean, progress: (state: RepairProgress) => void) {
  return runBackupRepair(native(), uri, problems, cancelled, progress);
}
export async function repairFromExport(kind: ExportKind, uri: string, problems: readonly Problem[], cancelled: () => boolean, progress: (state: RepairProgress) => void) {
  const bridge = native();
  if (!bridge.beginExportRepair) throw new Error('native-build-required');
  return runExportRepair((await openImportStore()).database, bridge, kind, uri, problems, cancelled, progress);
}
