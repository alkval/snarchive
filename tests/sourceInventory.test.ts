import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inventoryFromSnapshot, mergeSourceInventories, type DirectorySnapshot } from '../src/import/sourceInventory.ts';
const text = JSON.stringify({ 'Saved Media': [{ Date: '2026-02-05 17:48:47 UTC', 'Media Type': 'Image', 'Download Link': 'https://example.invalid/?mid=a&token=discard-me' }] });
function snapshot(entries: DirectorySnapshot['entries']): DirectorySnapshot {
  return { entries, visitedEntries: entries.length, metadataBytes: entries.reduce((n, e) => n + Buffer.byteLength(e.metadataText ?? ''), 0) };
}
const media = snapshot([{ path: 'memories/2026-02-05_a-main.jpg' }, { path: 'memories/2026-02-05_a-overlay.png' }]);
const meta = snapshot([{ path: 'json/memories_history.json', metadataText: text }]);

test('folder inventory joins metadata found in a separately selected folder', () => {
  const first = mergeSourceInventories([], inventoryFromSnapshot(media, 'a'));
  const second = mergeSourceInventories(first.sources, inventoryFromSnapshot(meta, 'b'));
  assert.equal(second.inventory.memories.length, 1);
  assert.equal(second.inventory.memories[0]?.captureDate.kind, 'instant');
  assert.equal(second.inventory.memories[0]?.overlays.length, 1);
  assert.equal(JSON.stringify(second).includes('discard-me'), false);
});
test('rescanning a folder replaces its prior observations without duplicates', () => {
  const first = mergeSourceInventories([], inventoryFromSnapshot(media, 'a'));
  const second = mergeSourceInventories(first.sources, inventoryFromSnapshot(media, 'a'));
  assert.equal(second.sources.length, 1);
  assert.equal(second.inventory.memories[0]?.media.length, 1);
});
test('unsupported filenames and inert HTML are counted without reading their content', () => {
  const result = inventoryFromSnapshot(snapshot([{ path: 'index.html' }, { path: 'holiday.heic' }]), 'a');
  assert.equal(result.otherFiles, 2); assert.equal(result.files.length, 0);
});
test('metadata-only and overlay-only entries have distinct report counts', () => {
  const files = snapshot([{ path: '2026-02-05_b-overlay.png' }, ...meta.entries]);
  const { inventory } = mergeSourceInventories([], inventoryFromSnapshot(files, 'a'));
  assert.equal(inventory.summary.metadataOnly, 1);
  assert.equal(inventory.summary.orphanOverlays, 1);
  assert.equal(inventory.summary.missingMedia, 2);
});
test('unsafe and repeated file paths abort a snapshot instead of hiding files', () => {
  for (const path of ['../a.jpg', '/a.jpg', 'a\\b.jpg']) {
    assert.throws(() => inventoryFromSnapshot(snapshot([{ path }]), 'a'), /unsafe-source/);
  }
  assert.throws(() => inventoryFromSnapshot(snapshot([{ path: 'a' }, { path: 'a' }]), 'a'), /unsafe-source/);
});
test('missing metadata content and unexpected content fail explicitly', () => {
  assert.throws(() => inventoryFromSnapshot(snapshot([{ path: 'memories_history.json' }]), 'a'), /missing-metadata-content/);
  assert.throws(() => inventoryFromSnapshot(snapshot([{ path: 'index.html', metadataText: text }]), 'a'), /unexpected-metadata-content/);
});
test('invalid native accounting and source limits are rejected', () => {
  for (const visitedEntries of [0, -1, NaN, 100_001]) assert.throws(() => inventoryFromSnapshot({ ...media, visitedEntries }, 'a'), /source-limit/);
  assert.throws(() => inventoryFromSnapshot({ ...media, metadataBytes: 16 * 1024 * 1024 + 1 }, 'a'), /source-limit/);
});
test('failed session merge leaves previous preview unchanged', () => {
  const first = mergeSourceInventories([], inventoryFromSnapshot(media, 'a'));
  const before = JSON.stringify(first);
  const next = { ...inventoryFromSnapshot(meta, 'b'), visitedEntries: 100_000 };
  assert.throws(() => mergeSourceInventories(first.sources, next), /session-limit/);
  assert.equal(JSON.stringify(first), before);
});
test('combined metadata and source counts are bounded', () => {
  const base = inventoryFromSnapshot(meta, 'a');
  const large = { ...base, metadataBytes: 9 * 1024 * 1024 };
  assert.throws(() => mergeSourceInventories([large], { ...large, sourceId: 'b' }), /session-limit/);
  const eight = Array.from({ length: 8 }, (_, i) => ({ ...base, sourceId: String(i) }));
  assert.throws(() => mergeSourceInventories(eight, { ...base, sourceId: 'new' }), /session-limit/);
});
