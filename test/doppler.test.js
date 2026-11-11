import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { flyby, fit, kind, after, SOUND_MS } from '../public/doppler.js';
import { trace, FMIN } from '../public/hear.js';

// Invented curves with known answers. None of this is a real aircraft through a real microphone.

const START = 1_800_000_000_000;
const pass = { at: START + 30_000, distance: 400, speed: 50 };
// Where tones of `hz` (a list) from `pass` are heard, every eighth of a second between two times (s
// from its closest approach), each off by up to `jitter` of itself, the same way every run.
function points(pass, hz, from, to, jitter = 0.003) {
  const out = [];
  let n = 0;
  for (let t = from; t <= to; t += 0.125) {
    const at = pass.at + t * 1000;
    hz.forEach((f, tone) => out.push({ at, hz: f * flyby(at, pass) * (1 + jitter * Math.sin(n++ * 2.4)), tone }));
  }
  return out;
}

test('a flyby is heard high coming in, at its own pitch as it passes, and low going away', () => {
  assert.equal(flyby(pass.at, pass), 1);
  const c = SOUND_MS;
  const v = pass.speed;
  assert.ok(Math.abs(flyby(pass.at - 600_000, pass) - c / (c - v)) < 0.002, 'far off and coming straight in: c / (c - v)');
  assert.ok(Math.abs(flyby(pass.at + 600_000, pass) - c / (c + v)) < 0.002, 'and going straight away: c / (c + v)');
  let last = Infinity;
  for (let t = -60; t <= 60; t += 0.5) {
    const f = flyby(pass.at + t * 1000, pass);
    assert.ok(f < last, 'it only ever falls');
    last = f;
  }
  // A nearer pass at the same speed falls faster.
  const near = { ...pass, distance: 100 };
  assert.ok(flyby(pass.at + 3000, near) < flyby(pass.at + 3000, pass));
});

test('a whole pass with two harmonics gives back when, how near, how fast and the note', () => {
  const free = fit(points(pass, [120, 240], -15, 20));
  assert.ok(Math.abs(free.at - pass.at) < 300, `closest approach ${(free.at - pass.at) / 1000} s off`);
  assert.ok(Math.abs(free.distance / pass.distance - 1) < 0.1, `distance ${free.distance} m`);
  assert.ok(Math.abs(free.speed / pass.speed - 1) < 0.1, `speed ${free.speed} m/s`);
  assert.ok(Math.abs(free.hz[0] - 120) < 1 && Math.abs(free.hz[1] - 240) < 2, `notes ${free.hz}`);
  assert.ok(free.rms < 1.5 && free.miss < 0.3, `fits within ${free.rms} Hz`);
  assert.equal(free.seconds, 35);
});

test('a few seconds through the closest approach need the speed from the feed', () => {
  // A jet's whine is heard for a few seconds as it passes, as two did on a logged session. Given the speed, the
  // time and distance come out; without it, distance and speed trade off.
  const jet = { at: START + 30_000, distance: 380, speed: 64 };
  const short = points(jet, [380], -3, 3, 0.002);
  const known = fit(short, { speed: 64 });
  assert.ok(Math.abs(known.at - jet.at) < 500, `closest approach ${(known.at - jet.at) / 1000} s off`);
  assert.ok(Math.abs(known.distance / jet.distance - 1) < 0.15, `distance ${known.distance} m`);
  assert.equal(known.speed, 64);
  const loose = fit(short);
  assert.ok(Math.abs(loose.at - jet.at) < 1000, 'the moment it passed is still pinned');
  assert.ok(Math.abs(loose.distance / loose.speed - jet.distance / jet.speed) < 1.5, 'and distance over speed, but not each');
});

test('nothing is fitted to a steady tone or to too little', () => {
  const steady = Array.from({ length: 40 }, (_, i) => ({ at: START + i * 125, hz: 120 * (1 + 0.001 * Math.sin(i)), tone: 0 }));
  assert.equal(fit(steady), null);
  assert.equal(fit(points(pass, [120], 0, 1)), null, 'nine points');
});

test('a tone traced through clutter is fitted as the flyby it came from (fixture)', () => {
  const { truth, cols } = JSON.parse(readFileSync(new URL('./fixtures/curve.json', import.meta.url)));
  const groups = trace(cols);
  assert.equal(groups.length, 1, 'the whine, and not the hum (it does not bend) or the clutter (it jumps about)');
  const pts = groups[0].flatMap((run, tone) => run.map(({ i, b }) => ({ at: cols[i].at, hz: FMIN * 2 ** (b / 48), tone })));
  const f = fit(pts, { speed: truth.speed });
  assert.ok(Math.abs(f.at - truth.at) < 700, `closest approach ${(f.at - truth.at) / 1000} s off`);
  assert.ok(Math.abs(f.distance / truth.distance - 1) < 0.2, `distance ${f.distance} m`);
  assert.ok(Math.abs(f.hz[0] / truth.hz - 1) < 0.01, `note ${f.hz[0]} Hz`);
});

test('a propeller is a low note with harmonics, a jet high tones on no series', () => {
  assert.equal(kind([126, 252, 378], 126), 'propeller');
  assert.equal(kind([252, 378], 126), 'propeller', 'the note itself need not be heard');
  assert.equal(kind([383], null), 'jet');
  assert.equal(kind([1094, 3374], null), 'jet');
  assert.equal(kind([126], null), null, 'one low tone could be either');
  assert.equal(kind([], null), null);
  assert.equal(kind([600, 1200], 600), null, 'a series on a high note is neither');
});

test('a pass first heard coming in is expected to fade as far away going out', () => {
  const heard = pass.at - 20_000;
  const fade = after(heard, pass);
  // How far away it was: the range whose sound arrives `heard`, coming in and going out.
  const range = (ms, sign) => {
    let lo = 0;
    let hi = 60;
    for (let n = 0; n < 60; n++) {
      const tau = (lo + hi) / 2; // seconds from closest approach, as emitted
      const r = Math.hypot(pass.distance, pass.speed * tau);
      const arrives = pass.at + (sign * tau + (r - pass.distance) / SOUND_MS) * 1000;
      if ((arrives - ms) * sign > 0) hi = tau;
      else lo = tau;
    }
    return Math.hypot(pass.distance, pass.speed * lo);
  };
  assert.ok(Math.abs(range(heard, -1) - range(fade, 1)) < 5, `${range(heard, -1)} m in, ${range(fade, 1)} m out`);
  assert.ok(fade - pass.at > pass.at - heard, 'later after than before: going away, its sound is drawn out');
  assert.equal(after(pass.at + 5000, pass), pass.at + 5000, 'first heard going away: nothing to add');
});
