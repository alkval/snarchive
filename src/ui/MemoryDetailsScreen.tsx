import { useEffect, useReducer, useRef, useState } from 'react';
import { Animated, Dimensions, Modal, PanResponder, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import type { ImportStore } from '../storage/importStore';
import { DETAIL_SECTIONS, readMemoryDetails } from '../storage/memoryDetails';
import { MemoryDetails } from '../domain/memoryDetails';
import { detailFields } from '../domain/detailLabels';
import { en } from '../i18n/en';
import { Button, Notice } from './kit';
import { space, type, useReducedMotion, useTheme } from './theme';

/** Mounted only while open, on the keyed viewer. Closing invalidates reads and discards paging state. */
export function MemoryDetailsScreen({ id, store, close }: { id: string; store: ImportStore; close(): void }) {
  const t = useTheme(), reduced = useReducedMotion();
  const scrollY = useRef(0), offset = useRef(new Animated.Value(0)).current, latestClose = useRef(close);
  latestClose.current = close;
  const reducedNow = useRef(reduced); reducedNow.current = reduced;
  useEffect(() => () => offset.stopAnimation(), [offset]);
  const dismiss = useRef(PanResponder.create({
    onMoveShouldSetPanResponderCapture: (_event, state) => scrollY.current <= 0 && state.dy > 18 && state.dy > Math.abs(state.dx) * 1.5,
    onPanResponderMove: (_event, state) => offset.setValue(Math.max(0, state.dy)),
    onPanResponderRelease: (_event, state) => {
      const leave = state.dy > 72 || (state.dy > 24 && state.vy > 0.7);
      Animated.timing(offset, { toValue: leave ? Dimensions.get('window').height : 0, duration: reducedNow.current ? 0 : 160, useNativeDriver: true })
        .start(({ finished }) => { if (finished && leave) latestClose.current(); });
    },
    onPanResponderTerminate: () => Animated.timing(offset, { toValue: 0, duration: 100, useNativeDriver: true }).start(),
  })).current;
  const [model] = useState(() => new MemoryDetails((section, anchor, direction) => readMemoryDetails(store.database, id, section, anchor, direction)));
  const [, render] = useReducer((n: number) => n + 1, 0);
  useEffect(() => { const unsubscribe = model.subscribe(render); void model.open(); return () => { unsubscribe(); model.close(); }; }, [model]);
  useEffect(() => { scrollY.current = 0; }, [model.section, model.rows, model.loading]);
  return <Modal visible animationType={reduced ? 'none' : 'slide'} onRequestClose={close}>
    <Animated.View style={[styles.root, { transform: [{ translateY: offset }] }]} {...dismiss.panHandlers}>
    <SafeAreaView style={[styles.root, { backgroundColor: t.ground }]}>
      <StatusBar style={t.dark ? 'light' : 'dark'} />
      <View style={[styles.handle, { backgroundColor: t.separator }]} />
      <View style={styles.bar}>
        <Text accessibilityRole="header" style={[type.title, { color: t.text }]}>{en.detailsTitle}</Text>
        <Button label={en.detailsDone} variant="secondary" onPress={close} />
      </View>
      <ScrollView onScroll={event => { scrollY.current = event.nativeEvent.contentOffset.y; }} scrollEventThrottle={16} key={`${model.section}:${model.rows[0]?.key1 ?? ''}:${model.rows[0]?.key2 ?? ''}:${model.loading}`} contentContainerStyle={styles.content}>
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
    </Animated.View>
  </Modal>;
}
const styles = StyleSheet.create({
  root: { flex: 1 }, handle: { width: 36, height: 4, borderRadius: 2, marginTop: 8, alignSelf: 'center' },
  bar: { padding: space.gutter, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  content: { padding: space.gutter, gap: 12, maxWidth: 680, width: '100%', alignSelf: 'center', paddingBottom: 48 },
  sections: { gap: 8 }, pages: { gap: 8 }, record: { borderRadius: 16, padding: 16, gap: 12 }, field: { gap: 4 },
});
