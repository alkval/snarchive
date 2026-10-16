import { parseObservedFilename, type FileCandidate } from '../domain/candidates.ts';
import { safeArchivePath } from './archivePolicy.ts';
import { buildInventory } from './inventory.ts';
import { parseMetadata, type MetadataResult } from './metadata.ts';

export type DirectorySnapshot = {
  entries: { path: string; metadataText?: string }[];
  metadataBytes: number;
  visitedEntries: number;
};
export type SourceInventory = {
  sourceId: string; files: FileCandidate[]; metadata: MetadataResult[];
  otherFiles: number; visitedEntries: number; metadataBytes: number;
};
export function inventoryFromSnapshot(snapshot: DirectorySnapshot, sourceId: string): SourceInventory {
  if (!Number.isSafeInteger(snapshot.visitedEntries) || snapshot.visitedEntries < snapshot.entries.length || snapshot.visitedEntries > 100_000 ||
      !Number.isSafeInteger(snapshot.metadataBytes) || snapshot.metadataBytes < 0 || snapshot.metadataBytes > 16 * 1024 * 1024) throw new Error('source-limit');
  const result: SourceInventory = { sourceId, files: [], metadata: [], otherFiles: 0, visitedEntries: snapshot.visitedEntries, metadataBytes: snapshot.metadataBytes };
  const paths = new Set<string>();
  for (const [index, entry] of snapshot.entries.entries()) {
    if (!safeArchivePath(entry.path) || paths.has(entry.path)) throw new Error('unsafe-source');
    paths.add(entry.path);
    const basename = entry.path.split('/').at(-1)!.toLowerCase();
    if (basename === 'memories_history.json') {
      if (entry.metadataText === undefined) throw new Error('missing-metadata-content');
      result.metadata.push(parseMetadata(entry.metadataText, `${sourceId}:metadata-${index}`));
    } else {
      if (entry.metadataText !== undefined) throw new Error('unexpected-metadata-content');
      const candidate = parseObservedFilename(sourceId, entry.path);
      if (candidate) result.files.push(candidate); else result.otherFiles++;
    }
  }
  return result;
}

/** Replacement by source ID avoids duplicate observations when rescanning one folder. */
export function mergeSourceInventories(previous: readonly SourceInventory[], incoming: SourceInventory) {
  const sources = [...previous.filter(source => source.sourceId !== incoming.sourceId), incoming];
  if (sources.length > 8 || sources.reduce((n, source) => n + source.visitedEntries, 0) > 100_000 ||
      sources.reduce((n, source) => n + source.metadataBytes, 0) > 16 * 1024 * 1024) throw new Error('session-limit');
  return { sources, inventory: buildInventory(sources.flatMap(source => source.files), sources.flatMap(source => source.metadata)),
    otherFiles: sources.reduce((n, source) => n + source.otherFiles, 0) };
}
export type InventoryPreview = ReturnType<typeof mergeSourceInventories>;
