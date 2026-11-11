// Makes the sound a microphone at the set would pick up from predicted tracks, so the listening
// engine (hear.js) can be shown and tested without a real aircraft. Pure JavaScript, no Web Audio.
//
//   const synth = createSynth({ sampleRate, background, louder, hum, tone, fan, speech, gain, seed })
//       background  level of the steady room noise, on predict.js's dB scale (default 40)
//       louder      dB added to every aircraft: a world where they are louder than predicted (default 0)
//       hum         { hz, db, from, to } for a steady hum with harmonics, e.g. { hz: 60, db: 45 }
//       tone        { hz, db, slide, bend, harmonics, from, to } for a tone whose pitch moves, as a
//                   motor's does: `hz` is its pitch at `from`, and t seconds later that is multiplied
//                   by exp(slide * t + bend * t * t). So a `slide` of -0.003 falls 0.3 % a second, and
//                   `bend` makes the fall speed up or ease off. `harmonics` (default 1) adds overtones.
//       fan         { db, from, to } for steady noise with no tones in it, like the room's but switched on
//       speech      { db, from, to } for speech-like bursts: syllables in phrases, with pauses
//       gain        { db, from, to } turns the whole microphone down by `db` (-30, say) after everything
//                   else is mixed. -Infinity gives digital silence: a muted or unplugged microphone
//                   `from` and `to` are the epoch ms a nuisance starts and stops; either may be left out
//       seed        any integer: the same seed gives the same sound
//   synth.render(tracks, at, startMs, seconds) → Float32Array
//       `tracks` and `at` as in an `hfs:update` (predict()'s results and the poll time they count
//       from). Returns mono audio for `seconds` starting at wall-clock `startMs`. Call it again for
//       the next stretch and the sound carries on without a click, even if the tracks have changed.
//   fundamentalOf(track) → the note in Hz it gives that aircraft's tones, or null for a jet
//
// Light aircraft (A1) get a propeller's harmonic series and helicopters (A7) a main rotor's, with the
// Doppler shift worked out from the positions along the path. Everything else gets a jet's roar,
// which has no tones. (The rotor's harmonics are closer together than hear.js can split, so it hears
// a helicopter as it hears a jet.) Each follows its track's predicted `db`. A level of FULL would fill the digital
// scale, and levels are A-weighted over the band the engine listens in, the way it measures them.
//
// shortcut: these voices are invented, and only like the real thing in the ways the engine relies on
// (steady harmonics, the right Doppler, a smooth swell); replace them with recordings when there are some.

import { aWeight, FMIN, FMAX } from './hear.js';

const FULL = 100;
const SOUND_MS = 343; // as in predict.js
// A harmonic series: the note's range in Hz, how many harmonics, how fast they fade, and the share of power in tones.
const VOICES = {
  A1: { low: 70, high: 100, harmonics: 10, fade: 0.75, tonal: 0.9 }, // blades passing, about 2400 rpm with two blades
  A7: { low: 18, high: 27, harmonics: 24, fade: 0.9, tonal: 0.85 }, // main rotor
};

const hash = (text) => {
  let h = 2166136261;
  for (const c of text) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return (h >>> 0) / 2 ** 32;
};
export const fundamentalOf = ({ hex, category }) => (VOICES[category] ? VOICES[category].low + (VOICES[category].high - VOICES[category].low) * hash(hex) : null);

export function createSynth({ sampleRate = 16000, background = 40, louder = 0, hum = null, tone = null, fan = null, speech = null, gain = null, seed = 1 } = {}) {
  const rand = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const power = (db) => 10 ** ((db - FULL) / 10);
  const turn = 2 * Math.PI;

  // Noise with most of its power between `low` and `high` Hz. `per` is the A-weighted power, in the
  // engine's band, that one unit of white noise comes out with, so its level can be set in dBA.
  function noise(low, high) {
    const a = 1 - Math.exp((-turn * high) / sampleRate);
    const b = 1 - Math.exp((-turn * low) / sampleRate);
    let per = 0;
    for (let hz = FMIN; hz < FMAX; hz += 2) {
      const c = Math.cos((turn * hz) / sampleRate);
      const lowPass = (a * a) / (1 - 2 * (1 - a) * c + (1 - a) ** 2);
      const highPass = ((1 - b) ** 2 * (2 - 2 * c)) / (1 - 2 * (1 - b) * c + (1 - b) ** 2);
      per += lowPass * highPass * aWeight(hz) * (4 / sampleRate);
    }
    let smooth = 0;
    let slow = 0;
    return {
      per,
      next() {
        smooth += a * ((rand() - 0.5) * 3.4641 - smooth);
        slow += b * (smooth - slow);
        return smooth - slow;
      },
    };
  }

  // A harmonic series with every harmonic at its own fixed phase. add() plays `count` harmonics of
  // a note at `theta`, each multiplied by `gain` times its own strength.
  function series(strengths) {
    const re = [0];
    const im = [0];
    for (const s of strengths) {
      const phase = turn * rand();
      re.push(s * Math.cos(phase));
      im.push(s * Math.sin(phase));
    }
    return {
      strengths: [0, ...strengths],
      // The gain that gives these harmonics, at note `hz`, an A-weighted in-band power of `want`.
      gain(hz, want, count) {
        let got = 0;
        for (let k = 1; k <= count; k++) if (k * hz >= FMIN && k * hz < FMAX) got += (this.strengths[k] ** 2 / 2) * aWeight(k * hz);
        return got ? Math.sqrt(want / got) : 0;
      },
      add(theta, count) {
        const c = Math.cos(theta);
        const s = Math.sin(theta);
        let x = c;
        let y = s;
        let sum = 0;
        for (let k = 1; k <= count; k++) {
          sum += re[k] * x + im[k] * y;
          const turned = x * c - y * s;
          y = x * s + y * c;
          x = turned;
        }
        return sum;
      },
    };
  }

  const room = noise(40, 1000);
  const voices = new Map(); // hex -> the state that keeps an aircraft's sound continuous between calls
  const drone = hum && { ...series(Array.from({ length: 8 }, (_, k) => 0.7 ** k)), theta: 0 };
  const whine = tone && { theta: 0, since: tone.from };
  const blower = fan && noise(40, 1000);
  const talk = speech && { left: 0, voiced: false, toGo: 0, theta: 0 };

  function fly(out, w, at, startMs) {
    const path = w.path;
    if (path.length < 2) return;
    let v = voices.get(w.hex);
    if (!v) {
      const kind = VOICES[w.category];
      const tones = kind && series(Array.from({ length: kind.harmonics }, (_, k) => kind.fade ** k));
      voices.set(w.hex, (v = { kind, tones, hz: fundamentalOf(w), theta: 0, roar: noise(80, 600) }));
    }
    // When the sound arriving at `ms` left the aircraft, on the path's own clock, and how loud it is.
    // Between two path samples the aircraft moves in a straight line, and this solves for the moment
    // whose sound arrives exactly then, so the Doppler shift comes from the geometry.
    let i = 0;
    const leaving = (ms) => {
      const tau = (ms - at) / 1000;
      while (i < path.length - 2 && path[i + 1].heardAt <= tau) i++;
      const a = path[i];
      const b = path[i + 1];
      if (tau < a.heardAt || tau > b.heardAt || b.t - a.t > 4) return null;
      let u = (tau - a.heardAt) / (b.heardAt - a.heardAt);
      for (let n = 0; n < 3; n++) {
        const dist = Math.hypot(a.x + (b.x - a.x) * u, a.y + (b.y - a.y) * u, a.alt + (b.alt - a.alt) * u);
        u += (tau - (a.t + (b.t - a.t) * u + dist / SOUND_MS)) / (b.heardAt - a.heardAt);
      }
      return { t: a.t + (b.t - a.t) * u, db: a.db + (b.db - a.db) * u + louder };
    };
    const block = Math.round(sampleRate / 100);
    let was = leaving(startMs);
    for (let n = 0; n < out.length; n += block) {
      const end = Math.min(n + block, out.length);
      const now = leaving(startMs + (end / sampleRate) * 1000);
      if (was && now && now.db > background - 30) {
        const factor = ((now.t - was.t) * sampleRate) / (end - n); // heard pitch over emitted pitch
        const tonal = v.kind?.tonal ?? 0;
        const roar = Math.sqrt((power(now.db) * (1 - tonal)) / v.roar.per);
        let count = 0;
        while (v.kind && count < v.kind.harmonics && (count + 1) * v.hz * factor < FMAX) count++;
        const gain = count ? v.tones.gain(v.hz * factor, power(now.db) * tonal, count) : 0;
        const step = (turn * v.hz * factor) / sampleRate;
        for (let s = n; s < end; s++) {
          out[s] += roar * v.roar.next();
          if (count) out[s] += gain * v.tones.add((v.theta += step), count);
        }
        if (v.theta > turn) v.theta %= turn;
      }
      was = now;
    }
  }

  // Speech-like bursts: voiced syllables whose pitch slides, strung into phrases with pauses between.
  function chatter(out, first, last) {
    for (let s = first; s < last; s++) {
      if (talk.left-- <= 0) {
        if (talk.voiced) {
          talk.voiced = false;
          talk.left = (--talk.toGo > 0 ? 0.04 + 0.08 * rand() : 0.5 + rand()) * sampleRate; // a gap, or a pause between phrases
          if (talk.toGo <= 0) talk.toGo = 3 + Math.floor(6 * rand());
        } else {
          const pitch = 100 + 120 * rand();
          const mouth = [300 + 500 * rand(), 1000 + 1200 * rand()]; // two resonances, as a vowel has
          const count = Math.floor(3500 / pitch);
          const shape = Array.from({ length: count }, (_, k) => {
            const hz = (k + 1) * pitch;
            return (1 + 3 * Math.exp(-(((hz - mouth[0]) / 150) ** 2)) + 2 * Math.exp(-(((hz - mouth[1]) / 250) ** 2))) / (k + 1);
          });
          const voice = series(shape);
          const length = Math.round((0.12 + 0.18 * rand()) * sampleRate);
          Object.assign(talk, { voiced: true, left: length, length, pitch, slide: 0.85 + 0.3 * rand(), voice, count, gain: voice.gain(pitch, power(speech.db), count) });
        }
      }
      if (!talk.voiced) continue;
      const along = 1 - talk.left / talk.length;
      talk.theta += (turn * talk.pitch * (1 + (talk.slide - 1) * along)) / sampleRate;
      out[s] += talk.gain * Math.sin(Math.PI * along) ** 2 * talk.voice.add(talk.theta, talk.count);
    }
  }

  return {
    render(tracks, at, startMs, seconds) {
      const out = new Float32Array(Math.round(seconds * sampleRate));
      const quiet = Math.sqrt(power(background) / room.per);
      for (let s = 0; s < out.length; s++) out[s] = quiet * room.next();
      for (const w of tracks) fly(out, w, at, startMs);
      // The samples of `out` a nuisance covers: [first, last).
      const sample = (ms, otherwise) => (ms == null ? otherwise : Math.max(0, Math.min(out.length, Math.round(((ms - startMs) / 1000) * sampleRate))));
      const span = (nuisance) => [sample(nuisance.from, 0), sample(nuisance.to, out.length)];
      if (drone) {
        const [first, last] = span(hum);
        const loud = drone.gain(hum.hz, power(hum.db), 8);
        for (let s = first; s < last; s++) out[s] += loud * drone.add((drone.theta += (turn * hum.hz) / sampleRate), 8);
      }
      if (whine) {
        whine.since ??= startMs;
        const [first, last] = span(tone);
        const { slide = 0, bend = 0, harmonics = 1 } = tone;
        // Each overtone 0.7 times the one below, and all of them together as loud as `db`.
        let got = 0;
        for (let k = 1; k <= harmonics; k++) got += (0.7 ** (2 * k - 2) / 2) * aWeight(k * tone.hz);
        const loud = Math.sqrt(power(tone.db) / got);
        for (let s = first; s < last; s++) {
          const t = (startMs - whine.since) / 1000 + s / sampleRate;
          whine.theta += (turn * tone.hz * Math.exp(slide * t + bend * t * t)) / sampleRate;
          for (let k = 1; k <= harmonics; k++) out[s] += loud * 0.7 ** (k - 1) * Math.sin(k * whine.theta);
        }
      }
      if (blower) {
        const [first, last] = span(fan);
        const loud = Math.sqrt(power(fan.db) / blower.per);
        for (let s = first; s < last; s++) out[s] += loud * blower.next();
      }
      if (talk) chatter(out, ...span(speech));
      if (gain) {
        const [first, last] = span(gain);
        const by = 10 ** (gain.db / 20);
        for (let s = first; s < last; s++) out[s] *= by;
      }
      return out;
    },
  };
}
