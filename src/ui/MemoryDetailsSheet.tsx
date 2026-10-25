import { useEffect, useReducer, useRef, useState, type ComponentRef } from 'react';
import { AccessibilityInfo, Animated, BackHandler, PanResponder, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import type { ImportStore } from '../storage/importStore';
import { DETAIL_SECTIONS, readMemoryDetails } from '../storage/memoryDetails';
import { MemoryDetails } from '../domain/memoryDetails';
import { detailFields } from '../domain/detailLabels';
import { en } from '../i18n/en';
import { Button, Notice } from './kit';
import { space, type, useTheme } from './theme';

/** A drag down closes the sheet when it travels `distance` px, or is flicked (`flickVelocity` px/ms over `flickDistance`). */
const CLOSE = { distance: 96, flickDistance: 24, flickVelocity: 0.5 };
const DRAG = 6; // px of mostly vertical movement before the sheet takes a drag from its content.

/** Memory details as a sheet over the viewer, drawn `offset` px below its open position. The viewer owns the offset
 * (see DetailsSheet), so the sheet follows a swipe up on the media before it opens (`open` once it has). Here a drag
 * down is reported (`drag`, then `release`), and the viewer moves, closes or restores the sheet; a close already under
 * way (Back, Done) ignores the rest of that drag. Mounted only while shown: closing invalidates reads and paging state.
 *
 * Android's scroll view claims every vertical drag on it, even at its top. So while the content is at its top, native
 * scrolling is off and this sheet takes the drag: down moves the sheet, up scrolls the content by hand. Once scrolled,
 * the content scrolls natively until it is back at the top. A drag on the header always moves the sheet. With a screen
 * reader on, the content always scrolls natively; Done and Back close the sheet. */
export function MemoryDetailsSheet({ id, store, offset, open, close, drag: dragTo, release }: {
  id: string; store: ImportStore; offset: Animated.Value; open: boolean; close(): void; drag(dy: number): void; release(leave: boolean): void;
}) {
  const t = useTheme(), insets = useSafeAreaInsets();
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);
  const [atTop, setAtTop] = useState(true), [screenReader, setScreenReader] = useState(false);
  const state = useRef({ y: 0, top: true, header: 0, screenReader: false, mode: null as 'sheet' | 'scroll' | null, start: 0 });
  const latest = useRef({ close, dragTo, release }); latest.current = { close, dragTo, release };
  state.current.screenReader = screenReader;
  useEffect(() => {
    let active = true;
    void AccessibilityInfo.isScreenReaderEnabled().then(value => { if (active) setScreenReader(value); }, () => {});
    const subscription = AccessibilityInfo.addEventListener('screenReaderChanged', setScreenReader);
    return () => { active = false; subscription.remove(); };
  }, []);
  // Registered after the app's handler, so Back closes the sheet before it reaches the library.
  useEffect(() => { const subscription = BackHandler.addEventListener('hardwareBackPress', () => { latest.current.close(); return true; }); return () => subscription.remove(); }, []);
  const scrolled = (y: number) => {
    state.current.y = y;
    const top = y <= 0.5;
    if (top !== state.current.top) { state.current.top = top; setAtTop(top); }
  };
  const drag = useRef(PanResponder.create({
    onMoveShouldSetPanResponderCapture: (_event, gesture) => {
      const s = state.current;
      if (!(Math.abs(gesture.dy) > DRAG && Math.abs(gesture.dy) > Math.abs(gesture.dx) * 1.5)) return false;
      // y0 is only set once a responder is granted; before that, the start is the latest point less the travel.
      const header = gesture.moveY - gesture.dy < s.header;
      if (gesture.dy > 0 && (header || (s.top && !s.screenReader))) { s.mode = 'sheet'; return true; }
      if (gesture.dy < 0 && !header && s.top && !s.screenReader) { s.mode = 'scroll'; s.start = s.y; return true; }
      return false;
    },
    onPanResponderTerminationRequest: () => false,
    onPanResponderMove: (_event, gesture) => {
      const s = state.current;
      if (s.mode === 'sheet') latest.current.dragTo(gesture.dy);
      else if (s.mode === 'scroll') scroll.current?.scrollTo({ y: Math.max(0, s.start - gesture.dy), animated: false });
    },
    onPanResponderRelease: (_event, gesture) => {
      const s = state.current, mode = s.mode;
      s.mode = null;
      if (mode === 'sheet') {
        latest.current.release(gesture.dy >= CLOSE.distance || (gesture.dy >= CLOSE.flickDistance && gesture.vy >= CLOSE.flickVelocity));
      } else if (mode === 'scroll') scroll.current?.scrollTo({ y: Math.max(0, s.start - gesture.dy - gesture.vy * 250), animated: true });
    },
    onPanResponderTerminate: () => { if (state.current.mode === 'sheet') latest.current.release(false); state.current.mode = null; },
  })).current;
  const [model] = useState(() => new MemoryDetails((section, anchor, direction) => readMemoryDetails(store.database, id, section, anchor, direction)));
  const [, render] = useReducer((n: number) => n + 1, 0);
  useEffect(() => { const unsubscribe = model.subscribe(render); void model.open(); return () => { unsubscribe(); model.close(); }; }, [model]);
  // The content is keyed by section and page, so a new one starts at its top.
  useEffect(() => { scrolled(0); }, [model.section, model.rows, model.loading]);
  return <Animated.View accessibilityViewIsModal onAccessibilityEscape={close} {...drag.panHandlers}
    style={[styles.sheet, { backgroundColor: t.ground, transform: [{ translateY: offset }] }]}>
    {open && <StatusBar style={t.dark ? 'light' : 'dark'} hidden={false} />}
    <View onLayout={event => { state.current.header = event.nativeEvent.layout.height; }} style={{ paddingTop: insets.top, paddingLeft: insets.left, paddingRight: insets.right }}>
      <View style={[styles.handle, { backgroundColor: t.separator }]} />
      <View style={styles.bar}>
        <Text accessibilityRole="header" style={[type.title, { color: t.text }]}>{en.detailsTitle}</Text>
        <Button label={en.detailsDone} variant="secondary" onPress={close} />
      </View>
    </View>
    <ScrollView ref={scroll} scrollEnabled={screenReader || !atTop} onScroll={event => scrolled(event.nativeEvent.contentOffset.y)} scrollEventThrottle={16}
      key={`${model.section}:${model.rows[0]?.key1 ?? ''}:${model.rows[0]?.key2 ?? ''}:${model.loading}`}
      contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 48, paddingLeft: insets.left + space.gutter, paddingRight: insets.right + space.gutter }]}>
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
  </Animated.View>;
}
const styles = StyleSheet.create({
  sheet: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, borderTopLeftRadius: 16, borderTopRightRadius: 16, overflow: 'hidden' },
  handle: { width: 36, height: 4, borderRadius: 2, marginTop: 8, alignSelf: 'center' },
  bar: { padding: space.gutter, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  content: { paddingTop: space.gutter, gap: 12, maxWidth: 680, width: '100%', alignSelf: 'center' },
  sections: { gap: 8 }, pages: { gap: 8 }, record: { borderRadius: 16, padding: 16, gap: 12 }, field: { gap: 4 },
});
