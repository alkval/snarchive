import { useEffect, useState } from 'react';
import { ActivityIndicator, AppState, Image, StyleSheet, Text, View } from 'react-native';
import { useEvent } from 'expo';
import { useVideoPlayer, VideoView } from 'expo-video';
import { originalUri, type LocalVideo } from '../platform/originalImporter';
import type { ImportStore, LibraryRow } from '../storage/importStore';
import { matchingAspect, seekTarget, videoDisplaySize, videoControlsReady } from '../domain/photoGeometry';
import { en } from '../i18n/en';
import { MediaButton } from './kit';
import { type, useTheme } from './theme';

export function VideoPlayerView({ video, row, store }: { video: LocalVideo; row: LibraryRow; store: ImportStore }) {
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
  const [overlay, setOverlay] = useState<string | null>(null);
  const [showOverlay, setShowOverlay] = useState(false);
  const [note, setNote] = useState('');
  useEffect(() => {
    const listener = AppState.addEventListener('change', state => { if (state !== 'active') player.pause(); });
    return () => listener.remove(); // useVideoPlayer releases the player on unmount.
  }, [player]);
  useEffect(() => {
    let active = true;
    void (async () => {
      if (!row.overlays) return;
      if (row.overlays > 1) { setNote(en.libraryOverlayVariants); return; }
      const size = videoDisplaySize(video.width, video.height, video.rotation);
      if (!size) { setNote(en.videoGeometry); return; }
      try {
        const object = (await store.objects(row.id)).find(item => item.role === 'overlay');
        if (!object) throw new Error('missing-overlay');
        const uri = await originalUri(object);
        const dimensions = await new Promise<{ width: number; height: number }>((resolve, reject) => Image.getSize(uri, (width, height) => resolve({ width, height }), reject));
        if (!active) return;
        if (matchingAspect(size, dimensions)) setOverlay(uri);
        else setNote(en.libraryOverlaySize);
      } catch { if (active) setNote(en.libraryOverlayFailed); }
    })();
    return () => { active = false; };
  }, [video, row, store]);
  const duration = Number.isFinite(player.duration) ? player.duration : 0;
  const ready = videoControlsReady(status, duration);
  const progress01 = duration > 0 ? Math.min(1, Math.max(0, currentTime / duration)) : 0;
  return <View style={styles.root}>
    {status === 'error' ? <Text accessibilityLiveRegion="polite" style={[type.body, styles.centerText, { color: t.onMedia }]}>{en.libraryVideoFailed}</Text> : <>
      <View style={styles.canvas}>
        <VideoView player={player} style={StyleSheet.absoluteFill} contentFit="contain" surfaceType="textureView" nativeControls={false} fullscreenOptions={{ enable: false }} allowsPictureInPicture={false} allowsVideoFrameAnalysis={false} />
        {overlay && showOverlay && <Image pointerEvents="none" accessible={false} source={{ uri: overlay }} resizeMode="contain" style={StyleSheet.absoluteFill} onError={() => { setOverlay(null); setNote(en.libraryOverlayFailed); }} />}
        {!ready && <View style={styles.loading}><ActivityIndicator color={t.onMediaSecondary} accessibilityLabel={en.videoLoading} /></View>}
      </View>
      <View style={styles.chrome}>
        <View accessible accessibilityLabel={en.videoTime(currentTime, duration)} style={styles.timeline}>
          <View style={[styles.track, { backgroundColor: t.mediaControl }]}>
            <View style={[styles.fill, { width: `${progress01 * 100}%`, backgroundColor: t.onMedia }]} />
          </View>
          <View style={styles.times}>
            <Text style={[type.caption, styles.time, { color: t.onMediaSecondary }]}>{en.videoClock(currentTime, duration).split(' / ')[0]}</Text>
            <Text style={[type.caption, styles.time, { color: t.onMediaSecondary }]}>{en.videoClock(currentTime, duration).split(' / ')[1]}</Text>
          </View>
        </View>
        <View style={styles.controls}>
          <MediaButton icon="refresh" label={en.videoRestart} disabled={!ready} onPress={() => { player.currentTime = 0; }} />
          <MediaButton icon="play-back" label={en.videoBack} disabled={!ready} onPress={() => { player.currentTime = seekTarget(player.currentTime, -5, duration); }} />
          <MediaButton large icon={isPlaying ? 'pause' : 'play'} label={isPlaying ? en.videoPause : en.videoPlay} disabled={!ready}
            onPress={() => { if (isPlaying) player.pause(); else { if (player.currentTime >= duration) player.currentTime = 0; player.play(); } }} />
          <MediaButton icon="play-forward" label={en.videoForward} disabled={!ready} onPress={() => { player.currentTime = seekTarget(player.currentTime, 5, duration); }} />
          <MediaButton icon={muted ? 'volume-mute' : 'volume-high'} label={muted ? en.videoUnmute : en.videoMute} onPress={() => { player.muted = !muted; setMuted(!muted); }} />
        </View>
        {overlay && <View style={styles.overlayRow}>
          <MediaButton icon={showOverlay ? 'layers' : 'layers-outline'} label={showOverlay ? en.libraryHideOverlay : en.libraryShowOverlay} onPress={() => setShowOverlay(!showOverlay)} />
          <Text style={[type.footnote, { color: t.onMediaSecondary }]}>{showOverlay ? en.libraryHideOverlay : en.libraryShowOverlay}</Text>
        </View>}
        {!!note && <Text style={[type.footnote, styles.centerText, { color: t.onMediaSecondary }]}>{note}</Text>}
      </View>
    </>}
  </View>;
}
const styles = StyleSheet.create({
  root: { flex: 1, alignSelf: 'stretch' },
  canvas: { flex: 1, minHeight: 48 },
  loading: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, alignItems: 'center', justifyContent: 'center' },
  chrome: { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 8, gap: 14 },
  timeline: { gap: 6 },
  track: { height: 4, borderRadius: 2, overflow: 'hidden' },
  fill: { position: 'absolute', left: 0, top: 0, bottom: 0, borderRadius: 2 },
  times: { flexDirection: 'row', justifyContent: 'space-between' },
  time: { fontVariant: ['tabular-nums'] },
  controls: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 14 },
  overlayRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10 },
  centerText: { textAlign: 'center', paddingHorizontal: 12 },
});
