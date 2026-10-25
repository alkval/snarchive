// The gesture rules as plain state. These tests do not prove that native touch delivery works on a device; see
// docs/testing.md for what was checked on the emulator.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DOUBLE_TAP_SCALE, IDENTITY, MAX_SCALE, StageGestures, SWIPE, TAP, VERTICAL, clampTransform, containedSize, isZoomed, swipeDecision, verticalDecision, zoomAbout, type Touch } from '../src/domain/viewerGestures.ts';
import { matchingAspect } from '../src/domain/photoGeometry.ts';

const stage = { width: 400, height: 800 };
const landscape = { width: 4000, height: 3000 }; // Drawn 400 × 300: letterboxed top and bottom.
const finger = (x: number, y: number, id = 1): Touch => ({ id, x, y });
const near = (a: number, b: number, what: string) => assert.ok(Math.abs(a - b) < 1e-6, `${what}: ${a} vs ${b}`);
function photo(content = landscape) { const g = new StageGestures(true); g.layout(stage, content); return g; }
/** One-finger drag from (0,0) by (dx,dy) in `steps`, released with velocity vx. */
function drag(g: StageGestures, dx: number, dy: number, vx = 0, time = 0) {
  g.begin([finger(0, 0)], time);
  for (let i = 1; i <= 4; i++) g.move([finger((dx * i) / 4, (dy * i) / 4)], time + i * 20);
  return g.end(time + 100, vx);
}
function pinch(g: StageGestures, from: number, to: number, centre = { x: 0, y: 0 }) {
  g.begin([finger(centre.x - from / 2, centre.y, 1)], 0);
  g.move([finger(centre.x - from / 2, centre.y, 1), finger(centre.x + from / 2, centre.y, 2)], 10);
  g.move([finger(centre.x - to / 2, centre.y, 1), finger(centre.x + to / 2, centre.y, 2)], 20);
}

test('fit is contain: the whole photo is visible and letterboxed', () => {
  assert.deepEqual(containedSize(landscape, stage), { width: 400, height: 300 });
  assert.deepEqual(containedSize({ width: 1000, height: 4000 }, stage), { width: 200, height: 800 });
  assert.deepEqual(containedSize({ width: 0, height: 10 }, stage), { width: 0, height: 0 });
  assert.deepEqual(clampTransform({ scale: 0.5, x: 30, y: -30 }, { width: 400, height: 300 }, stage), IDENTITY, 'never smaller than fit, centred');
});

test('zoom is limited to 1×–4× and panning never shows a gap beyond the photo edge', () => {
  const drawn = { width: 400, height: 300 };
  assert.equal(clampTransform({ scale: 9, x: 0, y: 0 }, drawn, stage).scale, MAX_SCALE);
  const t = clampTransform({ scale: 2, x: 1000, y: 1000 }, drawn, stage);
  assert.deepEqual(t, { scale: 2, x: 200, y: 0 }, 'x limited to (800-400)/2; 600 tall still fits 800, so y stays centred');
  const tall = clampTransform({ scale: 4, x: -1000, y: -1000 }, drawn, stage);
  assert.deepEqual(tall, { scale: 4, x: -600, y: -200 });
  assert.deepEqual(clampTransform({ scale: 1.01, x: 5, y: 5 }, drawn, stage), IDENTITY, 'near 1 snaps back to fit');
});

test('zooming about a point keeps the content under it in place', () => {
  const drawn = { width: 400, height: 300 };
  const focal = { x: 100, y: 50 };
  const t = zoomAbout(IDENTITY, 2, focal, drawn, stage);
  // Content point under the focal before: u = focal. After: t + s·u should be the focal again (within bounds).
  near(t.x + t.scale * focal.x, focal.x, 'x'); near(t.y, 0, 'y is clamped: the zoomed photo is still shorter than the stage');
});

test('photo and overlay share one transform: matching aspects are drawn at the same size, so every point aligns', () => {
  const base = { width: 1080, height: 1920 }, overlay = { width: 540, height: 960 };
  assert.ok(matchingAspect(base, overlay));
  const a = containedSize(base, stage), b = containedSize(overlay, stage);
  near(a.width, b.width, 'width'); near(a.height, b.height, 'height');
  const g = photo(base); pinch(g, 100, 250, { x: 40, y: -30 }); g.end(30, 0);
  // Both layers are children of one transformed view: a feature at content offset u maps to t + s·u for both.
  for (const u of [{ x: -a.width / 2, y: -a.height / 2 }, { x: 37, y: 101 }]) {
    const onBase = { x: g.transform.x + g.transform.scale * u.x, y: g.transform.y + g.transform.scale * u.y };
    const onOverlay = { x: g.transform.x + g.transform.scale * (u.x * b.width / a.width), y: g.transform.y + g.transform.scale * (u.y * b.height / a.height) };
    near(onBase.x, onOverlay.x, 'x'); near(onBase.y, onOverlay.y, 'y');
  }
});

test('swipe thresholds: distance, flick, direction and horizontal dominance', () => {
  assert.equal(swipeDecision(-SWIPE.distance + 1, 0, 0, 1000), null, 'just short');
  assert.equal(swipeDecision(-SWIPE.distance, 0, 0, 1000), 'next');
  assert.equal(swipeDecision(SWIPE.distance, 0, 0, 1000), 'previous');
  assert.equal(swipeDecision(-0.18 * 300, 0, 0, 300), 'next', 'a narrow stage needs only 18% of its width');
  assert.equal(swipeDecision(-SWIPE.flickDistance, 0, -SWIPE.flickVelocity, 1000), 'next', 'a quick flick');
  assert.equal(swipeDecision(-SWIPE.flickDistance + 1, 0, -5, 1000), null, 'too short even when fast');
  assert.equal(swipeDecision(-40, 0, 2, 1000), null, 'flick against the drag direction');
  assert.equal(swipeDecision(-120, 80, 0, 1000), null, 'not horizontal enough (needs 1.5×)');
  assert.equal(swipeDecision(-120, 79, 0, 1000), 'next');
});

test('at fit a horizontal drag navigates and follows the finger; a short or vertical drag does not', () => {
  const g = photo();
  g.begin([finger(0, 0)], 0); g.move([finger(-50, 2)], 20);
  assert.equal(g.swipeOffset, -50, 'the photo follows the finger');
  assert.deepEqual(g.end(60, 0), { navigate: null, tapped: false, doubleTap: false }, '50 px is not enough');
  assert.equal(g.swipeOffset, 0, 'snaps back');
  assert.equal(drag(g, -120, 10).navigate, 'next');
  assert.equal(drag(g, 120, 10).navigate, 'previous');
  assert.equal(drag(g, 30, 200).navigate, null, 'vertical');
  assert.deepEqual(g.transform, IDENTITY);
});

test('while zoomed a one-finger drag pans within bounds and never navigates, even past the edge', () => {
  const g = photo();
  pinch(g, 100, 300); g.end(40, 0);
  assert.ok(isZoomed(g.transform)); assert.equal(g.transform.scale, 3);
  const end = drag(g, -2000, 0, -5);
  assert.equal(end.navigate, null);
  assert.equal(g.transform.x, -(400 * 3 - 400) / 2, 'stopped at the edge');
  assert.equal(g.swipeOffset, 0);
});

test('two fingers always pinch; lifting one never turns the gesture into a swipe', () => {
  const g = photo();
  pinch(g, 100, 120); // Small zoom.
  g.move([finger(-60, 0, 1)], 30); g.move([finger(-300, 0, 1)], 40);
  const end = g.end(50, -3);
  assert.equal(end.navigate, null);
  const back = photo();
  pinch(back, 200, 150); // Pinch in at fit: stays at fit.
  assert.deepEqual(back.transform, IDENTITY);
  back.move([finger(-300, 0, 1)], 30);
  assert.equal(back.end(40, -3).navigate, null, 'even at fit');
});

test('pinch keeps the midpoint content under the fingers and is limited to 4×', () => {
  const g = photo();
  pinch(g, 50, 1000, { x: 100, y: 0 });
  assert.equal(g.transform.scale, MAX_SCALE);
  const g2 = photo(); pinch(g2, 100, 200, { x: 100, y: 0 });
  near(g2.transform.scale, 2, 'scale'); near(g2.transform.x + 2 * 100, 100, 'focal x stays');
});

test('double tap zooms in at the tap and back to fit; slow or distant taps do not', () => {
  const g = photo();
  const tap = (x: number, y: number, time: number) => { g.begin([finger(x, y)], time); return g.end(time + 50, 0); };
  assert.deepEqual(tap(50, 20, 0), { navigate: null, tapped: true, doubleTap: false });
  assert.deepEqual(tap(52, 22, 200), { navigate: null, tapped: true, doubleTap: true }, 'the second tap zooms and is reported as a double tap');
  near(g.transform.scale, DOUBLE_TAP_SCALE, 'zoomed in');
  tap(0, 0, 1000); tap(0, 0, 1200);
  assert.deepEqual(g.transform, IDENTITY, 'second double tap resets');
  tap(0, 0, 2000); tap(0, 0, 2000 + TAP.doubleInterval + 51);
  assert.deepEqual(g.transform, IDENTITY, 'too slow');
  tap(0, 0, 4000); tap(TAP.doubleSlop + 5, 0, 4100);
  assert.deepEqual(g.transform, IDENTITY, 'too far apart');
  g.begin([finger(0, 0)], 5000); assert.equal(g.end(5000 + TAP.maxDuration + 1, 0).tapped, false, 'a long press is not a tap');
});

test('a cancelled gesture never navigates and keeps a valid zoom; layout changes reset to fit', () => {
  const g = photo();
  g.begin([finger(0, 0)], 0); g.move([finger(-300, 0)], 20);
  g.cancel();
  assert.equal(g.swipeOffset, 0); assert.deepEqual(g.transform, IDENTITY);
  pinch(g, 100, 250); g.cancel();
  assert.equal(g.transform.scale, 2.5, 'zoom applied so far is kept');
  g.layout({ width: 800, height: 400 }, landscape); // Rotation.
  assert.deepEqual(g.transform, IDENTITY);
  pinch(g, 100, 200); g.end(30, 0);
  g.layout({ width: 800, height: 400 }, landscape); // Same layout again: nothing changes.
  assert.equal(g.transform.scale, 2);
  g.layout({ width: 800, height: 400 }, { width: 3000, height: 4000 }); // Another photo.
  assert.deepEqual(g.transform, IDENTITY);
  g.begin([finger(0, 0)], 0); g.move([finger(-300, 0)], 10);
  g.reset();
  assert.equal(g.end(20, 0).navigate, null, 'a reset during a gesture ends it without navigating');
});

test('video and message stages only swipe: no zoom by pinch or double tap', () => {
  const g = new StageGestures(false); g.layout(stage, null);
  pinch(g, 100, 300); g.end(30, 0);
  assert.deepEqual(g.transform, IDENTITY);
  g.begin([finger(0, 0)], 0); g.end(10, 0); g.begin([finger(0, 0)], 100); g.end(110, 0);
  assert.deepEqual(g.transform, IDENTITY);
  assert.equal(drag(g, -150, 0).navigate, 'next');
});

test('a stage created before its photo loaded becomes zoomable when the photo arrives', () => {
  // The viewer shows the same stage while loading (not zoomable) and after the photo is measured.
  const g = new StageGestures(false); g.layout(stage, null);
  pinch(g, 100, 300); g.end(30, 0);
  assert.deepEqual(g.transform, IDENTITY);
  g.setZoomable(true); g.layout(stage, landscape);
  pinch(g, 100, 300); g.end(30, 0);
  assert.equal(g.transform.scale, 3);
  g.setZoomable(false);
  assert.deepEqual(g.transform, IDENTITY, 'and back to fit if it stops being a photo');
});

test('touch-count changes without movement: two fingers once means no navigation until the gesture ends', () => {
  const g = photo();
  g.begin([finger(0, 0, 1)], 0);
  g.touchesChanged([finger(0, 0, 1), finger(120, 0, 2)], 10);
  g.touchesChanged([finger(0, 0, 1)], 20);
  g.move([finger(-300, 0, 1)], 30);
  assert.equal(g.end(40, -3).navigate, null);
  g.begin([finger(0, 0, 1)], 100); g.move([finger(-300, 0, 1)], 110);
  assert.equal(g.end(120, -3).navigate, 'next', 'cleared only when the gesture ended');
  g.begin([finger(0, 0, 1)], 200); g.touchesChanged([finger(0, 0, 1)], 201); // The first finger's own start event.
  g.move([finger(-300, 0, 1)], 210);
  assert.equal(g.end(220, -3).navigate, 'next', 'a start event for the same finger changes nothing');
});

test('a height-only stage change keeps the zoom within bounds; a width change resets', () => {
  const g = photo();
  pinch(g, 100, 300); g.end(30, 0);
  assert.equal(g.transform.scale, 3);
  g.layout({ width: 400, height: 776 }, landscape); // Controls or a note appeared below the stage.
  assert.equal(g.transform.scale, 3, 'zoom kept');
  g.begin([finger(0, 0)], 100); g.move([finger(-5000, -5000)], 110); g.end(120, 0);
  assert.deepEqual(g.transform, { scale: 3, x: -400, y: -62 }, 'bounds follow the new height: (900-776)/2');
  g.layout({ width: 420, height: 776 }, landscape); // A window or orientation change.
  assert.deepEqual(g.transform, IDENTITY);
});

test('vertical swipes open details or return at fit, never while zoomed, multi-touching or cancelled', () => {
  const g = photo(); drag(g, 0, -160); assert.equal(g.verticalSwipe, 'up');
  drag(g, 0, 160); assert.equal(g.verticalSwipe, 'down');
  drag(g, 0, 40); assert.equal(g.verticalSwipe, null);
  g.begin([finger(0, 0)], 0); g.end(10, 0); g.begin([finger(0, 0)], 100); g.end(110, 0); assert.ok(isZoomed(g.transform));
  drag(g, 0, -160, 0, 1000); assert.equal(g.verticalSwipe, null, 'zoomed: a vertical drag pans');
  g.reset(); g.begin([finger(0, 0)], 0); g.touchesChanged([finger(0, 0), finger(100, 0, 2)], 10);
  g.touchesChanged([finger(0, 0)], 20); g.move([finger(0, -160)], 30); g.end(40, 0); assert.equal(g.verticalSwipe, null);
  g.reset(); g.begin([finger(0, 0)], 0); g.move([finger(0, -160)], 20); g.cancel(); assert.equal(g.verticalSwipe, null);
});

test('a vertical drag reports its distance while it lasts, and nothing once it ends, is cancelled or gains a finger', () => {
  const g = photo();
  g.begin([finger(0, 0)], 0); assert.equal(g.verticalOffset, null);
  g.move([finger(0, -5)], 10); assert.equal(g.verticalOffset, null, 'within tap slop');
  g.move([finger(2, -60)], 20); assert.equal(g.verticalOffset, -60);
  g.move([finger(2, 30)], 30); assert.equal(g.verticalOffset, 30, 'it follows the finger back down past the start');
  g.end(40, 0); assert.equal(g.verticalOffset, null);
  g.begin([finger(0, 0)], 100); g.move([finger(0, -80)], 120); g.cancel(); assert.equal(g.verticalOffset, null);
  g.begin([finger(0, 0)], 200); g.move([finger(0, -80)], 220); g.move([finger(0, -80), finger(50, -80, 2)], 230); assert.equal(g.verticalOffset, null);
  g.reset(); g.begin([finger(0, 0)], 300); g.move([finger(-80, 0)], 320); assert.equal(g.verticalOffset, null, 'a horizontal swipe is not vertical');
});

test('a released vertical drag decides by distance or a flick in the direction it travelled', () => {
  assert.equal(verticalDecision(-VERTICAL.distance, 0), 'up');
  assert.equal(verticalDecision(VERTICAL.distance, 0), 'down');
  assert.equal(verticalDecision(-(VERTICAL.distance - 1), 0), null);
  assert.equal(verticalDecision(-VERTICAL.flickDistance, -VERTICAL.flickVelocity), 'up', 'a short fast flick');
  assert.equal(verticalDecision(-(VERTICAL.flickDistance - 1), -2), null, 'too short even when fast');
  assert.equal(verticalDecision(-40, VERTICAL.flickVelocity), null, 'moving back down at release');
  const g = photo(); g.begin([finger(0, 0)], 0); g.move([finger(0, -30)], 20); g.end(40, 0, -1); assert.equal(g.verticalSwipe, 'up');
});
