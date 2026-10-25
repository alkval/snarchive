import type { Navigation, StageGestures, Touch, Transform } from '../domain/viewerGestures.ts';

/** The subset of a responder event the stage reads. */
export type StageEvent = { nativeEvent: { touches: readonly { identifier: string | number; pageX: number; pageY: number }[]; pageX: number; pageY: number; identifier: string | number } };
export type StageCallbacks = {
  /** Converts an event's current touches (not the finger that just lifted) to stage-centre coordinates. */
  touches: (event: StageEvent) => Touch[];
  /** Shows a transform; `settle` animates to it (end of a gesture). */
  show: (transform: Transform, settle: boolean) => void;
  navigate: (direction: Navigation) => void;
  vertical?: (direction: 'up' | 'down') => void;
  /** A tap ended; `doubleTap` when it completed a double tap. */
  tap?: (doubleTap: boolean) => void;
  locked?: () => boolean;
  now?: () => number;
};

/** The PanResponder configuration for GestureStage. Kept free of React Native imports so the exact handlers the stage
 * installs can be driven in host tests. Every touch change reaches the gesture model: start and end fire for each
 * finger that lands or lifts, including a second finger that never moves. */
export function stageResponderConfig(gestures: StageGestures, callbacks: StageCallbacks) {
  const now = callbacks.now ?? Date.now;
  return {
    onStartShouldSetPanResponder: () => !callbacks.locked?.(),
    onMoveShouldSetPanResponder: () => !callbacks.locked?.(),
    // Keep a gesture once it has started, so a pan or pinch is not handed to another view halfway.
    onPanResponderTerminationRequest: () => !gestures.active,
    onPanResponderGrant: (event: StageEvent) => {
      const current = callbacks.touches(event);
      gestures.begin(current.length ? current : callbacks.touches({ nativeEvent: { ...event.nativeEvent, touches: [event.nativeEvent] } }), now());
    },
    onPanResponderStart: (event: StageEvent) => { gestures.touchesChanged(callbacks.touches(event), now()); callbacks.show(gestures.transform, false); },
    onPanResponderMove: (event: StageEvent) => { gestures.move(callbacks.touches(event), now()); callbacks.show(gestures.transform, false); },
    onPanResponderEnd: (event: StageEvent) => { gestures.touchesChanged(callbacks.touches(event), now()); callbacks.show(gestures.transform, false); },
    onPanResponderRelease: (_event: StageEvent, state: { vx: number; vy?: number }) => {
      const result = gestures.end(now(), state.vx, state.vy ?? 0);
      if (result.navigate) { callbacks.navigate(result.navigate); return; }
      // The decision goes first, so a drag that opened details is not reported as abandoned by the settle below.
      if (gestures.verticalSwipe) callbacks.vertical?.(gestures.verticalSwipe);
      callbacks.show(gestures.transform, true);
      if (result.tapped) callbacks.tap?.(result.doubleTap);
    },
    onPanResponderTerminate: () => { gestures.cancel(); callbacks.show(gestures.transform, true); },
  };
}
