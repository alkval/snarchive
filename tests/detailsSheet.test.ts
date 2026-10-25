import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DetailsSheet } from '../src/domain/detailsSheet.ts';

/** Records the sheet's effects; animations stay pending until `finish` runs them (or a later one replaces them). */
function sheet(height = 800) {
  const state = { offset: height, mounted: false, open: false };
  let pending: { to: number; done?: () => void } | null = null;
  const model = new DetailsSheet({
    set: offset => { pending = null; state.offset = offset; },
    animate: (to, done) => { pending = { to, done }; },
    stop: () => { pending = null; },
    mount: mounted => { state.mounted = mounted; },
    opened: open => { state.open = open; },
  }, height);
  const finish = () => { const run = pending; pending = null; if (run) { state.offset = run.to; run.done?.(); } };
  return { model, state, finish };
}

test('Back during an active sheet drag wins: later moves and the release cannot bring the sheet back', () => {
  const { model, state, finish } = sheet();
  model.open(); finish();
  model.sheetDrag(40); assert.equal(state.offset, 40);
  model.close(); // Back or Done while the finger is still down.
  model.sheetDrag(60); model.sheetRelease(false);
  finish();
  assert.deepEqual(state, { offset: 800, mounted: false, open: false }, 'closed, unmounted, not left visible');
  assert.equal(model.phase, 'closed');
});

test('a close followed by a terminated sheet drag (restore) leaves it closed', () => {
  const { model, state, finish } = sheet();
  model.open(); finish(); model.sheetDrag(30);
  model.close(); model.sheetRelease(false); finish();
  assert.equal(state.mounted, false); assert.equal(state.open, false); assert.equal(state.offset, 800);
});

test('the sheet follows a media drag up, drops back when released short, and opens past the threshold', () => {
  const { model, state, finish } = sheet();
  model.stageDrag(5); assert.equal(state.mounted, false, 'a drag down starts nothing');
  model.stageDrag(-200); assert.equal(state.offset, 600); assert.equal(state.mounted, true); assert.equal(state.open, false);
  model.stageDrag(50); assert.equal(state.offset, 800, 'back below the start: fully closed, still mounted');
  model.stageDrag(null); finish(); assert.equal(state.mounted, false);
  model.stageDrag(-300); assert.equal(model.release('up'), true); model.stageDrag(null); finish();
  assert.deepEqual(state, { offset: 0, mounted: true, open: true }, 'the end of the opening drag does not close it');
});

test('a drag up that returns down drops the sheet instead of closing the viewer; a plain drag down closes the viewer', () => {
  const { model, finish, state } = sheet();
  model.stageDrag(-100); assert.equal(model.release('down'), true); finish(); assert.equal(state.mounted, false);
  assert.equal(model.release('down'), false);
});

test('reopening during a close animation keeps the sheet mounted', () => {
  const { model, state, finish } = sheet();
  model.open(); finish(); model.close();
  model.stageDrag(-100); // A new drag stops the close animation and takes over.
  finish(); assert.equal(state.mounted, true); assert.equal(model.phase, 'dragging');
  model.open(); model.close(); model.open(); finish();
  assert.deepEqual(state, { offset: 0, mounted: true, open: true });
});

test('media drags are ignored while open; sheet drags are ignored unless open', () => {
  const { model, state, finish } = sheet();
  model.sheetDrag(100); assert.equal(state.offset, 800);
  model.open(); finish(); model.stageDrag(-50); assert.equal(state.offset, 0);
  model.sheetDrag(-30); assert.equal(state.offset, 0, 'never above the open position');
  model.sheetDrag(120); model.sheetRelease(true); finish(); assert.equal(state.mounted, false);
});
