import test from 'node:test';
import assert from 'node:assert/strict';
import { widen, LATE_S } from '../public/widen.js';
import { status, steady } from '../public/status.js';

const T0 = 1_800_000_000_000;
// A window as follow() gives it at a poll `s` seconds in, for sound heard from `from` to `to` seconds in.
const win = (s, from, to, more = {}) => ({ hex: 'abc123', startS: from - s, endS: to - s, path: [{ t: 0, heardAt: 1, x: 1000, y: 0 }], ...more });
const at = (s) => T0 + s * 1000;

// The page's side, as app.js does it: a poll every 5 s widens what follow() gives, and the banner is
// worked out every second in between.
function page(timing) {
  const kept = new Map();
  let windows = [];
  let shown = null;
  return {
    poll(s, audible) {
      windows = widen(audible, at(s), timing, kept);
      return windows;
    },
    banner(s, polledAt) {
      shown = steady(status(windows, at(s), polledAt), at(s), shown, polledAt);
      return shown;
    },
  };
}

test('a window widened for a late feed holds to its widened end after the prediction drops it', () => {
  const timing = { offsets: { abc123: 15 }, lag: null };
  const p = page(timing);
  // Heard from 40 s to 73.7 s by the prediction; the feed has run 15 s late, so to 88.7 s.
  let announced = null;
  for (let s = 40; s <= 100; s++) {
    if (s % 5 === 0) p.poll(s, s < 73.7 ? [win(s, 40, 73.7)] : []); // gone from the prediction once its own end passes
    const b = p.banner(s, at(Math.floor(s / 5) * 5));
    if (s === 70) announced = b.until;
    if (s < 88.7) assert.equal(b.state, 'hold', `still holding at ${s} s`);
  }
  assert.equal(announced, at(88.7));
});

test('a newer window for the same aircraft never ends before the widened end announced', () => {
  const timing = { offsets: { abc123: 15 }, lag: null };
  const kept = new Map();
  assert.equal(widen([win(60, 40, 73.7)], at(60), timing, kept)[0].end, at(88.7));
  timing.offsets = {}; // the measurement is dropped
  const [w] = widen([win(65, 40, 74)], at(65), timing, kept);
  assert.equal(w.end, at(88.7));
  assert.equal(w.start, at(40));
  // Once that end has passed, nothing of it is kept.
  assert.deepEqual(widen([], at(89), timing, kept), []);
  assert.equal(kept.size, 0);
});

test('a kept window is re-timed to each poll, path and all', () => {
  const kept = new Map();
  widen([win(70, 40, 73.7)], at(70), { offsets: { abc123: 15 }, lag: null }, kept);
  const [w] = widen([], at(75), { offsets: {}, lag: null }, kept);
  assert.equal(w.end, at(88.7));
  assert.ok(Math.abs(w.endS - -1.3) < 1e-9);
  assert.equal(w.path[0].t, -5);
  assert.equal(w.path[0].heardAt, -4);
});

test('a window is widened only outwards, and by LATE_S at most', () => {
  const kept = new Map();
  const [late] = widen([win(0, 10, 20)], at(0), { offsets: { abc123: 40 }, lag: null }, kept);
  assert.deepEqual([late.start, late.end], [at(10), at(20 + LATE_S)]);
  kept.clear();
  const [early] = widen([win(0, 10, 20)], at(0), { offsets: {}, lag: -6 }, kept);
  assert.deepEqual([early.start, early.end], [at(4), at(20)]);
  assert.equal(kept.size, 0); // nothing was added to its end
});

test('an estimate is not widened, by its own offset or the lag', () => {
  const kept = new Map();
  for (const mark of [{ lost: true }, { lost: true, unsure: true }]) {
    const [w] = widen([win(0, 10, 20, mark)], at(0), { offsets: { abc123: 10 }, lag: 8 }, kept);
    assert.deepEqual([w.start, w.end], [at(10), at(20)]);
  }
  assert.equal(kept.size, 0);
});

test('an aircraft whose window turns unsure still holds to the widened end announced', () => {
  const kept = new Map();
  widen([win(60, 40, 73.7)], at(60), { offsets: { abc123: 15 }, lag: null }, kept);
  const ws = widen([win(65, 65, 80, { lost: true, unsure: true, path: [] })], at(65), { offsets: { abc123: 15 }, lag: null }, kept);
  assert.equal(ws.length, 1);
  assert.equal(ws[0].unsure, undefined);
  assert.equal(status(ws, at(85), at(65)).state, 'hold');
});
