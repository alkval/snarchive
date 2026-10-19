// Helper process for backupRestore.test.ts: applies a whole manifest inside the restore transaction, then dies
// before COMMIT, as a killed app would. Not a test file itself (no .test suffix).
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { BackupManifestValidator } from '../src/backup/manifest.ts';
import { RestoreMerge } from '../src/backup/restoreMerge.ts';
import type { SqlConnection } from '../src/storage/previewStore.ts';

const [path, manifestPath] = process.argv.slice(2) as [string, string];
const raw = new DatabaseSync(path);
const tx: SqlConnection = {
  async execAsync(sql) { raw.exec(sql); },
  async runAsync(sql, ...p) { raw.prepare(sql).run(...p); },
  async getFirstAsync<T>(sql: string, ...p: (string | number | null)[]) { return (raw.prepare(sql).get(...p) as T | undefined) ?? null; },
  async getAllAsync<T>(sql: string, ...p: (string | number | null)[]) { return raw.prepare(sql).all(...p) as T[]; },
};
raw.exec('BEGIN IMMEDIATE');
const merge = new RestoreMerge(tx); await merge.begin();
const validator = new BackupManifestValidator({ keepRecords: true });
validator.push(readFileSync(manifestPath, 'utf8'));
for (const record of validator.takeRecords()) await merge.apply(record);
validator.finish(); await merge.finish();
process.exit(9); // Killed before COMMIT.
