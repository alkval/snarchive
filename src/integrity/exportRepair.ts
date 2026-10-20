import type { SqlDatabase } from '../storage/previewStore.ts';
import { RepairFailure, type Problem, type RepairProgress, type RepairReport } from './originals.ts';

export type ExportKind = 'zip' | 'folder';
type Result = { ok: boolean; code?: string; cleanupFailed?: boolean; storeCleanupFailed?: boolean };
export interface ExportRepairBridge {
  /** sessionOpened also covers a failure after opening, while fetching the archive identity. */
  beginExportRepair(uri: string, kind: ExportKind): Promise<Result & { archiveSha256?: string; sessionOpened?: boolean }>;
  prepareExportRepair(): Promise<Result>;
  repairExportObject(hash: string, bytes: number, path: string): Promise<Result & {
    outcome?: 'repaired' | 'already_valid' | 'mismatch'; warnings?: string[];
  }>;
  endExportRepair(): Promise<Result>;
}

/** Recorded paths are hints, not proof. ZIP candidates belong to the exact selected archive; folder candidates may
 * come from either kind of observation, so an extracted ZIP can repair a ZIP-originated original too. Only completed observations
 * have the original's recorded hash. Page by path so shared objects do not send an unbounded list over the bridge. */
export async function exportCandidates(db: SqlDatabase, kind: ExportKind, archiveHash: string, hash: string, after = ''): Promise<string[]> {
  const rows = await db.getAllAsync<{ path: string }>(
    "SELECT DISTINCT i.relative_path AS path FROM import_items i JOIN import_jobs j ON j.hash=i.job_hash " +
    "WHERE i.state='done' AND i.object_hash=? AND (?='folder' OR (j.kind='zip' AND j.hash=?)) AND i.relative_path>? " +
    "ORDER BY i.relative_path LIMIT 200", hash, kind, archiveHash, after);
  return rows.map(row => row.path);
}

const PER_OBJECT = new Set(['quarantine-failed', 'repair-target-appeared', 'repair-target-inaccessible', 'thumbnail-eviction-failed']);

/** Repairs from one reselected export. No plan is rewritten or created, and no library rows change. Each candidate
 * is streamed by native code through the same exact-byte repair operation used for backups. A rejected candidate
 * leaves the target unchanged, and another recorded path can be tried. A ZIP stamp change stops the whole run. */
export async function runExportRepair(db: SqlDatabase, bridge: ExportRepairBridge, kind: ExportKind, uri: string,
  problems: readonly Problem[], cancelled: () => boolean, progress: (state: RepairProgress) => void): Promise<RepairReport> {
  if (cancelled()) throw new RepairFailure('cancelled', false);
  progress({ stage: 'validating' });
  const opened = await bridge.beginExportRepair(uri, kind);
  if (!opened.ok) {
    // An early busy/open failure owns no session. A failure after opening still needs to release its gate.
    const ended = opened.sessionOpened ? await bridge.endExportRepair().catch(() => ({ ok: false } as Result)) : null;
    throw new RepairFailure(cancelled() ? 'cancelled' : opened.code ?? 'export-unreadable',
      !!opened.cleanupFailed || !!ended && (!ended.ok || !!ended.cleanupFailed),
      !!opened.storeCleanupFailed || !!ended?.storeCleanupFailed);
  }
  const report: RepairReport = { repaired: [], alreadyValid: [], unavailable: [], mismatch: [], failed: [], notAttempted: [],
    stopped: null, storeCleanupFailed: false, cleanupFailed: false, warnings: [] };
  let closed = false;
  const close = async () => {
    if (closed) return; closed = true;
    if (!(await bridge.endExportRepair().catch(() => ({ ok: false }))).ok) report.cleanupFailed = true;
  };
  const stop = (code: string, index: number) => {
    report.stopped = cancelled() ? 'cancelled' : code;
    report.notAttempted.push(...problems.slice(index).map(problem => problem.hash));
  };
  try {
    try {
      if (kind === 'zip' && !/^[a-f0-9]{64}$/.test(opened.archiveSha256 ?? '')) throw new Error('export-unreadable');
      if (kind === 'zip') {
        const recorded = await db.getFirstAsync<{ hash: string }>("SELECT hash FROM import_jobs WHERE kind='zip' AND hash=?", opened.archiveSha256!);
        if (cancelled()) throw new Error('cancelled');
        if (!recorded) {
          report.sourceNotice = 'zip-not-recorded';
          report.unavailable.push(...problems.map(problem => problem.hash));
          progress({ stage: 'repairing', done: problems.length, total: problems.length });
          return report; // No candidates can belong to this ZIP; do not prepare or attempt any originals.
        }
      }
      const prepared = await bridge.prepareExportRepair();
      report.storeCleanupFailed ||= !!prepared.storeCleanupFailed;
      report.cleanupFailed ||= !!prepared.cleanupFailed;
      if (!prepared.ok || cancelled()) throw new Error(cancelled() ? 'cancelled' : prepared.code ?? 'export-unreadable');
    } catch (error) {
      await close();
      throw new RepairFailure(cancelled() ? 'cancelled' : error instanceof Error ? error.message : 'export-unreadable',
        report.cleanupFailed, report.storeCleanupFailed);
    }
    for (const [index, problem] of problems.entries()) {
      if (cancelled()) { stop('cancelled', index); break; }
      progress({ stage: 'repairing', done: index, total: problems.length });
      let after = '', mismatch = false, sourceIssue: string | null = null, finished = false;
      try {
        for (;;) {
          if (cancelled()) { stop('cancelled', index); break; }
          const paths = await exportCandidates(db, kind, opened.archiveSha256 ?? '', problem.hash, after);
          for (const path of paths) {
            if (cancelled()) { stop('cancelled', index); break; }
            const result = await bridge.repairExportObject(problem.hash, problem.bytes, path);
            report.storeCleanupFailed ||= !!result.storeCleanupFailed;
            report.cleanupFailed ||= !!result.cleanupFailed;
            if (result.ok && (result.outcome === 'repaired' || result.outcome === 'already_valid')) {
              (result.outcome === 'repaired' ? report.repaired : report.alreadyValid).push(problem.hash);
              if (result.outcome === 'repaired') for (const code of result.warnings ?? []) report.warnings.push({ hash: problem.hash, code });
              finished = true; break; // A finished repair wins over a cancellation arriving after replacement.
            }
            if (cancelled()) { stop('cancelled', index); break; }
            if (result.ok && result.outcome === 'mismatch') { mismatch = true; continue; }
            const code = result.code ?? 'export-unreadable';
            if (code === 'source-missing') continue;
            if (code === 'source-unreadable' || kind === 'folder' && code === 'source-changed') { sourceIssue = code; continue; }
            if (PER_OBJECT.has(code)) { report.failed.push({ hash: problem.hash, code }); finished = true; break; }
            stop(code, index); break;
          }
          if (finished || report.stopped || paths.length < 200) break;
          after = paths[paths.length - 1]!;
        }
      } catch (error) {
        // A bridge or database rejection after earlier repairs must preserve the partial report.
        stop(error instanceof Error ? error.message : 'export-unreadable', index);
      }
      if (report.stopped) break;
      if (!finished) {
        if (sourceIssue) report.failed.push({ hash: problem.hash, code: sourceIssue });
        else if (mismatch) report.mismatch.push(problem.hash);
        else report.unavailable.push(problem.hash);
      }
    }
    progress({ stage: 'repairing', done: problems.length - report.notAttempted.length, total: problems.length });
  } finally { await close(); }
  return report;
}
