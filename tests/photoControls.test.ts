import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StageGestures, IDENTITY, MAX_SCALE, PHOTO_ADJUSTMENTS, type PhotoAdjustment, type PhotoControlState } from '../src/domain/viewerGestures.ts';
import { stageControlReporter, stageResponderConfig, type StageEvent } from '../src/ui/stageResponder.ts';

function photo(stage = { width: 400, height: 600 }, content = { width: 400, height: 600 }) {
  const model = new StageGestures(true); model.layout(stage, content); return model;
}
const touch = (x: number, y: number, id = 1) => ({ id, x, y });
function event(x = 0, y = 0): StageEvent {
  return { nativeEvent: { pageX: x, pageY: y, identifier: 1, touches: [{ pageX: x, pageY: y, identifier: 1 }] } };
}

test('at fit only Zoom in is enabled; unavailable geometry and videos expose no photo actions', () => {
  const model = photo();
  assert.equal(model.controls.ready, true); assert.equal(model.controls.percent, 100);
  assert.deepEqual(PHOTO_ADJUSTMENTS.filter(action => model.controls.enabled[action]), ['zoom-in']);
  for (const other of [new StageGestures(true), new StageGestures(false)]) {
    if (other !== model) other.layout({ width: 0, height: 0 }, null);
    assert.equal(other.controls.ready, false);
    for (const action of PHOTO_ADJUSTMENTS) other.adjust(action);
    assert.deepEqual(other.transform, IDENTITY);
  }
  const video = new StageGestures(false); video.layout({ width: 400, height: 600 }, { width: 400, height: 600 });
  video.adjust('zoom-in'); assert.deepEqual(video.transform, IDENTITY); assert.equal(video.controls.ready, false);
});

test('rapid button commands accumulate synchronously and stop at both zoom bounds', () => {
  const model = photo();
  model.adjust('zoom-in'); model.adjust('zoom-in'); model.adjust('zoom-in');
  assert.equal(model.transform.scale, 2.5); assert.equal(model.controls.percent, 250);
  for (let i = 0; i < 20; i++) model.adjust('zoom-in');
  assert.equal(model.transform.scale, MAX_SCALE); assert.equal(model.controls.enabled['zoom-in'], false);
  for (let i = 0; i < 20; i++) model.adjust('zoom-out');
  assert.deepEqual(model.transform, IDENTITY); assert.equal(model.controls.enabled['zoom-out'], false);
});

test('buttons move the photo by a quarter stage in the labelled direction and clamp at each edge', () => {
  const model = photo(); model.adjust('zoom-in'); model.adjust('zoom-in');
  model.adjust('left'); assert.equal(model.transform.x, -100);
  model.adjust('up'); assert.equal(model.transform.y, -150);
  model.adjust('left'); model.adjust('up');
  assert.deepEqual(model.transform, { scale: 2, x: -200, y: -300 });
  assert.equal(model.controls.enabled.left, false); assert.equal(model.controls.enabled.up, false);
  for (let i = 0; i < 8; i++) { model.adjust('right'); model.adjust('down'); }
  assert.deepEqual(model.transform, { scale: 2, x: 200, y: 300 });
  assert.equal(model.controls.enabled.right, false); assert.equal(model.controls.enabled.down, false);
  assert.equal(model.controls.enabled.left, true); assert.equal(model.controls.enabled.up, true);
});

test('letterboxed photos disable movement on axes with no overflow', () => {
  const landscape = photo({ width: 400, height: 600 }, { width: 1600, height: 400 });
  for (let i = 0; i < 6; i++) landscape.adjust('zoom-in');
  assert.equal(landscape.transform.scale, 4);
  assert.equal(landscape.controls.enabled.up, false); assert.equal(landscape.controls.enabled.down, false);
  assert.equal(landscape.controls.enabled.left, true);
  const portrait = photo({ width: 600, height: 400 }, { width: 400, height: 1600 });
  for (let i = 0; i < 6; i++) portrait.adjust('zoom-in');
  assert.equal(portrait.controls.enabled.left, false); assert.equal(portrait.controls.enabled.right, false);
  assert.equal(portrait.controls.enabled.up, true);
});

test('Zoom out preserves the stage-centre content point until edge clamping, and Reset returns exact fit', () => {
  const model = photo();
  for (let i = 0; i < 4; i++) model.adjust('zoom-in');
  model.adjust('left'); model.adjust('up');
  const before = { x: -model.transform.x / model.transform.scale, y: -model.transform.y / model.transform.scale };
  model.adjust('zoom-out');
  assert(Math.abs(-model.transform.x / model.transform.scale - before.x) < 1e-9);
  assert(Math.abs(-model.transform.y / model.transform.scale - before.y) < 1e-9);
  model.adjust('reset'); assert.deepEqual(model.transform, IDENTITY);
  assert.equal(model.controls.enabled.reset, false);
});

test('a button interruption consumes an active swipe and its late move/release cannot navigate', () => {
  const model = photo(); let navigations = 0;
  const responder = stageResponderConfig(model, {
    touches: e => e.nativeEvent.touches.map(t => ({ id: t.identifier, x: t.pageX, y: t.pageY })),
    show: () => {}, navigate: () => { navigations++; }, now: () => 0,
  });
  responder.onPanResponderGrant(event()); responder.onPanResponderMove(event(-200));
  assert.equal(model.swipeOffset, -200);
  model.adjust('zoom-in');
  responder.onPanResponderMove(event(-300)); responder.onPanResponderRelease(event(-300), { vx: -2 });
  assert.equal(navigations, 0); assert.equal(model.swipeOffset, 0); assert.equal(model.transform.scale, 1.5);
});

test('a control clears pending double-tap history; the next single tap does not toggle zoom', () => {
  const model = photo();
  model.begin([touch(0, 0)], 0); model.end(30, 0);
  model.adjust('zoom-in');
  model.begin([touch(0, 0)], 80); model.end(100, 0);
  assert.equal(model.transform.scale, 1.5);
});

test('pinch, button zoom, pan and reset all operate on the same transform', () => {
  const model = photo();
  model.begin([touch(-50, 0), touch(50, 0, 2)], 0);
  model.move([touch(-100, 0), touch(100, 0, 2)], 20); model.end(30, 0);
  assert.equal(model.transform.scale, 2);
  model.adjust('zoom-in'); model.adjust('right'); assert.deepEqual(model.transform, { scale: 2.5, x: 100, y: 0 });
  model.begin([touch(0, 0)], 100); model.move([touch(-50, 40)], 120); model.end(150, 0);
  assert.deepEqual(model.transform, { scale: 2.5, x: 50, y: 40 });
  model.adjust('reset'); assert.deepEqual(model.transform, IDENTITY);
});

test('settled-state reporter skips gesture frames and duplicate states, but reports controls immediately', () => {
  const model = photo(), reports: PhotoControlState[] = [];
  const report = stageControlReporter(model, state => reports.push(state));
  report(); report(); assert.equal(reports.length, 1);
  model.begin([touch(-50, 0), touch(50, 0, 2)], 0);
  for (let i = 0; i < 90; i++) { model.move([touch(-100, 0), touch(100, 0, 2)], i); report(); }
  assert.equal(reports.length, 1);
  model.end(100, 0); report(); assert.equal(reports.at(-1)!.percent, 200);
  model.adjust('zoom-in'); report(); assert.equal(reports.at(-1)!.percent, 250);
  model.adjust('reset'); report(); assert.equal(reports.at(-1)!.percent, 100);
  assert.equal(reports.length, 4);
});

test('width/content changes and memory replacement reset controls; height-only changes preserve bounded zoom', () => {
  const model = photo(); model.adjust('zoom-in'); model.adjust('left');
  model.layout({ width: 400, height: 500 }, { width: 400, height: 600 });
  assert.equal(model.controls.percent, 150);
  model.layout({ width: 600, height: 400 }, { width: 400, height: 600 });
  assert.deepEqual(model.transform, IDENTITY);
  model.adjust('zoom-in'); model.layout({ width: 600, height: 400 }, { width: 600, height: 400 });
  assert.deepEqual(model.transform, IDENTITY);
  model.adjust('zoom-in'); model.setZoomable(false); assert.equal(model.controls.ready, false);
  assert.deepEqual(photo().transform, IDENTITY); // The viewer remounts the stage for a new memory.
});

test('the enabled controls predict a real bounded transform change after mixed operations', () => {
  const model = photo({ width: 320, height: 480 }, { width: 600, height: 900 });
  const commands: PhotoAdjustment[] = [...PHOTO_ADJUSTMENTS, 'zoom-in', 'zoom-in', 'left', 'left', 'up', 'zoom-out', 'right'];
  for (const command of commands) {
    const enabled = model.controls.enabled[command], before = { ...model.transform };
    model.adjust(command);
    assert.equal(JSON.stringify(before) !== JSON.stringify(model.transform), enabled);
    assert(model.transform.scale >= 1 && model.transform.scale <= 4);
  }
});

test('a control interrupts a pinch without reviving its lifted-finger pan, and a later fresh swipe still works', () => {
  const model = photo();
  model.begin([touch(-50, 0), touch(50, 0, 2)], 0);
  model.move([touch(-100, 0), touch(100, 0, 2)], 20);
  model.adjust('reset');
  model.touchesChanged([touch(100, 0, 2)], 30); model.move([touch(-200, 0, 2)], 40);
  assert.deepEqual(model.end(50, -3), { navigate: null, tapped: false });
  assert.deepEqual(model.transform, IDENTITY);
  model.begin([touch(0, 0)], 100); model.move([touch(-200, 0)], 120);
  assert.equal(model.end(150, -2).navigate, 'next');
});

test('opening a controls sheet can cancel tap history without changing the current photo pose', () => {
  const model = photo(); model.adjust('zoom-in'); model.adjust('left');
  model.begin([touch(0, 0)], 0); model.end(20, 0);
  const pose = { ...model.transform };
  model.cancel(); // GestureStageHandle.cancel, called before showing the modal.
  assert.deepEqual(model.transform, pose);
  model.begin([touch(0, 0)], 80); model.end(100, 0);
  assert.deepEqual(model.transform, pose, 'a tap after closing controls must not complete the older double tap');
});
