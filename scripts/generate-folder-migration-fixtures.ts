// Builds schema-4 app-data fixtures (folder jobs in provider listing order, as commit 307eda2 planned them) from a
// device's own scan of the synthetic extracted folder (scripts/generate-folder-fixture.py), for section 21 verification.
// Synthetic data only. Usage, from the project root:
//   node --experimental-strip-types scripts/generate-folder-migration-fixtures.ts <folder> <scan.json> <variant.jpg> <photos.zip> <out>
// <folder>: the snarchive-extracted folder; <scan.json>: the preview_checkpoint payload saved after scanning it on the
// device; <variant.jpg>: any other synthetic JPEG (the conflicting bytes for f03); <photos.zip>: the photo fixture ZIP.
// Writes F1-partial, F2-agreeing and F3-conflicting, each with files/ (library database at user_version 4 and
// originals) and expected.json (job keys and each completed path's SHA-256). Load files/ into disposable app data.
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
const [folderDir, scanPath, variantPath, zipPath, out] = process.argv.slice(2);
const repo = process.cwd();
const { ImportStore, indexDates } = await import(join(repo, 'src/storage/importStore.ts'));
const { decodePreview, encodePreview } = await import(join(repo, 'src/storage/previewCodec.ts'));
const { listedFolderHash, folderInventoryHash, isCanonicalFolderSource } = await import(join(repo, 'src/import/sourceEvidence.ts'));
const { inventoryFromSnapshot } = await import(join(repo, 'src/import/sourceInventory.ts'));

class DB {
  raw: DatabaseSync; constructor(path: string) { this.raw = new DatabaseSync(path); }
  async execAsync(sql: string) { this.raw.exec(sql); }
  async runAsync(sql: string, ...p: unknown[]) { this.raw.prepare(sql).run(...(p as never[])); }
  async getFirstAsync<T>(sql: string, ...p: unknown[]) { return (this.raw.prepare(sql).get(...(p as never[])) as T | undefined) ?? null; }
  async getAllAsync<T>(sql: string, ...p: unknown[]) { return this.raw.prepare(sql).all(...(p as never[])) as T[]; }
  async withExclusiveTransactionAsync(work: (tx: DB) => Promise<void>) { this.raw.exec('BEGIN IMMEDIATE'); try { await work(this); this.raw.exec('COMMIT'); } catch (e) { this.raw.exec('ROLLBACK'); throw e; } }
}
const device = decodePreview(readFileSync(scanPath, 'utf8')).preview.sources[0]!;
const variant = readFileSync(variantPath);
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const zipBytes = readFileSync(zipPath), zipHash = sha(zipBytes);
const zipNames = execFileSync('unzip', ['-Z1', zipPath], { encoding: 'utf8' }).trim().split('\n');
const zipEntry = (name: string) => execFileSync('unzip', ['-p', zipPath, name]);

type Done = Record<string, Buffer>; // path -> bytes preserved for it
/** The same scan as a provider listing the folder in reverse: files reversed, the metadata file at another index. */
function reversed(source: typeof device) {
  const metadata = source.metadata;
  return { ...source, files: [...source.files].reverse(), metadata: metadata.map(m => ({
    records: m.records.map(r => ({ ...r, sourceId: `${source.sourceId}:metadata-16` })), diagnostics: m.diagnostics.map(d => ({ ...d, sourceId: `${source.sourceId}:metadata-16` })) })) };
}
async function build(name: string, jobs: { source: typeof device; done: Done }[]) {
  const dir = join(out, name); rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, 'files/SQLite'), { recursive: true }); mkdirSync(join(dir, 'files/snarchive-originals/staging'), { recursive: true });
  const db = new DB(join(dir, 'files/SQLite/snarchive-library.db')); const store = new ImportStore(db); await store.initialize();
  const objects = new Map<string, Buffer>();
  const receipt = (bytes: Buffer) => { const h = sha(bytes); objects.set(h, bytes); return { sha256: h, relativePath: `objects/${h.slice(0, 2)}/${h}`, bytes: bytes.length }; };
  // An ordinary ZIP job (the photo fixture), with its first memory preserved.
  const zipSource = inventoryFromSnapshot({ entries: zipNames.map(path => path.endsWith('.json') ? { path, metadataText: zipEntry(path).toString('utf8') } : { path }),
    metadataBytes: zipNames.filter(n => n.endsWith('.json')).reduce((n, p) => n + zipEntry(p).length, 0), visitedEntries: zipNames.length }, 'source-2');
  await store.plan(zipHash, zipSource);
  for (const [ordinal, file] of zipSource.files.entries()) if (file.relativePath.startsWith('2026-10-18_000-photo')) await store.commit(zipHash, ordinal, receipt(zipEntry(file.relativePath)));
  await store.state(zipHash, 'paused');
  const keys: string[] = [];
  for (const job of jobs) {
    const key = listedFolderHash(job.source);
    if (isCanonicalFolderSource(job.source)) throw new Error('fixture listing is already canonical');
    const plan = encodePreview({ preview: { sources: [job.source], inventory: null as never, otherFiles: 0 }, sourceIds: new Map([[`folder:${key}`, job.source.sourceId]]) });
    db.raw.prepare("INSERT INTO import_jobs(hash,state,plan_json,kind) VALUES (?,'planned',?,'folder')").run(key, plan);
    await db.withExclusiveTransactionAsync(async tx => indexDates(tx as never, decodePreview(plan).preview.sources[0]!));
    for (const [ordinal, file] of job.source.files.entries()) db.raw.prepare('INSERT INTO import_items(job_hash,ordinal,relative_path,memory_id,role,date_json) VALUES (?,?,?,?,?,?)')
      .run(key, ordinal, file.relativePath, file.memorySourceId, file.role, JSON.stringify(file.captureDate));
    for (const [path, bytes] of Object.entries(job.done)) await store.commit(key, job.source.files.findIndex(f => f.relativePath === path), receipt(bytes));
    await store.state(key, 'paused'); keys.push(key);
  }
  db.raw.exec('PRAGMA user_version = 4;'); db.raw.exec('PRAGMA wal_checkpoint(TRUNCATE);'); db.raw.close();
  for (const [hash, bytes] of objects) { mkdirSync(join(dir, 'files/snarchive-originals/objects', hash.slice(0, 2)), { recursive: true }); writeFileSync(join(dir, 'files/snarchive-originals/objects', hash.slice(0, 2), hash), bytes); }
  rmSync(join(dir, 'files/SQLite/snarchive-library.db-wal'), { force: true }); rmSync(join(dir, 'files/SQLite/snarchive-library.db-shm'), { force: true });
  const expected = { zipHash, legacyKeys: keys, canonicalKey: folderInventoryHash(device), jobs: jobs.map((job, i) => ({ key: keys[i], done: Object.fromEntries(Object.entries(job.done).map(([p, b]) => [p, sha(b)])) })) };
  writeFileSync(join(dir, 'expected.json'), JSON.stringify(expected, null, 1));
  console.log(name, JSON.stringify({ legacy: keys.map(k => k.slice(0, 12)), canonical: expected.canonicalKey.slice(0, 12), zip: zipHash.slice(0, 12), objects: objects.size }));
}
const file = (name: string) => readFileSync(join(folderDir, 'memories', name));
const M = (name: string) => `memories/${name}`;
await build('F1-partial', [{ source: device, done: { [M('2026-10-01_f00-main.jpg')]: file('2026-10-01_f00-main.jpg'), [M('2026-10-01_f00-overlay.png')]: file('2026-10-01_f00-overlay.png'),
  [M('2026-10-02_f01-main.jpg')]: file('2026-10-02_f01-main.jpg'), [M('2026-10-06_f05-main.jpg')]: file('2026-10-06_f05-main.jpg'),
  [M('2026-10-14_fvideo-main.mp4')]: file('2026-10-14_fvideo-main.mp4'), [M('2026-10-18_000-photo-main.jpg')]: file('2026-10-18_000-photo-main.jpg') } }]);
await build('F2-agreeing', [
  { source: device, done: { [M('2026-10-01_f00-main.jpg')]: file('2026-10-01_f00-main.jpg'), [M('2026-10-02_f01-main.jpg')]: file('2026-10-02_f01-main.jpg'), [M('2026-10-03_f02-main.jpg')]: file('2026-10-03_f02-main.jpg') } },
  { source: reversed(device), done: { [M('2026-10-06_f05-main.jpg')]: file('2026-10-06_f05-main.jpg'), [M('2026-10-07_f06-main.jpg')]: file('2026-10-07_f06-main.jpg'),
    [M('2026-10-14_fvideo-main.mp4')]: file('2026-10-14_fvideo-main.mp4'), [M('2026-10-03_f02-main.jpg')]: file('2026-10-03_f02-main.jpg') } }]);
await build('F3-conflicting', [
  { source: device, done: { [M('2026-10-01_f00-main.jpg')]: file('2026-10-01_f00-main.jpg'), [M('2026-10-04_f03-main.jpg')]: file('2026-10-04_f03-main.jpg'), [M('2026-10-05_f04-main.jpg')]: file('2026-10-05_f04-main.jpg') } },
  { source: reversed(device), done: { [M('2026-10-04_f03-main.jpg')]: variant, [M('2026-10-08_f07-main.jpg')]: file('2026-10-08_f07-main.jpg'), [M('2026-10-14_fvideo-main.mp4')]: file('2026-10-14_fvideo-main.mp4') } }]);
