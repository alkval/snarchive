import { StatusBar } from 'expo-status-bar';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Animated, Easing, Image, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import type { ImportStore, LibraryRow } from '../storage/importStore';
import type { LocalVideo } from '../platform/originalImporter';
import type { Photo, ViewerMedia } from '../platform/viewerMedia';
import { MemoryDeleteFailure, type DeleteOutcome } from '../integrity/deleteMemory';
import type { ReactNode } from 'react';
import { VideoPlayerView } from './VideoPlayerView';
import { FavoriteButton } from './FavoriteButton';
import { MediaButton } from './kit';
import { GestureStage, type GestureStageHandle } from './GestureStage';
import { ViewerChrome } from './ViewerChrome';
import { MemoryDetailsSheet } from './MemoryDetailsSheet';
import { DetailsSheet } from '../domain/detailsSheet';
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

const EASE_OUT = Easing.bezier(0.23, 1, 0.32, 1);

/** The media fills the screen, in the same place for photos and videos; the bars (`chrome`, kept by the pager across
 * memories) are drawn over it and a tap on the media shows or hides them. Swiping up moves the details sheet with the
 * finger; it opens past a distance or a flick and otherwise drops back. */
export function MemoryViewer({ row, store, onBack, favorite, navigation, initialMedia, loadMedia, previousPreview, nextPreview, onDelete, onBusy, chrome, onToggleChrome }: {
  row: LibraryRow & { favorite: number }; store: ImportStore; onBack: () => void; favorite: ViewerFavorite; navigation: ViewerNavigation;
  initialMedia?: ViewerMedia; loadMedia(): Promise<ViewerMedia>; previousPreview?: ReactNode; nextPreview?: ReactNode;
  onDelete(): Promise<DeleteOutcome>; onBusy(value: boolean): void; chrome: boolean; onToggleChrome(): void;
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
  const overlayOpacity = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    const toValue = showOverlay ? 1 : 0;
    if (reduced) { overlayOpacity.setValue(toValue); return; }
    Animated.timing(overlayOpacity, { toValue, duration: 150, easing: EASE_OUT, useNativeDriver: true }).start();
  }, [showOverlay, overlayOpacity, reduced]);
  // Loads only for this memory: a result that arrives after the viewer moved on is dropped (`active`).
  const { id } = row;
  useEffect(() => {
    let active = true;
    void loadMedia().then(media => { if (active) { setBase(media.base); setOverlay(media.overlay); setVideo(media.video); setStatus(media.status); setOverlayStatus(media.overlayStatus); setLoading(false); } },
      () => { if (active) { setLoading(false); setStatus(en.libraryPhotoFailed); } });
    return () => { active = false; };
  }, [id]);

  // The details sheet sits `sheet` px below its open position; the screen height is closed. `details` mounts it while
  // it is dragged, opening, open or closing. DetailsSheet decides which drags, releases and controls apply.
  const { height } = useWindowDimensions();
  const sheet = useRef(new Animated.Value(height)).current;
  const [details, setDetails] = useState(false), [detailsOpen, setDetailsOpen] = useState(false);
  const reducedRef = useRef(reduced); reducedRef.current = reduced;
  const sheetModel = useRef<DetailsSheet | null>(null);
  sheetModel.current ??= new DetailsSheet({
    set: offset => sheet.setValue(offset),
    animate: (toValue, done) => Animated.timing(sheet, { toValue, duration: reducedRef.current ? 0 : 260, easing: EASE_OUT, useNativeDriver: true })
      .start(({ finished }) => { if (finished && alive.current) done?.(); }),
    stop: () => sheet.stopAnimation(),
    mount: setDetails, opened: setDetailsOpen,
  }, height);
  const detailsSheet = sheetModel.current;
  useEffect(() => detailsSheet.resize(height), [height, detailsSheet]);
  const openDetails = () => { if (deleting) return; stage.current?.cancel(); detailsSheet.open(); };
  const dragDetails = (dy: number | null) => { if (!deleting) detailsSheet.stageDrag(dy); };
  const vertical = (direction: 'up' | 'down') => {
    if (deleting) return;
    if (direction === 'up') stage.current?.cancel();
    if (!detailsSheet.release(direction)) onBack();
  };
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
  const navigate = async (direction: Direction) => !deleting && navigation[direction] !== 'end' ? navigation.go(direction) : false;
  const canNavigate = (direction: Direction) => !deleting && navigation[direction] !== 'end';
  const note = deleteError || (favorite.failed ? en.favoriteFailed : '') || overlayStatus || (navigation.failed ? en.viewerNavigationFailed(navigation.failed) : '');
  const stageContent = base ? <View style={StyleSheet.absoluteFill}>
    <Image accessibilityLabel={en.libraryPhoto} fadeDuration={0} source={{ uri: base.uri }} resizeMode="contain" style={StyleSheet.absoluteFill}
      onError={() => { setBase(null); setOverlay(null); setStatus(en.libraryPhotoFailed); }} />
    {overlay && <Animated.Image accessible={false} fadeDuration={0} source={{ uri: overlay.uri }} resizeMode="contain" style={[StyleSheet.absoluteFill, { opacity: overlayOpacity }]}
      onError={() => { setOverlay(null); setOverlayStatus(en.libraryOverlayFailed); }} />}
  </View> : <View style={styles.centred}>
    {loading && <ActivityIndicator color={t.onMediaSecondary} accessibilityLabel={en.libraryLoading} />}
    {!!status && <Text accessibilityLiveRegion="polite" style={[type.body, styles.status, { color: t.onMedia }]}>{status}</Text>}
  </View>;
  const topBar = <View pointerEvents="box-none" style={styles.topBar}>
    <MediaButton icon="chevron-back" label={en.libraryBack} disabled={deleting} onPress={onBack} />
    <View pointerEvents="none" style={styles.titleBlock} accessible accessibilityRole="header" accessibilityLabel={[date.title, date.caption].filter(Boolean).join(', ')}>
      <Text numberOfLines={1} style={[type.headline, { color: t.onMedia }]}>{date.title}</Text>
      {!!row.instant && !!date.caption && <Text numberOfLines={2} style={[type.caption, { color: t.onMediaSecondary, textAlign: 'center' }]}>{date.caption}</Text>}
    </View>
    <View pointerEvents="box-none" style={styles.actions}>
      <MediaButton icon="information-circle-outline" label={en.detailsTitle} disabled={deleting} onPress={openDetails} />
      <FavoriteButton favorite={row.favorite === 1} pending={favorite.pending || deleting} onToggle={favorite.toggle} />
    </View>
  </View>;
  const trash = deleting ? <View style={styles.slot}><ActivityIndicator color={t.onMedia} accessibilityLabel="Deleting memory" /></View>
    : <MediaButton icon="trash-outline" label="Delete memory" onPress={askDelete} />;
  const noteText = note ? <Text pointerEvents="none" accessibilityLiveRegion="polite" style={[type.footnote, styles.note, { color: t.onMediaSecondary }]}>{note}</Text> : null;
  const shared = { onNavigate: navigate, previousPreview, nextPreview, onVertical: vertical, onVerticalDrag: dragDetails, onTap: onToggleChrome, controlsShown: chrome, canNavigate };
  return <View style={[styles.root, { backgroundColor: t.media }]}>
    <StatusBar style="light" hidden={!chrome} />
    <View style={StyleSheet.absoluteFill} importantForAccessibility={details ? 'no-hide-descendants' : 'auto'} accessibilityElementsHidden={details}>
      {video ? <VideoPlayerView {...shared} video={video} row={row} store={store} covered={details || deleting || confirmingDelete} poster={initialMedia?.poster}
        initialOverlay={overlay?.uri} initialOverlayStatus={overlayStatus} chrome={{ visible: chrome, top: topBar, trailing: trash, note }} />
        : <>
          <GestureStage ref={stage} {...shared} zoomable={!!base} content={base?.size ?? null}>{stageContent}</GestureStage>
          <ViewerChrome visible={chrome} top={topBar} bottom={<>
            {noteText}
            <View pointerEvents="box-none" style={styles.controls}>
              {base && overlay ? <MediaButton icon={showOverlay ? 'layers' : 'layers-outline'} label={showOverlay ? en.libraryHideOverlay : en.libraryShowOverlay} disabled={deleting} onPress={() => setShowOverlay(value => !value)} /> : <View />}
              {trash}
            </View>
          </>} />
        </>}
    </View>
    {details && <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: t.media, opacity: sheet.interpolate({ inputRange: [0, height], outputRange: [0.6, 0], extrapolate: 'clamp' }) }]} />}
    {details && <MemoryDetailsSheet id={id} store={store} offset={sheet} open={detailsOpen} close={() => detailsSheet.close()}
      drag={dy => detailsSheet.sheetDrag(dy)} release={leave => detailsSheet.sheetRelease(leave)} />}
  </View>;
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  topBar: { minHeight: 56, flexDirection: 'row', alignItems: 'center', gap: 8 },
  titleBlock: { flex: 1, alignItems: 'center', paddingHorizontal: 8 },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  centred: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  status: { textAlign: 'center', paddingHorizontal: 32 },
  note: { textAlign: 'center', paddingHorizontal: 8 },
  controls: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  slot: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center' },
});
