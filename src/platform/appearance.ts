import { openDatabaseAsync } from 'expo-sqlite';
import type { AppearanceRepository } from '../domain/appearance';
import { AppearanceStore } from '../storage/appearanceStore';

let opening: Promise<AppearanceStore> | undefined;
function openStore(): Promise<AppearanceStore> {
  if (!opening) opening = (async () => {
    const db = await openDatabaseAsync('snarchive-preferences.db');
    try {
      const store = new AppearanceStore(db);
      await store.initialize();
      return store;
    } catch {
      await db.closeAsync();
      throw new Error('preferences-unavailable');
    }
  })().catch(error => { opening = undefined; throw error; });
  return opening;
}
export const appearanceRepository: AppearanceRepository = {
  load: async () => (await openStore()).load(),
  save: async choice => (await openStore()).save(choice),
};
