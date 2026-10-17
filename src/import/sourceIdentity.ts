import type { DirectorySnapshot } from './sourceInventory.ts';

/** Android providers can expose identical ZIP bytes through different document URIs. */
export function sourceIdentity(source: { kind: 'zip' | 'directory'; uri: string }, snapshot: DirectorySnapshot): string {
  if (source.kind === 'directory') return `directory:${source.uri}`;
  if (typeof snapshot.archiveSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(snapshot.archiveSha256)) {
    throw new Error('native-build-required');
  }
  return `zip:${snapshot.archiveSha256}`;
}
