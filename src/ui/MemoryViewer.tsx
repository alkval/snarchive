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
import { GestureStage, type GestureStageHandle } from './GestureStage';
import { PhotoControls } from './PhotoControls';
import { EMPTY_PHOTO_CONTROLS } from '../domain/viewerGestures';
import type { Direction, NeighbourState } from '../domain/memoryNavigation';
import { type, useReducedMotion, useTheme } from './theme';
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

/** What the viewer needs to move through the filtered library; MemoryPager supplies it. */
export type ViewerNavigation = { previous: NeighbourState; next: NeighbourState; go: (direction: Direction) => void; failed: Direction | null };

/** One memory, fullscreen. Keyed by memory ID by its parent, so moving to another memory starts from a clean state:
 * zoom, overlay toggle, loads and the video player all belong to the memory they were created for. */
/** The favourite state of the open memory: `pending` and `failed` come from writes that outlive this viewer. */
export type ViewerFavorite = { pending: boolean; failed: boolean; toggle: () => void };

export function MemoryViewer({ row, store, onBack, favorite, navigation }: {
  row: LibraryRow & { favorite: number }; store: ImportStore; onBack: () => void; favorite: ViewerFavorite; navigation: ViewerNavigation;
}) {
  const t = useTheme();
  const reduced = useReducedMotion();
  const date = memoryDate(row);
  const [video, setVideo] = useState<LocalVideo | null>(null);
  const [base, setBase] = useState<Photo | null>(null);
  const [overlay, setOverlay] = useState<Photo | null>(null);
  const [showOverlay, setShowOverlay] = useState(true);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState('');
  const [overlayStatus, setOverlayStatus] = useState('');
  const stage = useRef<GestureStageHandle>(null);
  const [controlsOpen, setControlsOpen] = useState(false);
  const [controls, setControls] = useState(EMPTY_PHOTO_CONTROLS);
  const [zoomed, setZoomed] = useState(false);
  const [resetToken, setResetToken] = useState(0);
  const overlayOpacity = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    const toValue = showOverlay ? 1 : 0;
    if (reduced) { overlayOpacity.setValue(toValue); return; }
    Animated.timing(overlayOpacity, { toValue, duration: 150, easing: Easing.bezier(0.23, 1, 0.32, 1), useNativeDriver: true }).start();
  }, [showOverlay, overlayOpacity, reduced]);
  // Loads only for this memory: a result that arrives after the viewer moved on is dropped (`active`).
  const { id, photos, videos, overlays } = row;
  useEffect(() => {
    let active = true;
    void (async () => {
      if (photos + videos !== 1) { setStatus(en.libraryVariants); setLoading(false); return; }
      try {
        const objects = await store.objects(id);
        const object = objects.find(item => item.role === (videos ? 'video' : 'photo'));
        if (!object) throw new Error('missing-object');
        if (videos) {
          const local = await originalVideo(object);
          if (active) { setVideo(local); setLoading(false); }
          return;
        }
        const photo = await measure(await originalUri(object));
        if (!active) return;
        setBase(photo); setLoading(false);
        if (overlays > 1) { setOverlayStatus(en.libraryOverlayVariants); return; }
        const layer = objects.find(item => item.role === 'overlay');
        if (!layer) return;
        try {
          const image = await measure(await originalUri(layer));
          if (!active) return;
          if (!matchingAspect(photo.size, image.size)) { setOverlayStatus(en.libraryOverlaySize); return; }
          setOverlay(image);
        } catch { if (active) setOverlayStatus(en.libraryOverlayFailed); }
      } catch { if (active) { setStatus(videos ? en.libraryVideoFailed : en.libraryPhotoFailed); setLoading(false); } }
    })();
    return () => { active = false; };
  }, [id, photos, videos, overlays, store]);
  const navigate = (direction: Direction) => { if (navigation[direction] !== 'end') navigation.go(direction); };
  const note = (favorite.failed ? en.favoriteFailed : '') || overlayStatus || (navigation.failed ? en.viewerNavigationFailed(navigation.failed) : '');
  const stageContent = base ? <View style={StyleSheet.absoluteFill}>
    <FadeImage accessibilityLabel={en.libraryPhoto} source={{ uri: base.uri }} resizeMode="contain" style={StyleSheet.absoluteFill}
      onError={() => { setBase(null); setOverlay(null); setStatus(en.libraryPhotoFailed); }} />
    {overlay && <Animated.Image accessible={false} source={{ uri: overlay.uri }} resizeMode="contain" style={[StyleSheet.absoluteFill, { opacity: overlayOpacity }]}
      onError={() => { setOverlay(null); setOverlayStatus(en.libraryOverlayFailed); }} />}
  </View> : <View style={styles.centred}>
    {loading && <ActivityIndicator color={t.onMediaSecondary} accessibilityLabel={en.libraryLoading} />}
    {!!status && <Text accessibilityLiveRegion="polite" style={[type.body, styles.status, { color: t.onMedia }]}>{status}</Text>}
  </View>;
  const step = (direction: Direction) => {
    const state = navigation[direction];
    return <MediaButton icon={direction === 'previous' ? 'arrow-back' : 'arrow-forward'}
      label={state === 'loading' ? en.libraryLoading : state === 'end' ? en.viewerNone(direction) : en.viewerStep(direction)}
      disabled={state === 'end' || state === 'loading'} onPress={() => navigate(direction)} />;
  };
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
          <FavoriteButton favorite={row.favorite === 1} pending={favorite.pending} onToggle={favorite.toggle} />
        </View>
      </View>
      {video ? <VideoPlayerView video={video} row={row} store={store} onNavigate={navigate} />
        : <GestureStage ref={stage} onControlsChange={setControls} zoomable={!!base} content={base?.size ?? null} onNavigate={navigate} onZoomChange={setZoomed} resetToken={resetToken}>{stageContent}</GestureStage>}
      <View style={styles.bottomBar}>
        {!!note && <Text accessibilityLiveRegion="polite" style={[type.footnote, styles.note, { color: t.onMediaSecondary }]}>{note}</Text>}
        <View style={styles.controls}>
          {step('previous')}
          <View style={styles.middle}>
            {base && <View style={styles.control}>
              <MediaButton icon="options-outline" label={en.viewerPhotoControls} disabled={!controls.ready} onPress={() => { stage.current?.cancel(); setControlsOpen(true); }} />
              <Text style={[type.footnote, { color: t.onMediaSecondary }]}>{en.viewerPhotoControls}</Text>
            </View>}
            {base && overlay && <View style={styles.control}>
              <MediaButton icon={showOverlay ? 'layers' : 'layers-outline'} label={showOverlay ? en.libraryHideOverlay : en.libraryShowOverlay} onPress={() => setShowOverlay(value => !value)} />
              <Text style={[type.footnote, { color: t.onMediaSecondary }]}>{showOverlay ? en.libraryHideOverlay : en.libraryShowOverlay}</Text>
            </View>}
            {/* Always laid out for a photo, so the stage keeps its size when zoom starts or ends; hidden and inert at fit. */}
            {base && <View style={[styles.control, !zoomed && styles.hidden]} pointerEvents={zoomed ? 'auto' : 'none'}
              importantForAccessibility={zoomed ? 'auto' : 'no-hide-descendants'} accessibilityElementsHidden={!zoomed}>
              <MediaButton icon="contract" label={en.viewerResetZoom} disabled={!zoomed} onPress={() => setResetToken(value => value + 1)} />
              <Text style={[type.footnote, { color: t.onMediaSecondary }]}>{en.viewerResetZoom}</Text>
            </View>}
          </View>
          {step('next')}
        </View>
      </View>
    </SafeAreaView>
    {base && <PhotoControls visible={controlsOpen} state={controls} adjust={action => stage.current?.adjust(action)} close={() => setControlsOpen(false)} />}
  </View>;
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  topBar: { minHeight: 56, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12 },
  side: { width: 56, justifyContent: 'center' },
  right: { alignItems: 'flex-end' },
  titleBlock: { flex: 1, alignItems: 'center', paddingHorizontal: 8 },
  centred: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  status: { textAlign: 'center', paddingHorizontal: 32 },
  bottomBar: { paddingHorizontal: 12, paddingVertical: 10, gap: 10 },
  note: { textAlign: 'center', paddingHorizontal: 8 },
  controls: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  middle: { flex: 1, flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 16 },
  control: { alignItems: 'center', gap: 6 },
  hidden: { opacity: 0 },
});
