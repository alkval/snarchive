import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ImportStore } from '../src/storage/importStore.ts';
import { inventoryFromSnapshot } from '../src/import/sourceInventory.ts';
import { writeBackupSnapshot } from '../src/backup/snapshot.ts';
import { BackupManifestValidator } from '../src/backup/manifest.ts';
import { RestoreMerge } from '../src/backup/restoreMerge.ts';
import { LibraryDB } from './helpers/libraryDb.ts';
const hash = 'a'.repeat(64), object = 'b'.repeat(64);
async function library(t: { after(fn: () => void): void }, filled = true, folder = false) {
  const db = new LibraryDB(); t.after(() => db.raw.close()); const store = new ImportStore(db); await store.initialize();
  const source = inventoryFromSnapshot({ entries: ['2026-02-05_one-main.jpg', '2026-02-05_two-main.jpg'].map(path => ({ path })), visitedEntries: 2, metadataBytes: 0 }, 'source-1');
  if (filled) {
    const key = folder ? await store.planFolder(source) : (await store.plan(hash, source), hash);
    for (let ordinal = 0; ordinal < 2; ordinal++) await store.commit(key, ordinal, { sha256: object, relativePath: `objects/bb/${object}`, bytes: 10 });
    await store.state(key, 'completed');
  }
  return { db, store };
}
async function snapshot(db: LibraryDB) {
  const lines: string[] = []; await writeBackupSnapshot(db, { async line(line) { lines.push(line); }, async object() {} }); return lines.join('');
}
function validated(text: string) { const reader = new BackupManifestValidator({ keepRecords: true }); reader.push(text); reader.finish(); return reader; }
async function restore(db: LibraryDB, text: string) {
  const records = validated(text).takeRecords();
  await db.withExclusiveTransactionAsync(async tx => { const merge = new RestoreMerge(tx); await merge.begin(); for (const record of records) await merge.apply(record); await merge.finish(); });
}
test('v3 deletion markers survive ZIP and folder backup round-trips and are not pending work', async t => {
  for (const folder of [false, true]) {
    const source = await library(t, true, folder); await source.store.deleteMemory('one');
    const text = await snapshot(source.db); assert.ok(text.startsWith('{"type":"header","format":"snarchive-backup","version":3}\n'));
    assert.equal(validated(text).finish().pendingFiles, 0);
    const target = await library(t, false); await restore(target.db, text);
    assert.equal(await snapshot(target.db), text);
    assert.deepEqual(target.db.raw.prepare('SELECT * FROM library_dates ORDER BY memory_id,kind,value').all(), source.db.raw.prepare('SELECT * FROM library_dates ORDER BY memory_id,kind,value').all());
    assert.equal(target.db.raw.prepare("SELECT count(*) AS n FROM memory_deletions WHERE memory_id='one'").get()!.n, 1);
    assert.deepEqual((await target.store.page()).map(row => row.id), ['two']);
    await restore(target.db, text); assert.equal(await snapshot(target.db), text);
  }
});
test('a backup deletion never deletes an existing live memory; an explicitly restored older backup can recover a local deletion', async t => {
  const source = await library(t); const older = await snapshot(source.db); await source.store.deleteMemory('one'); const newer = await snapshot(source.db);
  const target = await library(t); await restore(target.db, newer);
  assert.equal((await target.store.summary()).memories, 2);
  assert.equal(target.db.raw.prepare('SELECT count(*) AS n FROM memory_deletions').get()!.n, 0);
  await restore(source.db, older);
  assert.equal((await source.store.summary()).memories, 2); assert.equal(await snapshot(source.db), older);
  assert.equal((await source.store.page()).find(row => row.id === 'one')?.day, '2026-02-05', 'explicit recovery restores date evidence too');
});
test('deleting the last memory makes a valid zero-object backup without deleted original bytes', async t => {
  const source = await library(t); await source.store.deleteMemory('one'); await source.store.deleteMemory('two');
  const text = await snapshot(source.db), preview = validated(text).finish();
  assert.equal(preview.objects, 0); assert.equal(preview.memories, 0); assert.equal(preview.pendingFiles, 0);
  const target = await library(t, false); await restore(target.db, text); assert.equal(await snapshot(target.db), text);
});
function rewrite(text: string, edit: (records: Record<string, unknown>[]) => void) {
  const records = text.trim().split('\n').map(line => JSON.parse(line)); edit(records);
  records.at(-1).records = records.length - 1;
  return records.map(record => JSON.stringify(record) + '\n').join('');
}
test('deleted records must be sorted, unique, before objects, version 3 and traceable to a source; preserved deleted files are refused', async t => {
  const source = await library(t); await source.store.deleteMemory('one'); const text = await snapshot(source.db);
  const bad = [
    rewrite(text, r => { r[0]!.version = 2; }),
    rewrite(text, r => { r.splice(2, 0, { ...r[1] }); }),
    rewrite(text, r => { r[1]!.memoryId = 'unknown'; }),
    rewrite(text, r => { [r[1], r[2]] = [r[2]!, r[1]!]; }),
    rewrite(text, r => { r[1]!.memoryId = 'two'; }),
  ];
  for (const forged of bad) assert.throws(() => validated(forged), /backup-invalid/);
  const legacy = await library(t); assert.ok((await snapshot(legacy.db)).includes('"version":1'));
  const legacyFolder = await library(t, true, true); assert.ok((await snapshot(legacyFolder.db)).includes('"version":2'));
});
