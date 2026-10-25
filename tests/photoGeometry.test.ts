import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchingAspect } from '../src/domain/photoGeometry.ts';
test('overlay alignment accepts proportional resolutions without stretching', () => {
  assert.equal(matchingAspect({ width: 600, height: 800 }, { width: 300, height: 400 }), true);
  assert.equal(matchingAspect({ width: 600, height: 800 }, { width: 800, height: 600 }), false);
  assert.equal(matchingAspect({ width: 0, height: 800 }, { width: 300, height: 400 }), false);
  assert.equal(matchingAspect({ width: Infinity, height: 800 }, { width: 300, height: 400 }), false);
});
test('small export rounding differences work in either orientation, while genuine canvas mismatches stay hidden', () => {
  assert.equal(matchingAspect({ width: 1080, height: 1920 }, { width: 720, height: 1276 }), true);
  assert.equal(matchingAspect({ width: 1920, height: 1080 }, { width: 1276, height: 720 }), true);
  assert.equal(matchingAspect({ width: 1080, height: 1920 }, { width: 600, height: 800 }), false);
});

import { videoDisplaySize, seekTarget, videoControlsReady } from '../src/domain/photoGeometry.ts';
test('video geometry applies container rotations before comparing overlays', () => {
  assert.deepEqual(videoDisplaySize(480, 640, 0), { width: 480, height: 640 });
  assert.deepEqual(videoDisplaySize(480, 640, 90), { width: 640, height: 480 });
  assert.deepEqual(videoDisplaySize(480, 640, 180), { width: 480, height: 640 });
  assert.deepEqual(videoDisplaySize(480, 640, 270), { width: 640, height: 480 });
  assert.equal(matchingAspect(videoDisplaySize(480, 640, 90)!, { width: 320, height: 240 }), true);
  assert.equal(videoDisplaySize(0, 640, 0), null);
  assert.equal(videoDisplaySize(480, 640, 45), null);
  assert.equal(videoDisplaySize(480, 640), null);
  assert.equal(videoDisplaySize(Infinity, 640, 0), null);
});
test('video seeking stays inside the media duration', () => {
  assert.equal(seekTarget(2, -5, 12), 0);
  assert.equal(seekTarget(10, 5, 12), 12);
  assert.equal(seekTarget(3, 5, 12), 8);
  assert.equal(seekTarget(3, 5, NaN), 0);
});

test('finished video remains seekable and restartable without enabling failed or unloaded media', () => {
  assert.equal(videoControlsReady('idle', 12), true);
  assert.equal(videoControlsReady('idle', 0), false);
  assert.equal(videoControlsReady('error', 12), false);
  assert.equal(videoControlsReady('loading', 12), false);
  assert.equal(videoControlsReady('readyToPlay', 12), true);
});
