import { Platform } from 'react-native';
import { requireOptionalNativeModule } from 'expo';
import type { InspectionProgress } from '../backup/inspectBackup';
import { runInspectionSession, type InspectionBridge, type InspectionOutcome } from '../backup/inspectionSession';

export { InspectionFailure, type InspectionOutcome } from '../backup/inspectionSession';
type NativeInspection = InspectionBridge & { cancel(): void };
function native(): NativeInspection {
  const module = requireOptionalNativeModule<NativeInspection>('SnarchiveSources');
  if (Platform.OS !== 'android' || !module?.beginBackupInspection) throw new Error('native-build-required');
  return module;
}
export function cancelBackupInspection() { if (Platform.OS === 'android') requireOptionalNativeModule<NativeInspection>('SnarchiveSources')?.cancel(); }

/** Read-only: nothing reaches the library or the originals store. See runInspectionSession. */
export function inspectBackupDocument(uri: string, cancelled: () => boolean, progress: (state: InspectionProgress) => void): Promise<InspectionOutcome> {
  return runInspectionSession(native(), uri, cancelled, progress);
}
