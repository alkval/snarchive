import type { SqlDatabase } from '../storage/previewStore.ts';
import { validateManifest } from '../backup/inspectBackup.ts';

type Result = { ok: boolean; code?: string; cleanupFailed?: boolean; storeCleanupFailed?: boolean };
export type Health = 'valid' | 'missing' | 'damaged' | 'unreadable';
/** An original whose recorded bytes are not all there: no file, a file of the wrong length or content, or a file that
 * could not be read (an access or I/O error), whose content is therefore unknown. */
export type Problem = { hash: string; bytes: number; health: Exclude<Health, 'valid'> };
export type CheckProgress = { checked: number; total: number; bytes: number; totalBytes: number };
export type CheckResult = { total: number; totalBytes: number; problems: Problem[] };

/** The native side of an originals check (Android). Read-only; media bytes never cross this boundary. */
export interface CheckBridge {
  /** Takes the shared operation guard for the whole check, so nothing writes the store meanwhile. */
  beginOriginalCheck(): Promise<Result>;
  /** Reads each listed object in full: its length and SHA-256 against the library's record. */
  checkOriginals(hashes: string[], sizes: number[]): Promise<Result & { health?: Health[] }>;
  endOriginalCheck(): Promise<Result>;
}
export class CheckFailure extends Error {}

const PAGE = 200, BATCH = 50, BATCH_BYTES = 64 * 1024 ** 2;

/** Verifies every recorded original against the stored-object catalog, a page at a time, in native batches small
 * enough to report progress and honour cancellation between them. Only problems are kept. Changes nothing. */
export async function runOriginalsCheck(db: SqlDatabase, bridge: CheckBridge, cancelled: () => boolean,
  progress: (state: CheckProgress) => void): Promise<CheckResult> {
  const totals = await db.getFirstAsync<{ n: number; b: number }>('SELECT count(*) AS n, coalesce(sum(bytes),0) AS b FROM stored_objects');
  const total = totals?.n ?? 0, totalBytes = totals?.b ?? 0;
  const began = await bridge.beginOriginalCheck();
  if (!began.ok) throw new CheckFailure(began.code ?? 'check-failed');
  try {
    const problems: Problem[] = []; let checked = 0, bytes = 0, after = '';
    progress({ checked, total, bytes, totalBytes });
    for (;;) {
      const rows = await db.getAllAsync<{ hash: string; bytes: number }>(`SELECT hash,bytes FROM stored_objects WHERE hash>? ORDER BY hash LIMIT ${PAGE}`, after);
      for (let start = 0; start < rows.length;) {
        if (cancelled()) throw new CheckFailure('cancelled');
        let end = start + 1, batchBytes = rows[start]!.bytes;
        while (end < rows.length && end - start < BATCH && batchBytes + rows[end]!.bytes <= BATCH_BYTES) batchBytes += rows[end++]!.bytes;
        const batch = rows.slice(start, end);
        const result = await bridge.checkOriginals(batch.map(row => row.hash), batch.map(row => row.bytes));
        if (!result.ok || result.health?.length !== batch.length) throw new CheckFailure(cancelled() ? 'cancelled' : result.code ?? 'check-failed');
        // A cancellation that arrived during the batch wins over its results.
        if (cancelled()) throw new CheckFailure('cancelled');
        result.health.forEach((health, index) => { if (health !== 'valid') problems.push({ ...batch[index]!, health }); });
        checked += batch.length; bytes += batchBytes; start = end;
        progress({ checked, total, bytes, totalBytes });
      }
      if (rows.length < PAGE) break;
      after = rows[rows.length - 1]!.hash;
    }
    if (cancelled()) throw new CheckFailure('cancelled');
    return { total, totalBytes, problems };
  } finally { await bridge.endOriginalCheck().catch(() => {}); }
}

export type Affected = { memories: { id: string; role: string; day: string | null }[]; memoryCount: number };
/** The memories that use each original: up to three, by date, and how many in all. Asked for one page of problems at a
 * time, so a large result never loads every association at once. An original no memory uses has a count of zero. */
export async function affectedMemories(db: SqlDatabase, hashes: string[]): Promise<Map<string, Affected>> {
  const out = new Map<string, Affected>();
  for (const hash of hashes) {
    const memories = await db.getAllAsync<{ id: string; role: string; day: string | null }>(`SELECT m.memory_id AS id, m.role,
      (SELECT min(day) FROM library_dates d WHERE d.memory_id=m.memory_id) AS day FROM memory_objects m WHERE m.object_hash=?
      ORDER BY day IS NULL, day, id LIMIT 3`, hash);
    const count = await db.getFirstAsync<{ n: number }>('SELECT count(DISTINCT memory_id) AS n FROM memory_objects WHERE object_hash=?', hash);
    out.set(hash, { memories, memoryCount: count?.n ?? 0 });
  }
  return out;
}

/** The native side of repair from a backup: a Section 19 inspection session, without the verify-everything pass. */
export interface RepairBridge {
  beginBackupInspection(uri: string): Promise<Result & { inPlace?: boolean }>;
  readBackupManifest(): Promise<Result & { text?: string; done?: boolean }>;
  declareBackupObjects(hashes: string[], sizes: number[]): Promise<Result>;
  sealBackupInspection(): Promise<Result>;
  /** Removes partly written originals left in store staging by an earlier operation. */
  prepareBackupRepair(): Promise<Result>;
  /** warning: on a completed repair, a problem after the replacement (the repaired file is already in place). */
  repairBackupObject(hash: string, bytes: number): Promise<Result & { outcome?: 'repaired' | 'already_valid' | 'unavailable' | 'mismatch'; warning?: string | null }>;
  endBackupInspection(): Promise<Result>;
}
export type RepairProgress = { stage: 'validating' } | { stage: 'repairing'; done: number; total: number };
/** Per problem: repaired (verified bytes now in place); alreadyValid (it verified when repair began, so nothing was
 * written); unavailable (not in this backup); mismatch (the backup's copy failed the length, CRC or SHA-256 check, so
 * nothing changed); failed (with the code), and those not attempted because the run stopped (stopped: its code). */
export type RepairReport = {
  repaired: string[]; alreadyValid: string[]; unavailable: string[]; mismatch: string[]; failed: { hash: string; code: string }[];
  notAttempted: string[]; stopped: string | null; storeCleanupFailed: boolean; cleanupFailed: boolean;
  /** Repaired originals with a problem after their replacement: "thumbnail-eviction-failed" or "sync-failed". */
  warnings: { hash: string; code: string }[];
};
/** Fails before anything was repaired: the backup could not be opened or validated, or store staging could not be
 * prepared. cleanupFailed: a private copy of the backup was left; storeCleanupFailed: a partly written original was
 * left in store staging. Both are reported beside the code, including on cancellation. */
export class RepairFailure extends Error {
  readonly cleanupFailed: boolean; readonly storeCleanupFailed: boolean;
  constructor(code: string, cleanupFailed: boolean, storeCleanupFailed = false) { super(code); this.cleanupFailed = cleanupFailed; this.storeCleanupFailed = storeCleanupFailed; }
}
/** One object could not be repaired, but the others can still be tried; the original is unchanged in each case. */
const PER_OBJECT = new Set(['quarantine-failed', 'repair-target-appeared', 'repair-target-inaccessible', 'thumbnail-eviction-failed']);

/** Opens the chosen backup, validates its manifest and object catalog (versions 1 and 2), then repairs each problem
 * from it. Only the objects being repaired are read. The library database is never written: a repaired original keeps
 * its hash, path and length. The session is always closed, which deletes any private copy of the backup. */
export async function runBackupRepair(bridge: RepairBridge, uri: string, problems: readonly Problem[], cancelled: () => boolean,
  progress: (state: RepairProgress) => void): Promise<RepairReport> {
  const opened = await bridge.beginBackupInspection(uri);
  if (!opened.ok) throw new RepairFailure(cancelled() ? 'cancelled' : opened.code ?? 'backup-unreadable', !!opened.cleanupFailed);
  const report: RepairReport = { repaired: [], alreadyValid: [], unavailable: [], mismatch: [], failed: [], notAttempted: [], stopped: null, storeCleanupFailed: false, cleanupFailed: false, warnings: [] };
  const checked = <T extends Result>(result: T): T => {
    if (!result.ok) { if (result.storeCleanupFailed) report.storeCleanupFailed = true; if (result.cleanupFailed) report.cleanupFailed = true; throw new Error(result.code ?? 'backup-unreadable'); }
    return result;
  };
  let closed = false;
  const close = async () => { if (closed) return; closed = true; if (!(await bridge.endBackupInspection().catch(() => ({ ok: false }))).ok) report.cleanupFailed = true; };
  try {
    progress({ stage: 'validating' });
    try {
      await validateManifest({
        async readManifest() { const chunk = checked(await bridge.readBackupManifest()); return { text: chunk.text ?? '', done: !!chunk.done }; },
        async declare(objects) { checked(await bridge.declareBackupObjects(objects.map(([hash]) => hash), objects.map(([, bytes]) => bytes))); },
        async seal() { checked(await bridge.sealBackupInspection()); },
      }, cancelled);
      checked(await bridge.prepareBackupRepair());
    } catch (error) {
      await close();
      throw new RepairFailure(cancelled() ? 'cancelled' : error instanceof Error ? error.message : 'backup-unreadable', report.cleanupFailed, report.storeCleanupFailed);
    }
    for (const [index, problem] of problems.entries()) {
      if (cancelled()) { report.stopped = 'cancelled'; report.notAttempted.push(...problems.slice(index).map(p => p.hash)); break; }
      progress({ stage: 'repairing', done: index, total: problems.length });
      const result = await bridge.repairBackupObject(problem.hash, problem.bytes);
      if (result.storeCleanupFailed) report.storeCleanupFailed = true;
      if (result.ok && result.outcome) {
        // A repair that finished is reported as repaired even if cancellation arrived just after it.
        ({ repaired: report.repaired, already_valid: report.alreadyValid, unavailable: report.unavailable, mismatch: report.mismatch })[result.outcome].push(problem.hash);
        if (result.outcome === 'repaired' && result.warning) report.warnings.push({ hash: problem.hash, code: result.warning });
        continue;
      }
      if (result.cleanupFailed) report.cleanupFailed = true;
      const code = cancelled() ? 'cancelled' : result.code ?? 'backup-unreadable';
      if (code !== 'cancelled' && PER_OBJECT.has(code)) { report.failed.push({ hash: problem.hash, code }); continue; }
      report.stopped = code; report.notAttempted.push(...problems.slice(index).map(p => p.hash)); break;
    }
    progress({ stage: 'repairing', done: problems.length - report.notAttempted.length, total: problems.length });
  } finally { await close(); }
  return report;
}

/** Warnings on completed repairs, one entry per kind with its count, for one notice each. */
export function repairWarnings(report: RepairReport): [string, number][] {
  const counts = new Map<string, number>();
  for (const warning of report.warnings) counts.set(warning.code, (counts.get(warning.code) ?? 0) + 1);
  return [...counts];
}
