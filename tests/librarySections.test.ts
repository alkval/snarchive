import { test } from 'node:test';
import assert from 'node:assert/strict';
import { librarySections, type DatedRow } from '../src/domain/librarySections.ts';

const row = (id: string, day: string | null, dateConflict = 0, instant: string | null = null): DatedRow => ({ id, day, instant, dateConflict });

test('alternating unknown and conflicting dates get distinct, stable section keys in their original order', () => {
  // The page query sorts both kinds to the same empty position and orders them by ID, so they can interleave.
  const rows = [row('a', null), row('b', '2026-01-02', 1), row('c', null)];
  const sections = librarySections(rows);
  assert.deepEqual(sections.map(section => section.group), ['unknown', 'conflict', 'unknown']);
  assert.equal(new Set(sections.map(section => section.key)).size, sections.length);
  assert.deepEqual(sections.flatMap(section => section.rows.map(item => item.id)), ['a', 'b', 'c']);
  assert.deepEqual(librarySections(rows).map(section => section.key), sections.map(section => section.key));
});

test('consecutive rows of one day share a section; days, instants and order are kept', () => {
  const rows = [row('a', '2026-10-18'), row('b', '2026-10-18'), row('c', null, 0, '2026-10-17T08:00:00.000Z'), row('d', '2026-10-16'), row('e', null)];
  const sections = librarySections(rows);
  assert.deepEqual(sections.map(section => [section.group, section.rows.map(item => item.id)]),
    [['2026-10-18', ['a', 'b']], ['2026-10-17', ['c']], ['2026-10-16', ['d']], ['unknown', ['e']]]);
  assert.equal(new Set(sections.map(section => section.key)).size, sections.length);
});

test('an empty page has no sections', () => {
  assert.deepEqual(librarySections([]), []);
});
