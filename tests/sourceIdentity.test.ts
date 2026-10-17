import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sourceIdentity } from '../src/import/sourceIdentity.ts';
import { inventoryFromSnapshot, mergeSourceInventories } from '../src/import/sourceInventory.ts';
const snapshot = { entries: [], metadataBytes: 0, visitedEntries: 0, archiveSha256: 'a'.repeat(64) };
test('identical ZIP bytes from different providers replace the same source', () => {
  const a = sourceIdentity({ kind: 'zip', uri: 'content://downloads/1' }, snapshot);
  const b = sourceIdentity({ kind: 'zip', uri: 'content://external/Download/test.zip' }, snapshot);
  assert.equal(a, b);
  const first = inventoryFromSnapshot(snapshot, a);
  assert.equal(mergeSourceInventories([first], inventoryFromSnapshot(snapshot, b)).sources.length, 1);
});
test('changed archive bytes remain a distinct source', () => {
  const source = { kind: 'zip' as const, uri: 'content://downloads/1' };
  assert.notEqual(sourceIdentity(source, snapshot), sourceIdentity(source, { ...snapshot, archiveSha256: 'b'.repeat(64) }));
});
test('missing or malformed archive digests require a current native build', () => {
  for (const archiveSha256 of [undefined, '', 'x'.repeat(64), 'a'.repeat(63)]) {
    assert.throws(() => sourceIdentity({ kind: 'zip', uri: 'content://1' }, { ...snapshot, archiveSha256 }), /native-build-required/);
  }
});
test('folder identity remains tied to its selected URI', () => {
  assert.equal(sourceIdentity({ kind: 'directory', uri: 'content://tree/1' }, snapshot), 'directory:content://tree/1');
});
