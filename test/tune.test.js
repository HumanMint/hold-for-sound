import test from 'node:test';
import assert from 'node:assert/strict';
import { tune, remember } from '../public/tune.js';

// Observations as hear.js files them, cut down to what tuning reads.
const heard = (category, floor, more) => ({ hex: 'abc123', category, how: 'envelope', heard: true, confidence: 0.75, predPeak: floor + 12, floor, ...more });
const unheard = (category, predPeak) => ({ hex: 'abc123', category, how: 'unheard', heard: false, confidence: 0.7, predPeak, floor: null });
const spread = [38, 39, 40, 41, 42, 43, 44, 45, 46].map((floor) => heard('A3', floor));

test('there is no floor until four passes have been heard, however many went unheard', () => {
  assert.deepEqual(tune([]), { floor: null, trim: {}, passes: 0, heard: 0, unheard: 0, error: null, settled: false, early: false });
  assert.equal(tune(spread.slice(0, 3)).floor, null);
  assert.equal(tune([...spread.slice(0, 3), ...Array(20).fill(unheard('A3', 60))]).floor, null); // a muted microphone hears nothing too
  const four = tune(spread.slice(0, 4));
  assert.equal(four.floor, 39.5);
  assert.equal(four.settled, false);
});

test('before four, two heard passes may lower the user\'s level, and never raise it', () => {
  // A sound stage chosen for a microphone at an open window: aircraft are heard 7 dB and more under the level.
  assert.equal(tune([heard('A3', 12.7)], 20).floor, null, 'one pass is not enough');
  assert.equal(tune([heard('A3', 12.7), heard('A3', 9)], 20).floor, 12.7, 'two lower it, as far as the higher of them says');
  assert.equal(tune([heard('A3', 12.7), heard('A3', 24)], 20).floor, null, 'not when one of them puts it higher');
  assert.equal(tune([heard('A3', 18.5), heard('A3', 12)], 20).floor, null, 'nor by under 2 dB');
  assert.equal(tune([heard('A3', 12.7), heard('A3', 9)]).floor, null, 'nor with no level to lower');
  assert.equal(tune([heard('A3', 12.7), ...Array(9).fill(unheard('A3', 60))], 20).floor, null, 'unheard aircraft count for nothing');
  const t = tune(spread.slice(0, 3), 60);
  assert.deepEqual([t.floor, t.heard, t.error, t.settled], [40, 3, null, false]);
  assert.equal(tune(spread.slice(0, 4), 30).floor, 39.5, 'from four the floor is what they say, above the level or not');
});

test('the floor is the middle of what the heard passes say, and says how sure it is', () => {
  const t = tune(spread);
  assert.equal(t.floor, 42);
  assert.deepEqual([t.passes, t.heard, t.unheard], [9, 9, 0]);
  assert.ok(t.error > 1 && t.error <= 2 && t.settled, `error ${t.error}`);
  assert.equal(tune([...spread, heard('A3', 95)]).floor, 42.5); // a wild pass counts as one pass, not as 50 dB
  const scattered = tune(spread.map((o, i) => ({ ...o, floor: 42 + (i - 4) * 5 })));
  assert.ok(scattered.floor === 42 && !scattered.settled, 'passes that disagree by many dB are not settled');
});

test('aircraft that went unheard are counted and never move the floor, however many', () => {
  // A covered or unplugged microphone hears nothing either: silence must not make the page warn less.
  for (const n of [3, 6, 60]) {
    const t = tune([...spread, ...Array(n).fill(unheard('A3', 70))]);
    assert.deepEqual([t.floor, t.heard, t.unheard, t.settled], [42, 9, n, true]);
  }
  // And a long deaf day does not push the heard passes out of what is kept.
  const kept = remember(spread, Array(500).fill(unheard('A3', 70)));
  assert.deepEqual([tune(kept).floor, tune(kept).heard, tune(kept).unheard], [42, 9, 20]);
});

test('a category gets its own trim only with five heard passes that differ by 2 dB or more', () => {
  const jets = [41, 41.5, 42, 42, 42, 42.5, 43, 43].map((floor) => heard('A3', floor));
  const props = [35, 36, 36, 36.5, 37].map((floor) => heard('A1', floor)); // audible at a lower prediction: louder than predicted
  assert.deepEqual(tune([...jets, ...props.slice(0, 4)]).trim, {});
  const t = tune([...jets, ...props]);
  assert.equal(t.floor, 41.5); // the middle of all thirteen
  assert.deepEqual(t.trim, { A1: 6 });
  assert.deepEqual(tune([...jets, ...props.map((o) => ({ ...o, floor: o.floor + 5 }))]).trim, {}); // 1 dB apart: within the noise
  assert.deepEqual(tune([...jets, ...props.map((o) => ({ ...o, floor: o.floor - 30 }))]).trim, { A1: 12 }); // and never more than 12
});

test('only confident passes about a known aircraft are stored, and only the newest 80', () => {
  const unsure = { ...heard('A3', 90), how: 'unsure', heard: null, confidence: 0.2 };
  const unexplained = { hex: null, category: null, how: 'unexplained', heard: true, confidence: 0, predPeak: null, floor: null };
  assert.deepEqual(remember(spread, [unsure, unexplained, heard('A3', 90, { confidence: 0.3 })]), spread);
  // Heard for certain, but with another aircraft too close to say how loud it was: hear.js leaves the floor out.
  const overlapped = { ...heard('A1', null), how: 'doppler', confidence: 1 };
  assert.deepEqual(remember(spread, [overlapped]), spread);
  assert.equal(tune([...spread, overlapped]).heard, 9);
  const many = Array.from({ length: 100 }, (_, i) => heard('A3', i));
  const kept = remember(spread, many);
  assert.equal(kept.length, 80);
  assert.equal(kept.at(-1).floor, 99);
  assert.equal(tune([...spread, unsure, unexplained]).floor, 42);
});
