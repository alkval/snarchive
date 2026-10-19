import { useEffect, useRef, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import type { ImportStore } from '../storage/importStore';
import { en } from '../i18n/en';
export function FavoriteButton({ id, initial, store, saved }: { id: string; initial: boolean; store: ImportStore; saved: () => void }) {
  const [favorite, setFavorite] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const lock = useRef(false), active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  async function toggle() {
    if (lock.current) return;
    lock.current = true; setSaving(true); setFailed(false);
    try { await store.setFavorite(id, !favorite); saved(); if (active.current) setFavorite(!favorite); }
    catch { if (active.current) setFailed(true); }
    finally { lock.current = false; if (active.current) setSaving(false); }
  }
  return <View>
    <Pressable accessibilityRole="button" accessibilityState={{ disabled: saving, selected: favorite }} disabled={saving} onPress={() => void toggle()} style={{ padding: 12, minHeight: 48, borderWidth: 1, borderColor: '#b9dec8', borderRadius: 8 }}>
      <Text style={{ color: '#f3f4ef', fontSize: 16 }}>{saving ? en.favoriteSaving : favorite ? en.favoriteRemove : en.favoriteAdd}</Text>
    </Pressable>
    {failed && <Text accessibilityLiveRegion="polite" style={{ color: '#f3f4ef' }}>{en.favoriteFailed}</Text>}
  </View>;
}
