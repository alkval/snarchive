/** Header preflight only. Native extraction must independently enforce actual byte limits. */
export const archiveLimits = {
  maxEntries: 100_000,
  maxDepth: 32,
  maxPathLength: 1024,
  maxEntryBytes: 8 * 1024 ** 3,
  maxTotalBytes: 64 * 1024 ** 3,
  maxCompressionRatio: 1000,
} as const;

export type ArchiveEntry = {
  path: string;
  kind: 'file' | 'directory' | 'symlink' | 'unknown';
  compressedBytes: number;
  expandedBytes: number;
  encrypted: boolean;
};
export type ArchiveRejection = 'unsafe-path' | 'unsupported-entry' | 'encrypted' | 'invalid-size'
  | 'entry-limit' | 'byte-limit' | 'compression-ratio' | 'path-collision';

export function safeArchivePath(path: string, directory = false): boolean {
  if (!path || path.length > archiveLimits.maxPathLength || /^[\/\\]/.test(path) || /[\\:\x00-\x1f\x7f]/.test(path)) return false;
  const normalized = directory && path.endsWith('/') ? path.slice(0, -1) : path;
  const parts = normalized.split('/');
  return parts.length <= archiveLimits.maxDepth && parts.every(part =>
    part !== '' && part !== '.' && part !== '..' && !/[ .]$/.test(part));
}

export function preflightArchive(entries: readonly ArchiveEntry[]):
  { ok: true; declaredBytes: number } | { ok: false; code: ArchiveRejection; entry?: number } {
  if (entries.length > archiveLimits.maxEntries) return { ok: false, code: 'entry-limit' };
  let total = 0;
  const paths = new Map<string, ArchiveEntry['kind']>();
  for (let index = 0; index < entries.length; index++) {
    const item = entries[index]!;
    const reject = (code: ArchiveRejection) => ({ ok: false as const, code, entry: index });
    if (!safeArchivePath(item.path, item.kind === 'directory')) return reject('unsafe-path');
    if (item.kind !== 'file' && item.kind !== 'directory') return reject('unsupported-entry');
    if (item.encrypted) return reject('encrypted');
    if (![item.compressedBytes, item.expandedBytes].every(size => Number.isSafeInteger(size) && size >= 0)) return reject('invalid-size');
    if (item.kind === 'directory' && item.expandedBytes !== 0) return reject('invalid-size');
    if (item.expandedBytes > archiveLimits.maxEntryBytes || item.expandedBytes > archiveLimits.maxTotalBytes - total) return reject('byte-limit');
    if (item.expandedBytes > Math.max(1, item.compressedBytes) * archiveLimits.maxCompressionRatio) return reject('compression-ratio');
    total += item.expandedBytes;
    // Conservative cross-platform collision check; never decode URL-like path text.
    const path = item.path.replace(/\/$/, '').normalize('NFC').toLowerCase();
    if (paths.has(path)) return reject('path-collision');
    paths.set(path, item.kind);
  }
  for (const path of paths.keys()) {
    const parts = path.split('/');
    for (let length = 1; length < parts.length; length++) {
      if (paths.get(parts.slice(0, length).join('/')) === 'file') return { ok: false, code: 'path-collision' };
    }
  }
  return { ok: true, declaredBytes: total };
}
