import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ImportStore, type Receipt } from '../src/storage/importStore.ts';
import { inventoryFromSnapshot } from '../src/import/sourceInventory.ts';
import { reviewStorage, removeSelected, StorageReviewFailure, type StorageBridge, type StorageEntry, type StorageKind } from '../src/integrity/storageCleanup.ts';
import type { SqlDatabase, SqlConnection } from '../src/storage/previewStore.ts';
import { quarantineCopyId, storageEntryLabel } from '../src/ui/storageLabels.ts';

/** A file database, so a second connection can compete with the exclusive transaction as another writer would. */
class DB implements SqlDatabase {
  raw: DatabaseSync; readonly path: string;
  constructor(path: string) { this.path = path; this.raw = new DatabaseSync(path); }
  async execAsync(sql: string) { this.raw.exec(sql); }
  async runAsync(sql: string, ...p: (string | number | null)[]) { this.raw.prepare(sql).run(...p); }
  async getFirstAsync<T>(sql: string, ...p: (string | number | null)[]) { return (this.raw.prepare(sql).get(...p) as T | undefined) ?? null; }
  async getAllAsync<T>(sql: string, ...p: (string | number | null)[]) { return this.raw.prepare(sql).all(...p) as T[]; }
  transactions = 0;
  async withExclusiveTransactionAsync(work: (tx: SqlConnection) => Promise<void>) {
    this.transactions++;
    this.raw.exec('BEGIN EXCLUSIVE'); try { await work(this); this.raw.exec('COMMIT'); } catch (e) { this.raw.exec('ROLLBACK'); throw e; }
  }
}
const receipt = (content: string): Receipt => {
  const sha256 = createHash('sha256').update(content).digest('hex');
  return { sha256, relativePath: `objects/${sha256.slice(0, 2)}/${sha256}`, bytes: Buffer.byteLength(content) };
};
const hashOf = (content: string) => receipt(content).sha256;

/** A library with one committed memory ("kept"), plus object hashes referenced by exactly one kind of row each. */
async function library(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), 'storage-cleanup-'));
  const db = new DB(join(dir, 'library.db')); t.after(() => { try { db.raw.close(); } catch {} rmSync(dir, { recursive: true, force: true }); });
  const store = new ImportStore(db); await store.initialize();
  const zip = 'a'.repeat(64);
  const names = ['2026-02-05_one-main.jpg', '2026-02-06_two-main.jpg', '2026-02-07_three-main.jpg', '2026-02-08_four-main.jpg'];
  await store.plan(zip, inventoryFromSnapshot({ entries: names.map(path => ({ path })), metadataBytes: 0, visitedEntries: names.length }, 'source-1'));
  for (const [i, content] of ['kept', 'memory-only', 'item-only', 'catalog-only'].entries()) await store.commit(zip, i, receipt(content));
  db.raw.exec('PRAGMA foreign_keys=OFF');
  // memory-only: only a memory association remains. item-only: only the import observation. catalog-only: only the catalog row.
  db.raw.prepare('DELETE FROM stored_objects WHERE hash IN (?,?)').run(hashOf('memory-only'), hashOf('item-only'));
  db.raw.prepare('DELETE FROM import_items WHERE object_hash IN (?,?)').run(hashOf('memory-only'), hashOf('catalog-only'));
  db.raw.prepare('DELETE FROM memory_objects WHERE object_hash IN (?,?)').run(hashOf('item-only'), hashOf('catalog-only'));
  const left = (table: string, column: string, hash: string) => (db.raw.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${column}=?`).get(hash) as { n: number }).n;
  assert.deepEqual([left('stored_objects', 'hash', hashOf('memory-only')), left('memory_objects', 'object_hash', hashOf('memory-only')), left('import_items', 'object_hash', hashOf('memory-only'))], [0, 1, 0]);
  assert.deepEqual([left('stored_objects', 'hash', hashOf('item-only')), left('memory_objects', 'object_hash', hashOf('item-only')), left('import_items', 'object_hash', hashOf('item-only'))], [0, 0, 1]);
  assert.deepEqual([left('stored_objects', 'hash', hashOf('catalog-only')), left('memory_objects', 'object_hash', hashOf('catalog-only')), left('import_items', 'object_hash', hashOf('catalog-only'))], [1, 0, 0]);
  return { db, store, zip };
}
function dump(db: DB) {
  const all = (sql: string) => db.raw.prepare(sql).all();
  return JSON.stringify([all('SELECT * FROM import_jobs ORDER BY hash'), all('SELECT * FROM import_items ORDER BY job_hash,ordinal'), all('SELECT * FROM stored_objects ORDER BY hash'),
    all('SELECT * FROM memories ORDER BY id'), all('SELECT * FROM memory_objects ORDER BY memory_id,role,object_hash'), all('SELECT * FROM library_favorites ORDER BY memory_id'),
    all('SELECT * FROM library_dates ORDER BY memory_id,kind,value')]);
}

type File = StorageEntry;
const object = (content: string, n = 0): File => {
  const hash = hashOf(content);
  return { kind: 'object', path: `objects/${hash.slice(0, 2)}/${hash}`, hash, bytes: content.length, modified: 1_700_000_000_000 + n, identity: `id-${content}` };
};
const kept = (content: string, n: number): File => {
  const hash = hashOf(content), name = `${hash}-${1_700_000_000_000 + n}-0000000${n}.damaged`;
  return { kind: 'quarantine', path: `quarantine/${name}`, hash, bytes: 100 + n, modified: 1_700_000_000_000 + n, identity: `q-${n}` };
};
/** A fake native store: a sorted file list, paged by path; removal checks the session mode and identity, like StorageReview. */
class Fake implements StorageBridge {
  files = new Map<string, File>(); sessions: string[] = []; ended = 0; open: string | null = null;
  beginCode: string | null = null; endOk = true; pageFail: StorageKind | null = null;
  removed: string[] = []; result = new Map<string, { ok: boolean; code?: string; outcome?: 'removed' | 'skipped'; reason?: string; warning?: string }>();
  beforeRemove: ((path: string) => void) | null = null; throwOnRemove = false;
  constructor(files: File[]) { for (const f of files) this.files.set(f.path, f); }
  async beginStorageReview(mode: 'scan' | 'cleanup') {
    if (this.open) return { ok: false, code: 'busy' };
    if (this.beginCode) return { ok: false, code: this.beginCode };
    this.open = mode; this.sessions.push(mode); return { ok: true };
  }
  async reviewStoragePage(kind: StorageKind, after: string, limit: number) {
    assert.ok(this.open, 'pages only in a session');
    if (this.pageFail === kind) return { ok: false, code: 'storage-unreadable' };
    const prefix = kind === 'object' ? 'objects/' : 'quarantine/';
    const all = [...this.files.values()].filter(f => f.kind === kind).sort((a, b) => a.path < b.path ? -1 : 1);
    const rest = all.filter(f => f.path.slice(prefix.length) > after), entries = rest.slice(0, limit);
    return { ok: true, entries, next: rest.length > limit ? entries.at(-1)!.path.slice(prefix.length) : null, unrecognized: 1 };
  }
  async removeStorageEntry(kind: StorageKind, path: string, identity: string) {
    assert.equal(this.open, 'cleanup', 'removal only in a cleanup session');
    this.beforeRemove?.(path);
    if (this.throwOnRemove) throw new Error('bridge rejected');
    const forced = this.result.get(path);
    if (forced) { if (forced.outcome === 'removed') { this.files.delete(path); this.removed.push(path); } return forced; }
    const file = this.files.get(path);
    if (!file || file.kind !== kind) return { ok: true, outcome: 'skipped' as const, reason: 'missing' };
    if (file.identity !== identity) return { ok: true, outcome: 'skipped' as const, reason: 'changed' };
    this.files.delete(path); this.removed.push(path); return { ok: true, outcome: 'removed' as const, reason: null, warning: null };
  }
  async endStorageReview() { this.ended++; this.open = null; return this.endOk ? { ok: true } : { ok: false, code: 'backup-cleanup-failed' }; }
}
const never = () => false;

test('every kind of library reference protects an object; only unreferenced objects and all quarantine copies are listed', async t => {
  const { db } = await library(t);
  const files = [object('kept'), object('memory-only'), object('item-only'), object('catalog-only'), object('orphan-1'), object('orphan-2'), kept('kept', 1), kept('memory-only', 2)];
  const fake = new Fake(files); const before = dump(db); const seen: number[] = [];
  const result = await reviewStorage(db, fake, never, n => seen.push(n));
  assert.deepEqual(result.uncatalogued.map(e => e.hash).sort(), [hashOf('orphan-1'), hashOf('orphan-2')].sort());
  assert.deepEqual(result.quarantine.map(e => e.path), [kept('kept', 1).path, kept('memory-only', 2).path].sort());
  assert.equal(result.catalogued, 4); assert.equal(result.unrecognized, 2); assert.equal(result.cleanupFailed, false);
  assert.deepEqual([fake.sessions, fake.ended, fake.removed], [['scan'], 1, []]);
  assert.equal(seen.at(-1), 8); assert.equal(dump(db), before, 'a review changes nothing');
});

test('a catalog row found only by its path also protects the object', async t => {
  const { db } = await library(t);
  const orphan = object('orphan');
  db.raw.prepare('INSERT INTO stored_objects(hash,relative_path,bytes) VALUES (?,?,?)').run('f'.repeat(64), orphan.path, 6);
  const result = await reviewStorage(db, new Fake([orphan]), never, () => {});
  assert.deepEqual([result.uncatalogued.length, result.catalogued], [0, 1]);
});

test('objects are paged and checked in bounded batches across more than one page', async t => {
  const { db } = await library(t);
  const files = Array.from({ length: 1203 }, (_, i) => object(`orphan-${i}`, i));
  const result = await reviewStorage(db, new Fake([...files, object('kept')]), never, () => {});
  assert.equal(result.uncatalogued.length, 1203); assert.equal(result.catalogued, 1);
  assert.equal(new Set(result.uncatalogued.map(e => e.path)).size, 1203, 'each once');
});

test('an unsupported schema, a failed query or a failed page fail closed and end the session once', async t => {
  const { db } = await library(t);
  const fake = new Fake([object('orphan')]);
  db.raw.exec('PRAGMA user_version = 4');
  await assert.rejects(reviewStorage(db, fake, never, () => {}), (e: StorageReviewFailure) => e.message === 'storage-schema-unsupported');
  assert.deepEqual(fake.sessions, [], 'refused before opening a session');
  db.raw.exec('PRAGMA user_version = 6');
  db.raw.exec('ALTER TABLE memory_objects RENAME TO memory_objects_moved');
  await assert.rejects(reviewStorage(db, fake, never, () => {}), (e: StorageReviewFailure) => e.message === 'library-check-failed');
  assert.deepEqual([fake.sessions.length, fake.ended], [1, 1]);
  db.raw.exec('ALTER TABLE memory_objects_moved RENAME TO memory_objects');
  fake.pageFail = 'quarantine'; fake.endOk = false;
  await assert.rejects(reviewStorage(db, fake, never, () => {}), (e: StorageReviewFailure) => e.message === 'storage-unreadable' && e.cleanupFailed);
  assert.deepEqual([fake.sessions.length, fake.ended], [2, 2]);
  fake.pageFail = null; fake.endOk = true; fake.beginCode = 'busy';
  await assert.rejects(reviewStorage(db, fake, never, () => {}), (e: StorageReviewFailure) => e.message === 'busy');
  let stop = false; fake.beginCode = null;
  await assert.rejects(reviewStorage(db, fake, () => stop, () => { stop = true; }), (e: StorageReviewFailure) => e.message === 'cancelled');
  assert.equal(fake.ended, fake.sessions.length, 'every opened session ended once');
});

test('removal deletes exactly the selected entries, never unselected ones, and leaves the library unchanged', async t => {
  const { db } = await library(t);
  const a = object('orphan-a'), b = object('orphan-b'), q1 = kept('kept', 1), q2 = kept('kept', 2);
  const fake = new Fake([a, b, q1, q2, object('kept')]); const before = dump(db);
  const review = await reviewStorage(db, fake, never, () => {});
  db.transactions = 0;
  const report = await removeSelected(db, fake, [review.uncatalogued.find(e => e.path === a.path)!, review.quarantine.find(e => e.path === q2.path)!], never, () => {});
  assert.deepEqual(report.removed, [a.path, q2.path]); assert.deepEqual(fake.removed, [a.path, q2.path]);
  assert.ok(fake.files.has(b.path) && fake.files.has(q1.path) && fake.files.has(object('kept').path), 'unselected kept');
  assert.deepEqual([report.skipped, report.failed, report.notAttempted, report.warnings, report.stopped, report.cleanupFailed], [[], [], [], [], null, false]);
  assert.equal(report.bytesListed, a.bytes + q2.bytes);
  assert.deepEqual(fake.sessions, ['scan', 'cleanup']); assert.equal(fake.ended, 2);
  assert.equal(db.transactions, 2, 'one exclusive transaction per entry');
  assert.equal(dump(db), before, 'the logical library is unchanged');
  const empty = await removeSelected(db, fake, [], never, () => {});
  assert.deepEqual([empty.removed, empty.stopped], [[], null]);
});

test('a reference added after the review protects the object: it is skipped as referenced, never removed', async t => {
  for (const kind of ['catalog', 'memory', 'item'] as const) {
    const { db, zip } = await library(t);
    const late = object(`late-${kind}`), other = object('other');
    const fake = new Fake([late, other]);
    const review = await reviewStorage(db, fake, never, () => {});
    assert.equal(review.uncatalogued.length, 2);
    if (kind === 'catalog') db.raw.prepare('INSERT INTO stored_objects(hash,relative_path,bytes) VALUES (?,?,?)').run(late.hash, late.path, late.bytes);
    if (kind === 'memory') db.raw.prepare('UPDATE memory_objects SET object_hash=? WHERE object_hash=?').run(late.hash, hashOf('memory-only'));
    if (kind === 'item') db.raw.prepare('UPDATE import_items SET object_hash=? WHERE job_hash=? AND ordinal=0').run(late.hash, zip);
    const report = await removeSelected(db, fake, review.uncatalogued, never, () => {});
    assert.deepEqual(report.skipped, [{ path: late.path, reason: 'referenced' }], kind);
    assert.deepEqual(report.removed, [other.path], kind); assert.ok(fake.files.has(late.path), kind);
  }
});

test('the reference proof and the removal share one exclusive transaction: no other connection can write in between', async t => {
  const { db } = await library(t);
  const target = object('orphan');
  const fake = new Fake([target]);
  const review = await reviewStorage(db, fake, never, () => {});
  const other = new DatabaseSync(db.path, { timeout: 0 } as never); t.after(() => other.close());
  let blocked = '';
  fake.beforeRemove = () => {
    try { other.prepare('INSERT INTO stored_objects(hash,relative_path,bytes) VALUES (?,?,?)').run(target.hash, target.path, target.bytes); }
    catch (error) { blocked = (error as Error).message; }
  };
  const report = await removeSelected(db, fake, review.uncatalogued, never, () => {});
  assert.match(blocked, /locked|busy/i, 'a second writer is refused during the native removal');
  assert.deepEqual(report.removed, [target.path]);
  assert.equal((other.prepare('SELECT count(*) AS n FROM stored_objects WHERE hash=?').get(target.hash) as { n: number }).n, 0);
});

test('a changed or missing file is skipped; per-entry failures continue; others stop with the rest not attempted', async t => {
  const { db } = await library(t);
  const files = ['a', 'b', 'c', 'd', 'e', 'f'].map(c => object(`orphan-${c}`)); const fake = new Fake(files);
  const review = await reviewStorage(db, fake, never, () => {});
  const pick = (i: number) => review.uncatalogued.find(x => x.path === files[i]!.path)!;
  const a = pick(0), b = pick(1), c = pick(2), d = pick(3), e = pick(4), f = pick(5);
  fake.files.set(a.path, { ...a, identity: 'replaced' }); fake.files.delete(b.path);
  fake.result.set(c.path, { ok: false, code: 'delete-failed' });
  fake.result.set(d.path, { ok: true, outcome: 'removed', warning: 'sync-failed' });
  fake.result.set(e.path, { ok: false, code: 'storage-review-failed' });
  const report = await removeSelected(db, fake, [a, b, c, d, e, f], never, () => {});
  assert.deepEqual(report.skipped, [{ path: a.path, reason: 'changed' }, { path: b.path, reason: 'missing' }]);
  assert.deepEqual(report.failed, [{ path: c.path, code: 'delete-failed' }]);
  assert.deepEqual(report.removed, [d.path]); assert.deepEqual(report.warnings, [{ path: d.path, code: 'sync-failed' }]);
  assert.equal(report.stopped, 'storage-review-failed'); assert.deepEqual(report.notAttempted, [e.path, f.path]);
  assert.ok(fake.files.has(f.path) && fake.files.has(a.path)); assert.equal(fake.open, null);
});

test('cancellation before the first and between removals keeps completed ones and attempts nothing more', async t => {
  const { db } = await library(t);
  const files = ['a', 'b', 'c'].map(c => object(`orphan-${c}`)); const fake = new Fake(files);
  const review = (await reviewStorage(db, fake, never, () => {})).uncatalogued;
  await assert.rejects(removeSelected(db, fake, review, () => true, () => {}), (e: StorageReviewFailure) => e.message === 'cancelled');
  assert.deepEqual([fake.sessions, fake.removed], [['scan'], []], 'no session opened, nothing removed');
  let stop = false;
  const report = await removeSelected(db, fake, review, () => stop, done => { if (done === 1) stop = true; });
  assert.deepEqual(report.removed, [review[0]!.path]); assert.deepEqual(report.notAttempted, [review[1]!.path, review[2]!.path]);
  assert.equal(report.stopped, 'cancelled'); assert.equal(fake.ended, 2);
  // Cancelled at the native check just before the unlink.
  fake.result.set(review[1]!.path, { ok: false, code: 'cancelled' });
  const native = await removeSelected(db, fake, review.slice(1), never, () => {});
  assert.deepEqual([native.removed, native.stopped, native.notAttempted], [[], 'cancelled', review.slice(1).map(e => e.path)]);
});

test('a failed proof stops before the native call; a rejected native call stops; a session cleanup failure never replaces the outcome', async t => {
  const { db } = await library(t);
  const files = ['a', 'b'].map(c => object(`orphan-${c}`)); const fake = new Fake(files);
  const review = (await reviewStorage(db, fake, never, () => {})).uncatalogued;
  db.raw.exec('PRAGMA user_version = 7');
  let report = await removeSelected(db, fake, review, never, () => {});
  assert.deepEqual([report.stopped, report.notAttempted.length, fake.removed], ['storage-schema-unsupported', 2, []]);
  db.raw.exec('PRAGMA user_version = 6');
  db.raw.exec('ALTER TABLE import_items RENAME TO import_items_moved');
  report = await removeSelected(db, fake, review, never, () => {});
  assert.deepEqual([report.stopped, report.notAttempted.length, fake.removed], ['library-check-failed', 2, []]);
  db.raw.exec('ALTER TABLE import_items_moved RENAME TO import_items');
  fake.throwOnRemove = true; fake.endOk = false;
  report = await removeSelected(db, fake, review, never, () => {});
  assert.deepEqual([report.stopped, report.notAttempted.length, report.cleanupFailed], ['storage-review-failed', 2, true]);
  fake.throwOnRemove = false; fake.endOk = true; fake.beginCode = 'storage-busy';
  await assert.rejects(removeSelected(db, fake, review, never, () => {}), (e: StorageReviewFailure) => e.message === 'storage-busy');
  fake.beginCode = null; fake.open = 'scan';
  await assert.rejects(removeSelected(db, fake, review, never, () => {}), (e: StorageReviewFailure) => e.message === 'busy', 'another operation holds the guard');
  fake.open = null;
  assert.equal(fake.ended, 4, 'each opened cleanup session ended exactly once');
});

test('a rescan after an interrupted removal shows what is still there and never resumes a selection', async t => {
  const { db } = await library(t);
  const files = ['a', 'b', 'c'].map(c => object(`orphan-${c}`)); const fake = new Fake(files);
  const first = (await reviewStorage(db, fake, never, () => {})).uncatalogued;
  fake.result.set(first[1]!.path, { ok: false, code: 'storage-review-failed' }); // As if the app stopped here.
  await removeSelected(db, fake, first, never, () => {});
  fake.result.clear();
  const again = await reviewStorage(db, fake, never, () => {});
  assert.deepEqual(again.uncatalogued.map(e => e.path), first.slice(1).map(e => e.path));
  assert.deepEqual(fake.sessions, ['scan', 'cleanup', 'scan'], 'nothing removed without a new selection');
});

test('copies of one original with the same size and date get distinct, stable labels from their file names', () => {
  const hash = hashOf('damaged-original'), modified = new Date(2026, 9, 20, 12).getTime();
  const copy = (millis: string, random: string): StorageEntry =>
    ({ kind: 'quarantine', path: `quarantine/${hash}-${millis}-${random}.damaged`, hash, bytes: 15_000, modified, identity: `q-${random}` });
  const first = copy('1760000000000', '00000000'), second = copy('1760000000001', '00000001');
  const a = storageEntryLabel(first), b = storageEntryLabel(second);
  assert.equal(a.detail, b.detail, 'same rounded size and calendar date');
  assert.notEqual(a.title, b.title); assert.notEqual(a.accessibilityLabel, b.accessibilityLabel);
  assert.equal(quarantineCopyId(first.path), '1760000000000-00000000');
  for (const [entry, label] of [[first, a], [second, b]] as const) {
    assert.ok(label.title.includes(quarantineCopyId(entry.path)) && label.title.includes(hash.slice(0, 12)), 'copy and original identifiers shown');
    assert.ok(label.accessibilityLabel.includes(label.title) && label.accessibilityLabel.includes(label.detail), 'spoken label carries both');
  }
  assert.deepEqual(storageEntryLabel({ ...first }), a, 'stable: derived only from the entry');
  const original = storageEntryLabel({ kind: 'object', path: `objects/${hash.slice(0, 2)}/${hash}`, hash, bytes: 15_000, modified, identity: 'o' });
  assert.equal(original.title, `Original ${hash.slice(0, 12)}`);
});
