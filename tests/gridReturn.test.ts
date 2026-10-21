import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { ImportStore, type ChronologicalRow, type LibraryCursor, type Receipt } from '../src/storage/importStore.ts';
import { inventoryFromSnapshot } from '../src/import/sourceInventory.ts';
import { emptyPageFallback, patchFavorites, returnToGrid } from '../src/domain/gridReturn.ts';
import { keyOf } from '../src/domain/memoryNavigation.ts';
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
const favourites: LibraryFilters = { media: 'all', favorites: true, month: '' };

/** 35 memories, newest first f00 … f34; the first 31 are favourites, so the Favourites filter has 30 + 1 rows. */
async function library(t: { after(fn: () => void): void }) {
  const db = new DB(); t.after(() => { try { db.raw.close(); } catch {} });
  const store = new ImportStore(db); await store.initialize();
  const names = Array.from({ length: 35 }, (_, i) => `2026-0${8 - Math.floor(i / 28)}-${String(28 - (i % 28)).padStart(2, '0')}_f${String(i).padStart(2, '0')}-main.jpg`);
  const zip = 'b'.repeat(64);
  await store.plan(zip, inventoryFromSnapshot({ entries: names.map(path => ({ path })), metadataBytes: 0, visitedEntries: names.length }, 'source-1'));
  for (let i = 0; i < names.length; i++) await store.commit(zip, i, receipt(names[i]!));
  for (let i = 0; i < 31; i++) await store.setFavorite(`f${String(i).padStart(2, '0')}`, true);
  return { store };
}
/** The grid's load step, as LibraryBrowser runs it: read 31 rows; an empty later page steps back. */
async function show(store: ImportStore, filters: LibraryFilters, cursor: LibraryCursor | null, history: (LibraryCursor | null)[]) {
  for (;;) {
    const page = await store.chronologicalPage(cursor, 31, filters);
    const fallback = page.length ? null : emptyPageFallback(cursor, history);
    if (!fallback) return { rows: page.slice(0, 30), next: page.length > 30, cursor, history };
    ({ cursor, history } = fallback);
  }
}
async function unfavourite(store: ImportStore, rows: readonly ChronologicalRow[]) {
  const changes = new Map<string, boolean>();
  for (const row of rows) { await store.setFavorite(row.id, false); changes.set(row.id, false); }
  return changes;
}

test('an emptied first Favourites page reloads and shows the later favourite, with pagination', async t => {
  const { store } = await library(t);
  const first = await show(store, favourites, null, []);
  assert.equal(first.rows.length, 30); assert.equal(first.next, true);
  const changes = await unfavourite(store, first.rows); // All 30 unfavourited in the viewer, closing on the last.
  const decision = returnToGrid(first.rows, first.rows[29]!.id, changes, favourites);
  assert.deepEqual(decision, { kind: 'reload' }, 'not an empty page');
  const again = await show(store, favourites, first.cursor, first.history);
  assert.deepEqual(again.rows.map(row => row.id), ['f30']); assert.equal(again.next, false);
  assert.equal(again.cursor, null, 'still the first page, filters unchanged');
});

test('an emptied later Favourites page steps back to the page before it', async t => {
  const { store } = await library(t);
  const first = await show(store, favourites, null, []);
  const second = await show(store, favourites, keyOf(first.rows[29]!), [null]);
  assert.deepEqual(second.rows.map(row => row.id), ['f30']);
  const changes = await unfavourite(store, second.rows);
  assert.deepEqual(returnToGrid(second.rows, 'f30', changes, favourites), { kind: 'reload' });
  const again = await show(store, favourites, second.cursor, second.history);
  assert.equal(again.cursor, null); assert.deepEqual(again.history, []);
  assert.deepEqual(again.rows.map(row => row.id), first.rows.map(row => row.id), 'the earlier page, with its favourites');
  assert.equal(again.next, false, 'nothing after it now');
});

test('a page that keeps rows is patched in place; unrelated pages jump; an empty library stays empty', async t => {
  const { store } = await library(t);
  const first = await show(store, favourites, null, []);
  const changes = await unfavourite(store, first.rows.slice(0, 2));
  const kept = returnToGrid(first.rows, first.rows[1]!.id, changes, favourites);
  assert.equal(kept.kind, 'keep');
  assert.deepEqual(kept.kind === 'keep' && kept.rows.map(row => row.id), first.rows.slice(2).map(row => row.id));
  assert.deepEqual(returnToGrid(first.rows, 'f33', new Map(), favourites), { kind: 'jump' });
  const all = { media: 'all', favorites: false, month: '' } satisfies LibraryFilters;
  assert.equal(patchFavorites(first.rows, changes, all).find(row => row.id === first.rows[0]!.id)?.favorite, 0, 'without the filter: heart cleared, row kept');
  assert.equal(emptyPageFallback(null, []), null);
});
