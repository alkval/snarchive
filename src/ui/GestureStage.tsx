import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, type ComponentRef, type ReactNode } from 'react';
import { Animated, Easing, PanResponder, StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { stageControlReporter, stageResponderConfig, type StageEvent } from './stageResponder';
import { IDENTITY, StageGestures, isZoomed, type Navigation, type Size, type Touch, type Transform, type PhotoAdjustment, type PhotoControlState } from '../domain/viewerGestures';
import { useReducedMotion } from './theme';

export type GestureStageHandle = { adjust(action: PhotoAdjustment): void; cancel(): void };

type Props = {
  zoomable: boolean; content: Size | null; onNavigate: (direction: Navigation) => void; onZoomChange?: (zoomed: boolean) => void;
  onControlsChange?: (state: PhotoControlState) => void; resetToken?: number; children: ReactNode;
};

/** The fullscreen media area: one-finger swipes navigate at fit; when `zoomable` (a photo of size `content`), pinch,
 * pan and double-tap zoom it. Everything in `children` is moved by one transform, so a photo and its overlay stay aligned.
 * The children receive no touches: controls belong outside the stage. Gesture rules live in viewerGestures. */
export const GestureStage = forwardRef<GestureStageHandle, Props>(function GestureStage({ zoomable, content, onNavigate, onZoomChange, onControlsChange, resetToken = 0, children }, handle) {
  const reduced = useReducedMotion();
  const gestures = useRef(new StageGestures(zoomable)).current;
  const values = useRef({ x: new Animated.Value(0), y: new Animated.Value(0), scale: new Animated.Value(1), swipe: new Animated.Value(0) }).current;
  const view = useRef<ComponentRef<typeof View>>(null);
  const origin = useRef({ x: 0, y: 0 }), size = useRef<Size>({ width: 0, height: 0 });
  const latest = useRef({ onNavigate, onZoomChange, onControlsChange, reduced, zoomed: false });
  latest.current = { ...latest.current, onNavigate, onZoomChange, onControlsChange, reduced };

  const report = useMemo(() => stageControlReporter(gestures, controls => latest.current.onControlsChange?.(controls)), []);
  const show = (transform: Transform, animate: boolean) => {
    const zoomed = isZoomed(transform);
    if (zoomed !== latest.current.zoomed) { latest.current.zoomed = zoomed; latest.current.onZoomChange?.(zoomed); }
    report();
    if (!animate || latest.current.reduced) {
      values.x.setValue(transform.x); values.y.setValue(transform.y); values.scale.setValue(transform.scale); values.swipe.setValue(gestures.swipeOffset);
      return;
    }
    const timing = (value: Animated.Value, toValue: number) => Animated.timing(value, { toValue, duration: 180, easing: Easing.bezier(0.23, 1, 0.32, 1), useNativeDriver: true });
    Animated.parallel([timing(values.x, transform.x), timing(values.y, transform.y), timing(values.scale, transform.scale), timing(values.swipe, gestures.swipeOffset)]).start();
  };
  useImperativeHandle(handle, () => ({
    adjust(action) { gestures.adjust(action); show(gestures.transform, true); },
    cancel() { gestures.cancel(); show(gestures.transform, true); },
  }));
  // A photo that finished loading, a new photo size or memory starts at fit.
  useEffect(() => { gestures.setZoomable(zoomable); gestures.layout(size.current, content); show(gestures.transform, false); }, [zoomable, content?.width, content?.height]);
  useEffect(() => { if (resetToken) { gestures.reset(); show(IDENTITY, true); } }, [resetToken]);

  const touches = (event: StageEvent): Touch[] => {
    const centre = { x: origin.current.x + size.current.width / 2, y: origin.current.y + size.current.height / 2 };
    return event.nativeEvent.touches.slice(0, 2).map(touch => ({ id: touch.identifier, x: touch.pageX - centre.x, y: touch.pageY - centre.y }));
  };
  const responder = useMemo(() => PanResponder.create(stageResponderConfig(gestures, {
    touches, show, navigate: direction => latest.current.onNavigate(direction),
  })), []);

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
});

const styles = StyleSheet.create({ stage: { flex: 1, alignSelf: 'stretch', overflow: 'hidden' } });
