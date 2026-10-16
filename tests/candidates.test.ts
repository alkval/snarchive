import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSnapchatDate, parseObservedFilename, groupCandidates } from '../src/domain/candidates.ts';

function file(source: string, name: string) {
  const value = parseObservedFilename(source, name);
  assert.ok(value);
  return value;
}

test('UTC is preserved without the local timezone changing the instant', () => {
  assert.deepEqual(parseSnapchatDate('2026-02-05 17:48:47 UTC'), {
    kind: 'instant', utc: '2026-02-05T17:48:47.000Z', original: '2026-02-05 17:48:47 UTC', provenance: 'snapchat', timezone: 'UTC',
  });
});
test('invalid dates and times are not normalized into plausible capture dates', () => {
  for (const value of ['2025-02-29 00:00:00 UTC', '2026-02-30 00:00:00 UTC', '2026-01-01 24:00:00 UTC', '2026-01-01 00:60:00 UTC', '2026-01-01 00:00:60 UTC', '2026-01-01', null]) {
    assert.deepEqual(parseSnapchatDate(value), { kind: 'unknown' });
  }
});
test('leap day is accepted when valid', () => {
  assert.equal(parseSnapchatDate('2024-02-29 00:00:00 UTC').kind, 'instant');
});
test('filename date keeps date-only precision', () => {
  assert.deepEqual(file('part-a', 'memories/2025-11-16_snap-A-main.jpg').captureDate,
    { kind: 'date-only', date: '2025-11-16', provenance: 'filename', confidence: 'inferred' });
});
test('invalid filename dates retain media with unknown date', () => {
  assert.deepEqual(file('part-a', '2025-02-29_snap-A-main.mp4').captureDate, { kind: 'unknown' });
});
test('unknown formats and incorrectly typed overlays are not guessed', () => {
  for (const name of ['holiday.jpg', '2025-11-16_a-overlay.jpg', '2025-11-16_a-main.png', '2025-11-16_a-main.exe']) {
    assert.equal(parseObservedFilename('part-a', name), null);
  }
});
test('media and overlays associate across separate selected sources', () => {
  const groups = groupCandidates([file('a', '2025-11-16_snap-A-main.mp4'), file('b', '2025-11-16_snap-A-overlay.png')]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0]?.status, 'candidate');
  assert.equal(groups[0]?.overlays.length, 1);
});
test('orphan overlays are explicitly identified', () => {
  assert.equal(groupCandidates([file('a', '2025-11-16_a-overlay.png')])[0]?.status, 'orphan-overlay');
});
test('repeated observation does not create a second candidate', () => {
  const item = file('a', '2025-11-16_a-main.jpg');
  assert.equal(groupCandidates([item, item])[0]?.media.length, 1);
});
test('overlapping sources require verification before selecting bytes', () => {
  assert.equal(groupCandidates([file('a', '2025-11-16_a-main.jpg'), file('b', '2025-11-16_a-main.jpg')])[0]?.status, 'needs-resolution');
});
test('different source identities remain separate', () => {
  assert.equal(groupCandidates([file('a', '2025-11-16_a-main.jpg'), file('a', '2025-11-16_b-main.jpg')]).length, 2);
});
test('ambiguous overlays are not automatically selected', () => {
  const groups = groupCandidates([file('a', '2025-11-16_a-main.jpg'), file('a', '2025-11-16_a-overlay.png'), file('b', '2025-11-16_a-overlay.png')]);
  assert.equal(groups[0]?.status, 'needs-resolution');
});
