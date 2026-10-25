import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { LibraryDB } from './helpers/libraryDb.ts';
import { ImportStore, type ChronologicalRow } from '../src/storage/importStore.ts';
import { inventoryFromSnapshot } from '../src/import/sourceInventory.ts';
import { defaultFilters } from '../src/domain/libraryFilters.ts';
import { LibraryTimeline } from '../src/domain/libraryTimeline.ts';
import { timelineLayout, TimelinePosition } from '../src/domain/timelineLayout.ts';
import { MemorySequence } from '../src/domain/memoryNavigation.ts';
import { favoriteSavedHandler } from '../src/domain/libraryGrid.ts';
const tick = () => new Promise(resolve => setImmediate(resolve));
async function settle() { for (let i = 0; i < 12; i++) await tick(); }
async function fixture(t: { after(fn: () => void): void }, count = 90) {
  const db = new LibraryDB(); t.after(() => db.raw.close()); const store = new ImportStore(db); await store.initialize();
  const names = Array.from({ length: count }, (_, i) => `2026-${String(12 - Math.floor(i / 28)).padStart(2, '0')}-${String(28 - i % 28).padStart(2, '0')}_m${String(i).padStart(3, '0')}-main.${i % 3 ? 'jpg' : 'mp4'}`);
  const hash = 'a'.repeat(64); await store.plan(hash, inventoryFromSnapshot({ entries: names.map(path => ({ path })), visitedEntries: count, metadataBytes: 0 }, 'source-1'));
  for (let i = 0; i < count; i++) { const sha256 = createHash('sha256').update(names[i]!).digest('hex'); await store.commit(hash, i, { sha256, bytes: 1, relativePath: `objects/${sha256.slice(0, 2)}/${sha256}` }); }
  const grid = new LibraryTimeline(filters => store.chronologicalIndex(filters), ids => store.chronologicalRows(ids));
  return { db, store, grid };
}
test('whole-library position index and bounded display rows match the existing chronological query under every filter', async t => {
  const { store, db } = await fixture(t);
  await store.setFavorite('m003', true); await db.runAsync("DELETE FROM library_dates WHERE memory_id='m005'");
  await db.runAsync("INSERT INTO library_dates VALUES ('m006','day','2020-01-01','2020-01-01')");
  for (const filters of [defaultFilters, { ...defaultFilters, media: 'photos' as const }, { ...defaultFilters, media: 'videos' as const },
    { ...defaultFilters, favorites: true }, { ...defaultFilters, month: '2026-12' }, { ...defaultFilters, onThisDay: '2027-12-25' }]) {
    const index = await store.chronologicalIndex(filters), rows = await store.chronologicalPage(null, 100, filters);
    assert.deepEqual(index.map(entry => entry.id), rows.map(row => row.id));
    assert.deepEqual(index.map(entry => entry.group), rows.map(row => row.dateConflict ? 'conflict' : row.day ?? row.instant?.slice(0, 10) ?? 'unknown'));
    const facts = new Map((await store.chronologicalRows(index.map(entry => entry.id))).map(row => [row.id, row]));
    assert.deepEqual(index.map(entry => ({ ...facts.get(entry.id)! })), rows);
  }
  await assert.rejects(store.chronologicalRows(Array.from({ length: 101 }, (_, i) => String(i))), /invalid-import-state/);
});
test('one full scroll range includes newer and older neighbours after arbitrary seeks; facts stay bounded', async () => {
  const entries = Array.from({ length: 10000 }, (_, i) => ({ id: String(i), group: i < 5000 ? '2026-12-01' : '2020-01-01' }));
  const batches: number[] = [];
  const grid = new LibraryTimeline(async () => entries, async ids => { batches.push(ids.length); return ids.map(id => ({ id, favorite: 0 })); });
  await grid.load(); await settle();
  for (const at of [9000, 5000, 9999, 2000, 0]) {
    grid.show([String(at)]); await settle(); assert.equal(grid.row(String(at))?.id, String(at)); assert.ok(grid.cachedRows <= 180);
    assert.equal(grid.entries[0]?.id, '0'); assert.equal(grid.entries.at(-1)?.id, '9999');
  }
  assert.ok(batches.every(count => count <= 60)); assert.ok(batches.reduce((a, b) => a + b) < 400);
});
test('delayed index reads yield to filters and disposed browsers', async () => {
  let release!: () => void, calls = 0;
  const grid = new LibraryTimeline(async () => { if (++calls === 1) { await new Promise<void>(resolve => { release = resolve; }); return [{ id: 'old', group: '2020-01-01' }]; } return [{ id: 'new', group: '2026-01-01' }]; }, async ids => ids.map(id => ({ id, favorite: 0 })));
  const old = grid.load(); await grid.setFilters({ ...defaultFilters, media: 'videos' }); release(); await old;
  assert.deepEqual(grid.entries.map(entry => entry.id), ['new']);
  let finish!: () => void;
  const disposed = new LibraryTimeline(async () => { await new Promise<void>(resolve => { finish = resolve; }); return [{ id: 'late', group: 'unknown' }]; }, async () => []);
  const pending = disposed.load(); disposed.dispose(); finish(); await pending; assert.deepEqual(disposed.entries, []);
});
test('completed favourite saves win over held facts and held Favourites indexes, including additions to an empty result', async t => {
  const { store } = await fixture(t, 10);
  let release!: () => void, held = true;
  const grid = new LibraryTimeline(filters => store.chronologicalIndex(filters), async ids => { const rows = await store.chronologicalRows(ids); if (held) { held = false; await new Promise<void>(resolve => { release = resolve; }); } return rows; });
  await grid.load(); await settle(); await store.setFavorite('m000', true); grid.favoriteSaved('m000', true); release(); await settle();
  assert.equal(grid.row('m000')?.favorite, 1);
  await store.setFavorite('m000', false);
  let unblock!: () => void, pause = true;
  const favorites = new LibraryTimeline(async filters => { const rows = await store.chronologicalIndex(filters); if (pause) { pause = false; await new Promise<void>(resolve => { unblock = resolve; }); } return rows; }, ids => store.chronologicalRows(ids));
  const loading = favorites.setFilters({ ...defaultFilters, favorites: true }); await settle();
  await store.setFavorite('m001', true); favorites.favoriteSaved('m001', true); unblock(); await loading; await settle();
  assert.deepEqual(favorites.entries.map(entry => entry.id), ['m001']);
  await store.setFavorite('m001', false); favorites.favoriteSaved('m001', false); await settle(); assert.equal(favorites.entries.length, 0);
  await store.setFavorite('m002', true); favorites.favoriteSaved('m002', true); await settle(); assert.deepEqual(favorites.entries.map(entry => entry.id), ['m002']);
});
test('a completed save always reaches the timeline while a viewer is closed; reopened viewers fetch strict neighbours', async t => {
  const { grid, store } = await fixture(t); await grid.load(); await settle();
  const handler = favoriteSavedHandler<ChronologicalRow>(grid, () => null);
  await store.setFavorite('m000', true); handler('m000', true); assert.equal(grid.row('m000')?.favorite, 1);
  grid.show(['m070']); await settle(); const row = grid.row('m070')!;
  const sequence = new MemorySequence([row], 0, (key, direction, limit) => store.chronologicalAdjacent(key, direction, limit));
  assert.equal(await sequence.move('previous'), 'moved'); assert.equal(sequence.current.id, 'm069');
  assert.equal(await sequence.move('next'), 'moved'); assert.equal(sequence.current.id, 'm070');
});
test('deleted memories cannot return through a held fact read; failed reads remain bounded and retryable', async t => {
  const { store } = await fixture(t, 10); let release!: () => void, held = true;
  const grid = new LibraryTimeline(filters => store.chronologicalIndex(filters), async ids => { const rows = await store.chronologicalRows(ids); if (held) { held = false; await new Promise<void>(resolve => { release = resolve; }); } return rows; });
  await grid.load(); await settle(); await store.deleteMemory('m000'); grid.memoryDeleted('m000'); await settle(); release(); await settle();
  assert.ok(!grid.entries.some(entry => entry.id === 'm000')); assert.equal(grid.row('m000'), undefined);
  let reads = 0;
  const failure = new LibraryTimeline(async () => [{ id: 'one', group: 'unknown' }], async ids => { if (++reads === 1) throw Error('unreadable'); return ids.map(id => ({ id, favorite: 0 })); });
  await failure.load(); await settle(); assert.equal(reads, 1); assert.equal(failure.rowsFailed, true);
  failure.show(['one']); await settle(); assert.equal(reads, 1);
  failure.retryRows(); await settle(); assert.equal(failure.row('one')?.id, 'one'); assert.equal(failure.rowsFailed, false);
});
test('timeline geometry and the single handle share exact pixel positions, including unknown and conflicting date runs', () => {
  const entries = ['2026-12-01', '2026-12-01', '2026-12-01', '2026-12-01', '2020-01-01', 'unknown', 'conflict', 'unknown'].map((group, i) => ({ id: String(i), group }));
  const a = timelineLayout(entries, 364, 1); assert.equal(a.tile, 120);
  assert.equal(a.cells[0]?.length, 46); assert.equal(a.cells[1]?.length, 122);
  for (const cell of a.cells) { assert.equal(a.cellAt(cell.offset), cell); for (const entry of cell.entries) assert.equal(a.cells[a.byId.get(entry.id)!], cell); }
  assert.deepEqual(a.cells.flatMap(cell => cell.entries.map(entry => entry.id)), entries.map(entry => entry.id));
  assert.equal(a.total, a.cells.reduce((sum, cell) => sum + cell.length, 48));
  assert.equal(a.cellAt(1e9), a.cells.at(-1)); assert.equal(timelineLayout([], 364, 1).cellAt(0), undefined);
  const position = new TimelinePosition(); let changes = 0; position.subscribe(() => changes++);
  position.set(.0001, '2026-12-01'); assert.equal(position.fraction, .0001); assert.equal(position.month, '2026-12');
  position.set(.0001, '2026-12-01'); assert.equal(changes, 1, 'repeated positions do not publish');
  position.set(1, 'unknown'); assert.equal(position.fraction, 1); assert.equal(position.month, '');
});
test('a rapid drag queues only the latest viewport after the single in-flight display read', async () => {
  const entries = Array.from({ length: 10000 }, (_, i) => ({ id: String(i), group: 'unknown' }));
  let release!: () => void, held = true; const batches: string[][] = [];
  const grid = new LibraryTimeline(async () => entries, async ids => { batches.push([...ids]); if (held) { held = false; await new Promise<void>(resolve => { release = resolve; }); } return ids.map(id => ({ id, favorite: 0 })); });
  await grid.load(); grid.show(['9000']); grid.show(['8000']); grid.show(['1000']); release(); await settle();
  assert.equal(batches.length, 2); assert.ok(batches[1]!.includes('1000')); assert.ok(!batches.flat().includes('9000'));
});
test('a failed index can retry; Favourites index rereads stay bounded if saves keep completing', async () => {
  let fail = true;
  const grid = new LibraryTimeline(async () => { if (fail) throw Error('read-failed'); return [{ id: 'a', group: 'unknown' }]; }, async ids => ids.map(id => ({ id, favorite: 0 })));
  await grid.load(); assert.equal(grid.failed, true); fail = false; await grid.load(); assert.equal(grid.failed, false); assert.equal(grid.entries.length, 1);
  let reads = 0;
  const busy: LibraryTimeline<{ id: string; favorite: number }> = new LibraryTimeline(async () => {
    busy.favoriteSaved('a', true); reads++; return [{ id: 'a', group: 'unknown' }];
  }, async ids => ids.map(id => ({ id, favorite: 1 })));
  await busy.setFilters({ ...defaultFilters, favorites: true }); assert.equal(reads, 4); assert.equal(busy.loading, false);
});
test('scroll-anchor restoration handles the final favourite disappearing, deleted anchors, filters and rotation', async () => {
  const { restoredTimelineOffset } = await import('../src/domain/timelineLayout.ts');
  const entries = Array.from({ length: 200 }, (_, i) => ({ id: String(i), group: '2026-01-01' }));
  const layout = timelineLayout(entries, 364, 1), anchor = { id: '90', within: 25, at: 31 };
  assert.equal(restoredTimelineOffset(timelineLayout([], 364, 1), anchor, 800, 500, false), 0);
  assert.equal(restoredTimelineOffset(layout, anchor, 800, 500, true), 0);
  assert.equal(restoredTimelineOffset(layout, anchor, 800, 500, false), layout.cells[layout.byId.get('90')!]!.offset + 25);
  const removed = timelineLayout(entries.filter(row => row.id !== '90'), 364, 1);
  assert.ok(Number.isFinite(restoredTimelineOffset(removed, anchor, 800, 500, false)));
  const rotated = timelineLayout(entries, 724, 1);
  assert.equal(restoredTimelineOffset(rotated, anchor, 500, 500, false), rotated.cells[rotated.byId.get('90')!]!.offset + 25);
});
test('dragging preserves the grab point regardless of window offsets, with exact travel and endpoint clamping', async () => {
  const { draggedTimelineFraction } = await import('../src/domain/timelineLayout.ts');
  const travel = 800 - 44;
  for (const windowTop of [0, 24, 124, 400]) {
    const grabY = windowTop + .25 * travel + 30, endY = grabY + 200;
    const fraction = draggedTimelineFraction(.25, endY - grabY, 800);
    assert.equal(fraction * travel, .25 * travel + 200);
    assert.equal(windowTop + fraction * travel + 30, endY, 'finger stays at its initial point within the handle');
  }
  assert.equal(draggedTimelineFraction(.5, 0, 800), .5);
  assert.equal(draggedTimelineFraction(.5, 10000, 800), 1); assert.equal(draggedTimelineFraction(.5, -10000, 800), 0);
});
