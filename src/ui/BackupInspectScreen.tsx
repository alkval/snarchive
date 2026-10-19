import { useEffect, useRef, useState } from 'react';
import { BackHandler, ScrollView, StyleSheet, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { BackupPreview } from '../backup/manifest';
import type { InspectionProgress } from '../backup/inspectBackup';
import { cancelBackupInspection, inspectBackupDocument, InspectionFailure } from '../platform/backupInspection';
import { cancelBackupRestore, restoreBackupDocument, RestoreFailure, type RestoreOutcome, type RestoreProgress } from '../platform/backupRestore';
import { sourcePicker } from '../platform/sourcePicker';
import { en } from '../i18n/en';
import { BackButton, Button, Group, LargeTitle, Notice, Row } from './kit';
import { space, useTheme } from './theme';

type Verified = { uri: string; preview: BackupPreview; inPlace: boolean; cleanupFailed: boolean };
type State =
  | { kind: 'idle' } | { kind: 'cancelled'; cleanupFailed: boolean } | { kind: 'picker-closed' }
  | { kind: 'working'; progress: InspectionProgress | null; cancelling: boolean }
  | ({ kind: 'verified' } & Verified)
  | { kind: 'failed'; code: string; cleanupFailed: boolean }
  | { kind: 'restoring'; verified: Verified; progress: RestoreProgress | null; cancelling: boolean }
  | { kind: 'restore-failed'; verified: Verified; code: string; cleanupFailed: boolean }
  | { kind: 'restored'; outcome: RestoreOutcome };

function size(bytes: number): string {
  const units = ['bytes', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes, unit = 0;
  while (value >= 1000 && unit < units.length - 1) { value /= 1000; unit++; }
  return unit === 0 ? `${bytes} bytes` : `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
}

/** Checks a backup (read-only), then, only on the explicit Restore action, adds it to the library. */
export function BackupInspectScreen({ onClose, onChanged, onOpenLibrary }: { onClose(): void; onChanged(): void; onOpenLibrary(): void }) {
  const t = useTheme();
  const [state, setState] = useState<State>({ kind: 'idle' });
  const running = useRef<'check' | 'restore' | null>(null), stopped = useRef(false), mounted = useRef(true);
  const cancel = () => {
    if (!running.current) return;
    stopped.current = true;
    if (running.current === 'restore') cancelBackupRestore(); else cancelBackupInspection();
    setState(previous => previous.kind === 'working' || previous.kind === 'restoring' ? { ...previous, cancelling: true } : previous);
  };
  useEffect(() => {
    mounted.current = true;
    const back = BackHandler.addEventListener('hardwareBackPress', () => { if (running.current) cancel(); else onClose(); return true; });
    // Leaving the screen cancels; the native session then closes itself and deletes its private files.
    return () => { back.remove(); mounted.current = false; if (running.current) { stopped.current = true; cancelBackupInspection(); } };
  }, [onClose]);

  async function check() {
    if (running.current) return; // Repeated taps never start a second session.
    running.current = 'check'; stopped.current = false;
    setState({ kind: 'working', progress: null, cancelling: false });
    try {
      const uri = await sourcePicker.selectBackup();
      if (!mounted.current) return;
      if (!uri) { setState({ kind: 'picker-closed' }); return; }
      if (stopped.current) { setState({ kind: 'cancelled', cleanupFailed: false }); return; }
      const outcome = await inspectBackupDocument(uri, () => stopped.current,
        progress => { if (mounted.current) setState(previous => ({ kind: 'working', progress, cancelling: previous.kind === 'working' && previous.cancelling })); });
      if (mounted.current) setState({ kind: 'verified', uri, ...outcome });
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      const cleanupFailed = error instanceof InspectionFailure && error.cleanupFailed;
      if (mounted.current) setState(code === 'cancelled' || stopped.current ? { kind: 'cancelled', cleanupFailed } : { kind: 'failed', code, cleanupFailed });
    } finally { running.current = null; }
  }

  /** The explicit approval to change the library. The backup is validated again inside the restore itself. */
  async function restore(verified: Verified) {
    if (running.current) return;
    running.current = 'restore'; stopped.current = false;
    setState({ kind: 'restoring', verified, progress: null, cancelling: false });
    try {
      const outcome = await restoreBackupDocument(verified.uri, () => stopped.current,
        progress => { if (mounted.current) setState(previous => ({ kind: 'restoring', verified, progress, cancelling: previous.kind === 'restoring' && previous.cancelling })); });
      onChanged();
      if (mounted.current) setState({ kind: 'restored', outcome });
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      const cleanupFailed = error instanceof RestoreFailure && error.cleanupFailed;
      if (mounted.current) setState({ kind: 'restore-failed', verified, code, cleanupFailed });
    } finally { running.current = null; }
  }

  const working = state.kind === 'working' || state.kind === 'restoring';
  const counts = en.inspectCounts;
  const checkProgress = state.kind === 'working' ? state.progress : null;
  const restoreProgress = state.kind === 'restoring' ? state.progress : null;
  const fraction = checkProgress?.stage === 'objects' ? (checkProgress.totalBytes > 0 ? checkProgress.bytes / checkProgress.totalBytes : checkProgress.done ? 1 : 0)
    : restoreProgress?.stage === 'objects' ? (restoreProgress.totalBytes > 0 ? restoreProgress.bytes / restoreProgress.totalBytes : restoreProgress.done ? 1 : 0) : null;
  const verified = state.kind === 'verified' ? state : state.kind === 'restore-failed' ? state.verified : null;
  const progressMessage = state.kind === 'working' ? (state.cancelling ? en.inspectCancelling
      : checkProgress?.stage === 'objects' ? en.inspectObjects(checkProgress.verified, checkProgress.total, size(checkProgress.bytes), size(checkProgress.totalBytes))
      : checkProgress?.stage === 'manifest' ? en.inspectStage.manifest : en.inspectStage.opening)
    : state.kind === 'restoring' ? (state.cancelling ? en.restoreCancelling
      : restoreProgress?.stage === 'objects' ? en.restoreObjects(restoreProgress.stored, restoreProgress.total, size(restoreProgress.bytes), size(restoreProgress.totalBytes))
      : restoreProgress?.stage === 'merging' ? en.restoreStage.merging : en.restoreStage.validating)
    : '';

  return <SafeAreaView style={[styles.root, { backgroundColor: t.ground }]}>
    <StatusBar style={t.dark ? 'light' : 'dark'} />
    <View style={styles.topBar}><BackButton label={en.title} onPress={() => { if (running.current) cancel(); else onClose(); }} /></View>
    <ScrollView contentContainerStyle={styles.content}>
      <LargeTitle title={en.inspectTitle} subtitle={en.inspectSubtitle} />
      {working && <View style={styles.block}>
        <Notice tone="progress" message={progressMessage} />
        {fraction !== null && <View accessible={false} style={[styles.track, { backgroundColor: t.raised }]}>
          <View style={[styles.fill, { width: `${Math.round(fraction * 100)}%`, backgroundColor: t.accent }]} />
        </View>}
      </View>}
      {(state.kind === 'failed' || state.kind === 'cancelled') && en.inspectOutcomeNotices(
        state.kind === 'cancelled' ? { cancelled: true } : { cancelled: false, code: state.code }, state.cleanupFailed,
      ).map(notice => <Notice key={notice.message} tone={notice.tone} message={notice.message} />)}
      {state.kind === 'picker-closed' && <Notice tone="info" message={en.inspectPickerClosed} />}
      {state.kind === 'restore-failed' && en.restoreFailureNotices(state.code, state.cleanupFailed)
        .map(notice => <Notice key={notice.message} tone={notice.tone} message={notice.message} />)}
      {state.kind === 'restored' && <>
        <Notice tone="success" title={en.restoreDone} message={en.restoreDoneDetail} />
        {state.outcome.cleanupFailed && <Notice tone="warning" message={en.inspectCleanupFailed} />}
        <Group header={en.restoreChanges}>
          <Row title={en.restoreChangeRows.memories[0]} detail={en.restoreChangeRows.memories[1]} value={state.outcome.changes.memoriesAdded.toLocaleString()} />
          <Row title={en.restoreChangeRows.files[0]} detail={en.restoreChangeRows.files[1]} value={en.restoreFilesValue(state.outcome.files.added, state.outcome.files.reused)} />
          <Row title={en.restoreChangeRows.favorites[0]} detail={en.restoreChangeRows.favorites[1]} value={state.outcome.changes.favoritesAdded.toLocaleString()} />
          <Row title={en.restoreChangeRows.sources[0]} detail={en.restoreChangeRows.sources[1]} value={en.restoreSourcesValue(state.outcome.changes.sourcesAdded, state.outcome.changes.sourcesUpdated)} />
          <Row title={en.restoreChangeRows.preserved[0]} detail={en.restoreChangeRows.preserved[1]} value={state.outcome.changes.filesPreserved.toLocaleString()} />
        </Group>
      </>}
      {state.kind === 'verified' && <>
        <Notice tone="success" title={en.inspectVerified} message={en.inspectVerifiedDetail} />
        {state.cleanupFailed && <Notice tone="warning" message={en.inspectCleanupFailed} />}
      </>}
      {verified && <>
        <Group header={en.inspectContents} footer={en.inspectFooterFor(verified.inPlace, verified.cleanupFailed)}>
          <Row title={counts.memories[0]} detail={counts.memories[1]} value={verified.preview.memories.toLocaleString()} />
          <Row title={counts.objects[0]} detail={counts.objects[1]} value={`${verified.preview.objects.toLocaleString()} · ${size(verified.preview.originalBytes)}`} />
          {verified.preview.sharedObjects > 0 && <Row title={counts.shared[0]} detail={counts.shared[1]} value={verified.preview.sharedObjects.toLocaleString()} />}
          <Row title={counts.sources[0]} detail={counts.sources[1]} value={verified.preview.sources.toLocaleString()} />
          <Row title={counts.favorites[0]} detail={counts.favorites[1]} value={verified.preview.favorites.toLocaleString()} />
          <Row title={counts.pending[0]} detail={counts.pending[1]} value={verified.preview.pendingFiles.toLocaleString()} />
          {verified.preview.overlayOnly > 0 && <Row title={counts.overlayOnly[0]} detail={counts.overlayOnly[1]} value={verified.preview.overlayOnly.toLocaleString()} />}
          {verified.preview.variants > 0 && <Row title={counts.variants[0]} detail={counts.variants[1]} value={verified.preview.variants.toLocaleString()} />}
          {verified.preview.unreferencedObjects > 0 && <Row title={counts.unlinked[0]} detail={counts.unlinked[1]} value={verified.preview.unreferencedObjects.toLocaleString()} />}
        </Group>
        <Group header={en.restoreHeader} footer={en.restoreFooter} inset={52}>
          <Row icon="add-circle-outline" title={en.restoreAdds} detail={en.restoreAddsDetail} />
          <Row icon="heart-outline" title={en.restoreFavorites} detail={en.restoreFavoritesDetail} />
          <Row icon="copy-outline" title={en.restoreVariants} detail={en.restoreVariantsDetail} />
          <Row icon="shield-checkmark-outline" title={en.restoreChecked} detail={en.restoreCheckedDetail} />
        </Group>
      </>}
      {(state.kind === 'idle' || state.kind === 'failed' || state.kind === 'cancelled' || state.kind === 'picker-closed') && <Group inset={52}>
        <Row icon="time-outline" title={en.inspectFull} detail={en.inspectFullDetail} />
        <Row icon="shield-checkmark-outline" title={en.inspectReadOnly} detail={en.inspectReadOnlyDetail} />
        <Row icon="information-circle-outline" title={en.inspectLater} detail={en.inspectLaterDetail} />
      </Group>}
    </ScrollView>
    <View style={[styles.actions, { backgroundColor: t.ground }]}>
      {working ? <Button variant="secondary" label={state.kind === 'restoring' ? en.restoreCancel : en.inspectCancel} disabled={state.cancelling} onPress={cancel} />
        : state.kind === 'restored' ? <>
          <Button icon="images-outline" label={en.restoreOpenLibrary} onPress={onOpenLibrary} />
          <Button variant="plain" label={en.restoreFinish} onPress={onClose} />
        </>
        : verified ? <>
          <Button icon="download-outline" label={en.restoreStart} onPress={() => void restore(verified)} />
          <Button variant="plain" label={en.inspectAgain} onPress={() => void check()} />
        </>
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
  actions: { paddingHorizontal: space.gutter, paddingTop: 12, paddingBottom: 16, gap: 4, width: '100%', maxWidth: 640, alignSelf: 'center' },
});
