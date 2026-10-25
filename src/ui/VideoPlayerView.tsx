import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ActivityIndicator, AppState, Image, PanResponder, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useEvent } from 'expo';
import { useVideoPlayer, VideoView } from 'expo-video';
import { originalUri, type LocalVideo } from '../platform/originalImporter';
import type { ImportStore, LibraryRow } from '../storage/importStore';
import { matchingAspect, seekTarget, videoDisplaySize, videoControlsReady } from '../domain/photoGeometry';
import { en } from '../i18n/en';
import { MediaButton } from './kit';
import { GestureStage } from './GestureStage';
import { ViewerChrome } from './ViewerChrome';
import { OverlayImage } from './OverlayImage';
import type { Navigation } from '../domain/viewerGestures';
import { type, useTheme } from './theme';

/** The viewer's bars for a video: `top` and `trailing` (the memory's own actions) come from the viewer, which shows them
 * the same way for photos. */
export type VideoChrome = { visible: boolean; top: ReactNode; trailing: ReactNode; note: string };

/** One player per open video: its parent remounts this for another memory, and the player is paused and released on
 * unmount, so leaving a video stops it and visited videos keep no player. It starts playing when opened, pauses while
 * something covers it and resumes afterwards. Swipes navigate on the picture only; the controls over it never start
 * a swipe, and empty space around them passes touches to the picture. */
export function VideoPlayerView({ video, row, store, onNavigate, covered = false, poster, initialOverlay, initialOverlayStatus, previousPreview, nextPreview, onVertical, onVerticalDrag, onTap, canNavigate, chrome }: {
  video: LocalVideo; row: LibraryRow; store: ImportStore; onNavigate: (direction: Navigation) => void | boolean | Promise<boolean>; covered?: boolean;
  poster?: string | null; initialOverlay?: string; initialOverlayStatus?: string; previousPreview?: ReactNode; nextPreview?: ReactNode;
  onVertical?(direction: 'up' | 'down'): void; onVerticalDrag?(dy: number | null): void; onTap?(): void; canNavigate?(direction: Navigation): boolean;
  chrome: VideoChrome;
}) {
  const t = useTheme();
  const screen = useWindowDimensions(), landscape = screen.width > screen.height;
  const player = useVideoPlayer({ uri: video.uri, contentType: 'progressive', useCaching: false }, instance => {
    instance.staysActiveInBackground = false;
    instance.showNowPlayingNotification = false;
    instance.timeUpdateEventInterval = 0.25;
    instance.play();
  });
  const { status } = useEvent(player, 'statusChange', { status: player.status });
  const { isPlaying } = useEvent(player, 'playingChange', { isPlaying: player.playing });
  const progress = useEvent(player, 'timeUpdate');
  const currentTime = progress?.currentTime ?? 0;
  const [muted, setMuted] = useState(false);
  const [overlay, setOverlay] = useState<string | null>(initialOverlay ?? null);
  const [showOverlay, setShowOverlay] = useState(true);
  const [note, setNote] = useState(initialOverlayStatus ?? '');
  // Covered (details, a delete prompt) pauses; uncovering resumes only a video that was playing.
  const resume = useRef(false);
  useEffect(() => {
    if (covered) { resume.current = resume.current || player.playing; player.pause(); }
    else if (resume.current) { resume.current = false; player.play(); }
  }, [covered, player]);
  useEffect(() => {
    const listener = AppState.addEventListener('change', state => { if (state !== 'active') { resume.current = false; player.pause(); } });
    return () => {
      listener.remove();
      try { player.pause(); } catch { /* Already released. */ } // useVideoPlayer then releases the player.
    };
  }, [player]);
  const { id, overlays } = row;
  useEffect(() => {
    let active = true;
    void (async () => {
      if (!overlays || initialOverlay || initialOverlayStatus) return;
      if (overlays > 1) { setNote(en.libraryOverlayVariants); return; }
      const size = videoDisplaySize(video.width, video.height, video.rotation);
      if (!size) { setNote(en.videoGeometry); return; }
      try {
        const object = (await store.objects(id)).find(item => item.role === 'overlay');
        if (!object) throw new Error('missing-overlay');
        const uri = await originalUri(object);
        const dimensions = await new Promise<{ width: number; height: number }>((resolve, reject) => Image.getSize(uri, (width, height) => resolve({ width, height }), reject));
        if (!active) return;
        if (matchingAspect(size, dimensions)) setOverlay(uri);
        else setNote(en.libraryOverlaySize);
      } catch { if (active) setNote(en.libraryOverlayFailed); }
    })();
    return () => { active = false; };
  }, [video, id, overlays, store]);
  const duration = Number.isFinite(player.duration) ? player.duration : 0;
  const ready = videoControlsReady(status, duration);

  // Dragging along the bar scrubs: the picture follows at most every 120 ms, and exactly where the finger lifts.
  const [scrub, setScrub] = useState<number | null>(null);
  const seek = useRef({ width: 1, start: 0, at: 0 });
  const latest = useRef({ ready, duration }); latest.current = { ready, duration };
  const scrubber = useMemo(() => {
    const fraction = (value: number) => Math.min(1, Math.max(0, value));
    const to = (value: number, force: boolean) => {
      const now = Date.now();
      if (force || now - seek.current.at >= 120) { seek.current.at = now; player.currentTime = value * latest.current.duration; }
    };
    return PanResponder.create({
      onStartShouldSetPanResponder: () => latest.current.ready,
      onMoveShouldSetPanResponder: () => latest.current.ready,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: event => { const value = fraction(event.nativeEvent.locationX / seek.current.width); seek.current.start = value; setScrub(value); to(value, true); },
      onPanResponderMove: (_event, state) => { const value = fraction(seek.current.start + state.dx / seek.current.width); setScrub(value); to(value, false); },
      onPanResponderRelease: (_event, state) => { to(fraction(seek.current.start + state.dx / seek.current.width), true); setScrub(null); },
      onPanResponderTerminate: () => setScrub(null),
    });
  }, [player]);
  const shownTime = scrub === null ? currentTime : scrub * duration;
  const progress01 = duration > 0 ? Math.min(1, Math.max(0, shownTime / duration)) : 0;
  const [elapsed, total] = en.videoClock(shownTime, duration).split(' / ');

  const timeStyle = [type.caption, styles.time, { color: t.onMedia }];
  const timeline = <View pointerEvents="box-none" style={[styles.timeline, landscape && styles.grow]}>
    <Text pointerEvents="none" style={timeStyle}>{elapsed}</Text>
    <View {...scrubber.panHandlers} accessible accessibilityRole="adjustable" accessibilityLabel="Video position"
      accessibilityValue={{ min: 0, max: Math.round(duration), now: Math.round(currentTime), text: en.videoTime(currentTime, duration) }}
      accessibilityActions={[{ name: 'increment', label: 'Forward 5 seconds' }, { name: 'decrement', label: 'Back 5 seconds' }]}
      onAccessibilityAction={event => { if (ready && ['increment', 'decrement'].includes(event.nativeEvent.actionName)) player.currentTime = seekTarget(player.currentTime, event.nativeEvent.actionName === 'increment' ? 5 : -5, duration); }}
      onLayout={event => { seek.current.width = Math.max(1, event.nativeEvent.layout.width); }} style={styles.seek}>
      <View pointerEvents="none" style={[styles.track, { backgroundColor: 'rgba(255,255,255,0.3)' }]}><View style={[styles.fill, { width: `${progress01 * 100}%`, backgroundColor: t.onMedia }]} /></View>
    </View>
    <Text pointerEvents="none" style={timeStyle}>{total}</Text>
  </View>;
  const play = <MediaButton large={!landscape} icon={isPlaying ? 'pause' : 'play'} label={isPlaying ? en.videoPause : en.videoPlay} disabled={!ready}
    onPress={() => { if (isPlaying) player.pause(); else { if (player.currentTime >= duration) player.currentTime = 0; player.play(); } }} />;
  const mute = <MediaButton icon={muted ? 'volume-mute' : 'volume-high'} label={muted ? en.videoUnmute : en.videoMute} onPress={() => { player.muted = !muted; setMuted(!muted); }} />;
  const layers = overlay ? <MediaButton icon={showOverlay ? 'layers' : 'layers-outline'} label={showOverlay ? en.libraryHideOverlay : en.libraryShowOverlay} onPress={() => setShowOverlay(!showOverlay)} /> : null;
  const message = chrome.note || note;
  const bottom = <>
    {!!message && <Text pointerEvents="none" style={[type.footnote, styles.centerText, { color: t.onMediaSecondary }]}>{message}</Text>}
    {landscape ? <View pointerEvents="box-none" style={styles.row}>{play}{timeline}{mute}{layers}{chrome.trailing}</View> : <>
      {timeline}
      <View pointerEvents="box-none" style={styles.row}>
        <View pointerEvents="box-none" style={[styles.side, styles.row]}>{layers}{mute}</View>
        {play}
        <View pointerEvents="box-none" style={[styles.side, styles.row, styles.end]}>{chrome.trailing}</View>
      </View>
    </>}
  </>;
  return <View style={styles.root}>
    <GestureStage zoomable={false} content={null} onNavigate={onNavigate} onVertical={onVertical} onVerticalDrag={onVerticalDrag} onTap={onTap} controlsShown={chrome.visible} previousPreview={previousPreview} nextPreview={nextPreview} canNavigate={canNavigate}>
      {status === 'error' ? <View style={styles.loading}><Text accessibilityLiveRegion="polite" style={[type.body, styles.centerText, { color: t.onMedia }]}>{en.libraryVideoFailed}</Text></View> : <>
      <VideoView player={player} style={StyleSheet.absoluteFill} contentFit="contain" surfaceType="textureView" nativeControls={false} fullscreenOptions={{ enable: false }} allowsPictureInPicture={false} allowsVideoFrameAnalysis={false} />
      {!ready && poster && <Image accessible={false} fadeDuration={0} source={{ uri: poster }} resizeMode="contain" style={StyleSheet.absoluteFill} />}
      {overlay && showOverlay && videoDisplaySize(video.width, video.height, video.rotation) &&
        <OverlayImage uri={overlay} media={videoDisplaySize(video.width, video.height, video.rotation)!}
          onError={() => { setOverlay(null); setNote(en.libraryOverlayFailed); }} />}
      {!ready && <View style={styles.loading}><ActivityIndicator color={t.onMediaSecondary} accessibilityLabel={en.videoLoading} /></View>}
      </>}
    </GestureStage>
    <ViewerChrome visible={chrome.visible} top={chrome.top} bottom={bottom} />
  </View>;
}
const styles = StyleSheet.create({
  root: { flex: 1, alignSelf: 'stretch' },
  loading: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, alignItems: 'center', justifyContent: 'center' },
  timeline: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  grow: { flex: 1 },
  seek: { flex: 1, minHeight: 40, justifyContent: 'center' },
  track: { height: 4, borderRadius: 2, overflow: 'hidden' },
  fill: { position: 'absolute', left: 0, top: 0, bottom: 0, borderRadius: 2 },
  time: { fontVariant: ['tabular-nums'], minWidth: 36, textAlign: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  side: { flex: 1 },
  end: { justifyContent: 'flex-end' },
  centerText: { textAlign: 'center', paddingHorizontal: 12 },
});
