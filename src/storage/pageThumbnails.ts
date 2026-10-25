import type { ImportStore, LibraryRow, LibraryObject } from './importStore.ts';

/** One page, one active decode, no automatic retries for failed media. */
export async function pageThumbnails(
  rows: readonly LibraryRow[], store: Pick<ImportStore, 'objects'>,
  create: (object: LibraryObject, video: boolean, overlay?: LibraryObject) => Promise<string>,
  stopped: () => boolean, publish: (id: string, uri: string | null) => void,
): Promise<void> {
  const results = new Map<string, string | null>();
  for (const row of rows.slice(0, 30)) {
    if (stopped()) return;
    if (row.photos + row.videos !== 1) { publish(row.id, null); continue; }
    let uri: string | null = null;
    try {
      const objects = await store.objects(row.id);
      const object = objects.find(item => item.role !== 'overlay');
      const overlay = row.overlays === 1 ? objects.find(item => item.role === 'overlay') : undefined;
      if (stopped()) return;
      if (object) {
        const key = `${object.sha256}:${object.role}:${overlay?.sha256 ?? 'none'}`;
        if (!results.has(key)) {
          try { results.set(key, await create(object, object.role === 'video', overlay)); }
          catch { results.set(key, null); }
        }
        uri = results.get(key) ?? null;
      }
    } catch { /* A missing derivative never prevents opening the original. */ }
    if (stopped()) return;
    publish(row.id, uri);
  }
}
