import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ImportStore, type Receipt } from '../src/storage/importStore.ts';
import { inventoryFromSnapshot } from '../src/import/sourceInventory.ts';
import { runImport, type OriginalCopier } from '../src/import/runImport.ts';
import { deleteLibraryMemory, type MemoryDeleteBridge } from '../src/integrity/deleteMemory.ts';
import type { StorageEntry } from '../src/integrity/storageCleanup.ts';
import { LibraryDB } from './helpers/libraryDb.ts';
const hash = 'a'.repeat(64);
const receipt = (letter: string): Receipt => ({ sha256: letter.repeat(64), relativePath: `objects/${letter.repeat(2)}/${letter.repeat(64)}`, bytes: 10 });
const shared = receipt('b'), layer = receipt('c');
async function setup(t: { after(fn: () => void): void }) {
  const db = new LibraryDB(); t.after(() => db.raw.close()); const store = new ImportStore(db); await store.initialize();
  const source = inventoryFromSnapshot({ entries: ['2026-02-05_one-main.jpg', '2026-02-05_one-overlay.png', '2026-02-05_two-main.jpg'].map(path => ({ path })), visitedEntries: 3, metadataBytes: 0 }, 'source-1');
  await store.plan(hash, source); await store.commit(hash, 0, shared); await store.commit(hash, 1, layer); await store.commit(hash, 2, shared);
  await store.setFavorite('one', true);
  return { db, store, source };
}
test('delete removes live associations and favourites, keeping shared bytes and source-date evidence', async t => {
  const { db, store } = await setup(t);
  assert.deepEqual((await store.deleteMemory('one')).map(row => ({ ...row })), [layer]);
  assert.deepEqual((await store.page()).map(row => row.id), ['two']);
  assert.equal((await store.summary()).objects, 1);
  for (const table of ['memory_objects', 'library_favorites']) assert.equal(db.raw.prepare(`SELECT count(*) AS n FROM ${table} WHERE memory_id='one'`).get()!.n, 0);
  assert.deepEqual(db.raw.prepare("SELECT state,object_hash FROM import_items WHERE memory_id='one'").all().map(row => [row.state, row.object_hash]), [['pending', null], ['pending', null]]);
  assert.equal(db.raw.prepare("SELECT count(*) AS n FROM library_dates WHERE memory_id='one'").get()!.n, 1, 'source-derived date evidence retained for explicit restore');
  assert.equal((await store.item(hash, -1))?.memory_id, 'two');
  assert.equal(await store.hasPending(hash), false);
  await store.state(hash, 'completed');
  assert.deepEqual(await store.deleteMemory('one'), []);
  assert.deepEqual((await store.deleteMemory('two')).map(row => ({ ...row })), [shared]);
  assert.equal((await store.summary()).objects, 0);
});
test('resuming and re-planning either source kind cannot resurrect a deleted memory, including a stale commit', async t => {
  const { store, source } = await setup(t); await store.deleteMemory('one');
  await store.plan(hash, source); await store.commit(hash, 0, shared);
  const copied: string[] = [], confirmed: string[] = [];
  const copier: OriginalCopier = { async open() {}, async preserve(path) { copied.push(path); return shared; }, async confirm(hash) { confirmed.push(hash); }, async close() {} };
  await runImport(store, copier, hash, 'synthetic', () => false, () => {});
  assert.deepEqual(copied, []); assert.deepEqual(confirmed, [shared.sha256]);
  const folder = await store.planFolder(source);
  let ordinal = -1;
  for (;;) { const item = await store.item(folder, ordinal); if (!item) break; assert.equal(item.memory_id, 'two'); ordinal = item.ordinal; }
  assert.deepEqual((await store.page()).map(row => row.id), ['two']);
});
test('a delete transaction failure rolls back the tombstone, links, receipts and favourite together', async t => {
  const { db, store } = await setup(t); db.failSql = 'DELETE FROM memories';
  await assert.rejects(store.deleteMemory('one'), /injected-db-failure/);
  assert.equal((await store.summary()).memories, 2); assert.equal((await store.objects('one')).length, 2);
  assert.equal(db.raw.prepare('SELECT count(*) AS n FROM memory_deletions').get()!.n, 0);
  assert.equal(db.raw.prepare("SELECT count(*) AS n FROM library_favorites WHERE memory_id='one'").get()!.n, 1);
});
test('schema 5 upgrades without changing existing library data, receipts or plans', async t => {
  const { db, store } = await setup(t);
  const before = db.raw.prepare('SELECT * FROM import_items ORDER BY ordinal').all();
  db.raw.exec('DROP TABLE memory_deletions; PRAGMA user_version=5');
  await store.initialize();
  assert.equal(db.raw.prepare('PRAGMA user_version').get()!.user_version, 6);
  assert.deepEqual(db.raw.prepare('SELECT * FROM import_items ORDER BY ordinal').all(), before);
  assert.equal((await store.summary()).memories, 2);
});
function fake(db: LibraryDB, objects: Receipt[]) {
  let active = false, session = 0;
  const removed: string[] = [], evicted: string[] = [];
  const files: StorageEntry[] = objects.map(r => ({ kind: 'object', path: r.relativePath, hash: r.sha256, bytes: r.bytes, identity: r.sha256, modified: 1 }));
  const options = { endFails: false, beginFails: false, afterFirstEnd: () => {}, pageFails: false };
  const bridge: MemoryDeleteBridge = {
    async beginStorageReview() { if (options.beginFails) return { ok: false, code: 'storage-busy' }; assert.equal(active, false); active = true; session++; return { ok: true }; },
    async reviewStoragePage() { assert.equal(active, true); return options.pageFails ? { ok: false } : { ok: true, entries: files, next: null }; },
    async removeStorageEntry(_kind, path) { assert.equal(active, true); assert.equal(db.active, true); assert.equal(db.raw.prepare("SELECT count(*) AS n FROM memories WHERE id='one'").get()!.n, 0, 'DB delete already committed'); removed.push(path); return { ok: true, outcome: 'removed' }; },
    async evictStorageThumbnail(hash) { assert.equal(active, true); evicted.push(hash); return { ok: true }; },
    async endStorageReview() { assert.equal(active, true); active = false; if (session === 1) options.afterFirstEnd(); return { ok: !options.endFails }; },
  };
  return { bridge, removed, evicted, options, sessions: () => session };
}
test('deletion commits before native unlink, re-proves references, and evicts only unshared derivatives', async t => {
  const { db, store } = await setup(t); const native = fake(db, [shared, layer]);
  assert.deepEqual(await deleteLibraryMemory(store, native.bridge, 'one'), { deleted: true, cleanupFailed: false });
  assert.deepEqual(native.removed, [layer.relativePath]); assert.deepEqual(native.evicted, [layer.sha256]); assert.equal(native.sessions(), 3);
});
test('a reference acquired between cleanup sessions protects the file at the last deletion proof', async t => {
  const { db, store } = await setup(t); const native = fake(db, [layer]);
  native.options.afterFirstEnd = () => { db.raw.prepare('INSERT INTO stored_objects VALUES (?,?,?)').run(layer.sha256, layer.relativePath, layer.bytes); };
  assert.equal((await deleteLibraryMemory(store, native.bridge, 'one')).deleted, true);
  assert.deepEqual(native.removed, []);
});
test('busy and DB failures remove nothing; a post-commit page/end failure keeps the completed deletion', async t => {
  const { db, store } = await setup(t); const native = fake(db, [layer]);
  native.options.beginFails = true; await assert.rejects(deleteLibraryMemory(store, native.bridge, 'one'), /storage-busy/);
  assert.equal((await store.summary()).memories, 2); assert.deepEqual(native.removed, []);
  native.options.beginFails = false; db.failSql = 'DELETE FROM memories';
  await assert.rejects(deleteLibraryMemory(store, native.bridge, 'one'), /injected-db-failure/); assert.deepEqual(native.removed, []);
  db.failSql = ''; native.options.pageFails = true; native.options.endFails = true;
  assert.deepEqual(await deleteLibraryMemory(store, native.bridge, 'one'), { deleted: true, cleanupFailed: true });
  assert.equal((await store.summary()).memories, 1); assert.deepEqual(native.removed, []);
});
