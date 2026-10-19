import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ImportStore, type Receipt } from '../src/storage/importStore.ts';
import { runImport, type OriginalCopier } from '../src/import/runImport.ts';
import type { SqlDatabase, SqlConnection } from '../src/storage/previewStore.ts';
import { inventoryFromSnapshot } from '../src/import/sourceInventory.ts';
class DB implements SqlDatabase {
  raw: DatabaseSync; failSql = '';
  constructor(path: string) { this.raw = new DatabaseSync(path); }
  async execAsync(sql: string) { this.raw.exec(sql); }
  async runAsync(sql: string, ...p: (string | number | null)[]) { this.raw.prepare(sql).run(...p); if (this.failSql && sql.includes(this.failSql)) throw new Error('injected-db-failure'); }
  async getFirstAsync<T>(sql: string, ...p: (string | number | null)[]) { return (this.raw.prepare(sql).get(...p) as T | undefined) ?? null; }
  async withExclusiveTransactionAsync(work: (tx: SqlConnection) => Promise<void>) {
    this.raw.exec('BEGIN IMMEDIATE'); try { await work(this); this.raw.exec('COMMIT'); } catch (error) { this.raw.exec('ROLLBACK'); throw error; }
  }
}
const hash = 'a'.repeat(64);
const receipt = (letter = 'b'): Receipt => ({ sha256: letter.repeat(64), relativePath: `objects/${letter.repeat(2)}/${letter.repeat(64)}`, bytes: 10 });
const source = (names = ['one', 'two']) => inventoryFromSnapshot({ entries: names.map(name => ({ path: `2026-02-05_${name}-main.jpg` })), metadataBytes: 0, visitedEntries: names.length }, 'source-1');
class Copier implements OriginalCopier {
  preserved: string[] = []; confirmed: string[] = []; closed = 0; failAt = 0; failConfirm = false;
  async open(_uri: string, _hash: string, _remaining: number) {}
  async preserve(path: string) { this.preserved.push(path); if (this.failAt === this.preserved.length) throw new Error('cancelled'); return receipt(); }
  async confirm(hash: string, _bytes: number) { if (this.failConfirm) throw new Error('stored-object-corrupt'); this.confirmed.push(hash); }
  async close() { this.closed++; }
}
async function setup(t: { after: (fn: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), 'snarchive-jobs-')); const path = join(dir, 'library.db');
  const db = new DB(path); t.after(() => { try { db.raw.close(); } catch {} rmSync(dir, { recursive: true, force: true }); });
  const store = new ImportStore(db); await store.initialize(); await store.plan(hash, source()); return { db, store, path };
}
test('planning is idempotent and cannot expose pending files as stored memories', async t => {
  const { store } = await setup(t); await store.plan(hash, source());
  assert.deepEqual(await store.summary(), { files: 0, objects: 0, memories: 0, unfinished: 1, conflicts: 0 });
  await assert.rejects(store.state(hash, 'completed'));
});
test('distinct memories share stored bytes without merging their identities', async t => {
  const { store } = await setup(t); const copier = new Copier();
  await runImport(store, copier, hash, 'synthetic', () => false, () => {});
  assert.deepEqual(await store.summary(), { files: 2, objects: 1, memories: 2, unfinished: 0, conflicts: 0 });
  assert.equal(copier.closed, 1);
});
test('interrupted job reopens and confirms completed files before continuing', async t => {
  const { store, db, path } = await setup(t); const first = new Copier(); first.failAt = 2;
  await assert.rejects(runImport(store, first, hash, 'synthetic', () => false, () => {}));
  assert.equal((await store.summary()).files, 1); db.raw.close();
  const reopened = new DB(path); const next = new ImportStore(reopened); await next.initialize(); const second = new Copier();
  try {
    await runImport(next, second, hash, 'synthetic', () => false, () => {});
    assert.equal(second.preserved.length, 1); assert.equal(second.confirmed.length, 1);
    assert.equal((await next.summary()).unfinished, 0);
  } finally { reopened.raw.close(); }
});
test('database failure rolls back file receipt and memory associations together', async t => {
  const { store, db } = await setup(t); db.failSql = 'UPDATE import_items';
  await assert.rejects(store.commit(hash, 0, receipt()));
  assert.deepEqual(await store.summary(), { files: 0, objects: 0, memories: 0, unfinished: 1, conflicts: 0 });
  db.failSql = ''; await store.commit(hash, 0, receipt()); assert.equal((await store.summary()).files, 1);
});
test('finalized but uncommitted bytes are retried after database failure', async t => {
  const { store, db } = await setup(t); const copier = new Copier(); db.failSql = 'UPDATE import_items';
  await assert.rejects(runImport(store, copier, hash, 'synthetic', () => false, () => {}));
  assert.equal(copier.preserved.length, 1); assert.equal((await store.summary()).files, 0);
  db.failSql = ''; await runImport(store, copier, hash, 'synthetic', () => false, () => {});
  assert.equal(copier.preserved.length, 3); assert.equal((await store.summary()).files, 2);
});
test('completed reimport confirms objects without copying or duplicating links', async t => {
  const { store } = await setup(t); const copier = new Copier();
  await runImport(store, copier, hash, 'synthetic', () => false, () => {});
  await runImport(store, copier, hash, 'synthetic', () => false, () => {});
  assert.equal(copier.preserved.length, 2); assert.equal(copier.confirmed.length, 2); assert.equal((await store.summary()).memories, 2);
});
test('competing bytes for the same memory remain separate and report a conflict', async t => {
  const { store } = await setup(t); await store.commit(hash, 0, receipt());
  const second = 'c'.repeat(64); await store.plan(second, source(['one'])); await store.commit(second, 0, receipt('d'));
  const summary = await store.summary(); assert.equal(summary.memories, 1); assert.equal(summary.objects, 2); assert.equal(summary.conflicts, 1);
});
test('overlay-only records do not count as memories with base media', async t => {
  const { store } = await setup(t); const other = 'c'.repeat(64);
  const overlay = inventoryFromSnapshot({ entries: [{ path: '2026-02-05_orphan-overlay.png' }], metadataBytes: 0, visitedEntries: 1 }, 'source-1');
  await store.plan(other, overlay); await store.commit(other, 0, receipt()); assert.equal((await store.summary()).memories, 0);
});
test('invalid native receipts cannot create objects or completed work', async t => {
  const { store } = await setup(t);
  await assert.rejects(store.commit(hash, 0, { ...receipt(), relativePath: '../outside' }));
  await assert.rejects(store.commit(hash, 0, { ...receipt(), bytes: -1 })); assert.equal((await store.summary()).files, 0);
});
test('missing/corrupt completed objects stop resume instead of claiming completion', async t => {
  const { store } = await setup(t); await store.commit(hash, 0, receipt()); const copier = new Copier(); copier.failConfirm = true;
  await assert.rejects(runImport(store, copier, hash, 'synthetic', () => false, () => {}), /stored-object-corrupt/);
  assert.equal(copier.preserved.length, 0); assert.equal((await store.summary()).unfinished, 1);
});
test('cancellation after finalization commits the complete file and pauses remaining work', async t => {
  const { store } = await setup(t); const copier = new Copier(); let stopped = false;
  await assert.rejects(runImport(store, copier, hash, 'synthetic', () => stopped, () => { stopped = true; }), /cancelled/);
  assert.equal((await store.summary()).files, 1); assert.equal((await store.summary()).unfinished, 1); assert.equal(copier.closed, 1);
});
test('changed source cannot advance pending work', async t => {
  const { store } = await setup(t); const copier = new Copier(); copier.open = async () => { throw new Error('source-changed'); };
  await assert.rejects(runImport(store, copier, hash, 'wrong', () => false, () => {}), /source-changed/); assert.equal((await store.summary()).files, 0);
});

test('library pages exclude pending and overlay-only records and keep shared-byte identities', async t => {
  const { store } = await setup(t);
  assert.deepEqual(await store.page(), []);
  await store.commit(hash, 0, receipt()); await store.commit(hash, 1, receipt());
  const first = await store.page('', 1); assert.equal(first[0]?.id, 'one');
  assert.equal(first[0]?.day, '2026-02-05'); assert.equal(first[0]?.instant, null);
  assert.equal(first[0]?.photos, 1);
  assert.equal((await store.page('one', 1))[0]?.id, 'two');
  assert.deepEqual(await store.page('two'), []);
  await assert.rejects(store.page('', 101));
  const overlay = inventoryFromSnapshot({ entries: [{ path: '2026-02-05_orphan-overlay.png' }], metadataBytes: 0, visitedEntries: 1 }, 'source-2');
  await store.plan('c'.repeat(64), overlay); await store.commit('c'.repeat(64), 0, receipt());
  assert.equal((await store.page()).length, 2);
  assert.deepEqual(await store.objects('one'), [{ role: 'photo', ...receipt() }]);
});
test('late metadata enriches existing memories and contradictory instants are explicit', async t => {
  const { store } = await setup(t); await store.commit(hash, 0, receipt());
  const metadata = (date: string) => inventoryFromSnapshot({ entries: [{ path: 'memories_history.json', metadataText: JSON.stringify({ 'Saved Media': [{ Date: date, 'Media Type': 'Image', 'Download Link': 'https://example.test/?mid=one' }] }) }], metadataBytes: 500, visitedEntries: 1 }, 'source-2');
  await store.plan('c'.repeat(64), metadata('2026-02-05 12:00:00 UTC'));
  assert.equal((await store.page())[0]?.instant, '2026-02-05T12:00:00.000Z');
  assert.equal((await store.page())[0]?.dateConflict, 0);
  await store.plan('d'.repeat(64), metadata('2026-02-05 13:00:00 UTC'));
  assert.equal((await store.page())[0]?.dateConflict, 1);
});
test('version-one migration backfills dates without losing receipts, and can reopen', async t => {
  const { store, db } = await setup(t); await store.commit(hash, 0, receipt());
  db.raw.exec('DROP TABLE library_favorites; DROP TABLE library_dates; DROP INDEX memory_objects_by_memory; DROP INDEX import_items_by_memory; PRAGMA user_version=1;');
  await store.initialize(); await store.initialize();
  assert.equal((await store.summary()).files, 1);
  assert.equal((await store.page())[0]?.day, '2026-02-05');
});
test('failed date migration rolls back and leaves the previous database intact', async t => {
  const { store, db } = await setup(t); await store.commit(hash, 0, receipt());
  db.raw.exec("DROP TABLE library_favorites; DROP TABLE library_dates; DROP INDEX memory_objects_by_memory; DROP INDEX import_items_by_memory; PRAGMA user_version=1; UPDATE import_jobs SET plan_json='invalid';");
  await assert.rejects(store.initialize());
  assert.equal((db.raw.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 1);
  assert.equal((await store.summary()).files, 1);
});
test('library reports competing photo and overlay versions instead of choosing one', async t => {
  const { store } = await setup(t); await store.commit(hash, 0, receipt());
  const other = 'c'.repeat(64); await store.plan(other, source(['one'])); await store.commit(other, 0, receipt('d'));
  assert.equal((await store.page())[0]?.photos, 2);
  assert.equal((await store.objects('one')).length, 2);
});
test('bounded object reads retain the base when many overlay variants exist', async t => {
  const { store } = await setup(t); await store.commit(hash, 0, receipt());
  for (const letter of ['c', 'd', 'e']) {
    const overlay = inventoryFromSnapshot({ entries: [{ path: '2026-02-05_one-overlay.png' }], metadataBytes: 0, visitedEntries: 1 }, 'source-2');
    await store.plan(letter.repeat(64), overlay); await store.commit(letter.repeat(64), 0, receipt(letter));
  }
  assert.equal((await store.page())[0]?.overlays, 3);
  assert.equal((await store.objects('one'))[0]?.role, 'photo');
  assert.equal((await store.objects('one')).length, 3);
});

test('chronological cursor pages order dates, timed evidence, ties, and uncertain dates without gaps', async t => {
  const { store } = await setup(t);
  const other = 'f'.repeat(64);
  const names = ['2026-10-18_z-main.jpg', '2026-10-18_a-main.jpg', '2026-10-18_timed-main.jpg', '2026-10-17_older-main.jpg', '2026-02-30_unknown-main.jpg', '2026-10-18_conflict-main.jpg'];
  const metadata = JSON.stringify({ 'Saved Media': [
    { Date: '2026-10-18 12:00:00 UTC', 'Media Type': 'Image', 'Download Link': 'https://example.test/?mid=timed' },
    { Date: '2026-10-19 12:00:00 UTC', 'Media Type': 'Image', 'Download Link': 'https://example.test/?mid=conflict' },
  ] });
  const input = inventoryFromSnapshot({ entries: [...names.map(path => ({ path })), { path: 'memories_history.json', metadataText: metadata }], metadataBytes: metadata.length, visitedEntries: 7 }, 'source-2');
  await store.plan(other, input);
  assert.deepEqual(await store.chronologicalPage(), []);
  for (let i = 0; i < names.length; i++) await store.commit(other, i, receipt());
  const all = await store.chronologicalPage();
  assert.deepEqual(all.map(row => row.id), ['timed', 'a', 'z', 'older', 'conflict', 'unknown']);
  assert.equal(all[4]?.sortDay, ''); assert.equal(all[4]?.dateConflict, 1);
  assert.equal(all[5]?.day, null);
  const visited: string[] = []; let cursor: { day: string; time: string; id: string } | null = null;
  for (;;) {
    const page = await store.chronologicalPage(cursor, 2); if (!page.length) break;
    visited.push(...page.map(row => row.id)); const last = page[page.length - 1]!;
    cursor = { day: last.sortDay, time: last.sortTime, id: last.id };
  }
  assert.deepEqual(visited, all.map(row => row.id));
  await assert.rejects(store.chronologicalPage(null, 101));
});
test('new date evidence changes chronological order without changing stored identity', async t => {
  const { store } = await setup(t); await store.commit(hash, 0, receipt());
  const input = inventoryFromSnapshot({ entries: [{ path: '2026-10-18_new-main.jpg' }], metadataBytes: 0, visitedEntries: 1 }, 'source-2');
  await store.plan('c'.repeat(64), input); await store.commit('c'.repeat(64), 0, receipt());
  assert.deepEqual((await store.chronologicalPage()).map(row => row.id), ['new', 'one']);
  await store.plan('d'.repeat(64), inventoryFromSnapshot({ entries: [{ path: '2026-10-19_new-main.jpg' }], metadataBytes: 0, visitedEntries: 1 }, 'source-3'));
  assert.deepEqual((await store.chronologicalPage()).map(row => row.id), ['one', 'new']);
  assert.equal((await store.summary()).objects, 1);
});

test('favorites persist across database reopening without merging shared-byte memories', async t => {
  const { store, db, path } = await setup(t); await store.commit(hash, 0, receipt()); await store.commit(hash, 1, receipt());
  await store.setFavorite('one', true); await store.setFavorite('one', true);
  db.raw.close(); const reopened = new DB(path); const next = new ImportStore(reopened);
  try {
    await next.initialize();
    const rows = await next.chronologicalPage(null, 30, { media: 'all', favorites: true, month: '' });
    assert.deepEqual(rows.map(row => row.id), ['one']); assert.equal(rows[0]?.favorite, 1);
    assert.equal((await next.summary()).objects, 1);
    await next.setFavorite('one', false);
    assert.equal((await next.chronologicalPage(null, 30, { media: 'all', favorites: true, month: '' })).length, 0);
  } finally { reopened.raw.close(); }
});
test('favorite write failure rolls back, and pending or unknown memories cannot be favorited', async t => {
  const { store, db } = await setup(t);
  await assert.rejects(store.setFavorite('one', true)); await assert.rejects(store.setFavorite('missing', true));
  await store.commit(hash, 0, receipt()); db.failSql = 'INSERT OR IGNORE INTO library_favorites';
  await assert.rejects(store.setFavorite('one', true)); db.failSql = '';
  assert.equal((await store.chronologicalPage())[0]?.favorite, 0);
});
test('schema two upgrade preserves imported files and creates favorites atomically', async t => {
  const { store, db } = await setup(t); await store.commit(hash, 0, receipt());
  db.raw.exec('DROP TABLE library_favorites; PRAGMA user_version=2;');
  await store.initialize(); await store.initialize(); await store.setFavorite('one', true);
  assert.equal((await store.summary()).files, 1);
  assert.equal((await store.chronologicalPage())[0]?.favorite, 1);
});
test('media, month, and favorite filters compose before cursor pagination', async t => {
  const { store } = await setup(t); await store.commit(hash, 0, receipt());
  const other = 'f'.repeat(64);
  const names = ['2026-10-18_clip-main.mp4', '2026-10-17_photo-main.jpg', '2026-09-01_sept-main.mp4', '2026-02-30_unknown-main.mp4'];
  await store.plan(other, inventoryFromSnapshot({ entries: names.map(path => ({ path })), visitedEntries: names.length, metadataBytes: 0 }, 'source-2'));
  for (let i = 0; i < names.length; i++) await store.commit(other, i, receipt());
  await store.setFavorite('clip', true); await store.setFavorite('sept', true);
  const filters = { media: 'videos' as const, favorites: true, month: '' };
  const first = (await store.chronologicalPage(null, 1, filters))[0]!;
  assert.equal(first.id, 'clip');
  const second = await store.chronologicalPage({ day: first.sortDay, time: first.sortTime, id: first.id }, 1, filters);
  assert.equal(second[0]?.id, 'sept');
  assert.deepEqual((await store.chronologicalPage(null, 30, { ...filters, month: '2026-10' })).map(row => row.id), ['clip']);
  assert.deepEqual((await store.chronologicalPage(null, 30, { media: 'photos', favorites: false, month: '2026-10' })).map(row => row.id), ['photo']);
  await assert.rejects(store.chronologicalPage(null, 30, { ...filters, month: '2026-13' }));
  await store.plan('e'.repeat(64), inventoryFromSnapshot({ entries: [{ path: '2026-10-19_clip-main.mp4' }], visitedEntries: 1, metadataBytes: 0 }, 'source-3'));
  assert.equal((await store.chronologicalPage(null, 30, { ...filters, month: '2026-10' })).length, 0);
  assert.equal((await store.chronologicalPage(null, 30, filters)).length, 2);
});
