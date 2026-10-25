import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LibraryDB } from './helpers/libraryDb.ts';
import { ImportStore } from '../src/storage/importStore.ts';
import { inventoryFromSnapshot } from '../src/import/sourceInventory.ts';
import { resetLibrary, type ResetBridge } from '../src/integrity/resetLibrary.ts';

const tables = ['memory_objects', 'import_items', 'import_jobs', 'library_favorites', 'library_dates', 'memories', 'stored_objects', 'memory_deletions'];
async function setup(t: { after(fn: () => void): void }) {
  const db = new LibraryDB(); t.after(() => db.raw.close()); const store = new ImportStore(db); await store.initialize();
  const source = inventoryFromSnapshot({ entries: [{ path: '2026-01-02_one-main.jpg' }], visitedEntries: 1, metadataBytes: 0 }, 'source-1');
  await store.plan('a'.repeat(64), source);
  await store.commit('a'.repeat(64), 0, { sha256: 'b'.repeat(64), bytes: 1, relativePath: `objects/bb/${'b'.repeat(64)}` });
  await store.setFavorite('one', true); await db.runAsync("INSERT INTO memory_deletions VALUES ('previously-deleted')");
  return { db, store, source };
}
function bridge(db: LibraryDB) {
  let held = false; const calls: string[] = [];
  const fake: ResetBridge = {
    async beginStorageReview(mode) { assert.equal(mode, 'cleanup'); held = true; calls.push('begin'); return { ok: true }; },
    async clearLibraryFiles() {
      assert.ok(held); assert.equal(db.active, true, 'the second transaction keeps the empty-reference proof valid through unlink');
      for (const table of tables) assert.equal(db.raw.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n, 0);
      calls.push('files'); return { ok: true };
    },
    async endStorageReview() { assert.ok(held); held = false; calls.push('end'); return { ok: true }; },
  };
  return { fake, calls };
}
test('reset holds the cleanup session through metadata commit, preview clear and file removal; old exports can be planned again', async t => {
  const { db, store, source } = await setup(t); const { fake, calls } = bridge(db);
  assert.deepEqual(await resetLibrary(db, fake, async () => { assert.equal(db.active, false, 'metadata committed before cleanup'); calls.push('preview'); }), { cleared: true, cleanupFailed: false });
  assert.deepEqual(calls, ['begin', 'preview', 'files', 'end']);
  await store.plan('a'.repeat(64), source);
  assert.equal((await store.item('a'.repeat(64), -1))?.state, 'pending');
  assert.equal(db.raw.prepare('SELECT count(*) AS n FROM memory_deletions').get()!.n, 0);
});
test('database failure rolls back everything, never removes files, and ends once without replacing the error', async t => {
  const { db, store } = await setup(t); const { fake, calls } = bridge(db);
  db.failSql = 'DELETE FROM memories'; fake.endStorageReview = async () => { calls.push('end'); throw new Error('end-failed'); };
  await assert.rejects(resetLibrary(db, fake, async () => { calls.push('preview'); }), /injected-db-failure/);
  assert.equal((await store.summary()).memories, 1); assert.equal((await store.objects('one')).length, 1);
  assert.deepEqual(calls, ['begin', 'end']);
});
test('busy and unsupported schemas leave files untouched', async t => {
  const { db } = await setup(t); const { fake, calls } = bridge(db);
  const begin = fake.beginStorageReview; fake.beginStorageReview = async () => ({ ok: false, code: 'busy' });
  await assert.rejects(resetLibrary(db, fake, async () => {}), /busy/); assert.deepEqual(calls, []);
  fake.beginStorageReview = begin; await db.execAsync('PRAGMA user_version=99');
  await assert.rejects(resetLibrary(db, fake, async () => {}), /storage-schema-unsupported/);
  assert.deepEqual(calls, ['begin', 'end']);
});
test('preview, file and close cleanup failures report a committed empty library; a retry is idempotent', async t => {
  const { db } = await setup(t); const { fake, calls } = bridge(db);
  fake.clearLibraryFiles = async () => { calls.push('files'); return { ok: false }; };
  fake.endStorageReview = async () => { calls.push('end'); return { ok: false }; };
  assert.deepEqual(await resetLibrary(db, fake, async () => { throw new Error('preview-failed'); }), { cleared: true, cleanupFailed: true });
  for (const table of tables) assert.equal(db.raw.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n, 0);
  const retry = bridge(db); assert.equal((await resetLibrary(db, retry.fake, async () => {})).cleanupFailed, false);
});
test('a new object reference between the metadata commit and cleanup protects every file', async t => {
  const { db, store, source } = await setup(t); const { fake, calls } = bridge(db);
  const transaction = db.withExclusiveTransactionAsync.bind(db); let commits = 0;
  db.withExclusiveTransactionAsync = async work => {
    await transaction(work);
    if (++commits === 1) {
      await store.plan('a'.repeat(64), source);
      await store.commit('a'.repeat(64), 0, { sha256: 'b'.repeat(64), bytes: 1, relativePath: `objects/bb/${'b'.repeat(64)}` });
    }
  };
  assert.equal((await resetLibrary(db, fake, async () => {})).cleanupFailed, true);
  assert.deepEqual(calls, ['begin', 'end']); assert.equal((await store.summary()).memories, 1);
});

test('reset reserves the WAL writer before its second proof and holds it through file removal', async t => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { DatabaseSync } = await import('node:sqlite');
  const dir = mkdtempSync(join(tmpdir(), 'reset-wal-'));
  const db = new LibraryDB(join(dir, 'library.db'));
  db.raw.exec('PRAGMA journal_mode=WAL');
  const store = new ImportStore(db); await store.initialize();
  const other = new DatabaseSync(join(dir, 'library.db'), { timeout: 0 });
  t.after(() => { other.close(); db.raw.close(); rmSync(dir, { recursive: true, force: true }); });
  const insert = () => other.prepare('INSERT INTO stored_objects(hash,relative_path,bytes) VALUES (?,?,?)')
    .run('c'.repeat(64), `objects/cc/${'c'.repeat(64)}`, 1);
  const { fake, calls } = bridge(db);
  fake.clearLibraryFiles = async () => {
    assert.throws(insert, /locked|busy/i, 'a competing writer cannot invalidate the empty proof before unlink');
    calls.push('files'); return { ok: true };
  };
  assert.deepEqual(await resetLibrary(db, fake, async () => {}), { cleared: true, cleanupFailed: false });
  assert.deepEqual(calls, ['begin', 'files', 'end']);
  insert(); // The transaction released its writer reservation.
});
