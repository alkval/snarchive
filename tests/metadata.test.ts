import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMetadata, parseLocation } from '../src/import/metadata.ts';
import { buildInventory } from '../src/import/inventory.ts';
import { parseObservedFilename } from '../src/domain/candidates.ts';
const row = (id = 'snap-A', extra = {}) => ({ Date: '2026-02-05 17:48:47 UTC', 'Media Type': 'Image', 'Download Link': `https://example.invalid/download?mid=${id}&token=synthetic-secret`, ...extra });
const metadata = (rows: unknown[], source = 'metadata-part') => parseMetadata(JSON.stringify({ 'Saved Media': rows }), source);
function file(id = 'snap-A', part = 'main.jpg', day = '2026-02-05') {
  const item = parseObservedFilename('media-part', `memories/${day}_${id}-${part}`);
  assert.ok(item); return item;
}

test('only required fields survive parsing, never signed URLs or unrelated export data', () => {
  const result = metadata([row('snap-A', { unrelated: 'private-message' })]);
  const serialized = JSON.stringify(result);
  for (const secret of ['synthetic-secret', 'https:', 'private-message', 'Download Link']) assert.equal(serialized.includes(secret), false);
  assert.equal(result.records[0]?.memorySourceId, 'snap-A');
});
test('malformed JSON and unsupported shapes produce sanitized diagnostics', () => {
  for (const input of ['{https://private.invalid', 'null', '[]', '{"Saved Media":{}}']) {
    const result = parseMetadata(input, 'part');
    assert.equal(result.records.length, 0); assert.equal(result.diagnostics.length, 1);
    assert.equal(JSON.stringify(result).includes('private.invalid'), false);
  }
});
test('metadata parser bounds input and row count', () => {
  assert.equal(parseMetadata(' '.repeat(8 * 1024 * 1024 + 1), 'part').diagnostics[0]?.code, 'metadata-limit');
  assert.equal(metadata(Array(100_001).fill(null)).diagnostics[0]?.code, 'metadata-limit');
});
test('invalid rows do not discard valid neighbors', () => {
  const result = metadata([null, row(), [], 1]);
  assert.equal(result.records.length, 1); assert.equal(result.diagnostics.length, 3);
});
test('different IDs in URL fields cannot be silently matched', () => {
  const result = metadata([row('snap-A', { 'Media Download Url': 'https://example.invalid/?mid=snap-B' })]);
  assert.equal(result.records[0]?.memorySourceId, null);
  assert.ok(result.diagnostics.some(issue => issue.code === 'conflicting-identity'));
});
test('conflicting repeated mid parameters are ambiguous', () => {
  assert.equal(metadata([row('snap-A&mid=snap-B')]).records[0]?.memorySourceId, null);
});
test('invalid, credentialed, unsupported or oversized links are not used', () => {
  for (const link of ['file:///a?mid=snap-A', 'https://user:pass@example.invalid/?mid=snap-A', 'not a URL', 'https://example.invalid/?mid=%2Fetc', 'x'.repeat(16385)]) {
    assert.equal(metadata([row('snap-A', { 'Media Download Url': link })]).records[0]?.memorySourceId, null);
  }
});
test('missing IDs remain unmatched, never matched by date alone', () => {
  const inventory = buildInventory([file()], [metadata([row('snap-A', { 'Download Link': '' })])]);
  assert.equal(inventory.unmatchedMetadata.length, 1);
  assert.equal(inventory.memories[0]?.captureDate.kind, 'date-only');
});
test('location validation preserves coordinates locally and flags placeholders', () => {
  assert.deepEqual(parseLocation('Latitude, Longitude: 59.9, 10.7'), { kind: 'valid', latitude: 59.9, longitude: 10.7 });
  assert.equal(parseLocation('Latitude, Longitude: 0, 0').kind, 'placeholder');
  assert.equal(parseLocation('Latitude, Longitude: 0, 10').kind, 'valid');
  for (const value of ['Latitude, Longitude: 91, 2', 'Latitude, Longitude: 1, 181', 'Latitude, Longitude: NaN, 2', 5]) assert.equal(parseLocation(value).kind, 'invalid');
});
test('metadata in another part enriches capture date without filename-time invention', () => {
  const inventory = buildInventory([file()], [metadata([row()])]);
  assert.equal(inventory.memories[0]?.captureDate.kind, 'instant');
  assert.equal(inventory.summary.needsResolution, 0);
});
test('repeated rows retain provenance without duplicate logical inventory entries', () => {
  const inventory = buildInventory([file()], [metadata([row(), row()]), metadata([row()], 'other-part')]);
  assert.equal(inventory.memories.length, 1);
  assert.equal(inventory.repeatedRows, 2);
  assert.equal(inventory.memories[0]?.metadata.length, 3);
});
test('metadata-only records remain missing media until a later observation', () => {
  const rows = metadata([row()]);
  assert.equal(buildInventory([], [rows]).memories[0]?.availability, 'metadata-only');
  assert.equal(buildInventory([file()], [rows]).memories[0]?.availability, 'media-present');
});
test('late overlays associate without creating another memory', () => {
  const inventory = buildInventory([file(), file('snap-A', 'overlay.png')], [metadata([row()])]);
  assert.equal(inventory.memories.length, 1); assert.equal(inventory.memories[0]?.overlays.length, 1);
});
test('an orphan overlay stays out of media-present entries', () => {
  const result = buildInventory([file('snap-A', 'overlay.png')], []);
  assert.equal(result.summary.mediaPresent, 0); assert.equal(result.summary.orphanOverlays, 1);
});
test('conflicting explicit timestamps retain evidence without choosing one', () => {
  const memory = buildInventory([file()], [metadata([row(), row('snap-A', { Date: '2026-02-05 18:00:00 UTC' })])]).memories[0]!;
  assert.equal(memory.captureDate.kind, 'unknown');
  assert.ok(memory.issues.includes('conflicting-dates')); assert.equal(memory.dateEvidence.length, 3);
});
test('filename and metadata day disagreement is reported', () => {
  assert.ok(buildInventory([file('snap-A', 'main.jpg', '2026-02-04')], [metadata([row()])]).memories[0]?.issues.includes('conflicting-dates'));
});
test('invalid metadata date preserves inferred fallback with diagnostic', () => {
  const inventory = buildInventory([file()], [metadata([row('snap-A', { Date: 'invalid' })])]);
  assert.equal(inventory.memories[0]?.captureDate.kind, 'date-only');
  assert.ok(inventory.diagnostics.some(issue => issue.code === 'invalid-date'));
});
test('type and location disagreements are reported', () => {
  const a = row('snap-A', { Location: 'Latitude, Longitude: 59, 10' });
  const b = row('snap-A', { Location: 'Latitude, Longitude: 60, 11', 'Media Type': 'Video' });
  const issues = buildInventory([file()], [metadata([a, b])]).memories[0]!.issues;
  assert.ok(issues.includes('conflicting-locations')); assert.ok(issues.includes('conflicting-media-types'));
});
test('distinct source IDs stay separate even when other metadata is identical', () => {
  assert.equal(buildInventory([file('snap-A'), file('snap-B')], [metadata([row('snap-A'), row('snap-B')])]).memories.length, 2);
});

test('UTF-8 BOM does not make an otherwise valid metadata document unsupported', () => {
  const result = parseMetadata('\uFEFF' + JSON.stringify({ 'Saved Media': [row()] }), 'part');
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0]?.memorySourceId, 'snap-A');
});
