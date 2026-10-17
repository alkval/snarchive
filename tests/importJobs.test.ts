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
  preserved: string[] = []; verified: string[] = []; closed = 0; failAt = 0; failVerify = false;
  async open(_uri: string, _hash: string, _remaining: number) {}
  async preserve(path: string) { this.preserved.push(path); if (this.failAt === this.preserved.length) throw new Error('cancelled'); return receipt(); }
  async verify(hash: string, _bytes: number) { if (this.failVerify) throw new Error('stored-object-corrupt'); this.verified.push(hash); }
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
test('interrupted job reopens and verifies completed files before continuing', async t => {
  const { store, db, path } = await setup(t); const first = new Copier(); first.failAt = 2;
  await assert.rejects(runImport(store, first, hash, 'synthetic', () => false, () => {}));
  assert.equal((await store.summary()).files, 1); db.raw.close();
  const reopened = new DB(path); const next = new ImportStore(reopened); await next.initialize(); const second = new Copier();
  try {
    await runImport(next, second, hash, 'synthetic', () => false, () => {});
    assert.equal(second.preserved.length, 1); assert.equal(second.verified.length, 1);
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
test('completed reimport verifies objects without copying or duplicating links', async t => {
  const { store } = await setup(t); const copier = new Copier();
  await runImport(store, copier, hash, 'synthetic', () => false, () => {});
  await runImport(store, copier, hash, 'synthetic', () => false, () => {});
  assert.equal(copier.preserved.length, 2); assert.equal(copier.verified.length, 2); assert.equal((await store.summary()).memories, 2);
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
  const { store } = await setup(t); await store.commit(hash, 0, receipt()); const copier = new Copier(); copier.failVerify = true;
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
