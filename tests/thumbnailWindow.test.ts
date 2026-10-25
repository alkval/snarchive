import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ThumbnailWindow, visibleThumbnailRows } from '../src/domain/thumbnailWindow.ts';

const tick = () => new Promise(resolve => setImmediate(resolve));
const rows = (start: number, count: number) => Array.from({ length: count }, (_, i) => ({ id: String(start + i) }));

test('empty, header-only and stale visibility reports retain the current thumbnail window', () => {
  const feed = rows(0, 300);
  assert.equal(visibleThumbnailRows(feed, []), null);
  assert.equal(visibleThumbnailRows(feed, ['stale']), null);
  const window = visibleThumbnailRows(feed, ['150', '151', '152'])!;
  assert.equal(window[0]?.id, '141'); assert.equal(window.at(-1)?.id, '194');
  assert.ok(window.some(row => row.id === '152'));
});

test('overlapping windows reuse results and become completely idle after loading', async () => {
  const calls: string[] = []; let publications = 0;
  const cache = new ThumbnailWindow(async (row: { id: string }) => { calls.push(row.id); return `file://${row.id}`; });
  cache.subscribe(() => publications++);
  cache.setRows(rows(0, 40)); await tick();
  cache.setRows(rows(10, 40)); await tick();
  const before = publications;
  for (let i = 0; i < 20; i++) cache.setRows(rows(10, 40));
  await tick();
  assert.equal(calls.length, 50); assert.equal(new Set(calls).size, 50);
  assert.equal(publications, before); assert.equal(cache.get('20'), 'file://20');
});

test('rapid viewport changes share one worker and skip superseded queued work', async () => {
  let release!: () => void; let active = 0, peak = 0;
  const calls: string[] = [];
  const cache = new ThumbnailWindow(async (row: { id: string }) => {
    calls.push(row.id); active++; peak = Math.max(peak, active);
    if (row.id === '0') await new Promise<void>(resolve => { release = resolve; });
    active--; return `file://${row.id}`;
  });
  cache.setRows(rows(0, 30));
  cache.setRows(rows(100, 30)); cache.setRows(rows(200, 30));
  release(); await tick();
  assert.equal(peak, 1); assert.deepEqual(calls, ['0', ...rows(200, 30).map(row => row.id)]);
  assert.equal(cache.get('200'), 'file://200');
});

test('failures stay cached without a retry loop; stale image errors cannot replace newer results', async () => {
  let calls = 0;
  const cache = new ThumbnailWindow(async (_row: { id: string }) => { calls++; throw new Error('bad-image'); });
  cache.setRows([{ id: 'a' }]); await tick();
  for (let i = 0; i < 10; i++) cache.setRows([{ id: 'a' }]);
  await tick(); assert.equal(calls, 1); assert.equal(cache.get('a'), null);
  const good = new ThumbnailWindow(async (_row: { id: string }) => 'file://new');
  good.setRows([{ id: 'a' }]); await tick();
  good.failed('a', 'file://old'); assert.equal(good.get('a'), 'file://new');
  good.failed('a', 'file://new'); assert.equal(good.get('a'), null);
});

test('an explicit refresh discards in-flight results without starting a second worker', async () => {
  let release!: () => void, calls = 0;
  const cache = new ThumbnailWindow(async (_row: { id: string }) => {
    calls++; if (calls === 1) { await new Promise<void>(resolve => { release = resolve; }); return 'file://old'; }
    return 'file://new';
  });
  cache.setRows([{ id: 'a' }]); cache.reset(); release(); await tick();
  assert.equal(calls, 2); assert.equal(cache.get('a'), 'file://new');
});

test('bounded cache pins the visible window; pause and resume retain successful thumbnails', async () => {
  let calls = 0;
  const cache = new ThumbnailWindow(async (row: { id: string }) => { calls++; return `file://${row.id}`; }, 60);
  cache.setRows(rows(0, 60)); await tick(); cache.setRows(rows(30, 60)); await tick();
  for (const row of rows(30, 60)) assert.equal(cache.get(row.id), `file://${row.id}`);
  assert.equal(cache.get('0'), undefined);
  cache.setRows([]); cache.setRows(rows(30, 60)); await tick(); assert.equal(calls, 90);
});
