import { useEffect, useRef, useState } from 'react';
import type { ImportStore } from '../storage/importStore';
import { en } from '../i18n/en';
import { MediaButton } from './kit';

export function FavoriteButton({ id, initial, store, saved, failed }: { id: string; initial: boolean; store: ImportStore; saved: (favorite: boolean) => void; failed: (message: string) => void }) {
  const [favorite, setFavorite] = useState(initial);
  const [saving, setSaving] = useState(false);
  const lock = useRef(false), active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  async function toggle() {
    if (lock.current) return;
    lock.current = true; setSaving(true); failed('');
    try { await store.setFavorite(id, !favorite); saved(!favorite); if (active.current) setFavorite(!favorite); }
    catch { if (active.current) failed(en.favoriteFailed); }
    finally { lock.current = false; if (active.current) setSaving(false); }
  }
  // The heart fills only once the change is saved, so it never shows a state the library does not have.
  return <MediaButton icon={favorite ? 'heart' : 'heart-outline'} disabled={saving}
    label={saving ? en.favoriteSaving : favorite ? en.favoriteRemove : en.favoriteAdd} onPress={() => void toggle()} />;
}
