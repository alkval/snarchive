import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultFilters, validFilters } from '../src/domain/libraryFilters.ts';
test('month filters accept complete calendar months without inventing a day or timezone', () => {
  assert.equal(validFilters(defaultFilters), true);
  for (const month of ['2026-01', '2026-12', '0001-01']) assert.equal(validFilters({ ...defaultFilters, month }), true);
  for (const month of ['2026-00', '2026-13', '2026-1', '0000-01', '2026-10-01', "' OR 1=1", ' 2026-10']) assert.equal(validFilters({ ...defaultFilters, month }), false);
});
