// The listening engine: turns microphone audio plus the predicted tracks into facts about what is
// being heard. Pure JavaScript with no DOM, no Web Audio, no timers and no clock of its own (every
// time is passed in, in epoch ms), so it runs the same in the page, in a Web Worker, and under
// `node --test`. synth.js makes test audio for it and tune.js turns its observations into settings.
//
//   const ear = createEar({ sampleRate })      any rate from 16000 to 48000
//
//   ear.push(pcm, endMs) → [column, ...]       Feed mono audio: a Float32Array of any length and the
//       wall-clock time of its last sample. Returns the spectrogram columns it completed, 8 a second:
//       { at, db, above }. `at` is the middle of the quarter second the column describes. `db` and
//       `above` are Float32Arrays with one value per frequency bin: `db` is the level (dB below a
//       full-scale tone, uncalibrated) and `above` is `db` minus the usual level of that bin: the tone
//       detector looks at that, wherever it is above zero. The engine goes on using these arrays, so
//       read them but do not change them or transfer them out of a worker (copying is fine). A jump of
//       more than a second between blocks means the microphone stopped, and the engine starts learning
//       the background again. It does the same after 3 s at 10 dB or more under the background it knew
//       (turned down, covered, or the room went quiet), and for as long as it is given silence.
//   FREQS, BINS, FMIN, FMAX                    Centre frequency in Hz of each of the 304 bins. They are
//       log spaced, 48 to the octave, from 50 Hz to about 4 kHz: FREQS[b] = FMIN * 2 ** (b / 48).
//   ear.quiet                                  Float32Array(BINS): the usual level of each bin, in dB,
//       updated in place, though not while a noise is going on. This is the background as a spectrum;
//       `db - above` is the same thing.
//
//   ear.update({ at, tracks, trim, floor })    Pass every `hfs:update`: its `at`, its `tracks`, its
//       `floor`, and the `trim` that was in effect for those tracks (what was last sent in `hfs:tune`).
//       Aircraft predicted within 15 dB of `floor` are the ones it tries to match the sound to.
//
//   ear.status() → what is happening now, refreshed once a second of audio:
//     { at, ready, signal, level, background, rise, noise, expected, heard }
//       ready       false for the first 20 s, while it learns the background
//       signal      false while the microphone gives nothing: digital silence (110 dB or more under full
//                   scale), or mute(true). Nothing is heard or learned then, and `ready` is false.
//       level, background, rise   A-weighted, 50 Hz to 4 kHz, in dB. `rise` is how far the sound is
//                   above the background. Speech and bangs are smoothed out of it, which takes 6 s, so
//                   it describes the moment 3 s before `at`.
//       noise       true while the rise has stayed at or above 3 dB: something like an aircraft is audible
//       expected    [{ hex, level, swing }]: aircraft predicted loud enough to hear now. `level` is the
//                   prediction and `swing` is how much, in percent, its Doppler shift changed over the
//                   last 30 s. Tones can only be pinned on an aircraft while that is changing.
//       heard       [{ hex, how, confidence, candidates, tones, fundamental }], which is empty in quiet:
//                   how 'doppler'   tones slid along this aircraft's Doppler curve and nobody else's.
//                                   `tones` are their frequencies as emitted, in Hz, and `fundamental`
//                                   the note they are harmonics of (null if they are not a series).
//                   how 'envelope'  no tones, but only this aircraft's predicted loudness fits the timing.
//                   how 'level'     hex is null: aircraft-like noise that cannot be pinned on one track.
//                                   `candidates` lists the aircraft it could be. An empty list means no
//                                   predicted track explains it (no transponder, or not an aircraft).
//
//   ear.curve(hex, hz, fromMs, toMs, stepMs) → Float32Array   Where a tone emitted at `hz` by that
//       aircraft is heard over a stretch of past and future time, to draw on the spectrogram and ahead
//       of it. NaN where the aircraft has no track.
//
//   ear.observations() → [observation, ...]    Passes that finished since the last call. Plain JSON:
//     { at, hex, category, how, heard, confidence, predPeak, rise, floor, onsetErr, peakErr, seconds,
//       tones, fundamental, curve: { from, step, pred: [...], rise: [...] } }
//       at          when the predicted peak was due to be heard
//       how         'doppler' or 'envelope' (heard, as above), 'unheard' (predicted but nothing was
//                   audible), 'unsure' (noise that could not be pinned on this aircraft), or
//                   'unexplained' (hex null: aircraft-like noise that no expected aircraft explains)
//       heard       true, false, or null for 'unsure'
//       confidence  for a heard pass, how sure it is of which aircraft this was: never over 0.45 unless
//                   the pass has a `floor`, because tones or timing alone can be something else's. An
//                   unheard pass gets 0.7 once this engine has heard an aircraft, and 0.2 before that,
//                   or if the feed had lost the aircraft or the microphone is in doubt (below).
//       predPeak    the loudest it was predicted, on predict.js's scale with the trim taken out, and
//                   smoothed the way `rise` is, so a quick close pass reads a few dB under its true peak
//       rise        the most the sound rose above the background during the pass, in dB. For a heard
//                   pass with a `floor`, only while no other aircraft was predicted within 10 dB of it.
//       floor       this pass's estimate of the predicted level that is just audible here. null if it was
//                   not heard, and also if how loud it was could not be measured as its own: another
//                   aircraft was predicted within 10 dB of it at its peak, or the sound peaked at
//                   another moment than predicted, or did not rise and fall as predicted. Then `how`
//                   and `hex` still say who it seemed to be, and tune() passes the record by.
//       onsetErr, peakErr   seconds the sound was later (+) or earlier (-) than predicted, or null
//       curve       predicted level and measured rise side by side, one value every `step` ms
//     Store them with remember() from tune.js and pass the stored list to tune(). At most 200 wait here.
//
//   ear.forget()                               Start learning the background again, e.g. after the
//       microphone was moved. Tracks and finished observations are kept.
//   ear.mute(on)                               Tell it the microphone is muted (true) or back (false), when
//       the browser says so (a MediaStreamTrack's mute and unmute events). While muted it behaves as it
//       does for silence, whatever audio still arrives.
//
// What it will not learn from. The costly mistake is a false record that tune() trusts, so it prefers
// to say nothing: no record at all for a pass the microphone missed part of or that fell in the first
// 20 s of a background, 'unsure' for noise it cannot pin down, and no `floor`, with the confidence
// held under what tune() asks for, where two aircraft overlap or the loudness was not the aircraft's
// own. A session learns nothing from silence until it has heard an aircraft: one that goes unheard
// counts as evidence only after this engine has heard one and measured it (a pass with a `floor`,
// trusted). A new engine starts without that, so a page reopened with a covered or misrouted
// microphone cannot raise a floor learned earlier. It loses it again when the microphone comes back
// 10 dB or more quieter than it was (after silence, a stop, a sudden drop, or forget()).
//
// How it works: each quarter second of audio becomes one column of the spectrogram. Loudness is one
// number per column, A-weighted like the predictions. The level is the quietest tenth of the last 6 s
// of those, which drops speech and bangs (they have gaps) but keeps an aircraft's slow swell, and the
// background is the quietest fifth of the last 5 min of levels. For tones, every candidate aircraft's
// Doppler curve is known from its track, so the last 30 s of columns are slid back along that curve
// and averaged: tones from that aircraft pile up into sharp peaks, while a steady hum, or another
// aircraft's tones, smear out. Each bin's usual level is taken out first, so an old hum is invisible.
// A peak then has to pile up better along the curve than along any straight line through the places
// the tone is seen in the single columns: a motor's tone drifting at a steady rate crosses many a
// curve. With no tones, a swell is matched to a predicted loudness curve by its timing and shape,
// unless it is no swell (it switched on or off, or stayed put) or is mostly a hum. Either way, a pass
// is measured, and believed, only if its loudness peaked when that aircraft was predicted loudest.
//
// shortcut: every threshold in this file is a guess that has only met synth.js, never a real aircraft
// through a real phone; revisit them all once there are recordings from a set.
// shortcut: the track's timing is trusted. With synth.js, a feed 2 s late changes nothing; at 3 s
// tones are matched too briefly to be trusted, and at 4 s about half the passes are heard but not
// measured. Search over a time offset per aircraft if real feeds lag more than a second or two.
// shortcut: tones are pinned on an aircraft only while its Doppler curve bends within the 30 s searched
// (about 30 s of a close pass). On the straight parts either side they could be any steady or
// drifting tone, and the sound is reported as noise with that aircraft as a candidate.
// shortcut: a quarter-second column cannot split tones closer than about 20 Hz, so a helicopter's
// main-rotor harmonics blur together and it is only ever matched by loudness; add a longer window for
// the low end if helicopters matter.
// shortcut: loudness is one A-weighted number, so a narrow steady noise that dominates it can hide an
// aircraft a person would still hear; follow it per band if sets turn out to have such noise.
// shortcut: a new steady noise (a generator starting) reads as unexplained noise until the background
// catches up, about 4 min, or forget() is called. It is no longer taken for an aircraft's swell, but
// an aircraft that passes during those minutes is measured against the old background.
// shortcut: with one candidate, a swell is named as soon as its rise fits, before the peak has shown
// whether the timing does: an aircraft with no transponder passing 20 s ahead of a silent, predicted
// one gets that one's name for a few seconds (no record is kept). Wait for the peak if that misleads.
// shortcut: where aircraft are audible nearly all the time the quiet between them is never heard, so
// the background includes them and floors come out high (5 dB beside LAX in the recorded traffic);
// learn the background only while nothing is predicted if that matters.

export const FMIN = 50;
export const BINS = 304;
const BPO = 48; // bins per octave
export const FMAX = FMIN * 2 ** (BINS / BPO);
export const FREQS = Float32Array.from({ length: BINS }, (_, b) => FMIN * 2 ** (b / BPO));

const WINDOW_S = 0.25; // long enough to split a propeller's harmonics, short enough to follow them sliding
const HOP_S = 0.125;
const TICK = 8; // columns per round of analysis: once a second
const SMOOTH = 48; // columns (6 s) the level is smoothed over
const QUIETEST = 0.1; // the level is the value this fraction of the way up those columns
const LAG = 3000; // ms: a smoothed level describes the middle of those 6 s
const MEMORY = 300; // seconds of levels the background is taken from
const WARMUP = 20; // seconds of listening before the background means anything
const LOOK = 240; // columns (30 s) searched for sliding tones

const DETECT = 3; // dB of rise that counts as audible: the noise is then as loud as the background
const MARGIN = 15; // dB below the page's floor at which a predicted aircraft becomes a candidate
const PEAK = 3; // dB a tone must stand above its neighbours once its Doppler shift is undone
const CLAIM = 2; // dB a tone must lose under every other explanation to belong to one aircraft
const BODY = 15; // dB under its predicted peak that still counts as the body of a pass
const FIT = 0.3; // how far off a predicted level curve may be and still explain the sound (see fit())
const TRUST = { tones: 0.4, alone: 0.75, picked: 0.55, unheard: 0.7, doubted: 0.45, unsure: 0.2 }; // confidence given to each kind of evidence
const SURE = 0.5; // the confidence tune.js asks for before it learns from a pass (its TRUSTED)
const SILENT = 1e-11; // A-weighted power, 110 dB under full scale: quieter than a 16-bit converter's own noise, so no microphone
const DROP = 10; // dB under the background it knew that means the microphone or the room has changed
const REACH = 3; // bins either side of where a tone should be that one column is searched for it
const STAND = 7; // dB a tone must stand above the bins beside it to be seen in a single column
const RUN = 16; // sightings (2 s of them) before a straight line is tried through them
const TONAL = 0.5; // share of the extra loudness that steady tones must carry for it to be a hum
const STEADY = 0.1; // a rise that moves about its mean by less than this share of its peak is steady noise, not a swell
const ALONE = 10; // dB under an aircraft's own level at which another stops adding to what is measured
const NEAR = 3; // dB under its predicted peak an aircraft may be when the sound peaks, for that peak to be its own
const SLIP = 3000; // ms the sound's peak may be from the moment the aircraft was predicted loudest
const WAITING = 200; // observations kept for a caller that is not collecting them

const dB = (power) => 10 * Math.log10(power + 1e-20);
const round = (x) => (Number.isFinite(x) ? Math.round(x * 10) / 10 : null);
// A source `over` dB above the background lifts the total by riseOf(over); excess() is the way back.
const riseOf = (over) => 10 * Math.log10(1 + 10 ** (over / 10));
const excess = (rise) => 10 * Math.log10(10 ** (rise / 10) - 1);

// The A-weighting curve as a power ratio (1 at 1 kHz), because predict.js works in dBA.
export function aWeight(hz) {
  const f = hz * hz;
  const r = (12194 ** 2 * f * f) / ((f + 20.6 ** 2) * Math.sqrt((f + 107.7 ** 2) * (f + 737.9 ** 2)) * (f + 12194 ** 2));
  return 1.585 * r * r;
}

// In-place FFT for one power-of-two size.
function makeFft(n) {
  const bits = Math.log2(n);
  const swap = new Uint32Array(n);
  const cos = new Float64Array(n / 2);
  const sin = new Float64Array(n / 2);
  for (let i = 0; i < n; i++) for (let b = 0; b < bits; b++) swap[i] |= ((i >> b) & 1) << (bits - 1 - b);
  for (let i = 0; i < n / 2; i++) {
    cos[i] = Math.cos((2 * Math.PI * i) / n);
    sin[i] = Math.sin((2 * Math.PI * i) / n);
  }
  return (re, im) => {
    for (let i = 0; i < n; i++) {
      const j = swap[i];
      if (j > i) {
        let t = re[i];
        re[i] = re[j];
        re[j] = t;
        t = im[i];
        im[i] = im[j];
        im[j] = t;
      }
    }
    for (let size = 2; size <= n; size *= 2) {
      const half = size / 2;
      const step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = 0, k = 0; j < half; j++, k += step) {
          const a = i + j;
          const b = a + half;
          const xr = re[b] * cos[k] + im[b] * sin[k];
          const xi = im[b] * cos[k] - re[b] * sin[k];
          re[b] = re[a] - xr;
          im[b] = im[a] - xi;
          re[a] += xr;
          im[a] += xi;
        }
      }
    }
  };
}

const TONE = FREQS.map((hz) => aWeight(hz) / 2); // what a full-scale tone in each bin adds to the loudness
const STILL = new Float32Array(LOOK); // the shifts of "nothing is moving"

const scratch = new Float32Array(MEMORY);
const seenIn = new Float32Array(LOOK); // follow()'s sightings of a tone: the column, the bin, and working space
const seenAt = new Float32Array(LOOK);
const chord = new Float32Array(LOOK);
// The value a fraction `q` of the way up the first `n` entries, e.g. q = 0.5 for the median.
function quantile(values, n, q) {
  scratch.set(values.subarray(0, n));
  return scratch.subarray(0, n).sort()[Math.floor(q * (n - 1))];
}

// The note a set of tones are harmonics of, or null: the highest one that takes in nearly all of the
// tone found, trying each tone as each harmonic number. With few tones this can be an octave out.
function fundamental(tones) {
  const series = [];
  for (const t of tones) {
    for (let n = 1; n <= 12 && t.hz / n >= 15; n++) {
      const f0 = t.hz / n;
      let sum = 0;
      let hits = 0;
      let hz = 0;
      let weight = 0;
      for (const o of tones) {
        const k = Math.round(o.hz / f0);
        if (k < 1 || Math.abs(o.hz / (k * f0) - 1) > 0.012) continue;
        sum += o.z;
        hits++;
        hz += o.z * o.hz; // higher harmonics place the note more finely, so they weigh more
        weight += o.z * k;
      }
      if (hits >= 2) series.push({ sum, hz: hz / weight });
    }
  }
  const most = Math.max(...series.map((f) => f.sum));
  return series.filter((f) => f.sum >= 0.9 * most).reduce((a, b) => (b.hz > a.hz ? b : a), { hz: null }).hz;
}

export function createEar({ sampleRate }) {
  const size = Math.round(sampleRate * WINDOW_S);
  const hop = Math.round(sampleRate * HOP_S);
  const n = 2 ** Math.ceil(Math.log2(size));
  const fft = makeFft(n);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  const hann = Float64Array.from({ length: size }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size));
  const top = Math.ceil((FMAX * n) / sampleRate) + 1;
  const power = new Float64Array(top + 1); // per FFT bin; 1 = a full-scale tone
  const inBand = size / (3 * n); // turns a sum of `power` into mean-square level

  // Each spectrogram bin takes the strongest FFT bin it covers. Low down, where the spectrogram bins
  // are finer than the FFT's, it reads between two FFT bins instead (to[b] = -1).
  const from = new Int32Array(BINS);
  const to = new Int32Array(BINS);
  const mix = new Float32Array(BINS);
  for (let b = 0; b < BINS; b++) {
    const at = (hz) => (hz * n) / sampleRate;
    const lo = at(FREQS[b] * 2 ** (-0.5 / BPO));
    const hi = at(FREQS[b] * 2 ** (0.5 / BPO));
    if (hi - lo < 1) {
      from[b] = Math.floor(at(FREQS[b]));
      mix[b] = at(FREQS[b]) - from[b];
      to[b] = -1;
    } else {
      from[b] = Math.ceil(lo);
      to[b] = Math.floor(hi);
    }
  }
  const bottom = Math.round((FMIN * n) / sampleRate);
  const weight = Float64Array.from({ length: top + 1 }, (_, k) => aWeight((k * sampleRate) / n) * inBand);

  const buf = new Float32Array(size);
  let fill = 0;
  let last = null; // time of the last sample pushed

  // What is being heard. forget() clears all of this.
  let frames, ticks, cols, still, rises, event, up, down, sunk, state;
  let off = false; // the caller says the microphone is muted
  let was = null; // the background, in dB, it knew before it last started again
  // Whether an aircraft that goes unheard is evidence: only once this engine has heard one and measured
  // it, and not after the microphone has come back at least DROP dB quieter than it was (turned down,
  // covered, swapped) until it has heard one again. A page reopened with a covered or misrouted
  // microphone would otherwise raise, on silence alone, a floor learned on an earlier day.
  let hears = false;
  const quiet = new Float32Array(BINS);
  const recent = new Float32Array(SMOOTH); // A-weighted power of each of the last 6 s of columns
  const memory = new Float32Array(MEMORY); // the level, once a second
  function forget() {
    if (state?.ready) was = state.background;
    fill = frames = ticks = up = down = sunk = 0;
    cols = []; // the last 30 s of columns
    still = []; // a column every 2 s for 4 min: each bin's usual level is the median of these
    rises = []; // { at, rise, hum } once a second for 10 min
    event = null; // the stretch of noise going on now: { from, peak, at, known, seen, pick, run }
    state = { at: null, ready: false, signal: !off, level: null, background: null, rise: 0, noise: false, expected: [], heard: [] };
  }
  forget();

  // What the feed says. Kept when the microphone stops.
  const planes = new Map(); // hex -> { hex, category, seen, s: [{ emit, heard, db, factor }] }
  const passes = new Map(); // hex -> { from, to, doppler, tones, fundamental } while it is predicted loud
  let done = [];
  let trim = {};
  let floor = null;

  // A track's predicted level (trim taken out) and Doppler factor for sound arriving at `ms`, or null.
  function sample(plane, ms) {
    const s = plane.s;
    let lo = 0;
    let hi = s.length - 1;
    if (hi < 1 || ms < s[0].heard || ms > s[hi].heard) return null;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (s[mid].heard <= ms) lo = mid;
      else hi = mid;
    }
    const a = s[lo];
    const b = s[hi];
    if (b.emit - a.emit > 6000) return null; // a hole in the path: it is waiting on the runway, and silent
    const u = (ms - a.heard) / (b.heard - a.heard);
    return { db: a.db + (b.db - a.db) * u, factor: a.factor + (b.factor - a.factor) * u };
  }
  const level = (plane, ms) => (sample(plane, ms)?.db ?? -Infinity) + (trim[plane.category] ?? 0);
  // The prediction as the level tracker would report it: the quietest tenth of the 6 s around `ms`.
  // A quick, close pass loses the same few dB from its peak in both, so the two can be compared.
  const around = new Float32Array(25);
  function due(plane, ms) {
    for (let i = 0; i < 25; i++) around[i] = sample(plane, ms + (i - 12) * (LAG / 12))?.db ?? -Infinity;
    return quantile(around, 25, QUIETEST);
  }

  function column(at) {
    re.fill(0);
    im.fill(0);
    for (let i = 0; i < size; i++) re[i] = buf[i] * hann[i];
    fft(re, im);
    for (let k = 0; k <= top; k++) power[k] = ((re[k] * re[k] + im[k] * im[k]) * 16) / (size * size);

    const db = new Float32Array(BINS);
    for (let b = 0; b < BINS; b++) {
      let p = 0;
      if (to[b] < 0) p = power[from[b]] * (1 - mix[b]) + power[from[b] + 1] * mix[b];
      else for (let k = from[b]; k <= to[b]; k++) if (power[k] > p) p = power[k];
      db[b] = dB(p);
    }
    // Not while a noise is going on: a hum would become usual here, where the tone detector looks,
    // before the loudness background had taken it in, and then be heard as loud but toneless.
    if (frames % 16 === 0 && !event) {
      still.push(db);
      if (still.length > 120) still.shift();
      const one = new Float32Array(still.length);
      for (let b = 0; b < BINS; b++) {
        for (let i = 0; i < still.length; i++) one[i] = still[i][b];
        quiet[b] = quantile(one, one.length, 0.5);
      }
    }
    const col = { at, db, above: db.map((v, b) => v - quiet[b]) };
    // The tone detector's own copy keeps only what is above the usual level. A bin that falls below it
    // (a hum that had become usual, then stopped) is no tone anywhere, and must not cancel one.
    cols.push({ at, above: col.above.map((v) => Math.max(v, 0)) });
    if (cols.length > LOOK) cols.shift();

    let loud = 0;
    for (let k = bottom; k < top; k++) loud += power[k] * weight[k];
    recent[frames % SMOOTH] = loud;
    if (++frames % TICK === 0) tick(at);
    return col;
  }

  // The last 30 s of columns (or only those from `first` on), each slid back by its own `shift` in bins
  // and averaged: `mean`. Tones that followed those shifts pile up in one bin; anything else is spread
  // thin. `z` is how far each bin stands above the level around it.
  function straighten(shift, first = 0) {
    const sum = new Float32Array(BINS);
    const count = new Uint16Array(BINS);
    let used = 0;
    for (let i = first; i < cols.length; i++) {
      const d = shift[i];
      if (!(d > -BINS && d < BINS)) continue;
      used++;
      const whole = Math.floor(d);
      const part = d - whole;
      const col = cols[i].above;
      for (let b = Math.max(0, -whole), end = Math.min(BINS, BINS - 1 - whole); b < end; b++) {
        sum[b] += col[b + whole] * (1 - part) + col[b + whole + 1] * part;
        count[b]++;
      }
    }
    // Bins near the ends that slid out of range part of the time have too little behind them to trust.
    const mean = sum.map((v, b) => (count[b] >= 0.8 * used ? v / count[b] : NaN));
    const near = new Float32Array(25);
    const z = mean.map((v, b) => {
      let m = 0;
      for (let i = Math.max(0, b - 12); i <= Math.min(BINS - 1, b + 12); i++) if (mean[i] === mean[i]) near[m++] = mean[i];
      return v === v && m >= 8 ? v - quantile(near, m, 0.3) : 0;
    });
    return { mean, z };
  }

  // An averaged peak is not yet a tone. This looks for it column by column: `b` is its bin once the
  // columns are straightened by `shift`, so column i should show it at b + shift[i]. The answer is how
  // well the same sound piles up under one more explanation, a tone drifting at a steady rate: a
  // straight line through the places it was seen, averaged the way straighten() averages. A curve that
  // is nearly straight while the tone is there cannot beat it.
  // shortcut: only a steady drift is ruled out. A tone that bends the way an aircraft's would is still
  // taken for one here, and is caught, if at all, by its loudness when the pass is recorded.
  function follow(shift, b) {
    let n = 0;
    for (let i = 0; i < cols.length; i++) {
      const centre = Math.round(b + shift[i]);
      if (!(centre >= REACH + 3 && centre < BINS - REACH - 3)) continue;
      const col = cols[i].above;
      let k = centre - REACH;
      for (let j = k + 1; j <= centre + REACH; j++) if (col[j] > col[k]) k = j;
      let beside = 0;
      for (let j = REACH + 1; j <= REACH + 3; j++) beside += col[centre - j] + col[centre + j];
      if (col[k] - beside / 6 < STAND) continue;
      seenIn[n] = i;
      seenAt[n++] = k;
    }
    // How well it piles up along the straight line through sightings `from` to `to`: the middle slope
    // of the chords from each to the one half that list further on, then the middle offset. A stray
    // sighting or two would drag a least-squares line.
    const along = (from, to) => {
      const many = to - from;
      const half = many >> 1;
      for (let j = 0; j < half; j++) chord[j] = (seenAt[from + j + half] - seenAt[from + j]) / (seenIn[from + j + half] - seenIn[from + j]);
      const slope = quantile(chord, half, 0.5);
      for (let j = 0; j < many; j++) chord[j] = seenAt[from + j] - slope * seenIn[from + j];
      const start = quantile(chord, many, 0.5);
      let sum = 0;
      let used = 0;
      for (let i = 0; i < cols.length; i++) {
        const at = start + slope * i;
        const whole = Math.floor(at);
        if (shift[i] !== shift[i] || whole < 0 || whole >= BINS - 1) continue;
        sum += cols[i].above[whole] * (1 - (at - whole)) + cols[i].above[whole + 1] * (at - whole);
        used++;
      }
      return used ? sum / used : -Infinity;
    };
    // The best of several lines counts. One through every sighting is the one to beat for a single
    // tone, even when speech has broken the sightings up. But a motor has harmonics, and a falling
    // curve slides off one of them onto the next one down, so that a line through all the sightings
    // follows neither: each stretch that moved smoothly gets a line of its own as well.
    let line = n >= RUN ? along(0, n) : -Infinity;
    for (let from = 0, to = 1; to <= n; to++) {
      if (to < n && seenIn[to] - seenIn[to - 1] <= 8 && Math.abs(seenAt[to] - seenAt[to - 1]) <= 4) continue;
      if (to - from >= RUN && to - from < n) line = Math.max(line, along(from, to));
      from = to;
    }
    return line;
  }

  // How much of the loudness above the background, over the 6 s the level describes, is tones that
  // held still: near 1 for a hum, near 0 for a jet's roar or for tones sliding past.
  // shortcut: a hum between 1 and 4 minutes old is in the background's level but not yet in each
  // bin's usual level, so it is counted against a later aircraft; one background would fix that.
  function steady(extra) {
    const { mean, z } = straighten(STILL, Math.max(0, cols.length - SMOOTH));
    let tones = 0;
    for (let b = 1; b < BINS - 1; b++) if (z[b] >= PEAK && z[b] >= z[b - 1] && z[b] > z[b + 1]) tones += 10 ** ((quiet[b] + mean[b]) / 10) * TONE[b];
    return tones / extra;
  }

  // How badly a track's predicted level explains the measured rise between two times: 0 is exactly,
  // and about 1 is no better than predicting silence. The floor is whatever makes the two peaks agree,
  // so this judges the timing and shape of the swell, not how loud it was. Infinity when the sound was
  // no swell at all: it stayed as it was throughout, which a prediction that hardly changes would
  // always fit, or it came or went within a second when the prediction did not, as something switched
  // on or off does.
  // shortcut: a step under 6 dB is not told from the start of a swell, and can be named for a few seconds.
  function fit(plane, start, end) {
    const pts = [];
    let most = -Infinity;
    let peak = 0;
    let sum = 0;
    let squares = 0;
    for (const r of rises) {
      if (r.at < start || r.at > end || r.rise !== r.rise) continue;
      const pred = due(plane, r.at);
      pts.push([pred, r.rise]);
      most = Math.max(most, pred);
      peak = Math.max(peak, r.rise);
      sum += r.rise;
      squares += r.rise ** 2;
    }
    if (most === -Infinity || peak < 1) return Infinity;
    // How many dB the rise moved about its own mean (rounding can take the difference just under zero).
    if (Math.sqrt(Math.max(0, squares / pts.length - (sum / pts.length) ** 2)) < Math.max(0.5, STEADY * peak)) return Infinity;
    const zero = most - excess(peak);
    let miss = 0;
    let before = NaN;
    for (const [pred, rise] of pts) {
      const off = rise - riseOf(pred - zero);
      if (Math.abs(off - before) > Math.max(DETECT, peak / 2)) return Infinity;
      before = off;
      miss += off * off;
    }
    return Math.sqrt(miss / pts.length) / peak;
  }

  // A pass is over: set what was predicted beside what was heard, for tuning. The comparison is made
  // over the body of the swell (while the prediction is within BODY dB of its peak, and 5 s either
  // side), so that the aircraft before and after it, a minute away, do not count against it.
  function finish(plane, pass) {
    const pts = [];
    for (const r of rises) if (r.at >= pass.from - 4000 && r.at <= pass.to + 4000) pts.push({ at: r.at, rise: r.rise, hum: r.hum, pred: due(plane, r.at) });
    if (!pts.length || pts[0].at > pass.from - 3000) return; // the microphone was not listening from the start
    // The rise that held for two seconds running, so one stray second of something else does not count.
    pts.forEach((q, i) => (q.held = Math.min(q.rise, pts[i - 1]?.rise ?? q.rise)));
    const best = pts.reduce((a, b) => (b.pred > a.pred ? b : a));
    if (best === pts[0]) return; // opened on the way down (the floor was just lowered): a tail, not a pass
    let first = pts.indexOf(best);
    let last = first;
    while (first > 0 && pts[first - 1].pred >= best.pred - BODY) first--;
    while (last < pts.length - 1 && pts[last + 1].pred >= best.pred - BODY) last++;
    const body = pts.slice(Math.max(0, first - 5), last + 6);
    if (body.some((q) => q.rise !== q.rise)) return; // still learning the background
    const start = body[0].at;
    const end = body.at(-1).at;
    const most = (some) => some.reduce((a, b) => (b.held > a.held ? b : a));
    const rest = [...planes.values()].filter((p) => p !== plane);
    const others = rest.filter((p) => body.some((q, i) => i % 2 === 0 && level(p, q.at) >= floor - MARGIN));
    const own = trim[plane.category] ?? 0;

    let how = 'unsure';
    let confidence = TRUST.unsure;
    if (pass.doppler >= TRUST.tones) {
      how = 'doppler';
      confidence = pass.doppler;
    } else if (most(body).held < DETECT) {
      how = 'unheard';
      // Only counts if the feed still had the aircraft as the peak came, not a minutes-old forecast,
      // and if this microphone has shown that it hears aircraft.
      confidence = hears && plane.seen >= best.at - 20000 ? TRUST.unheard : TRUST.unsure;
    } else {
      // A swell is this aircraft's only if no other aircraft explains it nearly as well, and if it was
      // not mostly a hum.
      const mine = fit(plane, start, end);
      const risen = body.filter((q) => q.rise >= DETECT);
      if (mine < FIT && 2 * risen.filter((q) => q.hum).length <= risen.length && !others.some((p) => fit(p, start, end) < 1.5 * mine + 0.1)) {
        how = 'envelope';
        confidence = others.length ? TRUST.picked : TRUST.alone;
      }
    }
    const heard = how === 'unsure' ? null : how !== 'unheard';
    // How loud it was is read only from the stretch around its predicted peak in which no other
    // aircraft was predicted within ALONE dB of it: anywhere else the rise is not all its own.
    const lone = (q) => !rest.some((p) => level(p, q.at) >= q.pred + own - ALONE);
    let alone = null;
    if (heard && lone(best)) {
      let a = body.indexOf(best);
      let b = a;
      while (a > 0 && lone(body[a - 1])) a--;
      while (b < body.length - 1 && lone(body[b + 1])) b++;
      alone = body.slice(a, b + 1);
    }
    const loudest = most(alone ?? body);
    // And it is believed only if the loudness there was this aircraft's own, whatever named it: the
    // sound peaked within SLIP of the moment it was predicted loudest, while it was predicted within
    // NEAR dB of that, and rose and fell as predicted. Both, because a slow distant aircraft stays near
    // its loudest for half a minute, and a lorry passing in that time would otherwise be measured as it.
    // shortcut: so a feed running more than SLIP late teaches nothing, and broad quiet passes often don't.
    // A motor's tone can bend like an aircraft's, and an aircraft with no transponder can pass a few
    // seconds later and louder: tones say who was there, not whose noise it was. Short of that, who it
    // was is kept, but doubted, and how loud is left out.
    // shortcut: something unpredicted that peaks within a few seconds of the aircraft, and swells
    // like it, is still measured as the aircraft; nothing here can tell them apart.
    const measured = alone && loudest.pred >= best.pred - NEAR && Math.abs(loudest.at - best.at) <= SLIP && fit(plane, alone[0].at, alone.at(-1).at) < FIT;
    // Tones can be heard before they lift the overall level, so the rise is counted as at least 1 dB.
    const est = measured ? best.pred - excess(Math.max(loudest.held, 1)) : null;
    if (heard && !measured) confidence = Math.min(confidence, TRUST.doubted);
    if (measured && confidence >= SURE) hears = true;
    // When this swell began: back from the peak to the first second that cleared the bar.
    const began = (peak, clears) => {
      let i = pts.indexOf(peak);
      if (!measured || !clears(peak)) return null;
      while (i > 0 && clears(pts[i - 1])) i--;
      return i > 0 ? pts[i].at : null; // null: it was already going when the pass opened
    };
    const onset = began(loudest, (q) => q.held >= DETECT);
    const dueOn = began(best, (q) => q.pred >= est);
    const every = Math.ceil(pts.length / 45);
    const shown = pts.filter((_, i) => i % every === 0);
    file({
      at: best.at,
      hex: plane.hex,
      category: plane.category,
      how,
      heard,
      confidence: Math.round(confidence * 100) / 100,
      predPeak: round(best.pred),
      rise: round(loudest.held),
      floor: round(est),
      onsetErr: onset && dueOn ? (onset - dueOn) / 1000 : null,
      peakErr: measured ? (loudest.at - best.at) / 1000 : null,
      seconds: Math.round((pass.to - pass.from) / 1000),
      tones: how === 'doppler' ? pass.tones : [],
      fundamental: how === 'doppler' ? pass.fundamental : null,
      curve: { from: shown[0].at, step: every * 1000, pred: shown.map((q) => round(q.pred)), rise: shown.map((q) => round(q.rise)) },
    });
  }

  function file(observation) {
    done.push(observation);
    if (done.length > WAITING) done.shift();
  }

  function tick(at) {
    // How loud it is, and how loud this place usually is.
    const now = quantile(recent, Math.min(frames, SMOOTH), QUIETEST);
    // Nothing is coming from the microphone. It drops what it knew, so that nothing is heard in the
    // silence or learned from it, and starts again like new when the sound is back.
    if (off || now < SILENT) {
      forget();
      Object.assign(state, { at, signal: false, level: round(dB(now)) });
      return;
    }
    memory[ticks % MEMORY] = now;
    const usual = quantile(memory, Math.min(ticks + 1, MEMORY), 0.2);
    const ready = ++ticks >= WARMUP;
    const rise = ready ? dB(now + 1e-15) - dB(usual + 1e-15) : NaN;
    // Far under the background it knew for 3 s: the microphone was turned down or covered, or the room
    // went quiet. Either way that background is no longer the one to measure against.
    // shortcut: a drop under DROP dB is only followed slowly, and for the minute that takes aircraft
    // read quieter than they are; follow the background faster downwards if that shows in the floors.
    sunk = rise <= -DROP ? sunk + 1 : 0;
    if (sunk >= 3) {
      forget();
      state.at = at;
      return;
    }
    if (ticks === WARMUP && was != null && dB(usual) <= was - DROP) hears = false;
    const stamp = at - LAG;
    // A hum is one to the end: in the quiet tail of a noise, where its tones are too faint to pick out,
    // it is taken to be what it was the second before.
    rises.push({ at: stamp, rise, hum: rise >= DETECT ? steady(now - usual) >= TONAL : !!event && !!rises.at(-1)?.hum });
    if (rises.length > 600) rises.shift();
    if (rise >= DETECT) (up++, (down = 0));
    else if (!(rise > DETECT - 1)) (down++, (up = 0));
    if (!event && up >= 2) event = { from: stamp - 1000, peak: 0, at: stamp, known: false, seen: new Set(), pick: null, run: 0 };
    if (event && rise > event.peak) Object.assign(event, { peak: rise, at: stamp });

    // Which aircraft are predicted loud enough to matter right now. Each such stretch is a pass.
    const cands = [];
    if (floor != null) {
      for (const plane of planes.values()) {
        const loud = level(plane, at) >= floor - MARGIN;
        let pass = passes.get(plane.hex);
        if (loud && !pass) passes.set(plane.hex, (pass = { from: at, to: at, doppler: 0, tones: [], fundamental: null }));
        if (!pass) continue;
        if (loud) pass.to = at;
        // Over once it has been quiet for 8 s. A hovering helicopter is cut into 5 min pieces.
        if (at - pass.to > 8000 || at - pass.from > 300000) {
          passes.delete(plane.hex);
          finish(plane, pass);
        } else if (loud) cands.push({ plane, pass, level: level(plane, at) });
      }
    }
    cands.sort((a, b) => b.level - a.level);

    // Tones. Each candidate, and "nothing is moving", gets the columns straightened its own way. A
    // peak belongs to a candidate only if the same sound piles up clearly less under every other
    // explanation, wherever it would land there. One of those explanations is a tone drifting at a
    // steady rate, which follow() looks for in the columns themselves.
    const heard = [];
    const expected = cands.map((c) => ({ hex: c.plane.hex, level: round(c.level), swing: null }));
    if (cands.length && cols.length >= 80) {
      // shortcut: only the 6 loudest candidates are tried; raise it if a busy sky needs more.
      const views = [null, ...cands.slice(0, 6)].map((c) => {
        const shift = Float32Array.from(cols, (col) => (c ? BPO * Math.log2(sample(c.plane, col.at)?.factor ?? NaN) : 0));
        return { c, shift, ...straighten(shift) };
      });
      views.slice(1).forEach((view, i) => {
        const known = view.shift.filter((d) => d === d);
        if (known.length < 80) return;
        expected[i].swing = round((2 ** ((Math.max(...known) - Math.min(...known)) / BPO) - 1) * 100);
        // Where this candidate's bin `b` would land in each other view: between b + lo and b + hi.
        const spans = views
          .filter((other) => other !== view)
          .map((other) => {
            let lo = Infinity;
            let hi = -Infinity;
            for (let k = 0; k < cols.length; k++) {
              const d = view.shift[k] - other.shift[k];
              if (d === d) (lo = Math.min(lo, d)), (hi = Math.max(hi, d));
            }
            return { mean: other.mean, lo, hi };
          });
        const tones = [];
        for (let b = 1; b < BINS - 1; b++) {
          const z = view.z[b];
          if (z < PEAK || z < view.z[b - 1] || z <= view.z[b + 1]) continue;
          let rival = -Infinity;
          let blind = false; // where it would land under another explanation runs off the spectrogram
          for (const s of spans) {
            const lo = Math.round(b + s.lo) - 1;
            const hi = Math.round(b + s.hi) + 1;
            if (lo < 0 || hi >= BINS) blind = true;
            else
              for (let k = lo; k <= hi; k++) {
                if (s.mean[k] > rival) rival = s.mean[k];
                else if (s.mean[k] !== s.mean[k]) blind = true; // too few columns reached this bin to say
              }
          }
          if (blind || !(Math.min(z, view.mean[b] - rival) >= Math.max(CLAIM, z / 3))) continue;
          // The same bar again with a steady drift among the rivals. Short of it, the peak is not this
          // aircraft's tone: it is left out of its tones, and a small margin is not added to the rest.
          const margin = Math.min(z, view.mean[b] - Math.max(rival, follow(view.shift, b)));
          if (!(margin >= Math.max(CLAIM, z / 3))) continue;
          const bin = b + (0.5 * (view.z[b - 1] - view.z[b + 1])) / (view.z[b - 1] - 2 * z + view.z[b + 1]);
          tones.push({ hz: FMIN * 2 ** (bin / BPO), z, margin });
        }
        const confidence = 1 - Math.exp(-tones.reduce((sum, t) => sum + t.margin, 0) / 10);
        if (confidence < TRUST.tones) return;
        const found = { tones: tones.map((t) => round(t.hz)), fundamental: round(fundamental(tones)) };
        heard.push({ hex: view.c.plane.hex, how: 'doppler', confidence: Math.round(confidence * 100) / 100, candidates: [], ...found });
        if (confidence > view.c.pass.doppler) Object.assign(view.c.pass, { doppler: confidence, ...found });
      });
    }

    // No tones: go by loudness. One candidate whose predicted swell fits, and no other, gets it. A hum
    // is never a swell, however it is timed.
    if (event && !heard.length) {
      const fits = cands.map((c) => ({ hex: c.plane.hex, miss: fit(c.plane, Math.max(event.from - 10000, stamp - 90000), stamp) })).sort((a, b) => a.miss - b.miss);
      const pick = fits[0]?.miss < FIT && !(fits[1]?.miss < 1.5 * fits[0].miss + 0.1) && !rises.at(-1).hum ? fits[0].hex : null;
      event.run = pick && pick === event.pick ? event.run + 1 : 0;
      event.pick = pick;
      // Named only once the same aircraft has been the one clear fit for 3 s, well into the swell.
      const clear = pick && event.run >= 2 && stamp - event.from >= 6000;
      const who = clear
        ? { hex: fits[0].hex, how: 'envelope', confidence: fits.length > 1 ? TRUST.picked : TRUST.alone }
        : { hex: null, how: 'level', confidence: 0 };
      heard.push({ ...who, candidates: cands.map((c) => c.plane.hex), tones: [], fundamental: null });
    }
    if (event) {
      for (const c of cands) event.seen.add(c.plane);
      event.known ||= heard.some((h) => h.how === 'doppler');
      if (down >= 3) {
        // Explained if an aircraft's tones were heard in it, or if, now that it is over, the swell of an
        // aircraft that was expected fits the whole of it: then that aircraft's own pass says what is
        // known. One that was merely expected at the time does not make the noise its own.
        // shortcut: a passing truck swells like an aircraft; only length (10 s or more) sets them apart here.
        if (stamp - event.from >= 10000 && !event.known && ![...event.seen].some((plane) => fit(plane, event.from - 10000, stamp) < FIT)) {
          const blank = { hex: null, category: null, predPeak: null, floor: null, onsetErr: null, peakErr: null, tones: [], fundamental: null, curve: null };
          file({ at: event.at, how: 'unexplained', heard: true, confidence: 0, rise: round(event.peak), seconds: Math.round((stamp - event.from) / 1000), ...blank });
        }
        event = null;
      }
    }
    state = { at, ready, signal: true, level: round(dB(now)), background: round(dB(usual)), rise: round(rise) ?? 0, noise: !!event, expected, heard };
  }

  return {
    quiet,
    forget,
    status: () => state,
    observations: () => done.splice(0),

    mute(on) {
      off = !!on;
      if (off) forget();
    },

    push(pcm, endMs) {
      if (last != null && Math.abs(endMs - (pcm.length / sampleRate) * 1000 - last) > 1000) forget();
      last = endMs;
      const made = [];
      for (let i = 0; i < pcm.length; ) {
        const take = Math.min(size - fill, pcm.length - i);
        buf.set(pcm.subarray(i, i + take), fill);
        fill += take;
        i += take;
        if (fill === size) {
          made.push(column(endMs - ((pcm.length - i + size / 2) / sampleRate) * 1000));
          buf.copyWithin(0, hop);
          fill = size - hop;
        }
      }
      return made;
    },

    // Each poll's path is a guess made from one moment. For the future the newest guess wins; for the
    // past the truth is what earlier polls said at the time, so those samples are kept, not redrawn.
    update({ at, tracks, trim: inEffect = {}, floor: pageFloor = null }) {
      trim = inEffect;
      floor = pageFloor;
      for (const w of tracks) {
        let plane = planes.get(w.hex);
        if (!plane) planes.set(w.hex, (plane = { hex: w.hex, category: w.category, s: [] }));
        const s = plane.s;
        const known = s.length > 0;
        while (s.length && s.at(-1).emit >= at) s.pop();
        for (let i = 0; i < w.path.length; i++) {
          const p = w.path[i];
          if (known && p.t < 0) continue;
          const a = w.path[Math.max(i - 1, 0)];
          const b = w.path[Math.min(i + 1, w.path.length - 1)];
          const heard = at + p.heardAt * 1000;
          if (s.length && heard <= s.at(-1).heard) continue;
          // Heard pitch over emitted pitch: how much aircraft time goes by per second of listening.
          // Near the speed of sound it runs away, and is left unknown.
          const factor = (b.t - a.t) / (b.heardAt - a.heardAt);
          s.push({ emit: at + p.t * 1000, heard, db: p.db - (inEffect[w.category] ?? 0), factor: factor > 0.25 && factor < 4 ? factor : NaN });
        }
        plane.seen = at;
      }
      for (const [hex, plane] of planes) {
        const s = plane.s;
        // Gone from the feed: believe its last forecast for 30 s more, then stop expecting it.
        if (plane.seen < at) while (s.length && s.at(-1).emit > plane.seen + 30000) s.pop();
        let old = 0;
        while (old < s.length && s[old].heard < at - 600000) old++;
        s.splice(0, old);
        if (!s.length && !passes.has(hex)) planes.delete(hex);
      }
    },

    curve(hex, hz, fromMs, toMs, stepMs = 500) {
      const plane = planes.get(hex);
      const out = new Float32Array(Math.max(0, Math.floor((toMs - fromMs) / stepMs) + 1));
      return out.map((_, i) => hz * (plane && sample(plane, fromMs + i * stepMs)?.factor));
    },
  };
}
