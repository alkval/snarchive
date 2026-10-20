import { useEffect, useRef, useState } from 'react';
import { BackHandler, ScrollView, StyleSheet, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { StorageReviewFailure, type CleanupReport, type StorageEntry, type StorageKind, type StorageReviewResult } from '../integrity/storageCleanup';
import { cancelStorageWork, removeStorageSelection, reviewLibraryStorage } from '../platform/storageCleanup';
import { en } from '../i18n/en';
import { BackButton, Button, Group, LargeTitle, Notice, Row } from './kit';
import { storageEntryLabel, storageSize as size } from './storageLabels';
import { space, useTheme } from './theme';

const PAGE = 50;
type Review = { result: StorageReviewResult; selected: Record<StorageKind, Set<string>>; shown: Record<StorageKind, number> };
type State =
  | { kind: 'idle' } | { kind: 'failed'; code: string; cleanupFailed: boolean }
  | { kind: 'scanning'; listed: number; cancelling: boolean }
  | ({ kind: 'reviewed' } & Review)
  | ({ kind: 'confirming'; target: StorageKind } & Review)
  | { kind: 'removing'; target: StorageKind; done: number; total: number; cancelling: boolean }
  | { kind: 'removed'; target: StorageKind; report: CleanupReport }
  | { kind: 'remove-failed'; code: string; cleanupFailed: boolean };

/** The same title, detail and spoken label wherever a file is shown. */
const labelled = (entry: StorageEntry) => { const { title, detail, accessibilityLabel } = storageEntryLabel(entry); return { title, detail, label: accessibilityLabel }; };
const list = (review: Review, kind: StorageKind) => kind === 'object' ? review.result.uncatalogued : review.result.quarantine;

/** Reviews removable files (read-only), then removes only what the user selected and confirmed. A new review is needed
 * after any removal; selections never carry over to files found later. */
export function ManageStorageScreen({ onClose }: { onClose(): void }) {
  const t = useTheme();
  const [state, setState] = useState<State>({ kind: 'idle' });
  const running = useRef<'scan' | 'remove' | null>(null), stopped = useRef(false), mounted = useRef(true);
  const cancel = () => {
    if (!running.current) return;
    stopped.current = true; cancelStorageWork();
    setState(previous => previous.kind === 'scanning' || previous.kind === 'removing' ? { ...previous, cancelling: true } : previous);
  };
  useEffect(() => {
    mounted.current = true;
    const back = BackHandler.addEventListener('hardwareBackPress', () => {
      if (running.current) cancel();
      else setState(previous => { if (previous.kind === 'confirming') return { ...previous, kind: 'reviewed' }; onClose(); return previous; });
      return true;
    });
    return () => { back.remove(); mounted.current = false; if (running.current) { stopped.current = true; cancelStorageWork(); } };
  }, [onClose]);

  async function review() {
    if (running.current) return;
    running.current = 'scan'; stopped.current = false;
    setState({ kind: 'scanning', listed: 0, cancelling: false });
    try {
      const result = await reviewLibraryStorage(() => stopped.current,
        listed => { if (mounted.current) setState(previous => previous.kind === 'scanning' ? { ...previous, listed } : previous); });
      if (mounted.current) setState({ kind: 'reviewed', result, selected: { object: new Set(), quarantine: new Set() },
        shown: { object: Math.min(PAGE, result.uncatalogued.length), quarantine: Math.min(PAGE, result.quarantine.length) } });
    } catch (error) {
      const code = stopped.current ? 'cancelled' : error instanceof Error ? error.message : '';
      if (mounted.current) setState({ kind: 'failed', code, cleanupFailed: error instanceof StorageReviewFailure && error.cleanupFailed });
    } finally { running.current = null; }
  }

  function toggle(target: StorageKind, path: string) {
    setState(previous => {
      if (previous.kind !== 'reviewed') return previous;
      const selected = new Set(previous.selected[target]);
      if (selected.has(path)) selected.delete(path); else selected.add(path);
      return { ...previous, selected: { ...previous.selected, [target]: selected } };
    });
  }
  function selectAll(target: StorageKind, all: boolean) {
    setState(previous => previous.kind !== 'reviewed' ? previous
      : { ...previous, selected: { ...previous.selected, [target]: all ? new Set(list(previous, target).map(entry => entry.path)) : new Set() } });
  }

  /** The explicit confirmation authorizes exactly the selected entries of this list, as they were listed. */
  async function remove(reviewState: Review, target: StorageKind) {
    if (running.current) return;
    const selection = list(reviewState, target).filter(entry => reviewState.selected[target].has(entry.path));
    if (selection.length === 0) return;
    running.current = 'remove'; stopped.current = false;
    setState({ kind: 'removing', target, done: 0, total: selection.length, cancelling: false });
    try {
      const report = await removeStorageSelection(selection, () => stopped.current,
        (done, total) => { if (mounted.current) setState(previous => previous.kind === 'removing' ? { ...previous, done, total } : previous); });
      if (mounted.current) setState({ kind: 'removed', target, report });
    } catch (error) {
      const code = stopped.current ? 'cancelled' : error instanceof Error ? error.message : '';
      if (mounted.current) setState({ kind: 'remove-failed', code, cleanupFailed: error instanceof StorageReviewFailure && error.cleanupFailed });
    } finally { running.current = null; }
  }

  const working = state.kind === 'scanning' || state.kind === 'removing';
  const reviewed = state.kind === 'reviewed' ? state : null;
  const confirming = state.kind === 'confirming' ? state : null;

  const section = (review: Review, target: StorageKind) => {
    const entries = list(review, target), selected = review.selected[target];
    const header = `${target === 'object' ? en.storageUncatalogued : en.storageQuarantine} · ${en.storageCount(entries.length, size(entries.reduce((n, e) => n + e.bytes, 0)))}`;
    return <View key={target} style={styles.block}>
      <Group header={header} footer={target === 'object' ? en.storageUncataloguedFooter : en.storageQuarantineFooter}>
        {entries.length === 0 ? <Row title={en.storageNone} /> : entries.slice(0, review.shown[target]).map(entry => (
          <Row key={entry.path} checked={selected.has(entry.path)} onPress={() => toggle(target, entry.path)} {...labelled(entry)}
            accessory={<Ionicons name={selected.has(entry.path) ? 'checkmark-circle' : 'ellipse-outline'} size={22} color={selected.has(entry.path) ? t.accent : t.secondary} />} />
        ))}
      </Group>
      {review.shown[target] < entries.length && <Button variant="plain" label={en.storageMore(review.shown[target], entries.length)}
        onPress={() => setState(previous => previous.kind === 'reviewed' ? { ...previous, shown: { ...previous.shown, [target]: Math.min(entries.length, previous.shown[target] + PAGE) } } : previous)} />}
      {entries.length > 0 && <View style={styles.inline}>
        <Button variant="plain" label={selected.size === entries.length ? en.storageClear : en.storageSelectAll(entries.length)} onPress={() => selectAll(target, selected.size !== entries.length)} />
        <Button variant="secondary" label={en.storageRemoveSelected(selected.size)} disabled={selected.size === 0}
          onPress={() => setState(previous => previous.kind === 'reviewed' ? { ...previous, kind: 'confirming', target } : previous)} />
      </View>}
    </View>;
  };

  const confirmSelection = confirming ? list(confirming, confirming.target).filter(entry => confirming.selected[confirming.target].has(entry.path)) : [];
  const report = state.kind === 'removed' ? state.report : null;

  return <SafeAreaView style={[styles.root, { backgroundColor: t.ground }]}>
    <StatusBar style={t.dark ? 'light' : 'dark'} />
    <View style={styles.topBar}><BackButton label={en.title} onPress={() => { if (running.current) cancel(); else if (confirming) setState({ ...confirming, kind: 'reviewed' }); else onClose(); }} /></View>
    <ScrollView contentContainerStyle={styles.content}>
      <LargeTitle title={en.storageTitle} subtitle={en.storageSubtitle} />
      {state.kind === 'scanning' && <Notice tone="progress" message={state.cancelling ? en.storageCancelling : en.storageScanning(state.listed)} />}
      {state.kind === 'removing' && <Notice tone="progress" message={state.cancelling ? en.storageCancelling : en.storageRemoving(state.done, state.total)} />}
      {(state.kind === 'failed' || state.kind === 'remove-failed') && <>
        <Notice tone={state.code === 'cancelled' ? 'info' : 'warning'} message={en.storageFailed(state.code)} />
        {state.cleanupFailed && <Notice tone="warning" message={en.storageSessionCleanup} />}
      </>}
      {reviewed && <>
        {reviewed.result.cleanupFailed && <Notice tone="warning" message={en.storageSessionCleanup} />}
        {reviewed.result.unrecognized > 0 && <Notice tone="info" message={en.storageUnrecognized(reviewed.result.unrecognized)} />}
        {section(reviewed, 'object')}
        {section(reviewed, 'quarantine')}
      </>}
      {confirming && <Notice tone="warning" title={en.storageConfirmTitle(confirmSelection.length, size(confirmSelection.reduce((n, e) => n + e.bytes, 0)))}
        message={confirming.target === 'quarantine' ? en.storageConfirmQuarantine : en.storageConfirmObjects} />}
      {confirming && <Group header={en.storageSelection}>
        {confirmSelection.map(entry => <Row key={entry.path} {...labelled(entry)} />)}
      </Group>}
      {report && <>
        {report.stopped && <Notice tone={report.stopped === 'cancelled' ? 'info' : 'warning'} message={en.storageStopped(report.stopped)} />}
        {report.warnings.length > 0 && <Notice tone="warning" message={en.storageSyncWarning(report.warnings.length)} />}
        {report.cleanupFailed && <Notice tone="warning" message={en.storageSessionCleanup} />}
        <Group header={en.storageResultTitle} footer={en.storageResultFooter}>
          {([['removed', report.removed.length], ['skipped', report.skipped.length], ['failed', report.failed.length], ['notAttempted', report.notAttempted.length]] as const)
            .map(([key, count]) => <Row key={key} title={en.storageResultRows[key][0]} detail={en.storageResultRows[key][1]} value={count.toLocaleString()} />)}
        </Group>
      </>}
      {(state.kind === 'idle' || state.kind === 'failed') && <Group inset={52}>
        <Row icon="eye-outline" title={en.storageReviewOnly} detail={en.storageReviewOnlyDetail} />
        <Row icon="shield-checkmark-outline" title={en.storageProtected} detail={en.storageProtectedDetail} />
        <Row icon="information-circle-outline" title={en.storageEstimate} detail={en.storageEstimateDetail} />
      </Group>}
    </ScrollView>
    <View style={[styles.actions, { backgroundColor: t.ground }]}>
      {working ? <Button variant="secondary" label={en.storageCancel} disabled={state.cancelling} onPress={cancel} />
        : confirming ? <>
          <Button icon="trash-outline" label={en.storageConfirm} onPress={() => void remove(confirming, confirming.target)} />
          <Button variant="plain" label={en.storageConfirmCancel} onPress={() => setState({ ...confirming, kind: 'reviewed' })} />
        </>
        : state.kind === 'removed' || state.kind === 'remove-failed' ? <>
          <Button icon="refresh-outline" label={en.storageReviewAgain} onPress={() => void review()} />
          <Button variant="plain" label={en.storageDone} onPress={onClose} />
        </>
        : reviewed ? <Button variant="plain" label={en.storageReviewAgain} onPress={() => void review()} />
        : <Button icon="search-outline" label={state.kind === 'idle' ? en.storageStart : en.storageReviewAgain} onPress={() => void review()} />}
    </View>
  </SafeAreaView>;
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  topBar: { minHeight: 52, justifyContent: 'center', paddingHorizontal: space.gutter - 4 },
  content: { paddingHorizontal: space.gutter, paddingBottom: 24, gap: space.section, width: '100%', maxWidth: 640, alignSelf: 'center' },
  block: { gap: 8 },
  inline: { gap: 4 },
  actions: { paddingHorizontal: space.gutter, paddingTop: 12, paddingBottom: 16, gap: 4, width: '100%', maxWidth: 640, alignSelf: 'center' },
});
