import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { ImportStore, type Receipt } from '../src/storage/importStore.ts';
import { inventoryFromSnapshot, type DirectorySnapshot } from '../src/import/sourceInventory.ts';
import { runFolderImport, FolderStepError, FolderImportFailure, type FolderCopier, type FolderScan } from '../src/import/runFolderImport.ts';
import { folderInventoryHash, sourceEvidence } from '../src/import/sourceEvidence.ts';
import { sha256Hex } from '../src/domain/sha256.ts';
import { writeBackupSnapshot } from '../src/backup/snapshot.ts';
import { BackupManifestValidator } from '../src/backup/manifest.ts';
import { RestoreMerge } from '../src/backup/restoreMerge.ts';
import { decodePreview, encodePreview } from '../src/storage/previewCodec.ts';
import type { SqlDatabase, SqlConnection } from '../src/storage/previewStore.ts';

class DB implements SqlDatabase {
  raw: DatabaseSync; failSql = '';
  constructor() { this.raw = new DatabaseSync(':memory:'); }
  async execAsync(sql: string) { this.raw.exec(sql); }
  async runAsync(sql: string, ...p: (string | number | null)[]) { if (this.failSql && sql.includes(this.failSql)) throw new Error('disk-io-error'); this.raw.prepare(sql).run(...p); }
  async getFirstAsync<T>(sql: string, ...p: (string | number | null)[]) { return (this.raw.prepare(sql).get(...p) as T | undefined) ?? null; }
  async getAllAsync<T>(sql: string, ...p: (string | number | null)[]) { return this.raw.prepare(sql).all(...p) as T[]; }
  async withExclusiveTransactionAsync(work: (tx: SqlConnection) => Promise<void>) {
    this.raw.exec('BEGIN IMMEDIATE'); try { await work(this); this.raw.exec('COMMIT'); } catch (e) { this.raw.exec('ROLLBACK'); throw e; }
  }
}
async function library(t: { after(fn: () => void): void }) {
  const db = new DB(); t.after(() => { try { db.raw.close(); } catch {} });
  const store = new ImportStore(db); await store.initialize(); return { db, store };
}
const metadata = (rows: { date: string; mid: string; location?: string }[]) => JSON.stringify({ 'Saved Media': rows.map(row => ({
  Date: row.date, 'Media Type': 'Image', 'Download Link': `https://synthetic.invalid/download?mid=${row.mid}`, Location: row.location ?? 'Latitude, Longitude: 10, 20' })) });

/** A synthetic extracted folder: media files with their content, plus optional memories_history.json. */
type Folder = { files: Map<string, string>; metadataText?: string };
const folder = (files: Record<string, string>, metadataText?: string): Folder => ({ files: new Map(Object.entries(files)), metadataText });
function snapshot(dir: Folder): DirectorySnapshot {
  const entries: DirectorySnapshot['entries'] = [...dir.files.keys()].map(path => ({ path }));
  if (dir.metadataText !== undefined) entries.push({ path: 'json/memories_history.json', metadataText: dir.metadataText });
  return { entries, metadataBytes: dir.metadataText?.length ?? 0, visitedEntries: entries.length + 1 };
}
const receiptFor = (content: string): Receipt => {
  const sha256 = createHash('sha256').update(content).digest('hex');
  return { sha256, relativePath: `objects/${sha256.slice(0, 2)}/${sha256}`, bytes: Buffer.byteLength(content) };
};
/** A fake native session over a Folder. faults[path] fails that file with a code (optionally with a store leftover). */
class Copier implements FolderCopier {
  stored = new Map<string, number>(); preserved: string[] = []; confirmed: string[] = []; closed = 0; opened = 0;
  faults = new Map<string, { code: string; storeCleanupFailed?: boolean }>();
  openFails: string | null = null; prepareFails: string | null = null; confirmFails = false; cancelAfter = 0; cancelled = false;
  dir: Folder; sizes = new Map<string, number>();
  constructor(dir: Folder) { this.dir = dir; }
  async open(_uri: string): Promise<FolderScan> {
    this.opened++; if (this.openFails) throw new FolderStepError(this.openFails);
    const scan = snapshot(this.dir);
    return { ...scan, sizes: scan.entries.map(entry => this.sizes.get(entry.path) ?? (this.dir.files.has(entry.path) ? Buffer.byteLength(this.dir.files.get(entry.path)!) : -1)) };
  }
  async prepare() { if (this.prepareFails) throw new FolderStepError(this.prepareFails); }
  async preserve(path: string) {
    const fault = this.faults.get(path);
    if (fault) throw new FolderStepError(fault.code, !!fault.storeCleanupFailed);
    const content = this.dir.files.get(path); if (content === undefined) throw new FolderStepError('source-missing');
    this.preserved.push(path); const receipt = receiptFor(content); this.stored.set(receipt.sha256, receipt.bytes);
    if (this.cancelAfter && this.preserved.length === this.cancelAfter) this.cancelled = true;
    return receipt;
  }
  async confirm(hash: string, bytes: number) { if (this.confirmFails || this.stored.get(hash) !== bytes) throw new FolderStepError('stored-object-corrupt'); this.confirmed.push(hash); }
  async close() { this.closed++; }
}
async function plan(store: ImportStore, dir: Folder, label = 'source-1') { return store.planFolder(inventoryFromSnapshot(snapshot(dir), label)); }
const run = (store: ImportStore, copier: Copier, hash: string) => runFolderImport(store, copier, hash, 'content://tree/synthetic', () => copier.cancelled, () => {});
async function dump(db: DB) {
  const all = (sql: string) => db.raw.prepare(sql).all();
  return { jobs: all('SELECT hash,kind,state,plan_json FROM import_jobs ORDER BY hash'), items: all('SELECT * FROM import_items ORDER BY job_hash,ordinal'),
    objects: all('SELECT * FROM stored_objects ORDER BY hash'), memories: all('SELECT * FROM memories ORDER BY id'),
    associations: all('SELECT * FROM memory_objects ORDER BY memory_id,role,object_hash'), dates: all('SELECT * FROM library_dates ORDER BY memory_id,kind,value') };
}
async function manifest(db: DB) { const lines: string[] = []; await writeBackupSnapshot(db, { async line(line) { lines.push(line); }, async object() {} }); return lines.join(''); }
async function restoreInto(db: DB, text: string) {
  const validator = new BackupManifestValidator({ keepRecords: true });
  await db.withExclusiveTransactionAsync(async tx => {
    const merge = new RestoreMerge(tx); await merge.begin();
    for (let offset = 0; offset < text.length; offset += 97) { validator.push(text.slice(offset, offset + 97)); for (const record of validator.takeRecords()) await merge.apply(record); }
    validator.finish(); await merge.finish();
  });
}
function validate(text: string) { const validator = new BackupManifestValidator(); validator.push(text); return validator.finish(); }
function rejectsManifest(text: string, code: string) { assert.throws(() => validate(text), (error: Error) => error.message === code); }

const EXPORT = folder({
  'memories/2026-02-05_one-main.jpg': 'photo one', 'memories/2026-02-05_one-overlay.png': 'overlay one',
  'memories/2026-02-06_two-main.mp4': 'video two', 'memories/2026-02-07_three-main.jpg': 'photo one', // Same bytes as one.
  'memories/2026-02-08_orphan-overlay.png': 'lonely overlay',
}, metadata([{ date: '2026-02-05 12:00:00 UTC', mid: 'one' }, { date: '2026-02-09 08:00:00 UTC', mid: 'later', location: 'Latitude, Longitude: 59.9, 10.7' }]));

test('folder scan -> preserve -> browse, with exact receipts, shared bytes kept as distinct memories, overlays and metadata', async t => {
  const { store } = await library(t); const hash = await plan(store, EXPORT); const copier = new Copier(EXPORT);
  assert.match(hash, /^[a-f0-9]{64}$/);
  const outcome = await run(store, copier, hash);
  assert.deepEqual(outcome, { preserved: 5, confirmed: 0, skipped: { missing: 0, changed: 0, unreadable: 0 }, changedSincePreserved: 0, complete: true, storeCleanupFailed: false });
  assert.deepEqual(await store.summary(), { files: 5, objects: 4, memories: 3, unfinished: 0, conflicts: 0 });
  const page = await store.chronologicalPage();
  assert.deepEqual(page.map(row => [row.id, row.day, row.overlays]), [['three', '2026-02-07', 0], ['two', '2026-02-06', 0], ['one', '2026-02-05', 1]]);
  const saved = await store.folderPlan(hash);
  assert.equal(saved!.metadata[0]!.records.find(row => row.memorySourceId === 'later')!.location.kind, 'valid'); // Evidence for media not yet seen.
  assert.equal(copier.closed, 1);
});

test('repeating the import confirms completed files and adds nothing; a re-scan of the same folder reuses the job', async t => {
  const { db, store } = await library(t); const hash = await plan(store, EXPORT); const copier = new Copier(EXPORT);
  await run(store, copier, hash); const before = await dump(db);
  assert.equal(await plan(store, EXPORT, 'source-4'), hash, 'same inventory, different device label: same job');
  const again = await run(store, copier, hash);
  assert.equal(again.preserved, 0); assert.equal(again.confirmed, 5); assert.equal(copier.preserved.length, 5);
  assert.deepEqual(await dump(db), before);
});

test('per-file failures leave those files pending and report them; a retry completes without duplicates', async t => {
  const { db, store } = await library(t); const hash = await plan(store, EXPORT); const copier = new Copier(EXPORT);
  copier.faults.set('memories/2026-02-06_two-main.mp4', { code: 'source-changed', storeCleanupFailed: true });
  copier.faults.set('memories/2026-02-07_three-main.jpg', { code: 'source-unreadable' });
  copier.faults.set('memories/2026-02-08_orphan-overlay.png', { code: 'source-missing' });
  const partial = await run(store, copier, hash);
  assert.deepEqual(partial.skipped, { missing: 1, changed: 1, unreadable: 1 });
  assert.equal(partial.complete, false); assert.equal(partial.storeCleanupFailed, true); assert.equal(partial.preserved, 2);
  assert.equal((db.raw.prepare('SELECT state FROM import_jobs').get() as { state: string }).state, 'paused');
  copier.faults.clear();
  const retry = await run(store, copier, hash);
  assert.equal(retry.complete, true); assert.equal(retry.preserved, 3); assert.equal(retry.confirmed, 2);
  assert.deepEqual(await store.summary(), { files: 5, objects: 4, memories: 3, unfinished: 0, conflicts: 0 });
});

test('a different or edited folder is folder-changed and imports nothing into the plan', async t => {
  const { db, store } = await library(t); const hash = await plan(store, EXPORT); const before = await dump(db);
  for (const changed of [
    folder({ ...Object.fromEntries(EXPORT.files), 'memories/2026-02-10_new-main.jpg': 'added' }, EXPORT.metadataText),
    folder(Object.fromEntries([...EXPORT.files].slice(1)), EXPORT.metadataText),
    folder(Object.fromEntries(EXPORT.files), metadata([{ date: '2026-02-05 12:00:01 UTC', mid: 'one' }])),
    folder(Object.fromEntries(EXPORT.files)),
  ]) {
    const copier = new Copier(changed);
    await assert.rejects(run(store, copier, hash), (error: Error) => error instanceof FolderImportFailure && error.message === 'folder-changed');
    assert.equal(copier.preserved.length, 0); assert.equal(copier.closed, 1);
  }
  const after = await dump(db);
  assert.deepEqual({ ...after, jobs: [] }, { ...before, jobs: [] });
  assert.equal((after.jobs[0] as { state: string }).state, 'paused');
});

test('expired access, an unreadable folder and low storage stop before copying; a retry then works', async t => {
  const { db, store } = await library(t); const hash = await plan(store, EXPORT); const before = await dump(db);
  for (const [field, code] of [['openFails', 'folder-access-denied'], ['openFails', 'folder-unreadable'], ['prepareFails', 'insufficient-storage']] as const) {
    const copier = new Copier(EXPORT); copier[field] = code;
    await assert.rejects(run(store, copier, hash), (error: Error) => error instanceof FolderImportFailure && error.message === code);
    assert.equal(copier.preserved.length, 0);
  }
  assert.deepEqual((await dump(db)).items, before.items);
  assert.equal((await run(store, new Copier(EXPORT), hash)).complete, true);
});

test('cancellation keeps committed files and leaves the rest pending; a retry finishes', async t => {
  const { store } = await library(t); const hash = await plan(store, EXPORT); const copier = new Copier(EXPORT); copier.cancelAfter = 2;
  await assert.rejects(run(store, copier, hash), (error: Error) => error instanceof FolderImportFailure && error.message === 'cancelled');
  assert.equal((await store.summary()).files, 2, 'the file finalized as cancel arrived was still committed');
  copier.cancelled = false; copier.cancelAfter = 0;
  const retry = await run(store, copier, hash);
  assert.equal(retry.confirmed, 2); assert.equal(retry.preserved, 3); assert.equal((await store.summary()).files, 5);
});

test('a database failure while committing rolls back that file; a retry reuses its verified object', async t => {
  const { db, store } = await library(t); const hash = await plan(store, EXPORT); const copier = new Copier(EXPORT);
  db.failSql = 'UPDATE import_items';
  await assert.rejects(run(store, copier, hash));
  assert.deepEqual(await store.summary(), { files: 0, objects: 0, memories: 0, unfinished: 1, conflicts: 0 });
  db.failSql = '';
  assert.equal((await run(store, copier, hash)).complete, true);
  assert.equal((await store.summary()).files, 5);
});

test('a corrupt existing original stops the run; a failure with a store leftover reports both', async t => {
  const { store } = await library(t); const hash = await plan(store, EXPORT); const copier = new Copier(EXPORT);
  await run(store, copier, hash);
  copier.confirmFails = true;
  await assert.rejects(run(store, copier, hash), (error: Error) => error instanceof FolderImportFailure && error.message === 'stored-object-corrupt');
  assert.equal((await store.summary()).unfinished, 0, 'a completed job stays completed after a failed rerun');
  const other = folder({ 'memories/2026-03-01_new-main.jpg': 'new' }); const second = await plan(store, other); const failing = new Copier(other);
  failing.faults.set('memories/2026-03-01_new-main.jpg', { code: 'insufficient-storage', storeCleanupFailed: true });
  await assert.rejects(run(store, failing, second), (error: Error) => error instanceof FolderImportFailure && error.message === 'insufficient-storage' && error.storeCleanupFailed);
});

test('completed files whose reported size changed are counted, never re-imported', async t => {
  const { store } = await library(t); const hash = await plan(store, EXPORT); const copier = new Copier(EXPORT);
  await run(store, copier, hash);
  copier.sizes.set('memories/2026-02-06_two-main.mp4', 999);
  const again = await run(store, copier, hash);
  assert.equal(again.changedSincePreserved, 1); assert.equal(again.preserved, 0);
});

test('overlapping folder and ZIP imports keep one memory per identity, share bytes and keep variants', async t => {
  const { store } = await library(t);
  const zip = 'f'.repeat(64);
  await store.plan(zip, inventoryFromSnapshot({ entries: [{ path: '2026-02-05_one-main.jpg' }, { path: '2026-02-06_two-main.mp4' }], metadataBytes: 0, visitedEntries: 2 }, 'source-2'));
  await store.commit(zip, 0, receiptFor('photo one')); await store.commit(zip, 1, receiptFor('a different video two'));
  const hash = await plan(store, EXPORT); await run(store, new Copier(EXPORT), hash);
  const summary = await store.summary();
  assert.equal(summary.memories, 3); assert.equal(summary.objects, 5); assert.equal(summary.conflicts, 1, 'two has two versions');
  assert.equal((await store.objects('two')).length, 2);
});

test('folder identity ignores the device label and nothing else', () => {
  const normalize = (dir: Folder, label: string) => decodePreview(encodePreview({ preview: { sources: [inventoryFromSnapshot(snapshot(dir), label)], inventory: null as never, otherFiles: 0 }, sourceIds: new Map([[`folder:${'0'.repeat(64)}`, label]]) })).preview.sources[0]!;
  const a = normalize(EXPORT, 'source-1'), b = normalize(EXPORT, 'source-6');
  assert.equal(folderInventoryHash(a), folderInventoryHash(b));
  assert.equal(folderInventoryHash(a), sha256Hex(`snarchive-folder-inventory\n1\n${sourceEvidence(a)}`));
  const moved = folder(Object.fromEntries([...EXPORT.files].map(([path, content]) => [path.replace('memories/', 'other/'), content])), EXPORT.metadataText);
  assert.notEqual(folderInventoryHash(normalize(moved, 'source-1')), folderInventoryHash(a));
});

test('SHA-256 in TypeScript matches node:crypto, including multi-byte and surrogate text', () => {
  for (const text of ['', 'abc', 'a'.repeat(55), 'a'.repeat(56), 'a'.repeat(64), 'a'.repeat(1000), 'Øre 😀 日本', 'x\uD800y', '\uDC00']) {
    assert.equal(sha256Hex(text), createHash('sha256').update(Buffer.from(new TextEncoder().encode(text))).digest('hex'), JSON.stringify(text));
  }
});

test('backup of folder-originated data is version 2, round-trips through restore, and re-exports identically', async t => {
  const source = await library(t); const hash = await plan(source.store, EXPORT); const copier = new Copier(EXPORT);
  copier.faults.set('memories/2026-02-08_orphan-overlay.png', { code: 'source-unreadable' }); // One file stays pending.
  await run(source.store, copier, hash);
  await source.store.setFavorite('one', true);
  const text = await manifest(source.db); const records = text.trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(records[0], { type: 'header', format: 'snarchive-backup', version: 2 });
  assert.equal(records.filter(record => record.type === 'folder').length, 1);
  assert.equal(records.filter(record => record.type === 'folder-preserved').length, 4);
  const preview = validate(text);
  assert.equal(preview.folders, 1); assert.equal(preview.sources, 1); assert.equal(preview.pendingFiles, 1); assert.equal(preview.memories, 3);
  const target = await library(t); await restoreInto(target.db, text);
  const job = target.db.raw.prepare('SELECT hash,kind,state FROM import_jobs').get() as { hash: string; kind: string; state: string };
  assert.deepEqual({ ...job }, { hash, kind: 'folder', state: 'paused' });
  assert.equal(await manifest(target.db), text, 'export -> restore -> export is identical');
  const before = await dump(target.db); await restoreInto(target.db, text);
  assert.deepEqual(await dump(target.db), before, 'restoring again changes nothing');
  // The restored job can be resumed from the folder: its pending file is copied, nothing else is.
  const resume = new Copier(EXPORT); for (const [sha, bytes] of copier.stored) resume.stored.set(sha, bytes);
  const outcome = await run(target.store, resume, hash);
  assert.equal(outcome.preserved, 1); assert.equal(outcome.complete, true);
});

test('a library with folder and ZIP sources exports ZIP sources first, then folders; restore keeps both kinds', async t => {
  const { db, store } = await library(t); const zip = '0'.repeat(64);
  await store.plan(zip, inventoryFromSnapshot({ entries: [{ path: '2026-02-05_one-main.jpg' }], metadataBytes: 0, visitedEntries: 1 }, 'source-2'));
  await store.commit(zip, 0, receiptFor('photo one'));
  await run(store, new Copier(EXPORT), await plan(store, EXPORT));
  const text = await manifest(db); const types = text.trim().split('\n').map(line => JSON.parse(line).type);
  assert.ok(types.lastIndexOf('source') < types.indexOf('folder'));
  const target = await library(t); await restoreInto(target.db, text);
  assert.deepEqual(target.db.raw.prepare('SELECT kind FROM import_jobs ORDER BY kind').all().map(row => (row as { kind: string }).kind), ['folder', 'zip']);
  assert.equal(await manifest(target.db), text);
});

test('version rules: folder records need version 2, a forged folder identity is refused, newer versions are unsupported', async t => {
  const { db, store } = await library(t); await run(store, new Copier(EXPORT), await plan(store, EXPORT));
  const text = await manifest(db); const lines = text.trim().split('\n');
  rejectsManifest(text.replace('"version":2', '"version":1'), 'backup-invalid');
  rejectsManifest(text.replace('"version":2', '"version":3'), 'backup-unsupported');
  const folderLine = lines.findIndex(line => line.includes('"type":"folder"'));
  const record = JSON.parse(lines[folderLine]!); const forged = 'e'.repeat(64);
  record.inventorySha256 = forged; record.inventory.identities = [[`folder:${forged}`, 'source-1']];
  const edited = lines.map((line, index) => index === folderLine ? JSON.stringify(record) : line.replace(/"inventorySha256":"[a-f0-9]{64}"/, `"inventorySha256":"${forged}"`));
  rejectsManifest(edited.join('\n') + '\n', 'backup-invalid');
  // Evidence edited under the original identity no longer hashes to it.
  const tampered = text.replace('Latitude, Longitude', 'X').replace('"latitude":59.9', '"latitude":59.8');
  rejectsManifest(tampered, 'backup-invalid');
});

test('a library without folder jobs still writes version 1, and version 1 backups restore into schema 4', async t => {
  const { db, store } = await library(t); const zip = '0'.repeat(64);
  await store.plan(zip, inventoryFromSnapshot({ entries: [{ path: '2026-02-05_one-main.jpg' }], metadataBytes: 0, visitedEntries: 1 }, 'source-1'));
  await store.commit(zip, 0, receiptFor('photo one'));
  const text = await manifest(db);
  assert.equal(JSON.parse(text.split('\n')[0]!).version, 1);
  const target = await library(t); await restoreInto(target.db, text);
  assert.equal((target.db.raw.prepare('SELECT kind FROM import_jobs').get() as { kind: string }).kind, 'zip');
});

test('schema 3 libraries migrate to 4: existing jobs become ZIP jobs and folder jobs can be added', async t => {
  const { db, store } = await library(t); const zip = '0'.repeat(64);
  await store.plan(zip, inventoryFromSnapshot({ entries: [{ path: '2026-02-05_one-main.jpg' }], metadataBytes: 0, visitedEntries: 1 }, 'source-1'));
  await store.commit(zip, 0, receiptFor('photo one'));
  db.raw.exec('ALTER TABLE import_jobs DROP COLUMN kind; PRAGMA user_version=3;');
  await store.initialize(); await store.initialize();
  assert.equal((db.raw.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 4);
  assert.equal((db.raw.prepare('SELECT kind FROM import_jobs').get() as { kind: string }).kind, 'zip');
  assert.throws(() => db.raw.exec("UPDATE import_jobs SET kind='other'"));
  const hash = await plan(store, EXPORT); await run(store, new Copier(EXPORT), hash);
  assert.equal((await store.summary()).memories, 3);
  await assert.rejects(store.plan(hash, inventoryFromSnapshot(snapshot(EXPORT), 'source-3')), 'a folder key is never reused as a ZIP job');
});
