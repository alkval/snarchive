import { StatusBar } from 'expo-status-bar';
import { useEffect, useRef, useState } from 'react';
import { FlatList, Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { ImportStore, LibraryRow, LibraryCursor, ChronologicalRow } from '../storage/importStore';
import { VideoPlayerView } from './VideoPlayerView';
import { thumbnail, originalUri, originalVideo, type LocalVideo } from '../platform/originalImporter';
import { matchingAspect, type ImageSize } from '../domain/photoGeometry';
import { pageThumbnails } from '../storage/pageThumbnails';
import { defaultFilters, type LibraryFilters } from '../domain/libraryFilters';
import { LibraryFilterForm } from './LibraryFilters';
import { FavoriteButton } from './FavoriteButton';
import { en } from '../i18n/en';

type Photo = { uri: string; size: ImageSize };
function measure(uri: string): Promise<Photo> {
  return new Promise((resolve, reject) => Image.getSize(uri, (width, height) => resolve({ uri, size: { width, height } }), reject));
}
function dateLabel(row: LibraryRow): string {
  return row.dateConflict ? en.libraryDateConflict : row.instant ? `${row.instant.replace('T', ' ').replace('.000Z', ' UTC').replace('Z', ' UTC')} ${en.libraryMetadata}`
    : row.day ? `${row.day} ${en.libraryInferred}` : en.libraryUnknownDate;
}
function Button({ label, onPress, disabled = false }: { label: string; onPress: () => void; disabled?: boolean }) {
  return <Pressable accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled} onPress={onPress} style={[styles.button, disabled && { opacity: 0.5 }]}><Text style={styles.buttonText}>{label}</Text></Pressable>;
}
export function LibraryBrowser({ store, onClose }: { store: ImportStore; onClose: () => void }) {
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const [filters, setFilters] = useState<LibraryFilters>({ ...defaultFilters });
  const [editingFilters, setEditingFilters] = useState(false);
  const [rows, setRows] = useState<ChronologicalRow[]>([]);
  const [cursor, setCursor] = useState<LibraryCursor | null>(null);
  const [history, setHistory] = useState<(LibraryCursor | null)[]>([]);
  const [previews, setPreviews] = useState<Record<string, string | null>>({});
  const [next, setNext] = useState(false);
  const [selected, setSelected] = useState<ChronologicalRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true; setLoading(true); setFailed(false); setRows([]); setPreviews({});
    void store.chronologicalPage(cursor, 31, filters).then(page => { if (active) { setRows(page.slice(0, 30)); setNext(page.length > 30); } })
      .catch(() => { if (active) setFailed(true); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [store, cursor, retry, filters]);
  useEffect(() => {
    let stopped = false;
    if (!selected) void pageThumbnails(rows, store, thumbnail, () => stopped,
      (id, uri) => setPreviews(previous => ({ ...previous, [id]: uri })));
    return () => { stopped = true; };
  }, [rows, selected, store]);
  return <SafeAreaView style={styles.root}>
    <StatusBar style="light" />
    <Button label={selected ? en.libraryBack : en.libraryClose} onPress={selected ? () => { setSelected(null); setRetry(value => value + 1); } : onClose} />
    {selected ? <>
      <FavoriteButton key={`favorite-${selected.id}`} id={selected.id} initial={selected.favorite === 1} store={store} saved={() => { if (active.current) { setCursor(null); setHistory([]); setRetry(value => value + 1); } }} />
      <PhotoViewer key={selected.id} row={selected} store={store} />
    </> : editingFilters ? <LibraryFilterForm current={filters} cancel={() => setEditingFilters(false)} apply={value => { setFilters(value); setCursor(null); setHistory([]); setEditingFilters(false); }} /> : <>
      <Text accessibilityRole="header" style={styles.title}>{en.libraryTitle}</Text>
      <Text style={styles.text}>{en.libraryOrder}</Text>
      <Button label={en.filterSummary(filters.media, filters.favorites, filters.month)} onPress={() => setEditingFilters(true)} />
      {loading ? <Text style={styles.text}>{en.libraryLoading}</Text> : failed ? <><Text style={styles.text}>{en.libraryFailed}</Text><Button label={en.libraryRetry} onPress={() => setRetry(value => value + 1)} /></> : <>
        <FlatList key={JSON.stringify(cursor)} data={rows} keyExtractor={row => row.id} ListEmptyComponent={<Text style={styles.text}>{en.filterEmpty}</Text>}
          renderItem={({ item }) => <Pressable accessibilityRole="button" onPress={() => setSelected(item)} style={styles.row}>
            <View style={styles.thumbnail}>
              {previews[item.id] ? <Image accessible={false} source={{ uri: previews[item.id]! }} resizeMode="contain" style={StyleSheet.absoluteFill} onError={() => setPreviews(previous => ({ ...previous, [item.id]: null }))} />
                : <Text style={styles.id}>{previews[item.id] === undefined ? en.thumbnailLoading : en.thumbnailMissing}</Text>}
            </View>
            <View style={styles.rowText}><Text style={styles.text}>{dateLabel(item)}</Text><Text style={styles.id}>{item.favorite ? `${en.favoriteLabel} · ${item.id}` : item.id}</Text>
            <Text style={styles.text}>{en.libraryKinds(item.photos, item.videos, item.overlays)}</Text></View>
          </Pressable>} />
        <View style={styles.navigation}><Button label={en.libraryPrevious} disabled={!history.length} onPress={() => { setCursor(history[history.length - 1]!); setHistory(history.slice(0, -1)); }} />
          <Button label={en.libraryNext} disabled={!next} onPress={() => { setHistory([...history, cursor]); const last = rows[rows.length - 1]!; setCursor({ day: last.sortDay, time: last.sortTime, id: last.id }); }} /></View>
      </>}
    </>}
  </SafeAreaView>;
}
function PhotoViewer({ row, store }: { row: LibraryRow; store: ImportStore }) {
  const [video, setVideo] = useState<LocalVideo | null>(null);
  const [base, setBase] = useState<Photo | null>(null);
  const [overlay, setOverlay] = useState<Photo | null>(null);
  const [showOverlay, setShowOverlay] = useState(false);
  const [status, setStatus] = useState(en.libraryLoading);
  const [overlayStatus, setOverlayStatus] = useState('');
  useEffect(() => {
    let active = true;
    void (async () => {
      if (row.photos + row.videos !== 1) { setStatus(en.libraryVariants); return; }
      try {
        const objects = await store.objects(row.id);
        const object = objects.find(item => item.role === (row.videos ? 'video' : 'photo'));
        if (!object) throw new Error('missing-object');
        if (row.videos) {
          const local = await originalVideo(object);
          if (active) { setVideo(local); setStatus(''); }
          return;
        }
        const photo = await measure(await originalUri(object));
        if (!active) return;
        setBase(photo); setStatus('');
        if (row.overlays > 1) { setOverlayStatus(en.libraryOverlayVariants); return; }
        const layer = objects.find(item => item.role === 'overlay');
        if (!layer) return;
        try {
          const image = await measure(await originalUri(layer));
          if (!active) return;
          if (!matchingAspect(photo.size, image.size)) { setOverlayStatus(en.libraryOverlaySize); return; }
          setOverlay(image);
        } catch { if (active) setOverlayStatus(en.libraryOverlayFailed); }
      } catch { if (active) setStatus(row.videos ? en.libraryVideoFailed : en.libraryPhotoFailed); }
    })();
    return () => { active = false; };
  }, [row, store]);
  return <View style={styles.viewer}>
    <Text style={styles.text}>{dateLabel(row)}</Text><Text style={styles.id}>{row.id}</Text>
    {!!status && <Text accessibilityLiveRegion="polite" style={styles.text}>{status}</Text>}
    {video && <VideoPlayerView video={video} row={row} store={store} />}
    {base && <View style={styles.canvas}>
      <Image accessibilityLabel={en.libraryPhoto} source={{ uri: base.uri }} resizeMode="contain" style={StyleSheet.absoluteFill} onError={() => { setBase(null); setOverlay(null); setStatus(en.libraryPhotoFailed); }} />
      {overlay && showOverlay && <Image accessible={false} source={{ uri: overlay.uri }} resizeMode="contain" style={StyleSheet.absoluteFill} onError={() => { setOverlay(null); setOverlayStatus(en.libraryOverlayFailed); }} />}
    </View>}
    {!!overlayStatus && <Text style={styles.text}>{overlayStatus}</Text>}
    {overlay && <Button label={showOverlay ? en.libraryHideOverlay : en.libraryShowOverlay} onPress={() => setShowOverlay(value => !value)} />}
  </View>;
}
const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#151817', padding: 16, gap: 12 },
  title: { fontSize: 24, fontWeight: '600', color: '#f3f4ef' }, text: { fontSize: 16, lineHeight: 23, color: '#f3f4ef' },
  id: { fontSize: 13, color: '#b9c2bc' }, thumbnail: { width: 96, height: 96, backgroundColor: '#000000', alignItems: 'center', justifyContent: 'center', padding: 6 }, rowText: { flex: 1, gap: 6 },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 18, gap: 12, borderBottomWidth: 1, borderBottomColor: '#506056' },
  button: { padding: 14, minHeight: 48, backgroundColor: '#b9dec8', borderRadius: 8, alignItems: 'center' }, buttonText: { color: '#162d20', fontSize: 16, fontWeight: '600' },
  navigation: { flexDirection: 'row', justifyContent: 'space-between' }, viewer: { flex: 1, gap: 12 }, canvas: { flex: 1, backgroundColor: '#000000' },
});
