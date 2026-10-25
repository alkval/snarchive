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

test('Back during a media drag cancels that drag: its later moves and release neither reopen details nor close the viewer', () => {
  const { model, state, finish } = sheet();
  model.stageDrag(-150); assert.equal(model.phase, 'dragging');
  model.close(); // Back while the finger is still on the media.
  model.stageDrag(-300); assert.equal(model.phase, 'closed', 'later moves are ignored');
  assert.equal(model.release('up'), true, 'its release is consumed, not reopening and not closing the viewer');
  model.stageDrag(null); finish();
  assert.deepEqual(state, { offset: 800, mounted: false, open: false });
  assert.equal(model.phase, 'closed');
});

test('after the cancelled drag ends, a new gesture may interrupt the close and open details again', () => {
  const { model, state, finish } = sheet();
  model.stageDrag(-150); model.close(); model.stageDrag(-200); model.stageDrag(null);
  model.stageDrag(-100); assert.equal(model.phase, 'dragging', 'a genuinely new drag takes over the closing sheet');
  finish(); assert.equal(state.mounted, true, 'the stopped close does not unmount it');
  assert.equal(model.release('up'), true); model.stageDrag(null); finish();
  assert.deepEqual(state, { offset: 0, mounted: true, open: true });
  model.release('down'); // A plain release down is not consumed after the cancelled drag ended.
  assert.equal(new DetailsSheet({ set() {}, animate() {}, stop() {}, mount() {}, opened() {} }, 800).release('down'), false);
});

test('Done while the media drag that opened the sheet is still settling does not let it reopen', () => {
  const { model, state, finish } = sheet();
  model.stageDrag(-400); model.release('up'); // Opened by release; the end of that drag is reported next.
  model.close(); model.stageDrag(null); finish();
  assert.deepEqual(state, { offset: 800, mounted: false, open: false });
});

test('rotation during a close retargets it to the new screen height, so it never unmounts part-way on screen', () => {
  const { model, state, finish } = sheet(400); // Landscape.
  model.open(); finish(); model.close();
  model.resize(900); // Portrait: the old target (400) would stop short of the new bottom.
  finish();
  assert.deepEqual(state, { offset: 900, mounted: false, open: false });
});

test('rotation keeps a dragged sheet at the same distance from the new bottom and leaves an open sheet open', () => {
  const { model, state, finish } = sheet(800);
  model.stageDrag(-200); assert.equal(state.offset, 600);
  model.resize(400); assert.equal(state.offset, 200);
  model.release('up'); model.stageDrag(null); finish(); model.resize(800);
  assert.deepEqual(state, { offset: 0, mounted: true, open: true });
});
