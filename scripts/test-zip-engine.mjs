import { mkdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const out = `${root}/work/zip-engine`;
mkdirSync(out, { recursive: true });
const jar = `${out}/zip4j-2.11.6.jar`;
const expected = '5f1eb1e9d67cfee200a695e4079751b49e73a226b154193e13f7c602efbe72fb';
try { if (createHash('sha256').update(readFileSync(jar)).digest('hex') !== expected) throw Error(); }
catch { console.error('Missing or unexpected ZIP engine. See docs/development.md for the pinned download and checksum.'); process.exit(1); }
const sources = ['ZipGuard.java', 'ZipInventory.java'].map(name => `modules/snarchive-sources/android/src/main/java/com/alkval/snarchive/sources/zip/${name}`);
for (const [cmd, args] of [
  ['python3', ['scripts/generate-zip-fixtures.py', `${out}/fixtures`]],
  ['javac', ['--release', '8', '-cp', jar, '-d', `${out}/classes`, ...sources, 'tests/native/ZipInventoryTest.java']],
  ['java', ['-Xmx128m', '-cp', `${out}/classes${process.platform === 'win32' ? ';' : ':'}${jar}`, 'ZipInventoryTest', `${out}/fixtures`]],
]) {
  const result = spawnSync(cmd, args, { cwd: root, stdio: 'inherit' });
  if (result.error || result.status !== 0) process.exit(result.status ?? 1);
}
