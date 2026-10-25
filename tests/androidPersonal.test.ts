import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { personalAlias, personalCertificate, readPersonalSigning, templateCertificate } from '../scripts/androidPersonal.ts';

function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), 'snarchive-personal-test-')); chmodSync(root, 0o700);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const name of ['private-key.p12', 'password.txt']) writeFileSync(join(root, name), 'synthetic', { mode: 0o600 });
  const identity = join(root, 'identity.json');
  writeFileSync(identity, JSON.stringify({ format: 1, alias: personalAlias, certificateSha256: 'a'.repeat(64) }), { mode: 0o600 });
  return { root, identity };
}
test('personal builds refuse the shared public template certificate, in either case', () => {
  for (const hash of [templateCertificate, templateCertificate.toUpperCase()]) assert.throws(() => personalCertificate(hash), /public-template-key/);
});
test('personal certificate fingerprints must be complete SHA-256 values', () => {
  for (const hash of [null, '', 'a'.repeat(63), 'z'.repeat(64), ` ${'a'.repeat(64)}`]) assert.throws(() => personalCertificate(hash), /invalid-certificate/);
  assert.equal(personalCertificate('A'.repeat(64)), 'a'.repeat(64));
});
test('signing identity pins a certificate while returning only local secret paths', t => {
  const { root } = fixture(t), result = readPersonalSigning(root);
  assert.equal(result.certificateSha256, 'a'.repeat(64)); assert.equal(result.alias, personalAlias);
  assert.equal(result.password, join(root, 'password.txt'));
});
test('group-readable signing secrets are refused', t => {
  const { root } = fixture(t); chmodSync(join(root, 'private-key.p12'), 0o640);
  assert.throws(() => readPersonalSigning(root), /signing-permissions/);
});
test('signing secret symlinks are refused', t => {
  const { root } = fixture(t); rmSync(join(root, 'password.txt'));
  symlinkSync('identity.json', join(root, 'password.txt')); assert.throws(() => readPersonalSigning(root), /signing-permissions/);
});
test('signing directories accessible to other users are refused', t => {
  const { root } = fixture(t); chmodSync(root, 0o755); assert.throws(() => readPersonalSigning(root), /signing-permissions/);
});
test('a different alias or metadata version cannot silently replace the signing identity', t => {
  const { root, identity } = fixture(t);
  for (const record of [{ format: 2, alias: personalAlias }, { format: 1, alias: 'androiddebugkey' }]) {
    writeFileSync(identity, JSON.stringify({ ...record, certificateSha256: 'a'.repeat(64) }));
    assert.throws(() => readPersonalSigning(root), /signing-identity/);
  }
});
test('a directory cannot stand in for a signing secret', t => {
  const { root } = fixture(t); rmSync(join(root, 'private-key.p12')); mkdirSync(join(root, 'private-key.p12'), { mode: 0o700 });
  assert.throws(() => readPersonalSigning(root), /signing-permissions/);
});
