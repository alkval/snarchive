import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ActivityIndicator, AppState, Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { useEvent } from 'expo';
import { useVideoPlayer, VideoView } from 'expo-video';
import { originalUri, type LocalVideo } from '../platform/originalImporter';
import type { ImportStore, LibraryRow } from '../storage/importStore';
import { matchingAspect, seekTarget, videoDisplaySize, videoControlsReady } from '../domain/photoGeometry';
import { en } from '../i18n/en';
import { MediaButton } from './kit';
import { GestureStage } from './GestureStage';
import type { Navigation } from '../domain/viewerGestures';
import { type, useTheme } from './theme';

/** One player per open video: its parent remounts this for another memory, and the player is paused and released on
 * unmount, so leaving a video stops it and visited videos keep no player. Swipes navigate on the picture only; the
 * controls below it never start a swipe. */
export function VideoPlayerView({ video, row, store, onNavigate, covered = false, poster, initialOverlay, initialOverlayStatus, previousPreview, nextPreview, onVertical, canNavigate }: {
  video: LocalVideo; row: LibraryRow; store: ImportStore; onNavigate: (direction: Navigation) => void | boolean | Promise<boolean>; covered?: boolean;
  poster?: string | null; initialOverlay?: string; initialOverlayStatus?: string; previousPreview?: ReactNode; nextPreview?: ReactNode;
  onVertical?(direction: 'up' | 'down'): void; canNavigate?(direction: Navigation): boolean;
}) {
  const t = useTheme();
  const player = useVideoPlayer({ uri: video.uri, contentType: 'progressive', useCaching: false }, instance => {
    instance.staysActiveInBackground = false;
    instance.showNowPlayingNotification = false;
    instance.timeUpdateEventInterval = 0.25;
  });
  const { status } = useEvent(player, 'statusChange', { status: player.status });
  const { isPlaying } = useEvent(player, 'playingChange', { isPlaying: player.playing });
  const progress = useEvent(player, 'timeUpdate');
  const currentTime = progress?.currentTime ?? 0;
  const [muted, setMuted] = useState(false);
  const [overlay, setOverlay] = useState<string | null>(initialOverlay ?? null);
  const [showOverlay, setShowOverlay] = useState(true);
  const [note, setNote] = useState(initialOverlayStatus ?? '');
  const trackWidth = useRef(1);
  useEffect(() => { if (covered) player.pause(); }, [covered, player]);
  useEffect(() => {
    const listener = AppState.addEventListener('change', state => { if (state !== 'active') player.pause(); });
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
  const progress01 = duration > 0 ? Math.min(1, Math.max(0, currentTime / duration)) : 0;
  return <View style={styles.root}>
    <>
      <View style={styles.canvas}><GestureStage zoomable={false} content={null} onNavigate={onNavigate} onVertical={onVertical} previousPreview={previousPreview} nextPreview={nextPreview} canNavigate={canNavigate}>
        {status === 'error' ? <View style={styles.loading}><Text accessibilityLiveRegion="polite" style={[type.body, styles.centerText, { color: t.onMedia }]}>{en.libraryVideoFailed}</Text></View> : <>
        <VideoView player={player} style={StyleSheet.absoluteFill} contentFit="contain" surfaceType="textureView" nativeControls={false} fullscreenOptions={{ enable: false }} allowsPictureInPicture={false} allowsVideoFrameAnalysis={false} />
        {!ready && poster && <Image accessible={false} source={{ uri: poster }} resizeMode="contain" style={StyleSheet.absoluteFill} />}
        {overlay && showOverlay && <Image pointerEvents="none" accessible={false} source={{ uri: overlay }} resizeMode="contain" style={StyleSheet.absoluteFill} onError={() => { setOverlay(null); setNote(en.libraryOverlayFailed); }} />}
        {!ready && <View style={styles.loading}><ActivityIndicator color={t.onMediaSecondary} accessibilityLabel={en.videoLoading} /></View>}
        </>}
      </GestureStage></View>
      <View style={styles.chrome}>
        <View style={styles.timeline}>
          <Pressable accessibilityRole="adjustable" accessibilityLabel="Video position" accessibilityValue={{ min: 0, max: Math.round(duration), now: Math.round(currentTime), text: en.videoTime(currentTime, duration) }}
            accessibilityActions={[{ name: 'increment', label: 'Forward 5 seconds' }, { name: 'decrement', label: 'Back 5 seconds' }]}
            onAccessibilityAction={event => { if (ready && ['increment', 'decrement'].includes(event.nativeEvent.actionName)) player.currentTime = seekTarget(player.currentTime, event.nativeEvent.actionName === 'increment' ? 5 : -5, duration); }}
            onLayout={event => { trackWidth.current = event.nativeEvent.layout.width; }}
            onPress={event => { if (ready && trackWidth.current > 0) player.currentTime = Math.max(0, Math.min(duration, event.nativeEvent.locationX / trackWidth.current * duration)); }}
            style={styles.seek}>
            <View pointerEvents="none" style={[styles.track, { backgroundColor: t.mediaControl }]}><View style={[styles.fill, { width: `${progress01 * 100}%`, backgroundColor: t.onMedia }]} /></View>
          </Pressable>
          <View style={styles.times}>
            <Text style={[type.caption, styles.time, { color: t.onMediaSecondary }]}>{en.videoClock(currentTime, duration).split(' / ')[0]}</Text>
            <Text style={[type.caption, styles.time, { color: t.onMediaSecondary }]}>{en.videoClock(currentTime, duration).split(' / ')[1]}</Text>
          </View>
        </View>
        <View style={styles.controls}>
          {overlay && <MediaButton icon={showOverlay ? 'layers' : 'layers-outline'} label={showOverlay ? en.libraryHideOverlay : en.libraryShowOverlay} onPress={() => setShowOverlay(!showOverlay)} />}
          <MediaButton large icon={isPlaying ? 'pause' : 'play'} label={isPlaying ? en.videoPause : en.videoPlay} disabled={!ready}
            onPress={() => { if (isPlaying) player.pause(); else { if (player.currentTime >= duration) player.currentTime = 0; player.play(); } }} />
          <MediaButton icon={muted ? 'volume-mute' : 'volume-high'} label={muted ? en.videoUnmute : en.videoMute} onPress={() => { player.muted = !muted; setMuted(!muted); }} />
        </View>
        {!!note && <Text style={[type.footnote, styles.centerText, { color: t.onMediaSecondary }]}>{note}</Text>}
      </View>
    </>
  </View>;
}
const styles = StyleSheet.create({
  root: { flex: 1, alignSelf: 'stretch' },
  canvas: { flex: 1, minHeight: 48 },
  loading: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, alignItems: 'center', justifyContent: 'center' },
  chrome: { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 8, gap: 14 },
  timeline: { gap: 6 },
  seek: { minHeight: 32, justifyContent: 'center' },
  track: { height: 4, borderRadius: 2, overflow: 'hidden' },
  fill: { position: 'absolute', left: 0, top: 0, bottom: 0, borderRadius: 2 },
  times: { flexDirection: 'row', justifyContent: 'space-between' },
  time: { fontVariant: ['tabular-nums'] },
  controls: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 14 },
  overlayRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10 },
  centerText: { textAlign: 'center', paddingHorizontal: 12 },
});
