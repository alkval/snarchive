import { useEffect, useMemo, useRef, type ComponentRef, type ReactNode } from 'react';
import { Animated, Easing, PanResponder, StyleSheet, View, type GestureResponderEvent, type LayoutChangeEvent } from 'react-native';
import { IDENTITY, StageGestures, isZoomed, type Navigation, type Size, type Touch, type Transform } from '../domain/viewerGestures';
import { useReducedMotion } from './theme';

/** The fullscreen media area: one-finger swipes navigate at fit; when `zoomable` (a photo of size `content`), pinch,
 * pan and double-tap zoom it. Everything in `children` is moved by one transform, so a photo and its overlay stay aligned.
 * The children receive no touches: controls belong outside the stage. Gesture rules live in viewerGestures. */
export function GestureStage({ zoomable, content, onNavigate, onZoomChange, resetToken = 0, children }: {
  zoomable: boolean; content: Size | null; onNavigate: (direction: Navigation) => void; onZoomChange?: (zoomed: boolean) => void; resetToken?: number; children: ReactNode;
}) {
  const reduced = useReducedMotion();
  const gestures = useRef(new StageGestures(zoomable)).current;
  const values = useRef({ x: new Animated.Value(0), y: new Animated.Value(0), scale: new Animated.Value(1), swipe: new Animated.Value(0) }).current;
  const view = useRef<ComponentRef<typeof View>>(null);
  const origin = useRef({ x: 0, y: 0 }), size = useRef<Size>({ width: 0, height: 0 });
  const latest = useRef({ onNavigate, onZoomChange, reduced, zoomed: false });
  latest.current = { ...latest.current, onNavigate, onZoomChange, reduced };

  const show = (transform: Transform, animate: boolean) => {
    const zoomed = isZoomed(transform);
    if (zoomed !== latest.current.zoomed) { latest.current.zoomed = zoomed; latest.current.onZoomChange?.(zoomed); }
    if (!animate || latest.current.reduced) {
      values.x.setValue(transform.x); values.y.setValue(transform.y); values.scale.setValue(transform.scale); values.swipe.setValue(gestures.swipeOffset);
      return;
    }
    const timing = (value: Animated.Value, toValue: number) => Animated.timing(value, { toValue, duration: 180, easing: Easing.bezier(0.23, 1, 0.32, 1), useNativeDriver: true });
    Animated.parallel([timing(values.x, transform.x), timing(values.y, transform.y), timing(values.scale, transform.scale), timing(values.swipe, gestures.swipeOffset)]).start();
  };
  // A photo that finished loading, a new photo size or memory starts at fit.
  useEffect(() => { gestures.setZoomable(zoomable); gestures.layout(size.current, content); show(gestures.transform, false); }, [zoomable, content?.width, content?.height]);
  useEffect(() => { if (resetToken) { gestures.reset(); show(IDENTITY, true); } }, [resetToken]);

  const touches = (event: GestureResponderEvent): Touch[] => {
    const centre = { x: origin.current.x + size.current.width / 2, y: origin.current.y + size.current.height / 2 };
    const list = event.nativeEvent.touches.length ? event.nativeEvent.touches : [event.nativeEvent];
    return list.slice(0, 2).map(touch => ({ id: touch.identifier, x: touch.pageX - centre.x, y: touch.pageY - centre.y }));
  };
  const responder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    // Keep a gesture once it has started, so a pan or pinch is not handed to another view halfway.
    onPanResponderTerminationRequest: () => !gestures.active,
    onPanResponderGrant: event => { gestures.begin(touches(event), Date.now()); },
    onPanResponderMove: event => { gestures.move(touches(event), Date.now()); show(gestures.transform, false); },
    onPanResponderRelease: (_event, state) => {
      const result = gestures.end(Date.now(), state.vx);
      show(gestures.transform, true);
      if (result.navigate) latest.current.onNavigate(result.navigate);
    },
    onPanResponderTerminate: () => { gestures.cancel(); show(gestures.transform, true); },
  }), []);

  const layout = (event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    size.current = { width, height };
    gestures.layout(size.current, content); show(gestures.transform, false);
    view.current?.measure((_x, _y, _w, _h, pageX, pageY) => { origin.current = { x: pageX, y: pageY }; });
  };
  return <View ref={view} onLayout={layout} style={styles.stage} {...responder.panHandlers}>
    <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { transform: [
      { translateX: Animated.add(values.x, values.swipe) }, { translateY: values.y }, { scale: values.scale },
    ] }]}>{children}</Animated.View>
  </View>;
}

const styles = StyleSheet.create({ stage: { flex: 1, alignSelf: 'stretch', overflow: 'hidden' } });
