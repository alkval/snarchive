export const GRID_COLUMNS = 3, GRID_GAP = 2;

/** SectionList's flattened indices include a header and a zero-height footer for every section. Supplying exact
 * bounds avoids estimating a mixture of short headers, empty footers and square photo rows during a fast fling. */
export function gridLayout(rowCounts: readonly number[], width: number, fontScale: number, headerOffset = 0) {
  const tile = Math.max(1, (width - GRID_GAP * (GRID_COLUMNS - 1)) / GRID_COLUMNS);
  const heading = 24 + Math.ceil(22 * fontScale);
  const cells: { index: number; length: number; offset: number }[] = [];
  let offset = headerOffset;
  const add = (length: number) => { cells.push({ index: cells.length, length, offset }); offset += length; };
  for (const count of rowCounts) {
    add(heading);
    for (let i = 0; i < count; i++) add(tile + GRID_GAP);
    add(0);
  }
  return { tile, heading, cells };
}
