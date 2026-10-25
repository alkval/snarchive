import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ViewerMediaCache } from '../src/domain/viewerMediaCache.ts';
test('adjacent media metadata reads are shared, bounded and retryable after rejection', async () => {
  const read: string[] = []; let fail = true;
  const cache = new ViewerMediaCache(async id => { read.push(id); if (id === 'fail' && fail) throw new Error('missing'); return id; }, 3);
  const first = cache.load('a'); assert.equal(cache.load('a'), first); await first;
  for (const id of ['b', 'c', 'd']) await cache.load(id);
  assert.equal(cache.peek('a'), undefined); assert.equal(cache.peek('b'), 'b');
  await assert.rejects(cache.load('fail')); fail = false; assert.equal(await cache.load('fail'), 'fail');
  assert.equal(read.filter(id => id === 'a').length, 1); assert.equal(read.filter(id => id === 'fail').length, 2);
});
test('a late evicted read cannot replace its newer entry or notify a closed subscriber', async () => {
  let resolve!: (value: string) => void, reads = 0, notices = 0;
  const cache = new ViewerMediaCache<string>(id => id === 'a' && reads++ === 0 ? new Promise(done => { resolve = done; }) : Promise.resolve(id), 1);
  const unsubscribe = cache.subscribe(() => notices++);
  const held = cache.load('a'); await Promise.resolve(); await cache.load('b'); await cache.load('a');
  const before = notices; resolve('old a'); await held;
  assert.equal(cache.peek('a'), 'a'); assert.equal(notices, before);
  unsubscribe(); await cache.load('c'); assert.equal(notices, before);
});
