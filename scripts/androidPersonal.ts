import { lstatSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const personalAlias = 'snarchive-personal';
export const templateCertificate = 'fac61745dc0903786fb9ede62a962b399f7348f0bb6f899b8332667591033b9c';
export function personalCertificate(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-fA-F0-9]{64}$/.test(value)) throw new Error('personal-invalid-certificate');
  const hash = value.toLowerCase();
  if (hash === templateCertificate) throw new Error('personal-public-template-key');
  return hash;
}
function privatePath(path: string, directory = false) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile()) ||
      (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid()))
    throw new Error('personal-signing-permissions');
}
export function readPersonalSigning(directory: string) {
  const root = resolve(directory); privatePath(root, true);
  const keystore = join(root, 'private-key.p12'), password = join(root, 'password.txt'), identity = join(root, 'identity.json');
  for (const path of [keystore, password, identity]) privatePath(path);
  const record = JSON.parse(readFileSync(identity, 'utf8'));
  if (record?.format !== 1 || record?.alias !== personalAlias) throw new Error('personal-signing-identity');
  return { root, keystore, password, alias: personalAlias, certificateSha256: personalCertificate(record.certificateSha256) };
}
