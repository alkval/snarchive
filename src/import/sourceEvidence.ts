import { sha256Hex } from '../domain/sha256.ts';
import type { SourceInventory } from './sourceInventory.ts';

/** A source's complete evidence (files, metadata records with dates and locations, diagnostics, counts) with only its
 * per-device label replaced: the source's own ID, each file's ID, and the "<label>:" prefix of metadata IDs. Two scans
 * of the same export on different devices (source-1 vs source-7) compare equal; any other difference does not. */
export function sourceEvidence(source: SourceInventory): string {
  const label = source.sourceId, neutral = 'source';
  const relabel = (id: string) => id.startsWith(`${label}:`) ? `${neutral}${id.slice(label.length)}` : id;
  return JSON.stringify({
    ...source, sourceId: neutral,
    files: source.files.map(file => ({ ...file, sourceId: file.sourceId === label ? neutral : file.sourceId })),
    metadata: source.metadata.map(result => ({
      ...result,
      records: result.records.map(record => ({ ...record, sourceId: relabel(record.sourceId) })),
      diagnostics: result.diagnostics.map(diagnostic => ({ ...diagnostic, sourceId: relabel(diagnostic.sourceId) })),
    })),
  });
}

/** The identity of an extracted folder's plan: SHA-256 of a version tag and the source's codec-normalized evidence.
 * It identifies what the scan saw (names, metadata, counts), not media bytes, and not a location or provider. The
 * caller must pass a source decoded by the saved-preview codec, so key order and allowlisted fields are fixed. */
export function folderInventoryHash(normalized: SourceInventory): string {
  return sha256Hex(`snarchive-folder-inventory\n1\n${sourceEvidence(normalized)}`);
}
