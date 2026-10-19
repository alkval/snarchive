import { Platform } from 'react-native';
import { requireOptionalNativeModule } from 'expo';
import { inspectBackup, type InspectionProgress, type VerifyProgress } from '../backup/inspectBackup';
import type { BackupPreview } from '../backup/manifest';

type Result = { ok: boolean; code?: string };
interface NativeInspection {
  beginBackupInspection(uri: string): Promise<Result & { inPlace?: boolean; objects?: number; objectBytes?: number }>;
  readBackupManifest(): Promise<Result & { text?: string; done?: boolean }>;
  declareBackupObjects(hashes: string[], sizes: number[]): Promise<Result>;
  sealBackupInspection(): Promise<Result>;
  verifyBackupObjects(): Promise<Result & Partial<VerifyProgress>>;
  endBackupInspection(): Promise<Result>;
  cancel(): void;
}
function native(): NativeInspection {
  const module = requireOptionalNativeModule<NativeInspection>('SnarchiveSources');
  if (Platform.OS !== 'android' || !module?.beginBackupInspection) throw new Error('native-build-required');
  return module;
}
function checked<T extends Result>(result: T): T { if (!result.ok) throw new Error(result.code ?? 'backup-unreadable'); return result; }

export type InspectionOutcome = { preview: BackupPreview; inPlace: boolean; cleanupFailed: boolean };
/** A failed or cancelled check whose private copy also could not be deleted. */
export class InspectionFailure extends Error { constructor(code: string, readonly cleanupFailed: boolean) { super(code); } }
export function cancelBackupInspection() { if (Platform.OS === 'android') requireOptionalNativeModule<NativeInspection>('SnarchiveSources')?.cancel(); }

/** Read-only: opens the chosen document (in place, or a private copy), validates it, verifies every object, then
 * always closes the session, which deletes any private copy. Nothing reaches the library or the originals store. */
export async function inspectBackupDocument(uri: string, cancelled: () => boolean, progress: (state: InspectionProgress) => void): Promise<InspectionOutcome> {
  const bridge = native();
  const opened = checked(await bridge.beginBackupInspection(uri));
  let preview: BackupPreview;
  try {
    preview = await inspectBackup({
      async readManifest() { const chunk = checked(await bridge.readBackupManifest()); return { text: chunk.text ?? '', done: !!chunk.done }; },
      async declare(objects) { checked(await bridge.declareBackupObjects(objects.map(([hash]) => hash), objects.map(([, bytes]) => bytes))); },
      async seal() { checked(await bridge.sealBackupInspection()); },
      async verify() {
        const state = checked(await bridge.verifyBackupObjects());
        return { verified: state.verified ?? 0, total: state.total ?? 0, bytes: state.bytes ?? 0, totalBytes: state.totalBytes ?? 0, done: !!state.done };
      },
    }, cancelled, progress);
  } catch (error) {
    const closed = await bridge.endBackupInspection().catch(() => ({ ok: false }));
    if (closed.ok) throw error;
    throw new InspectionFailure(error instanceof Error ? error.message : 'backup-unreadable', true);
  }
  const closed = await bridge.endBackupInspection().catch(() => ({ ok: false }));
  return { preview, inPlace: !!opened.inPlace, cleanupFailed: !closed.ok };
}
