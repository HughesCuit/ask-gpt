import test from 'node:test';
import assert from 'node:assert/strict';
import { chipLooksSelected, thinkingMeta } from '../src/thinking-state.mjs';

test('chipLooksSelected: already-on via aria-pressed', () => {
  assert.equal(chipLooksSelected({ text: 'Think', pressed: 'true' }), true);
  assert.equal(chipLooksSelected({ text: 'Think', pressed: 'on' }), true);
});

test('chipLooksSelected: unverified click is not selected', () => {
  assert.equal(chipLooksSelected({ text: 'Think', pressed: null, hasActiveClass: false }), false);
  assert.equal(chipLooksSelected(null), false);
});

test('chipLooksSelected: ancestor selected or active class', () => {
  assert.equal(chipLooksSelected({ selectedAttr: 'ancestor' }), true);
  assert.equal(chipLooksSelected({ hasActiveClass: true }), true);
});

test('thinkingMeta: enabled only when verified', () => {
  const clickedUnverified = thinkingMeta({
    ok: true,
    verified: false,
    method: 'dom-click-unverified',
    requested: true,
    detail: { text: 'Think' },
  });
  assert.equal(clickedUnverified.thinking_clicked, true);
  assert.equal(clickedUnverified.thinking_enabled, false);

  const verified = thinkingMeta({
    ok: true,
    verified: true,
    method: 'dom-click-verified',
    requested: true,
    detail: { text: 'Think', pressed: 'true' },
  });
  assert.equal(verified.thinking_enabled, true);
  assert.equal(verified.thinking_method, 'dom-click-verified');

  const skipped = thinkingMeta({ ok: false, verified: false, method: 'option-not-found' });
  assert.equal(skipped.thinking_enabled, false);
  assert.equal(skipped.thinking_requested, false);
});
