import test from 'node:test';
import assert from 'node:assert/strict';
import { unheard, notHeard } from '../public/unheard.js';
import { status } from '../public/status.js';

const win = { hex: 'rotor1', category: 'A7', start: 0, end: 100_000 };
const sample = (at, extra = {}) => ({ status: { at, ready: true, signal: true, rise: 0, heard: [], ...extra } });
function run(known, from = 0, to = 20_000, windows = [win]) {
  let ids;
  for (let now = from; now <= to; now += 1000) ids = unheard(known, windows, now, sample(now));
  return ids;
}

test('waits for 20 seconds of quiet after the audible start, including sound travel', () => {
  const known = new Map();
  assert.deepEqual(run(known, 0, 19_000), []);
  assert.deepEqual(run(known, 20_000, 20_000), ['rotor1']);
  const later = { ...win, start: 10_000 };
  assert.deepEqual(run(new Map(), 0, 29_000, [later]), []);
});

test('a rise, noise or any attribution restores and latches the hold for this window', () => {
  for (const rise of [{ rise: 3 }, { noise: true }, { heard: [{ hex: 'other' }] }]) {
    const known = new Map();
    run(known);
    assert.deepEqual(unheard(known, [win], 21_000, sample(21_000, rise)), []);
    assert.deepEqual(run(known, 22_000, 60_000), []);
    unheard(known, [], 61_000, sample(61_000));
    assert.deepEqual(run(known, 62_000, 82_000), ['rotor1']);
  }
});

test('demo, stale, startup, missing signal, missing audio and interrupted listening give no negative evidence', () => {
  for (const bad of [
    { ...sample(21_000), demo: true }, { ...sample(21_000), stale: true },
    sample(21_000, { ready: false }), sample(21_000, { signal: false }),
    sample(21_000, { rise: null }), sample(18_000), sample(22_000), null,
  ]) {
    const known = new Map();
    run(known);
    assert.deepEqual(unheard(known, [win], 21_000, bad), []);
    assert.deepEqual(run(known, 22_000, 41_000), []);
  }
  const known = new Map();
  run(known);
  assert.deepEqual(unheard(known, [win], 24_000, sample(24_000)), []);
});

test('never downgrades estimates, uncertain windows, jets or future windows', () => {
  for (const w of [{ ...win, lost: true }, { ...win, unsure: true }, { ...win, category: 'A3' }, { ...win, start: 50_000 }]) {
    assert.deepEqual(run(new Map(), 0, 40_000, [w]), []);
    assert.deepEqual(notHeard([w], { at: 20_000, hexes: ['rotor1'] }, 20_000), [w]);
  }
});

test('downgrade means heads-up, another hold wins, old feed stays unknown and evidence expires', () => {
  const evidence = { at: 20_000, hexes: ['rotor1'] };
  const windows = notHeard([win], evidence, 20_000);
  assert.equal(status(windows, 20_000, 20_000).state, 'soon');
  assert.equal(status(windows, 50_000, 0).state, '');
  assert.equal(status([...windows, { ...win, hex: 'jet001', category: 'A3' }], 20_000, 20_000).state, 'hold');
  assert.equal(status(notHeard([win], evidence, 22_001), 22_001, 22_001).state, 'hold');
  assert.equal(status(notHeard([win], evidence, 19_000), 19_000, 19_000).state, 'hold');
  assert.equal(win.notHeard, undefined);
});
