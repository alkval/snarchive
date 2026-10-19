import { useEffect, useRef, useState } from 'react';
import { BackHandler, ScrollView, StyleSheet, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { BackupPreview } from '../backup/manifest';
import type { InspectionProgress } from '../backup/inspectBackup';
import { cancelBackupInspection, inspectBackupDocument } from '../platform/backupInspection';
import { sourcePicker } from '../platform/sourcePicker';
import { en } from '../i18n/en';
import { BackButton, Button, Group, LargeTitle, Notice, Row } from './kit';
import { space, useTheme } from './theme';

type State =
  | { kind: 'idle' } | { kind: 'cancelled' } | { kind: 'picker-closed' }
  | { kind: 'working'; progress: InspectionProgress | null; cancelling: boolean }
  | { kind: 'verified'; preview: BackupPreview; inPlace: boolean; cleanupFailed: boolean }
  | { kind: 'failed'; code: string };

function size(bytes: number): string {
  const units = ['bytes', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes, unit = 0;
  while (value >= 1000 && unit < units.length - 1) { value /= 1000; unit++; }
  return unit === 0 ? `${bytes} bytes` : `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
}

/** Read-only backup check. Nothing here writes the library, the originals store or the chosen file. */
export function BackupInspectScreen({ onClose }: { onClose(): void }) {
  const t = useTheme();
  const [state, setState] = useState<State>({ kind: 'idle' });
  const running = useRef(false), stopped = useRef(false), mounted = useRef(true);
  const cancel = () => {
    if (!running.current) return;
    stopped.current = true; cancelBackupInspection();
    setState(previous => previous.kind === 'working' ? { ...previous, cancelling: true } : previous);
  };
  useEffect(() => {
    mounted.current = true;
    const back = BackHandler.addEventListener('hardwareBackPress', () => { if (running.current) cancel(); else onClose(); return true; });
    // Leaving the screen cancels; the native session then closes itself and deletes any private copy.
    return () => { back.remove(); mounted.current = false; if (running.current) { stopped.current = true; cancelBackupInspection(); } };
  }, [onClose]);

  async function check() {
    if (running.current) return; // Repeated taps never start a second session.
    running.current = true; stopped.current = false;
    setState({ kind: 'working', progress: null, cancelling: false });
    try {
      const uri = await sourcePicker.selectBackup();
      if (!mounted.current) return;
      if (!uri) { setState({ kind: 'picker-closed' }); return; }
      if (stopped.current) { setState({ kind: 'cancelled' }); return; }
      const outcome = await inspectBackupDocument(uri, () => stopped.current,
        progress => { if (mounted.current) setState(previous => ({ kind: 'working', progress, cancelling: previous.kind === 'working' && previous.cancelling })); });
      if (mounted.current) setState({ kind: 'verified', ...outcome });
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      if (mounted.current) setState(code === 'cancelled' || stopped.current ? { kind: 'cancelled' } : { kind: 'failed', code });
    } finally { running.current = false; }
  }

  const working = state.kind === 'working';
  const progress = working ? state.progress : null;
  const fraction = progress?.stage === 'objects' && progress.totalBytes > 0 ? progress.bytes / progress.totalBytes : progress?.stage === 'objects' && progress.done ? 1 : 0;
  const counts = en.inspectCounts;
  return <SafeAreaView style={[styles.root, { backgroundColor: t.ground }]}>
    <StatusBar style={t.dark ? 'light' : 'dark'} />
    <View style={styles.topBar}><BackButton label={en.title} onPress={() => { if (running.current) cancel(); else onClose(); }} /></View>
    <ScrollView contentContainerStyle={styles.content}>
      <LargeTitle title={en.inspectTitle} subtitle={en.inspectSubtitle} />
      {working && <View style={styles.block}>
        <Notice tone="progress" message={state.cancelling ? en.inspectCancelling
          : progress?.stage === 'objects' ? en.inspectObjects(progress.verified, progress.total, size(progress.bytes), size(progress.totalBytes))
          : progress?.stage === 'manifest' ? en.inspectStage.manifest : en.inspectStage.opening} />
        {progress?.stage === 'objects' && <View accessible={false} style={[styles.track, { backgroundColor: t.raised }]}>
          <View style={[styles.fill, { width: `${Math.round(fraction * 100)}%`, backgroundColor: t.accent }]} />
        </View>}
      </View>}
      {state.kind === 'failed' && <Notice tone={state.code === 'busy' || state.code === 'insufficient-storage' ? 'warning' : 'error'}
        message={en.inspectErrors[state.code] ?? en.inspectUnreadable} />}
      {state.kind === 'cancelled' && <Notice tone="info" message={en.inspectCancelled} />}
      {state.kind === 'picker-closed' && <Notice tone="info" message={en.inspectPickerClosed} />}
      {state.kind === 'verified' && <>
        <Notice tone="success" title={en.inspectVerified} message={en.inspectVerifiedDetail} />
        {state.cleanupFailed && <Notice tone="warning" message={en.inspectCleanupFailed} />}
        <Group header={en.inspectContents} footer={`${state.inPlace ? '' : `${en.inspectCopyNote} `}${en.inspectFooter}`}>
          <Row title={counts.memories[0]} detail={counts.memories[1]} value={state.preview.memories.toLocaleString()} />
          <Row title={counts.objects[0]} detail={counts.objects[1]} value={`${state.preview.objects.toLocaleString()} · ${size(state.preview.originalBytes)}`} />
          {state.preview.sharedObjects > 0 && <Row title={counts.shared[0]} detail={counts.shared[1]} value={state.preview.sharedObjects.toLocaleString()} />}
          <Row title={counts.sources[0]} detail={counts.sources[1]} value={state.preview.sources.toLocaleString()} />
          <Row title={counts.favorites[0]} detail={counts.favorites[1]} value={state.preview.favorites.toLocaleString()} />
          <Row title={counts.pending[0]} detail={counts.pending[1]} value={state.preview.pendingFiles.toLocaleString()} />
          {state.preview.overlayOnly > 0 && <Row title={counts.overlayOnly[0]} detail={counts.overlayOnly[1]} value={state.preview.overlayOnly.toLocaleString()} />}
          {state.preview.variants > 0 && <Row title={counts.variants[0]} detail={counts.variants[1]} value={state.preview.variants.toLocaleString()} />}
          {state.preview.unreferencedObjects > 0 && <Row title={counts.unlinked[0]} detail={counts.unlinked[1]} value={state.preview.unreferencedObjects.toLocaleString()} />}
        </Group>
      </>}
      {state.kind !== 'verified' && !working && <Group inset={52}>
        <Row icon="time-outline" title={en.inspectFull} detail={en.inspectFullDetail} />
        <Row icon="shield-checkmark-outline" title={en.inspectReadOnly} detail={en.inspectReadOnlyDetail} />
        <Row icon="information-circle-outline" title={en.inspectLater} detail={en.inspectLaterDetail} />
      </Group>}
    </ScrollView>
    <View style={[styles.actions, { backgroundColor: t.ground }]}>
      {working ? <Button variant="secondary" label={en.inspectCancel} disabled={state.cancelling} onPress={cancel} />
        : <Button icon="document-outline" label={state.kind === 'idle' ? en.inspectChoose : en.inspectAgain} onPress={() => void check()} />}
    </View>
  </SafeAreaView>;
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  topBar: { minHeight: 52, justifyContent: 'center', paddingHorizontal: space.gutter - 4 },
  content: { paddingHorizontal: space.gutter, paddingBottom: 24, gap: space.section, width: '100%', maxWidth: 640, alignSelf: 'center' },
  block: { gap: 12 },
  track: { height: 6, borderRadius: 3, overflow: 'hidden' },
  fill: { position: 'absolute', left: 0, top: 0, bottom: 0, borderRadius: 3 },
  actions: { paddingHorizontal: space.gutter, paddingTop: 12, paddingBottom: 16, width: '100%', maxWidth: 640, alignSelf: 'center' },
});
