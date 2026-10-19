import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ImportStore, type Receipt } from '../src/storage/importStore.ts';
import { inventoryFromSnapshot } from '../src/import/sourceInventory.ts';
import { writeBackupSnapshot } from '../src/backup/snapshot.ts';
import { en } from '../src/i18n/en.ts';
import { runRestore, RestoreFailure, type RestoreBridge } from '../src/backup/restoreBackup.ts';
import type { SqlDatabase, SqlConnection } from '../src/storage/previewStore.ts';

export class DB implements SqlDatabase {
  raw: DatabaseSync;
  failAt = 0; calls = 0; afterCommit: (() => void) | null = null;
  constructor(path = ':memory:') { this.raw = new DatabaseSync(path); }
  private fault() { if (this.failAt && ++this.calls === this.failAt) throw new Error('disk-io-error'); }
  async execAsync(sql: string) { this.raw.exec(sql); }
  async runAsync(sql: string, ...p: (string | number | null)[]) { this.fault(); this.raw.prepare(sql).run(...p); }
  async getFirstAsync<T>(sql: string, ...p: (string | number | null)[]) { return (this.raw.prepare(sql).get(...p) as T | undefined) ?? null; }
  async getAllAsync<T>(sql: string, ...p: (string | number | null)[]) { return this.raw.prepare(sql).all(...p) as T[]; }
  async withExclusiveTransactionAsync(work: (tx: SqlConnection) => Promise<void>) {
    this.raw.exec('BEGIN IMMEDIATE');
    try { await work(this); this.raw.exec('COMMIT'); } catch (e) { this.raw.exec('ROLLBACK'); throw e; }
    this.afterCommit?.();
  }
}
const receipt = (seed: string, bytes = 10): Receipt => {
  const sha256 = seed.repeat(64).slice(0, 64);
  return { sha256, relativePath: `objects/${sha256.slice(0, 2)}/${sha256}`, bytes };
};
const A = receipt('a'), B = receipt('b', 20), C = receipt('c', 30), D = receipt('d', 5), E = receipt('e', 7);
const job1 = '1'.repeat(64), job2 = '2'.repeat(64), job3 = '3'.repeat(64);
const JOB1 = ['2026-02-05_one-main.jpg', '2026-02-05_two-main.jpg', '2026-02-05_orphan-overlay.png', '2026-02-05_pending-main.mp4', '2026-02-05_one-overlay.png'];
const plan = (store: ImportStore, hash: string, paths: string[], id: string) =>
  store.plan(hash, inventoryFromSnapshot({ entries: paths.map(path => ({ path })), metadataBytes: 0, visitedEntries: paths.length }, id));

async function emptyLibrary(t: { after(fn: () => void): void }, path?: string) {
  const db = new DB(path); t.after(() => { try { db.raw.close(); } catch {} });
  const store = new ImportStore(db); await store.initialize(); return { db, store };
}
/** Shared bytes (one, two -> A), a repeated observation (one in both jobs), a variant (two -> A and C),
 * an overlay-only identity, a pending file and favorites. */
async function sourceLibrary(t: { after(fn: () => void): void }) {
  const { db, store } = await emptyLibrary(t);
  await plan(store, job1, JOB1, 'source-1');
  await store.commit(job1, 0, A); await store.commit(job1, 1, A); await store.commit(job1, 2, B); await store.commit(job1, 4, D);
  await plan(store, job2, ['2026-02-05_one-main.jpg', '2026-02-05_two-main.jpg'], 'source-2');
  await store.commit(job2, 0, A); await store.commit(job2, 1, C);
  await store.setFavorite('one', true); await store.setFavorite('two', true);
  return { db, store };
}
async function manifest(db: DB): Promise<string> {
  const lines: string[] = [];
  await writeBackupSnapshot(db, { async line(line) { lines.push(line); }, async object() {} });
  return lines.join('');
}
/** Everything restore may change, in a comparable form. */
async function dump(db: DB) {
  const all = (sql: string) => db.raw.prepare(sql).all();
  return {
    jobs: all('SELECT hash,state,plan_json FROM import_jobs ORDER BY hash'),
    items: all('SELECT job_hash,ordinal,relative_path,memory_id,role,date_json,state,object_hash FROM import_items ORDER BY job_hash,ordinal'),
    objects: all('SELECT * FROM stored_objects ORDER BY hash'), memories: all('SELECT * FROM memories ORDER BY id'),
    associations: all('SELECT * FROM memory_objects ORDER BY memory_id,role,object_hash'),
    favorites: all('SELECT * FROM library_favorites ORDER BY memory_id'), dates: all('SELECT * FROM library_dates ORDER BY memory_id,kind,value'),
  };
}
type Faults = { stagedText?: string; failOn?: keyof RestoreBridge; endFails?: boolean; cancelWhen?: (call: string) => boolean };
/** A fake native session over manifest text. Pass 1 and the staged re-read serve the same bytes unless told not to. */
function bridge(text: string, faults: Faults = {}) {
  const calls: string[] = []; let read = 0, staged = 0; const state = { cancelled: false };
  const call = (name: keyof RestoreBridge) => {
    calls.push(name); if (faults.cancelWhen?.(name)) state.cancelled = true;
    if (faults.failOn === name) return { ok: false, code: 'backup-unreadable' };
    return null;
  };
  const chunk = (source: string, offset: number) => ({ text: source.slice(offset, offset + 64), done: offset + 64 >= source.length });
  const native: RestoreBridge = {
    async beginBackupRestore() { return call('beginBackupRestore') ?? { ok: true, inPlace: true }; },
    async readBackupManifest() { const f = call('readBackupManifest'); if (f) return f; const out = chunk(text, read); read += 64; return { ok: true, ...out }; },
    async declareBackupObjects() { return call('declareBackupObjects') ?? { ok: true }; },
    async sealBackupInspection() { return call('sealBackupInspection') ?? { ok: true }; },
    async prepareBackupRestore() { return call('prepareBackupRestore') ?? { ok: true, missingBytes: 0 }; },
    async storeBackupObjects() { return call('storeBackupObjects') ?? { ok: true, stored: 1, total: 1, added: 1, reused: 0, bytes: 1, totalBytes: 1, done: true }; },
    async readStagedManifest() { const f = call('readStagedManifest'); if (f) return f; const source = faults.stagedText ?? text; const out = chunk(source, staged); staged += 64; return { ok: true, ...out }; },
    async endBackupInspection() { call('endBackupInspection'); return faults.endFails ? { ok: false, code: 'backup-cleanup-failed' } : { ok: true }; },
  };
  return { calls, native, state };
}
async function restore(db: DB, text: string, faults: Faults = {}) {
  const { native, state, calls } = bridge(text, faults);
  const outcome = await runRestore(native, db, 'content://synthetic', () => state.cancelled, () => {});
  return { outcome, calls };
}
async function rejects(db: DB, text: string, code: string, faults: Faults = {}) {
  const before = await dump(db);
  const { native, state } = bridge(text, faults);
  await assert.rejects(runRestore(native, db, 'content://synthetic', () => state.cancelled, () => {}),
    (error: Error) => error instanceof RestoreFailure && error.message === code);
  assert.deepEqual(await dump(db), before, 'a failed restore changes nothing');
}

test('export -> restore into an empty library -> export again gives the same logical backup', async t => {
  const source = await sourceLibrary(t); const text = await manifest(source.db);
  const target = await emptyLibrary(t);
  const { outcome } = await restore(target.db, text);
  assert.deepEqual(outcome.changes, { memoriesAdded: 2, associationsAdded: 5, objectsAdded: 4, favoritesAdded: 2, sourcesAdded: 2, sourcesUpdated: 0, filesPreserved: 6 });
  assert.equal(await manifest(target.db), text); // Objects, provenance, observations, favorites: identical records.
  const [before, after] = [await dump(source.db), await dump(target.db)];
  assert.deepEqual(after.dates, before.dates); assert.deepEqual(after.associations, before.associations);
  assert.deepEqual(after.items, before.items); assert.deepEqual(after.favorites, before.favorites);
  // Job states are derived, not restored: fully preserved is completed, partly preserved is resumable.
  assert.deepEqual(after.jobs.map(job => job.state), ['paused', 'completed']);
  const summary = await target.store.summary();
  assert.equal(summary.memories, 2); assert.equal(summary.conflicts, 1); // "two" keeps both variants.
});

test('restoring again changes nothing and creates no duplicates', async t => {
  const text = await manifest((await sourceLibrary(t)).db); const target = await emptyLibrary(t);
  await restore(target.db, text); const once = await dump(target.db);
  const { outcome } = await restore(target.db, text);
  assert.deepEqual(outcome.changes, { memoriesAdded: 0, associationsAdded: 0, objectsAdded: 0, favoritesAdded: 0, sourcesAdded: 0, sourcesUpdated: 0, filesPreserved: 0 });
  assert.deepEqual(await dump(target.db), once);
});

test('restore into a populated library adds alongside existing work and keeps existing favorites', async t => {
  const text = await manifest((await sourceLibrary(t)).db);
  const target = await emptyLibrary(t);
  await plan(target.store, job3, ['2026-03-01_local-main.jpg'], 'source-1'); await target.store.commit(job3, 0, E);
  await target.store.setFavorite('local', true);
  const { outcome } = await restore(target.db, text);
  assert.equal(outcome.changes.memoriesAdded, 2); assert.equal(outcome.changes.sourcesAdded, 2);
  const after = await dump(target.db);
  assert.deepEqual(after.favorites.map(row => row.memory_id), ['local', 'one', 'two']); // Absent from the backup, still a favorite.
  assert.ok(after.objects.some(row => row.hash === E.sha256) && after.jobs.some(row => row.hash === job3));
  assert.match(await manifest(target.db), /"memoryId":"local"/); // Still exportable, with both libraries' contents.
});

test('an existing source with the same inventory gains preserved files and never regresses', async t => {
  const text = await manifest((await sourceLibrary(t)).db); const target = await emptyLibrary(t);
  await plan(target.store, job1, JOB1, 'source-7');   // Same archive, scanned on another device: different label.
  await target.store.commit(job1, 0, A);              // Already done, same bytes.
  await target.store.commit(job1, 3, E);              // Done here but pending in the backup: must stay done.
  const { outcome } = await restore(target.db, text);
  assert.equal(outcome.changes.sourcesUpdated, 1);
  const items = (await dump(target.db)).items.filter(row => row.job_hash === job1).map(row => [row.ordinal, row.state, row.object_hash]);
  assert.deepEqual(items, [[0, 'done', A.sha256], [1, 'done', A.sha256], [2, 'done', B.sha256], [3, 'done', E.sha256], [4, 'done', D.sha256]]);
  const job = (await dump(target.db)).jobs.find(row => row.hash === job1)!;
  assert.equal(job.state, 'completed'); assert.match(String(job.plan_json), /source-7/); // The existing plan is kept.
});

test('an incompatible inventory for the same archive is rejected and nothing changes', async t => {
  const text = await manifest((await sourceLibrary(t)).db); const target = await emptyLibrary(t);
  await plan(target.store, job1, ['2026-02-05_one-main.jpg', '2026-02-05_other-main.jpg'], 'source-1');
  await rejects(target.db, text, 'restore-conflict');
});

test('a preserved file with different bytes than the library already has is rejected', async t => {
  const text = await manifest((await sourceLibrary(t)).db); const target = await emptyLibrary(t);
  await plan(target.store, job1, JOB1, 'source-1'); await target.store.commit(job1, 1, C); // Backup says A.
  await rejects(target.db, text, 'restore-conflict');
});

test('catalog objects no memory references are kept and exported again', async t => {
  const db = (await emptyLibrary(t)).db; await db.runAsync('INSERT INTO stored_objects VALUES (?,?,?)', E.sha256, E.relativePath, E.bytes);
  const text = await manifest(db); assert.match(text, new RegExp(E.sha256));
  const target = await emptyLibrary(t); const { outcome } = await restore(target.db, text);
  assert.equal(outcome.changes.objectsAdded, 1); assert.equal(await manifest(target.db), text);
});

test('an existing object row with a different size is a conflict', async t => {
  const text = await manifest((await sourceLibrary(t)).db); const target = await emptyLibrary(t);
  await target.db.runAsync('INSERT INTO stored_objects VALUES (?,?,?)', A.sha256, A.relativePath, A.bytes + 1);
  await rejects(target.db, text, 'restore-conflict');
});

test('a database failure inside the merge rolls back everything', async t => {
  const text = await manifest((await sourceLibrary(t)).db); const target = await emptyLibrary(t);
  await plan(target.store, job3, ['2026-03-01_local-main.jpg'], 'source-1');
  target.db.failAt = 4; target.db.calls = 0;
  await rejects(target.db, text, 'disk-io-error');
  target.db.failAt = 0; await restore(target.db, text); // A retry then succeeds.
  assert.equal((await target.store.summary()).memories, 2);
});

test('cancellation before the commit boundary leaves the library unchanged', async t => {
  const text = await manifest((await sourceLibrary(t)).db); const target = await emptyLibrary(t);
  for (const when of ['readBackupManifest', 'storeBackupObjects', 'readStagedManifest'] as const) {
    await rejects(target.db, text, 'cancelled', { cancelWhen: call => call === when });
  }
  // Immediately before COMMIT: the last staged chunk has been applied, then cancel arrives.
  let staged = 0; const chunks = Math.ceil(text.length / 64);
  await rejects(target.db, text, 'cancelled', { cancelWhen: call => call === 'readStagedManifest' && ++staged === chunks });
});

test('cancellation just after the commit reports the committed restore', async t => {
  const text = await manifest((await sourceLibrary(t)).db); const target = await emptyLibrary(t);
  const { native, state } = bridge(text);
  target.db.afterCommit = () => { state.cancelled = true; };
  const outcome = await runRestore(native, target.db, 'content://synthetic', () => state.cancelled, () => {});
  assert.equal(outcome.changes.memoriesAdded, 2); assert.equal((await target.store.summary()).memories, 2);
});

test('the merge re-validates the staged copy: if it differs from what was validated, nothing changes', async t => {
  const text = await manifest((await sourceLibrary(t)).db); const target = await emptyLibrary(t);
  const tampered = text.replace('"memoryId":"one"}\n', '"memoryId":"two"}\n'); // Still parseable, different favorites.
  assert.notEqual(tampered, text);
  await rejects(target.db, text, 'backup-invalid', { stagedText: tampered });
});

test('native failures keep their code; cleanup failures are reported alongside, never instead', async t => {
  const text = await manifest((await sourceLibrary(t)).db); const target = await emptyLibrary(t);
  await rejects(target.db, text, 'backup-unreadable', { failOn: 'storeBackupObjects' });
  const { native, state } = bridge(text, { failOn: 'storeBackupObjects', endFails: true });
  const error = await runRestore(native, target.db, 'x', () => state.cancelled, () => {}).catch(e => e);
  assert.ok(error instanceof RestoreFailure && error.message === 'backup-unreadable' && error.cleanupFailed);
  const failedOpen = bridge(text); failedOpen.native.beginBackupRestore = async () => ({ ok: false, code: 'staging-cleanup-failed', cleanupFailed: true });
  const opened = await runRestore(failedOpen.native, target.db, 'x', () => false, () => {}).catch(e => e);
  assert.ok(opened instanceof RestoreFailure && opened.message === 'staging-cleanup-failed' && opened.cleanupFailed);
  const done = await restore(target.db, text, { endFails: true });
  assert.equal(done.outcome.cleanupFailed, true); assert.equal(done.outcome.changes.memoriesAdded, 2); // Committed; cleanup reported.
});

test('store staging cleanup failures are kept apart from the step code and from private-copy cleanup', async t => {
  const text = await manifest((await sourceLibrary(t)).db); const target = await emptyLibrary(t);
  const before = await dump(target.db);
  const failing = (result: { ok: false; code: string; cleanupFailed?: boolean; storeCleanupFailed?: boolean }, cancel = false) => {
    const { native, state } = bridge(text);
    native.storeBackupObjects = async () => { if (cancel) state.cancelled = true; return result; };
    return runRestore(native, target.db, 'x', () => state.cancelled, () => {}).catch(e => e);
  };
  // Processing failed and its staged part could not be deleted: the processing code stays the reason.
  const damaged = await failing({ ok: false, code: 'backup-damaged', storeCleanupFailed: true });
  assert.ok(damaged instanceof RestoreFailure && damaged.message === 'backup-damaged' && damaged.storeCleanupFailed && !damaged.cleanupFailed);
  // Cancellation plus a failed delete: both are reported.
  const cancelled = await failing({ ok: false, code: 'cancelled', storeCleanupFailed: true }, true);
  assert.ok(cancelled instanceof RestoreFailure && cancelled.message === 'cancelled' && cancelled.storeCleanupFailed);
  // A private-copy failure on the step's path is not a store failure.
  const copy = await failing({ ok: false, code: 'backup-unreadable', cleanupFailed: true });
  assert.ok(copy instanceof RestoreFailure && copy.cleanupFailed && !copy.storeCleanupFailed);
  // recoverStaging could not remove an abandoned part: its own code, from prepare.
  const { native } = bridge(text); native.prepareBackupRestore = async () => ({ ok: false, code: 'store-staging-cleanup-failed', storeCleanupFailed: true });
  const recovered = await runRestore(native, target.db, 'x', () => false, () => {}).catch(e => e);
  assert.ok(recovered instanceof RestoreFailure && recovered.message === 'store-staging-cleanup-failed' && recovered.storeCleanupFailed);
  // A failure whose cleanup worked carries no flags.
  const clean = await failing({ ok: false, code: 'backup-damaged' });
  assert.ok(clean instanceof RestoreFailure && !clean.storeCleanupFailed && !clean.cleanupFailed);
  assert.deepEqual(await dump(target.db), before, 'nothing changed');
  // Then a retry succeeds.
  assert.equal((await restore(target.db, text)).outcome.changes.memoriesAdded, 2);
});

test('restore failure wording: each leftover is named once, store staging never claims reopening clears it', () => {
  const messages = (code: string, copy: boolean, store: boolean) => en.restoreFailureNotices(code, copy, store).map(notice => notice.message);
  assert.deepEqual(messages('backup-damaged', false, true), [en.inspectErrors['backup-damaged'], en.restoreNotChanged, en.restoreStoreCleanupFailed]);
  assert.deepEqual(messages('cancelled', false, true), [en.restoreCancelled, en.restoreStoreCleanupFailed]);
  assert.deepEqual(messages('cancelled', true, true), [en.restoreCancelled, en.inspectCleanupFailed, en.restoreStoreCleanupFailed]);
  const recover = en.restoreFailureNotices('store-staging-cleanup-failed', false, true);
  assert.deepEqual(recover.map(notice => notice.message), [en.restoreErrors['store-staging-cleanup-failed'], en.restoreNotChanged]);
  assert.equal(recover[0]!.tone, 'warning');
  assert.deepEqual(messages('backup-damaged', false, false), [en.inspectErrors['backup-damaged'], en.restoreNotChanged]);
  for (const text of [en.restoreErrors['store-staging-cleanup-failed']!, en.restoreStoreCleanupFailed]) {
    assert.doesNotMatch(text, /reopen|startup|was not opened/i);
    assert.match(text, /next time you restore a backup or preserve originals/);
  }
});

test('the native steps run in order: validate, store every object, then merge from the staged copy', async t => {
  const text = await manifest((await sourceLibrary(t)).db); const target = await emptyLibrary(t);
  const { calls } = await restore(target.db, text);
  const first = (name: string) => calls.indexOf(name), last = (name: string) => calls.lastIndexOf(name);
  assert.equal(first('beginBackupRestore'), 0);
  assert.ok(last('readBackupManifest') < first('sealBackupInspection') && last('declareBackupObjects') < first('sealBackupInspection'));
  assert.ok(first('sealBackupInspection') < first('prepareBackupRestore') && first('prepareBackupRestore') < first('storeBackupObjects'));
  assert.ok(last('storeBackupObjects') < first('readStagedManifest'));   // Every object is durable before the merge.
  assert.equal(last('endBackupInspection'), calls.length - 1);
});

test('a process killed inside the merge transaction leaves the library unchanged; a retry completes', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'snarchive-restore-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const text = await manifest((await sourceLibrary(t)).db);
  const path = join(dir, 'library.db'); const manifestPath = join(dir, 'manifest.jsonl'); writeFileSync(manifestPath, text);
  const target = await emptyLibrary(t, path);
  await plan(target.store, job3, ['2026-03-01_local-main.jpg'], 'source-1'); await target.store.commit(job3, 0, E);
  const before = await dump(target.db); target.db.raw.close();
  // The child applies the whole manifest inside the transaction, then exits before COMMIT.
  const child = spawnSync(process.execPath, ['--experimental-strip-types', 'tests/restoreCrashChild.ts', path, manifestPath], { encoding: 'utf8' });
  assert.equal(child.status, 9, child.stderr);
  const reopened = await emptyLibrary(t, path);
  assert.deepEqual(await dump(reopened.db), before);
  const { outcome } = await restore(reopened.db, text);
  assert.equal(outcome.changes.memoriesAdded, 2); assert.equal((await reopened.store.summary()).memories, 3);
});

type Row = { date: string; link?: string; location?: string };
const savedMedia = (rows: Row[]) => JSON.stringify({ 'Saved Media': rows.map(row => ({
  Date: row.date, 'Media Type': 'Image', 'Download Link': row.link ?? 'https://synthetic.invalid/download?mid=one', Location: row.location ?? 'Latitude, Longitude: 10, 20' })) });
const ONE: Row = { date: '2026-02-06 12:00:00 UTC' };
/** Plans job1 as a device would after scanning: one media file plus memories_history.json evidence (or none). */
async function planWithMetadata(store: ImportStore, label: string, rows: Row[] | null) {
  const metadataText = rows && savedMedia(rows);
  const entries = [{ path: '2026-02-05_one-main.jpg' }, ...(metadataText ? [{ path: 'memories_history.json', metadataText }] : [])];
  await store.plan(job1, inventoryFromSnapshot({ entries, metadataBytes: metadataText?.length ?? 0, visitedEntries: entries.length }, label));
}
async function metadataBackup(t: { after(fn: () => void): void }) {
  const { db, store } = await emptyLibrary(t);
  await planWithMetadata(store, 'source-1', [ONE]); await store.commit(job1, 0, A);
  return manifest(db);
}

test('source compatibility: identical evidence under a different device label is accepted, and re-export keeps it', async t => {
  const text = await metadataBackup(t); assert.match(text, /2026-02-06T12:00:00\.000Z/); assert.match(text, /"latitude":10/);
  const target = await emptyLibrary(t); await planWithMetadata(target.store, 'source-7', [ONE]);
  const { outcome } = await restore(target.db, text);
  assert.equal(outcome.changes.sourcesUpdated, 1); assert.equal(outcome.changes.memoriesAdded, 1);
  const again = await manifest(target.db);
  assert.match(again, /2026-02-06T12:00:00\.000Z/); assert.match(again, /"latitude":10/); assert.match(again, /source-7:metadata-1/);
  const fresh = await emptyLibrary(t); await restore(fresh.db, text);
  assert.equal(await manifest(fresh.db), text); // Into an empty library, every piece of evidence survives exactly.
});

test('source compatibility: a library missing the backup\'s metadata is a conflict, not a silent loss', async t => {
  const text = await metadataBackup(t); const target = await emptyLibrary(t);
  await planWithMetadata(target.store, 'source-1', null);
  await rejects(target.db, text, 'restore-conflict');
});

test('source compatibility: timestamp-only, location-only, diagnostic and metadata-only differences are conflicts', async t => {
  const text = await metadataBackup(t);
  const variants: Record<string, Row[]> = {
    timestamp: [{ date: '2026-02-06 13:00:00 UTC' }],
    location: [{ ...ONE, location: 'Latitude, Longitude: 11, 20' }],
    diagnostic: [ONE, { date: 'not a date', link: 'https://synthetic.invalid/download?mid=two' }],
    pendingEvidence: [ONE, { date: '2026-02-07 09:00:00 UTC', link: 'https://synthetic.invalid/download?mid=later' }],
  };
  for (const [name, rows] of Object.entries(variants)) {
    const target = await emptyLibrary(t); await planWithMetadata(target.store, 'source-3', rows);
    const before = await dump(target.db);
    await rejects(target.db, text, 'restore-conflict');
    assert.deepEqual(await dump(target.db), before, name);
  }
});

test('source evidence comparison ignores only the label', async () => {
  const { sourceEvidence } = await import('../src/backup/restoreMerge.ts');
  const source = (label: string, rows: Row[]) => inventoryFromSnapshot({ entries: [{ path: '2026-02-05_one-main.jpg' }, { path: 'memories_history.json', metadataText: savedMedia(rows) }], metadataBytes: 10, visitedEntries: 2 }, label);
  assert.equal(sourceEvidence(source('source-1', [ONE])), sourceEvidence(source('source-7', [ONE])));
  assert.notEqual(sourceEvidence(source('source-1', [ONE])), sourceEvidence(source('source-1', [{ ...ONE, location: 'Latitude, Longitude: 10, 21' }])));
});
