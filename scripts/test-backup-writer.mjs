import { mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const out = `${root}/work/backup-writer`;
mkdirSync(out, { recursive: true });
const base = 'modules/snarchive-sources/android/src/main/java/com/alkval/snarchive/sources';
for (const [cmd, args] of [
  ['javac', ['--release', '8', '-d', `${out}/classes`, `${base}/storage/OriginalStore.java`, `${base}/backup/BackupWriter.java`, `${base}/backup/BackupSession.java`, 'tests/native/BackupWriterTest.java', 'tests/native/BackupSessionTest.java']],
  ['java', ['-Xmx64m', '-cp', `${out}/classes`, 'BackupWriterTest', out]],
  ['java', ['-Xmx64m', '-cp', `${out}/classes`, 'BackupSessionTest', out]],
]) {
  const result = spawnSync(cmd, args, { cwd: root, stdio: 'inherit' });
  if (result.error || result.status !== 0) process.exit(result.status ?? 1);
}
