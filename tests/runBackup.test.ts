import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backupChunks, runBackup, type BackupTransport } from '../src/backup/runBackup.ts';
function transport() {
  const calls: string[] = [];
  const native: BackupTransport = {
    async begin() { calls.push('begin'); }, async line() { calls.push('line'); }, async object() { calls.push('object'); },
    async build() { calls.push('build'); }, async choose() { calls.push('choose'); return true; },
    async save() { calls.push('save'); }, async end() { calls.push('end'); },
  };
  return { calls, native };
}
test('backup builds only after snapshot commit and reports saved after destination verification', async () => {
  const { calls, native } = transport();
  const result = await runBackup(async sink => { await sink.line('{}\n'); calls.push('commit'); }, native, () => false, stage => calls.push(stage));
  assert.equal(result, 'saved');
  assert.deepEqual(calls, ['begin', 'snapshot', 'line', 'commit', 'build', 'build', 'choose', 'choose', 'save', 'save', 'end']);
});
test('failed snapshot commit never builds or opens save picker', async () => {
  const { calls, native } = transport();
  await assert.rejects(runBackup(async sink => { await sink.line('{"type":"end"}\n'); throw new Error('commit-failed'); }, native, () => false, () => {}), /commit-failed/);
  assert.deepEqual(calls, ['begin', 'line', 'end']);
});
test('cancel between build and save picker discards staging', async () => {
  const { calls, native } = transport(); let stopped = false;
  native.build = async () => { calls.push('build'); stopped = true; };
  await assert.rejects(runBackup(async () => {}, native, () => stopped, () => {}), /cancelled/);
  assert.deepEqual(calls, ['begin', 'build', 'end']);
});
test('closing the system save picker does not write a destination', async () => {
  const { calls, native } = transport(); native.choose = async () => { calls.push('choose'); return false; };
  assert.equal(await runBackup(async () => {}, native, () => false, () => {}), 'cancelled');
  assert.deepEqual(calls, ['begin', 'build', 'choose', 'end']);
});
test('destination errors clean up, and failed deletion is reported', async () => {
  const { calls, native } = transport(); native.save = async () => { calls.push('save'); throw new Error('save-failed'); };
  await assert.rejects(runBackup(async () => {}, native, () => false, () => {}), /save-failed/);
  assert.equal(calls.at(-1), 'end');
  native.end = async () => { throw new Error('backup-partial-remains'); };
  await assert.rejects(runBackup(async () => {}, native, () => false, () => {}), /backup-partial-remains/);
});
test('failed begin cannot end another active backup', async () => {
  const { calls, native } = transport(); native.begin = async () => { throw new Error('busy'); };
  await assert.rejects(runBackup(async () => {}, native, () => false, () => {}), /busy/); assert.deepEqual(calls, []);
});
test('late cancel after destination commit does not mislabel a saved backup', async () => {
  const { native } = transport(); let stopped = false; native.save = async () => { stopped = true; };
  assert.equal(await runBackup(async () => {}, native, () => stopped, () => {}), 'saved');
});
test('bridge chunks preserve UTF-8 bytes at surrogate boundaries', () => {
  const text = 'a'.repeat(65535) + '🙂' + 'ø'.repeat(65536) + '\n';
  const chunks = [...backupChunks(text)];
  assert.ok(chunks.every(chunk => chunk.length <= 65536));
  assert.deepEqual(Buffer.concat(chunks.map(chunk => Buffer.from(chunk))), Buffer.from(text));
});
