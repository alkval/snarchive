import type { SourceSelection } from '../platform/sourcePicker.ts';
import { inventoryFromSnapshot, type DirectorySnapshot, type SourceInventory } from './sourceInventory.ts';
import { sourceIdentity } from './sourceIdentity.ts';
import { buildInventory } from './inventory.ts';

export type ImportPart = { selection: SourceSelection; source: SourceInventory; hash: string | null };
export type ImportBatch = { parts: ImportPart[]; memories: number; photos: number; videos: number; overlays: number };
/** Keeps this selection's read grants for confirmation/import. No media is copied by scanning. */
export async function scanImportBatch(selections: readonly SourceSelection[], scan: (selection: SourceSelection) => Promise<DirectorySnapshot>,
  cancelled: () => boolean, progress: (part: number, total: number) => void): Promise<ImportBatch> {
  if (!selections.length || selections.length > 64) throw new Error('selection-limit');
  const parts: ImportPart[] = [], seen = new Set<string>(); let visited = 0, metadata = 0;
  for (const [index, selection] of selections.entries()) {
    if (cancelled()) throw new Error('cancelled');
    progress(index + 1, selections.length);
    const snapshot = await scan(selection);
    if (cancelled()) throw new Error('cancelled');
    const identity = sourceIdentity(selection, snapshot);
    if (seen.has(identity)) continue;
    seen.add(identity); visited += snapshot.visitedEntries; metadata += snapshot.metadataBytes;
    if (visited > 100_000 || metadata > 16 * 1024 ** 2) throw new Error('selection-limit');
    parts.push({ selection, source: inventoryFromSnapshot(snapshot, `source-${parts.length + 1}`), hash: selection.kind === 'zip' ? snapshot.archiveSha256! : null });
  }
  const files = parts.flatMap(part => part.source.files);
  if (!files.length) throw new Error('no-media');
  const inventory = buildInventory(files, parts.flatMap(part => part.source.metadata));
  return { parts, memories: inventory.summary.mediaPresent, photos: files.filter(f => f.role === 'photo').length,
    videos: files.filter(f => f.role === 'video').length, overlays: files.filter(f => f.role === 'overlay').length };
}

/** The caller supplies the existing durable per-source importer. Reuses the URIs selected once by the user. */
export async function importBatch(batch: ImportBatch, run: (part: ImportPart, index: number, total: number) => Promise<void>, cancelled: () => boolean) {
  for (const [index, part] of batch.parts.entries()) {
    if (cancelled()) throw new Error('cancelled');
    await run(part, index + 1, batch.parts.length);
  }
}
