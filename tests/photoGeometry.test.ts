import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchingAspect } from '../src/domain/photoGeometry.ts';
test('overlay alignment accepts proportional resolutions without stretching', () => {
  assert.equal(matchingAspect({ width: 600, height: 800 }, { width: 300, height: 400 }), true);
  assert.equal(matchingAspect({ width: 600, height: 800 }, { width: 800, height: 600 }), false);
  assert.equal(matchingAspect({ width: 0, height: 800 }, { width: 300, height: 400 }), false);
  assert.equal(matchingAspect({ width: Infinity, height: 800 }, { width: 300, height: 400 }), false);
});
