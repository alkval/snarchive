import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { ImportStore } from '../src/storage/importStore.ts';
import type { SqlDatabase, SqlConnection } from '../src/storage/previewStore.ts';
import { inventoryFromSnapshot } from '../src/import/sourceInventory.ts';
import { exportCandidates, runExportRepair, type ExportRepairBridge } from '../src/integrity/exportRepair.ts';
import { RepairFailure, repairWarnings, type Problem } from '../src/integrity/originals.ts';

class DB implements SqlDatabase {
  raw = new DatabaseSync(':memory:');
  async execAsync(sql: string) { this.raw.exec(sql); }
  async runAsync(sql: string, ...p: (string | number | null)[]) { this.raw.prepare(sql).run(...p); }
  async getFirstAsync<T>(sql: string, ...p: (string | number | null)[]) { return (this.raw.prepare(sql).get(...p) as T | undefined) ?? null; }
  async getAllAsync<T>(sql: string, ...p: (string | number | null)[]) { return this.raw.prepare(sql).all(...p) as T[]; }
  async withExclusiveTransactionAsync(work: (tx: SqlConnection) => Promise<void>) {
    this.raw.exec('BEGIN IMMEDIATE'); try { await work(this); this.raw.exec('COMMIT'); } catch (error) { this.raw.exec('ROLLBACK'); throw error; }
  }
}
const A = 'a'.repeat(64), B = 'b'.repeat(64);
const receipt = (text: string) => {
  const sha256 = createHash('sha256').update(text).digest('hex');
  return { sha256, bytes: Buffer.byteLength(text), relativePath: `objects/${sha256.slice(0, 2)}/${sha256}` };
};
const H = receipt('shared bytes'), O = receipt('other bytes');
const problems: Problem[] = [H, O].map(r => ({ hash: r.sha256, bytes: r.bytes, health: 'damaged' }));
const first = 'a/2026-02-05_one-main.jpg', second = 'z/2026-02-06_two-main.jpg', other = 'other/2026-02-07_other-main.jpg';
const source = (paths: string[], sourceId = 'source-1') => inventoryFromSnapshot({ entries: paths.map(path => ({ path })), metadataBytes: 0, visitedEntries: paths.length }, sourceId);
async function library(t: { after(fn: () => void): void }) {
  const db = new DB(); t.after(() => db.raw.close()); const store = new ImportStore(db); await store.initialize();
  await store.plan(A, source([first, second, other]));
  await store.commit(A, 0, H); await store.commit(A, 1, H); await store.commit(A, 2, O);
  await store.plan(B, source(['foreign/2026-02-05_one-main.jpg'], 'source-2')); await store.commit(B, 0, H);
  const folder = await store.planFolder(source([first, second, other], 'source-3'));
  for (let ordinal = -1; ;) { const item = await store.item(folder, ordinal); if (!item) break; await store.commit(folder, item.ordinal, item.relative_path === other ? O : H); ordinal = item.ordinal; }
  return { db, store };
}
function dump(db: DB) {
  return JSON.stringify((db.raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[])
    .map(({ name }) => [name, db.raw.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()]));
}
type Reply = Awaited<ReturnType<ExportRepairBridge['repairExportObject']>>;
class Bridge implements ExportRepairBridge {
  calls: string[] = []; paths: string[] = [];
  opened = { ok: true, archiveSha256: A, code: '', cleanupFailed: false };
  prepared = { ok: true, code: '', storeCleanupFailed: false }; endOk = true;
  outcomes = new Map<string, Reply>(); rejectPath = ''; onRepair: (() => void) | null = null; onPrepare: (() => void) | null = null;
  constructor() { this.outcomes.set('foreign/2026-02-05_one-main.jpg', { ok: false, code: 'source-missing' }); }
  async beginExportRepair() { this.calls.push('begin'); return this.opened; }
  async prepareExportRepair() { this.calls.push('prepare'); this.onPrepare?.(); return this.prepared; }
  async repairExportObject(_hash: string, _bytes: number, path: string): Promise<Reply> {
    this.calls.push('repair'); this.paths.push(path); this.onRepair?.();
    if (path === this.rejectPath) throw new Error('native-rejected');
    return this.outcomes.get(path) ?? { ok: true, outcome: 'repaired' };
  }
  async endExportRepair() { this.calls.push('end'); return { ok: this.endOk }; }
}
test('ZIP candidates use exact archive identity; extracted folders can use either provenance kind as path hints', async t => {
  const { db } = await library(t);
  assert.deepEqual(await exportCandidates(db, 'zip', A, H.sha256), [first, second]);
  assert.deepEqual(await exportCandidates(db, 'zip', B, H.sha256), ['foreign/2026-02-05_one-main.jpg']);
  assert.deepEqual(await exportCandidates(db, 'folder', '', H.sha256), [first, 'foreign/2026-02-05_one-main.jpg', second]);
  assert.deepEqual(await exportCandidates(db, 'zip', 'c'.repeat(64), H.sha256), []);
});
test('ZIP repair tries another recorded path after mismatch, keeps both warnings, and changes no database rows', async t => {
  const { db } = await library(t); const before = dump(db), bridge = new Bridge();
  bridge.outcomes.set(first, { ok: true, outcome: 'mismatch', storeCleanupFailed: true });
  bridge.outcomes.set(second, { ok: true, outcome: 'repaired', warnings: ['sync-failed', 'thumbnail-eviction-failed'] });
  const report = await runExportRepair(db, bridge, 'zip', 'content://synthetic', problems.slice(0, 1), () => false, () => {});
  assert.deepEqual(bridge.paths, [first, second]); assert.deepEqual(report.repaired, [H.sha256]);
  assert.equal(report.storeCleanupFailed, true); assert.deepEqual(repairWarnings(report), [['sync-failed', 1], ['thumbnail-eviction-failed', 1]]);
  assert.equal(dump(db), before); assert.deepEqual(bridge.calls.filter(c => c !== 'repair'), ['begin', 'prepare', 'end']);
});
test('folders try other recorded paths after per-file change or access failures without matching the old inventory', async t => {
  const { db } = await library(t); const bridge = new Bridge();
  bridge.outcomes.set(first, { ok: false, code: 'source-changed' });
  const result = await runExportRepair(db, bridge, 'folder', 'content://different-tree', problems, () => false, () => {});
  assert.deepEqual(result.repaired, [H.sha256, O.sha256]); assert.equal(result.stopped, null);
  assert.deepEqual(bridge.paths, [first, 'foreign/2026-02-05_one-main.jpg', second, other]);
});
test('missing candidates are unavailable, stable bad bytes are mismatch, unreadable candidates are failed', async t => {
  const { db } = await library(t);
  for (const [code, bucket] of [['source-missing', 'unavailable'], ['source-unreadable', 'failed'], ['mismatch', 'mismatch']] as const) {
    const bridge = new Bridge();
    for (const path of [first, second]) bridge.outcomes.set(path, code === 'mismatch' ? { ok: true, outcome: 'mismatch' } : { ok: false, code });
    const result = await runExportRepair(db, bridge, 'folder', 'u', problems.slice(0, 1), () => false, () => {});
    assert.equal(result[bucket].length, 1); assert.equal(result.stopped, null); assert.equal(bridge.paths.length, 3);
  }
});
test('a different ZIP or an unreferenced object has no recorded candidates and is not read', async t => {
  const { db } = await library(t); const bridge = new Bridge(); bridge.opened.archiveSha256 = 'c'.repeat(64);
  const result = await runExportRepair(db, bridge, 'zip', 'u', problems, () => false, () => {});
  assert.deepEqual(result.unavailable, problems.map(p => p.hash)); assert.equal(bridge.paths.length, 0);
});
test('candidate pagination handles more than 200 paths without sending media or all paths in one call', async t => {
  const db = new DB(); t.after(() => db.raw.close()); const store = new ImportStore(db); await store.initialize();
  const paths = Array.from({ length: 205 }, (_, i) => `copies/${String(i).padStart(3, '0')}/2026-02-05_one-main.jpg`);
  await store.plan(A, source(paths)); for (let i = 0; i < paths.length; i++) await store.commit(A, i, H);
  const bridge = new Bridge(); for (const path of paths.slice(0, -1)) bridge.outcomes.set(path, { ok: false, code: 'source-missing' });
  const result = await runExportRepair(db, bridge, 'zip', 'u', problems.slice(0, 1), () => false, () => {});
  assert.deepEqual(bridge.paths, paths); assert.deepEqual(result.repaired, [H.sha256]);
});
test('a ZIP stamp change stops the session, while per-object store failures allow the next original', async t => {
  const { db } = await library(t);
  const changed = new Bridge(); changed.outcomes.set(first, { ok: false, code: 'source-changed', storeCleanupFailed: true });
  const stopped = await runExportRepair(db, changed, 'zip', 'u', problems, () => false, () => {});
  assert.equal(stopped.stopped, 'source-changed'); assert.deepEqual(stopped.notAttempted, problems.map(p => p.hash)); assert.equal(stopped.storeCleanupFailed, true);
  const failed = new Bridge(); failed.outcomes.set(first, { ok: false, code: 'quarantine-failed' });
  const partial = await runExportRepair(db, failed, 'zip', 'u', problems, () => false, () => {});
  assert.deepEqual(partial.failed, [{ hash: H.sha256, code: 'quarantine-failed' }]); assert.deepEqual(partial.repaired, [O.sha256]);
});
test('cancellation after a completed repair counts it and keeps every warning; session closes once', async t => {
  const { db } = await library(t); const bridge = new Bridge(); let stop = false;
  bridge.outcomes.set(first, { ok: true, outcome: 'repaired', warnings: ['sync-failed'] }); bridge.onRepair = () => { stop = true; };
  const result = await runExportRepair(db, bridge, 'zip', 'u', problems, () => stop, () => {});
  assert.deepEqual(result.repaired, [H.sha256]); assert.deepEqual(result.notAttempted, [O.sha256]); assert.equal(result.stopped, 'cancelled');
  assert.deepEqual(result.warnings, [{ hash: H.sha256, code: 'sync-failed' }]); assert.equal(bridge.calls.filter(c => c === 'end').length, 1);
});
test('open and preparation failures retain cleanup flags, including cancellation, without double-closing', async t => {
  const { db } = await library(t); const unopened = new Bridge(); unopened.opened = { ok: false, code: 'staging-cleanup-failed', cleanupFailed: true, archiveSha256: '' };
  await assert.rejects(runExportRepair(db, unopened, 'zip', 'u', problems, () => false, () => {}), (e: Error) => e instanceof RepairFailure && e.cleanupFailed);
  assert.deepEqual(unopened.calls, ['begin']);
  const prep = new Bridge(); let stop = false; prep.onPrepare = () => { stop = true; };
  prep.prepared = { ok: false, code: 'cancelled', storeCleanupFailed: true }; prep.endOk = false;
  await assert.rejects(runExportRepair(db, prep, 'zip', 'u', problems, () => stop, () => {}), (e: Error) => e instanceof RepairFailure && e.message === 'cancelled' && e.storeCleanupFailed && e.cleanupFailed);
  assert.deepEqual(prep.calls, ['begin', 'prepare', 'end']);
});
test('a bridge rejection after a repair retains partial results and cleanup warnings', async t => {
  const { db } = await library(t); const bridge = new Bridge(); bridge.rejectPath = other; bridge.endOk = false;
  const report = await runExportRepair(db, bridge, 'zip', 'u', problems, () => false, () => {});
  assert.deepEqual(report.repaired, [H.sha256]); assert.deepEqual(report.notAttempted, [O.sha256]);
  assert.equal(report.stopped, 'native-rejected'); assert.equal(report.cleanupFailed, true);
});
test('an already-valid original is counted once, and an invalid ZIP identity closes before reading candidates', async t => {
  const { db } = await library(t); const bridge = new Bridge(); bridge.outcomes.set(first, { ok: true, outcome: 'already_valid' });
  const report = await runExportRepair(db, bridge, 'zip', 'u', problems.slice(0, 1), () => false, () => {});
  assert.deepEqual(report.alreadyValid, [H.sha256]); assert.deepEqual(bridge.paths, [first]);
  const invalid = new Bridge(); invalid.opened.archiveSha256 = '';
  await assert.rejects(runExportRepair(db, invalid, 'zip', 'u', problems, () => false, () => {}), (e: Error) => e.message === 'export-unreadable');
  assert.deepEqual(invalid.calls, ['begin', 'end']);
});
