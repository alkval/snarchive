import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BenchmarkDatabase, seedLibrary } from '../scripts/benchmarks/libraryFixture.ts';
import { baselineSql } from '../scripts/benchmarks/chronologicalBaseline.ts';
import { defaultFilters, type LibraryFilters } from '../src/domain/libraryFilters.ts';
import { MemorySequence, keyOf, type SequenceKey } from '../src/domain/memoryNavigation.ts';
import type { ChronologicalRow } from '../src/storage/importStore.ts';

async function fixture(t: { after(fn: () => void): void }, count = 1_100) {
  const db = new BenchmarkDatabase(); t.after(() => db.raw.close());
  return { db, store: await seedLibrary(db, count) };
}

test('large-library forward pagination equals the previous query with no skips or duplicates', async t => {
  const { db, store } = await fixture(t);
  const walk = async () => {
    const result: ChronologicalRow[] = []; let cursor: SequenceKey | null = null;
    for (;;) {
      const page = await store.chronologicalPage(cursor, 31);
      if (!page.length) break;
      result.push(...page); cursor = keyOf(page.at(-1)!);
    }
    return result;
  };
  const after = await walk(); db.queryTransform = () => baselineSql('next');
  assert.deepEqual(await walk(), after);
  assert.equal(new Set(after.map(row => row.id)).size, after.length);
  assert.equal(after.length, 990); // Only-overlay and no-base controls are excluded.
  assert.equal(db.maxReturned, 31);
});

test('reverse navigation and nonmember anchors match the baseline under every filter family', async t => {
  const { db, store } = await fixture(t);
  const filters: LibraryFilters[] = [];
  for (const media of ['all', 'photos', 'videos'] as const) for (const favorites of [false, true])
    for (const date of [{}, { month: '2020-10' }, { onThisDay: '2026-10-24' }, { onThisDay: '2028-02-29' }])
      filters.push({ ...defaultFilters, media, favorites, ...date });
  const anchors = [{ day: '2020-10-24', time: '', id: 'not-a-library-member' }, { day: '', time: '', id: 'bench-00000500' }];
  for (const filter of filters) for (const anchor of anchors) for (const direction of ['next', 'previous'] as const) {
    db.queryTransform = null;
    const result = await store.chronologicalAdjacent(anchor, direction, 20, filter);
    db.queryTransform = () => baselineSql(direction);
    assert.deepEqual(await store.chronologicalAdjacent(anchor, direction, 20, filter), result, JSON.stringify({ filter, anchor, direction }));
  }
});

test('prefilters do not promote conflicting evidence or change variants and unknown dates', async t => {
  const { db, store } = await fixture(t);
  const page = await store.chronologicalPage({ day: '', time: '', id: '' }, 100);
  assert(page.some(row => row.day === null && row.dateConflict === 0));
  assert(page.some(row => row.day !== null && row.dateConflict === 1));
  const daily = await store.chronologicalPage(null, 100, { ...defaultFilters, onThisDay: '2026-10-24' });
  assert(daily.length > 0); assert(daily.every(row => row.dateConflict === 0 && row.day?.slice(5) === '10-24' && row.day < '2026-01-01'));
  // A matching date on a conflicting memory survives the cheap EXISTS check, but must fail the exact outer check.
  db.raw.prepare("INSERT INTO library_dates VALUES('bench-00000010','date-only','2021-10-24','2021-10-24')").run();
  assert(!(await store.chronologicalPage(null, 100, { ...defaultFilters, onThisDay: '2026-10-24' })).some(row => row.id === 'bench-00000010'));
  const variants = await store.chronologicalPage(null, 100, { ...defaultFilters, media: 'videos' });
  assert(variants.some(row => row.photos > 0 && row.videos > 0));
});

test('favourite writes and later date evidence are reflected immediately without a cached projection', async t => {
  const { db, store } = await fixture(t);
  await store.setFavorite('bench-00000010', true);
  const filter = { ...defaultFilters, favorites: true, onThisDay: '2026-10-24' };
  assert((await store.chronologicalPage(null, 100, filter)).some(row => row.id === 'bench-00000010'));
  await store.setFavorite('bench-00000010', false);
  assert(!(await store.chronologicalPage(null, 100, filter)).some(row => row.id === 'bench-00000010'));
  db.raw.prepare("INSERT INTO library_dates VALUES('bench-00000010','instant','2020-10-24T23:00:00.000Z','2020-10-24')").run();
  assert(!(await store.chronologicalPage(null, 100, { ...defaultFilters, onThisDay: '2026-10-24' })).some(row => row.id === 'bench-00000010'));
});

test('bound IDs retain Unicode, quotes and strict ordering in both directions', async t => {
  const { db, store } = await fixture(t, 100);
  const hash = db.raw.prepare('SELECT hash FROM stored_objects LIMIT 1').get()!.hash;
  assert(typeof hash === 'string');
  for (const id of ["quote' OR 1=1--", 'éclair', '雪', '2', '10']) {
    db.raw.prepare('INSERT INTO memories VALUES(?)').run(id);
    db.raw.prepare("INSERT INTO memory_objects VALUES(?,'photo',?)").run(id, hash);
  }
  for (const direction of ['next', 'previous'] as const) {
    const anchor = { day: '', time: '', id: "quote' OR 1=1--" };
    db.queryTransform = null; const after = await store.chronologicalAdjacent(anchor, direction, 100);
    db.queryTransform = () => baselineSql(direction);
    assert.deepEqual(await store.chronologicalAdjacent(anchor, direction, 100), after);
    assert(!after.some(row => row.id === anchor.id));
  }
});

test('a 10000-memory library keeps native results and the fullscreen window bounded', async t => {
  const { db, store } = await fixture(t, 10_000);
  const rows = await store.chronologicalPage(null, 31);
  const sequence = new MemorySequence(rows.slice(0, 30), 0, (key, direction, limit) => store.chronologicalAdjacent(key, direction, limit));
  for (let i = 0; i < 180; i++) {
    assert.equal(await sequence.move('next'), 'moved');
    assert(sequence.ids().length <= 60);
  }
  for (let i = 0; i < 90; i++) { assert.equal(await sequence.move('previous'), 'moved'); assert(sequence.ids().length <= 60); }
  // prepare/move can start a final neighbouring load; await it before the test closes SQLite.
  await sequence.move('next');
  assert(db.maxReturned <= 31);
});

test('chronological reads do not write rows, change the schema or exceed the requested result limit', async t => {
  const { db, store } = await fixture(t);
  const changes = db.raw.prepare('SELECT total_changes() n').get()!.n;
  const schema = db.raw.prepare("SELECT sql FROM sqlite_master ORDER BY name").all();
  for (const limit of [1, 20, 31, 100]) assert((await store.chronologicalPage(null, limit)).length <= limit);
  await assert.rejects(store.chronologicalPage(null, 101));
  assert.equal(db.raw.prepare('SELECT total_changes() n').get()!.n, changes);
  assert.deepEqual(db.raw.prepare("SELECT sql FROM sqlite_master ORDER BY name").all(), schema);
  assert.equal(db.raw.prepare('PRAGMA user_version').get()!.user_version, 5);
});
