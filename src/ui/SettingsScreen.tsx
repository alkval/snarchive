import { useRef, useState } from 'react';
import { Alert, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { BackButton, Button, Group, LargeTitle, Notice, Row } from './kit';
import { space, useTheme } from './theme';
export type SettingsAction = 'appearance' | 'backup' | 'restore' | 'check' | 'storage';
export function SettingsScreen({ close, open, warning, reset, resetting = false }: {
  close(): void; open(action: SettingsAction): void; warning?: string; reset(): Promise<void>; resetting?: boolean;
}) {
  const t = useTheme(); const [advanced, setAdvanced] = useState(false);
  const [failure, setFailure] = useState('');
  const confirming = useRef(false);
  const confirmReset = () => {
    if (resetting || confirming.current) return;
    confirming.current = true;
    Alert.alert('Delete all Snarchive media?', 'This permanently clears every memory, favourite, import record and deleted-memory marker, plus Snarchive’s private originals, overlays, previews and kept damaged copies. You can then import your exports again. Your original ZIPs, extracted folders and saved backup files stay unchanged.', [
      { text: 'Cancel', style: 'cancel', onPress: () => { confirming.current = false; } },
      { text: 'Delete all', style: 'destructive', onPress: () => {
        confirming.current = false; setFailure('');
        void reset().catch(error => setFailure(error instanceof Error && ['busy', 'storage-busy'].includes(error.message)
          ? 'Another file operation is running. Try again when it finishes.' : 'The library could not be cleared. Its files were not removed. Try again.'));
      } },
    ], { cancelable: true, onDismiss: () => { confirming.current = false; } });
  };
  return <SafeAreaView style={[styles.root, { backgroundColor: t.ground }]}>
    <View style={styles.bar}><BackButton label="Library" onPress={() => { if (!resetting) close(); }} /></View>
    <ScrollView pointerEvents={resetting ? 'none' : 'auto'} contentContainerStyle={styles.content}>
      <LargeTitle title="Settings" />
      <Group><Row icon="color-palette-outline" title="Appearance" detail="Use your phone's theme, light or dark" onPress={() => open('appearance')} /></Group>
      <Group header="Backups" footer="A backup is a separate copy you keep somewhere safe. It can restore your memories if you lose the app or phone.">
        <Row icon="archive-outline" title="Save a backup" detail="Copy your library to a ZIP file" onPress={() => open('backup')} />
        <Row icon="download-outline" title="Restore a backup" detail="Bring back memories from a Snarchive backup" onPress={() => open('restore')} />
      </Group>
      <Group header="Start over" footer="Clear this app’s library so you can re-import your exports. Appearance and your files outside Snarchive are kept.">
        <Button label={resetting ? 'Clearing library…' : 'Delete all Snarchive media'} icon="trash-outline" variant="destructive" disabled={resetting} onPress={confirmReset} />
      </Group>
      {!!failure && <Notice tone="error" message={failure} />}
      <Group footer={warning}>
        <Row icon="construct-outline" title="Troubleshooting" detail="File checks and unused storage" onPress={() => setAdvanced(value => !value)} />
        {advanced && <Row icon="pulse-outline" title="Check saved files" detail="Find missing or damaged files when a memory will not open" onPress={() => open('check')} />}
        {advanced && <Row icon="server-outline" title="Free up unused space" detail="Review leftover files and old damaged copies" onPress={() => open('storage')} />}
      </Group>
    </ScrollView>
  </SafeAreaView>;
}
const styles = StyleSheet.create({ root: { flex: 1 }, bar: { minHeight: 52, paddingHorizontal: space.gutter }, content: { padding: space.gutter, gap: 28, paddingBottom: 48, maxWidth: 640, width: '100%', alignSelf: 'center' } });
