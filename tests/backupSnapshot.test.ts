import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { ImportStore, LIBRARY_SCHEMA_VERSION, type Receipt } from '../src/storage/importStore.ts';
import { inventoryFromSnapshot } from '../src/import/sourceInventory.ts';
import { BACKUP_SCHEMA_VERSION, writeBackupSnapshot } from '../src/backup/snapshot.ts';
import type { SqlDatabase, SqlConnection } from '../src/storage/previewStore.ts';
class DB implements SqlDatabase {
  raw = new DatabaseSync(':memory:');
  active = false;
  queries = 0;
  async execAsync(sql: string) { this.raw.exec(sql); }
  async runAsync(sql: string, ...p: (string | number | null)[]) { this.raw.prepare(sql).run(...p); }
  async getFirstAsync<T>(sql: string, ...p: (string | number | null)[]) { this.queries++; return (this.raw.prepare(sql).get(...p) as T | undefined) ?? null; }
  async getAllAsync<T>(sql: string, ...p: (string | number | null)[]) { this.queries++; return this.raw.prepare(sql).all(...p) as T[]; }
  async withExclusiveTransactionAsync(work: (tx: SqlConnection) => Promise<void>) {
    this.raw.exec('BEGIN IMMEDIATE'); this.active = true;
    try { await work(this); this.raw.exec('COMMIT'); } catch (e) { this.raw.exec('ROLLBACK'); throw e; } finally { this.active = false; }
  }
}
const hash = 'a'.repeat(64);
const receipt: Receipt = { sha256: 'b'.repeat(64), relativePath: `objects/bb/${'b'.repeat(64)}`, bytes: 10 };
async function setup(t: { after(fn: () => void): void }) {
  const db = new DB(); t.after(() => db.raw.close());
  const store = new ImportStore(db); await store.initialize();
  const paths = ['2026-02-05_one-main.jpg', '2026-02-05_two-main.jpg', '2026-02-05_orphan-overlay.png', '2026-02-05_pending-main.mp4'];
  await store.plan(hash, inventoryFromSnapshot({ entries: paths.map(path => ({ path })), metadataBytes: 0, visitedEntries: paths.length }, 'source-1'));
  for (let ordinal = 0; ordinal < 3; ordinal++) await store.commit(hash, ordinal, receipt);
  await store.setFavorite('one', true);
  return { db, store };
}
async function capture(db: DB) {
  const lines: string[] = [], objects: Receipt[] = [];
  await writeBackupSnapshot(db, {
    async line(line) { assert.equal(db.active, true); lines.push(line); },
    async object(object) { assert.equal(db.active, true); objects.push({ ...object }); },
  });
  return { lines, objects, records: lines.map(line => JSON.parse(line)) };
}
test('backup snapshot keeps distinct memories, shared bytes, orphan overlay and favorite', async t => {
  const { db } = await setup(t); const result = await capture(db);
  assert.deepEqual(result.objects, [receipt]);
  assert.deepEqual(result.records[0], { type: 'header', format: 'snarchive-backup', version: 1 });
  const preserved = result.records.filter(r => r.type === 'preserved');
  assert.deepEqual(preserved.map(r => [r.memoryId, r.role]), [['one', 'photo'], ['two', 'photo'], ['orphan', 'overlay']]);
  assert.ok(preserved.every(r => r.sha256 === receipt.sha256));
  assert.deepEqual(result.records.filter(r => r.type === 'favorite'), [{ type: 'favorite', memoryId: 'one' }]);
  assert.equal(result.records.at(-1).records, result.records.length - 1);
  assert.equal(result.records.at(-1).originalBytes, 10);
  const inventory = result.records.find(r => r.type === 'source').inventory;
  assert.equal(inventory.sources[0].files.length, 4); // Pending video retained as evidence, not preserved media.
  assert.equal(inventory.sources[0].files[0].captureDate.kind, 'date-only');
});
test('backup snapshot is stable and strips unknown metadata fields and device state', async t => {
  const { db } = await setup(t);
  const row = await db.getFirstAsync<{ plan_json: string }>('SELECT plan_json FROM import_jobs');
  const plan = JSON.parse(row!.plan_json); plan.untrusted = 'https://synthetic.invalid/signed?secret=fixture';
  await db.runAsync('UPDATE import_jobs SET plan_json=?', JSON.stringify(plan));
  const first = await capture(db), second = await capture(db);
  assert.deepEqual(first.lines, second.lines);
  assert.ok(!first.lines.join('').includes('secret='));
  assert.ok(!first.lines.join('').includes('plan_json'));
});
test('backup includes late metadata and conflicting source observations without choosing a winner', async t => {
  const { db, store } = await setup(t);
  const metadataText = JSON.stringify({ 'Saved Media': [{ Date: '2026-02-06 12:00:00 UTC', 'Media Type': 'Image', 'Download Link': 'https://synthetic.invalid/download?mid=one', Location: 'Latitude: 10, Longitude: 20' }] });
  const source = inventoryFromSnapshot({ entries: [{ path: 'memories_history.json', metadataText }], metadataBytes: metadataText.length, visitedEntries: 1 }, 'source-2');
  await store.plan('c'.repeat(64), source);
  const { records } = await capture(db);
  const sources = records.filter(r => r.type === 'source');
  assert.equal(sources.length, 2);
  assert.equal(sources[1].inventory.sources[0].metadata[0].records[0].memorySourceId, 'one');
  assert.equal(sources[1].inventory.sources[0].metadata[0].records[0].captureDate.utc, '2026-02-06T12:00:00.000Z');
  assert.ok(!JSON.stringify(sources).includes('Download Link'));
});
test('backup refuses broken object references or mismatched saved observations', async t => {
  const { db } = await setup(t);
  await db.runAsync('DELETE FROM stored_objects');
  await assert.rejects(capture(db), /invalid-backup-snapshot/);
  await db.runAsync('INSERT INTO stored_objects VALUES (?,?,?)', receipt.sha256, receipt.relativePath, receipt.bytes);
  await db.runAsync("UPDATE import_items SET memory_id='wrong' WHERE ordinal=0");
  await assert.rejects(capture(db), /invalid-backup-snapshot/);
});
test('failed or cancelled snapshot has no end record and leaves library unchanged', async t => {
  const { db, store } = await setup(t); const before = await store.summary();
  const lines: string[] = []; let stopped = false;
  await assert.rejects(writeBackupSnapshot(db, { async line(line) { lines.push(line); stopped = true; }, async object() {} }, () => stopped), /cancelled/);
  assert.ok(lines.every(line => JSON.parse(line).type !== 'end'));
  await assert.rejects(writeBackupSnapshot(db, { async line() { throw new Error('disk-full'); }, async object() {} }), /disk-full/);
  assert.equal(db.active, false); assert.deepEqual(await store.summary(), before);
  assert.equal((await capture(db)).records.at(-1).type, 'end');
});
test('empty library produces a valid empty snapshot', async t => {
  const db = new DB(); t.after(() => db.raw.close()); await new ImportStore(db).initialize();
  const { records } = await capture(db);
  assert.deepEqual(records, [{ type: 'header', format: 'snarchive-backup', version: 1 }, { type: 'end', records: 1, objects: 0, originalBytes: 0 }]);
});
test('large libraries cross batch boundaries with a bounded number of queries', async t => {
  const db = new DB(); t.after(() => db.raw.close());
  const store = new ImportStore(db); await store.initialize();
  const count = 1201, paths = Array.from({ length: count }, (_, i) => `2026-02-05_m${i}-main.jpg`);
  await store.plan(hash, inventoryFromSnapshot({ entries: paths.map(path => ({ path })), metadataBytes: 0, visitedEntries: count }, 'source-1'));
  for (let ordinal = 0; ordinal < count; ordinal++) {
    const sha256 = ordinal.toString(16).padStart(64, '0');
    await store.commit(hash, ordinal, { sha256, relativePath: `objects/${sha256.slice(0, 2)}/${sha256}`, bytes: 1 });
  }
  for (let i = 0; i < count; i += 2) await store.setFavorite(`m${i}`, true);
  db.queries = 0; const { records, objects } = await capture(db);
  assert.equal(objects.length, count);
  assert.deepEqual(records.filter(r => r.type === 'preserved').map(r => r.ordinal), Array.from({ length: count }, (_, i) => i));
  assert.equal(records.filter(r => r.type === 'favorite').length, Math.ceil(count / 2));
  assert.equal(records.at(-1).objects, count);
  assert.ok(db.queries < 20, `${db.queries} queries`); // One row per query took over 3,600.
});
test('backup refuses a library schema it does not cover', async t => {
  assert.equal(BACKUP_SCHEMA_VERSION, LIBRARY_SCHEMA_VERSION, 'Library schema changed: extend the backup snapshot and format, then bump BACKUP_SCHEMA_VERSION.');
  const { db } = await setup(t);
  db.raw.exec(`PRAGMA user_version = ${LIBRARY_SCHEMA_VERSION + 1}`);
  await assert.rejects(capture(db), /backup-schema-unsupported/);
});
