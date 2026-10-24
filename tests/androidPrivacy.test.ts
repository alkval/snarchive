import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { previewPermissions, verifyApkPrivacy } from '../scripts/androidPreview.ts';

const require = createRequire(import.meta.url);
const { applyPrivacyManifest } = require('../scripts/withAndroidPrivacy.cjs');
const manifest = `N: android=http://schemas.android.com/apk/res/android
  E: manifest (line=2)
    E: uses-sdk (line=7)
      A: android:targetSdkVersion(0x01010270)=(type 0x10)0x24
    E: application (line=10)
      A: android:allowBackup(0x01010280)=(type 0x12)0x0
      A: android:usesCleartextTraffic(0x010104ec)=(type 0x12)0x0
      E: meta-data (line=13)
        A: android:name(0x01010003)="expo.modules.updates.ENABLED" (Raw: "expo.modules.updates.ENABLED")
        A: android:value(0x01010024)=(type 0x12)0x0
      E: activity (line=16)
        A: android:name(0x01010003)="MainActivity" (Raw: "MainActivity")
        A: android:exported(0x01010010)=(type 0x12)0xffffffff
`;
const expected = { allowBackup: false, usesCleartextTraffic: false, updatesEnabled: false, networkSecurityConfig: false };

test('privacy prebuild policy sets explicit main-manifest restrictions and preserves other attributes', () => {
  const application = { $: { 'android:allowBackup': 'true', 'android:usesCleartextTraffic': 'true', 'android:theme': '@style/AppTheme' } };
  const value = { manifest: { application: [application] } };
  assert.equal(applyPrivacyManifest(value), value);
  assert.deepEqual(application.$, { 'android:allowBackup': 'false', 'android:usesCleartextTraffic': 'false', 'android:theme': '@style/AppTheme' });
  assert.deepEqual(applyPrivacyManifest(value), value);
});

test('privacy prebuild refuses absent or ambiguous application elements', () => {
  for (const application of [undefined, [], [{}, {}], [{}]])
    assert.throws(() => applyPrivacyManifest({ manifest: { application } }), /application-missing/);
});

test('compiled privacy policy accepts explicit false flags and current permitted dependency permissions', () => {
  assert.deepEqual(verifyApkPrivacy(manifest, previewPermissions), expected);
  assert.deepEqual(verifyApkPrivacy(manifest, []), expected);
  const flags = '      A: android:debuggable(0x0101000f)=(type 0x12)0x0\n      A: android:testOnly(0x01010272)=(type 0x12)0x0\n';
  assert.deepEqual(verifyApkPrivacy(manifest.replace('      E: meta-data', flags + '      E: meta-data'), previewPermissions), expected);
});

test('permission policy refuses any added permission, including special access and future dependencies', () => {
  for (const permission of ['android.permission.SYSTEM_ALERT_WINDOW', 'android.permission.CAMERA', 'android.permission.POST_NOTIFICATIONS', 'com.other.CUSTOM'])
    assert.throws(() => verifyApkPrivacy(manifest, [...previewPermissions, permission]), /unexpected-permission/);
});

test('a target SDK change requires revisiting the privacy policy before collection', () => {
  for (const value of ['(type 0x10)0x25', '(type 0x10)0x26', '@0x7f010001'])
    assert.throws(() => verifyApkPrivacy(manifest.replace('(type 0x10)0x24', value), previewPermissions), /unreviewed-target-sdk/);
});

test('backup and cleartext restrictions must be explicit typed booleans, never missing or resource references', () => {
  for (const attribute of ['allowBackup', 'usesCleartextTraffic']) {
    const line = manifest.split('\n').find(line => line.includes(`android:${attribute}`))!;
    for (const replacement of ['', line.replace('0x12)0x0', '0x12)0xffffffff'), line.replace('(type 0x12)0x0', '@0x7f010001'), line.replace('(type 0x12)0x0', '"false" (Raw: "false")')])
      assert.throws(() => verifyApkPrivacy(manifest.replace(line, replacement), previewPermissions), new RegExp(`unsafe-${attribute}`));
  }
});

test('compiled policy rejects debuggable, testOnly and network-security overrides', () => {
  for (const [attribute, id] of [['debuggable', '0x0101000f'], ['testOnly', '0x01010272'], ['networkSecurityConfig', '0x01010527']]) {
    const line = `      A: android:${attribute}(${id})=${attribute === 'networkSecurityConfig' ? '@0x7f150001' : '(type 0x12)0xffffffff'}\n`;
    assert.throws(() => verifyApkPrivacy(manifest.replace('      E: meta-data', line + '      E: meta-data'), previewPermissions), /unsafe-|network-security-override/);
  }
});

test('updates must be disabled once directly on the application, not on an activity', () => {
  const metadata = manifest.slice(manifest.indexOf('      E: meta-data'), manifest.indexOf('      E: activity'));
  for (const text of [manifest.replace(metadata, ''), manifest.replace('android:value(0x01010024)=(type 0x12)0x0', 'android:value(0x01010024)=(type 0x12)0xffffffff'), manifest.replace(metadata, metadata + metadata),
    manifest.replace(metadata, '') + metadata.split('\n').map(line => line ? `  ${line}` : '').join('\n')])
    assert.throws(() => verifyApkPrivacy(text, previewPermissions), /updates-enabled-or-unknown/);
});

test('nested attributes cannot masquerade as application privacy flags', () => {
  const flags = manifest.split('\n').filter(line => /android:(allowBackup|usesCleartextTraffic)/.test(line));
  let text = manifest;
  for (const line of flags) text = text.replace(line + '\n', '');
  text += flags.map(line => `  ${line}\n`).join('');
  assert.throws(() => verifyApkPrivacy(text, previewPermissions), /unsafe-allowBackup/);
});

test('privacy policy fails closed for malformed, duplicate or ambiguous manifest evidence', () => {
  const line = manifest.split('\n').find(line => line.includes('android:allowBackup'))!;
  for (const text of ['', 'unrecognized output', manifest.replace(line, line + '\n' + line), manifest + '    E: application (line=20)\n', manifest + '  E: manifest (line=30)\n'])
    assert.throws(() => verifyApkPrivacy(text, previewPermissions), /invalid-manifest-evidence|unreviewed-target-sdk|invalid-android-namespace/);
});

const attributes = [
  ['allowBackup', '0x01010280'], ['usesCleartextTraffic', '0x010104ec'], ['debuggable', '0x0101000f'],
  ['testOnly', '0x01010272'], ['networkSecurityConfig', '0x01010527'], ['targetSdkVersion', '0x01010270'],
  ['name', '0x01010003'], ['value', '0x01010024'],
] as const;
function withOptionalAttribute(name: string, id: string) {
  return manifest.includes(`android:${name}(`) ? manifest : manifest.replace('      E: meta-data',
    `      A: android:${name}(${id})=(type 0x12)0x0\n      E: meta-data`);
}

test('privacy attributes require framework IDs, including the reproduced ID-less false flags', () => {
  for (const [name, id] of attributes) {
    const text = withOptionalAttribute(name, id).replace(`android:${name}(${id})`, `android:${name}`);
    assert.throws(() => verifyApkPrivacy(text, previewPermissions), /invalid-attribute-identity/, name);
  }
});

test('printed privacy names cannot hide app resource IDs or other framework attribute IDs', () => {
  for (const [name, id] of attributes) {
    for (const wrongId of ['0x7f010099', name === 'allowBackup' ? '0x010104ec' : '0x01010280']) {
      const text = withOptionalAttribute(name, id).replace(`android:${name}(${id})`, `android:${name}(${wrongId})`);
      assert.throws(() => verifyApkPrivacy(text, previewPermissions), /invalid-attribute-identity/, name);
    }
  }
});

test('a framework privacy resource ID cannot be relabelled as an unrelated attribute', () => {
  for (const [name, id] of attributes) {
    const text = withOptionalAttribute(name, id).replace(`android:${name}(${id})`, `android:unrelated(${id})`);
    assert.throws(() => verifyApkPrivacy(text, previewPermissions), /invalid-attribute-identity/, name);
  }
});

test('privacy evidence requires one root Android namespace binding without aliases or rebinding', () => {
  const namespace = 'N: android=http://schemas.android.com/apk/res/android\n';
  for (const text of [
    manifest.replace(namespace, ''), manifest.replace(namespace, 'N: android=https://example.invalid/foreign\n'),
    manifest.replace(namespace, namespace + namespace), manifest.replace(namespace, ` ${namespace}`),
    manifest.replace('      E: meta-data', '      N: android=http://schemas.android.com/apk/res/android\n      E: meta-data'),
    manifest.replace(namespace, namespace + 'N: alias=http://schemas.android.com/apk/res/android\n'),
  ]) assert.throws(() => verifyApkPrivacy(text, previewPermissions), /invalid-android-namespace/);
});
