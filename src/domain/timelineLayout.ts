import { GRID_COLUMNS, GRID_GAP } from './gridLayout.ts';
import type { TimelineEntry } from './libraryTimeline.ts';
export type TimelineCell = { index: number; key: string; offset: number; length: number; group: string; count: number; entries: readonly TimelineEntry[] };
export const clampFraction = (value: number) => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
/** Every date heading and photo row has a position before its media is loaded. Both finger scrolling and the
 * handle use these same offsets; seeking never replaces the feed or removes its newer/older neighbours. */
export function timelineLayout(entries: readonly TimelineEntry[], width: number, fontScale: number) {
  const tile = Math.max(1, (width - GRID_GAP * (GRID_COLUMNS - 1)) / GRID_COLUMNS), heading = 24 + Math.ceil(22 * fontScale);
  const cells: TimelineCell[] = [], byId = new Map<string, number>();
  let offset = 0;
  for (let start = 0; start < entries.length;) {
    let end = start + 1;
    while (end < entries.length && entries[end]!.group === entries[start]!.group) end++;
    const group = entries[start]!.group, count = end - start;
    cells.push({ index: cells.length, key: `heading:${entries[start]!.id}`, group, count, entries: [], offset, length: heading }); offset += heading;
    for (let at = start; at < end; at += GRID_COLUMNS) {
      const row = entries.slice(at, Math.min(end, at + GRID_COLUMNS));
      for (const entry of row) byId.set(entry.id, cells.length);
      cells.push({ index: cells.length, key: `row:${row[0]!.id}`, group, count, entries: row, offset, length: tile + GRID_GAP }); offset += tile + GRID_GAP;
    }
    start = end;
  }
  const total = offset + (entries.length ? 48 : 0);
  const cellAt = (y: number): TimelineCell | undefined => {
    let low = 0, high = cells.length - 1;
    while (low < high) { const mid = Math.ceil((low + high) / 2); if (cells[mid]!.offset <= y) low = mid; else high = mid - 1; }
    return cells[low];
  };
  return { cells, byId, total, tile, cellAt, headers: cells.filter(cell => !cell.entries.length).map(cell => cell.index) };
}
/** Observed pixel position is local to the small scrollbar component, so scrolling doesn't re-render the grid. */
export class TimelinePosition {
  fraction = 0;
  month = '';
  private listeners = new Set<() => void>();
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  set(fraction: number, group: string) {
    const value = clampFraction(fraction), month = /^\d{4}-\d{2}/.test(group) ? group.slice(0, 7) : '';
    if (this.fraction === value && this.month === month) return;
    this.fraction = value; this.month = month;
    for (const listener of this.listeners) listener();
  }
}

export type TimelineAnchor = { id: string; within: number; at: number };
/** Membership can remove the anchor or the entire list. Never dereference a fallback cell in an empty layout. */
export function restoredTimelineOffset(layout: ReturnType<typeof timelineLayout>, anchor: TimelineAnchor | null,
  viewport: number, previousOffset: number, newScope: boolean): number {
  const maximum = Math.max(0, layout.total - viewport);
  if (newScope || !layout.cells.length) return 0;
  const at = anchor ? layout.byId.get(anchor.id) ?? Math.max(0, Math.min(anchor.at, layout.cells.length - 1)) : undefined;
  const value = at === undefined ? previousOffset : layout.cells[at]!.offset + anchor!.within;
  return Math.max(0, Math.min(maximum, value));
}

/** Drag by distance from the grab point. Window/safe-area offsets must never shift the handle under the finger. */
export function draggedTimelineFraction(start: number, deltaY: number, trackHeight: number, handleHeight = 44): number {
  return clampFraction(start + deltaY / Math.max(1, trackHeight - handleHeight));
}
