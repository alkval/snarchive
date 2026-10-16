import { groupCandidates, type CaptureDate, type FileCandidate } from '../domain/candidates.ts';
import type { MetadataRecord, MetadataResult } from './metadata.ts';

export type InventoryIssue = 'multiple-media' | 'multiple-overlays' | 'conflicting-dates' | 'conflicting-media-types' | 'conflicting-locations';
export type InventoryMemory = {
  memorySourceId: string;
  media: FileCandidate[];
  overlays: FileCandidate[];
  metadata: MetadataRecord[];
  captureDate: CaptureDate;
  dateEvidence: CaptureDate[];
  issues: InventoryIssue[];
  availability: 'media-present' | 'metadata-only' | 'orphan-overlay';
};

/** Rebuildable inventory, including later observations. No persistence or binary deduplication. */
export function buildInventory(files: readonly FileCandidate[], results: readonly MetadataResult[]) {
  const memories = new Map<string, InventoryMemory>();
  function get(id: string) {
    let memory = memories.get(id);
    if (!memory) {
      memory = { memorySourceId: id, media: [], overlays: [], metadata: [], captureDate: { kind: 'unknown' }, dateEvidence: [], issues: [], availability: 'metadata-only' };
      memories.set(id, memory);
    }
    return memory;
  }
  for (const group of groupCandidates(files)) {
    const memory = get(group.memorySourceId);
    memory.media = group.media;
    memory.overlays = group.overlays;
  }
  const unmatchedMetadata: MetadataRecord[] = [];
  let repeatedRows = 0;
  const seen = new Set<string>();
  for (const record of results.flatMap(result => result.records)) {
    if (record.memorySourceId === null) { unmatchedMetadata.push(record); continue; }
    // Count identical evidence, but retain every row's provenance in the inventory.
    const key = JSON.stringify([record.memorySourceId, record.captureDate, record.mediaType, record.location]);
    if (seen.has(key)) repeatedRows++;
    seen.add(key);
    get(record.memorySourceId).metadata.push(record);
  }
  for (const memory of memories.values()) {
    memory.availability = memory.media.length ? 'media-present' : memory.overlays.length ? 'orphan-overlay' : 'metadata-only';
    if (memory.media.length > 1) memory.issues.push('multiple-media');
    if (memory.overlays.length > 1) memory.issues.push('multiple-overlays');
    memory.dateEvidence = [...memory.metadata.map(row => row.captureDate), ...memory.media.map(file => file.captureDate), ...memory.overlays.map(file => file.captureDate)];
    const instants = memory.dateEvidence.filter(date => date.kind === 'instant');
    const dates = memory.dateEvidence.filter(date => date.kind === 'date-only');
    const days = new Set([...instants.map(date => date.utc.slice(0, 10)), ...dates.map(date => date.date)]);
    if (new Set(instants.map(date => date.utc)).size > 1 || days.size > 1) {
      memory.issues.push('conflicting-dates');
    } else {
      memory.captureDate = instants[0] ?? dates[0] ?? { kind: 'unknown' };
    }
    const types = new Set([...memory.media.map(file => file.role), ...memory.metadata.map(row => row.mediaType).filter(type => type !== 'unknown')]);
    if (types.size > 1) memory.issues.push('conflicting-media-types');
    const locations = new Set(memory.metadata.filter(row => row.location.kind === 'valid').map(row => JSON.stringify(row.location)));
    if (locations.size > 1) memory.issues.push('conflicting-locations');
  }
  const entries = [...memories.values()];
  return {
    memories: entries, unmatchedMetadata, diagnostics: results.flatMap(result => result.diagnostics), repeatedRows,
    summary: {
      mediaPresent: entries.filter(entry => entry.availability === 'media-present').length,
      missingMedia: entries.filter(entry => entry.media.length === 0).length,
      orphanOverlays: entries.filter(entry => entry.availability === 'orphan-overlay').length,
      needsResolution: entries.filter(entry => entry.issues.length > 0).length,
      unmatchedMetadata: unmatchedMetadata.length,
    },
  };
}
