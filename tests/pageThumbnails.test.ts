import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pageThumbnails } from '../src/storage/pageThumbnails.ts';
import type { LibraryRow, LibraryObject } from '../src/storage/importStore.ts';
const row = (id: string): LibraryRow => ({ id, day: null, instant: null, dateConflict: 0, photos: 1, videos: 0, overlays: 0 });
const object = (id: string): LibraryObject => ({ role: 'photo', sha256: id, relativePath: 'unused', bytes: 10 });
test('thumbnail work is sequential, bounded to one page, and deduplicated by object', async () => {
  let calls = 0, active = 0, peak = 0; const published: string[] = [];
  await pageThumbnails(Array.from({ length: 40 }, (_, i) => row(String(i))), { objects: async id => [object(String(Math.floor(Number(id) / 2)))] }, async () => {
    calls++; active++; peak = Math.max(peak, active); await Promise.resolve(); active--; return 'file:///cache';
  }, () => false, id => published.push(id));
  assert.equal(calls, 15); assert.equal(peak, 1); assert.equal(published.length, 30);
});
test('failed shared objects are attempted once per page and conflicts are skipped', async () => {
  let calls = 0; const published: (string | null)[] = [];
  await pageThumbnails([row('a'), row('b'), { ...row('c'), photos: 2 }], { objects: async () => [object('shared')] }, async () => { calls++; throw new Error('invalid-image'); }, () => false, (_id, uri) => published.push(uri));
  assert.equal(calls, 1); assert.deepEqual(published, [null, null, null]);
});
test('leaving a page stops publication and subsequent decoding', async () => {
  let stop = false, calls = 0, publications = 0;
  await pageThumbnails([row('a'), row('b')], { objects: async id => [object(id)] }, async () => { calls++; stop = true; return 'file:///cache'; }, () => stop, () => publications++);
  assert.equal(calls, 1); assert.equal(publications, 0);
});
test('preview identities include the unique overlay and ambiguous overlays are never chosen', async () => {
  const base = object('shared'), layers = [ { ...object('layer-a'), role: 'overlay' as const }, { ...object('layer-b'), role: 'overlay' as const } ];
  const seen: string[] = [];
  await pageThumbnails([{ ...row('a'), overlays: 1 }, { ...row('b'), overlays: 1 }, { ...row('c'), overlays: 2 }],
    { objects: async id => [base, ...id === 'a' ? [layers[0]!] : id === 'b' ? [layers[1]!] : layers] },
    async (_base, _video, overlay) => { seen.push(overlay?.sha256 ?? 'none'); return 'file://preview'; }, () => false, () => {});
  assert.deepEqual(seen, ['layer-a', 'layer-b', 'none']);
});
