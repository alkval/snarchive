import { en } from '../i18n/en.ts';

/** Favourite saves in flight, owned by the library browser rather than a viewer, so a save keeps its meaning when the
 * user moves to another memory and back before it finishes. Rows hold the saved (authoritative) state; this holds
 * only what is pending or failed. At most one write per memory runs at a time. */
export class FavoriteWrites {
  private pending = new Map<string, boolean>();
  private failed = new Set<string>();
  private listeners = new Set<() => void>();
  private readonly save: (id: string, favorite: boolean) => Promise<void>;
  private readonly saved: (id: string, favorite: boolean) => void;

  /** saved runs after a write is stored, with the new state, so the caller can update its rows. */
  constructor(save: (id: string, favorite: boolean) => Promise<void>, saved: (id: string, favorite: boolean) => void) {
    this.save = save; this.saved = saved;
  }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private changed() { for (const listener of [...this.listeners]) listener(); }
  isPending(id: string): boolean { return this.pending.has(id); }
  hasFailed(id: string): boolean { return this.failed.has(id); }

  /** Writes the opposite of `current` (the row's saved state). Ignored while a write for this memory is pending. */
  async toggle(id: string, current: boolean): Promise<void> {
    if (this.pending.has(id)) return;
    const next = !current;
    this.pending.set(id, next); this.failed.delete(id); this.changed();
    try { await this.save(id, next); this.pending.delete(id); this.saved(id, next); }
    catch { this.pending.delete(id); this.failed.add(id); }
    finally { this.changed(); }
  }
}

/** What the favourite button shows. The heart fills only once a change is saved, so it never shows a state the
 * library does not have; while saving it is disabled. */
export function favoriteButtonState(favorite: boolean, pending: boolean): { icon: 'heart' | 'heart-outline'; label: string; disabled: boolean } {
  return { icon: favorite ? 'heart' : 'heart-outline', label: pending ? en.favoriteSaving : favorite ? en.favoriteRemove : en.favoriteAdd, disabled: pending };
}
