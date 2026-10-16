import { useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, useColorScheme, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { en } from './src/i18n/en';
import { sourcePicker, type SourceSelection } from './src/platform/sourcePicker';

export default function App() {
  const dark = useColorScheme() === 'dark';
  const colors = dark ? { background: '#151817', text: '#f3f4ef', muted: '#b9c2bc', button: '#b9dec8', buttonText: '#162d20' }
    : { background: '#f8f9f5', text: '#17261d', muted: '#506056', button: '#244f37', buttonText: '#ffffff' };
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(en.empty);
  const selection = useRef<SourceSelection[]>([]);
  const picking = useRef(false);
  async function pick(kind: 'zip' | 'directory') {
    if (picking.current) return;
    picking.current = true;
    setBusy(true);
    try {
      const sources = kind === 'zip' ? await sourcePicker.selectArchives() : [await sourcePicker.selectDirectory()];
      if (sources.length > 0) {
        selection.current = sources;
        setMessage(en.selected(sources.length));
      }
    } catch {
      // Native errors can contain personal paths. Do not log or display their payloads.
      setMessage(en.pickerClosed);
    } finally {
      picking.current = false;
      setBusy(false);
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
            {(['zip', 'directory'] as const).map((kind) => (
              <Pressable key={kind} accessibilityRole="button" accessibilityState={{ disabled: busy }} disabled={busy}
                onPress={() => void pick(kind)} style={({ pressed }) => [styles.button, { backgroundColor: colors.button, opacity: pressed || busy ? 0.6 : 1 }]}>
                <Text style={[styles.buttonLabel, { color: colors.buttonText }]}>{kind === 'zip' ? en.zip : en.folder}</Text>
              </Pressable>
            ))}
            <Text accessibilityLiveRegion="polite" style={[styles.body, { color: colors.text }]}>{busy ? en.busy : message}</Text>
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
