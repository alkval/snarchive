import type { SnapshotSink } from './snapshot.ts';
export type BackupStage = 'snapshot' | 'choose' | 'save';
export interface BackupTransport extends SnapshotSink {
  begin(): Promise<void>;
  /** Closes private staging (manifest and catalog). The ZIP itself streams into the destination in save(). */
  seal(): Promise<void>;
  choose(): Promise<boolean>;
  save(): Promise<void>;
  end(): Promise<void>;
}
/** Staging is sealed, and the destination chosen, only after the snapshot transaction commits successfully. */
export async function runBackup(snapshot: (sink: SnapshotSink) => Promise<void>, transport: BackupTransport,
  cancelled: () => boolean, progress: (stage: BackupStage) => void): Promise<'saved' | 'cancelled'> {
  const check = () => { if (cancelled()) throw new Error('cancelled'); };
  check(); await transport.begin();
  try {
    check(); progress('snapshot'); await snapshot(transport);
    check(); await transport.seal();
    check(); progress('choose'); if (!await transport.choose()) return 'cancelled';
    check(); progress('save'); await transport.save();
    // save() has committed a verified destination. A late Cancel must not relabel it incomplete.
    return 'saved';
  } finally { await transport.end(); }
}
/** Keep bridge messages bounded without splitting UTF-16 surrogate pairs. */
export function* backupChunks(line: string): Generator<string> {
  let offset = 0;
  while (offset < line.length) {
    let end = Math.min(offset + 65536, line.length);
    const last = line.charCodeAt(end - 1);
    if (end < line.length && last >= 0xd800 && last <= 0xdbff) end--;
    yield line.slice(offset, end); offset = end;
  }
}
