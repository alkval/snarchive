import { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, useColorScheme, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { inventoryFromSnapshot, mergeSourceInventories, type InventoryPreview } from './src/import/sourceInventory';
import { scanDirectory, scanArchive, cancelDirectoryScan } from './src/platform/directoryScanner';
import { InventoryReport } from './src/ui/InventoryReport';
import { sourceIdentity } from './src/import/sourceIdentity';
import { en } from './src/i18n/en';
import { openPreviewStore } from './src/platform/previewDatabase';
import type { PreviewStore } from './src/storage/previewStore';
import { sourcePicker } from './src/platform/sourcePicker';

export default function App() {
  const dark = useColorScheme() === 'dark';
  const colors = dark ? { background: '#151817', text: '#f3f4ef', muted: '#b9c2bc', button: '#b9dec8', buttonText: '#162d20' }
    : { background: '#f8f9f5', text: '#17261d', muted: '#506056', button: '#244f37', buttonText: '#ffffff' };
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const store = useRef<PreviewStore | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(en.loading);
  const [preview, setPreview] = useState<InventoryPreview | null>(null);
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
        if (!active) return;
        store.current = database;
        sourceIds.current = saved?.sourceIds ?? new Map();
        setPreview(saved?.preview ?? null);
        setMessage(saved ? en.restored : en.empty);
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
  return (
    <SafeAreaProvider>
      <SafeAreaView style={[styles.root, { backgroundColor: colors.background }]}>
        <StatusBar style={dark ? 'light' : 'dark'} />
        <ScrollView contentContainerStyle={styles.content}>
          <Text accessibilityRole="header" style={[styles.title, { color: colors.text }]}>{en.title}</Text>
          <Text style={[styles.body, { color: colors.muted }]}>{en.promise}</Text>
          <View style={styles.section}>
            <Text accessibilityRole="header" style={[styles.heading, { color: colors.text }]}>{en.heading}</Text>
            <Text style={[styles.body, { color: colors.muted }]}>{en.explanation}</Text>
            <Text style={[styles.body, { color: colors.muted }]}>{en.zipNote}</Text>
            {(['zip', 'directory'] as const).map((kind) => (
              <Pressable key={kind} accessibilityRole="button" accessibilityState={{ disabled: busy || !ready }} disabled={busy || !ready}
                onPress={() => void pick(kind)} style={({ pressed }) => [styles.button, { backgroundColor: colors.button, opacity: pressed || busy || !ready ? 0.6 : 1 }]}>
                <Text style={[styles.buttonLabel, { color: colors.buttonText }]}>{kind === 'zip' ? en.zip : en.folder}</Text>
              </Pressable>
            ))}
            <Text accessibilityLiveRegion="polite" style={[styles.body, { color: colors.text }]}>{message}</Text>
            {!ready && message === en.loadFailed && <Pressable accessibilityRole="button" onPress={() => setLoadAttempt(value => value + 1)} style={[styles.button, { backgroundColor: colors.button }]}>
              <Text style={[styles.buttonLabel, { color: colors.buttonText }]}>{en.retry}</Text>
            </Pressable>}
            {busy && !saving && <Pressable accessibilityRole="button" onPress={() => { stopped.current = true; cancelDirectoryScan(); setMessage(en.cancelled); }} style={[styles.button, { backgroundColor: colors.button }]}>
              <Text style={[styles.buttonLabel, { color: colors.buttonText }]}>{en.cancel}</Text>
            </Pressable>}
            {preview && <Text style={[styles.body, { color: colors.muted }]}>{en.savedNote}</Text>}
            {preview && <InventoryReport preview={preview} color={colors.text} />}
            <Text style={[styles.body, { color: colors.muted }]}>{en.prototype}</Text>
          </View>
        </ScrollView>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}
const styles = StyleSheet.create({
  root: { flex: 1 }, content: { padding: 24, gap: 8, width: '100%', maxWidth: 640, alignSelf: 'center' },
  title: { fontSize: 28, fontWeight: '600' }, heading: { fontSize: 22, fontWeight: '600' },
  body: { fontSize: 16, lineHeight: 24 }, section: { marginTop: 48, gap: 20 },
  button: { minHeight: 48, padding: 16, borderRadius: 10, alignItems: 'center' },
  buttonLabel: { fontSize: 16, fontWeight: '600' },
});
