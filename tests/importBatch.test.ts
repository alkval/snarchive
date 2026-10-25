import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanImportBatch, importBatch } from '../src/import/importBatch.ts';
import type { DirectorySnapshot } from '../src/import/sourceInventory.ts';
const zip = (uri: string) => ({ kind: 'zip' as const, uri });
const scan = (paths: string[], hash = 'a'.repeat(64)): DirectorySnapshot => ({ entries: paths.map(path => ({ path })), visitedEntries: paths.length, metadataBytes: 0, archiveSha256: hash });
test('scan holds one selection for confirmation; confirmed import receives the same ZIP and folder grants once', async () => {
  const selected = [zip('zip1'), zip('alias1'), zip('zip2'), { kind: 'directory' as const, uri: 'tree' }];
  const scanned: string[] = [], copied: string[] = [];
  const batch = await scanImportBatch(selected, async part => { scanned.push(part.uri); return part.uri === 'zip2' ? scan(['2026-02-05_one-overlay.png'], 'b'.repeat(64)) : scan(['2026-02-05_one-main.jpg']); }, () => false, () => {});
  assert.deepEqual(scanned, ['zip1', 'alias1', 'zip2', 'tree']); assert.equal(copied.length, 0);
  assert.equal(batch.parts.length, 3); assert.equal(batch.memories, 1); assert.equal(batch.overlays, 1);
  await importBatch(batch, async part => { copied.push(part.selection.uri); }, () => false);
  assert.deepEqual(copied, ['zip1', 'zip2', 'tree']); assert.equal(batch.parts[2]!.hash, null);
});
test('more than eight parts can be reviewed together, while the aggregate scan quota still applies', async () => {
  const selected = Array.from({ length: 10 }, (_, i) => zip(String(i)));
  const batch = await scanImportBatch(selected, async part => scan([`2026-02-05_m${part.uri}-main.jpg`], Number(part.uri).toString(16).repeat(64)), () => false, () => {});
  assert.equal(batch.memories, 10);
  await assert.rejects(scanImportBatch(selected, async part => ({ ...scan([], Number(part.uri).toString(16).repeat(64)), visitedEntries: 50_001 }), () => false, () => {}), /selection-limit/);
  await assert.rejects(scanImportBatch([zip('empty')], async () => scan([]), () => false, () => {}), /no-media/);
});
test('cancellation and a failed part stop the batch without touching later parts', async () => {
  let stopped = false;
  await assert.rejects(scanImportBatch([zip('one')], async () => { stopped = true; return scan(['2026-02-05_one-main.jpg']); }, () => stopped, () => {}), /cancelled/);
  const batch = await scanImportBatch([zip('one'), zip('two')], async part => scan(['2026-02-05_one-main.jpg'], (part.uri === 'one' ? 'a' : 'b').repeat(64)), () => false, () => {});
  const calls: string[] = [];
  await assert.rejects(importBatch(batch, async part => { calls.push(part.selection.uri); throw new Error('insufficient-storage'); }, () => false), /insufficient-storage/);
  assert.deepEqual(calls, ['one']);
  await assert.rejects(importBatch(batch, async () => { throw new Error('must not run'); }, () => true), /cancelled/);
});
