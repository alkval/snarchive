import { test } from 'node:test';
import assert from 'node:assert/strict';
import { preflightArchive, safeArchivePath, archiveLimits, type ArchiveEntry } from '../src/import/archivePolicy.ts';
const entry = (extra: Partial<ArchiveEntry> = {}): ArchiveEntry => ({ path: 'memories/a.jpg', kind: 'file', compressedBytes: 100, expandedBytes: 200, encrypted: false, ...extra });
function rejection(entries: ArchiveEntry[], code: string) {
  const result = preflightArchive(entries);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, code);
}

test('ordinary nested media paths pass preflight', () => {
  assert.deepEqual(preflightArchive([entry()]), { ok: true, declaredBytes: 200 });
});
test('traversal, absolute, drive, backslash, control, empty and ambiguous segments fail', () => {
  for (const path of ['../a', '/a', 'C:/a', 'a\\b', 'a/../b', 'a//b', 'a/./b', 'a\0b', 'a\nb', 'a./b', 'a /b', '']) {
    assert.equal(safeArchivePath(path), false, JSON.stringify(path));
  }
});
test('directory trailing separator is accepted only for directories', () => {
  assert.equal(safeArchivePath('memories/', true), true);
  assert.equal(safeArchivePath('memories/'), false);
});
test('deep and long paths fail', () => {
  assert.equal(safeArchivePath(Array(33).fill('a').join('/')), false);
  assert.equal(safeArchivePath('a'.repeat(1025)), false);
});
test('symlinks, unknown types and encrypted entries fail', () => {
  rejection([entry({ kind: 'symlink' })], 'unsupported-entry');
  rejection([entry({ kind: 'unknown' })], 'unsupported-entry');
  rejection([entry({ encrypted: true })], 'encrypted');
});
test('unsafe numeric sizes fail', () => {
  for (const expandedBytes of [-1, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1]) rejection([entry({ expandedBytes })], 'invalid-size');
});
test('entry, total-byte and compression limits fail closed', () => {
  rejection(Array(archiveLimits.maxEntries + 1).fill(entry()), 'entry-limit');
  rejection([entry({ expandedBytes: archiveLimits.maxEntryBytes + 1 })], 'byte-limit');
  rejection(Array.from({ length: 9 }, (_, i) => entry({ path: `${i}.mp4`, expandedBytes: archiveLimits.maxEntryBytes, compressedBytes: archiveLimits.maxEntryBytes })), 'byte-limit');
  rejection([entry({ compressedBytes: 1, expandedBytes: 1001 })], 'compression-ratio');
});
test('case and Unicode normalization collisions fail', () => {
  rejection([entry(), entry({ path: 'MEMORIES/A.JPG' })], 'path-collision');
  rejection([entry({ path: 'é.jpg' }), entry({ path: 'e\u0301.jpg' })], 'path-collision');
});
test('file-as-parent collisions fail regardless of entry order', () => {
  const a = entry({ path: 'a' }), b = entry({ path: 'a/b' });
  rejection([a, b], 'path-collision'); rejection([b, a], 'path-collision');
});
test('directory with claimed content is invalid', () => {
  rejection([entry({ path: 'a/', kind: 'directory' })], 'invalid-size');
});
