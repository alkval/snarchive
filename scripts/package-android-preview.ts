import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { sha256, verifyApkEvidence, verifyApkPrivacy, verifyPreviewInputs, within } from './androidPreview.ts';

const [workspaceArg, output] = process.argv.slice(2);
if (!workspaceArg || !output) throw new Error('Usage: package-android-preview.ts <workspace> <new-output-directory>');
if (existsSync(output)) throw new Error('preview-output-exists');
const workspace = realpathSync(workspaceArg), inputs = verifyPreviewInputs(workspace);
const destination = join(realpathSync(dirname(resolve(output))), basename(resolve(output)));
if (within(workspace, destination)) throw new Error('preview-output-inside-workspace');
const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
const java = process.env.JAVA_HOME;
if (!sdk || !java) throw new Error('Set ANDROID_HOME and JAVA_HOME');
const tools = join(sdk, 'build-tools', process.env.SNARCHIVE_BUILD_TOOLS ?? '37.0.0');
const apk = join(workspace, 'android/app/build/outputs/apk/release/app-release.apk');
const apkBytes = readFileSync(apk), apkHash = sha256(apkBytes);
const mapping = join(workspace, 'android/app/build/outputs/mapping/release/mapping.txt');
if (!statSync(mapping).size) throw new Error('preview-missing-r8-mapping');
// This workspace file defaults to Expo's shared public template key, not a freshly generated private key.
const keystore = join(workspace, 'android/app/debug.keystore'), keystoreBytes = readFileSync(keystore);
const signingKeystore = { path: 'android/app/debug.keystore', sha256: sha256(keystoreBytes), bytes: keystoreBytes.length,
  alias: 'androiddebugkey' };
const certificate = execFileSync(join(java, 'bin/keytool'), ['-exportcert', '-keystore', keystore, '-alias', signingKeystore.alias, '-storepass', 'android']);
const run = (tool: string, args: string[]) => execFileSync(join(tools, tool), args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
const badging = run('aapt', ['dump', 'badging', apk]);
const entries = run('aapt', ['list', apk]);
const signer = run('apksigner', ['verify', '--verbose', '--print-certs', apk]);
const config = JSON.parse(readFileSync(join(workspace, 'app.json'), 'utf8'));
const evidence = verifyApkEvidence(badging, entries, signer, sha256(certificate), config.expo.android.blockedPermissions);
const privacy = verifyApkPrivacy(run('aapt', ['dump', 'xmltree', apk, 'AndroidManifest.xml']), evidence.permissions);
const bundle = execFileSync('unzip', ['-p', apk, 'assets/index.android.bundle'], { maxBuffer: 128 * 1024 * 1024 });
if (!bundle.length) throw new Error('preview-empty-bundle');
if (sha256(readFileSync(apk)) !== apkHash) throw new Error('preview-apk-changed');
if (sha256(readFileSync(keystore)) !== signingKeystore.sha256) throw new Error('preview-keystore-changed');
verifyPreviewInputs(workspace);
const report = { format: 1, purpose: 'Local ARM64 Android preview; shared public template debug key by default; never use with real data; not for publication',
  inputs: inputs.digest, lockfile: sha256(readFileSync(join(workspace, 'package-lock.json'))),
  signingKeystore,
  apk: { sha256: sha256(apkBytes), bytes: apkBytes.length, ...evidence, privacy },
  bundle: { sha256: sha256(bundle), bytes: bundle.length }, r8Mapping: { sha256: sha256(readFileSync(mapping)), bytes: statSync(mapping).size } };
mkdirSync(output); // Fail rather than overwrite a directory that appeared during verification.
writeFileSync(join(output, 'snarchive-android-preview-arm64.apk'), apkBytes, { flag: 'wx' });
writeFileSync(join(output, 'build-info.json'), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
writeFileSync(join(output, 'preview-inputs.json'), `${JSON.stringify(inputs, null, 2)}\n`, { flag: 'wx' });
console.log(JSON.stringify({ output, ...report }, null, 2));
