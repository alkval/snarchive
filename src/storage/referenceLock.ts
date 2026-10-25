import type { SqlConnection } from './previewStore.ts';

/** Expo begins a deferred transaction. Reserve the WAL writer before reading the reference proof, and keep it
 * until the transaction ends. This changes no rows; a read transaction alone would allow concurrent writers. */
export async function lockObjectReferences(tx: SqlConnection): Promise<void> {
  await tx.runAsync('DELETE FROM stored_objects WHERE 0');
}
