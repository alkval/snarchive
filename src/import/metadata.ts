import { parseSnapchatDate, type CaptureDate } from '../domain/candidates.ts';

export type LocationEvidence =
  | { kind: 'valid' | 'placeholder'; latitude: number; longitude: number }
  | { kind: 'unknown' | 'invalid' };
export type DiagnosticCode = 'invalid-json' | 'unsupported-format' | 'metadata-limit' | 'invalid-row'
  | 'missing-identity' | 'conflicting-identity' | 'invalid-link' | 'invalid-date' | 'invalid-location' | 'placeholder-location' | 'unknown-media-type';
export type Diagnostic = { code: DiagnosticCode; sourceId: string; row?: number };
export type MetadataRecord = {
  sourceId: string;
  row: number;
  memorySourceId: string | null;
  captureDate: CaptureDate;
  mediaType: 'photo' | 'video' | 'unknown';
  location: LocationEvidence;
};
export type MetadataResult = { records: MetadataRecord[]; diagnostics: Diagnostic[] };

const MAX_TEXT_CHARS = 8 * 1024 * 1024;
const MAX_ROWS = 100_000;
const ID = /^[A-Za-z0-9_-]{1,256}$/;
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** URLs are examined locally, never fetched, retained, or placed in error messages. */
function linkIdentity(value: unknown): { ids: string[]; invalid: boolean } {
  if (value === undefined || value === null || value === '') return { ids: [], invalid: false };
  if (typeof value !== 'string' || value.length > 16_384) return { ids: [], invalid: true };
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return { ids: [], invalid: true };
    const ids = url.searchParams.getAll('mid');
    if (ids.some(id => !ID.test(id))) return { ids: [], invalid: true };
    return { ids, invalid: false };
  } catch {
    return { ids: [], invalid: true };
  }
}

export function parseLocation(value: unknown): LocationEvidence {
  if (value === undefined || value === null || value === '') return { kind: 'unknown' };
  if (typeof value !== 'string' || value.length > 160) return { kind: 'invalid' };
  const match = /^Latitude, Longitude:\s*([+-]?\d+(?:\.\d+)?),\s*([+-]?\d+(?:\.\d+)?)\s*$/.exec(value);
  if (!match) return { kind: 'invalid' };
  const latitude = Number(match[1]), longitude = Number(match[2]);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return { kind: 'invalid' };
  return { kind: latitude === 0 && longitude === 0 ? 'placeholder' : 'valid', latitude, longitude };
}

/** Bounded, narrow Saved Media adapter. Unrelated export fields never leave this function. */
export function parseMetadata(text: string, sourceId: string): MetadataResult {
  const result: MetadataResult = { records: [], diagnostics: [] };
  const issue = (code: DiagnosticCode, row?: number) => result.diagnostics.push({ code, sourceId, ...(row === undefined ? {} : { row }) });
  if (text.length > MAX_TEXT_CHARS) { issue('metadata-limit'); return result; }
  let input: unknown;
  try { input = JSON.parse(text.startsWith('\uFEFF') ? text.slice(1) : text); } catch { issue('invalid-json'); return result; }
  if (!object(input) || !Array.isArray(input['Saved Media'])) { issue('unsupported-format'); return result; }
  const rows = input['Saved Media'];
  if (rows.length > MAX_ROWS) { issue('metadata-limit'); return result; }
  rows.forEach((raw: unknown, row: number) => {
    if (!object(raw)) { issue('invalid-row', row); return; }
    const links = [linkIdentity(raw['Download Link']), linkIdentity(raw['Media Download Url'])];
    const ids = new Set(links.flatMap(link => link.ids));
    const invalidLink = links.some(link => link.invalid);
    if (invalidLink) issue('invalid-link', row);
    if (ids.size > 1) issue('conflicting-identity', row);
    if (ids.size === 0) issue('missing-identity', row);
    // An invalid second link may hide a conflicting identity. Do not guess from the first.
    const memorySourceId = ids.size === 1 && !invalidLink ? [...ids][0]! : null;
    const captureDate = parseSnapchatDate(raw.Date);
    if (captureDate.kind === 'unknown') issue('invalid-date', row);
    const type = typeof raw['Media Type'] === 'string' ? raw['Media Type'].toLowerCase() : '';
    const mediaType = type === 'image' || type === 'photo' ? 'photo' : type === 'video' ? 'video' : 'unknown';
    if (mediaType === 'unknown') issue('unknown-media-type', row);
    const location = parseLocation(raw.Location);
    if (location.kind === 'invalid') issue('invalid-location', row);
    if (location.kind === 'placeholder') issue('placeholder-location', row);
    result.records.push({ sourceId, row, memorySourceId, captureDate, mediaType, location });
  });
  return result;
}
