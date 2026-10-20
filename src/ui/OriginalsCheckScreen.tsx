import { useEffect, useRef, useState } from 'react';
import { BackHandler, ScrollView, StyleSheet, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { Affected, CheckProgress, CheckResult, Problem, RepairProgress, RepairReport } from '../integrity/originals';
import { RepairFailure } from '../integrity/originals';
import { cancelOriginalsWork, checkLibraryOriginals, describeProblems, repairFromBackup } from '../platform/originalsCheck';
import { sourcePicker } from '../platform/sourcePicker';
import { en } from '../i18n/en';
import { BackButton, Button, Group, LargeTitle, Notice, Row } from './kit';
import { space, useTheme } from './theme';

const PAGE = 50;
type Found = { result: CheckResult; problems: Problem[]; shown: number; affected: Map<string, Affected> };
type State =
  | { kind: 'idle' } | { kind: 'cancelled' } | { kind: 'failed'; code: string }
  | { kind: 'checking'; progress: CheckProgress | null; cancelling: boolean }
  | ({ kind: 'checked' } & Found)
  | ({ kind: 'repairing'; progress: RepairProgress | null; cancelling: boolean } & Found)
  | ({ kind: 'repaired'; report: RepairReport } & Found)
  | ({ kind: 'repair-failed'; code: string; cleanupFailed: boolean } & Found)
  | ({ kind: 'picker-closed' } & Found);

function size(bytes: number): string {
  const units = ['bytes', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes, unit = 0;
  while (value >= 1000 && unit < units.length - 1) { value /= 1000; unit++; }
  return unit === 0 ? `${bytes} bytes` : `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
}

/** Verifies every original (read-only), then, only on the explicit repair action, replaces damaged ones from a backup.
 * Results live only on this screen; leaving it discards them. */
export function OriginalsCheckScreen({ onClose }: { onClose(): void }) {
  const t = useTheme();
  const [state, setState] = useState<State>({ kind: 'idle' });
  const running = useRef<'check' | 'repair' | null>(null), stopped = useRef(false), mounted = useRef(true);
  const cancel = () => {
    if (!running.current) return;
    stopped.current = true; cancelOriginalsWork();
    setState(previous => previous.kind === 'checking' || previous.kind === 'repairing' ? { ...previous, cancelling: true } : previous);
  };
  useEffect(() => {
    mounted.current = true;
    const back = BackHandler.addEventListener('hardwareBackPress', () => { if (running.current) cancel(); else onClose(); return true; });
    return () => { back.remove(); mounted.current = false; if (running.current) { stopped.current = true; cancelOriginalsWork(); } };
  }, [onClose]);

  async function check() {
    if (running.current) return;
    running.current = 'check'; stopped.current = false;
    setState({ kind: 'checking', progress: null, cancelling: false });
    try {
      const result = await checkLibraryOriginals(() => stopped.current,
        progress => { if (mounted.current) setState(previous => ({ kind: 'checking', progress, cancelling: previous.kind === 'checking' && previous.cancelling })); });
      const affected = await describeProblems(result.problems.slice(0, PAGE).map(problem => problem.hash));
      if (mounted.current) setState({ kind: 'checked', result, problems: result.problems, shown: Math.min(PAGE, result.problems.length), affected });
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      if (mounted.current) setState(code === 'cancelled' || stopped.current ? { kind: 'cancelled' } : { kind: 'failed', code });
    } finally { running.current = null; }
  }

  async function more(found: Found) {
    const next = found.problems.slice(found.shown, found.shown + PAGE);
    const affected = new Map([...found.affected, ...await describeProblems(next.map(problem => problem.hash))]);
    if (mounted.current) setState(previous => 'problems' in previous ? { ...previous, shown: found.shown + next.length, affected } : previous);
  }

  /** The explicit approval to replace damaged originals. Only bytes that match the library's record are written. */
  async function repair(found: Found) {
    if (running.current) return;
    running.current = 'repair'; stopped.current = false;
    const base: Found = { result: found.result, problems: found.problems, shown: found.shown, affected: found.affected };
    try {
      const uri = await sourcePicker.selectBackup();
      if (!mounted.current) return;
      if (!uri) { setState({ kind: 'picker-closed', ...base }); return; }
      setState({ kind: 'repairing', progress: null, cancelling: false, ...base });
      const report = await repairFromBackup(uri, found.problems, () => stopped.current,
        progress => { if (mounted.current) setState(previous => previous.kind === 'repairing' ? { ...previous, progress } : previous); });
      // What remains is anything not repaired and not found valid; those can be tried from another backup.
      const fixed = new Set([...report.repaired, ...report.alreadyValid]);
      const problems = found.problems.filter(problem => !fixed.has(problem.hash));
      const affected = await describeProblems(problems.slice(0, PAGE).map(problem => problem.hash));
      if (mounted.current) setState({ kind: 'repaired', report, result: found.result, problems, shown: Math.min(PAGE, problems.length), affected });
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      const cleanupFailed = error instanceof RepairFailure && error.cleanupFailed;
      if (mounted.current) setState({ kind: 'repair-failed', code: stopped.current ? 'cancelled' : code, cleanupFailed, ...base });
    } finally { running.current = null; }
  }

  const working = state.kind === 'checking' || state.kind === 'repairing';
  const found = 'problems' in state ? state : null;
  const fraction = state.kind === 'checking' && state.progress ? (state.progress.totalBytes > 0 ? state.progress.bytes / state.progress.totalBytes : state.progress.total > 0 ? state.progress.checked / state.progress.total : 0)
    : state.kind === 'repairing' && state.progress?.stage === 'repairing' ? (state.progress.total > 0 ? state.progress.done / state.progress.total : 1) : null;
  const progressMessage = state.kind === 'checking' ? (state.cancelling ? en.originalsCancelling : state.progress ? en.originalsProgress(state.progress.checked, state.progress.total) : en.originalsProgress(0, 0))
    : state.kind === 'repairing' ? (state.cancelling ? en.originalsCancelling : state.progress?.stage === 'repairing' ? en.originalsRepairProgress(state.progress.done, state.progress.total) : en.originalsRepairValidating)
    : '';
  const shared = found ? found.problems.slice(0, found.shown).filter(problem => (found.affected.get(problem.hash)?.memoryCount ?? 0) > 1).length : 0;
  const report = state.kind === 'repaired' ? state.report : null;

  return <SafeAreaView style={[styles.root, { backgroundColor: t.ground }]}>
    <StatusBar style={t.dark ? 'light' : 'dark'} />
    <View style={styles.topBar}><BackButton label={en.title} onPress={() => { if (running.current) cancel(); else onClose(); }} /></View>
    <ScrollView contentContainerStyle={styles.content}>
      <LargeTitle title={en.originalsTitle} subtitle={en.originalsSubtitle} />
      {working && <View style={styles.block}>
        <Notice tone="progress" message={progressMessage} />
        {fraction !== null && <View accessible={false} style={[styles.track, { backgroundColor: t.raised }]}>
          <View style={[styles.fill, { width: `${Math.round(fraction * 100)}%`, backgroundColor: t.accent }]} />
        </View>}
      </View>}
      {state.kind === 'cancelled' && <Notice tone="info" message={en.originalsCancelled} />}
      {state.kind === 'failed' && <Notice tone="warning" message={state.code === 'busy' ? en.originalsBusy : en.originalsFailed} />}
      {state.kind === 'picker-closed' && <Notice tone="info" message={en.inspectPickerClosed} />}
      {state.kind === 'repair-failed' && <>
        <Notice tone={state.code === 'cancelled' ? 'info' : 'warning'} message={en.originalsRepairFailed(state.code)} />
        {state.cleanupFailed && <Notice tone="warning" message={en.inspectCleanupFailed} />}
      </>}
      {report && <>
        {report.stopped && <Notice tone={report.stopped === 'cancelled' ? 'info' : 'warning'} message={en.originalsRepairStopped(report.stopped)} />}
        {report.storeCleanupFailed && <Notice tone="warning" message={en.restoreStoreCleanupFailed} />}
        {report.cleanupFailed && <Notice tone="warning" message={en.inspectCleanupFailed} />}
        <Group header={en.originalsRepairTitle} footer={report.repaired.length > 0 ? `${en.originalsQuarantine} ${en.originalsAfterRepair}` : en.originalsAfterRepair}>
          {([['repaired', report.repaired.length], ['alreadyValid', report.alreadyValid.length], ['unavailable', report.unavailable.length],
            ['mismatch', report.mismatch.length], ['failed', report.failed.length], ['notAttempted', report.notAttempted.length]] as const)
            .filter(([key, count]) => count > 0 || key === 'repaired')
            .map(([key, count]) => <Row key={key} title={en.originalsRepairRows[key][0]} detail={en.originalsRepairRows[key][1]} value={count.toLocaleString()} />)}
        </Group>
      </>}
      {found && state.kind !== 'repairing' && (found.problems.length === 0
        ? <Notice tone="success" title={en.originalsAllGoodTitle} message={state.kind === 'checked' ? en.originalsAllGood(found.result.total) : en.originalsAfterRepair} />
        : <>
          {state.kind === 'checked' && <Notice tone="warning" title={en.originalsFoundTitle(found.problems.length)} message={en.originalsFound(found.result.total)} />}
          <Group header={en.originalsFoundTitle(found.problems.length)} footer={shared > 0 ? en.originalsShared(shared) : en.originalsRepairScopeDetail}>
            {found.problems.slice(0, found.shown).map(problem => {
              const affected = found.affected.get(problem.hash);
              const first = affected?.memories[0];
              const label = first ? `${first.day ?? en.originalsUnknownDay} · ${en.originalsRole[first.role as keyof typeof en.originalsRole] ?? first.role}` : '';
              return <Row key={problem.hash} title={`${en.originalsHealth[problem.health]} · ${size(problem.bytes)}`}
                detail={`${en.originalsHealthDetail[problem.health]} ${en.originalsUsedBy(affected?.memoryCount ?? 0, label)}`} />;
            })}
          </Group>
          {found.shown < found.problems.length && <Button variant="plain" label={en.originalsMore(found.shown, found.problems.length)} onPress={() => void more(found)} />}
        </>)}
      {(state.kind === 'idle' || state.kind === 'cancelled' || state.kind === 'failed') && <Group inset={52}>
        <Row icon="time-outline" title={en.originalsFull} detail={en.originalsFullDetail} />
        <Row icon="shield-checkmark-outline" title={en.originalsReadOnly} detail={en.originalsReadOnlyDetail} />
        <Row icon="archive-outline" title={en.originalsRepairScope} detail={en.originalsRepairScopeDetail} />
      </Group>}
    </ScrollView>
    <View style={[styles.actions, { backgroundColor: t.ground }]}>
      {working ? <Button variant="secondary" label={state.kind === 'repairing' ? en.originalsRepairCancel : en.originalsCancel} disabled={state.cancelling} onPress={cancel} />
        : found && found.problems.length > 0 ? <>
          <Button icon="archive-outline" label={state.kind === 'checked' ? en.originalsRepair : en.originalsRepairAnother} onPress={() => void repair(found)} />
          <Button variant="plain" label={en.originalsCheckAgain} onPress={() => void check()} />
        </>
        : found ? <>
          {state.kind !== 'checked' && <Button icon="shield-checkmark-outline" label={en.originalsCheckAgain} onPress={() => void check()} />}
          <Button variant="plain" label={en.originalsDone} onPress={onClose} />
        </>
        : <Button icon="shield-checkmark-outline" label={state.kind === 'idle' ? en.originalsStart : en.originalsCheckAgain} onPress={() => void check()} />}
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
