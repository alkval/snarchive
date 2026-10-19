import { useCallback, useEffect, useRef, useState, type ComponentRef } from 'react';
import { Modal, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { inventoryFromSnapshot, mergeSourceInventories, type InventoryPreview } from './src/import/sourceInventory';
import { scanDirectory, scanArchive, cancelDirectoryScan } from './src/platform/directoryScanner';
import { InventoryReport } from './src/ui/InventoryReport';
import { sourceIdentity } from './src/import/sourceIdentity';
import { en } from './src/i18n/en';
import { openPreviewStore } from './src/platform/previewDatabase';
import type { PreviewStore } from './src/storage/previewStore';
import { openImportStore, originalCopier } from './src/platform/originalImporter';
import { runImport } from './src/import/runImport';
import type { ImportStore, ImportSummary } from './src/storage/importStore';
import { LibraryBrowser } from './src/ui/LibraryBrowser';
import { sourcePicker } from './src/platform/sourcePicker';
import { BackupScreen } from './src/ui/BackupScreen';
import { recoverBackups } from './src/platform/backup';
import { Group, LargeTitle, Notice, Row, type Tone } from './src/ui/kit';
import { space, type, useTheme } from './src/ui/theme';

export default function App() {
  const t = useTheme();
  const browserBack = useRef<(() => boolean) | null>(null);
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);
  const [browsing, setBrowsing] = useState(false);
  const [backingUp, setBackingUp] = useState(false);
  const closeBackup = useCallback(() => setBackingUp(false), []);
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const store = useRef<PreviewStore | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(en.loading);
  const [preview, setPreview] = useState<InventoryPreview | null>(null);
  const library = useRef<ImportStore | null>(null);
  const [librarySummary, setLibrarySummary] = useState<ImportSummary | null>(null);
  const sourceIds = useRef(new Map<string, string>());
  const stopped = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    let active = true;
    setReady(false);
    setMessage(en.loading);
    void (async () => {
      try {
        const database = await openPreviewStore();
        const saved = await database.load();
        const recoveredBackupStaging = await recoverBackups().then(() => true, () => false);
        const imports = await openImportStore();
        const summary = await imports.summary();
        if (!active) return;
        store.current = database;
        library.current = imports;
        setLibrarySummary(summary);
        sourceIds.current = saved?.sourceIds ?? new Map();
        setPreview(saved?.preview ?? null);
        setMessage(recoveredBackupStaging ? (saved ? en.restored : en.empty) : en.stagingNotCleared);
        setReady(true);
      } catch {
        if (active) setMessage(en.loadFailed);
      }
    })();
    return () => { active = false; mounted.current = false; stopped.current = true; cancelDirectoryScan(); };
  }, [loadAttempt]);
  const picking = useRef(false);
  async function pick(kind: 'zip' | 'directory') {
    if (picking.current || !ready || !store.current) return;
    picking.current = true;
    setBusy(true);
    stopped.current = false;
    setMessage(en.busy);
    scroll.current?.scrollTo({ y: 0 });
    let checkpointing = false;
    try {
      const sources = kind === 'zip' ? await sourcePicker.selectArchives() : [await sourcePicker.selectDirectory()];
      if (!mounted.current || stopped.current) { if (mounted.current) setMessage(en.cancelled); return; }
      if (sources.length === 0) { setMessage(en.pickerClosed); return; }
      const nextIds = new Map(sourceIds.current);
      let next = preview;
      for (const selected of sources) {
        setMessage(en.scanning);
        const snapshot = selected.kind === 'zip' ? await scanArchive(selected.uri) : await scanDirectory(selected.uri);
        if (!mounted.current || stopped.current) { if (mounted.current) setMessage(en.cancelled); return; }
        const key = sourceIdentity(selected, snapshot);
        const id = nextIds.get(key) ?? `source-${nextIds.size + 1}`;
        const source = inventoryFromSnapshot(snapshot, id);
        next = mergeSourceInventories(next?.sources ?? [], source);
        nextIds.set(key, id);
      }
      if (next) {
        checkpointing = true;
        setSaving(true);
        setMessage(en.saving);
        await store.current.save({ preview: next, sourceIds: nextIds });
        if (!mounted.current) return;
        sourceIds.current = nextIds;
        setPreview(next);
        setMessage(en.selected(next.sources.length));
      }
    } catch (error) {
      // Native errors can contain personal paths. Do not log or display their payloads.
      if (mounted.current) setMessage(checkpointing ? en.saveFailed : stopped.current ? en.cancelled : error instanceof Error && error.message === 'native-build-required' ? en.nativeRequired : error instanceof Error && error.message === 'zip-unavailable-ios' ? en.zipIos : error instanceof Error && error.message === 'insufficient-storage' ? en.storage : error instanceof Error && error.message === 'unsafe-or-unsupported-zip' ? en.zipFailed : en.failed);
    } finally {
      picking.current = false;
      if (mounted.current) { setBusy(false); setSaving(false); }
    }
  }
  async function preserve(hash: string, sourceId: string) {
    if (picking.current || !ready || !library.current) return;
    const source = preview?.sources.find(item => item.sourceId === sourceId);
    if (!source) return;
    picking.current = true; stopped.current = false; setBusy(true); setMessage(en.importPick); scroll.current?.scrollTo({ y: 0 });
    try {
      const selected = await sourcePicker.selectArchives();
      if (stopped.current || !mounted.current) return;
      if (selected.length === 0) { setMessage(en.pickerClosed); return; }
      if (selected.length !== 1) { setMessage(en.importOne); return; }
      await library.current.plan(hash, source);
      await runImport(library.current, originalCopier, hash, selected[0]!.uri, () => stopped.current,
        count => { if (mounted.current) setMessage(en.importProgress(count)); });
      if (mounted.current) setMessage(en.importComplete);
    } catch (error) {
      if (mounted.current) setMessage(error instanceof Error && error.message === 'source-changed' ? en.importChanged
        : error instanceof Error && error.message === 'native-build-required' ? en.nativeRequired
        : error instanceof Error && error.message === 'insufficient-storage' ? en.importStorage
        : error instanceof Error && error.message === 'stored-object-corrupt' ? en.importCorrupt : en.importPaused);
    } finally {
      try { const summary = await library.current.summary(); if (mounted.current) setLibrarySummary(summary); }
      catch { if (mounted.current) setMessage(en.importPaused); }
      picking.current = false; if (mounted.current) setBusy(false);
    }
  }
  const tone = toneFor(message);
  const closeBrowser = () => { if (!browserBack.current?.()) setBrowsing(false); };
  const zipSources = [...sourceIds.current].filter(([key]) => key.startsWith('zip:'));
  if (backingUp) return <SafeAreaProvider><BackupScreen onClose={closeBackup} /></SafeAreaProvider>;
  return (
    <SafeAreaProvider>
      <SafeAreaView edges={['top', 'left', 'right']} style={[styles.root, { backgroundColor: t.ground }]}>
        <StatusBar style={t.dark ? 'light' : 'dark'} />
        <Modal visible={browsing} animationType="slide" onRequestClose={closeBrowser}>
          {browsing && library.current && <LibraryBrowser store={library.current} onClose={() => setBrowsing(false)} backHandler={browserBack} />}
        </Modal>
        <ScrollView ref={scroll} contentContainerStyle={styles.content}>
          <LargeTitle title={en.title} subtitle={en.promise} />
          {tone && <Notice tone={tone} message={message}
            action={busy && !saving ? { label: en.cancel, onPress: () => { stopped.current = true; cancelDirectoryScan(); setMessage(en.cancelled); } }
              : !ready && message === en.loadFailed ? { label: en.retry, onPress: () => setLoadAttempt(value => value + 1) } : undefined} />}
          {librarySummary && <View style={styles.section}>
            <View style={[styles.hero, { backgroundColor: t.surface }]}>
              <View accessible accessibilityLabel={`${librarySummary.memories} ${en.libraryHeadline(librarySummary.memories)}. ${en.libraryStats(librarySummary.objects, librarySummary.files)}`}>
                <Text style={[type.figure, { color: t.text }]}>{librarySummary.memories.toLocaleString()}</Text>
                <Text style={[type.headline, { color: t.text }]}>{en.libraryHeadline(librarySummary.memories)}</Text>
                <Text style={[type.footnote, styles.heroStats, { color: t.secondary }]}>{en.libraryStats(librarySummary.objects, librarySummary.files)}</Text>
              </View>
              {librarySummary.unfinished > 0 && <Text style={[type.footnote, { color: t.warning }]}>{en.libraryUnfinished(librarySummary.unfinished)}</Text>}
              {librarySummary.conflicts > 0 && <Text style={[type.footnote, { color: t.secondary }]}>{en.libraryConflicts(librarySummary.conflicts)}</Text>}
            </View>
            <Group inset={52}>
              <Row icon="images-outline" title={en.libraryBrowse} detail={en.libraryBrowseDetail} disabled={!ready || busy} onPress={() => setBrowsing(true)} />
              {Platform.OS === 'android' && <Row icon="archive-outline" title={en.backupOpen} detail={en.backupOpenDetail} disabled={!ready || busy} onPress={() => setBackingUp(true)} />}
            </Group>
          </View>}
          <Group header={en.heading} footer={`${en.explanation} ${en.zipNote}`} inset={52}>
            <Row icon="file-tray-full-outline" title={en.zip} detail={en.zipDetail} disabled={busy || !ready} onPress={() => void pick('zip')} />
            <Row icon="folder-open-outline" title={en.folder} detail={en.folderDetail} disabled={busy || !ready} onPress={() => void pick('directory')} />
          </Group>
          {librarySummary && <Group header={en.originals} footer={Platform.OS === 'android' ? en.importNote : en.importIos} inset={52}>
            {Platform.OS === 'android' && zipSources.map(([key, id]) => (
              <Row key={key} icon="download-outline" title={en.importZip(id)} detail={en.importZipDetail} disabled={busy || !ready} onPress={() => void preserve(key.slice(4), id)} />
            ))}
          </Group>}
          {preview && <InventoryReport preview={preview} footer={`${en.previewNote} ${en.savedNote}`} />}
          <Text style={[type.footnote, styles.footer, { color: t.secondary }]}>{en.prototype}</Text>
        </ScrollView>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

/** Which kind of notice a status message is. Idle guidance needs no card. */
function toneFor(message: string): Tone | null {
  if ([en.loading, en.busy, en.scanning, en.saving, en.importPick].includes(message) || /copied or verified/.test(message)) return 'progress';
  if (message === en.importComplete || /scanned and saved/.test(message)) return 'success';
  if ([en.loadFailed, en.importCorrupt].includes(message)) return 'error';
  if ([en.saveFailed, en.failed, en.zipFailed, en.zipIos, en.storage, en.nativeRequired, en.importOne, en.importChanged, en.importPaused, en.importStorage, en.stagingNotCleared].includes(message)) return 'warning';
  if ([en.cancelled, en.pickerClosed].includes(message)) return 'info';
  return null;
}
const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { paddingHorizontal: space.gutter, paddingBottom: 48, gap: space.section, width: '100%', maxWidth: 640, alignSelf: 'center' },
  section: { gap: 12 },
  hero: { borderRadius: space.radius, padding: 20, gap: 6 },
  heroStats: { marginTop: 4 },
  footer: { marginHorizontal: 4 },
});
