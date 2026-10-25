import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { ImportStore, type ChronologicalRow } from '../src/storage/importStore.ts';
import type { SqlConnection } from '../src/storage/previewStore.ts';
import { inventoryFromSnapshot } from '../src/import/sourceInventory.ts';
import { defaultFilters, matchesFilters, validFilters, type LibraryFilters } from '../src/domain/libraryFilters.ts';
import { matchesOnThisDay, utcDay, validReferenceDay, watchUTCDate } from '../src/domain/onThisDay.ts';
import { MemorySequence, keyOf } from '../src/domain/memoryNavigation.ts';
import { LibraryGrid, favoriteSavedHandler } from '../src/domain/libraryGrid.ts';
import { FavoriteWrites } from '../src/domain/favoriteWrites.ts';
import { en } from '../src/i18n/en.ts';

const reference = '2026-10-23';
const scope: LibraryFilters = { ...defaultFilters, onThisDay: reference };
const tick = () => new Promise(resolve => setImmediate(resolve));
class DB {
  raw = new DatabaseSync(':memory:'); largest = 0;
  async execAsync(sql: string) { this.raw.exec(sql); }
  async runAsync(sql: string, ...p: (string | number | null)[]) { this.raw.prepare(sql).run(...p); }
  async getFirstAsync<T>(sql: string, ...p: (string | number | null)[]) {
    const row = (this.raw.prepare(sql).get(...p) as T | undefined) ?? null;
    const data = (row as { data?: unknown } | null)?.data;
    if (typeof data === 'string' && data.startsWith('[')) this.largest = Math.max(this.largest, (JSON.parse(data) as unknown[]).length);
    return row;
  }
  async getAllAsync<T>(sql: string, ...p: (string | number | null)[]) { return this.raw.prepare(sql).all(...p) as T[]; }
  async withExclusiveTransactionAsync(work: (tx: SqlConnection) => Promise<void>) {
    this.raw.exec('BEGIN IMMEDIATE');
    try { await work(this); this.raw.exec('COMMIT'); } catch (e) { this.raw.exec('ROLLBACK'); throw e; }
  }
}
async function library(t: { after(fn: () => void): void }) {
  const db = new DB(); t.after(() => db.raw.close());
  const store = new ImportStore(db); await store.initialize();
  const names = Array.from({ length: 65 }, (_, i) => `${2025 - i % 7}-10-23_m${String(i).padStart(2, '0')}-main.${i % 5 === 0 ? 'mp4' : 'jpg'}`);
  names.push('2026-10-23_current-main.jpg', '2027-10-23_future-main.jpg', '2025-10-22_before-main.jpg', '2025-10-24_after-main.jpg',
    '2025-02-30_unknown-main.jpg', '2025-10-23_conflict-main.jpg', '2025-10-23_timeconflict-main.jpg',
    '2024-02-29_leap-old-main.jpg', '2020-02-29_leap-older-main.jpg', '2028-02-29_leap-current-main.jpg', '2025-02-28_feb28-main.jpg');
  const zip = 'c'.repeat(64);
  await store.plan(zip, inventoryFromSnapshot({ entries: names.map(path => ({ path })), metadataBytes: 0, visitedEntries: names.length }, 'source-1'));
  for (let i = 0; i < names.length; i++) {
    const bytes = names[i]!, hash = createHash('sha256').update(bytes).digest('hex');
    await store.commit(zip, i, { sha256: hash, relativePath: `objects/${hash.slice(0, 2)}/${hash}`, bytes: bytes.length });
  }
  for (const id of ['m00', 'm07']) await db.runAsync("INSERT INTO library_dates(memory_id,kind,value,day) VALUES (?,'instant',?,?)", id, '2025-10-23T23:59:59.000Z', '2025-10-23');
  await db.runAsync("INSERT INTO library_dates(memory_id,kind,value,day) VALUES ('conflict','date-only','2025-10-24','2025-10-24')");
  for (const time of ['00:00:00', '01:00:00']) await db.runAsync("INSERT INTO library_dates(memory_id,kind,value,day) VALUES ('timeconflict','instant',?,'2025-10-23')", `2025-10-23T${time}.000Z`);
  return { db, store };
}
async function allRows(store: ImportStore, filters = defaultFilters): Promise<ChronologicalRow[]> {
  const rows: ChronologicalRow[] = [];
  for (let cursor: ReturnType<typeof keyOf> | null = null; ;) {
    const page = await store.chronologicalPage(cursor, 30, filters);
    rows.push(...page);
    if (page.length < 30) return rows;
    cursor = keyOf(page[page.length - 1]!);
  }
}
const gridFor = (store: ImportStore) => new LibraryGrid<ChronologicalRow>(
  (cursor, filters) => store.chronologicalPage(cursor, 31, filters));

test('On this day reference dates are complete calendar days and mutually exclusive with month', () => {
  for (const day of [reference, '2028-02-29', '0001-01-01']) {
    assert.equal(validReferenceDay(day), true);
    assert.equal(validFilters({ ...scope, onThisDay: day }), true);
  }
  for (const day of ['0000-01-01', '2026-02-29', '2026-02-30', '2026-1-01', '2026-10-23T00:00:00Z', "' OR 1=1", null])
    assert.equal(validReferenceDay(day), false);
  assert.equal(validFilters({ ...scope, onThisDay: '2026-02-30' }), false);
  assert.equal(validFilters({ ...scope, month: '2025-10' }), false);
  assert.equal(validFilters({ ...scope, onThisDay: '' }), true);
});

test('UTC reference dates do not shift with device offsets; only previous years match', () => {
  assert.equal(utcDay(new Date('2026-10-24T00:30:00+02:00')), reference);
  assert.equal(utcDay(new Date('2026-10-22T23:30:00-02:00')), reference);
  assert.equal(utcDay(new Date('2026-10-23T23:59:59.999Z')), reference);
  assert.equal(utcDay(new Date('2026-10-24T00:00:00.000Z')), '2026-10-24');
  assert.equal(matchesOnThisDay('2025-10-23', reference), true);
  for (const day of [null, '2025-10-22', '2025-10-24', reference, '2027-10-23']) assert.equal(matchesOnThisDay(day, reference), false);
});

test('UTC day watcher schedules midnight, refreshes on foreground and ignores callbacks after disposal', () => {
  let now = new Date('2026-10-23T23:59:59.990Z');
  const days: string[] = [], pending: { run: () => void; delay: number; cancelled: boolean }[] = [];
  const clock = watchUTCDate(day => days.push(day), () => now, (run, delay) => {
    const timer = { run, delay, cancelled: false }; pending.push(timer); return () => { timer.cancelled = true; };
  });
  assert.deepEqual(days, [reference]); assert.equal(pending[0]!.delay, 10);
  now = new Date('2026-10-24T00:00:00.000Z'); pending[0]!.run();
  assert.deepEqual(days, [reference, '2026-10-24']); assert.equal(pending[1]!.delay, 86_400_000);
  now = new Date('2026-10-25T12:00:00.000Z'); clock.refresh(); // The AppState adapter uses this same entry point.
  assert.equal(pending[1]!.cancelled, true); assert.equal(pending[2]!.delay, 43_200_000);
  clock.stop(); pending[2]!.run(); clock.refresh();
  assert.equal(pending[2]!.cancelled, true); assert.equal(days.length, 3);
});

test('SQLite and in-memory membership agree, excluding unknown/conflicting/current/future dates', async t => {
  const { store } = await library(t);
  const all = await allRows(store), matching = await allRows(store, scope);
  assert.equal(matching.length, 65);
  assert.deepEqual(matching, all.filter(row => matchesFilters(row, scope)));
  for (const id of ['unknown', 'conflict', 'timeconflict', 'current', 'future', 'before', 'after']) {
    assert.ok(all.some(row => row.id === id), `${id} still available in all dates`);
    assert.ok(!matching.some(row => row.id === id));
  }
  assert.equal(matching[0]!.id, 'm00'); assert.equal(matching[1]!.id, 'm07', 'same instant breaks ties by ID');
  assert.ok(matching.some(row => row.instant === null), 'filename dates are included');
});

test('On this day pages and fullscreen navigation share strict order and bounded queries in both directions', async t => {
  const { db, store } = await library(t);
  const all = await allRows(store, scope);
  const page = await store.chronologicalPage(keyOf(all[29]!), 30, scope);
  const sequence = new MemorySequence(page, 2, (key, direction, limit) => store.chronologicalAdjacent(key, direction, limit, scope), { batch: 7, keep: 12 });
  db.largest = 0;
  const seen = [sequence.current.id];
  while (await sequence.move('next') === 'moved') seen.push(sequence.current.id);
  assert.deepEqual(seen, all.slice(32).map(row => row.id));
  const backwards = [sequence.current.id];
  while (await sequence.move('previous') === 'moved') backwards.push(sequence.current.id);
  assert.deepEqual(backwards, all.map(row => row.id).reverse());
  assert.ok(db.largest <= 7, 'query result never exceeds the requested batch');
  assert.equal(sequence.state('previous'), 'end');
});

test('photos, videos and favourites compose with On this day without including other dates', async t => {
  const { store } = await library(t);
  for (const id of ['m00', 'm01', 'm07', 'current', 'after']) await store.setFavorite(id, true);
  const all = await allRows(store);
  for (const media of ['all', 'photos', 'videos'] as const) for (const favorites of [false, true]) {
    const filters = { ...scope, media, favorites };
    assert.deepEqual(await allRows(store, filters), all.filter(row => matchesFilters(row, filters)));
  }
  assert.deepEqual((await allRows(store, { ...scope, favorites: true, media: 'videos' })).map(row => row.id), ['m00']);
});

test('February 29 matches only earlier leap days, without February 28 or current-year fallback', async t => {
  const { store } = await library(t);
  const leap = await allRows(store, { ...scope, onThisDay: '2028-02-29' });
  assert.deepEqual(leap.map(row => row.id), ['leap-old', 'leap-older']);
  const ordinary = await allRows(store, { ...scope, onThisDay: '2026-02-28' });
  assert.deepEqual(ordinary.map(row => row.id), ['feb28']);
});

test('invalid reference and mixed date scopes are refused before querying', async t => {
  const { store } = await library(t);
  for (const filters of [{ ...scope, onThisDay: '2026-02-30' }, { ...scope, month: '2025-10' }]) {
    await assert.rejects(store.chronologicalPage(null, 30, filters), /invalid-import-state/);
    await assert.rejects(store.chronologicalAdjacent({ id: 'x', day: '', time: '' }, 'next', 7, filters), /invalid-import-state/);
  }
});

test('late favourite removals and additions during an On this day read keep membership and pagination', async t => {
  const { store } = await library(t);
  await store.setFavorite('m00', true); await store.setFavorite('m01', true);
  let release: () => void = () => {}, hold = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const grid = new LibraryGrid<ChronologicalRow>(async (cursor, filters) => {
    const page = await store.chronologicalPage(cursor, 31, filters);
    if (hold) { hold = false; await gate; }
    return page;
  });
  await grid.setFilters({ ...scope, favorites: true });
  const rows = grid.rows;
  const sequence = new MemorySequence(rows, 0, (key, direction, limit) => store.chronologicalAdjacent(key, direction, limit, grid.filters));
  // Keep the departing sequence pointer stale, exactly as a save completing before the closing render can see it.
  const writes = new FavoriteWrites((id, favorite) => store.setFavorite(id, favorite), favoriteSavedHandler(grid, () => sequence));
  await grid.extendFeedTo(sequence.current);
  hold = true; const reading = grid.retry();
  await writes.toggle('m00', true); await writes.toggle('m02', false);
  release(); await reading;
  assert.deepEqual(grid.rows.map(row => row.id).sort(), ['m01', 'm02']);
  assert.equal(grid.hasNext, false); assert.equal(grid.filters.onThisDay, reference);
});

test('UTC rollover refreshes history and ignores the old read; fullscreen keeps its captured scope until Back', async t => {
  const { store } = await library(t);
  const grid = gridFor(store);
  await grid.setFilters(scope); await grid.nextPage();
  assert.equal(grid.history.length, 1);
  const captured = grid.filters;
  const sequence = new MemorySequence(grid.rows, 0, (key, direction, limit) => store.chronologicalAdjacent(key, direction, limit, captured));
  let viewerOpen = true, now = new Date('2026-10-24T00:00:00.000Z');
  const clock = watchUTCDate(day => { if (!viewerOpen) void grid.refreshDay(day); }, () => now, () => () => {});
  assert.equal(grid.filters.onThisDay, reference, 'same guard as LibraryBrowser: no refresh while fullscreen');
  assert.ok(matchesFilters(sequence.current, captured));
  viewerOpen = false;
  await (grid.refreshDay(utcDay(now)) ?? grid.extendFeedTo(sequence.current));
  assert.deepEqual(grid.rows.map(row => row.id), ['after']);
  assert.equal(grid.cursor, null); assert.deepEqual(grid.history, []);
  assert.equal(grid.filters.onThisDay, '2026-10-24');
  assert.equal(grid.refreshDay('2026-10-24'), null, 'same date does not query again');
  assert.equal(captured.onThisDay, reference, 'the old sequence snapshot is immutable');
  now = new Date('2026-10-25T00:00:00.000Z'); clock.refresh(); await tick(); await tick();
  assert.equal(grid.rows.length, 0); assert.equal(grid.loading, false, 'empty new day has a normal empty state');
  clock.stop();
  await grid.setFilters({ ...grid.filters, onThisDay: '', month: '' });
  assert.equal(grid.refreshDay('2026-10-26'), null, 'all dates does not follow the daily scope');
  assert.ok(grid.rows.some(row => row.id === 'future'), 'all dates includes memories excluded from the daily scope');
  assert.equal(grid.rows.length, 30); assert.equal(grid.hasNext, true);
});

test('a day change supersedes held results while retaining media and favourite filters', async t => {
  const { store } = await library(t);
  await store.setFavorite('m01', true); await store.setFavorite('after', true);
  let release: () => void = () => {}, hold = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const grid = new LibraryGrid<ChronologicalRow>(async (cursor, filters) => {
    const page = await store.chronologicalPage(cursor, 31, filters);
    if (hold) { hold = false; await gate; }
    return page;
  });
  await grid.setFilters({ ...scope, media: 'photos', favorites: true });
  hold = true; const old = grid.retry(); await tick();
  await grid.refreshDay('2026-10-24'); release(); await old;
  assert.deepEqual(grid.rows.map(row => row.id), ['after']);
  assert.equal(grid.filters.media, 'photos'); assert.equal(grid.filters.favorites, true);
});

test('On this day wording names the UTC reference, previous years and an explicit date-scope exit', () => {
  assert.match(en.onThisDayScope(reference), /2026-10-23 \(UTC\).*Previous years/);
  assert.ok(en.filterChips('videos', true, '', reference).some(chip => chip.includes(reference)));
  assert.match(en.onThisDayEmpty, /previous years/);
  assert.equal(en.onThisDayAllDates, 'Show all dates');
});
