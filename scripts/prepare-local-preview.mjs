import { cpSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Copy only development inputs. Never copy private exports, caches, or signing keys.
const root = fileURLToPath(new URL('../', import.meta.url));
const destination = mkdtempSync(join(tmpdir(), 'snarchive-preview-'));
for (const name of ['App.tsx', 'index.ts', 'app.json', 'package.json', 'package-lock.json',
  'tsconfig.json', 'src', 'modules', 'tests', 'scripts', 'licenses', 'THIRD_PARTY_NOTICES.md']) {
  cpSync(join(root, name), join(destination, name), { recursive: true });
}
console.log(`Prepared a temporary preview workspace:\n${destination}`);
console.log('In that directory, run npm ci, then npm run check and npm start -- --localhost --max-workers 2.');
console.log('For bundle checks, run npx expo export --platform all --max-workers 2.');
console.log('This is a source snapshot. Make edits in the main project and prepare a new copy afterward.');
console.log('Do not store private exports here. Temporary files may be removed by the operating system.');
