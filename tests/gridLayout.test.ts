import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gridLayout } from '../src/domain/gridLayout.ts';

test('grid metrics include every flattened SectionList header, row and empty footer', () => {
  const layout = gridLayout([2, 1], 364, 1);
  assert.equal(layout.tile, 120); assert.equal(layout.heading, 46);
  assert.deepEqual(layout.cells.map(cell => [cell.index, cell.offset, cell.length]),
    [[0, 0, 46], [1, 46, 122], [2, 168, 122], [3, 290, 0], [4, 290, 46], [5, 336, 122], [6, 458, 0]]);
});
test('width, large text and the measured filter header are reflected without average-size estimates', () => {
  const a = gridLayout([3], 724, 2, 80);
  assert.equal(a.tile, 240); assert.equal(a.heading, 68); assert.equal(a.cells[0]?.offset, 80);
  assert.equal(a.cells.at(-1)?.offset, 80 + 68 + 3 * 242);
  const b = gridLayout([3], 364, 2, 80);
  assert.equal(b.cells.at(-1)?.offset, 80 + 68 + 3 * 122);
  assert.deepEqual(gridLayout([], 364, 1).cells, []);
});
