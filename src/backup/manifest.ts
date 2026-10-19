import { decodePreview, encodePreview, MAX_PREVIEW_CHARS, type SavedPreview } from '../storage/previewCodec.ts';
import { MAX_BACKUP_BYTES, MAX_BACKUP_OBJECTS, MAX_MANIFEST_BYTES } from './snapshot.ts';

/** Limits derived from the exporter (snapshot.ts) and the saved-preview codec, never tighter than what it writes. */
export const MAX_MANIFEST_RECORDS = 1_000_000;
/** A source record wraps one codec-encoded inventory (at most MAX_PREVIEW_CHARS) in about 100 characters. */
export const MAX_SOURCE_LINE = MAX_PREVIEW_CHARS + 1024;
/** Every other record is short: hashes, small integers and one memory identity taken from a filename. */
export const MAX_RECORD_LINE = 4096;
export const MAX_OBJECT_BYTES = 8 * 1024 ** 3;
export { MAX_MANIFEST_BYTES };

export type BackupPreview = {
  /** Distinct memory identities with at least one preserved photo or video. Shared objects and repeated observations do not add to it. */
  memories: number;
  /** Identities whose only preserved files are overlays. */
  overlayOnly: number;
  /** Identities with more than one distinct preserved file for the same role (competing versions, all kept). */
  variants: number;
  /** Unique original objects in the catalog, and their total size in bytes. */
  objects: number; originalBytes: number;
  /** Objects referenced by two or more distinct memories. */
  sharedObjects: number;
  /** Catalogued objects no preserved observation references. */
  unreferencedObjects: number;
  /** Scanned export sources (one per ZIP job), preserved observations, and inventory files without a preserved record. */
  sources: number; preserved: number; pendingFiles: number;
  favorites: number;
  records: number;
};

export class BackupManifestError extends Error {}
/** A record that passed every check, for a consumer such as restore. Sources carry the codec-decoded inventory. */
export type ValidRecord =
  | { type: 'object'; sha256: string; bytes: number }
  | { type: 'source'; archiveSha256: string; saved: SavedPreview; inventory: string }
  | { type: 'preserved'; archiveSha256: string; ordinal: number; memoryId: string; role: 'photo' | 'video' | 'overlay'; sha256: string }
  | { type: 'favorite'; memoryId: string };
function check(ok: unknown, code = 'backup-invalid'): asserts ok { if (!ok) throw new BackupManifestError(code); }
const HASH = /^[a-f0-9]{64}$/;
const MEMORY = /^[A-Za-z0-9_-]{1,1024}$/;
const KEYS: Record<string, string> = {
  header: 'format,type,version', object: 'bytes,relativePath,sha256,type', source: 'archiveSha256,inventory,type',
  preserved: 'archiveSha256,memoryId,ordinal,role,sha256,type', favorite: 'memoryId,type', end: 'objects,originalBytes,records,type',
};
const integer = (value: unknown, max: number) => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= max;
const ROLE_BIT = { photo: 1, video: 2, overlay: 4 } as const;

type Phase = 'header' | 'objects' | 'sources' | 'favorites' | 'ended';
type Current = { hash: string; files: { memorySourceId: string; role: string }[]; lastOrdinal: number; preserved: number };

/** Streaming reader for manifest.jsonl, version 1. Text arrives in chunks of any size; at most one record
 * (for a source, one codec inventory) is held as text at a time.
 *
 * State that grows with the permitted record counts: the object catalog (at most 100,000 entries), one entry per
 * distinct memory identity and per distinct (identity, role), and the first memory using each object. Each is
 * bounded by the 1,000,000-record limit; a library of tens of thousands of memories needs a few megabytes. */
export class BackupManifestValidator {
  private pending = '';
  private phase: Phase = 'header';
  private records = 0;
  private readonly objects = new Map<string, number>();
  private originalBytes = 0;
  private lastObject = '';
  private lastSource = '';
  private current: Current | null = null;
  private sources = 0; private preserved = 0; private pendingFiles = 0;
  private readonly memories = new Map<string, number>();
  private readonly firstByRole = new Map<string, string>();
  private readonly variantIds = new Set<string>();
  private readonly objectUser = new Map<string, string>();
  private readonly sharedObjects = new Set<string>();
  private favorites = 0; private lastFavorite = '';
  private declarations: [string, number][] = [];
  private readonly keepRecords: boolean;
  private validRecords: ValidRecord[] = [];
  /** keepRecords: also return each validated record (takeRecords), for a consumer that applies them. */
  constructor(options: { keepRecords?: boolean } = {}) { this.keepRecords = !!options.keepRecords; }
  /** Records validated since the last call (keepRecords only). A record is returned only after it passed. */
  takeRecords(): ValidRecord[] { const out = this.validRecords; this.validRecords = []; return out; }

  /** Accepts the next piece of manifest text. Lines end with LF; a line longer than any record could be fails here. */
  push(text: string): void {
    let start = 0;
    for (;;) {
      const end = text.indexOf('\n', start);
      if (end === -1) { this.pending += text.slice(start); check(this.pending.length <= MAX_SOURCE_LINE, 'backup-limit'); return; }
      const line = this.pending + text.slice(start, end); this.pending = '';
      check(line.length <= MAX_SOURCE_LINE, 'backup-limit');
      this.record(line);
      start = end + 1;
    }
  }

  /** Objects declared since the last call, for the native side to match against the archive. */
  takeDeclarations(): [string, number][] { const out = this.declarations; this.declarations = []; return out; }

  finish(): BackupPreview {
    check(this.pending === '' && this.phase === 'ended');
    let overlayOnly = 0, memories = 0;
    for (const bits of this.memories.values()) { if (bits & (ROLE_BIT.photo | ROLE_BIT.video)) memories++; else overlayOnly++; }
    return {
      memories, overlayOnly, variants: this.variantIds.size, objects: this.objects.size, originalBytes: this.originalBytes,
      sharedObjects: this.sharedObjects.size, unreferencedObjects: this.objects.size - this.objectUser.size,
      sources: this.sources, preserved: this.preserved, pendingFiles: this.pendingFiles, favorites: this.favorites, records: this.records,
    };
  }

  private record(line: string): void {
    check(this.phase !== 'ended'); // Nothing may follow the end record.
    check(++this.records <= MAX_MANIFEST_RECORDS, 'backup-limit');
    let value: unknown;
    try { value = JSON.parse(line); } catch { throw new BackupManifestError('backup-invalid'); }
    check(value !== null && typeof value === 'object' && !Array.isArray(value));
    const record = value as Record<string, unknown>;
    // The line must be exactly what JSON.stringify writes for the parsed value. JSON.parse drops duplicate keys
    // (keeping the last value), so any duplicate changes the text; so do extra whitespace, alternative escapes and
    // non-canonical numbers such as 1e5. Key order is not fixed: parsing keeps keys in the order they appear.
    check(JSON.stringify(record) === line);
    const type = record.type;
    check(typeof type === 'string' && Object.prototype.hasOwnProperty.call(KEYS, type) && Object.keys(record).sort().join(',') === KEYS[type]);
    if (type !== 'source') check(line.length <= MAX_RECORD_LINE, 'backup-limit');
    switch (type) {
      case 'header': return this.header(record);
      case 'object': return this.object(record);
      case 'source': return this.source(record);
      case 'preserved': return this.observation(record);
      case 'favorite': return this.favorite(record);
      default: return this.end(record);
    }
  }

  private header(record: Record<string, unknown>) {
    check(this.phase === 'header' && this.records === 1 && record.format === 'snarchive-backup');
    check(Number.isSafeInteger(record.version) && (record.version as number) >= 1);
    check(record.version === 1, 'backup-unsupported');
    this.phase = 'objects';
  }

  private object(record: Record<string, unknown>) {
    check(this.phase === 'objects');
    const hash = record.sha256, bytes = record.bytes;
    check(typeof hash === 'string' && HASH.test(hash) && hash > this.lastObject); // Sorted, so also unique.
    check(record.relativePath === `objects/${hash.slice(0, 2)}/${hash}` && integer(bytes, MAX_OBJECT_BYTES));
    check(this.objects.size < MAX_BACKUP_OBJECTS && (bytes as number) <= MAX_BACKUP_BYTES - this.originalBytes, 'backup-limit');
    this.objects.set(hash, bytes as number); this.originalBytes += bytes as number; this.lastObject = hash;
    this.declarations.push([hash, bytes as number]);
    if (this.keepRecords) this.validRecords.push({ type: 'object', sha256: hash, bytes: bytes as number });
  }

  private source(record: Record<string, unknown>) {
    check(this.phase === 'objects' || this.phase === 'sources');
    const hash = record.archiveSha256;
    check(typeof hash === 'string' && HASH.test(hash) && hash > this.lastSource);
    this.closeSource();
    // The inventory must be exactly what the saved-preview codec produces: one source, keyed by this archive.
    const text = JSON.stringify(record.inventory);
    check(typeof text === 'string' && text.length <= MAX_PREVIEW_CHARS, 'backup-limit');
    let saved: ReturnType<typeof decodePreview>;
    try { saved = decodePreview(text); check(encodePreview(saved) === text); } catch { throw new BackupManifestError('backup-invalid'); }
    check(saved.sourceIds.size === 1 && saved.sourceIds.has(`zip:${hash}`) && saved.preview.sources.length === 1);
    const files = saved.preview.sources[0]!.files.map(file => ({ memorySourceId: file.memorySourceId, role: file.role }));
    this.current = { hash, files, lastOrdinal: -1, preserved: 0 };
    this.lastSource = hash; this.sources++; this.phase = 'sources';
    if (this.keepRecords) this.validRecords.push({ type: 'source', archiveSha256: hash, saved, inventory: text });
  }

  private closeSource() {
    if (!this.current) return;
    this.pendingFiles += this.current.files.length - this.current.preserved;
    this.current = null;
  }

  private observation(record: Record<string, unknown>) {
    const current = this.current;
    check(this.phase === 'sources' && current && record.archiveSha256 === current.hash);
    const ordinal = record.ordinal, memoryId = record.memoryId, role = record.role, hash = record.sha256;
    // Strictly increasing ordinals: one observation per inventory file, never a duplicate.
    check(integer(ordinal, current.files.length - 1) && (ordinal as number) > current.lastOrdinal);
    const file = current.files[ordinal as number]!;
    check(typeof memoryId === 'string' && MEMORY.test(memoryId) && memoryId === file.memorySourceId && role === file.role);
    check((role === 'photo' || role === 'video' || role === 'overlay') && typeof hash === 'string' && this.objects.has(hash));
    current.lastOrdinal = ordinal as number; current.preserved++; this.preserved++;
    this.memories.set(memoryId, (this.memories.get(memoryId) ?? 0) | ROLE_BIT[role]);
    // Repeated observations of one association are allowed; a second distinct file for a role is a variant.
    const key = `${role}:${memoryId}`, first = this.firstByRole.get(key);
    if (first === undefined) this.firstByRole.set(key, hash); else if (first !== hash) this.variantIds.add(memoryId);
    const user = this.objectUser.get(hash);
    if (user === undefined) this.objectUser.set(hash, memoryId); else if (user !== memoryId) this.sharedObjects.add(hash);
    if (this.keepRecords) this.validRecords.push({ type: 'preserved', archiveSha256: current.hash, ordinal: ordinal as number, memoryId, role, sha256: hash });
  }

  private favorite(record: Record<string, unknown>) {
    check(this.phase === 'objects' || this.phase === 'sources' || this.phase === 'favorites');
    this.closeSource(); this.phase = 'favorites';
    const memoryId = record.memoryId;
    check(typeof memoryId === 'string' && MEMORY.test(memoryId) && memoryId > this.lastFavorite);
    // Only identities with preserved base media can be favorites.
    check(((this.memories.get(memoryId) ?? 0) & (ROLE_BIT.photo | ROLE_BIT.video)) !== 0);
    this.lastFavorite = memoryId; this.favorites++;
    if (this.keepRecords) this.validRecords.push({ type: 'favorite', memoryId });
  }

  private end(record: Record<string, unknown>) {
    check(this.phase !== 'header');
    this.closeSource();
    check(record.records === this.records - 1 && record.objects === this.objects.size && record.originalBytes === this.originalBytes);
    this.phase = 'ended';
  }
}
