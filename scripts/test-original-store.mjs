import { mkdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const out = `${root}/work/original-store`;
mkdirSync(out, { recursive: true });
const jar = `${root}/work/zip-engine/zip4j-2.11.6.jar`;
try {
  if (createHash('sha256').update(readFileSync(jar)).digest('hex') !== '5f1eb1e9d67cfee200a695e4079751b49e73a226b154193e13f7c602efbe72fb') throw Error();
} catch { console.error('Missing ZIP engine. Follow docs/development.md for its pinned download.'); process.exit(1); }
const base = 'modules/snarchive-sources/android/src/main/java/com/alkval/snarchive/sources';
for (const [cmd, args] of [
  ['javac', ['--release', '8', '-cp', jar, '-d', `${out}/classes`, `${base}/zip/ArchiveSource.java`, `${base}/zip/ZipGuard.java`, `${base}/zip/ZipInventory.java`, `${base}/storage/OriginalStore.java`, `${base}/storage/ArchiveOriginals.java`, `${base}/storage/LruFileIndex.java`, `${base}/storage/FolderOriginals.java`, `${base}/storage/ThumbnailFiles.java`, `${base}/storage/ExportRepairSession.java`, `${base}/backup/InspectionGate.java`, 'tests/native/OriginalStoreTest.java', 'tests/native/FolderOriginalsTest.java', 'tests/native/OriginalRepairTest.java', 'tests/native/ExportRepairTest.java']],
  ['java', ['-Xmx128m', '-cp', `${out}/classes${process.platform === 'win32' ? ';' : ':'}${jar}`, 'OriginalStoreTest', out]],
  ['java', ['-Xmx128m', '-cp', `${out}/classes${process.platform === 'win32' ? ';' : ':'}${jar}`, 'FolderOriginalsTest', out]],
  ['java', ['-Xmx128m', '-cp', `${out}/classes${process.platform === 'win32' ? ';' : ':'}${jar}`, 'OriginalRepairTest', out]],
  ['java', ['-Xmx128m', '-cp', `${out}/classes${process.platform === 'win32' ? ';' : ':'}${jar}`, 'ExportRepairTest', out]],
]) {
  const result = spawnSync(cmd, args, { cwd: root, stdio: 'inherit' });
  if (result.error || result.status !== 0) process.exit(result.status ?? 1);
}
