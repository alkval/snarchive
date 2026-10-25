import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { copyPreviewInputs, previewInputs, verifyApkEvidence, verifyPreviewInputs, within } from '../scripts/androidPreview.ts';

function setup(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), 'snarchive-preview-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'source'), destination = join(root, 'destination'); mkdirSync(source); mkdirSync(destination);
  const put = (path: string, text = 'synthetic') => { const file = join(source, path); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text); };
  for (const name of ['App.tsx', 'index.ts', 'app.json', 'package.json', 'package-lock.json', 'tsconfig.json', 'THIRD_PARTY_NOTICES.md']) put(name);
  for (const name of ['src/a.ts', 'modules/local/android/Main.java', 'tests/a.test.ts', 'scripts/run.ts', 'licenses/MIT.txt']) put(name);
  return { root, source, destination, put };
}

test('Android preview copies only build inputs, excluding caches, private folders, archives and signing material', t => {
  const { source, destination, put } = setup(t);
  put('assets/icon.png', 'synthetic icon');
  for (const path of ['exports/private.jpg', '.env', 'android/app/debug.keystore', 'src/.env.local', 'src/credentials.json',
    'modules/local/android/build/classes/Main.class', 'modules/local/android/.gradle/cache', 'modules/local/android/debug.keystore',
    'tests/private/input.json', 'tests/export.zip', 'scripts/work/data.json', 'src/node_modules/a.js']) put(path);
  const snapshot = copyPreviewInputs(source, destination);
  assert.equal(snapshot.files.length, 13);
  assert.equal(readFileSync(join(destination, 'assets/icon.png'), 'utf8'), 'synthetic icon');
  assert.equal(snapshot.files.find(f => f.path === 'src/a.ts')?.bytes, 9);
  assert.deepEqual(verifyPreviewInputs(destination), snapshot);
  assert.equal(readFileSync(join(destination, 'modules/local/android/Main.java'), 'utf8'), 'synthetic');
});

test('preview refuses symlinks before copying any file', t => {
  const { root, source, destination } = setup(t);
  const outside = join(root, 'outside'); writeFileSync(outside, 'never copy');
  symlinkSync(outside, join(source, 'src/link.ts'));
  assert.throws(() => copyPreviewInputs(source, destination), /preview-symlink/);
  assert.deepEqual(readdirSync(destination), []);
});

test('preview refuses occupied destinations and descendants including dot-dot-prefixed names', t => {
  const { source, destination } = setup(t);
  writeFileSync(join(destination, 'keep'), 'keep');
  assert.throws(() => copyPreviewInputs(source, destination), /not-empty/);
  assert.equal(readFileSync(join(destination, 'keep'), 'utf8'), 'keep');
  const nested = join(source, '..preview'); mkdirSync(nested);
  assert.equal(within(source, nested), true);
  assert.throws(() => copyPreviewInputs(source, nested), /inside-source/);
  assert.equal(within(source, destination), false);
});

test('verification detects modified, added and removed inputs, including optional configuration', t => {
  const { source, destination } = setup(t); copyPreviewInputs(source, destination);
  const file = join(destination, 'src/a.ts'); writeFileSync(file, 'changed');
  assert.throws(() => verifyPreviewInputs(destination), /mismatch/); writeFileSync(file, 'synthetic');
  writeFileSync(join(destination, 'src/extra.java'), 'extra'); assert.throws(() => verifyPreviewInputs(destination), /mismatch/);
  unlinkSync(join(destination, 'src/extra.java')); writeFileSync(join(destination, 'metro.config.js'), 'extra config');
  assert.throws(() => verifyPreviewInputs(destination), /mismatch/); unlinkSync(join(destination, 'metro.config.js'));
  unlinkSync(file); assert.throws(() => verifyPreviewInputs(destination), /mismatch/);
});

test('a forged manifest never chooses paths to read; input digests are independent of the workspace path', t => {
  const { source, destination } = setup(t); const before = previewInputs(source); copyPreviewInputs(source, destination);
  assert.equal(previewInputs(destination).digest, before.digest);
  writeFileSync(join(destination, 'preview-inputs.json'), JSON.stringify({ format: 1, files: [{ path: '../../outside' }] }));
  assert.throws(() => verifyPreviewInputs(destination), /mismatch/);
  writeFileSync(join(source, 'src/a.ts'), 'new bytes'); assert.notEqual(previewInputs(source).digest, before.digest);
});

const certificate = 'a'.repeat(64);
const badging = "package: name='com.alkval.snarchive' versionCode='1'\nnative-code: 'arm64-v8a'\nuses-permission: name='android.permission.INTERNET'\n";
const entries = 'classes.dex\nassets/index.android.bundle\nlib/arm64-v8a/libhermes.so\n';
const signer = `Number of signers: 1\nSigner #1 certificate SHA-256 digest: ${certificate}\n`;

test('APK evidence records the package, single ARM64 ABI, development certificate and declared permissions', () => {
  assert.deepEqual(verifyApkEvidence(badging, entries, signer, certificate, ['android.permission.CAMERA']), {
    applicationId: 'com.alkval.snarchive', debuggable: false, abis: ['arm64-v8a'], certificateSha256: certificate,
    permissions: ['android.permission.INTERNET'],
  });
});

test('APK evidence rejects a debug build, missing bundle, wrong application or ABI, and blocked permissions', () => {
  for (const data of [badging + 'application-debuggable\n', badging + '  application-debuggable  \n'])
    assert.throws(() => verifyApkEvidence(data, entries, signer, certificate, []), /debuggable/);
  assert.throws(() => verifyApkEvidence(badging, 'classes.dex\n', signer, certificate, []), /missing-bundle/);
  assert.throws(() => verifyApkEvidence(badging.replace('com.alkval.snarchive', 'other'), entries, signer, certificate, []), /application/);
  for (const abi of ["'x86_64'", "'arm64-v8a' 'x86_64'", ''])
    assert.throws(() => verifyApkEvidence(badging.replace("'arm64-v8a'", abi), entries, signer, certificate, []), /architecture/);
  assert.throws(() => verifyApkEvidence(badging, entries, signer, certificate, ['android.permission.INTERNET']), /permission/);
});

test('APK evidence rejects missing, mismatched or multiple signing certificates', () => {
  for (const text of ['', signer.replace(certificate, 'b'.repeat(64)), signer + `Signer #2 certificate SHA-256 digest: ${certificate}\n`])
    assert.throws(() => verifyApkEvidence(badging, entries, text, certificate, []), /signing-key/);
});

test('SDK 37 scheme-labelled certificates are checked once per identity, with a single signer required', () => {
  const current = `Number of signers: 1\nV2 Signer: certificate SHA-256 digest: ${certificate}\nV3.1 Signer: certificate SHA-256 digest: ${certificate}\n`;
  assert.equal(verifyApkEvidence(badging, entries, current, certificate, []).certificateSha256, certificate);
  for (const text of [current.replace('signers: 1', 'signers: 2'), current.replace(`V3.1 Signer: certificate SHA-256 digest: ${certificate}`, `V3.1 Signer: certificate SHA-256 digest: ${'b'.repeat(64)}`), current.replace('Number of signers: 1\n', '')])
    assert.throws(() => verifyApkEvidence(badging, entries, text, certificate, []), /signing-key/);
});
