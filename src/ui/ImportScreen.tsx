import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import { ActivityIndicator, Alert, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { sourcePicker } from '../platform/sourcePicker';
import { scanArchive, scanDirectory, cancelDirectoryScan } from '../platform/directoryScanner';
import { originalCopier } from '../platform/originalImporter';
import { folderCopier } from '../platform/folderImporter';
import type { ImportStore } from '../storage/importStore';
import { scanImportBatch, importBatch, type ImportBatch } from '../import/importBatch';
import { runImport } from '../import/runImport';
import { runFolderImport } from '../import/runFolderImport';
import { BackButton, Button, LargeTitle, Notice } from './kit';
import { space, type, useTheme } from './theme';

export function ImportScreen({ store, initialKind, close, complete, backHandler }: {
  store: ImportStore; initialKind?: 'zip' | 'directory'; close(): void; complete(message: string): Promise<void>;
  backHandler: MutableRefObject<(() => void) | null>;
}) {
  const t = useTheme();
  const [batch, setBatch] = useState<ImportBatch | null>(null), [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(''), [error, setError] = useState(''), [finished, setFinished] = useState(false);
  const running = useRef(false), cancelled = useRef(false), mounted = useRef(true), leave = useRef(false);
  const requestClose = () => {
    if (!running.current) { close(); return; }
    Alert.alert('Stop importing?', 'Memories already added will stay in your library. You can choose the same files later to continue.', [
      { text: 'Keep importing', style: 'cancel' }, { text: 'Stop', onPress: () => { leave.current = true; cancelled.current = true; cancelDirectoryScan(); setProgress('Stopping…'); } },
    ]);
  };
  useEffect(() => { backHandler.current = requestClose; return () => { backHandler.current = null; }; });
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; cancelled.current = true; }; }, []);
  const explain = (failure: unknown, importing: boolean) => {
    const code = failure instanceof Error ? failure.message : '';
    if (code === 'native-build-required') return 'This build cannot import these files. Install the latest Android APK, then try again.';
    if (code === 'no-media') return 'No supported memories were found. Choose ZIP files directly, or a folder containing already-extracted photos and videos.';
    if (code === 'selection-limit' || code === 'session-limit') return 'That selection is too large. Choose fewer ZIP parts at a time.';
    if (code === 'insufficient-storage') return 'There is not enough free space. Free some space, then choose these files again to continue.';
    if (code === 'source-changed' || code === 'folder-changed') return 'The export changed after it was checked. Choose it again.';
    if (code === 'cancelled' || cancelled.current) return 'Import stopped. Any completed memories were kept.';
    return importing ? 'Import stopped. Completed memories were kept. Choose the same files again to continue.' : 'These files could not be read. Choose the original export ZIPs or their extracted media folder.';
  };
  async function choose(kind: 'zip' | 'directory') {
    if (running.current) return;
    running.current = true; cancelled.current = false; leave.current = false; setBusy(true); setError(''); setBatch(null); setFinished(false);
    try {
      const selected = kind === 'zip' ? await sourcePicker.selectArchives() : await sourcePicker.selectDirectory().then(part => [part]).catch(failure => { if (failure?.code === 'ERR_PICKER_CANCELLED') return []; throw failure; });
      if (!selected.length || cancelled.current) return;
      const result = await scanImportBatch(selected, part => part.kind === 'zip' ? scanArchive(part.uri) : scanDirectory(part.uri),
        () => cancelled.current, (index, total) => { if (mounted.current) setProgress(`Checking export ${index} of ${total}…`); });
      if (mounted.current) setBatch(result);
    } catch (failure) { if (mounted.current && !leave.current) setError(explain(failure, false)); }
    finally { running.current = false; if (mounted.current) { setBusy(false); if (leave.current) await complete(''); } }
  }
  const began = useRef(false);
  useEffect(() => { if (initialKind && !began.current) { began.current = true; void choose(initialKind); } }, [initialKind]);
  async function add() {
    if (!batch || running.current) return;
    running.current = true; cancelled.current = false; leave.current = false; setBusy(true); setError('');
    const notes = new Set<string>();
    try {
      await importBatch(batch, async (part, index, total) => {
        const report = (files: number) => { if (mounted.current) setProgress(`Adding export ${index} of ${total} · ${files.toLocaleString()} files processed`); };
        report(0);
        if (part.hash) {
          await store.plan(part.hash, part.source);
          await runImport(store, originalCopier, part.hash, part.selection.uri, () => cancelled.current, report);
        } else {
          const hash = await store.planFolder(part.source);
          const result = await runFolderImport(store, folderCopier, hash, part.selection.uri, () => cancelled.current, report);
          if (!result.complete) notes.add('Some changed or unreadable files were skipped. Choose the folder again to retry.');
          if (result.changedSincePreserved) notes.add('Some export files have changed since an earlier import. Their saved originals were kept.');
          if (result.storeCleanupFailed) notes.add('Some temporary files could not be cleared. Free up space before trying again.');
        }
      }, () => cancelled.current);
      if (mounted.current) { if (notes.size) { setBatch(null); setFinished(true); setError([...notes].join(' ')); } else await complete('Added to your library'); }
    } catch (failure) {
      if (mounted.current && !leave.current) { setError(explain(failure, true) + (failure && typeof failure === 'object' && 'storeCleanupFailed' in failure && failure.storeCleanupFailed ? ' Some temporary files could not be cleared. Free up space before retrying.' : '')); setBatch(null); }
    } finally {
      running.current = false;
      if (mounted.current) { setBusy(false); if (leave.current) await complete('Import stopped. Completed memories were kept.'); }
    }
  }
  return <SafeAreaView style={[styles.root, { backgroundColor: t.ground }]}>
    <View style={styles.bar}><BackButton label="Library" onPress={requestClose} /></View>
    <ScrollView contentContainerStyle={styles.content}>
      <LargeTitle title="Add memories" subtitle={batch ? 'Ready to add to your library' : 'Choose your Snapchat export files.'} />
      {busy ? <View style={styles.progress}><ActivityIndicator size="large" color={t.accent} /><Text accessibilityLiveRegion="polite" style={[type.body, { color: t.text }]}>{progress || 'Opening file picker…'}</Text><Button label="Cancel" variant="secondary" onPress={requestClose} /></View>
        : finished ? <><Notice tone="warning" message={error} /><Button label="View library" onPress={() => void complete('')} /></> : batch ? <>
          <View style={[styles.review, { backgroundColor: t.surface }]}>
            <Text style={[type.title, { color: t.text }]}>{batch.memories.toLocaleString()} memories found</Text>
            <Text style={[type.body, { color: t.secondary }]}>{batch.photos} photos · {batch.videos} videos · {batch.overlays} overlays</Text>
            <Text style={[type.footnote, { color: t.secondary }]}>{batch.parts.length} export {batch.parts.length === 1 ? 'part' : 'parts'}. Matching overlays will be shown automatically.</Text>
          </View>
          <Button label={batch.memories ? 'Add to library' : 'Add overlays'} icon="add" onPress={() => void add()} />
          <Text style={[type.footnote, { color: t.secondary }]}>Files are copied into Snarchive. Your original exports stay unchanged.</Text>
          <Button label="Choose different files" variant="plain" onPress={() => setBatch(null)} />
        </> : <>
          <Button label="Choose ZIP files" icon="file-tray-full-outline" onPress={() => void choose('zip')} />
          <Button label="Choose an extracted folder" variant="secondary" icon="folder-open-outline" onPress={() => void choose('directory')} />
          <Text style={[type.footnote, { color: t.secondary }]}>For a split export, select all its ZIP parts together. The folder option is for photos and videos you have already extracted.</Text>
        </>}
      {!!error && !finished && <Notice tone="warning" message={error} />}
    </ScrollView>
  </SafeAreaView>;
}
const styles = StyleSheet.create({ root: { flex: 1 }, bar: { minHeight: 52, paddingHorizontal: space.gutter },
  content: { padding: space.gutter, paddingBottom: 48, gap: 24, maxWidth: 640, width: '100%', alignSelf: 'center' },
  review: { borderRadius: 20, padding: 24, gap: 12 }, progress: { gap: 24, paddingVertical: 32, alignItems: 'center' } });
