import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { personalAlias, personalCertificate } from './androidPersonal.ts';
import { sha256, within } from './androidPreview.ts';

const [argument] = process.argv.slice(2), java = process.env.JAVA_HOME;
if (!argument || !java) throw new Error('Set JAVA_HOME; usage: init-android-personal-key.ts <new-private-directory>');
const root = fileURLToPath(new URL('../', import.meta.url)), directory = resolve(argument);
if (within(root, directory) && !within(join(root, 'private'), directory)) throw new Error('personal-signing-use-private-folder');
if (existsSync(directory)) throw new Error('personal-signing-directory-exists');
process.umask(0o077);
mkdirSync(directory, { recursive: true, mode: 0o700 });
const keystore = join(directory, 'private-key.p12'), password = join(directory, 'password.txt');
writeFileSync(password, `${randomBytes(32).toString('hex')}\n`, { mode: 0o600, flag: 'wx' });
const keytool = join(java, 'bin/keytool');
execFileSync(keytool, ['-genkeypair', '-keystore', keystore, '-storetype', 'PKCS12', '-alias', personalAlias,
  '-storepass:file', password, '-keypass:file', password, '-keyalg', 'RSA', '-keysize', '4096', '-validity', '10000',
  '-dname', 'CN=Snarchive Personal Android', '-noprompt'], { stdio: 'pipe' });
chmodSync(keystore, 0o600);
const certificate = execFileSync(keytool, ['-exportcert', '-keystore', keystore, '-alias', personalAlias, '-storepass:file', password]);
const identity = { format: 1, alias: personalAlias, certificateSha256: personalCertificate(sha256(certificate)) };
writeFileSync(join(directory, 'identity.json'), `${JSON.stringify(identity, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
console.log(JSON.stringify({ directory, ...identity, note: 'Keep this directory private and back it up securely. Required for future updates. No password is printed.' }, null, 2));
