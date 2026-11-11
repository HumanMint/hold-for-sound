// Doppler curves: the pitch heard at the set from an aircraft flying past in a straight line at a
// steady speed, and the fit of that curve to tones found in the sound. Pure JavaScript with no DOM
// and no clock. hear.js fits the tones it traces with this, and listen.js draws what it fitted.
//
//   flyby(ms, { at, distance, speed }) → heard pitch over emitted pitch for sound arriving at `ms`
//       (epoch ms) from an aircraft whose closest approach, `distance` metres from the set at `speed`
//       m/s, is heard at `at` (epoch ms). It is 1 at `at`, higher before and lower after.
//   fit(points, { speed }) → { at, distance, speed, hz, rms, miss, seconds } or null
//       `points` are [{ at, hz, tone }]: a tone seen at `at` (epoch ms) at `hz`, with `tone` saying
//       which of several tones it is (0, 1, ...). One flyby is fitted to all of them, each tone with
//       its own emitted pitch (`hz[tone]`). With `speed` (m/s, from the feed) only the time and the
//       distance are fitted: from a curve alone speed and distance trade off against each other unless
//       both flat ends of it were heard. With none, the speed is fitted too, between SLOWEST and
//       FASTEST. The closest approach is looked for from SEARCH s before the first point to SEARCH s
//       after the last. `rms` is how far the points are from the fitted curve, in Hz,
//       and `miss` the same in spectrogram bins (48 to the octave), which does not grow with pitch.
//       `seconds` is how long the points cover. null when there is too little to fit: fewer than
//       MIN_POINTS points, or a pitch that hardly moves.
//   kind(hz, fundamental) → 'propeller', 'jet' or null: a hint from what the tones are, given their
//       emitted pitches and the note they are harmonics of (hear.js works that out), or null for none.
//   after(ms, { at, distance, speed }) → epoch ms: when sound comes from as far away going out as it
//       did at `ms` coming in, for how long a pass first heard at `ms` may last.
//
// shortcut: the flight is taken to be straight and level at a steady speed through the part of the
// curve that was heard. An aircraft slowing on final, turning, or changing power (which moves a
// propeller's pitch too) bends the curve in ways this reads as a different time or distance.
// shortcut: every threshold here is a guess, set from synth.js and three logged passes beside an
// airport.

export const SOUND_MS = 343; // as in predict.js
const BPO = 48; // bins per octave, as in hear.js
export const MIN_POINTS = 12;
const MOVE = 2; // bins the pitch has to move for a curve to say anything
const MOST = 40; // points the coarse search looks at; the rest only refine it
const SEARCH = 12; // s before the first point and after the last that the closest approach is looked for
const SLOWEST = 15; // m/s: the speeds a fit with no speed given may come out at
const FASTEST = 160;

// Heard over emitted pitch. Sound arriving `t` seconds after the closest approach is heard left the
// aircraft `tau` seconds after it was closest, where t + d/c = tau + r(tau)/c and r² = d² + (v tau)²,
// which solves exactly: (c² - v²) tau² - 2 c² T tau + c² T² - d² = 0, with T = t + d/c.
function shift(t, d, v) {
  const c = SOUND_MS;
  const T = t + d / c;
  const tau = (c * c * T - c * Math.sqrt(v * v * T * T + (c * c - v * v) * (d * d) / (c * c))) / (c * c - v * v);
  const r = c * (T - tau);
  return r > 0 ? 1 / (1 + (v * v * tau) / (r * c)) : 1;
}

export const flyby = (ms, { at, distance, speed }) => shift((ms - at) / 1000, distance, speed);

// When sound arrives from as far away on the way out as the aircraft was when `ms` was heard on the
// way in (epoch ms): a pass that began to be heard at `ms` might be expected to fade about then. `ms`
// itself if that was already on the way out.
// shortcut: as loud going away as coming in at the same distance, which a jet's roar is not.
export function after(ms, { at, distance, speed }) {
  const c = SOUND_MS;
  const T = (ms - at) / 1000 + distance / c;
  const tau = (c * c * T - c * Math.sqrt(speed * speed * T * T + ((c * c - speed * speed) * distance * distance) / (c * c))) / (c * c - speed * speed);
  if (tau >= 0) return ms;
  const r = c * (T - tau);
  return at + (Math.sqrt(Math.max(0, r * r - distance * distance)) / speed + r / c - distance / c) * 1000;
}

// How badly a curve with closest approach at `t0` (s), `w` = distance / speed (s) and speed `v` fits
// the points, in bins squared on average, each tone given the emitted pitch that suits it best.
// `out` gets each tone's emitted pitch in bins. The closest approach is kept within `span`.
const model = new Float64Array(4096);
const sum = new Float64Array(64);
const count = new Uint16Array(64);
function miss(pts, tones, t0, w, v, span, out = sum) {
  if (!(w > 0.2 && w < 200 && v > 3 && v < 0.8 * SOUND_MS && t0 > span[0] && t0 < span[1])) return Infinity;
  const d = w * v;
  out.fill(0, 0, tones);
  count.fill(0, 0, tones);
  for (let i = 0; i < pts.length; i++) {
    model[i] = BPO * Math.log2(shift(pts[i].t - t0, d, v));
    out[pts[i].tone] += pts[i].b - model[i];
    count[pts[i].tone]++;
  }
  for (let k = 0; k < tones; k++) out[k] /= count[k] || 1;
  let e = 0;
  for (let i = 0; i < pts.length; i++) e += (pts[i].b - model[i] - out[pts[i].tone]) ** 2;
  return e / pts.length;
}

// Nelder and Mead's simplex, for a few parameters.
function simplex(f, start, steps, rounds) {
  let s = [start, ...steps.map((step, i) => start.map((x, j) => (j === i ? x + step : x)))].map((x) => ({ x, f: f(x) }));
  const n = start.length;
  for (let r = 0; r < rounds; r++) {
    s.sort((a, b) => a.f - b.f);
    const mid = start.map((_, j) => s.slice(0, n).reduce((sum, p) => sum + p.x[j], 0) / n);
    const worst = s[n];
    const toward = (k) => mid.map((m, j) => m + k * (m - worst.x[j]));
    const r1 = toward(1);
    const f1 = f(r1);
    if (f1 < s[0].f) {
      const r2 = toward(2);
      const f2 = f(r2);
      s[n] = f2 < f1 ? { x: r2, f: f2 } : { x: r1, f: f1 };
    } else if (f1 < s[n - 1].f) s[n] = { x: r1, f: f1 };
    else {
      const r3 = toward(-0.5);
      const f3 = f(r3);
      if (f3 < worst.f) s[n] = { x: r3, f: f3 };
      else s = s.map((p, i) => (i ? { x: p.x.map((x, j) => s[0].x[j] + 0.5 * (x - s[0].x[j])) } : p)).map((p) => (p.f === undefined ? { ...p, f: f(p.x) } : p));
    }
  }
  return s.sort((a, b) => a.f - b.f)[0];
}

export function fit(points, { speed = null } = {}) {
  if (points.length < MIN_POINTS || points.length > model.length) return null;
  const from = Math.min(...points.map((p) => p.at));
  const tones = Math.max(...points.map((p) => p.tone)) + 1;
  if (tones > sum.length) return null;
  const all = points.map((p) => ({ t: (p.at - from) / 1000, b: BPO * Math.log2(p.hz), tone: p.tone }));
  // Each tone's pitch has to move, or the points could be any steady tone.
  const moved = Math.max(...Array.from({ length: tones }, (_, k) => {
    const b = all.filter((p) => p.tone === k).map((p) => p.b);
    return b.length ? Math.max(...b) - Math.min(...b) : 0;
  }));
  if (moved < MOVE) return null;
  const span = Math.max(...all.map((p) => p.t));
  const reach = [-SEARCH, span + SEARCH];
  const few = all.length > MOST ? all.filter((_, i) => i % Math.ceil(all.length / MOST) === 0) : all;
  // A coarse look over every closest approach from SEARCH s before the first point to SEARCH s after
  // the last, every likely distance/speed and, unless it is known, every likely speed; then refined.
  const speeds = speed ? [speed] : [24, 36, 54, 80, 120];
  let best = { f: Infinity };
  for (let t0 = 1 - SEARCH; t0 < span + SEARCH; t0 += 1.5)
    for (let w = 1; w < 60; w *= 1.5)
      for (const v of speeds) {
        const f = miss(few, tones, t0, w, v, reach);
        if (f < best.f) best = { f, x: [t0, Math.log(w), Math.log(v)] };
      }
  if (best.f === Infinity) return null;
  const known = speed != null;
  const cost = (x) => (known || (x[2] > Math.log(SLOWEST) && x[2] < Math.log(FASTEST)) ? miss(all, tones, x[0], Math.exp(x[1]), known ? speed : Math.exp(x[2]), reach) : Infinity);
  const start = known ? best.x.slice(0, 2) : best.x;
  const done = simplex(cost, start, known ? [0.75, 0.2] : [0.75, 0.2, 0.2], known ? 60 : 100);
  const [t0, lw, lv] = done.x;
  const v = known ? speed : Math.exp(lv);
  const w = Math.exp(lw);
  const emitted = new Float64Array(tones);
  const f = miss(all, tones, t0, w, v, reach, emitted);
  let hz2 = 0;
  for (const p of all) {
    const heard = 2 ** ((BPO * Math.log2(shift(p.t - t0, w * v, v)) + emitted[p.tone]) / BPO);
    hz2 += (heard - 2 ** (p.b / BPO)) ** 2;
  }
  const r = (x, by = 1) => Math.round(x * by) / by;
  return {
    at: Math.round(from + t0 * 1000),
    distance: Math.round(w * v),
    speed: r(v, 10),
    hz: Array.from(emitted, (b) => r(2 ** (b / BPO), 10)),
    rms: r(Math.sqrt(hz2 / all.length), 100),
    miss: r(Math.sqrt(f), 100),
    seconds: r(span, 10),
  };
}

// Propeller blades passing give a low note with its harmonics; a jet's tones are the whine of its
// fans and compressors, high and few, over a roar. So: two or more tones on a series whose note is
// under 300 Hz is a propeller; tones that are all 300 Hz or more and on no series is a jet.
// shortcut: a guess from one propeller and two jets heard beside an airport. A helicopter's tail rotor
// can make a series that reads as a propeller, and a jet's fan can have a harmonic.
export function kind(hz, fundamental) {
  if (!hz.length) return null;
  const on = fundamental ? hz.filter((f) => Math.abs(f / fundamental - Math.round(f / fundamental)) < 0.015 * Math.round(f / fundamental)).length : 0;
  if (fundamental && fundamental >= 40 && fundamental < 300 && on >= 2) return 'propeller';
  if (!fundamental && hz.every((f) => f >= 300)) return 'jet';
  return null;
}
