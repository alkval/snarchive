import { useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { BackButton, Group, LargeTitle, Row } from './kit';
import { space, useTheme } from './theme';
export type SettingsAction = 'appearance' | 'backup' | 'restore' | 'check' | 'storage';
export function SettingsScreen({ close, open, warning }: { close(): void; open(action: SettingsAction): void; warning?: string }) {
  const t = useTheme(); const [advanced, setAdvanced] = useState(false);
  return <SafeAreaView style={[styles.root, { backgroundColor: t.ground }]}>
    <View style={styles.bar}><BackButton label="Library" onPress={close} /></View>
    <ScrollView contentContainerStyle={styles.content}>
      <LargeTitle title="Settings" />
      <Group><Row icon="color-palette-outline" title="Appearance" detail="Use your phone's theme, light or dark" onPress={() => open('appearance')} /></Group>
      <Group header="Backups" footer="A backup is a separate copy you keep somewhere safe. It can restore your memories if you lose the app or phone.">
        <Row icon="archive-outline" title="Save a backup" detail="Copy your library to a ZIP file" onPress={() => open('backup')} />
        <Row icon="download-outline" title="Restore a backup" detail="Bring back memories from a Snarchive backup" onPress={() => open('restore')} />
      </Group>
      <Group footer={warning}>
        <Row icon="construct-outline" title="Troubleshooting" detail="File checks and unused storage" onPress={() => setAdvanced(value => !value)} />
        {advanced && <Row icon="pulse-outline" title="Check saved files" detail="Find missing or damaged files when a memory will not open" onPress={() => open('check')} />}
        {advanced && <Row icon="server-outline" title="Free up unused space" detail="Review leftover files and old damaged copies" onPress={() => open('storage')} />}
      </Group>
    </ScrollView>
  </SafeAreaView>;
}
const styles = StyleSheet.create({ root: { flex: 1 }, bar: { minHeight: 52, paddingHorizontal: space.gutter }, content: { padding: space.gutter, gap: 28, paddingBottom: 48, maxWidth: 640, width: '100%', alignSelf: 'center' } });
