import { inspectBackup, type InspectionProgress, type VerifyProgress } from './inspectBackup.ts';
import type { BackupPreview } from './manifest.ts';

type Result = { ok: boolean; code?: string };
/** The native inspection functions, as exposed by the Android module. */
export interface InspectionBridge {
  beginBackupInspection(uri: string): Promise<Result & { inPlace?: boolean; cleanupFailed?: boolean }>;
  readBackupManifest(): Promise<Result & { text?: string; done?: boolean }>;
  declareBackupObjects(hashes: string[], sizes: number[]): Promise<Result>;
  sealBackupInspection(): Promise<Result>;
  verifyBackupObjects(): Promise<Result & Partial<VerifyProgress>>;
  endBackupInspection(): Promise<Result>;
}
export type InspectionOutcome = { preview: BackupPreview; inPlace: boolean; cleanupFailed: boolean };
/** A failed or cancelled check. `message` is the original code (or 'cancelled'); cleanupFailed reports a private
 * copy that could not be deleted, which never replaces or hides the original outcome. */
export class InspectionFailure extends Error {
  readonly cleanupFailed: boolean;
  constructor(code: string, cleanupFailed: boolean) { super(code); this.cleanupFailed = cleanupFailed; }
}

function checked<T extends Result>(result: T): T { if (!result.ok) throw new Error(result.code ?? 'backup-unreadable'); return result; }

/** Read-only: opens the chosen document (in place, or a private copy), validates it, verifies every object, then
 * always closes the session, which deletes any private copy. Every failure surfaces as an InspectionFailure. */
export async function runInspectionSession(bridge: InspectionBridge, uri: string, cancelled: () => boolean,
  progress: (state: InspectionProgress) => void): Promise<InspectionOutcome> {
  const opened = await bridge.beginBackupInspection(uri);
  // A failed open already released its session; it may also report a copy it could not delete.
  if (!opened.ok) throw new InspectionFailure(cancelled() ? 'cancelled' : opened.code ?? 'backup-unreadable', !!opened.cleanupFailed);
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
    throw new InspectionFailure(cancelled() ? 'cancelled' : error instanceof Error ? error.message : 'backup-unreadable', !closed.ok);
  }
  const closed = await bridge.endBackupInspection().catch(() => ({ ok: false }));
  return { preview, inPlace: !!opened.inPlace, cleanupFailed: !closed.ok };
}
