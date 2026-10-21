import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FavoriteWrites, favoriteButtonState } from '../src/domain/favoriteWrites.ts';
import { MemorySequence } from '../src/domain/memoryNavigation.ts';
import type { ChronologicalRow } from '../src/storage/importStore.ts';
import { en } from '../src/i18n/en.ts';

const row = (id: string, favorite = 0): ChronologicalRow => ({ id, day: '2026-01-01', instant: null, dateConflict: 0, photos: 1, videos: 0, overlays: 0, favorite, sortDay: '2026-01-01', sortTime: '' });
/** A save that finishes only when released, recording every write. */
function delayedStore() {
  const writes: [string, boolean][] = []; const waiting: (() => void)[] = [];
  return { writes, release: () => waiting.shift()?.(), save: (id: string, favorite: boolean) => { writes.push([id, favorite]); return new Promise<void>(resolve => waiting.push(resolve)); } };
}
/** What the viewer's button shows for the open memory, from the same inputs MemoryPager passes. */
const button = (sequence: MemorySequence<ChronologicalRow>, writes: FavoriteWrites) => favoriteButtonState(sequence.current.favorite === 1, writes.isPending(sequence.current.id));

test('favourite A, move to B and back before the save finishes: the button follows the saved state', async () => {
  const store = delayedStore();
  const sequence = new MemorySequence([row('a'), row('b')], 0, async () => [], { batch: 5, keep: 10 });
  // As LibraryBrowser wires it: a saved write updates the loaded row.
  const writes = new FavoriteWrites(store.save, (id, favorite) => { const loaded = sequence.row(id); if (loaded) sequence.update({ ...loaded, favorite: favorite ? 1 : 0 }, true); });
  assert.deepEqual(button(sequence, writes), { icon: 'heart-outline', label: en.favoriteAdd, disabled: false });
  const saving = writes.toggle('a', false);
  assert.deepEqual(button(sequence, writes), { icon: 'heart-outline', label: en.favoriteSaving, disabled: true }, 'not filled until saved');
  await sequence.move('next'); await sequence.move('previous'); // Revisit A while the save is pending.
  assert.equal(sequence.current.id, 'a');
  assert.deepEqual(button(sequence, writes), { icon: 'heart-outline', label: en.favoriteSaving, disabled: true }, 'the revisit sees the pending write');
  await writes.toggle('a', false); // A tap during the pending write is ignored: no second write.
  assert.deepEqual(store.writes, [['a', true]]);
  store.release(); await saving;
  assert.deepEqual(button(sequence, writes), { icon: 'heart', label: en.favoriteRemove, disabled: false }, 'filled once saved');
  // The next toggle starts from the saved state and removes it.
  const removing = writes.toggle('a', sequence.current.favorite === 1);
  assert.deepEqual(store.writes, [['a', true], ['a', false]]);
  store.release(); await removing;
  assert.deepEqual(button(sequence, writes), { icon: 'heart-outline', label: en.favoriteAdd, disabled: false });
});

test('a failed save is reported for that memory only, keeps the saved state and can be retried', async () => {
  let fail = true; const calls: [string, boolean][] = [];
  const saved: [string, boolean][] = [];
  const writes = new FavoriteWrites(async (id, favorite) => { calls.push([id, favorite]); if (fail) throw new Error('db'); }, (id, favorite) => saved.push([id, favorite]));
  let changes = 0; writes.subscribe(() => changes++);
  await writes.toggle('a', false);
  assert.equal(writes.hasFailed('a'), true); assert.equal(writes.hasFailed('b'), false); assert.equal(writes.isPending('a'), false);
  assert.deepEqual(saved, []); assert.ok(changes >= 2);
  fail = false; await writes.toggle('a', false);
  assert.equal(writes.hasFailed('a'), false); assert.deepEqual(saved, [['a', true]]); assert.deepEqual(calls, [['a', true], ['a', true]]);
});
