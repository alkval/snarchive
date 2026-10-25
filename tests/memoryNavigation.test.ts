import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { ImportStore, type ChronologicalRow, type Receipt } from '../src/storage/importStore.ts';
import { inventoryFromSnapshot } from '../src/import/sourceInventory.ts';
import { MemorySequence, keyOf, type Direction } from '../src/domain/memoryNavigation.ts';
import { defaultFilters, matchesFilters, type LibraryFilters } from '../src/domain/libraryFilters.ts';
import type { SqlDatabase, SqlConnection } from '../src/storage/previewStore.ts';

test('deleting the open row selects the next, then previous, then closes an empty sequence', async () => {
  const rows = ['a', 'b', 'c'].map(id => ({ id, sortDay: '', sortTime: '' }));
  const sequence = new MemorySequence(rows, 1, async () => []);
  assert.equal((await sequence.remove('b'))?.id, 'c'); assert.deepEqual(sequence.ids(), ['a', 'c']);
  assert.equal((await sequence.remove('c'))?.id, 'a'); assert.deepEqual(sequence.ids(), ['a']);
  assert.equal(await sequence.remove('a'), null); assert.deepEqual(sequence.ids(), []);
  sequence.prepare(); assert.equal(await sequence.move('next'), 'end');
});
test('deleting an edge uses its strict cursor to fetch the next surviving memory', async () => {
  const a = { id: 'a', sortDay: '', sortTime: '' }, b = { ...a, id: 'b' };
  const anchors: string[] = [];
  const sequence = new MemorySequence([a], 0, async (anchor, direction) => { anchors.push(anchor.id); return direction === 'next' && anchor.id === 'a' ? [b] : []; });
  assert.equal((await sequence.remove('a'))?.id, 'b'); assert.ok(anchors.includes('a')); assert.deepEqual(sequence.ids(), ['b']);
});

class DB implements SqlDatabase {
  raw = new DatabaseSync(':memory:'); queries = 0; largest = 0;
  async execAsync(sql: string) { this.raw.exec(sql); }
  async runAsync(sql: string, ...p: (string | number | null)[]) { this.raw.prepare(sql).run(...p); }
  async getFirstAsync<T>(sql: string, ...p: (string | number | null)[]) {
    this.queries++;
    const row = (this.raw.prepare(sql).get(...p) as T | undefined) ?? null;
    const data = (row as { data?: unknown } | null)?.data;
    if (typeof data === 'string' && data.startsWith('[')) this.largest = Math.max(this.largest, (JSON.parse(data) as unknown[]).length);
    return row;
  }
  async getAllAsync<T>(sql: string, ...p: (string | number | null)[]) { return this.raw.prepare(sql).all(...p) as T[]; }
  async withExclusiveTransactionAsync(work: (tx: SqlConnection) => Promise<void>) { this.raw.exec('BEGIN IMMEDIATE'); try { await work(this); this.raw.exec('COMMIT'); } catch (e) { this.raw.exec('ROLLBACK'); throw e; } }
}
const receipt = (content: string): Receipt => {
  const sha256 = createHash('sha256').update(content).digest('hex');
  return { sha256, relativePath: `objects/${sha256.slice(0, 2)}/${sha256}`, bytes: content.length };
};

/** 83 memories: days spread over three months with several same-day ties, every fifth a video, two with unknown
 * dates, one with competing photo variants (unsupported in the viewer, still navigable). */
async function library(t: { after(fn: () => void): void }) {
  const db = new DB(); t.after(() => { try { db.raw.close(); } catch {} });
  const store = new ImportStore(db); await store.initialize();
  const names: string[] = [];
  for (let i = 0; i < 80; i++) {
    const month = 8 + (i % 3), day = 1 + (i % 9); // Many ties on the same day, broken by ID.
    names.push(`2026-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}_m${String(i).padStart(3, '0')}-main.${i % 5 === 0 ? 'mp4' : 'jpg'}`);
  }
  names.push('2026-02-30_unknown-a-main.jpg', '2026-02-31_unknown-b-main.jpg', '2026-07-04_variants-main.jpg');
  const zip = 'a'.repeat(64);
  await store.plan(zip, inventoryFromSnapshot({ entries: names.map(path => ({ path })), metadataBytes: 0, visitedEntries: names.length }, 'source-1'));
  for (let i = 0; i < names.length; i++) await store.commit(zip, i, receipt(names[i]!));
  // A second base photo makes "variants" a memory with competing base files.
  const extra = receipt('variant-2');
  db.raw.prepare('INSERT INTO stored_objects(hash,relative_path,bytes) VALUES (?,?,?)').run(extra.sha256, extra.relativePath, extra.bytes);
  db.raw.prepare("INSERT INTO memory_objects(memory_id,role,object_hash) VALUES ('variants','photo',?)").run(extra.sha256);
  return { db, store };
}
/** The whole filtered order, read with the grid's own pages (for comparison only). */
async function everything(store: ImportStore, filters: LibraryFilters = defaultFilters): Promise<ChronologicalRow[]> {
  const out: ChronologicalRow[] = [];
  for (let cursor: ReturnType<typeof keyOf> | null = null; ;) {
    const page = await store.chronologicalPage(cursor, 30, filters);
    out.push(...page);
    if (page.length < 30) return out;
    cursor = keyOf(page[page.length - 1]!);
  }
}
const fetcher = (store: ImportStore, filters: LibraryFilters = defaultFilters) =>
  (anchor: ReturnType<typeof keyOf>, direction: Direction, limit: number) => store.chronologicalAdjacent(anchor, direction, limit, filters);
async function walk(sequence: MemorySequence<ChronologicalRow>, direction: Direction, check?: () => void): Promise<string[]> {
  const seen = [sequence.current.id];
  for (;;) {
    const result = await sequence.move(direction);
    check?.();
    if (result === 'end') return seen;
    assert.equal(result, 'moved');
    seen.push(sequence.current.id);
  }
}

test('adjacent queries follow the grid order exactly in both directions, including ties and unknown dates', async t => {
  const { store } = await library(t);
  const all = await everything(store);
  assert.equal(all.length, 83);
  assert.equal(new Set(all.map(row => row.id)).size, 83);
  for (const index of [0, 1, 29, 30, 31, 40, 81, 82]) {
    const row = all[index]!;
    assert.deepEqual((await store.chronologicalAdjacent(keyOf(row), 'next', 5)).map(r => r.id), all.slice(index + 1, index + 6).map(r => r.id), `next of ${index}`);
    assert.deepEqual((await store.chronologicalAdjacent(keyOf(row), 'previous', 5)).map(r => r.id), all.slice(Math.max(0, index - 5), index).reverse().map(r => r.id), `previous of ${index}`);
  }
  await assert.rejects(store.chronologicalAdjacent(keyOf(all[0]!), 'next', 101));
  await assert.rejects(store.chronologicalAdjacent(keyOf(all[0]!), 'sideways' as Direction, 5));
});

test('navigation crosses database pages to both ends without duplicates or gaps, with a bounded window', async t => {
  const { db, store } = await library(t);
  const all = (await everything(store)).map(row => row.id);
  // Open from the second grid page, as the grid would.
  const page = await store.chronologicalPage(keyOf((await store.chronologicalPage(null, 30))[29]!), 30);
  const options = { batch: 7, keep: 12 };
  const sequence = new MemorySequence(page, 4, fetcher(store), options);
  db.largest = 0;
  const bound = () => assert.ok(sequence.ids().length <= options.keep + options.batch, `window ${sequence.ids().length}`);
  const forward = await walk(sequence, 'next', bound);
  assert.deepEqual(forward, all.slice(34));
  assert.equal(sequence.state('next'), 'end');
  const backward = await walk(sequence, 'previous', bound);
  assert.deepEqual(backward, [...all].reverse());
  assert.equal(sequence.state('previous'), 'end');
  assert.ok(db.largest <= Math.max(options.batch, 1), `no query returned more than a batch (${db.largest})`);
  assert.ok(sequence.fetches <= Math.ceil(83 / options.batch) * 2 + 4, `fetches ${sequence.fetches}`);
});

test('filters apply to navigation: photos, videos, a month and favourites', async t => {
  const { store } = await library(t);
  for (const id of ['m003', 'm010', 'm040', 'm079']) await store.setFavorite(id, true);
  for (const filters of [
    { media: 'photos', favorites: false, month: '' }, { media: 'videos', favorites: false, month: '' },
    { media: 'all', favorites: false, month: '2026-09' }, { media: 'all', favorites: true, month: '' },
  ] satisfies LibraryFilters[]) {
    const all = await everything(store, filters);
    assert.ok(all.length > 0 && all.every(row => matchesFilters(row, filters)), JSON.stringify(filters));
    const sequence = new MemorySequence(all.slice(0, 3), 1, fetcher(store, filters), { batch: 4, keep: 8 });
    assert.deepEqual(await walk(sequence, 'next'), all.slice(1).map(row => row.id), JSON.stringify(filters));
    assert.deepEqual(await walk(sequence, 'previous'), all.map(row => row.id).reverse());
  }
});

test('first and last memories are endpoints; unsupported and video memories stay in the sequence', async t => {
  const { store } = await library(t);
  const all = await everything(store);
  const first = new MemorySequence(all.slice(0, 30), 0, fetcher(store));
  assert.equal(first.state('previous'), 'unknown');
  assert.equal(await first.move('previous'), 'end');
  assert.equal(first.state('previous'), 'end'); assert.equal(first.current.id, all[0]!.id);
  const last = new MemorySequence(all.slice(60), 22, fetcher(store));
  assert.equal(await last.move('next'), 'end'); assert.equal(last.current.id, all[82]!.id);
  const ids = all.map(row => row.id);
  assert.ok(ids.includes('variants') && ids.includes('unknown-a') && ids.includes('m000'));
  const variants = all.find(row => row.id === 'variants')!;
  assert.equal(variants.photos, 2, 'competing variants: the viewer keeps its explanation');
  assert.equal(all.find(row => row.id === 'm000')!.videos, 1);
  assert.deepEqual(ids.slice(-2), ['unknown-a', 'unknown-b'], 'unknown dates come last, by ID');
});

test('removing the open memory from favourites keeps it open, then it leaves the sequence', async t => {
  const { store } = await library(t);
  const filters: LibraryFilters = { media: 'all', favorites: true, month: '' };
  for (const id of ['m001', 'm002', 'm004', 'm005']) await store.setFavorite(id, true);
  const all = await everything(store, filters);
  const order = all.map(row => row.id);
  const sequence = new MemorySequence(all, 1, fetcher(store, filters), { batch: 2, keep: 6 });
  const open = sequence.current;
  await store.setFavorite(open.id, false);
  const updated = { ...open, favorite: 0 };
  sequence.update(updated, matchesFilters(updated, filters));
  assert.equal(sequence.current.id, open.id, 'still open');
  assert.equal(sequence.current.favorite, 0);
  assert.equal(await sequence.move('next'), 'moved');
  assert.equal(sequence.current.id, order[2]);
  assert.equal(await sequence.move('previous'), 'moved');
  assert.equal(sequence.current.id, order[0], 'the removed memory is skipped');
  assert.deepEqual(sequence.ids(), order.filter(id => id !== open.id));
  // Favouriting again before moving keeps it.
  const again = new MemorySequence(all.filter(row => row.id !== open.id), 1, fetcher(store, filters));
  const current = again.current;
  again.update({ ...current, favorite: 0 }, false); again.update({ ...current, favorite: 1 }, true);
  await again.move('next'); await again.move('previous');
  assert.equal(again.current.id, current.id);
});

test('a favourite change that completes after moving on updates or removes that loaded memory', async t => {
  const { store } = await library(t);
  const all = await everything(store);
  const sequence = new MemorySequence(all.slice(0, 10), 3, fetcher(store));
  const left = sequence.current;
  await sequence.move('next');
  sequence.update({ ...left, favorite: 1 }, true);
  await sequence.move('previous');
  assert.equal(sequence.current.id, left.id); assert.equal(sequence.current.favorite, 1, 'navigating back shows the saved state');
  const favorites = { media: 'all', favorites: true, month: '' } satisfies LibraryFilters;
  const other = new MemorySequence(all.slice(0, 10), 5, fetcher(store, favorites));
  const before = other.ids()[4]!;
  other.update({ ...all[4]!, favorite: 0 }, false);
  assert.ok(!other.ids().includes(before)); assert.equal(other.current.id, all[5]!.id, 'open memory unchanged');
});

test('concurrent moves never skip; a failed load is reported, retried and never moves', async () => {
  const rows = (ids: string[]): ChronologicalRow[] => ids.map(id => ({ id, day: '2026-01-01', instant: null, dateConflict: 0, photos: 1, videos: 0, overlays: 0, favorite: 0, sortDay: '2026-01-01', sortTime: '' }));
  let fail = true; const requests: { anchor: string; direction: Direction }[] = [];
  let release: () => void = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  const sequence = new MemorySequence(rows(['a', 'b']), 1, async (anchor, direction, limit) => {
    requests.push({ anchor: anchor.id, direction });
    await gate;
    if (fail) { fail = false; throw new Error('db'); }
    return rows(['c', 'd', 'e']).slice(0, limit);
  }, { batch: 3, keep: 10 });
  const one = sequence.move('next'), two = sequence.move('next');
  assert.equal(sequence.state('next'), 'loading');
  release();
  assert.deepEqual(await Promise.all([one, two]), ['error', 'error']);
  assert.equal(sequence.current.id, 'b'); assert.equal(sequence.state('next'), 'error');
  assert.equal(requests.length, 1, 'one request for both moves');
  const three = sequence.move('next'), four = sequence.move('next');
  assert.deepEqual(await Promise.all([three, four]), ['moved', 'stale']);
  assert.equal(sequence.current.id, 'c', 'one step, not two');
});

test('a batch that arrives after its edge changed is dropped, and the waiting move reports stale', async () => {
  const base = (id: string): ChronologicalRow => ({ id, day: '2026-01-01', instant: null, dateConflict: 0, photos: 1, videos: 0, overlays: 0, favorite: 1, sortDay: '2026-01-01', sortTime: '' });
  let release: () => void = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  const sequence = new MemorySequence([base('a'), base('b')], 1, async (_anchor, direction) => { await gate; return direction === 'next' ? [base('x')] : []; }, { batch: 5, keep: 10 });
  const forward = sequence.move('next'); // Loads after b.
  assert.equal(await sequence.move('previous'), 'moved'); // Meanwhile the user goes back to a.
  sequence.update(base('b'), false); // b leaves (e.g. unfavourited elsewhere), so the load's edge is gone.
  release();
  assert.equal(await forward, 'stale');
  assert.deepEqual(sequence.ids(), ['a'], 'the late batch was not attached to another edge');
  assert.equal(sequence.current.id, 'a');
});

test('a pending move is stale after the user moved away and back to the same memory (B → A → B)', async () => {
  const row = (id: string): ChronologicalRow => ({ id, day: '2026-01-01', instant: null, dateConflict: 0, photos: 1, videos: 0, overlays: 0, favorite: 0, sortDay: '2026-01-01', sortTime: '' });
  let release: () => void = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  const sequence = new MemorySequence([row('a'), row('b')], 1, async (_anchor, direction) => { await gate; return direction === 'next' ? [row('c'), row('d')] : []; }, { batch: 5, keep: 10 });
  const pending = sequence.move('next'); // From B; C is not loaded, so this waits.
  assert.equal(await sequence.move('previous'), 'moved'); // B → A (loaded).
  assert.equal(await sequence.move('next'), 'moved'); // A → B (loaded): the same memory as before.
  assert.equal(sequence.current.id, 'b');
  release();
  assert.equal(await pending, 'stale', 'the old Next must not advance from the revisited B');
  assert.equal(sequence.current.id, 'b');
  assert.deepEqual(sequence.ids(), ['a', 'b', 'c', 'd'], 'the shared load still filled the window');
  assert.equal(await sequence.move('next'), 'moved'); assert.equal(sequence.current.id, 'c');
});
