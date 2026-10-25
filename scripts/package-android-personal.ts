import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { readPersonalSigning } from './androidPersonal.ts';
import { sha256, verifyApkEvidence, verifyApkPrivacy, verifyPreviewInputs, within } from './androidPreview.ts';

const [workspaceArg, signingArg, output] = process.argv.slice(2);
if (!workspaceArg || !signingArg || !output) throw new Error('Usage: package-android-personal.ts <workspace> <private-signing-directory> <new-output-directory>');
if (existsSync(output)) throw new Error('personal-output-exists');
const workspace = realpathSync(workspaceArg), inputs = verifyPreviewInputs(workspace), signing = readPersonalSigning(signingArg);
const destination = join(realpathSync(dirname(resolve(output))), basename(resolve(output)));
if (within(workspace, destination) || within(workspace, signing.root) || within(signing.root, destination)) throw new Error('personal-unsafe-output-location');
const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT, java = process.env.JAVA_HOME;
if (!sdk || !java) throw new Error('Set ANDROID_HOME and JAVA_HOME');
const tools = join(sdk, 'build-tools', process.env.SNARCHIVE_BUILD_TOOLS ?? '37.0.0');
const sourceApk = join(workspace, 'android/app/build/outputs/apk/release/app-release.apk');
const sourceHash = sha256(readFileSync(sourceApk)), keyHash = sha256(readFileSync(signing.keystore));
const certificate = execFileSync(join(java, 'bin/keytool'), ['-exportcert', '-keystore', signing.keystore,
  '-alias', signing.alias, '-storepass:file', signing.password]);
if (sha256(certificate) !== signing.certificateSha256) throw new Error('personal-signing-certificate-changed');
const mapping = readFileSync(join(workspace, 'android/app/build/outputs/mapping/release/mapping.txt'));
if (!mapping.length) throw new Error('personal-missing-r8-mapping');
const temporary = mkdtempSync(join(tmpdir(), 'snarchive-personal-sign-'));
try {
  const apk = join(temporary, 'signed.apk');
  // apksigner strips the template signatures. The private key never enters the build workspace.
  execFileSync(join(tools, 'apksigner'), ['sign', '--ks', signing.keystore, '--ks-key-alias', signing.alias,
    '--ks-pass', `file:${signing.password}`,
    '--v4-signing-enabled', 'false', '--out', apk, sourceApk]);
  const run = (tool: string, args: string[]) => execFileSync(join(tools, tool), args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  const evidence = verifyApkEvidence(run('aapt', ['dump', 'badging', apk]), run('aapt', ['list', apk]),
    run('apksigner', ['verify', '--verbose', '--print-certs', apk]), signing.certificateSha256,
    JSON.parse(readFileSync(join(workspace, 'app.json'), 'utf8')).expo.android.blockedPermissions);
  const privacy = verifyApkPrivacy(run('aapt', ['dump', 'xmltree', apk, 'AndroidManifest.xml']), evidence.permissions);
  const bundle = execFileSync('unzip', ['-p', apk, 'assets/index.android.bundle'], { maxBuffer: 128 * 1024 * 1024 });
  if (!bundle.length) throw new Error('personal-empty-bundle');
  if (sha256(readFileSync(sourceApk)) !== sourceHash || sha256(readFileSync(signing.keystore)) !== keyHash)
    throw new Error('personal-signing-input-changed');
  verifyPreviewInputs(workspace);
  const bytes = readFileSync(apk);
  const report = { format: 1, purpose: 'Privately signed personal Android test build; physical-device acceptance pending; not for publication',
    inputs: inputs.digest, sourceApkSha256: sourceHash, signing: { alias: signing.alias, certificateSha256: signing.certificateSha256 },
    apk: { sha256: sha256(bytes), bytes: bytes.length, ...evidence, privacy },
    bundle: { sha256: sha256(bundle), bytes: bundle.length }, r8Mapping: { sha256: sha256(mapping), bytes: mapping.length } };
  mkdirSync(output);
  writeFileSync(join(output, 'snarchive-personal-android-arm64.apk'), bytes, { flag: 'wx' });
  writeFileSync(join(output, 'build-info.json'), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  writeFileSync(join(output, 'preview-inputs.json'), `${JSON.stringify(inputs, null, 2)}\n`, { flag: 'wx' });
  writeFileSync(join(output, 'mapping.txt.gz'), gzipSync(mapping), { flag: 'wx' });
  console.log(JSON.stringify({ output, ...report }, null, 2));
} finally { rmSync(temporary, { recursive: true, force: true }); }
