import { test } from 'node:test';
import assert from 'node:assert/strict';
import { monthAtFraction, monthFraction, monthTitle } from '../src/domain/monthScroll.ts';
import { LibraryDB } from './helpers/libraryDb.ts';
import { ImportStore } from '../src/storage/importStore.ts';
import { LibraryGrid } from '../src/domain/libraryGrid.ts';
import { inventoryFromSnapshot } from '../src/import/sourceInventory.ts';
import { defaultFilters } from '../src/domain/libraryFilters.ts';

test('month drag positions are weighted, clamped and include undated memories', () => {
  const months = [{ month: '2026-10', count: 80 }, { month: '2025-01', count: 10 }, { month: '', count: 10 }];
  assert.equal(monthAtFraction(months, -1), 0); assert.equal(monthAtFraction(months, .79), 0);
  assert.equal(monthAtFraction(months, .8), 1); assert.equal(monthAtFraction(months, 2), 2);
  assert.equal(monthAtFraction([], .5), -1); assert.equal(monthFraction(months, '2025-01'), .8);
  assert.equal(monthFraction(months, ''), 1); assert.equal(monthTitle(''), 'Unknown dates');
  assert.match(monthTitle('2025-01'), /2025/);
});
test('month index agrees with chronological grid membership under all date/media/favourite filters', async t => {
  const db = new LibraryDB(); t.after(() => db.raw.close()); const store = new ImportStore(db); await store.initialize();
  const names = ['2026-10-10_a-main.jpg', '2025-01-02_b-main.mp4', '2024-02-03_c-main.jpg', '2020-01-01_unknown-main.jpg', '2023-01-01_d-main.jpg', '2022-01-01_d-main.jpeg'];
  const source = inventoryFromSnapshot({ entries: names.map(path => ({ path })), visitedEntries: names.length, metadataBytes: 0 }, 'source-1');
  await store.plan('a'.repeat(64), source);
  for (let i = 0; i < names.length; i++) { const hash = String(i + 1).repeat(64); await store.commit('a'.repeat(64), i, { sha256: hash, bytes: 1, relativePath: `objects/${hash.slice(0, 2)}/${hash}` }); }
  await db.runAsync("DELETE FROM library_dates WHERE memory_id='unknown'");
  await store.setFavorite('b', true);
  for (const filters of [defaultFilters, { ...defaultFilters, media: 'photos' as const }, { ...defaultFilters, media: 'videos' as const },
    { ...defaultFilters, favorites: true }, { ...defaultFilters, month: '2024-02' }, { ...defaultFilters, onThisDay: '2026-01-02' }]) {
    const rows = await store.chronologicalPage(null, 100, filters), actual = await store.chronologicalMonths(filters);
    const groups = new Map<string, number>();
    for (const row of rows) { const month = row.sortDay.slice(0, 7); groups.set(month, (groups.get(month) ?? 0) + 1); }
    assert.deepEqual(actual.map(row => [row.month, row.count]), [...groups.entries()]);
  }
});
test('timeline jumps query the selected month, keep filters and patches, and yield to newer requests', async () => {
  const rows = ['2026-10-20', '2026-10-01', '2025-03-20', '2025-03-01', ''].map((day, i) =>
    ({ id: String(i), sortDay: day, sortTime: '', day: day || null, dateConflict: 0, photos: 1, videos: 0, favorite: 0 }));
  let release: (() => void) | null = null, hold = false;
  const grid = new LibraryGrid(async cursor => {
    const result = rows.filter(row => !cursor || row.sortDay < cursor.day || row.sortDay === cursor.day && row.id > cursor.id);
    if (hold) { hold = false; await new Promise<void>(resolve => { release = resolve; }); } return result;
  });
  await grid.load(); grid.favoriteSaved('2', true);
  assert.equal(await grid.jumpToMonth('2025-03'), true); assert.equal(grid.feedRows[0]?.id, '2'); assert.equal(grid.feedRows[0]?.favorite, 1);
  assert.equal(grid.jumped, true); assert.deepEqual(grid.filters, defaultFilters);
  hold = true; const pending = grid.jumpToMonth('2026-10'); await grid.jumpToMonth('');
  (release as (() => void) | null)?.(); assert.equal(await pending, false);
  assert.deepEqual(grid.feedRows.map(row => row.id), ['4']);
  await grid.refresh(); assert.equal(grid.jumped, false); assert.equal(grid.feedRows[0]?.id, '0');
});

test('date gutter ignores taps, jitter and horizontal drags; only vertical movement claims a jump', async () => {
  const { monthDragStarts } = await import('../src/domain/monthScroll.ts');
  for (const [dx, dy] of [[0, 0], [0, 7], [4, 5], [30, 15], [-30, -15]]) assert.equal(monthDragStarts(dx!, dy!), false);
  assert.equal(monthDragStarts(0, 8), true); assert.equal(monthDragStarts(4, -20), true);
  assert.equal(monthDragStarts(30, 0), false, 'a drag ending back at its origin does not select');
});
test('unobserved dates start at newest without impersonating the unknown-date bucket or skipping a month', async () => {
  const { monthActionIndex } = await import('../src/domain/monthScroll.ts');
  const months = [{ month: '2026-10', count: 80 }, { month: '2025-01', count: 10 }, { month: '', count: 10 }];
  assert.equal(monthFraction(months, null), 0); assert.equal(monthFraction(months, ''), 1);
  assert.equal(monthActionIndex(months, null, true), 0); assert.equal(monthActionIndex(months, null, false), 0);
  assert.equal(monthActionIndex(months, 'missing', true), 0);
  assert.equal(monthActionIndex(months, '2026-10', true), 1);
  assert.equal(monthActionIndex(months, '', false), 1); assert.equal(monthActionIndex([], null, true), -1);
});
