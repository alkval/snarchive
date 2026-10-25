// Host-adapter tests: they drive the exact handler object GestureStage passes to PanResponder.create with synthetic
// responder events. They do not run React Native's PanResponder or a renderer; device checks are in section-25.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StageGestures, IDENTITY, type Navigation } from '../src/domain/viewerGestures.ts';
import { stageResponderConfig, type StageEvent } from '../src/ui/stageResponder.ts';

type Finger = { id: number; x: number; y: number };
const event = (...fingers: Finger[]): StageEvent => {
  const touches = fingers.map(f => ({ identifier: f.id, pageX: f.x, pageY: f.y }));
  const first = touches[0] ?? { identifier: 0, pageX: 0, pageY: 0 };
  return { nativeEvent: { touches, pageX: first.pageX, pageY: first.pageY, identifier: first.identifier } };
};
function stage(zoomable = true) {
  const gestures = new StageGestures(zoomable);
  gestures.layout({ width: 400, height: 800 }, zoomable ? { width: 4000, height: 3000 } : null);
  const navigated: Navigation[] = []; const shown: number[] = [];
  let time = 0;
  const config = stageResponderConfig(gestures, {
    touches: e => e.nativeEvent.touches.map(t => ({ id: t.identifier, x: t.pageX, y: t.pageY })), // Page = stage-centre here.
    show: transform => shown.push(transform.scale), navigate: direction => navigated.push(direction), now: () => (time += 16),
  });
  return { gestures, config, navigated, shown };
}
const one = (x: number, y = 0): Finger => ({ id: 1, x, y });
const two = (x: number, y = 0): Finger => ({ id: 2, x, y });

test('a released horizontal swipe hands its last offset to the page animation before any reset is drawn', () => {
  const { gestures, config, shown, navigated } = stage();
  config.onPanResponderGrant(event(one(0))); config.onPanResponderMove(event(one(-200)));
  const count = shown.length; config.onPanResponderRelease(event(), { vx: -1 });
  assert.deepEqual(navigated, ['next']); assert.equal(shown.length, count);
  assert.equal(gestures.active, false);
});
test('vertical details/back gestures travel through the installed adapter; locked transitions claim no touches', () => {
  const gestures = new StageGestures(false), vertical: string[] = [];
  gestures.layout({ width: 400, height: 800 }, null);
  let locked = false;
  const config = stageResponderConfig(gestures, { touches: e => e.nativeEvent.touches.map(t => ({ id: t.identifier, x: t.pageX, y: t.pageY })),
    show() {}, navigate() { throw new Error('not horizontal'); }, vertical: direction => vertical.push(direction), locked: () => locked });
  for (const y of [-150, 150]) { config.onPanResponderGrant(event(one(0))); config.onPanResponderMove(event(one(0, y))); config.onPanResponderRelease(event(), { vx: 0 }); }
  assert.deepEqual(vertical, ['up', 'down']);
  locked = true; assert.equal(config.onStartShouldSetPanResponder(), false); assert.equal(config.onMoveShouldSetPanResponder(), false);
});

test('the stage installs start and end handlers alongside grant, move, release and terminate', () => {
  const { config } = stage();
  for (const name of ['onPanResponderGrant', 'onPanResponderStart', 'onPanResponderMove', 'onPanResponderEnd', 'onPanResponderRelease', 'onPanResponderTerminate'] as const)
    assert.equal(typeof config[name], 'function', name);
});

test('a one-finger swipe navigates through the installed handlers', () => {
  const { config, navigated } = stage();
  config.onPanResponderGrant(event(one(0))); config.onPanResponderStart(event(one(0)));
  for (const x of [-40, -120, -200]) config.onPanResponderMove(event(one(x)));
  config.onPanResponderEnd(event()); config.onPanResponderRelease(event(), { vx: -1 });
  assert.deepEqual(navigated, ['next']);
});

test('a second finger that lands and lifts without moving still suppresses navigation for the rest of the gesture', () => {
  const { config, navigated, gestures } = stage();
  config.onPanResponderGrant(event(one(0))); config.onPanResponderStart(event(one(0)));
  config.onPanResponderStart(event(one(0), two(100))); // Lands; no move event.
  config.onPanResponderEnd(event(one(0)));             // Lifts; no move event.
  for (const x of [-60, -150, -300]) config.onPanResponderMove(event(one(x)));
  assert.equal(gestures.swipeOffset, 0, 'no swipe feedback either');
  config.onPanResponderEnd(event()); config.onPanResponderRelease(event(), { vx: -3 });
  assert.deepEqual(navigated, []);
  // The next, separate gesture can navigate again.
  config.onPanResponderGrant(event(one(0)));
  config.onPanResponderMove(event(one(-200)));
  config.onPanResponderRelease(event(), { vx: -1 });
  assert.deepEqual(navigated, ['next']);
});

test('the same happens on a stage that cannot zoom (video, messages)', () => {
  const { config, navigated } = stage(false);
  config.onPanResponderGrant(event(one(0)));
  config.onPanResponderStart(event(one(0), two(80))); config.onPanResponderEnd(event(one(0)));
  config.onPanResponderMove(event(one(-300)));
  config.onPanResponderRelease(event(), { vx: -3 });
  assert.deepEqual(navigated, []);
});

test('lifting one finger after a pinch continues as a pan without restarting the gesture', () => {
  const { config, gestures, navigated } = stage();
  config.onPanResponderGrant(event(one(-50)));
  config.onPanResponderStart(event(one(-50), two(50)));
  config.onPanResponderMove(event(one(-100), two(100))); // 2× about the centre.
  assert.equal(gestures.transform.scale, 2);
  config.onPanResponderEnd(event(one(-100)));          // Second finger lifts.
  config.onPanResponderMove(event(one(-160)));          // Pans 60 px left (within bounds).
  assert.deepEqual(gestures.transform, { scale: 2, x: -60, y: 0 });
  config.onPanResponderEnd(event()); config.onPanResponderRelease(event(), { vx: -3 });
  assert.deepEqual(navigated, []); assert.equal(gestures.transform.scale, 2);
});

test('a terminated gesture never navigates and leaves no swipe offset', () => {
  const { config, gestures, navigated } = stage();
  config.onPanResponderGrant(event(one(0))); config.onPanResponderMove(event(one(-300)));
  assert.equal(gestures.swipeOffset, -300);
  assert.equal(config.onPanResponderTerminationRequest(), false, 'an active gesture is kept');
  config.onPanResponderTerminate();
  assert.equal(gestures.swipeOffset, 0); assert.deepEqual(gestures.transform, IDENTITY); assert.deepEqual(navigated, []);
  assert.equal(config.onPanResponderTerminationRequest(), true, 'idle again');
});

test('a release reports the vertical decision before settling, then any tap with whether it completed a double tap', () => {
  const gestures = new StageGestures(true), calls: string[] = [];
  gestures.layout({ width: 400, height: 800 }, { width: 4000, height: 3000 });
  let time = 0;
  const config = stageResponderConfig(gestures, { touches: e => e.nativeEvent.touches.map(t => ({ id: t.identifier, x: t.pageX, y: t.pageY })),
    show: () => calls.push(`show:${gestures.verticalOffset}`), navigate() { throw new Error('not horizontal'); },
    vertical: direction => calls.push(`vertical:${direction}`), tap: doubleTap => calls.push(`tap:${doubleTap}`), now: () => (time += 16) });
  config.onPanResponderGrant(event(one(0))); config.onPanResponderMove(event(one(0, -150)));
  assert.deepEqual(calls, ['show:-150'], 'the drag distance is visible while it moves');
  config.onPanResponderRelease(event(), { vx: 0, vy: -1 });
  assert.deepEqual(calls.slice(1), ['vertical:up', 'show:null']);
  calls.length = 0;
  for (let i = 0; i < 2; i++) { config.onPanResponderGrant(event(one(10))); config.onPanResponderRelease(event(), { vx: 0 }); }
  assert.deepEqual(calls.filter(call => call.startsWith('tap')), ['tap:false', 'tap:true']);
});
