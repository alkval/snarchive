import { mkdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const out = `${root}/work/backup-inspection`;
mkdirSync(out, { recursive: true });
const jar = `${root}/work/zip-engine/zip4j-2.11.6.jar`;
try {
  if (createHash('sha256').update(readFileSync(jar)).digest('hex') !== '5f1eb1e9d67cfee200a695e4079751b49e73a226b154193e13f7c602efbe72fb') throw Error();
} catch { console.error('Missing ZIP engine. Follow docs/development.md for its pinned download.'); process.exit(1); }
const base = 'modules/snarchive-sources/android/src/main/java/com/alkval/snarchive/sources';
const sources = ['zip/ArchiveSource.java', 'zip/ZipGuard.java', 'zip/ZipInventory.java', 'storage/OriginalStore.java', 'backup/BackupWriter.java', 'backup/BackupInspection.java', 'backup/InspectionGate.java'].map(name => `${base}/${name}`);
const classpath = `${out}/classes${process.platform === 'win32' ? ';' : ':'}${jar}`;
for (const [cmd, args] of [
  ['javac', ['--release', '8', '-cp', jar, '-d', `${out}/classes`, ...sources, 'tests/native/BackupInspectionTest.java']],
  // 128 MiB: the ZIP64 case keeps 65,601 parsed headers; manifest and objects are streamed.
  ['java', ['-Xmx128m', '-cp', classpath, 'BackupInspectionTest', out]],
]) {
  const result = spawnSync(cmd, args, { cwd: root, stdio: 'inherit' });
  if (result.error || result.status !== 0) process.exit(result.status ?? 1);
}
