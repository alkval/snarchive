import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { PreviewStore, type SqlConnection, type SqlDatabase } from '../src/storage/previewStore.ts';
import { encodePreview, decodePreview, type SavedPreview } from '../src/storage/previewCodec.ts';
import { inventoryFromSnapshot, mergeSourceInventories } from '../src/import/sourceInventory.ts';

class HostDatabase implements SqlDatabase {
  raw: DatabaseSync;
  failAfterWrite = false;
  constructor(path: string) { this.raw = new DatabaseSync(path); }
  async execAsync(sql: string) { this.raw.exec(sql); }
  async runAsync(sql: string, ...params: (string | number | null)[]) {
    this.raw.prepare(sql).run(...params);
    if (this.failAfterWrite) throw new Error('injected-write-failure');
  }
  async getFirstAsync<T>(sql: string, ...params: (string | number | null)[]) { return (this.raw.prepare(sql).get(...params) as T | undefined) ?? null; }
  async getAllAsync<T>(sql: string, ...params: (string | number | null)[]) { return this.raw.prepare(sql).all(...params) as T[]; }
  async withExclusiveTransactionAsync(work: (tx: SqlConnection) => Promise<void>) {
    this.raw.exec('BEGIN IMMEDIATE');
    try { await work(this); this.raw.exec('COMMIT'); }
    catch (error) { this.raw.exec('ROLLBACK'); throw error; }
  }
}
function sample(otherFiles = 0): SavedPreview {
  const source = inventoryFromSnapshot({ visitedEntries: 2 + otherFiles, metadataBytes: 200, entries: [
    { path: '2026-02-05_memoryA-main.jpg' },
    { path: 'memories_history.json', metadataText: JSON.stringify({ 'Saved Media': [{
      Date: '2026-02-05 17:48:47 UTC', 'Media Type': 'Image',
      'Download Link': 'https://example.test/?mid=memoryA&secret=DO_NOT_SAVE',
      Location: 'Latitude, Longitude: 10, 20', privateField: 'DO_NOT_SAVE',
    }] }) }, ...Array.from({ length: otherFiles }, (_, i) => ({ path: `unused-${i}.txt` })),
  ] }, 'source-1');
  return { preview: mergeSourceInventories([], source), sourceIds: new Map([['zip:' + 'a'.repeat(64), 'source-1']]) };
}
function temporary(t: { after: (fn: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), 'snarchive-db-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true })); return join(dir, 'preview.db');
}
test('migration initializes an empty database and is repeatable', async t => {
  const db = new HostDatabase(temporary(t)); t.after(() => db.raw.close());
  const store = new PreviewStore(db); await store.initialize(); await store.initialize();
  assert.equal(await store.load(), null);
  assert.equal(db.raw.prepare('PRAGMA user_version').get()?.user_version, 1);
});
test('checkpoint survives close/reopen with identity, dates, locations and report intact', async t => {
  const path = temporary(t), first = new HostDatabase(path), saved = sample();
  const store = new PreviewStore(first); await store.initialize(); await store.save(saved); first.raw.close();
  const second = new HostDatabase(path); t.after(() => second.raw.close());
  const reopened = new PreviewStore(second); await reopened.initialize();
  assert.deepEqual(await reopened.load(), saved);
});
test('failed replacement rolls back to the previous complete checkpoint', async t => {
  const db = new HostDatabase(temporary(t)); t.after(() => db.raw.close());
  const store = new PreviewStore(db); await store.initialize(); await store.save(sample());
  db.failAfterWrite = true; await assert.rejects(store.save(sample(1))); db.failAfterWrite = false;
  assert.deepEqual(await store.load(), sample());
});
test('process exit before commit does not expose a partial replacement', async t => {
  const path = temporary(t), db = new HostDatabase(path);
  const store = new PreviewStore(db); await store.initialize(); await store.save(sample()); db.raw.close();
  const child = spawnSync(process.execPath, ['-e', `const {DatabaseSync}=require('node:sqlite'); const db=new DatabaseSync(process.argv[1]); db.exec('BEGIN IMMEDIATE'); db.prepare('UPDATE preview_checkpoint SET payload = ?').run('incomplete'); process.exit(0);`, path]);
  assert.equal(child.status, 0, child.stderr.toString());
  const reopenedDb = new HostDatabase(path); t.after(() => reopenedDb.raw.close());
  const reopened = new PreviewStore(reopenedDb); await reopened.initialize();
  assert.deepEqual(await reopened.load(), sample());
});
test('newer database version is rejected without replacing saved content', async t => {
  const db = new HostDatabase(temporary(t)); t.after(() => db.raw.close());
  const store = new PreviewStore(db); await store.initialize(); await store.save(sample());
  db.raw.exec('PRAGMA user_version = 2');
  await assert.rejects(store.initialize(), /unsupported-database-version/);
  assert.equal(db.raw.prepare('PRAGMA user_version').get()?.user_version, 2);
  assert.equal(db.raw.prepare('SELECT count(*) AS n FROM preview_checkpoint').get()?.n, 1);
});
test('corrupt saved content fails explicitly and remains available for recovery', async t => {
  const db = new HostDatabase(temporary(t)); t.after(() => db.raw.close());
  const store = new PreviewStore(db); await store.initialize(); await store.save(sample());
  db.raw.prepare('UPDATE preview_checkpoint SET payload = ?').run('{broken');
  await assert.rejects(store.load());
  assert.equal(db.raw.prepare('SELECT payload FROM preview_checkpoint').get()?.payload, '{broken');
});
test('storage allowlist excludes signed URLs and unrelated properties', () => {
  const saved = sample();
  Object.assign(saved.preview.sources[0]!, { rawMetadata: 'DO_NOT_SAVE' });
  Object.assign(saved.preview.sources[0]!.metadata[0]!.records[0]!, { downloadUrl: 'DO_NOT_SAVE' });
  const text = encodePreview(saved);
  assert.ok(!text.includes('DO_NOT_SAVE') && !text.includes('example.test'));
  assert.equal(decodePreview(text).preview.inventory.summary.mediaPresent, 1);
});
test('invalid paths, identity mappings and format versions are rejected', () => {
  const text = encodePreview(sample());
  for (const mutate of [
    (v: any) => { v.format = 2; },
    (v: any) => { v.identities[0][1] = 'source-2'; },
    (v: any) => { v.sources[0].files[0].relativePath = '../outside.jpg'; },
    (v: any) => { v.sources[0].metadata[0].records[0].captureDate.utc = 'wrong'; },
  ]) {
    const value = JSON.parse(text); mutate(value); assert.throws(() => decodePreview(JSON.stringify(value)));
  }
});
test('rescan after reopening replaces observations without another source', async t => {
  const db = new HostDatabase(temporary(t)); t.after(() => db.raw.close());
  const store = new PreviewStore(db); await store.initialize(); await store.save(sample());
  const loaded = (await store.load())!;
  const sourceId = loaded.sourceIds.get('zip:' + 'a'.repeat(64)); assert.equal(sourceId, 'source-1');
  loaded.preview = mergeSourceInventories(loaded.preview.sources, sample(1).preview.sources[0]!);
  await store.save(loaded);
  const latest = (await store.load())!;
  assert.equal(latest.preview.sources.length, 1); assert.equal(latest.preview.otherFiles, 1);
});
