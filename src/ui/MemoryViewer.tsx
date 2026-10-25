import { StatusBar } from 'expo-status-bar';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Animated, Easing, Image, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { ImportStore, LibraryRow } from '../storage/importStore';
import type { LocalVideo } from '../platform/originalImporter';
import type { Photo, ViewerMedia } from '../platform/viewerMedia';
import { MemoryDeleteFailure, type DeleteOutcome } from '../integrity/deleteMemory';
import type { ReactNode } from 'react';
import { VideoPlayerView } from './VideoPlayerView';
import { FavoriteButton } from './FavoriteButton';
import { MediaButton } from './kit';
import { GestureStage, type GestureStageHandle } from './GestureStage';
import { PhotoControls } from './PhotoControls';
import { MemoryDetailsScreen } from './MemoryDetailsScreen';
import { EMPTY_PHOTO_CONTROLS } from '../domain/viewerGestures';
import type { Direction, NeighbourState } from '../domain/memoryNavigation';
import { type, useReducedMotion, useTheme } from './theme';
import { en } from '../i18n/en';

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
export type ViewerNavigation = { previous: NeighbourState; next: NeighbourState; go: (direction: Direction) => Promise<boolean>; failed: Direction | null };

/** One memory, fullscreen. Keyed by memory ID by its parent, so moving to another memory starts from a clean state:
 * zoom, overlay toggle, loads and the video player all belong to the memory they were created for. */
/** The favourite state of the open memory: `pending` and `failed` come from writes that outlive this viewer. */
export type ViewerFavorite = { pending: boolean; failed: boolean; toggle: () => void };

export function MemoryViewer({ row, store, onBack, favorite, navigation, initialMedia, loadMedia, previousPreview, nextPreview, onDelete, onBusy }: {
  row: LibraryRow & { favorite: number }; store: ImportStore; onBack: () => void; favorite: ViewerFavorite; navigation: ViewerNavigation;
  initialMedia?: ViewerMedia; loadMedia(): Promise<ViewerMedia>; previousPreview?: ReactNode; nextPreview?: ReactNode;
  onDelete(): Promise<DeleteOutcome>; onBusy(value: boolean): void;
}) {
  const t = useTheme();
  const reduced = useReducedMotion();
  const date = memoryDate(row);
  const [video, setVideo] = useState<LocalVideo | null>(initialMedia?.video ?? null);
  const [base, setBase] = useState<Photo | null>(initialMedia?.base ?? null);
  const [overlay, setOverlay] = useState<Photo | null>(initialMedia?.overlay ?? null);
  const [showOverlay, setShowOverlay] = useState(true);
  const [loading, setLoading] = useState(!initialMedia);
  const [status, setStatus] = useState(initialMedia?.status ?? '');
  const [overlayStatus, setOverlayStatus] = useState(initialMedia?.overlayStatus ?? '');
  const [deleteError, setDeleteError] = useState('');
  const [deleting, setDeleting] = useState(false), [confirmingDelete, setConfirmingDelete] = useState(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const stage = useRef<GestureStageHandle>(null);
  const [controlsOpen, setControlsOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
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
    void loadMedia().then(media => { if (active) { setBase(media.base); setOverlay(media.overlay); setVideo(media.video); setStatus(media.status); setOverlayStatus(media.overlayStatus); setLoading(false); } },
      () => { if (active) { setLoading(false); setStatus(en.libraryPhotoFailed); } });
    return () => { active = false; };
  }, [id]);
  const openDetails = () => { if (deleting) return; stage.current?.cancel(); setDetailsOpen(true); };
  const vertical = (direction: 'up' | 'down') => { if (deleting) return; if (direction === 'up') openDetails(); else onBack(); };
  const askDelete = () => {
    if (deleting) return;
    stage.current?.cancel(); setDeleteError(''); setConfirmingDelete(true);
    Alert.alert('Delete this memory?', 'Remove it from Snarchive permanently. Your original export ZIPs and folders will not change.', [
      { text: 'Cancel', style: 'cancel', onPress: () => setConfirmingDelete(false) },
      { text: 'Delete', style: 'destructive', onPress: () => {
        setConfirmingDelete(false); setDeleting(true); onBusy(true);
        void onDelete().catch(error => { if (alive.current) setDeleteError('This memory could not be deleted. Please try again.' + (error instanceof MemoryDeleteFailure && error.cleanupFailed ? ' Storage cleanup also failed. Close and reopen Snarchive before retrying.' : '')); })
          .finally(() => { onBusy(false); if (alive.current) setDeleting(false); });
      } },
    ], { cancelable: true, onDismiss: () => setConfirmingDelete(false) });
  };
  const more = () => Alert.alert('Memory options', undefined, [
    ...(base ? [{ text: 'Photo controls', onPress: () => { stage.current?.cancel(); setControlsOpen(true); } }] : []),
    { text: 'Details', onPress: openDetails }, { text: 'Cancel', style: 'cancel' as const },
  ]);
  const navigate = async (direction: Direction) => !deleting && navigation[direction] !== 'end' ? navigation.go(direction) : false;
  const note = deleteError || (favorite.failed ? en.favoriteFailed : '') || overlayStatus || (navigation.failed ? en.viewerNavigationFailed(navigation.failed) : '');
  const stageContent = base ? <View style={StyleSheet.absoluteFill}>
    <Image accessibilityLabel={en.libraryPhoto} source={{ uri: base.uri }} resizeMode="contain" style={StyleSheet.absoluteFill}
      onError={() => { setBase(null); setOverlay(null); setStatus(en.libraryPhotoFailed); }} />
    {overlay && <Animated.Image accessible={false} source={{ uri: overlay.uri }} resizeMode="contain" style={[StyleSheet.absoluteFill, { opacity: overlayOpacity }]}
      onError={() => { setOverlay(null); setOverlayStatus(en.libraryOverlayFailed); }} />}
  </View> : <View style={styles.centred}>
    {loading && <ActivityIndicator color={t.onMediaSecondary} accessibilityLabel={en.libraryLoading} />}
    {!!status && <Text accessibilityLiveRegion="polite" style={[type.body, styles.status, { color: t.onMedia }]}>{status}</Text>}
  </View>;
  return <View style={[styles.root, { backgroundColor: t.media }]}>
    <StatusBar style="light" />
    <SafeAreaView style={styles.root}>
      <View style={styles.topBar}>
        <View style={styles.side}><MediaButton icon="chevron-back" label={en.libraryBack} disabled={deleting} onPress={onBack} /></View>
        <View style={styles.titleBlock} accessible accessibilityRole="header" accessibilityLabel={[date.title, date.caption].filter(Boolean).join(', ')}>
          <Text numberOfLines={1} style={[type.headline, { color: t.onMedia }]}>{date.title}</Text>
          {!!row.instant && !!date.caption && <Text numberOfLines={2} style={[type.caption, { color: t.onMediaSecondary, textAlign: 'center' }]}>{date.caption}</Text>}
        </View>
        <View style={[styles.side, styles.right]}>
          <MediaButton icon="ellipsis-horizontal" label="Memory options" disabled={deleting} onPress={more} />
          <FavoriteButton favorite={row.favorite === 1} pending={favorite.pending || deleting} onToggle={favorite.toggle} />
        </View>
      </View>
      {video ? <VideoPlayerView video={video} row={row} store={store} onNavigate={navigate} covered={detailsOpen || deleting || confirmingDelete} poster={initialMedia?.poster} initialOverlay={overlay?.uri} initialOverlayStatus={overlayStatus} previousPreview={previousPreview} nextPreview={nextPreview} onVertical={vertical} canNavigate={direction => !deleting && navigation[direction] !== 'end'} />
        : <GestureStage ref={stage} onControlsChange={setControls} zoomable={!!base} content={base?.size ?? null} onNavigate={navigate} previousPreview={previousPreview} nextPreview={nextPreview} onVertical={vertical} canNavigate={direction => !deleting && navigation[direction] !== 'end'} onZoomChange={setZoomed} resetToken={resetToken}>{stageContent}</GestureStage>}
      <View style={styles.bottomBar}>
        {!!note && <Text accessibilityLiveRegion="polite" style={[type.footnote, styles.note, { color: t.onMediaSecondary }]}>{note}</Text>}
        <View style={styles.controls}>
          {base && overlay ? <MediaButton icon={showOverlay ? 'layers' : 'layers-outline'} label={showOverlay ? en.libraryHideOverlay : en.libraryShowOverlay} disabled={deleting} onPress={() => setShowOverlay(value => !value)} /> : <View style={{ width: 48 }} />}
          {deleting ? <ActivityIndicator color={t.onMedia} accessibilityLabel="Deleting memory" /> : <MediaButton icon="trash-outline" label="Delete memory" onPress={askDelete} />}
        </View>
      </View>
    </SafeAreaView>
    {base && <PhotoControls visible={controlsOpen} state={controls} adjust={action => stage.current?.adjust(action)} close={() => setControlsOpen(false)} />}
    {detailsOpen && <MemoryDetailsScreen id={id} store={store} close={() => setDetailsOpen(false)} />}
  </View>;
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  topBar: { minHeight: 56, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12 },
  side: { width: 56, justifyContent: 'center' },
  right: { width: 104, flexDirection: 'row', alignItems: 'flex-end' },
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
