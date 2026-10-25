// Host-adapter integration tests for the library browser's state: they wire LibraryGrid, FavoriteWrites,
// favoriteSavedHandler and MemorySequence exactly as LibraryBrowser does, over real SQLite, and hold page reads and
// saves back to recreate the timings. No React renderer is involved; device checks are listed in section-25.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { ImportStore, type ChronologicalRow, type Receipt } from '../src/storage/importStore.ts';
import { inventoryFromSnapshot } from '../src/import/sourceInventory.ts';
import { LibraryGrid, favoriteSavedHandler } from '../src/domain/libraryGrid.ts';
import { FavoriteWrites } from '../src/domain/favoriteWrites.ts';
import { MemorySequence, keyOf } from '../src/domain/memoryNavigation.ts';
import { emptyPageFallback, patchFavorites } from '../src/domain/gridReturn.ts';
import type { LibraryFilters } from '../src/domain/libraryFilters.ts';
import type { SqlDatabase, SqlConnection } from '../src/storage/previewStore.ts';

class DB implements SqlDatabase {
  raw = new DatabaseSync(':memory:');
  async execAsync(sql: string) { this.raw.exec(sql); }
  async runAsync(sql: string, ...p: (string | number | null)[]) { this.raw.prepare(sql).run(...p); }
  async getFirstAsync<T>(sql: string, ...p: (string | number | null)[]) { return (this.raw.prepare(sql).get(...p) as T | undefined) ?? null; }
  async getAllAsync<T>(sql: string, ...p: (string | number | null)[]) { return this.raw.prepare(sql).all(...p) as T[]; }
  async withExclusiveTransactionAsync(work: (tx: SqlConnection) => Promise<void>) { this.raw.exec('BEGIN IMMEDIATE'); try { await work(this); this.raw.exec('COMMIT'); } catch (e) { this.raw.exec('ROLLBACK'); throw e; } }
}
const receipt = (content: string): Receipt => {
  const sha256 = createHash('sha256').update(content).digest('hex');
  return { sha256, relativePath: `objects/${sha256.slice(0, 2)}/${sha256}`, bytes: content.length };
};
const all: LibraryFilters = { media: 'all', favorites: false, month: '' };
const favourites: LibraryFilters = { media: 'all', favorites: true, month: '' };
const id = (i: number) => `f${String(i).padStart(2, '0')}`;
const tick = () => new Promise(resolve => setImmediate(resolve));

/** A gate: the next `hold` calls wait until released, one per release; a release that comes first is kept. */
function gate() {
  const waiting: (() => void)[] = []; let holding = 0, early = 0;
  return {
    hold(count = 1) { holding += count; },
    release: async () => { const next = waiting.shift(); if (next) next(); else early++; for (let i = 0; i < 5; i++) await tick(); },
    pass: () => {
      if (holding === 0) return Promise.resolve();
      holding--;
      if (early > 0) { early--; return Promise.resolve(); }
      return new Promise<void>(resolve => waiting.push(resolve));
    },
  };
}

/** 35 memories, newest first f00 … f34; the first 31 are favourites (Favourites filter: 30 + 1). The browser's wiring:
 * page reads run their SQL at once (a snapshot) but may be held before returning; saves commit at once but may be
 * held before they report completion. */
async function browser(t: { after(fn: () => void): void }, count = 35) {
  const db = new DB(); t.after(() => { try { db.raw.close(); } catch {} });
  const store = new ImportStore(db); await store.initialize();
  const names = Array.from({ length: count }, (_, i) => `2026-0${8 - Math.floor(i / 28)}-${String(28 - (i % 28)).padStart(2, '0')}_${id(i)}-main.jpg`);
  const zip = 'b'.repeat(64);
  await store.plan(zip, inventoryFromSnapshot({ entries: names.map(path => ({ path })), metadataBytes: 0, visitedEntries: names.length }, 'source-1'));
  for (let i = 0; i < names.length; i++) await store.commit(zip, i, receipt(names[i]!));
  for (let i = 0; i < 31; i++) await store.setFavorite(id(i), true);
  const reads = gate(), saves = gate();
  const grid = new LibraryGrid<ChronologicalRow>(
    async (cursor, filters) => { const page = await store.chronologicalPage(cursor, 31, filters); await reads.pass(); return page; },
    (key, filters) => store.chronologicalAdjacent(key, 'previous', 1, filters));
  // LibraryBrowser's `latest.current`: the sequence of the last render. Tests leave it stale on purpose.
  const latest: { sequence: MemorySequence<ChronologicalRow> | null } = { sequence: null };
  const writes = new FavoriteWrites(async (memory, favorite) => { await store.setFavorite(memory, favorite); await saves.pass(); },
    favoriteSavedHandler(grid, () => latest.sequence));
  const open = (memory: string) => {
    const rows = grid.rows, index = rows.findIndex(row => row.id === memory);
    latest.sequence = new MemorySequence(rows, index, (anchor, direction, limit) => store.chronologicalAdjacent(anchor, direction, limit, grid.filters));
    return latest.sequence;
  };
  return { store, grid, writes, reads, saves, latest, open };
}
const favouriteOf = (grid: LibraryGrid<ChronologicalRow>, memory: string) => grid.rows.find(row => row.id === memory)?.favorite;

test('returning after 17 viewer moves beyond the loaded feed keeps all earlier and later memories reachable', async t => {
  const { grid, open } = await browser(t, 70); await grid.load();
  const sequence = open('f25');
  for (let i = 0; i < 17; i++) assert.equal(await sequence.move('next'), 'moved');
  assert.equal(sequence.current.id, 'f42'); assert.equal(grid.feedRows.length, 30);
  await grid.extendFeedTo(sequence.current);
  assert.equal(grid.feedRows[0]?.id, 'f00'); assert.ok(grid.feedRows.some(row => row.id === 'f42'));
  assert.deepEqual(grid.feedRows.map(row => row.id), Array.from({ length: 60 }, (_, i) => id(i)));
  await grid.nextPage();
  assert.deepEqual(grid.feedRows.map(row => row.id), Array.from({ length: 70 }, (_, i) => id(i)));
});

test('a held scrolling-feed extension keeps favourite/deletion patches and yields to a filter change', async t => {
  const { grid, store, reads } = await browser(t, 70); await grid.load();
  const target = (await store.chronologicalPage(null, 70))[42]!;
  reads.hold(); const extending = grid.extendFeedTo(target);
  await store.deleteMemory('f00'); grid.memoryDeleted('f00');
  await store.setFavorite('f01', false); grid.favoriteSaved('f01', false);
  await reads.release(); await extending;
  assert.ok(!grid.feedRows.some(row => row.id === 'f00')); assert.equal(grid.feedRows.find(row => row.id === 'f01')?.favorite, 0);
  await grid.refresh(); reads.hold(); const stale = grid.extendFeedTo(target);
  const july = { ...all, month: '2026-07' }; await grid.setFilters(july);
  const before = grid.feedRows.map(row => row.id);
  await reads.release(); await stale;
  assert.deepEqual(grid.filters, july); assert.deepEqual(grid.feedRows.map(row => row.id), before);
});

test('returning from a very distant or deleted viewer anchor adds at most four pages; scrolling can continue', async () => {
  const rows = Array.from({ length: 500 }, (_, i) => ({ id: String(i).padStart(4, '0'), sortDay: '', sortTime: '', day: null, dateConflict: 0, photos: 1, videos: 0, favorite: 0 }));
  let reads = 0;
  const grid = new LibraryGrid(async cursor => { reads++; const from = cursor ? rows.findIndex(row => row.id === cursor.id) + 1 : 0; return rows.slice(from, from + 31); }, async () => []);
  await grid.load(); await grid.extendFeedTo(rows.at(-1)!);
  assert.equal(reads, 5); assert.equal(grid.feedRows.length, 150); assert.equal(grid.feedRows[0]?.id, '0000');
  await grid.nextPage(); assert.equal(grid.feedRows.length, 180);
});

test('the scrolling feed appends pages once, patches older favourites and removes deleted rows during held reads', async t => {
  const { store, grid, reads } = await browser(t);
  await grid.load(); assert.equal(grid.feedRows.length, 30);
  reads.hold(); const next = grid.nextPage();
  await store.deleteMemory('f00'); grid.memoryDeleted('f00');
  grid.favoriteSaved('f01', false);
  await reads.release(); await next;
  assert.equal(grid.feedRows.length, 34); assert.equal(new Set(grid.feedRows.map(row => row.id)).size, 34);
  assert.equal(grid.feedRows.find(row => row.id === 'f01')?.favorite, 0);
  assert.ok(!grid.feedRows.some(row => row.id === 'f00'));
  await grid.previousPage(); assert.equal(new Set(grid.feedRows.map(row => row.id)).size, grid.feedRows.length);
});
test('a full refresh discards cached pages and deletion masks, so explicitly restored memories can reappear', async t => {
  const { grid } = await browser(t); await grid.load(); await grid.nextPage();
  grid.memoryDeleted('f00'); assert.ok(!grid.feedRows.some(row => row.id === 'f00'));
  await grid.refresh();
  assert.equal(grid.feedRows.length, 30); assert.equal(grid.feedRows[0]?.id, 'f00'); assert.equal(grid.cursor, null);
});

test('a save that completes after the viewer closed, before the browser renders again, still reaches the grid', async t => {
  for (const filters of [all, favourites]) {
    const { grid, writes, saves, latest, open } = await browser(t);
    await grid.setFilters(filters);
    open('f00');
    saves.hold();
    const saving = writes.toggle('f00', true);            // Unfavourite A; the save is held.
    assert.equal(await grid.closedViewer(latest.sequence!.current), 'kept'); // Viewer closed …
    // … but no render yet: latest.sequence still points at the departing sequence.
    assert.ok(latest.sequence);
    await saves.release(); await saving;
    if (filters.favorites) assert.ok(!grid.rows.some(row => row.id === 'f00'), 'gone from Favourites');
    else assert.equal(favouriteOf(grid, 'f00'), 0, 'heart cleared');
    assert.equal(latest.sequence!.row('f00')?.favorite, 0, 'the departing sequence was updated as well, harmlessly');
  }
});

test('a page read that started before a save finished cannot bring back the old favourite state', async t => {
  for (const filters of [all, favourites]) {
    const { store, grid, writes, reads } = await browser(t);
    await grid.setFilters(filters);
    reads.hold();
    const loading = grid.retry();                          // Its SQL runs now: f01 is still a favourite.
    assert.equal(grid.loading, true); assert.equal(grid.rows.length, 0, 'rows are cleared while loading');
    await writes.toggle('f01', true);                      // The removal commits and completes meanwhile.
    assert.equal((await store.chronologicalPage(null, 31, favourites)).some(row => row.id === 'f01'), false, 'persisted');
    await reads.release(); await loading;                  // The older response arrives.
    if (filters.favorites) assert.ok(!grid.rows.some(row => row.id === 'f01'));
    else assert.equal(favouriteOf(grid, 'f01'), 0);
    // Favourites: the read was taken again after the save, so the page is full again (f30 moved up) and has no next.
    assert.equal(grid.rows.length, 30);
    assert.equal(grid.hasNext, !filters.favorites);
    if (filters.favorites) assert.equal(grid.rows[29]!.id, 'f30');
  }
});

test('a held response made empty by saves is read again: an emptied later page steps back with history and filters', async t => {
  const { grid, writes, reads } = await browser(t);
  await grid.setFilters(favourites);
  await grid.nextPage();
  assert.deepEqual(grid.rows.map(row => row.id), ['f30']); assert.equal(grid.history.length, 1);
  reads.hold();
  const loading = grid.retry();                            // Snapshot: f30 is a favourite.
  await writes.toggle('f30', true);
  await reads.release(); await loading;
  assert.equal(grid.cursor, null); assert.deepEqual(grid.history, []);
  assert.deepEqual(grid.rows.map(row => row.id), Array.from({ length: 30 }, (_, i) => id(i)), 'the earlier page');
  assert.equal(grid.hasNext, false); assert.deepEqual(grid.filters, favourites);
});

test('emptying the first Favourites page in the viewer shows the later favourite after closing', async t => {
  const { grid, writes, latest, open } = await browser(t);
  await grid.setFilters(favourites);
  const sequence = open('f00');
  for (let i = 0; i < 30; i++) {
    await writes.toggle(sequence.current.id, true);
    if (i < 29) assert.equal(await sequence.move('next'), 'moved');
  }
  // The page emptied while the viewer was open: the grid read it again underneath.
  await tick(); await tick();
  assert.equal(await grid.closedViewer(latest.sequence!.current), 'jumped', 'the closed-on memory is no longer on the re-read page');
  assert.deepEqual(grid.rows.map(row => row.id), ['f30']);
  assert.equal(grid.hasNext, false); assert.deepEqual(grid.filters, favourites);
});

test('emptying a later page in the viewer steps back to the earlier page', async t => {
  const { grid, writes, latest, open } = await browser(t);
  await grid.setFilters(favourites);
  await grid.nextPage();
  const sequence = open('f30');
  await writes.toggle('f30', true); await tick(); await tick();
  assert.equal(sequence.current.id, 'f30', 'still open');
  await grid.closedViewer(latest.sequence!.current);
  assert.equal(grid.cursor, null); assert.equal(grid.rows.length, 30); assert.equal(grid.rows[0]!.id, 'f00');
});

test('pagination, history, a superseded response and returning to another page', async t => {
  const { grid, reads, open } = await browser(t);
  await grid.setFilters(all);
  assert.equal(grid.rows.length, 30); assert.equal(grid.hasNext, true);
  await grid.nextPage();
  assert.deepEqual(grid.rows.map(row => row.id), ['f30', 'f31', 'f32', 'f33', 'f34']); assert.equal(grid.history.length, 1);
  await grid.previousPage();
  assert.equal(grid.rows[0]!.id, 'f00'); assert.equal(grid.history.length, 0);
  assert.equal(await grid.nextPage().then(() => grid.history.length), 1); await grid.previousPage();
  // A read superseded by a newer one (here a filter change) is ignored when it finally returns.
  const july: LibraryFilters = { media: 'all', favorites: false, month: '2026-07' };
  reads.hold();
  const stale = grid.retry();
  await grid.setFilters(july);
  await reads.release(); await stale;
  assert.deepEqual(grid.rows.map(row => row.id), ['f28', 'f29', 'f30', 'f31', 'f32', 'f33', 'f34'], 'the older response was ignored');
  await grid.setFilters(all);
  // Close the viewer on a memory from another page: a page starts there, and Previous returns here.
  const sequence = open('f29');
  await sequence.move('next'); await sequence.move('next');
  assert.equal(sequence.current.id, 'f31');
  assert.equal(await grid.closedViewer(sequence.current), 'jumped');
  assert.equal(grid.rows[0]!.id, 'f31'); assert.equal(grid.history.length, 1);
  await grid.previousPage();
  assert.equal(grid.rows[0]!.id, 'f00');
});

test('a held read whose 30 shown rows were all removed meanwhile is read again, so the lookahead match is shown', async t => {
  const { store, grid, writes, reads } = await browser(t);
  await grid.setFilters(favourites);
  reads.hold();
  const loading = grid.retry();                            // Snapshot: f00 … f30, 31 rows (30 shown + lookahead).
  for (let i = 0; i < 30; i++) await writes.toggle(id(i), true);
  await reads.release(); await loading;
  assert.deepEqual((await store.chronologicalPage(null, 31, favourites)).map(row => row.id), ['f30']);
  assert.deepEqual(grid.rows.map(row => row.id), ['f30'], 'the surviving match is shown, not an empty page');
  assert.equal(grid.hasNext, false); assert.equal(grid.cursor, null); assert.deepEqual(grid.history, []);
});

test('a Favourites read taken before a favourite was added is read again and includes it', async t => {
  const { store, grid, writes, reads } = await browser(t);
  await store.setFavorite('f00', false);
  await grid.setFilters(all);
  reads.hold();
  const saving = writes.toggle('f00', false);              // Favourite f00 …
  const loading = grid.setFilters(favourites);            // … while a Favourites read excluding it is in flight.
  await saving;
  await reads.release(); await loading;
  const persisted = await store.chronologicalPage(null, 31, favourites);
  assert.equal(persisted[0]?.id, 'f00');
  assert.deepEqual(grid.rows.map(row => row.id), persisted.slice(0, 30).map(row => row.id), 'same rows as the library now has');
  assert.equal(grid.hasNext, persisted.length > 30, 'pagination from the fresh read');
  assert.deepEqual(grid.filters, favourites); assert.deepEqual(grid.history, []);
});

test('an initially empty Favourites result picks up a favourite added during the read, or after it', async t => {
  const { store, grid, writes, reads } = await browser(t);
  for (let i = 0; i < 31; i++) await store.setFavorite(id(i), false);
  await grid.setFilters(favourites);
  assert.equal(grid.rows.length, 0);
  reads.hold();
  const loading = grid.retry();                            // Snapshot: no favourites.
  await writes.toggle('f05', false);
  await reads.release(); await loading;
  assert.deepEqual(grid.rows.map(row => row.id), ['f05']);
  // Shown (not loading): a save adding a member the page lacks reads the page again.
  await writes.toggle('f02', false); await tick(); await tick();
  assert.deepEqual(grid.rows.map(row => row.id), ['f02', 'f05']);
  // Removing and re-adding a member that is shown keeps it.
  await writes.toggle('f02', true); await tick(); await tick();
  assert.deepEqual(grid.rows.map(row => row.id), ['f05']);
  await writes.toggle('f02', false); await tick(); await tick();
  assert.deepEqual(grid.rows.map(row => row.id), ['f02', 'f05']);
});

test('re-reads stay bounded when saves keep completing during every read; superseded reads stay ignored', async () => {
  type Row = ChronologicalRow;
  const row = (memory: string): Row => ({ id: memory, day: '2026-01-01', instant: null, dateConflict: 0, photos: 1, videos: 0, overlays: 0, favorite: 1, sortDay: '2026-01-01', sortTime: '' });
  let reads = 0;
  const grid: LibraryGrid<Row> = new LibraryGrid<Row>(async () => { reads++; grid.favoriteSaved(`other-${reads}`, true); return [row('a')]; }, async () => []);
  grid.filters = favourites;
  await grid.load();
  assert.equal(reads, 1 + LibraryGrid.REREADS, 'one read plus the bounded re-reads');
  assert.deepEqual(grid.rows.map(r => r.id), ['a']); assert.equal(grid.loading, false);
  // With a filter where favourites cannot change membership, a save during the read needs no re-read.
  reads = 0; grid.filters = all; await grid.load();
  assert.equal(reads, 1);
});

test('patching and the empty-page fallback on their own', () => {
  const row = (memory: string, favorite: number): ChronologicalRow => ({ id: memory, day: '2026-01-01', instant: null, dateConflict: 0, photos: 1, videos: 0, overlays: 0, favorite, sortDay: '2026-01-01', sortTime: '' });
  const changes = new Map([['a', false], ['b', true]]);
  assert.deepEqual(patchFavorites([row('a', 1), row('b', 0), row('c', 1)], changes, favourites).map(r => r.id), ['b', 'c']);
  assert.deepEqual(patchFavorites([row('a', 1)], changes, all).map(r => r.favorite), [0]);
  assert.equal(emptyPageFallback(null, []), null);
  const key = keyOf(row('x', 0));
  assert.deepEqual(emptyPageFallback(key, [null, key]), { cursor: key, history: [null] });
});
