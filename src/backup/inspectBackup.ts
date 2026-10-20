import { BackupManifestValidator, type BackupPreview } from './manifest.ts';

export type VerifyProgress = { verified: number; total: number; bytes: number; totalBytes: number; done: boolean };
/** The native side of an open inspection session. Media bytes never cross this boundary. */
export interface InspectionTransport {
  /** The next piece of strictly decoded manifest text (bounded, never split inside a surrogate pair). */
  readManifest(): Promise<{ text: string; done: boolean }>;
  /** Objects the manifest declares; each must exist in the archive exactly once with that length. */
  declare(objects: [string, number][]): Promise<void>;
  /** After the end record: no undeclared object may remain in the archive. */
  seal(): Promise<void>;
  /** Streams the next objects (length, ZIP CRC and SHA-256) and reports overall progress. */
  verify(): Promise<VerifyProgress>;
}
export type InspectionProgress = { stage: 'manifest' } | ({ stage: 'objects' } & VerifyProgress);
const DECLARE_BATCH = 500;

/** Validates the whole manifest, declaring every object to the native side, then seals the session (no undeclared
 * object may remain). Shared by inspection and repair; it reads no media. */
export async function validateManifest(transport: Pick<InspectionTransport, 'readManifest' | 'declare' | 'seal'>, cancelled: () => boolean): Promise<BackupPreview> {
  const stop = () => { if (cancelled()) throw new Error('cancelled'); };
  const validator = new BackupManifestValidator();
  const flush = async () => {
    const declared = validator.takeDeclarations();
    for (let index = 0; index < declared.length; index += DECLARE_BATCH) { stop(); await transport.declare(declared.slice(index, index + DECLARE_BATCH)); }
  };
  for (;;) {
    stop();
    const chunk = await transport.readManifest();
    validator.push(chunk.text);
    await flush();
    if (chunk.done) break;
  }
  const preview = validator.finish();
  stop(); await transport.seal();
  return preview;
}

/** Validates the whole manifest, then verifies every object. Resolves only when everything matches. */
export async function inspectBackup(transport: InspectionTransport, cancelled: () => boolean,
  progress: (state: InspectionProgress) => void): Promise<BackupPreview> {
  const stop = () => { if (cancelled()) throw new Error('cancelled'); };
  progress({ stage: 'manifest' });
  const preview = await validateManifest(transport, cancelled);
  for (;;) {
    stop();
    const state = await transport.verify();
    progress({ stage: 'objects', ...state });
    if (state.done) return preview;
  }
}
