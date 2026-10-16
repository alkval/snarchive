import { mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const output = fileURLToPath(new URL('../work/java-prototype/', import.meta.url));
mkdirSync(output, { recursive: true });
for (const [command, args] of [
  ['javac', ['--release', '8', '-d', output, 'prototypes/android/BoundedCopy.java']],
  ['javac', ['-cp', output, '-d', output, 'prototypes/android/BoundedCopyTest.java']],
  ['java', ['-Xmx128m', '-cp', output, 'snarchive.prototype.BoundedCopyTest', output]],
]) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' });
  if (result.error) { console.error(`${command} could not start. Check the local JDK installation.`); process.exit(1); }
  if (result.status !== 0) process.exit(result.status ?? 1);
}
