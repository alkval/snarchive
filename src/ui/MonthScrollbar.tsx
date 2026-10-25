import { useMemo, useRef, useState, type ComponentRef } from 'react';
import { PanResponder, StyleSheet, Text, View } from 'react-native';
import { monthAtFraction, monthFraction, monthTitle, type MonthBucket } from '../domain/monthScroll';
import { type, useTheme } from './theme';

const HANDLE = 44;
/** Drag previews dates locally. Release performs a single paginated jump, rather than querying on every move. */
export function MonthScrollbar({ months, month, select }: { months: readonly MonthBucket[]; month: string; select(month: string): void }) {
  const t = useTheme();
  const track = useRef<ComponentRef<typeof View>>(null), top = useRef(0), height = useRef(1);
  const [trackHeight, setTrackHeight] = useState(1);
  const lastY = useRef(0);
  const [drag, setDrag] = useState<{ month: string; fraction: number } | null>(null);
  const latest = useRef({ months, select }); latest.current = { months, select };
  const gesture = useRef<{ month: string; fraction: number } | null>(null);
  const move = (pageY: number) => {
    lastY.current = pageY;
    const fraction = Math.max(0, Math.min(1, (pageY - top.current - HANDLE / 2) / Math.max(1, height.current - HANDLE)));
    const index = monthAtFraction(latest.current.months, fraction);
    if (index < 0) return;
    gesture.current = { month: latest.current.months[index]!.month, fraction }; setDrag(gesture.current);
  };
  const responder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderTerminationRequest: () => false,
    onPanResponderGrant: event => {
      const y = event.nativeEvent.pageY;
      move(y);
      track.current?.measureInWindow((_x, measuredTop) => { top.current = measuredTop; if (gesture.current) move(lastY.current); });
    },
    onPanResponderMove: (_event, state) => move(state.moveY),
    onPanResponderRelease: () => { const selected = gesture.current; gesture.current = null; setDrag(null); if (selected) latest.current.select(selected.month); },
    onPanResponderTerminate: () => { gesture.current = null; setDrag(null); },
  }), []);
  const fraction = drag?.fraction ?? monthFraction(months, month);
  const index = Math.max(0, months.findIndex(item => item.month === month));
  return <View ref={track} collapsable={false} {...responder.panHandlers} style={styles.track}
    onLayout={event => { height.current = event.nativeEvent.layout.height; setTrackHeight(height.current); track.current?.measureInWindow((_x, y) => { top.current = y; }); }}
    accessible accessibilityRole="adjustable" accessibilityLabel="Scroll by month and year"
    accessibilityHint="Drag up or down, then release to jump. Increase for older months; decrease for newer months."
    accessibilityValue={{ min: 0, max: Math.max(0, months.length - 1), now: index, text: monthTitle(month) }}
    accessibilityActions={[{ name: 'increment', label: 'Older month' }, { name: 'decrement', label: 'Newer month' }]}
    onAccessibilityAction={event => {
      const action = event.nativeEvent.actionName;
      if (action !== 'increment' && action !== 'decrement') return;
      const target = Math.min(months.length - 1, Math.max(0, index + (action === 'increment' ? 1 : -1)));
      if (months[target]) select(months[target]!.month);
    }}>
    <View pointerEvents="none" style={[styles.rail, { backgroundColor: t.secondary, opacity: drag ? 0.35 : 0.16 }]} />
    <View pointerEvents="none" style={[styles.handle, { top: fraction * Math.max(0, trackHeight - HANDLE), backgroundColor: drag ? t.accent : t.secondary }]} />
    {drag && <View pointerEvents="none" style={[styles.bubble, { top: fraction * Math.max(0, trackHeight - HANDLE), backgroundColor: t.text }]}>
      <Text style={[type.headline, { color: t.ground }]}>{monthTitle(drag.month)}</Text>
    </View>}
  </View>;
}
const styles = StyleSheet.create({
  track: { position: 'absolute', right: 0, top: 20, bottom: 36, width: 32 },
  rail: { position: 'absolute', right: 7, top: 0, bottom: 0, width: 2, borderRadius: 1 },
  handle: { position: 'absolute', right: 2, width: 12, height: HANDLE, borderRadius: 6 },
  bubble: { position: 'absolute', right: 28, minHeight: HANDLE, borderRadius: 16, paddingHorizontal: 16, alignItems: 'center', justifyContent: 'center' },
});
