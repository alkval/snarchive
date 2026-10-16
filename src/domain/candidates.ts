/** Initial observed filename adapter. Unknown formats remain unsupported. */
export type CaptureDate =
  | { kind: 'instant'; utc: string; original: string; provenance: 'snapchat'; timezone: 'UTC' }
  | { kind: 'date-only'; date: string; provenance: 'filename'; confidence: 'inferred' }
  | { kind: 'unknown' };

function validDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function parseSnapchatDate(value: unknown): CaptureDate {
  if (typeof value !== 'string') return { kind: 'unknown' };
  const match = /^(\d{4}-\d{2}-\d{2}) (\d{2}):(\d{2}):(\d{2}) UTC$/.exec(value);
  if (!match || !validDay(match[1]!) || Number(match[2]) > 23 || Number(match[3]) > 59 || Number(match[4]) > 59) {
    return { kind: 'unknown' };
  }
  return { kind: 'instant', utc: `${match[1]}T${match[2]}:${match[3]}:${match[4]}.000Z`, original: value, provenance: 'snapchat', timezone: 'UTC' };
}

export type FileCandidate = {
  sourceId: string;
  relativePath: string;
  memorySourceId: string;
  role: 'photo' | 'video' | 'overlay';
  captureDate: CaptureDate;
};

export function parseObservedFilename(sourceId: string, relativePath: string): FileCandidate | null {
  const filename = relativePath.split('/').at(-1) ?? '';
  const match = /^(\d{4}-\d{2}-\d{2})_([A-Za-z0-9_-]+)-(main|overlay)\.(jpg|jpeg|mp4|png)$/i.exec(filename);
  if (!match) return null;
  const [, day, identity, part, extension] = match;
  const isOverlay = part!.toLowerCase() === 'overlay';
  const ext = extension!.toLowerCase();
  if ((isOverlay && ext !== 'png') || (!isOverlay && ext === 'png')) return null;
  return {
    sourceId, relativePath, memorySourceId: identity!,
    role: isOverlay ? 'overlay' : ext === 'mp4' ? 'video' : 'photo',
    captureDate: validDay(day!) ? { kind: 'date-only', date: day!, provenance: 'filename', confidence: 'inferred' } : { kind: 'unknown' },
  };
}

export type CandidateGroup = {
  memorySourceId: string;
  media: FileCandidate[];
  overlays: FileCandidate[];
  status: 'candidate' | 'orphan-overlay' | 'needs-resolution';
};

/** Inventory only: never decides identity from bytes or silently selects a duplicate. */
export function groupCandidates(files: readonly FileCandidate[]): CandidateGroup[] {
  const groups = new Map<string, CandidateGroup>();
  const seen = new Set<string>();
  for (const file of files) {
    const observationKey = JSON.stringify([file.sourceId, file.relativePath]);
    if (seen.has(observationKey)) continue;
    seen.add(observationKey);
    let group = groups.get(file.memorySourceId);
    if (!group) {
      group = { memorySourceId: file.memorySourceId, media: [], overlays: [], status: 'candidate' };
      groups.set(file.memorySourceId, group);
    }
    (file.role === 'overlay' ? group.overlays : group.media).push(file);
  }
  for (const group of groups.values()) {
    group.status = group.media.length === 0 ? 'orphan-overlay'
      : group.media.length > 1 || group.overlays.length > 1 ? 'needs-resolution' : 'candidate';
  }
  return [...groups.values()];
}
