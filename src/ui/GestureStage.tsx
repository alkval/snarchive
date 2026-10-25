import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState, type ComponentRef, type ReactNode } from 'react';
import { Animated, Easing, PanResponder, StyleSheet, View, useWindowDimensions, type LayoutChangeEvent } from 'react-native';
import { stageAccessibility, stageResponderConfig, type StageEvent } from './stageResponder';
import { IDENTITY, StageGestures, TAP, isZoomed, type Navigation, type Size, type Touch, type Transform } from '../domain/viewerGestures';
import { useReducedMotion } from './theme';

export type GestureStageHandle = { cancel(): void };

type Props = {
  zoomable: boolean; content: Size | null; onNavigate: (direction: Navigation) => void | boolean | Promise<void | boolean>; onZoomChange?: (zoomed: boolean) => void;
  onVertical?: (direction: 'up' | 'down') => void; previousPreview?: ReactNode; nextPreview?: ReactNode; canNavigate?: (direction: Navigation) => boolean;
  /** Follows an unzoomed vertical drag: its distance (negative is up) while it lasts, then null when it ends. */
  onVerticalDrag?: (dy: number | null) => void;
  /** A single tap. On a zoomable photo it waits out the double-tap interval, so a double tap (zoom) never also taps. */
  onTap?: () => void;
  /** Whether the viewer's controls are shown, when a tap toggles them; adds a screen-reader action that does the same. */
  controlsShown?: boolean; resetToken?: number; children: ReactNode;
};

/** The fullscreen media area: one-finger swipes navigate at fit; when `zoomable` (a photo of size `content`), pinch,
 * pan and double-tap zoom it. Everything in `children` is moved by one transform, so a photo and its overlay stay aligned.
 * The children receive no touches: controls belong outside the stage. Gesture rules live in viewerGestures.
 *
 * The stage fills the window, so it starts at the window size: a newly mounted memory is drawn at its final size in its
 * first frame instead of after a layout pass (a blank frame on every swipe). */
export const GestureStage = forwardRef<GestureStageHandle, Props>(function GestureStage({ zoomable, content, onNavigate, onZoomChange, onVertical, onVerticalDrag, onTap, controlsShown, previousPreview, nextPreview, canNavigate, resetToken = 0, children }, handle) {
  const reduced = useReducedMotion();
  const screen = useWindowDimensions();
  const gestures = useRef(new StageGestures(zoomable)).current;
  const values = useRef({ x: new Animated.Value(0), y: new Animated.Value(0), scale: new Animated.Value(1), swipe: new Animated.Value(0) }).current;
  const view = useRef<ComponentRef<typeof View>>(null);
  const origin = useRef({ x: 0, y: 0 }), size = useRef<Size>({ width: screen.width, height: screen.height });
  const [width, setWidth] = useState(screen.width);
  const moving = useRef(false), alive = useRef(true), tapTimer = useRef<ReturnType<typeof setTimeout> | null>(null), vertical = useRef<number | null>(null);
  const latest = useRef({ onNavigate, onZoomChange, onVertical, onVerticalDrag, onTap, canNavigate, reduced, zoomable, zoomed: false });
  latest.current = { ...latest.current, onNavigate, onZoomChange, onVertical, onVerticalDrag, onTap, canNavigate, reduced, zoomable };
  const clearTap = () => { if (tapTimer.current) { clearTimeout(tapTimer.current); tapTimer.current = null; } };
  useEffect(() => { alive.current = true; return () => { alive.current = false; clearTap(); values.swipe.stopAnimation(); }; }, []);

  const tap = (doubleTap: boolean) => {
    clearTap();
    if (doubleTap) return;
    if (!latest.current.zoomable) { latest.current.onTap?.(); return; }
    tapTimer.current = setTimeout(() => { tapTimer.current = null; if (alive.current) latest.current.onTap?.(); }, TAP.doubleInterval);
  };
  const show = (transform: Transform, animate: boolean) => {
    const zoomed = isZoomed(transform);
    if (zoomed !== latest.current.zoomed) { latest.current.zoomed = zoomed; latest.current.onZoomChange?.(zoomed); }
    if (gestures.verticalOffset !== vertical.current) { vertical.current = gestures.verticalOffset; latest.current.onVerticalDrag?.(vertical.current); }
    if (!animate || latest.current.reduced) {
      values.x.setValue(transform.x); values.y.setValue(transform.y); values.scale.setValue(transform.scale); values.swipe.setValue(gestures.swipeOffset);
      return;
    }
    const timing = (value: Animated.Value, toValue: number) => Animated.timing(value, { toValue, duration: 180, easing: Easing.bezier(0.23, 1, 0.32, 1), useNativeDriver: true });
    Animated.parallel([timing(values.x, transform.x), timing(values.y, transform.y), timing(values.scale, transform.scale), timing(values.swipe, gestures.swipeOffset)]).start();
  };
  useImperativeHandle(handle, () => ({
    cancel() { clearTap(); values.swipe.stopAnimation(); moving.current = false; gestures.cancel(); show(gestures.transform, true); },
  }));
  // A photo that finished loading, a new photo size or memory starts at fit.
  useEffect(() => { gestures.setZoomable(zoomable); gestures.layout(size.current, content); show(gestures.transform, false); }, [zoomable, content?.width, content?.height]);
  useEffect(() => { if (resetToken) { gestures.reset(); show(IDENTITY, true); } }, [resetToken]);

  const touches = (event: StageEvent): Touch[] => {
    const centre = { x: origin.current.x + size.current.width / 2, y: origin.current.y + size.current.height / 2 };
    return event.nativeEvent.touches.slice(0, 2).map(touch => ({ id: touch.identifier, x: touch.pageX - centre.x, y: touch.pageY - centre.y }));
  };
  const navigate = (direction: Navigation) => {
    if (moving.current) return;
    clearTap();
    if (latest.current.canNavigate && !latest.current.canNavigate(direction)) { show(gestures.transform, true); return; }
    moving.current = true;
    Animated.timing(values.swipe, { toValue: direction === 'next' ? -size.current.width : size.current.width,
      duration: latest.current.reduced ? 0 : 150, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start(({ finished }) => {
      if (!finished || !alive.current) { moving.current = false; return; }
      void Promise.resolve(latest.current.onNavigate(direction)).then(moved => {
        if (alive.current && moved !== true) { moving.current = false; show(gestures.transform, true); }
      }, () => { if (alive.current) { moving.current = false; show(gestures.transform, true); } });
    });
  };
  const responder = useMemo(() => PanResponder.create(stageResponderConfig(gestures, {
    touches, show, navigate, tap, locked: () => moving.current, vertical: direction => latest.current.onVertical?.(direction),
  })), []);

  const layout = (event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    if (width !== size.current.width) { values.swipe.stopAnimation(); moving.current = false; }
    setWidth(width);
    size.current = { width, height };
    gestures.layout(size.current, content); show(gestures.transform, false);
    view.current?.measure((_x, _y, _w, _h, pageX, pageY) => { origin.current = { x: pageX, y: pageY }; });
  };
  const a11y = stageAccessibility(controlsShown, { navigate, details: () => latest.current.onVertical?.('up'), toggleControls: () => latest.current.onTap?.() });
  return <View ref={view} onLayout={layout} style={styles.stage} {...responder.panHandlers}
    accessible accessibilityRole="adjustable" accessibilityLabel="Memory" accessibilityHint={a11y.hint} accessibilityActions={a11y.actions}
    onAccessibilityAction={event => a11y.perform(event.nativeEvent.actionName)}>
    <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { width: width * 3, left: -width, right: undefined, transform: [{ translateX: values.swipe }] }]}>
      <View style={[StyleSheet.absoluteFill, { width, right: undefined }]}>{previousPreview}</View>
      <Animated.View style={[StyleSheet.absoluteFill, { width, left: width, right: undefined, transform: [
        { translateX: values.x }, { translateY: values.y }, { scale: values.scale },
      ] }]}>{children}</Animated.View>
      <View style={[StyleSheet.absoluteFill, { width, left: width * 2, right: undefined }]}>{nextPreview}</View>
    </Animated.View>
  </View>;
});

const styles = StyleSheet.create({ stage: { flex: 1, alignSelf: 'stretch', overflow: 'hidden' } });
