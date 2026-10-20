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

/** Ordinal string comparison by UTF-16 code units, independent of locale. */
const byText = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

/** A folder source in canonical order, so that its evidence does not depend on the order a document provider listed
 * the folder in. Files are sorted by relative path (unique within a source). Metadata results carry no path, and
 * their IDs ("<label>:metadata-<listing index>") depend on the listing; they are sorted by their content with those
 * IDs blanked, then renumbered by rank. Identical metadata files are interchangeable, so ties need no other key.
 * Nothing is dropped: every file, record, diagnostic and count is kept. ZIP sources never use this: an archive's
 * order is fixed by its bytes, and their evidence and identities are unchanged. */
export function canonicalFolderSource(source: SourceInventory): SourceInventory {
  const blank = (result: SourceInventory['metadata'][number]) => JSON.stringify({
    records: result.records.map(record => ({ ...record, sourceId: '' })),
    diagnostics: result.diagnostics.map(diagnostic => ({ ...diagnostic, sourceId: '' })),
  });
  const metadata = source.metadata.map(result => ({ result, key: blank(result) })).sort((a, b) => byText(a.key, b.key))
    .map(({ result }, rank) => {
      const id = `${source.sourceId}:metadata-${rank}`;
      return { records: result.records.map(record => ({ ...record, sourceId: id })), diagnostics: result.diagnostics.map(diagnostic => ({ ...diagnostic, sourceId: id })) };
    });
  return { ...source, files: [...source.files].sort((a, b) => byText(a.relativePath, b.relativePath)), metadata };
}

/** SHA-256 of the version tag and the given evidence exactly as ordered. Only for checking records written before
 * folder evidence was canonical (commit 307eda2), whose key was computed this way over the provider's listing order. */
export function listedFolderHash(normalized: SourceInventory): string {
  return sha256Hex(`snarchive-folder-inventory\n1\n${sourceEvidence(normalized)}`);
}

/** The identity of an extracted folder's plan: SHA-256 of a version tag and the source's codec-normalized evidence in
 * canonical order (canonicalFolderSource). It identifies what the scan saw (names, metadata, diagnostics, counts),
 * not media bytes, a location, a provider or its listing order. For a source already in canonical order it equals
 * listedFolderHash, so folder jobs planned from an ordered listing keep their key. The caller must pass a source
 * decoded by the saved-preview codec, so key order and allowlisted fields are fixed. */
export function folderInventoryHash(normalized: SourceInventory): string {
  return listedFolderHash(canonicalFolderSource(normalized));
}

/** True when a source's evidence is already in canonical order. */
export function isCanonicalFolderSource(source: SourceInventory): boolean {
  return sourceEvidence(source) === sourceEvidence(canonicalFolderSource(source));
}
