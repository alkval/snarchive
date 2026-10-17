import { openDatabaseAsync } from 'expo-sqlite';
import { PreviewStore } from '../storage/previewStore';
let opening: Promise<PreviewStore> | undefined;
export function openPreviewStore(): Promise<PreviewStore> {
  if (!opening) opening = (async () => {
    const database = await openDatabaseAsync('snarchive-preview.db');
    try {
      const store = new PreviewStore(database);
      await store.initialize();
      return store;
    } catch {
      await database.closeAsync();
      throw new Error('preview-storage-unavailable');
    }
  })().catch(error => { opening = undefined; throw error; });
  return opening;
}
