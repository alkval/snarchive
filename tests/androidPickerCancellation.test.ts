import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { applyPickerCancellationRules } = require('../scripts/withAndroidPickerCancellation.cjs');

test('prebuild keeps the cancellation exception class and members intact, idempotently preserving other R8 rules', () => {
  const rules = '-keepattributes SourceFile,LineNumberTable\n';
  const updated = applyPickerCancellationRules(rules);
  assert.ok(updated.startsWith(rules));
  assert.match(updated, /-keep class expo\.modules\.filesystem\.PickerCancelledException \{ \*; \}/);
  assert.equal(applyPickerCancellationRules(updated), updated);
  const config = JSON.parse(readFileSync(new URL('../app.json', import.meta.url), 'utf8'));
  assert.ok(config.expo.plugins.includes('./scripts/withAndroidPickerCancellation.cjs'));
});

test('toqr lock entry agrees with its pinned 0.1.1 tarball and app versions agree across manifests', () => {
  const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const config = JSON.parse(readFileSync(new URL('../app.json', import.meta.url), 'utf8'));
  assert.equal(lock.packages['node_modules/toqr'].version, '0.1.1');
  assert.equal(lock.packages['node_modules/toqr'].resolved, 'https://registry.npmjs.org/toqr/-/toqr-0.1.1.tgz');
  assert.equal(lock.version, pkg.version); assert.equal(lock.packages[''].version, pkg.version); assert.equal(config.expo.version, pkg.version);
});
