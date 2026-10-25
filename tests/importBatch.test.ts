import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanImportBatch, importBatch } from '../src/import/importBatch.ts';
import type { DirectorySnapshot } from '../src/import/sourceInventory.ts';
import { ImportStore, type Receipt } from '../src/storage/importStore.ts';
import { runImport, type OriginalCopier } from '../src/import/runImport.ts';
import { runFolderImport, type FolderCopier } from '../src/import/runFolderImport.ts';
import { LibraryDB } from './helpers/libraryDb.ts';
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

test('ten ZIP plans import through the real store and resume past part nine after an interrupted copy', async t => {
  const db = new LibraryDB(); t.after(() => db.raw.close()); const store = new ImportStore(db); await store.initialize();
  const selections = Array.from({ length: 10 }, (_, i) => zip(String(i)));
  const snapshot = (uri: string) => scan([`2026-02-05_m${uri}-main.jpg`], Number(uri).toString(16).repeat(64));
  const batch = await scanImportBatch(selections, async part => snapshot(part.uri), () => false, () => {});
  assert.equal((await store.summary()).files, 0, 'scanning has not planned or copied anything');
  const copied: string[] = [], confirmed: string[] = [], opened: string[] = [];
  let interrupted = true, closed = 0;
  const object: Receipt = { sha256: 'e'.repeat(64), bytes: 10, relativePath: `objects/ee/${'e'.repeat(64)}` };
  const copier: OriginalCopier = {
    async open(uri) { opened.push(uri); },
    async preserve(path) { if (interrupted && path.includes('_m8-')) throw new Error('cancelled'); copied.push(path); return object; },
    async confirm(hash) { confirmed.push(hash); }, async close() { closed++; },
  };
  const run = async (part: typeof batch.parts[number]) => {
    await store.plan(part.hash!, part.source);
    await runImport(store, copier, part.hash!, part.selection.uri, () => false, () => {});
  };
  await assert.rejects(importBatch(batch, run, () => false), /cancelled/);
  assert.equal((await store.summary()).memories, 8); assert.equal(closed, 9);
  interrupted = false;
  const reselected = await scanImportBatch(selections, async part => snapshot(part.uri), () => false, () => {});
  await importBatch(reselected, run, () => false);
  assert.equal((await store.summary()).memories, 10); assert.equal((await store.summary()).unfinished, 0);
  assert.equal(copied.length, 10); assert.equal(confirmed.length, 8); assert.equal(closed, 19);
  assert.deepEqual(opened.slice(-10), selections.map(part => part.uri));
  assert.equal(db.raw.prepare('SELECT count(*) AS n FROM import_jobs').get()!.n, 10);
});

test('a folder after nine ZIP parts also gets a valid single-source plan and runs the folder importer', async t => {
  const db = new LibraryDB(); t.after(() => db.raw.close()); const store = new ImportStore(db); await store.initialize();
  const selections = [...Array.from({ length: 9 }, (_, i) => zip(String(i))), { kind: 'directory' as const, uri: 'tree' }];
  const folder = scan(['2026-02-05_folder-main.jpg']);
  const batch = await scanImportBatch(selections, async part => part.kind === 'directory' ? folder : scan([`2026-02-05_m${part.uri}-main.jpg`], Number(part.uri).toString(16).repeat(64)), () => false, () => {});
  const part = batch.parts.at(-1)!; const hash = await store.planFolder(part.source); let closed = 0;
  const copier: FolderCopier = { async open(uri) { assert.equal(uri, 'tree'); return { ...folder, sizes: [10] }; }, async prepare() {},
    async preserve() { return { sha256: 'f'.repeat(64), relativePath: `objects/ff/${'f'.repeat(64)}`, bytes: 10 }; }, async confirm() {}, async close() { closed++; } };
  const result = await runFolderImport(store, copier, hash, part.selection.uri, () => false, () => {});
  assert.equal(result.complete, true); assert.equal(result.preserved, 1); assert.equal(closed, 1);
});
