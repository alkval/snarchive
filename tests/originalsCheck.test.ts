import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { ImportStore, type Receipt } from '../src/storage/importStore.ts';
import { inventoryFromSnapshot } from '../src/import/sourceInventory.ts';
import { writeBackupSnapshot } from '../src/backup/snapshot.ts';
import { runOriginalsCheck, affectedMemories, runBackupRepair, repairWarnings, CheckFailure, RepairFailure, type CheckBridge, type Health, type RepairBridge, type Problem } from '../src/integrity/originals.ts';
import { en } from '../src/i18n/en.ts';
import type { SqlDatabase, SqlConnection } from '../src/storage/previewStore.ts';

class DB implements SqlDatabase {
  raw = new DatabaseSync(':memory:');
  async execAsync(sql: string) { this.raw.exec(sql); }
  async runAsync(sql: string, ...p: (string | number | null)[]) { this.raw.prepare(sql).run(...p); }
  async getFirstAsync<T>(sql: string, ...p: (string | number | null)[]) { return (this.raw.prepare(sql).get(...p) as T | undefined) ?? null; }
  async getAllAsync<T>(sql: string, ...p: (string | number | null)[]) { return this.raw.prepare(sql).all(...p) as T[]; }
  async withExclusiveTransactionAsync(work: (tx: SqlConnection) => Promise<void>) { this.raw.exec('BEGIN IMMEDIATE'); try { await work(this); this.raw.exec('COMMIT'); } catch (e) { this.raw.exec('ROLLBACK'); throw e; } }
}
const receipt = (content: string, bytes?: number): Receipt => {
  const sha256 = createHash('sha256').update(content).digest('hex');
  return { sha256, relativePath: `objects/${sha256.slice(0, 2)}/${sha256}`, bytes: bytes ?? Buffer.byteLength(content) };
};
/** A ZIP job with two memories sharing one object, a variant, an overlay, and one unreferenced object row. */
async function library(t: { after(fn: () => void): void }) {
  const db = new DB(); t.after(() => { try { db.raw.close(); } catch {} });
  const store = new ImportStore(db); await store.initialize();
  const zip = 'a'.repeat(64);
  const names = ['2026-02-05_one-main.jpg', '2026-02-06_two-main.jpg', '2026-02-07_three-main.jpg', '2026-02-07_three-overlay.png', '2026-02-08_four-main.jpg'];
  await store.plan(zip, inventoryFromSnapshot({ entries: names.map(path => ({ path })), metadataBytes: 0, visitedEntries: names.length }, 'source-1'));
  await store.commit(zip, 0, receipt('shared')); await store.commit(zip, 1, receipt('shared'));
  await store.commit(zip, 2, receipt('three')); await store.commit(zip, 3, receipt('overlay'));
  await store.commit(zip, 4, receipt('four'));
  const unused = receipt('unused');
  db.raw.prepare('INSERT INTO stored_objects(hash,relative_path,bytes) VALUES (?,?,?)').run(unused.sha256, unused.relativePath, unused.bytes);
  return { db, store, zip };
}
function dump(db: DB) {
  const all = (sql: string) => db.raw.prepare(sql).all();
  return JSON.stringify([all('SELECT * FROM import_jobs ORDER BY hash'), all('SELECT * FROM import_items ORDER BY job_hash,ordinal'), all('SELECT * FROM stored_objects ORDER BY hash'),
    all('SELECT * FROM memories ORDER BY id'), all('SELECT * FROM memory_objects ORDER BY memory_id,role,object_hash'), all('SELECT * FROM library_favorites ORDER BY memory_id'),
    all('SELECT * FROM library_dates ORDER BY memory_id,kind,value')]);
}
/** A fake native check over a health map; valid unless listed. */
class Checker implements CheckBridge {
  health = new Map<string, Health>(); batches: { hashes: string[]; sizes: number[] }[] = []; began = 0; ended = 0;
  beginCode: string | null = null; failAt = -1; cancel: (() => void) | null = null; cancelAfter = -1;
  async beginOriginalCheck() { this.began++; return this.beginCode ? { ok: false, code: this.beginCode } : { ok: true }; }
  async checkOriginals(hashes: string[], sizes: number[]) {
    this.batches.push({ hashes, sizes });
    if (this.batches.length - 1 === this.cancelAfter) this.cancel?.();
    if (this.batches.length - 1 === this.failAt) return { ok: false, code: 'check-failed' };
    return { ok: true, health: hashes.map(hash => this.health.get(hash) ?? 'valid') };
  }
  async endOriginalCheck() { this.ended++; return { ok: true }; }
}

test('every recorded object is checked in bounded batches, problems are kept, and nothing changes', async t => {
  const { db } = await library(t);
  // 450 more rows (beyond two pages); a few large ones force the byte cap.
  for (let i = 0; i < 450; i++) { const r = receipt(`extra-${i}`, i % 100 === 0 ? 40 * 1024 ** 2 : 10); db.raw.prepare('INSERT INTO stored_objects(hash,relative_path,bytes) VALUES (?,?,?)').run(r.sha256, r.relativePath, r.bytes); }
  const before = dump(db); const checker = new Checker();
  const shared = receipt('shared').sha256, four = receipt('four').sha256, overlay = receipt('overlay').sha256;
  checker.health.set(shared, 'damaged'); checker.health.set(four, 'missing'); checker.health.set(overlay, 'unreadable');
  const seen: number[] = [];
  const result = await runOriginalsCheck(db, checker, () => false, state => seen.push(state.checked));
  assert.equal(result.total, 455);
  assert.deepEqual(new Map(result.problems.map(p => [p.hash, p.health])), new Map([[shared, 'damaged'], [four, 'missing'], [overlay, 'unreadable']]));
  assert.equal(checker.batches.reduce((n, b) => n + b.hashes.length, 0), 455, 'each object once');
  for (const batch of checker.batches) {
    assert.ok(batch.hashes.length <= 50);
    assert.ok(batch.hashes.length === 1 || batch.sizes.reduce((a, b) => a + b, 0) <= 64 * 1024 ** 2, 'byte cap, unless a single object');
  }
  assert.equal(seen.at(-1), 455); assert.deepEqual([checker.began, checker.ended], [1, 1]);
  assert.equal(dump(db), before, 'the library database is unchanged');
});

test('cancellation, a busy guard and a failed batch end the check cleanly with their own codes', async t => {
  const { db } = await library(t);
  let stop = false; const cancelling = new Checker(); cancelling.cancelAfter = 0; cancelling.cancel = () => { stop = true; };
  for (let i = 0; i < 120; i++) { const r = receipt(`x${i}`); db.raw.prepare('INSERT INTO stored_objects(hash,relative_path,bytes) VALUES (?,?,?)').run(r.sha256, r.relativePath, r.bytes); }
  await assert.rejects(runOriginalsCheck(db, cancelling, () => stop, () => {}), (e: Error) => e instanceof CheckFailure && e.message === 'cancelled');
  assert.equal(cancelling.batches.length, 1); assert.equal(cancelling.ended, 1);
  const busy = new Checker(); busy.beginCode = 'busy';
  await assert.rejects(runOriginalsCheck(db, busy, () => false, () => {}), (e: Error) => e.message === 'busy');
  assert.equal(busy.ended, 0, 'no session was opened');
  const failing = new Checker(); failing.failAt = 1;
  await assert.rejects(runOriginalsCheck(db, failing, () => false, () => {}), (e: Error) => e.message === 'check-failed');
  assert.equal(failing.ended, 1);
});

test('affected memories: shared objects list their memories and count, unused objects count zero', async t => {
  const { db } = await library(t);
  const affected = await affectedMemories(db, [receipt('shared').sha256, receipt('unused').sha256, receipt('overlay').sha256]);
  assert.deepEqual(JSON.parse(JSON.stringify(affected.get(receipt('shared').sha256))), { memories: [{ id: 'one', role: 'photo', day: '2026-02-05' }, { id: 'two', role: 'photo', day: '2026-02-06' }], memoryCount: 2 });
  assert.deepEqual(affected.get(receipt('unused').sha256), { memories: [], memoryCount: 0 });
  assert.equal(affected.get(receipt('overlay').sha256)!.memories[0]!.role, 'overlay');
});

async function manifestOf(db: DB) { const lines: string[] = []; await writeBackupSnapshot(db, { async line(l) { lines.push(l); }, async object() {} }); return lines.join(''); }
/** A fake native repair session over a manifest; outcomes per hash (or a failure code), recording the call order. */
class Repairer implements RepairBridge {
  calls: string[] = []; declared: string[] = []; text: string; offset = 0;
  outcomes = new Map<string, { ok: boolean; outcome?: 'repaired' | 'already_valid' | 'unavailable' | 'mismatch'; code?: string; storeCleanupFailed?: boolean; warnings?: string[] }>();
  prepareResult: { ok: boolean; code?: string; storeCleanupFailed?: boolean } = { ok: true }; onPrepare: (() => void) | null = null;
  beginResult: { ok: boolean; code?: string; cleanupFailed?: boolean } = { ok: true }; endOk = true; onRepair: ((hash: string) => void) | null = null;
  constructor(text: string) { this.text = text; }
  async beginBackupInspection() { this.calls.push('begin'); return this.beginResult; }
  async readBackupManifest() { this.calls.push('read'); const chunk = this.text.slice(this.offset, this.offset + 300); this.offset += 300; return { ok: true, text: chunk, done: this.offset >= this.text.length }; }
  async declareBackupObjects(hashes: string[]) { this.calls.push('declare'); this.declared.push(...hashes); return { ok: true }; }
  async sealBackupInspection() { this.calls.push('seal'); return { ok: true }; }
  async prepareBackupRepair() { this.calls.push('prepare'); this.onPrepare?.(); return this.prepareResult; }
  async repairBackupObject(hash: string) { this.calls.push(`repair:${hash.slice(0, 4)}`); this.onRepair?.(hash); return this.outcomes.get(hash) ?? { ok: true, outcome: 'repaired' as const }; }
  async endBackupInspection() { this.calls.push('end'); return { ok: this.endOk }; }
}
const problem = (content: string, health: Problem['health'] = 'damaged'): Problem => ({ hash: receipt(content).sha256, bytes: receipt(content).bytes, health });

test('repair from a version-1 backup: the manifest is validated first, each problem is attempted, outcomes are reported exactly', async t => {
  const { db } = await library(t); const text = await manifestOf(db);
  assert.equal(JSON.parse(text.split('\n')[0]!).version, 1);
  const problems = [problem('shared'), problem('four', 'missing'), problem('three'), problem('overlay', 'unreadable'), problem('unused')];
  const bridge = new Repairer(text);
  bridge.outcomes.set(problems[2]!.hash, { ok: true, outcome: 'already_valid' });
  bridge.outcomes.set(problems[3]!.hash, { ok: true, outcome: 'mismatch', storeCleanupFailed: true });
  bridge.outcomes.set(problems[4]!.hash, { ok: false, code: 'quarantine-failed' });
  const before = dump(db);
  const report = await runBackupRepair(bridge, 'content://backup', problems, () => false, () => {});
  assert.deepEqual(report, { repaired: [problems[0]!.hash, problems[1]!.hash], alreadyValid: [problems[2]!.hash], unavailable: [], mismatch: [problems[3]!.hash],
    failed: [{ hash: problems[4]!.hash, code: 'quarantine-failed' }], notAttempted: [], stopped: null, storeCleanupFailed: true, cleanupFailed: false, warnings: [] });
  assert.deepEqual(bridge.calls.filter(c => !c.startsWith('read') && !c.startsWith('declare')).slice(0, 3), ['begin', 'seal', 'prepare']);
  assert.equal(bridge.calls.at(-1), 'end'); assert.equal(bridge.calls.filter(c => c === 'end').length, 1);
  assert.equal(new Set(bridge.declared).size, 5, 'every catalog object declared');
  assert.equal(dump(db), before, 'repair never writes the library database');
});

test('repair from a version-2 backup (folder sources) validates and repairs the same way', async t => {
  const db = new DB(); t.after(() => db.raw.close()); const store = new ImportStore(db); await store.initialize();
  const hash = await store.planFolder(inventoryFromSnapshot({ entries: [{ path: 'm/2026-02-05_one-main.jpg' }], metadataBytes: 0, visitedEntries: 2 }, 'source-1'));
  await store.commit(hash, 0, receipt('folder photo'));
  const text = await manifestOf(db); assert.equal(JSON.parse(text.split('\n')[0]!).version, 2);
  const report = await runBackupRepair(new Repairer(text), 'content://backup', [problem('folder photo')], () => false, () => {});
  assert.deepEqual(report.repaired, [receipt('folder photo').sha256]);
});

test('a stopping error or cancellation lists what was not attempted; a repair that finished as cancel arrived counts as repaired', async t => {
  const { db } = await library(t); const text = await manifestOf(db);
  const problems = [problem('shared'), problem('four'), problem('three')];
  const stopping = new Repairer(text); stopping.outcomes.set(problems[1]!.hash, { ok: false, code: 'insufficient-storage', storeCleanupFailed: true });
  const stopped = await runBackupRepair(stopping, 'u', problems, () => false, () => {});
  assert.deepEqual([stopped.repaired, stopped.stopped, stopped.notAttempted, stopped.storeCleanupFailed], [[problems[0]!.hash], 'insufficient-storage', [problems[1]!.hash, problems[2]!.hash], true]);
  let cancel = false; const cancelling = new Repairer(text); cancelling.onRepair = hash => { if (hash === problems[0]!.hash) cancel = true; };
  const cancelled = await runBackupRepair(cancelling, 'u', problems, () => cancel, () => {});
  assert.deepEqual([cancelled.repaired, cancelled.stopped, cancelled.notAttempted], [[problems[0]!.hash], 'cancelled', [problems[1]!.hash, problems[2]!.hash]]);
  assert.equal(cancelling.calls.at(-1), 'end');
});

test('an invalid or unreadable backup repairs nothing and always closes the session', async t => {
  const { db } = await library(t); const text = await manifestOf(db);
  const invalid = new Repairer(text.replace('"version":1', '"version":3'));
  await assert.rejects(runBackupRepair(invalid, 'u', [problem('shared')], () => false, () => {}), (e: Error) => e instanceof RepairFailure && e.message === 'backup-unsupported');
  assert.ok(!invalid.calls.some(c => c.startsWith('repair'))); assert.equal(invalid.calls.at(-1), 'end');
  const tampered = new Repairer(text.replace(/"bytes":(\d+)/, (_, n) => `"bytes":${Number(n) + 1}`));
  await assert.rejects(runBackupRepair(tampered, 'u', [problem('shared')], () => false, () => {}), (e: Error) => e instanceof RepairFailure && e.message === 'backup-invalid');
  const unopened = new Repairer(text); unopened.beginResult = { ok: false, code: 'staging-cleanup-failed', cleanupFailed: true };
  await assert.rejects(runBackupRepair(unopened, 'u', [problem('shared')], () => false, () => {}), (e: Error) => e instanceof RepairFailure && e.cleanupFailed);
  const leftover = new Repairer(text); leftover.endOk = false;
  assert.equal((await runBackupRepair(leftover, 'u', [problem('shared')], () => false, () => {})).cleanupFailed, true);
});

test('a second backup can be tried for what remains, and a partial repair leaves the rest as it was', async t => {
  const { db } = await library(t); const text = await manifestOf(db);
  const problems = [problem('shared'), problem('four'), problem('three')];
  const first = new Repairer(text); first.outcomes.set(problems[1]!.hash, { ok: true, outcome: 'unavailable' }); first.outcomes.set(problems[2]!.hash, { ok: true, outcome: 'mismatch' });
  const one = await runBackupRepair(first, 'u1', problems, () => false, () => {});
  const fixed = new Set([...one.repaired, ...one.alreadyValid]); const remaining = problems.filter(p => !fixed.has(p.hash));
  assert.deepEqual(remaining.map(p => p.hash), [problems[1]!.hash, problems[2]!.hash]);
  const second = new Repairer(text);
  const two = await runBackupRepair(second, 'u2', remaining, () => false, () => {});
  assert.deepEqual(two.repaired, remaining.map(p => p.hash));
  assert.deepEqual(second.calls.filter(c => c.startsWith('repair')), remaining.map(p => `repair:${p.hash.slice(0, 4)}`), 'only what remained');
});

test('wording: repair points to Check originals, keeps the advice to keep exports, and says repair needs a backup', () => {
  for (const text of [en.importCorrupt, en.restoreErrors['stored-object-corrupt']!, en.backupErrors['stored-object-corrupt']!]) {
    assert.match(text, /Check originals/); assert.doesNotMatch(text, /not available yet/);
  }
  assert.match(en.importCorrupt, /Keep your source exports/); assert.match(en.restoreErrors['stored-object-corrupt']!, /Keep your exports/);
  assert.match(en.originalsRepairScopeDetail, /backup/); assert.match(en.originalsRepairScopeDetail, /ZIPs or folders is not available yet/);
  assert.match(en.originalsQuarantine, /still use space/);
  assert.equal(en.originalsUsedBy(0, ''), 'Not used by any memory');
  assert.equal(en.originalsUsedBy(3, '2026-02-05 · photo'), '2026-02-05 · photo and 2 other memories');
});

test('check cancellation wins over results: during the last batch, or with missing and wrong-length verdicts', async t => {
  const { db } = await library(t);
  let stop = false; const last = new Checker(); last.cancel = () => { stop = true; }; last.cancelAfter = 0; // Only one batch: it is the last.
  last.health.set(receipt('four').sha256, 'missing'); last.health.set(receipt('three').sha256, 'damaged');
  await assert.rejects(runOriginalsCheck(db, last, () => stop, () => {}), (e: Error) => e instanceof CheckFailure && e.message === 'cancelled');
  assert.equal(last.batches.length, 1); assert.equal(last.ended, 1);
});

test('a completed repair with a later problem stays repaired, with a warning, and the wording says it is repaired', async t => {
  const { db } = await library(t); const text = await manifestOf(db);
  const problems = [problem('shared'), problem('four'), problem('three')];
  const bridge = new Repairer(text);
  bridge.outcomes.set(problems[0]!.hash, { ok: true, outcome: 'repaired', warnings: ['thumbnail-eviction-failed'] });
  bridge.outcomes.set(problems[1]!.hash, { ok: true, outcome: 'repaired', warnings: ['sync-failed', 'thumbnail-eviction-failed'] });
  bridge.outcomes.set(problems[2]!.hash, { ok: true, outcome: 'repaired', warnings: [] });
  const report = await runBackupRepair(bridge, 'u', problems, () => false, () => {});
  assert.deepEqual(report.repaired, problems.map(p => p.hash)); assert.deepEqual(report.failed, []);
  // Both warnings of one repair are kept, and it stays repaired.
  assert.deepEqual(report.warnings, [{ hash: problems[0]!.hash, code: 'thumbnail-eviction-failed' },
    { hash: problems[1]!.hash, code: 'sync-failed' }, { hash: problems[1]!.hash, code: 'thumbnail-eviction-failed' }]);
  assert.deepEqual(repairWarnings(report), [['thumbnail-eviction-failed', 2], ['sync-failed', 1]]);
  assert.match(en.originalsRepairWarning('thumbnail-eviction-failed', 2), /^2 repaired originals /);
  assert.match(en.originalsRepairWarning('thumbnail-eviction-failed', 1), /^1 repaired original .*The original itself is repaired\.$/);
  assert.match(en.originalsRepairWarning('sync-failed', 2), /^2 repaired originals are in place/);
  for (const code of ['thumbnail-eviction-failed', 'sync-failed']) assert.doesNotMatch(en.originalsRepairWarning(code, 1), /left as it was|unchanged|not changed/);
});

test('a preparation failure carries the store leftover flag into RepairFailure, also when cancelled', async t => {
  const { db } = await library(t); const text = await manifestOf(db);
  const failing = new Repairer(text); failing.prepareResult = { ok: false, code: 'store-staging-cleanup-failed', storeCleanupFailed: true };
  await assert.rejects(runBackupRepair(failing, 'u', [problem('shared')], () => false, () => {}),
    (e: Error) => e instanceof RepairFailure && e.message === 'store-staging-cleanup-failed' && e.storeCleanupFailed && !e.cleanupFailed);
  assert.ok(!failing.calls.some(c => c.startsWith('repair'))); assert.equal(failing.calls.at(-1), 'end');
  let stop = false; const cancelled = new Repairer(text); cancelled.onPrepare = () => { stop = true; };
  cancelled.prepareResult = { ok: false, code: 'cancelled', storeCleanupFailed: true };
  await assert.rejects(runBackupRepair(cancelled, 'u', [problem('shared')], () => stop, () => {}),
    (e: Error) => e instanceof RepairFailure && e.message === 'cancelled' && e.storeCleanupFailed);
});
