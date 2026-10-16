import { mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const output = fileURLToPath(new URL('../work/swift-prototype/', import.meta.url));
mkdirSync(output, { recursive: true });
for (const [command, args] of [
  ['xcrun', ['swiftc', '-module-cache-path', `${output}/cache`, 'modules/snarchive-sources/ios/DirectoryInventory.swift', 'prototypes/apple/main.swift', '-o', `${output}/scan-tests`]],
  [`${output}/scan-tests`, [output]],
]) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' });
  if (result.error) { console.error('The Swift test toolchain could not start. macOS and Xcode are required.'); process.exit(1); }
  if (result.status !== 0) process.exit(result.status ?? 1);
}
