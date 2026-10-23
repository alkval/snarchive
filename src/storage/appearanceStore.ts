import { isAppearanceChoice, type AppearanceChoice, type AppearanceRepository } from '../domain/appearance.ts';
import type { SqlConnection, SqlDatabase } from './previewStore.ts';

/** Device preferences live in their own database, outside library backup/restore and its writer guard. */
export class AppearanceStore implements AppearanceRepository {
  private readonly db: SqlDatabase;
  constructor(db: SqlDatabase) { this.db = db; }
  private async version(tx: SqlConnection): Promise<void> {
    const row = await tx.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
    if (row?.user_version !== 1) throw new Error('unsupported-preferences-version');
  }
  async initialize(): Promise<void> {
    await this.db.execAsync('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
    await this.db.withExclusiveTransactionAsync(async tx => {
      const row = await tx.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
      if (row?.user_version === 1) return;
      if (row?.user_version !== 0) throw new Error('unsupported-preferences-version');
      await tx.execAsync(`CREATE TABLE appearance (
        id INTEGER PRIMARY KEY CHECK(id = 1),
        choice TEXT NOT NULL CHECK(choice IN ('system', 'light', 'dark'))
      ); PRAGMA user_version = 1;`);
    });
  }
  async load(): Promise<AppearanceChoice> {
    let choice: AppearanceChoice = 'system';
    await this.db.withExclusiveTransactionAsync(async tx => {
      await this.version(tx);
      const row = await tx.getFirstAsync<{ choice: unknown }>('SELECT choice FROM appearance WHERE id = 1');
      if (!row) return;
      if (!isAppearanceChoice(row.choice)) throw new Error('invalid-appearance');
      choice = row.choice;
    });
    return choice;
  }
  async save(choice: AppearanceChoice): Promise<void> {
    if (!isAppearanceChoice(choice)) throw new Error('invalid-appearance');
    await this.db.withExclusiveTransactionAsync(async tx => {
      await this.version(tx);
      await tx.runAsync(`INSERT INTO appearance (id, choice) VALUES (1, ?)
        ON CONFLICT(id) DO UPDATE SET choice = excluded.choice`, choice);
    });
  }
}
