import { useEffect, useRef, useState } from 'react';
import { BackHandler, ScrollView, StyleSheet, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaView } from 'react-native-safe-area-context';
import { cancelBackup, saveLibraryBackup } from '../platform/backup';
import { en } from '../i18n/en';
import { BackButton, Button, Group, LargeTitle, Notice, Row, type Tone } from './kit';
import { space, useTheme } from './theme';

type Status = { tone: Tone; title?: string; message: string };

export function BackupScreen({ onClose }: { onClose(): void }) {
  const t = useTheme();
  const [busy, setBusy] = useState(false), [status, setStatus] = useState<Status | null>(null);
  const running = useRef(false), stopped = useRef(false), mounted = useRef(true);
  const cancel = () => { if (running.current) { stopped.current = true; cancelBackup(); setStatus({ tone: 'progress', message: en.backupCancelling }); } };
  useEffect(() => {
    mounted.current = true;
    const back = BackHandler.addEventListener('hardwareBackPress', () => {
      if (running.current) cancel(); else onClose();
      return true;
    });
    return () => { back.remove(); mounted.current = false; if (running.current) { stopped.current = true; cancelBackup(); } };
  }, [onClose]);
  async function save() {
    if (running.current) return;
    running.current = true; stopped.current = false; setBusy(true); setStatus({ tone: 'progress', message: en.backupStage.snapshot });
    try {
      const result = await saveLibraryBackup(() => stopped.current, stage => { if (mounted.current) setStatus({ tone: 'progress', message: en.backupStage[stage] }); });
      if (mounted.current) setStatus(result === 'saved' ? { tone: 'success', title: en.backupSaved, message: en.backupSavedDetail } : { tone: 'info', message: en.backupCancelled });
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      if (!mounted.current) return;
      if (code === 'cancelled') setStatus({ tone: 'info', message: en.backupCancelled });
      // Saved and checked, but staging cleanup failed: the backup itself is good.
      else if (code === 'backup-saved-cleanup-failed') setStatus({ tone: 'warning', title: en.backupSaved, message: en.backupErrors[code]! });
      else setStatus({ tone: code === 'backup-unverified' || code === 'backup-partial-remains' ? 'warning' : 'error', message: en.backupErrors[code] ?? en.backupFailed });
    } finally { running.current = false; if (mounted.current) setBusy(false); }
  }
  return <SafeAreaView style={[styles.root, { backgroundColor: t.ground }]}>
    <StatusBar style={t.dark ? 'light' : 'dark'} />
    <View style={styles.topBar}><BackButton label={en.title} onPress={() => { if (running.current) cancel(); else onClose(); }} /></View>
    <ScrollView contentContainerStyle={styles.content}>
      <LargeTitle title={en.backupTitle} subtitle={en.backupSubtitle} />
      <Group footer={en.backupFooter} inset={52}>
        <Row icon="lock-open-outline" title={en.backupUnencrypted} detail={en.backupUnencryptedDetail} tone="warning" />
        <Row icon="folder-outline" title={en.backupDirect} detail={en.backupDirectDetail} />
        <Row icon="time-outline" title={en.backupOpenApp} detail={en.backupOpenAppDetail} />
      </Group>
      {status && <Notice tone={status.tone} title={status.title} message={status.message} />}
    </ScrollView>
    <View style={[styles.actions, { backgroundColor: t.ground }]}>
      {busy ? <Button variant="secondary" label={en.backupCancel} onPress={cancel} />
        : <Button icon="archive-outline" label={en.backupStart} onPress={() => void save()} />}
    </View>
  </SafeAreaView>;
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  topBar: { minHeight: 52, justifyContent: 'center', paddingHorizontal: space.gutter - 4 },
  content: { paddingHorizontal: space.gutter, paddingBottom: 24, gap: space.section, width: '100%', maxWidth: 640, alignSelf: 'center' },
  actions: { paddingHorizontal: space.gutter, paddingTop: 12, paddingBottom: 16, width: '100%', maxWidth: 640, alignSelf: 'center' },
});
