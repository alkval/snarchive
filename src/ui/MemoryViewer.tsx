import { StatusBar } from 'expo-status-bar';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Animated, Easing, Image, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { ImportStore, LibraryRow } from '../storage/importStore';
import { originalUri, originalVideo, type LocalVideo } from '../platform/originalImporter';
import { matchingAspect, type ImageSize } from '../domain/photoGeometry';
import { VideoPlayerView } from './VideoPlayerView';
import { FavoriteButton } from './FavoriteButton';
import { FadeImage, MediaButton } from './kit';
import { type, useTheme } from './theme';
import { en } from '../i18n/en';

type Photo = { uri: string; size: ImageSize };
function measure(uri: string): Promise<Photo> {
  return new Promise((resolve, reject) => Image.getSize(uri, (width, height) => resolve({ uri, size: { width, height } }), reject));
}

// Dates are recorded in UTC; format them in UTC so a day never shifts with the device time zone.
function formatter(options: Intl.DateTimeFormatOptions) {
  try { return new Intl.DateTimeFormat(undefined, { ...options, timeZone: 'UTC' }); } catch { return null; }
}
const dayFormat = formatter({ weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const shortDayFormat = formatter({ day: 'numeric', month: 'short', year: 'numeric' });
const timeFormat = formatter({ hour: '2-digit', minute: '2-digit' });

export function dayTitle(day: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  return dayFormat && !Number.isNaN(date.getTime()) ? dayFormat.format(date) : day;
}
function shortDay(day: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  return shortDayFormat && !Number.isNaN(date.getTime()) ? shortDayFormat.format(date) : day;
}
/** Title is the date alone so it fits a top bar; the caption carries the time and where the date came from. */
export function memoryDate(row: LibraryRow): { title: string; caption: string } {
  if (row.dateConflict) return { title: en.libraryDateConflict, caption: '' };
  if (row.instant) {
    const date = new Date(row.instant);
    if (!timeFormat || Number.isNaN(date.getTime())) return { title: row.instant.replace('T', ' ').replace('.000Z', ' UTC').replace('Z', ' UTC'), caption: en.libraryMetadata.replace(/^./, letter => letter.toUpperCase()) };
    return { title: shortDay(row.instant.slice(0, 10)), caption: `${timeFormat.format(date)} UTC · ${en.libraryMetadata}` };
  }
  if (row.day) return { title: shortDay(row.day), caption: en.libraryInferred };
  return { title: en.libraryUnknownDate, caption: '' };
}

export function MemoryViewer({ row, store, onBack, onFavoriteSaved }: { row: LibraryRow & { favorite: number }; store: ImportStore; onBack: () => void; onFavoriteSaved: () => void }) {
  const t = useTheme();
  const date = memoryDate(row);
  const [video, setVideo] = useState<LocalVideo | null>(null);
  const [base, setBase] = useState<Photo | null>(null);
  const [overlay, setOverlay] = useState<Photo | null>(null);
  const [showOverlay, setShowOverlay] = useState(false);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState('');
  const [overlayStatus, setOverlayStatus] = useState('');
  const [favoriteError, setFavoriteError] = useState('');
  const overlayOpacity = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(overlayOpacity, { toValue: showOverlay ? 1 : 0, duration: 150, easing: Easing.bezier(0.23, 1, 0.32, 1), useNativeDriver: true }).start();
  }, [showOverlay, overlayOpacity]);
  useEffect(() => {
    let active = true;
    void (async () => {
      if (row.photos + row.videos !== 1) { setStatus(en.libraryVariants); setLoading(false); return; }
      try {
        const objects = await store.objects(row.id);
        const object = objects.find(item => item.role === (row.videos ? 'video' : 'photo'));
        if (!object) throw new Error('missing-object');
        if (row.videos) {
          const local = await originalVideo(object);
          if (active) { setVideo(local); setLoading(false); }
          return;
        }
        const photo = await measure(await originalUri(object));
        if (!active) return;
        setBase(photo); setLoading(false);
        if (row.overlays > 1) { setOverlayStatus(en.libraryOverlayVariants); return; }
        const layer = objects.find(item => item.role === 'overlay');
        if (!layer) return;
        try {
          const image = await measure(await originalUri(layer));
          if (!active) return;
          if (!matchingAspect(photo.size, image.size)) { setOverlayStatus(en.libraryOverlaySize); return; }
          setOverlay(image);
        } catch { if (active) setOverlayStatus(en.libraryOverlayFailed); }
      } catch { if (active) { setStatus(row.videos ? en.libraryVideoFailed : en.libraryPhotoFailed); setLoading(false); } }
    })();
    return () => { active = false; };
  }, [row, store]);
  const note = favoriteError || overlayStatus;
  return <View style={[styles.root, { backgroundColor: t.media }]}>
    <StatusBar style="light" />
    <SafeAreaView style={styles.root}>
      <View style={styles.topBar}>
        <View style={styles.side}><MediaButton icon="chevron-back" label={en.libraryBack} onPress={onBack} /></View>
        <View style={styles.titleBlock} accessible accessibilityRole="header" accessibilityLabel={[date.title, date.caption].filter(Boolean).join(', ')}>
          <Text numberOfLines={1} style={[type.headline, { color: t.onMedia }]}>{date.title}</Text>
          {!!date.caption && <Text numberOfLines={2} style={[type.caption, { color: t.onMediaSecondary, textAlign: 'center' }]}>{date.caption}</Text>}
        </View>
        <View style={[styles.side, styles.right]}>
          <FavoriteButton id={row.id} initial={row.favorite === 1} store={store} saved={onFavoriteSaved} failed={setFavoriteError} />
        </View>
      </View>
      <View style={styles.stage}>
        {loading && <ActivityIndicator color={t.onMediaSecondary} accessibilityLabel={en.libraryLoading} />}
        {!!status && <Text accessibilityLiveRegion="polite" style={[type.body, styles.status, { color: t.onMedia }]}>{status}</Text>}
        {video && <VideoPlayerView video={video} row={row} store={store} />}
        {base && <View style={StyleSheet.absoluteFill}>
          <FadeImage accessibilityLabel={en.libraryPhoto} source={{ uri: base.uri }} resizeMode="contain" style={StyleSheet.absoluteFill}
            onError={() => { setBase(null); setOverlay(null); setStatus(en.libraryPhotoFailed); }} />
          {overlay && <Animated.Image accessible={false} pointerEvents="none" source={{ uri: overlay.uri }} resizeMode="contain" style={[StyleSheet.absoluteFill, { opacity: overlayOpacity }]}
            onError={() => { setOverlay(null); setOverlayStatus(en.libraryOverlayFailed); }} />}
        </View>}
      </View>
      {(!!note || (base && overlay)) && <View style={styles.bottomBar}>
        {!!note && <Text accessibilityLiveRegion="polite" style={[type.footnote, styles.note, { color: t.onMediaSecondary }]}>{note}</Text>}
        {base && overlay && <View style={styles.overlayControl}>
          <MediaButton icon={showOverlay ? 'layers' : 'layers-outline'} label={showOverlay ? en.libraryHideOverlay : en.libraryShowOverlay} onPress={() => setShowOverlay(value => !value)} />
          <Text style={[type.footnote, { color: t.onMediaSecondary }]}>{showOverlay ? en.libraryHideOverlay : en.libraryShowOverlay}</Text>
        </View>}
      </View>}
    </SafeAreaView>
  </View>;
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  topBar: { minHeight: 56, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12 },
  side: { width: 56, justifyContent: 'center' },
  right: { alignItems: 'flex-end' },
  titleBlock: { flex: 1, alignItems: 'center', paddingHorizontal: 8 },
  stage: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  status: { textAlign: 'center', paddingHorizontal: 32 },
  bottomBar: { paddingHorizontal: 20, paddingVertical: 12, gap: 12, alignItems: 'center' },
  note: { textAlign: 'center' },
  overlayControl: { alignItems: 'center', gap: 6 },
});
