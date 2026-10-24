import { useEffect, useReducer, useState } from 'react';
import { Modal, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import type { ImportStore } from '../storage/importStore';
import { DETAIL_SECTIONS, readMemoryDetails } from '../storage/memoryDetails';
import { MemoryDetails } from '../domain/memoryDetails';
import { detailFields } from '../domain/detailLabels';
import { en } from '../i18n/en';
import { Button, Notice } from './kit';
import { space, type, useTheme } from './theme';

/** Mounted only while open, on the keyed viewer. Closing invalidates reads and discards paging state. */
export function MemoryDetailsScreen({ id, store, close }: { id: string; store: ImportStore; close(): void }) {
  const t = useTheme();
  const [model] = useState(() => new MemoryDetails((section, anchor, direction) => readMemoryDetails(store.database, id, section, anchor, direction)));
  const [, render] = useReducer((n: number) => n + 1, 0);
  useEffect(() => { const unsubscribe = model.subscribe(render); void model.open(); return () => { unsubscribe(); model.close(); }; }, [model]);
  return <Modal visible animationType="none" onRequestClose={close}>
    <SafeAreaView style={[styles.root, { backgroundColor: t.ground }]}>
      <StatusBar style={t.dark ? 'light' : 'dark'} />
      <View style={styles.bar}>
        <Text accessibilityRole="header" style={[type.title, { color: t.text }]}>{en.detailsTitle}</Text>
        <Button label={en.detailsDone} variant="secondary" onPress={close} />
      </View>
      <ScrollView key={`${model.section}:${model.rows[0]?.key1 ?? ''}:${model.rows[0]?.key2 ?? ''}:${model.loading}`} contentContainerStyle={styles.content}>
        <Text style={[type.footnote, { color: t.secondary }]}>{en.detailsMemoryId}</Text>
        <Text selectable style={[type.body, { color: t.text }]}>{id}</Text>
        <Text style={[type.footnote, { color: t.secondary }]}>{en.detailsNote}</Text>
        <View style={styles.sections}>
          {DETAIL_SECTIONS.map(section => <Button key={section} label={section === model.section ? en.detailsSelected(en.detailsSections[section]) : en.detailsSections[section]}
            variant={section === model.section ? 'primary' : 'secondary'} onPress={() => void model.select(section)} />)}
        </View>
        <Text accessibilityRole="header" style={[type.headline, { color: t.text }]}>{en.detailsSections[model.section]}</Text>
        {model.section !== 'originals' && <Text style={[type.footnote, { color: t.secondary }]}>{model.section === 'dates' ? en.detailsDateNote : en.detailsSourceNote}</Text>}
        {model.loading ? <Notice tone="progress" message={en.detailsLoading} /> : model.failed
          ? <Notice tone="warning" message={en.detailsFailed} action={{ label: en.retry, onPress: () => void model.load() }} />
          : !model.rows.length ? <Text style={[type.body, { color: t.secondary }]}>{en.detailsEmpty}</Text>
          : model.rows.map(row => <View key={JSON.stringify([row.key1, row.key2])} style={[styles.record, { backgroundColor: t.raised }]}>
            {detailFields(row).map((field, i) => <View key={i} style={styles.field}>
              <Text style={[type.caption, { color: t.secondary }]}>{field.label}</Text>
              <Text selectable style={[type.body, { color: t.text }]}>{field.value}</Text>
            </View>)}
          </View>)}
        {!model.loading && !model.failed && (model.hasPrevious || model.hasNext) && <View style={styles.pages}>
          <Button label={en.detailsPrevious} variant="secondary" disabled={!model.hasPrevious} onPress={() => void model.move('previous')} />
          <Button label={en.detailsNext} variant="secondary" disabled={!model.hasNext} onPress={() => void model.move('next')} />
        </View>}
      </ScrollView>
    </SafeAreaView>
  </Modal>;
}
const styles = StyleSheet.create({
  root: { flex: 1 },
  bar: { padding: space.gutter, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  content: { padding: space.gutter, gap: 12, maxWidth: 680, width: '100%', alignSelf: 'center', paddingBottom: 48 },
  sections: { gap: 8 }, pages: { gap: 8 }, record: { borderRadius: 16, padding: 16, gap: 12 }, field: { gap: 4 },
});
