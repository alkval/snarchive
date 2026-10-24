import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { ImportStore } from '../src/storage/importStore.ts';
import type { SqlDatabase, SqlConnection } from '../src/storage/previewStore.ts';
import { DETAIL_SECTIONS, readMemoryDetails, type DetailRow } from '../src/storage/memoryDetails.ts';
import { MemoryDetails } from '../src/domain/memoryDetails.ts';
import { detailFields } from '../src/domain/detailLabels.ts';
import { inventoryFromSnapshot } from '../src/import/sourceInventory.ts';
import { en } from '../src/i18n/en.ts';

class DB implements SqlDatabase {
  raw = new DatabaseSync(':memory:');
  async execAsync(sql: string) { this.raw.exec(sql); }
  async runAsync(sql: string, ...p: (string | number | null)[]) { this.raw.prepare(sql).run(...p); }
  async getFirstAsync<T>(sql: string, ...p: (string | number | null)[]) { return (this.raw.prepare(sql).get(...p) as T | undefined) ?? null; }
  async getAllAsync<T>(sql: string, ...p: (string | number | null)[]) { return this.raw.prepare(sql).all(...p) as T[]; }
  async withExclusiveTransactionAsync(work: (tx: SqlConnection) => Promise<void>) {
    this.raw.exec('BEGIN IMMEDIATE'); try { await work(this); this.raw.exec('COMMIT'); } catch (e) { this.raw.exec('ROLLBACK'); throw e; }
  }
}
const key = (r: DetailRow) => [r.key1, r.key2];
const hash = (i: number) => i.toString(16).padStart(64, '0');
const memory = "雪 ' OR 1=1 --";
async function fixture(t: { after(fn: () => void): void }) {
  const db = new DB(); t.after(() => db.raw.close());
  const store = new ImportStore(db); await store.initialize();
  // Query fixture, not an import/restore fixture: ties in each leading sort column, numeric ordinals > 9,
  // distinct ZIP/folder jobs and pending observations, all associated with the same memory.
  await db.runAsync('INSERT INTO memories VALUES (?)', memory);
  for (let i = 0; i < 53; i++) {
    const h = hash(i), role = i % 3 === 0 ? 'overlay' : i % 3 === 1 ? 'photo' : 'video';
    await db.runAsync('INSERT INTO stored_objects VALUES (?,?,?)', h, `objects/${h.slice(0, 2)}/${h}`, i * 123);
    await db.runAsync('INSERT INTO memory_objects VALUES (?,?,?)', memory, role, h);
    const value = `2020-${String(1 + Math.floor(i / 28)).padStart(2, '0')}-${String(1 + i % 28).padStart(2, '0')}`;
    await db.runAsync('INSERT INTO library_dates VALUES (?,?,?,?)', memory, i % 2 ? 'instant' : 'date-only', i % 2 ? `${value}T12:34:56.000Z` : value, value);
  }
  for (let j = 0; j < 2; j++) {
    const source = hash(90 + j);
    await db.runAsync('INSERT INTO import_jobs(hash,kind,state,plan_json) VALUES (?,?,?,?)', source, j ? 'folder' : 'zip', 'paused', '{}');
    for (let i = 0; i < 33; i++) await db.runAsync('INSERT INTO import_items VALUES (?,?,?,?,?,?,?,?)',
      source, i, `nested/雪 ${i}.jpg`, memory, 'photo', '{}', i % 2 ? 'done' : 'pending', i % 2 ? hash(i) : null);
  }
  return { db, store };
}
const row = (i: number): DetailRow => ({ section: 'dates', key1: 'date-only', key2: String(i).padStart(3, '0'), kind: 'date-only', value: String(i), day: String(i) });
function held<T>() { let resolve!: (value: T) => void; let reject!: (e: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }

test('details walk every evidence row in both directions without duplicates or a growing history', async t => {
  const { db } = await fixture(t);
  for (const section of DETAIL_SECTIONS) {
    const model = new MemoryDetails((s, a, d) => readMemoryDetails(db, memory, s, a, d));
    await model.select(section);
    const pages: (string | number)[][][] = [], all: DetailRow[] = [];
    while (true) {
      assert.ok(model.rows.length <= 20);
      pages.push(model.rows.map(key)); all.push(...model.rows);
      if (!model.hasNext) break;
      await model.move('next');
    }
    assert.equal(all.length, section === 'sources' ? 66 : 53);
    assert.equal(new Set(all.map(r => JSON.stringify(key(r)))).size, all.length);
    for (let i = pages.length - 2; i >= 0; i--) { await model.move('previous'); assert.deepEqual(model.rows.map(key), pages[i]); }
    assert.equal(model.hasPrevious, false);
    assert.equal(model.hasNext, true);
  }
});

test('details include all variants beyond the viewer limit, exact bytes, paths, source kinds and pending records', async t => {
  const { db, store } = await fixture(t);
  assert.equal((await store.objects(memory)).length, 3);
  let rows = await readMemoryDetails(db, memory, 'originals', null, 'next');
  assert.equal(rows.length, 21);
  assert.ok(rows.every(r => r.section === 'originals' && r.path === `objects/${r.hash.slice(0, 2)}/${r.hash}`));
  rows = await readMemoryDetails(db, memory, 'sources', { key1: hash(90), key2: 27 }, 'next');
  assert.deepEqual(rows.slice(0, 5).map(r => r.key2), [28, 29, 30, 31, 32]);
  assert.ok(rows.some(r => r.section === 'sources' && r.kind === 'folder'));
  assert.ok(rows.some(r => r.section === 'sources' && r.kind === 'zip' && r.state === 'pending' && r.hash === null));
  assert.ok(rows.some(r => r.section === 'sources' && r.state === 'done' && r.hash !== null));
});

test('details use bound memory and cursor values, distinguish absent memories, and reject unsafe section names', async t => {
  const { db } = await fixture(t);
  for (const s of DETAIL_SECTIONS) {
    assert.ok((await readMemoryDetails(db, memory, s, null, 'next')).length);
    assert.deepEqual(await readMemoryDetails(db, 'other', s, null, 'next'), []);
    assert.deepEqual(await readMemoryDetails(db, memory, s, { key1: "z' OR 1=1 --", key2: 0 }, 'next'), []);
  }
  await assert.rejects(readMemoryDetails(db, memory, 'toString' as never, null, 'next'), /invalid-details-section/);
});

test('a removed cursor is still a valid key for forward and reverse detail reads', async t => {
  const { db } = await fixture(t);
  const first = (await readMemoryDetails(db, memory, 'originals', null, 'next')).slice(0, 20);
  const last = first.at(-1)!;
  await db.runAsync('DELETE FROM memory_objects WHERE memory_id=? AND role=? AND object_hash=?', memory, last.key1, last.key2);
  const next = await readMemoryDetails(db, memory, 'originals', last, 'next');
  const back = await readMemoryDetails(db, memory, 'originals', next[0]!, 'previous');
  assert.deepEqual(back.reverse().map(key), first.slice(0, -1).map(key));
});

test('real planned and committed import evidence is shown without writing library or schema', async t => {
  const db = new DB(); t.after(() => db.raw.close()); const store = new ImportStore(db); await store.initialize();
  await store.plan(hash(80), inventoryFromSnapshot({ entries: [
    { path: '2020-01-02_same-main.jpg' }, { path: '2020-01-03_same-overlay.png' },
  ], metadataBytes: 0, visitedEntries: 2 }, 'source-1'));
  const h = hash(70); await store.commit(hash(80), 0, { sha256: h, relativePath: `objects/${h.slice(0, 2)}/${h}`, bytes: 1234 });
  const snapshot = () => JSON.stringify([
    db.raw.prepare('SELECT total_changes() AS changes').get(), db.raw.prepare('PRAGMA user_version').get(),
    ...['sqlite_master', 'memories', 'stored_objects', 'memory_objects', 'library_dates', 'import_jobs', 'import_items', 'library_favorites']
      .map(table => db.raw.prepare(`SELECT * FROM ${table}`).all()),
  ]);
  const before = snapshot();
  const originals = await readMemoryDetails(db, 'same', 'originals', null, 'next');
  const dates = await readMemoryDetails(db, 'same', 'dates', null, 'next');
  const sources = await readMemoryDetails(db, 'same', 'sources', null, 'next');
  assert.equal(originals.length, 1); assert.equal(dates.length, 2); assert.equal(sources.length, 2);
  assert.deepEqual(sources.map(r => r.section === 'sources' && r.state), ['done', 'pending']);
  assert.equal(snapshot(), before);
});

test('loading blocks repeated page taps and failed reads retry the same cursor', async () => {
  const gate = held<DetailRow[]>(); const calls: unknown[] = []; let fail = false;
  const model = new MemoryDetails(async (s, a, d) => { calls.push([s, a, d]); if (!a) return Array.from({ length: 21 }, (_, i) => row(i)); if (fail) throw Error('db'); return calls.length === 2 ? gate.promise : [row(20)]; });
  await model.open(); const next = model.move('next'); await model.move('next'); await model.move('previous');
  assert.equal(calls.length, 2); gate.reject(Error('db')); await next;
  assert.equal(model.failed, true); assert.equal(model.loading, false); assert.equal(model.rows.length, 0);
  fail = true; await model.load(); assert.deepEqual(calls.at(-1), calls.at(-2));
  fail = false; await model.load(); assert.equal(model.failed, false); assert.deepEqual(model.rows.map(key), [key(row(20))]);
  assert.deepEqual(calls.at(-1), calls.at(-2)); assert.equal(model.hasPrevious, true);
});

test('switching sections supersedes a held result or error and starts at the first page', async () => {
  for (const reject of [false, true]) {
    const gate = held<DetailRow[]>();
    const model = new MemoryDetails(async section => section === 'originals' ? gate.promise : [row(5)]);
    const opening = model.load(); await model.select('dates');
    if (reject) gate.reject(Error('late')); else gate.resolve([row(1)]);
    await opening; assert.equal(model.section, 'dates'); assert.equal(model.failed, false);
    assert.deepEqual(model.rows.map(key), [key(row(5))]); assert.equal(model.hasPrevious, false);
  }
});

test('closing invalidates reads and a repeated effect setup can safely reopen the model', async () => {
  const gate = held<DetailRow[]>(); let first = true, changes = 0;
  const model = new MemoryDetails(async () => { if (first) { first = false; return gate.promise; } return [row(2)]; });
  model.subscribe(() => changes++); const opening = model.open(); model.close();
  const count = changes; model.subscribe(() => changes++); await model.open();
  gate.resolve([row(1)]); await opening;
  assert.equal(changes, count + 2); assert.deepEqual(model.rows.map(key), [key(row(2))]);
  model.close(); await model.load(); assert.equal(changes, count + 2);
});

test('empty and exact-size pages expose neither an invented next page nor stale flags after switching', async () => {
  const model = new MemoryDetails(async s => s === 'dates' ? [] : Array.from({ length: 20 }, (_, i) => row(i)));
  await model.load(); assert.equal(model.hasNext, false); assert.equal(model.hasPrevious, false);
  await model.select('dates'); assert.deepEqual(model.rows, []); assert.equal(model.hasNext, false);
});

test('labels retain full identities and exact byte counts without a date timezone conversion or integrity claim', () => {
  const original: DetailRow = { section: 'originals', key1: 'photo', key2: hash(1), role: 'photo', hash: hash(1), path: `objects/00/${hash(1)}`, bytes: 1234567 };
  assert.deepEqual(detailFields(original).map(f => f.value), ['1,234,567 bytes', hash(1), original.path]);
  const date: DetailRow = { section: 'dates', key1: 'instant', key2: '2020-01-01T00:00:00.000Z', kind: 'instant', value: '2020-01-01T00:00:00.000Z', day: '2020-01-01' };
  assert.deepEqual(detailFields(date), [{ label: 'Export metadata · UTC', value: date.value }]);
  const pending: DetailRow = { section: 'sources', key1: hash(1), key2: 12, kind: 'folder', path: 'outer/雪.jpg', role: 'overlay', state: 'pending', hash: null };
  assert.ok(detailFields(pending).some(f => f.value === pending.path));
  assert.deepEqual(detailFields(pending).at(-1), { label: 'Pending in this import', value: '—' });
  assert.match(en.detailsNote, /does not check file integrity/); assert.match(en.detailsDateNote, /Repeated evidence is shown once/);
});
