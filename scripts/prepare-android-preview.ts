import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyPreviewInputs } from './androidPreview.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const workspace = mkdtempSync(join(process.argv[2] ?? tmpdir(), 'snarchive-android-preview-'));
const inputs = copyPreviewInputs(root, workspace);
console.log(JSON.stringify({ workspace, inputDigest: inputs.digest, files: inputs.files.length }, null, 2));
console.log('Use the pinned dependencies: npm ci --no-audit --no-fund');
console.log('Generate Android: npx expo prebuild --platform android --no-install');
console.log('Then in android/: ./gradlew :app:assembleRelease --no-daemon --max-workers=2 -PreactNativeArchitectures=arm64-v8a -Pandroid.enableMinifyInReleaseBuilds=true');
console.log('Requires a compatible JDK and Android SDK. This uses the generated development signing key, for local testing only.');
