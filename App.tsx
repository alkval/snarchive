import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, BackHandler, Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import Ionicons from '@expo/vector-icons/Ionicons';
import { openImportStore } from './src/platform/originalImporter';
import type { ImportStore, ImportSummary } from './src/storage/importStore';
import { LibraryBrowser } from './src/ui/LibraryBrowser';
import { ImportScreen } from './src/ui/ImportScreen';
import { SettingsScreen, type SettingsAction } from './src/ui/SettingsScreen';
import { BackupScreen } from './src/ui/BackupScreen';
import { BackupInspectScreen } from './src/ui/BackupInspectScreen';
import { OriginalsCheckScreen } from './src/ui/OriginalsCheckScreen';
import { ManageStorageScreen } from './src/ui/ManageStorageScreen';
import { recoverBackups } from './src/platform/backup';
import { Button, LargeTitle, Notice } from './src/ui/kit';
import { space, type, useTheme } from './src/ui/theme';
import { AppearanceProvider } from './src/ui/AppearanceProvider';
import { AppearanceScreen } from './src/ui/AppearanceScreen';
import { clearLibrary } from './src/platform/storageCleanup';

type Route = 'library' | 'import' | 'settings' | SettingsAction;
export default function App() { return <SafeAreaProvider><AppearanceProvider><SnarchiveApp /></AppearanceProvider></SafeAreaProvider>; }
function SnarchiveApp() {
  const t = useTheme();
  const [store, setStore] = useState<ImportStore | null>(null), [summary, setSummary] = useState<ImportSummary | null>(null);
  const [route, setRoute] = useState<Route>('library'), [initialKind, setInitialKind] = useState<'zip' | 'directory' | undefined>();
  const [resetWarning, setResetWarning] = useState('');
  const [loadAttempt, setLoadAttempt] = useState(0), [failed, setFailed] = useState(false), [warning, setWarning] = useState('');
  const [revision, setRevision] = useState(0), [toast, setToast] = useState('');
  const [resetting, setResetting] = useState(false);
  const resetRunning = useRef(false);
  const browserBack = useRef<(() => boolean) | null>(null), importBack = useRef<(() => void) | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true; let active = true; setFailed(false);
    void (async () => {
      try {
        await recoverBackups().catch(() => { if (active) setWarning('Some temporary files could not be cleared. File operations will retry cleanup.'); });
        const library = await openImportStore(), state = await library.summary();
        if (active) { setStore(library); setSummary(state); }
      } catch { if (active) setFailed(true); }
    })();
    return () => { active = false; mounted.current = false; };
  }, [loadAttempt]);
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(''), 3500); return () => clearTimeout(timer); }, [toast]);
  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (resetting) return true;
      if (route === 'import') { importBack.current?.(); return true; }
      if (route === 'settings') { setRoute('library'); return true; }
      return route === 'library' && !!browserBack.current?.();
    });
    return () => subscription.remove();
  }, [route, resetting]);
  const refresh = useCallback(async (reloadGrid = true) => {
    if (!store) return;
    const next = await store.summary().catch(() => null);
    if (!next) { if (mounted.current) setWarning('The library could not be refreshed. Close and reopen Snarchive to try again.'); return; }
    if (mounted.current) { setSummary(next); if (reloadGrid) setRevision(value => value + 1); }
  }, [store]);
  const finishImport = async (message: string) => { await refresh(); if (mounted.current) { setRoute('library'); setToast(message); } };
  const closeImport = () => { void refresh(); setRoute('library'); };
  const add = (kind?: 'zip' | 'directory') => { setInitialKind(kind); setRoute('import'); };
  const settings = useCallback(() => setRoute('settings'), []);
  const changed = useCallback(() => { void refresh(); }, [refresh]);
  const finishTool = useCallback(() => { setRoute('settings'); void refresh(); }, [refresh]);
  const showLibrary = useCallback(() => { setRoute('library'); void refresh(); }, [refresh]);
  const reset = async () => {
    if (resetRunning.current) return;
    resetRunning.current = true; setResetting(true);
    try {
      const result = await clearLibrary();
      const state = await store?.summary().catch(() => null);
      setSummary(state ?? { files: 0, objects: 0, memories: 0, unfinished: 0, conflicts: 0 });
      setRevision(value => value + 1); setRoute('library');
      setResetWarning(result.cleanupFailed ? 'The reset finished, but storage cleanup could not be confirmed. Retry Delete all Snarchive media from Settings.' : '');
      setToast(result.cleanupFailed ? 'Library cleared. Storage cleanup could not be completed; retry Delete all in Settings.' : 'Library cleared. You can import your exports again.');
    } finally { resetRunning.current = false; setResetting(false); }
  };
  if (!store || !summary) return <SafeAreaView style={[styles.center, { backgroundColor: t.ground }]}>
    {failed ? <Notice tone="error" message="Your library could not be opened. Its files have not been changed." action={{ label: 'Try again', onPress: () => setLoadAttempt(value => value + 1) }} />
      : <ActivityIndicator size="large" color={t.accent} accessibilityLabel="Opening library" />}
  </SafeAreaView>;
  return <View style={[styles.root, { backgroundColor: t.ground }]}>
    <StatusBar style={t.dark ? 'light' : 'dark'} />
    <View style={styles.root} pointerEvents={route === 'library' ? 'auto' : 'none'} importantForAccessibility={route === 'library' ? 'auto' : 'no-hide-descendants'} accessibilityElementsHidden={route !== 'library'}>
    {!resetting && summary.memories > 0 ? <LibraryBrowser store={store} onClose={() => {}} backHandler={browserBack}
      onAdd={() => add()} onSettings={() => setRoute('settings')} refreshToken={revision} onLibraryChanged={() => void refresh(false)} onNotice={setToast} />
      : <SafeAreaView style={styles.root}>
        <View style={styles.emptyBar}><Text style={[type.headline, { color: t.text }]}>Snarchive</Text>
          <Pressable accessibilityRole="button" accessibilityLabel="Settings" onPress={() => setRoute('settings')} style={styles.iconButton}><Ionicons name="settings-outline" size={24} color={t.text} /></Pressable>
        </View>
        <View style={styles.empty}>
          <Image source={require('./assets/icon.png')} style={styles.logo} accessibilityIgnoresInvertColors />
          <LargeTitle title="Your memories, together" subtitle="Add your Snapchat exports to start your library." />
          <Button label="Add ZIP files" icon="add" onPress={() => add('zip')} />
          <Button label="Add an extracted folder" variant="secondary" icon="folder-open-outline" onPress={() => add('directory')} />
        </View>
      </SafeAreaView>}
    </View>
    {!!toast && route === 'library' && <View style={[styles.toast, { backgroundColor: t.text }]} pointerEvents="none"><Text accessibilityLiveRegion="polite" style={[type.body, { color: t.ground }]}>{toast}</Text></View>}
    {route !== 'library' && <View style={[StyleSheet.absoluteFill, { backgroundColor: t.ground }]}>
      {route === 'import' && <ImportScreen store={store} initialKind={initialKind} close={closeImport} complete={finishImport} backHandler={importBack} />}
      {route === 'settings' && <SettingsScreen close={() => setRoute('library')} open={setRoute} warning={[warning, resetWarning].filter(Boolean).join('\n\n')} reset={reset} resetting={resetting} />}
      {route === 'appearance' && <AppearanceScreen onClose={settings} />}
      {route === 'backup' && <BackupScreen onClose={settings} />}
      {route === 'restore' && <BackupInspectScreen onClose={finishTool} onChanged={changed} onOpenLibrary={showLibrary} />}
      {route === 'check' && <OriginalsCheckScreen onClose={settings} />}
      {route === 'storage' && <ManageStorageScreen onClose={finishTool} />}
    </View>}
  </View>;
}
const styles = StyleSheet.create({ root: { flex: 1 }, center: { flex: 1, justifyContent: 'center', padding: 24 },
  emptyBar: { minHeight: 56, paddingHorizontal: space.gutter, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  iconButton: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center' },
  empty: { flex: 1, justifyContent: 'center', padding: 24, paddingBottom: 64, gap: 20, maxWidth: 600, width: '100%', alignSelf: 'center' },
  logo: { width: 88, height: 88, borderRadius: 24 },
  toast: { position: 'absolute', bottom: 32, left: 20, right: 20, borderRadius: 18, padding: 16, alignItems: 'center', elevation: 4 },
});
