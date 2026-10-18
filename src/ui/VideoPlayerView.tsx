import { useEffect, useState } from 'react';
import { AppState, Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { useEvent } from 'expo';
import { useVideoPlayer, VideoView } from 'expo-video';
import { originalUri, type LocalVideo } from '../platform/originalImporter';
import type { ImportStore, LibraryRow } from '../storage/importStore';
import { matchingAspect, seekTarget, videoDisplaySize, videoControlsReady } from '../domain/photoGeometry';
import { en } from '../i18n/en';

export function VideoPlayerView({ video, row, store }: { video: LocalVideo; row: LibraryRow; store: ImportStore }) {
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
  function action(label: string, onPress: () => void, disabled = false) {
    return <Pressable key={label} accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled} onPress={onPress} style={[styles.button, disabled && { opacity: 0.5 }]}><Text style={styles.label}>{label}</Text></Pressable>;
  }
  return <View style={styles.root}>
    {status === 'error' ? <Text accessibilityLiveRegion="polite" style={styles.text}>{en.libraryVideoFailed}</Text> : <>
      {!ready && <Text style={styles.text}>{en.videoLoading}</Text>}
      <View style={styles.canvas}>
        <VideoView player={player} style={StyleSheet.absoluteFill} contentFit="contain" surfaceType="textureView" nativeControls={false} fullscreenOptions={{ enable: false }} allowsPictureInPicture={false} allowsVideoFrameAnalysis={false} />
        {overlay && showOverlay && <Image pointerEvents="none" accessible={false} source={{ uri: overlay }} resizeMode="contain" style={StyleSheet.absoluteFill} onError={() => { setOverlay(null); setNote(en.libraryOverlayFailed); }} />}
      </View>
      <Text style={styles.text}>{en.videoTime(currentTime, duration)}</Text>
      <View style={styles.controls}>
        {action(isPlaying ? en.videoPause : en.videoPlay, () => { if (isPlaying) player.pause(); else { if (player.currentTime >= duration) player.currentTime = 0; player.play(); } }, !ready)}
        {action(en.videoRestart, () => { player.currentTime = 0; }, !ready)}
        {action(muted ? en.videoUnmute : en.videoMute, () => { player.muted = !muted; setMuted(!muted); })}
        {action(en.videoBack, () => { player.currentTime = seekTarget(player.currentTime, -5, duration); }, !ready)}
        {action(en.videoForward, () => { player.currentTime = seekTarget(player.currentTime, 5, duration); }, !ready)}
        {overlay && action(showOverlay ? en.libraryHideOverlay : en.libraryShowOverlay, () => setShowOverlay(!showOverlay))}
      </View>
    </>}
    {!!note && <Text style={styles.text}>{note}</Text>}
  </View>;
}
const styles = StyleSheet.create({
  root: { flex: 1, gap: 8 }, canvas: { flex: 1, backgroundColor: '#000000', minHeight: 48 },
  text: { color: '#f3f4ef', fontSize: 16 }, controls: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  button: { minHeight: 48, justifyContent: 'center', padding: 12, borderRadius: 8, backgroundColor: '#b9dec8' }, label: { fontSize: 16, color: '#162d20' },
});
