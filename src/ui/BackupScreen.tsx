import { useEffect, useRef, useState } from 'react';
import { BackHandler, Pressable, ScrollView, StyleSheet, Text, useColorScheme } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaView } from 'react-native-safe-area-context';
import { cancelBackup, saveLibraryBackup } from '../platform/backup';
import type { BackupStage } from '../backup/runBackup';
const stages: Record<BackupStage, string> = {
  snapshot: 'Preparing library records…', choose: 'Choose where to save the backup.',
  save: 'Checking originals, writing the backup and checking the saved file…',
};
export function BackupScreen({ onClose }: { onClose(): void }) {
  const dark = useColorScheme() === 'dark';
  const colors = { background: dark ? '#151817' : '#f8f9f5', text: dark ? '#f3f4ef' : '#17261d', button: dark ? '#b9dec8' : '#244f37', label: dark ? '#162d20' : '#ffffff' };
  const [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  const running = useRef(false), stopped = useRef(false), mounted = useRef(true);
  const cancel = () => { if (running.current) { stopped.current = true; cancelBackup(); setMessage('Cancelling…'); } };
  useEffect(() => {
    mounted.current = true;
    const back = BackHandler.addEventListener('hardwareBackPress', () => {
      if (running.current) { stopped.current = true; cancelBackup(); setMessage('Cancelling…'); } else onClose();
      return true;
    });
    return () => { back.remove(); mounted.current = false; if (running.current) { stopped.current = true; cancelBackup(); } };
  }, [onClose]);
  async function save() {
    if (running.current) return;
    running.current = true; stopped.current = false; setBusy(true); setMessage(stages.snapshot);
    try {
      const result = await saveLibraryBackup(() => stopped.current, stage => { if (mounted.current) setMessage(stages[stage]); });
      if (mounted.current) setMessage(result === 'saved' ? 'Backup saved and checked. Restore is not available yet; keep your original exports.' : 'Backup cancelled.');
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      if (mounted.current) setMessage(code === 'backup-partial-remains' ? 'Saving did not finish. An incomplete file remains at the chosen location. Delete it before trying again.'
        : code === 'backup-unverified' ? 'The backup was written, but the chosen location could not hand it back for checking (some cloud services are still uploading). It was kept, but it has not been checked. Do not rely on it as your only copy.'
        : code === 'backup-saved-cleanup-failed' ? 'Backup saved and checked, but temporary files could not be cleared. Reopen the app before another backup.'
        : code === 'backup-cleanup-failed' ? 'Temporary backup files could not be cleared. Reopen the app before trying again.'
        : code === 'cancelled' ? 'Backup cancelled.'
        : code === 'stored-object-corrupt' ? 'An original is missing or damaged. No backup was saved.'
        : code === 'insufficient-storage' ? 'Not enough space to create the backup. Free some space and try again.'
        : code === 'backup-schema-unsupported' ? 'This version of the app cannot back up this library yet. Update the app and try again.'
        : code === 'native-build-required' ? 'Install the latest Android development build to save backups.'
        : 'Backup could not be saved and checked. Your library has not changed. Please try again.');
    } finally { running.current = false; if (mounted.current) setBusy(false); }
  }
  return <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }}>
    <StatusBar style={dark ? 'light' : 'dark'} />
    <ScrollView contentContainerStyle={styles.content}>
      <Text accessibilityRole="header" style={[styles.title, { color: colors.text }]}>Back up your library</Text>
      <Text style={[styles.text, { color: colors.text }]}>This ZIP is unencrypted. It contains private photos, videos, overlays and metadata, including any saved locations. Choose a location you trust.</Text>
      <Text style={[styles.text, { color: colors.text }]}>Keep the app open while it works. The backup is written directly to the location you choose, which needs room for a copy of your library. Only files already preserved in Snarchive are included; pending files remain pending.</Text>
      <Text style={[styles.text, { color: colors.text }]}>If the app is force-stopped while saving, an incomplete ZIP may remain at the destination. Delete that file before retrying. Restore is not available in this development build.</Text>
      <Text accessibilityLiveRegion="polite" style={[styles.text, { color: colors.text }]}>{message}</Text>
      <Pressable accessibilityRole="button" disabled={busy} accessibilityState={{ disabled: busy }} onPress={() => void save()} style={[styles.button, { backgroundColor: colors.button, opacity: busy ? 0.5 : 1 }]}><Text style={{ color: colors.label }}>Create and save backup</Text></Pressable>
      {busy ? <Pressable accessibilityRole="button" onPress={cancel} style={[styles.button, { backgroundColor: colors.button }]}><Text style={{ color: colors.label }}>Cancel backup</Text></Pressable>
        : <Pressable accessibilityRole="button" onPress={onClose} style={[styles.button, { backgroundColor: colors.button }]}><Text style={{ color: colors.label }}>Back</Text></Pressable>}
    </ScrollView>
  </SafeAreaView>;
}
const styles = StyleSheet.create({ content: { padding: 24, gap: 20, maxWidth: 640, width: '100%', alignSelf: 'center' }, title: { fontSize: 24, fontWeight: '600' }, text: { fontSize: 16, lineHeight: 24 }, button: { minHeight: 48, padding: 16, borderRadius: 10, alignItems: 'center' } });
