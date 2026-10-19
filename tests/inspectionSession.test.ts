import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInspectionSession, InspectionFailure, type InspectionBridge } from '../src/backup/inspectionSession.ts';
import { en } from '../src/i18n/en.ts';

const MANIFEST = '{"type":"header","format":"snarchive-backup","version":1}\n{"type":"end","records":1,"objects":0,"originalBytes":0}\n';
/** A fake native module: every call can succeed or fail, and the test records which calls happened. */
function bridge(overrides: Partial<InspectionBridge> = {}) {
  const calls: string[] = [];
  const base: InspectionBridge = {
    async beginBackupInspection() { calls.push('begin'); return { ok: true, inPlace: false }; },
    async readBackupManifest() { calls.push('read'); return { ok: true, text: MANIFEST, done: true }; },
    async declareBackupObjects() { calls.push('declare'); return { ok: true }; },
    async sealBackupInspection() { calls.push('seal'); return { ok: true }; },
    async verifyBackupObjects() { calls.push('verify'); return { ok: true, verified: 0, total: 0, bytes: 0, totalBytes: 0, done: true }; },
    async endBackupInspection() { calls.push('end'); return { ok: true }; },
  };
  return { calls, native: { ...base, ...overrides } };
}
async function failure(promise: Promise<unknown>): Promise<InspectionFailure> {
  try { await promise; } catch (error) { assert.ok(error instanceof InspectionFailure); return error; }
  throw new Error('expected a failure');
}

test('a failed open reports its own code and a copy it could not delete; nothing else runs', async () => {
  const { calls, native } = bridge({ async beginBackupInspection() { calls.push('begin'); return { ok: false, code: 'unsafe-or-unsupported-zip', cleanupFailed: true }; } });
  const error = await failure(runInspectionSession(native, 'content://x', () => false, () => {}));
  assert.equal(error.message, 'unsafe-or-unsupported-zip'); assert.equal(error.cleanupFailed, true);
  assert.deepEqual(calls, ['begin']); // The native side already closed the failed session.
});

test('a cancelled open keeps the cleanup failure', async () => {
  const { native } = bridge({ async beginBackupInspection() { return { ok: false, code: 'cancelled', cleanupFailed: true }; } });
  const error = await failure(runInspectionSession(native, 'content://x', () => true, () => {}));
  assert.equal(error.message, 'cancelled'); assert.equal(error.cleanupFailed, true);
});

test('a failed open without a cleanup problem reports only its code', async () => {
  const { native } = bridge({ async beginBackupInspection() { return { ok: false, code: 'insufficient-storage' }; } });
  const error = await failure(runInspectionSession(native, 'content://x', () => false, () => {}));
  assert.equal(error.message, 'insufficient-storage'); assert.equal(error.cleanupFailed, false);
});

test('a failure after opening closes the session and reports both outcomes', async () => {
  const { calls, native } = bridge({
    async verifyBackupObjects() { calls.push('verify'); return { ok: false, code: 'backup-damaged' }; },
    async endBackupInspection() { calls.push('end'); return { ok: false, code: 'backup-cleanup-failed' }; },
  });
  const error = await failure(runInspectionSession(native, 'content://x', () => false, () => {}));
  assert.equal(error.message, 'backup-damaged'); assert.equal(error.cleanupFailed, true); assert.equal(calls.at(-1), 'end');
});

test('cancellation after opening stays a cancellation and keeps the cleanup failure', async () => {
  let stopped = false;
  const { native } = bridge({
    async readBackupManifest() { stopped = true; return { ok: false, code: 'cancelled' }; },
    async endBackupInspection() { return { ok: false, code: 'backup-cleanup-failed' }; },
  });
  const error = await failure(runInspectionSession(native, 'content://x', () => stopped, () => {}));
  assert.equal(error.message, 'cancelled'); assert.equal(error.cleanupFailed, true);
});

test('a verified backup reports whether its private copy was deleted', async () => {
  const kept = bridge({ async endBackupInspection() { return { ok: false, code: 'backup-cleanup-failed' }; } });
  const outcome = await runInspectionSession(kept.native, 'content://x', () => false, () => {});
  assert.equal(outcome.preview.memories, 0); assert.equal(outcome.cleanupFailed, true); assert.equal(outcome.inPlace, false);
  const clean = bridge();
  assert.equal((await runInspectionSession(clean.native, 'content://x', () => false, () => {})).cleanupFailed, false);
});

test('the preview footer never claims a deletion that did not happen', () => {
  const inPlace = en.inspectFooterFor(true, false), deleted = en.inspectFooterFor(false, false), kept = en.inspectFooterFor(false, true);
  assert.equal(inPlace, en.inspectFooter); assert.ok(!/cop(y|ies)/i.test(inPlace));
  assert.ok(deleted.includes('has been deleted') && deleted.endsWith(en.inspectFooter));
  assert.ok(!kept.includes('deleted') && kept.includes('temporary private copy') && kept.endsWith(en.inspectFooter));
});

test('a leftover copy that stopped the check reaches the caller as a cleanup failure, not an unreadable backup', async () => {
  const { calls, native } = bridge({ async beginBackupInspection() { calls.push('begin'); return { ok: false, code: 'staging-cleanup-failed', cleanupFailed: true }; } });
  const error = await failure(runInspectionSession(native, 'content://x', () => false, () => {}));
  assert.equal(error.message, 'staging-cleanup-failed'); assert.equal(error.cleanupFailed, true); assert.deepEqual(calls, ['begin']);
});

test('failure and cancellation notices: one explanation per problem, never blaming the backup for a leftover copy', () => {
  const leftover = en.inspectOutcomeNotices({ cancelled: false, code: 'staging-cleanup-failed' }, true);
  assert.equal(leftover.length, 1); assert.equal(leftover[0]!.tone, 'warning');
  assert.ok(/earlier check or import/.test(leftover[0]!.message) && /not opened/.test(leftover[0]!.message));
  assert.ok(!/expired|choosing it again|has been deleted|damaged|malformed/i.test(leftover[0]!.message));
  const damaged = en.inspectOutcomeNotices({ cancelled: false, code: 'backup-damaged' }, true);
  assert.deepEqual(damaged.map(notice => notice.tone), ['error', 'warning']);
  assert.equal(damaged[1]!.message, en.inspectCleanupFailed);
  assert.deepEqual(en.inspectOutcomeNotices({ cancelled: false, code: 'backup-damaged' }, false).length, 1);
  const cancelled = en.inspectOutcomeNotices({ cancelled: true }, true);
  assert.deepEqual(cancelled.map(notice => notice.message), [en.inspectCancelled, en.inspectCleanupFailed]);
  assert.equal(en.inspectOutcomeNotices({ cancelled: false, code: 'something-new' }, false)[0]!.message, en.inspectUnreadable);
});
