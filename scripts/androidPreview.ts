import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';

const required = ['App.tsx', 'index.ts', 'app.json', 'package.json', 'package-lock.json', 'tsconfig.json',
  'src', 'modules', 'tests', 'scripts', 'licenses', 'THIRD_PARTY_NOTICES.md'];
const optional = ['babel.config.js', 'metro.config.js', 'app.config.js', 'app.config.ts'];
const excluded = new Set(['build', 'dist', 'coverage', 'node_modules', '.git', '.gradle', '.expo', 'work', 'private', 'exports', 'backups', '.DS_Store']);
const secretOrProduct = /^(?:\.env(?:\..*)?|credentials\.json|local\.properties)$|\.(?:apk|aab|ipa|zip|jks|keystore|p12|mobileprovision|class|log)$/i;
export type InputFile = { path: string; bytes: number; sha256: string };
export type PreviewInputs = { format: 1; digest: string; files: InputFile[] };
export const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
function digest(files: InputFile[]) { return sha256(`snarchive-android-preview-inputs\n1\n${JSON.stringify(files)}`); }
export function within(parent: string, child: string) {
  const path = relative(parent, child);
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`));
}

/** Only build inputs enter the workspace. Reject links rather than following them outside the source tree. */
export function previewInputs(root: string): PreviewInputs {
  const files: InputFile[] = [];
  function walk(path: string) {
    const name = path.split('/').at(-1)!;
    if (excluded.has(name) || secretOrProduct.test(name)) return;
    const target = join(root, path), stat = lstatSync(target);
    if (stat.isSymbolicLink()) throw new Error(`preview-symlink: ${path}`);
    if (stat.isDirectory()) { for (const child of readdirSync(target).sort()) walk(`${path}/${child}`); }
    else if (stat.isFile()) { const bytes = readFileSync(target); files.push({ path, bytes: bytes.length, sha256: sha256(bytes) }); }
    else throw new Error(`preview-special-file: ${path}`);
  }
  for (const name of required) walk(name);
  for (const name of optional) if (existsSync(join(root, name))) walk(name);
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return { format: 1, digest: digest(files), files };
}

export function copyPreviewInputs(root: string, destination: string): PreviewInputs {
  const from = realpathSync(root), to = realpathSync(destination);
  if (within(from, to)) throw new Error('preview-inside-source');
  if (readdirSync(to).length) throw new Error('preview-destination-not-empty');
  const snapshot = previewInputs(from);
  for (const file of snapshot.files) {
    const bytes = readFileSync(join(from, file.path));
    if (sha256(bytes) !== file.sha256) throw new Error('preview-input-changed');
    const path = join(to, file.path); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, bytes, { flag: 'wx' });
  }
  writeFileSync(join(to, 'preview-inputs.json'), `${JSON.stringify(snapshot, null, 2)}\n`, { flag: 'wx' });
  verifyPreviewInputs(to);
  return snapshot;
}

/** Compare a fresh allowlisted scan, including added files. Never use paths supplied by the manifest to read files. */
export function verifyPreviewInputs(root: string): PreviewInputs {
  const expected: unknown = JSON.parse(readFileSync(join(root, 'preview-inputs.json'), 'utf8'));
  const actual = previewInputs(root);
  if (JSON.stringify(expected) !== JSON.stringify(actual)) throw new Error('preview-input-mismatch');
  return actual;
}

export function verifyApkEvidence(badging: string, entries: string, signer: string, certificateSha256: string,
  blockedPermissions: readonly string[]) {
  const applicationId = /^package: name='([^']+)'/m.exec(badging)?.[1];
  if (applicationId !== 'com.alkval.snarchive') throw new Error('preview-wrong-application');
  if (/^\s*application-debuggable\s*$/m.test(badging)) throw new Error('preview-debuggable');
  const abis = [...(badging.match(/^native-code:(.*)$/m)?.[1] ?? '').matchAll(/'([^']+)'/g)].map(m => m[1]!);
  if (abis.length !== 1 || abis[0] !== 'arm64-v8a') throw new Error('preview-wrong-architecture');
  if (!entries.split(/\r?\n/).includes('assets/index.android.bundle')) throw new Error('preview-missing-bundle');
  const count = /^Number of signers: (\d+)\s*$/m.exec(signer)?.[1];
  const certificates = [...signer.matchAll(/^(Signer #(\d+)|V\d+(?:\.\d+)? Signer):? certificate SHA-256 digest: ([a-fA-F0-9]{64})\s*$/gm)];
  const hashes = new Set(certificates.map(m => m[3]!.toLowerCase()));
  if (count !== '1' || hashes.size !== 1 || !hashes.has(certificateSha256) || certificates.some(m => m[2] && m[2] !== '1')) throw new Error('preview-wrong-signing-key');
  const permissions = [...badging.matchAll(/^uses-permission(?:-sdk-\d+)?: name='([^']+)'/gm)].map(m => m[1]!).sort();
  if (permissions.some(p => blockedPermissions.includes(p))) throw new Error('preview-blocked-permission');
  return { applicationId, debuggable: false, abis, certificateSha256, permissions };
}

// New permissions require a deliberate policy change, even if app.json forgot to block them.
export const previewPermissions = [
  'android.permission.ACCESS_NETWORK_STATE',
  'android.permission.INTERNET',
  'android.permission.WAKE_LOCK',
  'com.alkval.snarchive.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION',
] as const;

type ManifestNode = { name: string; indent: number; attributes: Map<string, string>; children: ManifestNode[] };
const androidNamespace = 'http://schemas.android.com/apk/res/android';
// Framework identities verified with SDK 37 aapt output, including a synthetic compiled manifest.
const privacyAttributes: Readonly<Record<string, string>> = {
  'android:allowBackup': '0x01010280',
  'android:usesCleartextTraffic': '0x010104ec',
  'android:debuggable': '0x0101000f',
  'android:testOnly': '0x01010272',
  'android:networkSecurityConfig': '0x01010527',
  'android:targetSdkVersion': '0x01010270',
  'android:name': '0x01010003',
  'android:value': '0x01010024',
};
const privacyAttributeIds = new Set(Object.values(privacyAttributes));

/** Parse SDK aapt's compiled XML tree, retaining element scope and typed values.
 * Reject unsupported evidence instead of interpreting resource references as booleans.
 */
export function verifyApkPrivacy(xmltree: string, permissions: readonly string[]) {
  if (permissions.some(p => !previewPermissions.some(allowed => allowed === p))) throw new Error('preview-unexpected-permission');
  const roots: ManifestNode[] = [], stack: ManifestNode[] = [];
  let hasAndroidNamespace = false;
  for (const line of xmltree.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const namespace = /^(\s*)N: ([\w.-]+)=(\S+)$/.exec(line);
    if (namespace) {
      if (namespace[2] === 'android') {
        // One unambiguous root binding; nested rebinding cannot change attribute identity.
        if (namespace[1] || roots.length || hasAndroidNamespace || namespace[3] !== androidNamespace)
          throw new Error('preview-invalid-android-namespace');
        hasAndroidNamespace = true;
      } else if (namespace[3] === androidNamespace) throw new Error('preview-invalid-android-namespace');
      continue;
    }
    const element = /^(\s*)E: ([\w.-]+) \(line=\d+\)$/.exec(line);
    if (element) {
      const indent = element[1]!.length;
      while (stack.length && stack.at(-1)!.indent >= indent) stack.pop();
      const node: ManifestNode = { name: element[2]!, indent, attributes: new Map(), children: [] };
      (stack.at(-1)?.children ?? roots).push(node); stack.push(node);
      continue;
    }
    const attribute = /^(\s*)A: ([\w:.-]+)(?:\((0x[\da-fA-F]+)\))?=(.+)$/.exec(line);
    const node = stack.at(-1);
    if (!attribute || !node || attribute[1]!.length <= node.indent || node.attributes.has(attribute[2]!))
      throw new Error('preview-invalid-manifest-evidence');
    const name = attribute[2]!, id = attribute[3]?.toLowerCase(), expectedId = privacyAttributes[name];
    if (name.startsWith('android:') && !hasAndroidNamespace) throw new Error('preview-invalid-android-namespace');
    if ((expectedId && id !== expectedId) || (id && privacyAttributeIds.has(id) && expectedId !== id))
      throw new Error('preview-invalid-attribute-identity');
    node.attributes.set(name, attribute[4]!);
  }
  if (!hasAndroidNamespace) throw new Error('preview-invalid-android-namespace');
  const manifest = roots.length === 1 && roots[0]!.name === 'manifest' ? roots[0]! : undefined;
  const sdk = manifest?.children.filter(n => n.name === 'uses-sdk') ?? [];
  // Revisit platform privacy behavior when upgrading the pinned target SDK.
  if (sdk.length !== 1 || sdk[0]!.attributes.get('android:targetSdkVersion') !== '(type 0x10)0x24')
    throw new Error('preview-unreviewed-target-sdk');
  const applications = manifest?.children.filter(n => n.name === 'application') ?? [];
  if (applications.length !== 1) throw new Error('preview-invalid-manifest-evidence');
  const application = applications[0]!;
  const isFalse = (value: string | undefined) => value === '(type 0x12)0x0';
  for (const name of ['allowBackup', 'usesCleartextTraffic']) {
    if (!isFalse(application.attributes.get(`android:${name}`))) throw new Error(`preview-unsafe-${name}`);
  }
  for (const name of ['debuggable', 'testOnly']) {
    const value = application.attributes.get(`android:${name}`);
    if (value !== undefined && !isFalse(value)) throw new Error(`preview-unsafe-${name}`);
  }
  if (application.attributes.has('android:networkSecurityConfig')) throw new Error('preview-network-security-override');
  const updates = application.children.filter(n => n.name === 'meta-data' &&
    n.attributes.get('android:name') === '"expo.modules.updates.ENABLED" (Raw: "expo.modules.updates.ENABLED")');
  if (updates.length !== 1 || !isFalse(updates[0]!.attributes.get('android:value'))) throw new Error('preview-updates-enabled-or-unknown');
  return { allowBackup: false, usesCleartextTraffic: false, updatesEnabled: false, networkSecurityConfig: false };
}
