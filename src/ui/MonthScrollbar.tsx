import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { PanResponder, StyleSheet, Text, View } from 'react-native';
import { monthDragStarts, monthTitle } from '../domain/monthScroll';
import { draggedTimelineFraction, type TimelinePosition } from '../domain/timelineLayout';
import { type, useTheme } from './theme';

const HANDLE = 44;
export function MonthScrollbar({ position, marks, seek }: {
  position: TimelinePosition; marks: readonly { month: string; fraction: number }[]; seek(fraction: number): void;
}) {
  const t = useTheme(), [, render] = useReducer(n => n + 1, 0);
  useEffect(() => position.subscribe(render), [position]);
  const height = useRef(1);
  const [trackHeight, setTrackHeight] = useState(1), [drag, setDrag] = useState<number | null>(null);
  const latest = useRef({ position, seek }); latest.current = { position, seek };
  const gesture = useRef<{ x: number; y: number; start: number; active: boolean } | null>(null);
  const responder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: event => {
      const handleTop = latest.current.position.fraction * Math.max(0, height.current - HANDLE);
      return event.nativeEvent.locationY >= handleTop && event.nativeEvent.locationY <= handleTop + HANDLE;
    },
    onMoveShouldSetPanResponder: (_event, state) => monthDragStarts(state.dx, state.dy),
    onPanResponderTerminationRequest: () => false,
    onPanResponderGrant: event => {
      gesture.current = { x: event.nativeEvent.pageX, y: event.nativeEvent.pageY, start: latest.current.position.fraction, active: false };
    },
    onPanResponderMove: event => {
      const active = gesture.current; if (!active) return;
      const dy = event.nativeEvent.pageY - active.y;
      if (!active.active && !monthDragStarts(event.nativeEvent.pageX - active.x, dy)) return;
      active.active = true;
      const fraction = draggedTimelineFraction(active.start, dy, height.current);
      setDrag(fraction); latest.current.seek(fraction);
    },
    onPanResponderRelease: () => { gesture.current = null; setDrag(null); },
    onPanResponderTerminate: () => { gesture.current = null; setDrag(null); },
  }), []);
  const fraction = drag ?? position.fraction;
  const month = position.month;
  return <View collapsable={false} {...responder.panHandlers} style={styles.track}
    onLayout={event => { height.current = event.nativeEvent.layout.height; setTrackHeight(height.current); }}
    accessible accessibilityRole="adjustable" accessibilityLabel="Scroll through your library"
    accessibilityHint="Drag to move quickly through the same timeline. Increase for older months; decrease for newer months."
    accessibilityValue={{ min: 0, max: 100, now: Math.round(fraction * 100), text: monthTitle(month) }}
    accessibilityActions={[{ name: 'increment', label: 'Older month' }, { name: 'decrement', label: 'Newer month' }]}
    onAccessibilityAction={event => {
      const action = event.nativeEvent.actionName;
      const target = action === 'increment' ? marks.find(mark => mark.fraction > position.fraction + .000001)
        : action === 'decrement' ? [...marks].reverse().find(mark => mark.fraction < position.fraction - .000001) : undefined;
      if (target) seek(target.fraction);
    }}>
    <View pointerEvents="none" style={[styles.rail, { backgroundColor: t.secondary, opacity: drag === null ? 0.16 : 0.35 }]} />
    <View pointerEvents="none" style={[styles.handle, { top: fraction * Math.max(0, trackHeight - HANDLE), backgroundColor: drag === null ? t.secondary : t.accent }]} />
    {drag !== null && <View pointerEvents="none" style={[styles.bubble, { top: fraction * Math.max(0, trackHeight - HANDLE), backgroundColor: t.text }]}>
      <Text numberOfLines={1} style={[type.headline, { color: t.ground }]}>{monthTitle(month)}</Text>
    </View>}
  </View>;
}
const styles = StyleSheet.create({
  track: { width: 32, marginTop: 20, marginBottom: 36 },
  rail: { position: 'absolute', right: 7, top: 0, bottom: 0, width: 2, borderRadius: 1 },
  handle: { position: 'absolute', right: 2, width: 12, height: HANDLE, borderRadius: 6 },
  bubble: { position: 'absolute', right: 28, width: 144, minHeight: HANDLE, borderRadius: 16, paddingHorizontal: 16, alignItems: 'center', justifyContent: 'center' },
});
