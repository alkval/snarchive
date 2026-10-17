import { parseObservedFilename, parseSnapchatDate } from '../domain/candidates.ts';
import { safeArchivePath } from '../import/archivePolicy.ts';
import type { DiagnosticCode, MetadataResult, LocationEvidence } from '../import/metadata.ts';
import { mergeSourceInventories, type InventoryPreview, type SourceInventory } from '../import/sourceInventory.ts';

export const MAX_PREVIEW_CHARS = 32 * 1024 * 1024;
export type SavedPreview = { preview: InventoryPreview; sourceIds: Map<string, string> };
const codes = new Set<DiagnosticCode>(['invalid-json', 'unsupported-format', 'metadata-limit', 'invalid-row', 'missing-identity', 'conflicting-identity', 'invalid-link', 'invalid-date', 'invalid-location', 'placeholder-location', 'unknown-media-type']);
function check(ok: unknown): asserts ok { if (!ok) throw new Error('invalid-saved-preview'); }
function object(value: unknown): Record<string, unknown> { check(value && typeof value === 'object' && !Array.isArray(value)); return value as Record<string, unknown>; }
function array(value: unknown, max: number): unknown[] { check(Array.isArray(value) && value.length <= max); return value; }
function integer(value: unknown, max: number): number { check(Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= max); return value as number; }
function string(value: unknown, max: number): string { check(typeof value === 'string' && value.length <= max); return value; }
function location(value: unknown): LocationEvidence {
  const v = object(value);
  if (v.kind === 'unknown' || v.kind === 'invalid') return { kind: v.kind };
  check(v.kind === 'valid' || v.kind === 'placeholder');
  check(typeof v.latitude === 'number' && Number.isFinite(v.latitude) && Math.abs(v.latitude) <= 90);
  check(typeof v.longitude === 'number' && Number.isFinite(v.longitude) && Math.abs(v.longitude) <= 180);
  check((v.latitude === 0 && v.longitude === 0) === (v.kind === 'placeholder'));
  return { kind: v.kind, latitude: v.latitude, longitude: v.longitude };
}

/** Rebuild only allowlisted domain fields. Raw metadata and signed links never reach storage. */
function normalize(value: unknown): SavedPreview {
  const envelope = object(value); check(envelope.format === 1);
  const sourceIds = new Map<string, string>();
  const usedIds = new Set<string>();
  for (const pair of array(envelope.identities, 8)) {
    const [rawKey, rawId] = array(pair, 2);
    const key = string(rawKey, 8192), id = string(rawId, 16);
    check(/^source-[1-8]$/.test(id) && !usedIds.has(id) && !sourceIds.has(key));
    check(/^zip:[a-f0-9]{64}$/.test(key) || /^directory:(content|file):\/\//.test(key));
    sourceIds.set(key, id); usedIds.add(id);
  }
  let preview: InventoryPreview | undefined;
  let recordCount = 0, diagnosticCount = 0;
  const seenIds = new Set<string>();
  for (const raw of array(envelope.sources, 8)) {
    const v = object(raw), sourceId = string(v.sourceId, 16);
    check(usedIds.has(sourceId) && !seenIds.has(sourceId)); seenIds.add(sourceId);
    const paths = new Set<string>();
    const files = array(v.files, 100_000).map(rawFile => {
      const f = object(rawFile), path = string(f.relativePath, 1024);
      check(safeArchivePath(path) && !paths.has(path)); paths.add(path);
      const candidate = parseObservedFilename(sourceId, path); check(candidate); return candidate;
    });
    const metadata: MetadataResult[] = array(v.metadata, 100_000).map(rawMetadata => {
      const m = object(rawMetadata);
      const metadataId = (rawId: unknown) => {
        const id = string(rawId, 48); check(new RegExp(`^${sourceId}:metadata-[0-9]{1,6}$`).test(id)); return id;
      };
      const records = array(m.records, 100_000).map<MetadataResult['records'][number]>(rawRecord => {
        check(++recordCount <= 100_000);
        const r = object(rawRecord), date = object(r.captureDate);
        const captureDate = date.kind === 'unknown' ? { kind: 'unknown' as const } : parseSnapchatDate(date.original);
        check(date.kind === 'unknown' || (date.kind === 'instant' && captureDate.kind === 'instant' && date.utc === captureDate.utc));
        check(r.memorySourceId === null || (typeof r.memorySourceId === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(r.memorySourceId)));
        check(r.mediaType === 'photo' || r.mediaType === 'video' || r.mediaType === 'unknown');
        return { sourceId: metadataId(r.sourceId), row: integer(r.row, 99_999), memorySourceId: r.memorySourceId,
          captureDate, mediaType: r.mediaType, location: location(r.location) };
      });
      const diagnostics = array(m.diagnostics, 500_000).map(rawDiagnostic => {
        check(++diagnosticCount <= 500_000);
        const d = object(rawDiagnostic); check(codes.has(d.code as DiagnosticCode));
        return { sourceId: metadataId(d.sourceId), code: d.code as DiagnosticCode,
          ...(d.row === undefined ? {} : { row: integer(d.row, 99_999) }) };
      });
      return { records, diagnostics };
    });
    const source: SourceInventory = { sourceId, files, metadata, otherFiles: integer(v.otherFiles, 100_000),
      visitedEntries: integer(v.visitedEntries, 100_000), metadataBytes: integer(v.metadataBytes, 16 * 1024 * 1024) };
    check(source.visitedEntries >= files.length + metadata.length + source.otherFiles);
    preview = mergeSourceInventories(preview?.sources ?? [], source);
  }
  check(preview && seenIds.size === sourceIds.size);
  return { preview, sourceIds };
}
export function encodePreview(saved: SavedPreview): string {
  const normalized = normalize({ format: 1, sources: saved.preview.sources, identities: [...saved.sourceIds] });
  const text = JSON.stringify({ format: 1, sources: normalized.preview.sources, identities: [...normalized.sourceIds] });
  check(text.length <= MAX_PREVIEW_CHARS); return text;
}
export function decodePreview(text: string): SavedPreview {
  check(text.length <= MAX_PREVIEW_CHARS);
  return normalize(JSON.parse(text));
}
