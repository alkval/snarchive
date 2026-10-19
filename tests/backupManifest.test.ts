import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { ImportStore, type Receipt } from '../src/storage/importStore.ts';
import { inventoryFromSnapshot } from '../src/import/sourceInventory.ts';
import { writeBackupSnapshot } from '../src/backup/snapshot.ts';
import { BackupManifestValidator, MAX_RECORD_LINE, MAX_SOURCE_LINE, type BackupPreview } from '../src/backup/manifest.ts';
import { inspectBackup, type InspectionTransport } from '../src/backup/inspectBackup.ts';
import type { SqlDatabase, SqlConnection } from '../src/storage/previewStore.ts';

class DB implements SqlDatabase {
  raw = new DatabaseSync(':memory:');
  async execAsync(sql: string) { this.raw.exec(sql); }
  async runAsync(sql: string, ...p: (string | number | null)[]) { this.raw.prepare(sql).run(...p); }
  async getFirstAsync<T>(sql: string, ...p: (string | number | null)[]) { return (this.raw.prepare(sql).get(...p) as T | undefined) ?? null; }
  async getAllAsync<T>(sql: string, ...p: (string | number | null)[]) { return this.raw.prepare(sql).all(...p) as T[]; }
  async withExclusiveTransactionAsync(work: (tx: SqlConnection) => Promise<void>) {
    this.raw.exec('BEGIN IMMEDIATE');
    try { await work(this); this.raw.exec('COMMIT'); } catch (e) { this.raw.exec('ROLLBACK'); throw e; }
  }
}
const receipt = (seed: string, bytes = 10): Receipt => {
  const sha256 = seed.repeat(64).slice(0, 64);
  return { sha256, relativePath: `objects/${sha256.slice(0, 2)}/${sha256}`, bytes };
};
const A = receipt('a'), B = receipt('b', 20), C = receipt('c', 30), D = receipt('d', 5);
const job1 = '1'.repeat(64), job2 = '2'.repeat(64);

/** A synthetic library covering every association shape the format must keep apart. */
async function library(t: { after(fn: () => void): void }) {
  const db = new DB(); t.after(() => db.raw.close());
  const store = new ImportStore(db); await store.initialize();
  const plan = (hash: string, paths: string[], id: string) => store.plan(hash, inventoryFromSnapshot({ entries: paths.map(path => ({ path })), metadataBytes: 0, visitedEntries: paths.length }, id));
  // Job 1: "one" and "two" share bytes A; "orphan" has only an overlay; "pending" is never preserved.
  await plan(job1, ['2026-02-05_one-main.jpg', '2026-02-05_two-main.jpg', '2026-02-05_orphan-overlay.png', '2026-02-05_pending-main.mp4', '2026-02-05_one-overlay.png'], 'source-1');
  await store.commit(job1, 0, A); await store.commit(job1, 1, A); await store.commit(job1, 2, B); await store.commit(job1, 4, D);
  // Job 2: "one" observed again with the same bytes (repeated observation), "two" with competing bytes (variant).
  await plan(job2, ['2026-02-05_one-main.jpg', '2026-02-05_two-main.jpg'], 'source-2');
  await store.commit(job2, 0, A); await store.commit(job2, 1, C);
  await store.setFavorite('one', true); await store.setFavorite('two', true);
  return { db, store };
}
async function lines(db: DB): Promise<string[]> {
  const out: string[] = [];
  await writeBackupSnapshot(db, { async line(line) { out.push(line); }, async object() {} });
  return out;
}
function validate(text: string, chunk = text.length || 1): BackupPreview {
  const validator = new BackupManifestValidator();
  for (let index = 0; index < text.length; index += chunk) validator.push(text.slice(index, index + chunk));
  return validator.finish();
}
function rejects(text: string, code = 'backup-invalid') { assert.throws(() => validate(text), (error: Error) => error.message === code); }
const edit = (records: string[], index: number, change: (value: Record<string, unknown>) => void) => records.map((line, i) => {
  if (i !== index) return line;
  const value = JSON.parse(line); change(value); return JSON.stringify(value) + '\n';
});
const at = (records: string[], type: string, nth = 0) => records.map((line, i) => [JSON.parse(line).type, i] as const).filter(([kind]) => kind === type)[nth]![1];

test('exporter output validates and counts memories, shared bytes, observations, variants, overlays, pending files and favorites', async t => {
  const { db } = await library(t); const records = await lines(db); const text = records.join('');
  const preview = validate(text);
  assert.deepEqual(preview, {
    memories: 2,           // one, two — not inflated by the shared object A or the repeated observation of one
    overlayOnly: 1,        // orphan
    variants: 1,           // two: A in job 1, C in job 2
    objects: 4, originalBytes: 65,
    sharedObjects: 1,      // A is used by one and two
    unreferencedObjects: 0,
    sources: 2, preserved: 6, pendingFiles: 1,
    favorites: 2, records: records.length,
  });
  // Any chunking gives the same result, including one character at a time across multi-byte boundaries.
  assert.deepEqual(validate(text, 1), preview); assert.deepEqual(validate(text, 7), preview);
});

test('an empty library backup validates with zero counts', async t => {
  const db = new DB(); t.after(() => db.raw.close()); await new ImportStore(db).initialize();
  const preview = validate((await lines(db)).join(''));
  assert.equal(preview.memories + preview.objects + preview.sources + preview.favorites, 0);
});

test('the inspection runner declares every object, verifies, reports progress and leaves the library untouched', async t => {
  const { db, store } = await library(t); const before = await store.summary();
  const text = (await lines(db)).join(''); let offset = 0; const declared: [string, number][] = []; const stages: string[] = []; let sealed = false, rounds = 0;
  const transport: InspectionTransport = {
    async readManifest() { const piece = text.slice(offset, offset + 50); offset += piece.length; return { text: piece, done: offset >= text.length }; },
    async declare(objects) { assert.equal(sealed, false); declared.push(...objects); },
    async seal() { sealed = true; },
    async verify() { rounds++; return { verified: rounds, total: 2, bytes: rounds * 10, totalBytes: 20, done: rounds === 2 }; },
  };
  const preview = await inspectBackup(transport, () => false, state => stages.push(state.stage));
  assert.equal(preview.memories, 2);
  assert.deepEqual(declared.map(([hash]) => hash), [A, B, C, D].map(item => item.sha256).sort());
  assert.deepEqual(stages, ['manifest', 'objects', 'objects']);
  assert.deepEqual(await store.summary(), before);
});

test('cancellation during manifest reading or verification stops before more work', async t => {
  const { db } = await library(t); const text = (await lines(db)).join('');
  let stopped = false, verifies = 0, reads = 0;
  const transport: InspectionTransport = {
    async readManifest() { reads++; if (reads === 2) stopped = true; return { text: text.slice((reads - 1) * 40, reads * 40), done: false }; },
    async declare() {}, async seal() {}, async verify() { verifies++; return { verified: 0, total: 1, bytes: 0, totalBytes: 1, done: false }; },
  };
  await assert.rejects(inspectBackup(transport, () => stopped, () => {}), /cancelled/);
  assert.equal(reads, 2); assert.equal(verifies, 0);
});

test('unsupported versions and malformed headers are refused', async t => {
  const { db } = await library(t); const records = await lines(db);
  rejects(edit(records, 0, value => { value.version = 2; }).join(''), 'backup-unsupported');
  rejects(edit(records, 0, value => { value.version = '1'; }).join(''));
  rejects(edit(records, 0, value => { value.format = 'other-backup'; }).join(''));
  rejects(records.slice(1).join(''));                                   // header missing
  rejects([records[0]!, ...records].join(''));                          // header twice
});

test('missing, trailing, duplicate and out-of-order records are refused', async t => {
  const { db } = await library(t); const records = await lines(db);
  rejects(records.slice(0, -1).join(''));                               // no end record
  rejects([...records, records.at(-1)!].join(''));                      // end twice
  rejects([...records, records[at(records, 'favorite')]!].join(''));    // record after end
  rejects(records.join('').slice(0, -1));                               // last line not terminated
  const objects = [at(records, 'object', 0), at(records, 'object', 1)];
  const swapped = [...records]; [swapped[objects[0]!], swapped[objects[1]!]] = [swapped[objects[1]!]!, swapped[objects[0]!]!];
  rejects(swapped.join(''));                                            // objects out of order
  rejects(records.flatMap((line, i) => i === objects[0] ? [line, line] : [line]).join('')); // duplicate object
  const sources = [at(records, 'source', 0), at(records, 'source', 1)];
  const reordered = [...records.slice(0, sources[0]), ...records.slice(sources[1], at(records, 'favorite')), ...records.slice(sources[0], sources[1]), ...records.slice(at(records, 'favorite'))];
  rejects(reordered.join(''));                                          // sources out of order
  const favorites = [at(records, 'favorite', 0), at(records, 'favorite', 1)];
  const favoriteSwap = [...records]; [favoriteSwap[favorites[0]!], favoriteSwap[favorites[1]!]] = [favoriteSwap[favorites[1]!]!, favoriteSwap[favorites[0]!]!];
  rejects(favoriteSwap.join(''));                                       // favorites unsorted
  rejects([...records.slice(0, at(records, 'object')), records[at(records, 'favorite')]!, ...records.slice(at(records, 'object'))].join('')); // favorite before sources
});

test('record syntax: unknown types, missing or extra keys, duplicate keys, whitespace and invalid JSON are refused', async t => {
  const { db } = await library(t); const records = await lines(db); const fav = at(records, 'favorite');
  const replace = (line: string) => [...records.slice(0, fav), line, ...records.slice(fav + 1)].join('');
  rejects(replace('{"type":"note","memoryId":"one"}\n'));
  rejects(replace('{"type":"favorite"}\n'));
  rejects(replace('{"type":"favorite","memoryId":"one","extra":1}\n'));
  rejects(replace('{"type":"favorite","memoryId":"two","memoryId":"one"}\n'));
  rejects(replace('{"type": "favorite","memoryId":"one"}\n'));
  rejects(replace('{"type":"favorite","memoryId":"\\u006fne"}\n'));
  rejects(replace('["favorite","one"]\n'));
  rejects(replace('{"type":"favorite","memoryId":"one"\n'));
  rejects(replace('{"type":"favorite","memoryId":"one"}\r\n'));
});

test('invalid hashes, paths, sizes and totals are refused', async t => {
  const { db } = await library(t); const records = await lines(db); const object = at(records, 'object'), end = records.length - 1;
  rejects(edit(records, object, value => { value.sha256 = String(value.sha256).toUpperCase(); }).join(''));
  rejects(edit(records, object, value => { value.relativePath = `objects/zz/${value.sha256}`; }).join(''));
  rejects(edit(records, object, value => { value.relativePath = `../${value.sha256}`; }).join(''));
  for (const bytes of [-1, 1.5, '10', 8 * 1024 ** 3 + 1, Number.MAX_SAFE_INTEGER + 1]) rejects(edit(records, object, value => { value.bytes = bytes; }).join(''));
  rejects(edit(records, end, value => { value.records = (value.records as number) + 1; }).join(''));
  rejects(edit(records, end, value => { value.objects = (value.objects as number) - 1; }).join(''));
  rejects(edit(records, end, value => { value.originalBytes = (value.originalBytes as number) + 1; }).join(''));
});

test('preserved observations must match their source inventory, ordinal and declared object', async t => {
  const { db } = await library(t); const records = await lines(db); const first = at(records, 'preserved');
  rejects(edit(records, first, value => { value.ordinal = 99; }).join(''));                  // outside the inventory
  rejects(edit(records, first, value => { value.ordinal = -1; }).join(''));
  rejects(edit(records, first, value => { value.memoryId = 'two'; }).join(''));              // identity disagrees with the file
  rejects(edit(records, first, value => { value.role = 'video'; }).join(''));                // role disagrees with the file
  rejects(edit(records, first, value => { value.sha256 = 'e'.repeat(64); }).join(''));       // object not declared
  rejects(edit(records, first, value => { value.archiveSha256 = job2; }).join(''));          // not the current source
  rejects(records.flatMap((line, i) => i === first ? [line, line] : [line]).join(''));      // duplicate observation
  rejects([...records.slice(0, at(records, 'source')), records[first]!, ...records.slice(at(records, 'source'))].join('')); // before any source
});

test('source inventories go through the saved-preview codec and must match their archive identity', async t => {
  const { db } = await library(t); const records = await lines(db); const source = at(records, 'source');
  rejects(edit(records, source, value => { (value.inventory as Record<string, unknown>).untrusted = 'https://synthetic.invalid/x'; }).join(''));
  rejects(edit(records, source, value => { value.archiveSha256 = '0'.repeat(64); }).join(''));
  rejects(edit(records, source, value => { (value.inventory as { format: number }).format = 2; }).join(''));
  rejects(edit(records, source, value => { ((value.inventory as { sources: { files: { relativePath: string }[] }[] }).sources[0]!.files[0]!).relativePath = '../x.jpg'; }).join(''));
});

test('favorites must name identities with preserved base media', async t => {
  const { db } = await library(t); const records = await lines(db); const fav = at(records, 'favorite');
  rejects(edit(records, fav, value => { value.memoryId = 'orphan'; }).join(''));   // overlay-only
  rejects(edit(records, fav, value => { value.memoryId = 'ghost'; }).join(''));    // never preserved
  rejects(edit(records, fav, value => { value.memoryId = 'pending'; }).join(''));  // pending only
});

test('line limits: ordinary records are short, and an endless line fails before it is complete', async t => {
  const { db } = await library(t); const records = await lines(db); const fav = at(records, 'favorite');
  const long = `{"type":"favorite","memoryId":"${'x'.repeat(MAX_RECORD_LINE)}"}\n`;
  assert.throws(() => validate([...records.slice(0, fav), long, ...records.slice(fav + 1)].join('')), /backup-limit/);
  const validator = new BackupManifestValidator();
  assert.throws(() => validator.push('x'.repeat(MAX_SOURCE_LINE + 1)), /backup-limit/);
});
