// The parts of the listening panel (listen.js) that need no page: where a time, a pitch or a level
// lands on the timeline, the forecast as it slides into the past, the audio clock, what the panel
// says, and what it stores. Pure functions of plain values, shared by the page and the tests.

import { BINS, FMIN } from './hear.js';
import { flyby } from './doppler.js';
import { CLASS_NAME } from './predict.js';
import { sample, CUT_M } from './map-geo.js';

const clamp = (x) => Math.min(1, Math.max(0, x));

// ---- The timeline's shape ----

// Everything is in CSS pixels for a panel `width` wide, with text `em` pixels high. Time runs left to
// right and "now" sits at `xNow`. While listening a third of the width is the past, under a
// spectrogram `pitch.h` high; with the microphone off there is no past worth the room, so the top
// band only holds the aircraft names. A phone covers 6 minutes at about a pixel a second, which keeps
// a 30 s pass wide enough to read; anything wider covers 9, the whole forecast.
// `height` is the box the page gives the timeline. The names always get their three rows. While
// listening the loudness band keeps its usual height and the spectrogram takes the rest, up to a
// pixel a bin; otherwise the loudness band takes it. With no `height`, it is the height the timeline
// would choose for itself.
export function layout(width, listening, em = 15, height) {
  const narrow = width < 600;
  const total = narrow ? 360 : 540;
  const past = total * (listening ? 1 / 3 : 1 / 8);
  const row = Math.round(em * 1.4);
  const names = row * 3 + 4;
  const usual = narrow ? 64 : 80;
  height ??= (listening ? (narrow ? 152 : 228) : names) + usual + 19 + row; // 304 bins: two, or one and a third, to the pixel
  const room = height - 19 - row; // for the two bands; the rest is the rail and the time axis
  const top = listening ? Math.min(BINS, Math.max(names, room - usual)) : names;
  const level = room - top;
  return {
    width,
    past,
    ahead: total - past,
    xNow: (width * past) / total,
    row,
    pitch: { y: 0, h: top },
    level: { y: top + 8, h: level },
    rail: { y: top + level + 11, h: 4 },
    axis: { y: top + level + 17 },
    height: top + level + 19 + row,
  };
}

// The loudness scale: dB over the warning level, which is the level at which an aircraft is as loud
// as the background. Predictions are on it already (`db - floor`). What the microphone measures is a
// rise above the background, and overOf() turns that into the same thing (hear.js calls it excess).
export const LOW = -10;
export const HIGH = 30;
export const overOf = (rise) => 10 * Math.log10(Math.max(10 ** (rise / 10) - 1, 1e-9)); // no rise at all is far off the bottom
// Where a measured rise belongs on that scale. The microphone measures against the background, which
// is what the learned floor stands for; the scale is against the warning level, which is the learned
// floor plus whatever the user has moved the slider by. With nothing learned the two cannot be tied
// together: the rise is then drawn against the background as it is, and the panel says so.
export const heardOver = (rise, floor, learned) => overOf(rise) + (learned == null ? 0 : learned - floor);
export const levelY = (over, band) => band.y + band.h * (1 - clamp((over - LOW) / (HIGH - LOW)));
export const pitchY = (hz, band) => band.y + band.h * (1 - (48 * Math.log2(hz / FMIN)) / BINS);

// How dark the spectrogram is drawn, 0 to 1, for a bin `above` dB over its usual level. Under 2 dB is
// the background's own flicker; 26 dB over is as loud as anything gets.
export const shade = (above) => clamp((above - 2) / 24);

// Which spectrogram bins each of `rows` pixel rows shows, top row (highest pitch) first, as [from, to)
// pairs. With fewer rows than bins a row takes the strongest of its bins, so a thin tone is not lost.
export function rowBins(rows) {
  const out = new Int16Array(rows * 2);
  for (let r = 0; r < rows; r++) {
    out[2 * r] = Math.floor(((rows - 1 - r) * BINS) / rows);
    out[2 * r + 1] = Math.max(out[2 * r] + 1, Math.floor(((rows - r) * BINS) / rows));
  }
  return out;
}

// Minute marks for the time axis: [{ s, text }] with `s` in seconds from now. Every minute where
// there is room for the words, otherwise every other one.
export function ticks(past, ahead, pxPerS, em = 15) {
  const step = pxPerS * 60 >= em * 3.1 ? 1 : 2;
  const out = [];
  for (let m = -step * Math.floor(past / 60 / step) || 0; m * 60 <= ahead; m += step) out.push({ s: m * 60, text: m ? `${m < 0 ? '−' : ''}${Math.abs(m)} min` : 'now' });
  return out;
}

// ---- The forecast, kept as it becomes the past ----

const HOLE = 6000; // ms between two samples of a path that means it was silent in between (waiting on a runway)
const KEEP = 300_000; // ms of the past kept

// Every aircraft's predicted level at the set over time. update() takes each `hfs:update`. As in
// hear.js, the newest poll's guess wins for the future, and the past stays what earlier polls said
// at the time. An aircraft that is no longer in the feed keeps its past and loses its future at
// once: ahead of now the timeline is only ever the newest forecast, the one the banner is using.
// `planes` maps hex to { hex, name, category, seen, lost, peak, pts: [{ at, db, t }], was, path }, with
// `at` the epoch ms the sound arrives, `t` the epoch ms the aircraft is where it makes it, and `peak`
// the loudest it gets. `lost` is true while the newest forecast is the page's estimate of an aircraft
// the feed has lost (lost.js), which the timeline draws dotted. `was` is `pts` as the update before
// had them, for the timeline to ease out of (by `t`, with morph() in map-geo.js); it is null where
// that would make no sense: an aircraft that was not in that update, is not in this one, or has
// moved more than CUT_M from where that update put it. `path` is the newest track's path.
// shortcut: this repeats bookkeeping hear.js does for itself, because hear.js only gives out a
// track's pitch over time, not its level; use the engine's if it grows a level() beside curve().
export function createForecast() {
  const planes = new Map();
  let before = null; // when the update before this one was
  return {
    planes,
    update({ at, tracks }) {
      for (const w of tracks) {
        let plane = planes.get(w.hex);
        if (!plane) planes.set(w.hex, (plane = { hex: w.hex, pts: [] }));
        const a = plane.seen === before && sample(plane.path, 't', (at - before) / 1000);
        const b = sample(w.path, 't', 0);
        // From what is on screen: mid-ease that is `shown` (set by the timeline), not the last forecast.
        plane.was = a && Math.hypot(a.x - b.x, a.y - b.y) < CUT_M ? (plane.shown ?? plane.pts).map((p) => ({ ...p })) : null;
        plane.shown = null;
        Object.assign(plane, { name: w.flight || w.hex, category: w.category, seen: at, lost: !!w.lost, path: w.path });
        const pts = plane.pts;
        const known = pts.length > 0;
        while (pts.length && pts.at(-1).at >= at) pts.pop();
        for (const p of w.path) {
          const heard = at + p.heardAt * 1000;
          if ((known && heard < at) || heard <= pts.at(-1)?.at) continue;
          pts.push({ at: heard, db: p.db, t: at + p.t * 1000 });
        }
      }
      for (const [hex, plane] of planes) {
        const pts = plane.pts;
        if (plane.seen < at) {
          plane.was = null;
          while (pts.length && pts.at(-1).at > at) pts.pop(); // gone from the feed
        }
        let old = 0;
        while (old < pts.length && pts[old].at < at - KEEP) old++;
        pts.splice(0, old);
        if (!pts.length) planes.delete(hex);
        else plane.peak = pts.reduce((most, p) => Math.max(most, p.db), -Infinity);
      }
      before = at;
    },
  };
}

// An aircraft's predicted level for sound arriving at `ms`, or -Infinity where it has none.
export function levelAt(plane, ms) {
  const pts = plane.pts;
  let lo = 0;
  let hi = pts.length - 1;
  if (hi < 1 || ms < pts[0].at || ms > pts[hi].at) return -Infinity;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (pts[mid].at <= ms) lo = mid;
    else hi = mid;
  }
  if (pts[hi].at - pts[lo].at > HOLE) return -Infinity;
  return pts[lo].db + ((pts[hi].db - pts[lo].db) * (ms - pts[lo].at)) / (pts[hi].at - pts[lo].at);
}

// An aircraft's path cut into unbroken runs of samples between two times, leaving out the stretches
// quieter than `least`. Each run has one sample more at each end, so that a line drawn through it
// reaches the edge of the timeline, or comes down to the bottom of the scale.
export function runs(plane, from, to, least = -Infinity) {
  const out = [];
  let run = null;
  plane.pts.forEach((p, i, pts) => {
    const near = [pts[i - 1] ?? p, p, pts[i + 1] ?? p];
    if (near[2].at < from || near[0].at > to || !near.some((q) => q.db >= least)) return (run = null);
    if (!run || p.at - run.at(-1).at > HOLE) out.push((run = []));
    run.push(p);
  });
  return out;
}

// A new forecast that moves no point of the old one by more than this (ms, dB) is the same curve, a
// fraction of a pixel away: morph() is given it, so the timeline does not ease, and redraw, for nothing.
export const UNCHANGED = { t: 50, at: 50, db: 0.2 };

// One aircraft's curve between two times, as the timeline draws it while `shown` (its points easing
// into the newest forecast, by morph() in map-geo.js) may still be catching up with `plane.pts`.
// Whether it shows at all, whether it reaches the warning level (`loud`), when its loudest moment is
// (`at`) and whether that is on the timeline (`peaked`) are the newest forecast's. Only the outline
// (`lines`) and `anchor`, where the name's pole stands, are the eased ones: the anchor is the eased
// point that becomes the newest peak, kept between the two times, and its `db` may be below the chart.
// Null when the newest forecast has nothing on the timeline above the bottom of the chart.
export function curve(plane, shown, from, to, floor) {
  const least = floor + LOW;
  const inView = (p) => p.at >= from && p.at <= to;
  const newest = runs(plane, from, to, least).flat();
  const top = newest.reduce((most, p) => (inView(p) && p.db > (most?.db ?? least) ? p : most), null);
  if (!top) return null;
  const anchor = (shown !== plane.pts && shown[plane.pts.indexOf(top)]) || top;
  return {
    lines: shown === plane.pts ? runs(plane, from, to, least) : runs({ pts: shown }, from, to, least),
    loud: top.db >= floor,
    at: top.at,
    peaked: !newest.some((p) => !inView(p) && p.db > top.db),
    anchor: { at: Math.min(to, Math.max(from, anchor.at)), db: anchor.db },
  };
}

// The stretches of time in which some aircraft is predicted at or above `floor`: [[from, to], ...]
// in ms, in order. Like predict.js, a stretch runs from the first sample at the floor to the last.
export function audible(planes, floor) {
  const spans = [];
  for (const { pts } of planes.values()) {
    let span = null;
    pts.forEach((p, i) => {
      if (p.db < floor || (span && p.at - pts[i - 1].at > HOLE)) span = null;
      if (p.db < floor) return;
      if (span) span[1] = p.at;
      else spans.push((span = [p.at, p.at]));
    });
  }
  return joined(spans);
}
// Stretches of time put in order, with any that touch or overlap run together.
function joined(spans) {
  return spans
    .sort((a, b) => a[0] - b[0])
    .reduce((out, s) => {
      if (out.length && s[0] <= out.at(-1)[1]) out.at(-1)[1] = Math.max(out.at(-1)[1], s[1]);
      else out.push(s);
      return out;
    }, []);
}

// When the page holds, for the rail under the timeline: [[from, to], ...] in ms. Up to `at`, the
// moment of the newest flight data, it is what was predicted at the time, from the paths kept. From
// `at` on it is the page's own audible `windows` and nothing else, so the timeline cannot show a hold
// that the banner does not have. `shown` are the stretches the banner itself said Hold, which include
// the few seconds it waits before calling a hold over, so the rail never ends before the banner does.
export function held(planes, windows, at, floor, shown = []) {
  const past = audible(planes, floor).filter(([from]) => from < at).map(([from, to]) => [from, Math.min(to, at)]);
  const ahead = windows.filter((w) => !w.unsure && w.end > at).map((w) => [Math.max(w.start, at), w.end]); // an aircraft the page lost track of is no hold
  return joined([...past, ...ahead, ...shown.map((s) => [...s])]);
}

// The pitches to draw for an aircraft matched by its tones. Where the engine found them to be the
// harmonics of one note, that is the whole series up to the highest tone it found: the engine often
// leaves the lowest and strongest harmonics out of `tones`, and this puts a curve on those too. An
// octave error in the note would show as curves with no sound under them.
export const series = ({ hz, fundamental }) => (fundamental && hz.length ? Array.from({ length: Math.round(Math.max(...hz) / fundamental) }, (_, i) => (i + 1) * fundamental) : hz);

// A curve the engine fitted (hear.js `curves`), as lines to draw over the spectrogram: one for each
// emitted tone, [[at, hz], ...] every `step` ms from when its tones were first seen to the last.
export function fittedLines(c, step = 250) {
  const out = [];
  for (const hz of c.hz) {
    const line = [];
    for (let at = c.from; at <= c.to + step / 2; at += step) line.push([Math.min(at, c.to), hz * flyby(Math.min(at, c.to), c)]);
    out.push(line);
  }
  return out;
}

const signed = (s) => `${s > 0 ? '+' : s < 0 ? '−' : ''}${Math.abs(s).toFixed(1)}`;
const KIND = { propeller: 'propeller?', jet: 'jet?' };
// The values beside a fitted curve: speed, how near it came, what it sounds like, and how early (−)
// or late (+) its aircraft passed against the feed. With no aircraft, about how long until it may
// fade. All but the offset come from the fit alone, which can trade speed for distance, so they are
// marked as estimates.
export function fitLabel(c, now) {
  const out = [`~${Math.round(c.speed)} m/s`, `~${Math.round(c.distance)} m`];
  if (KIND[c.kind]) out.push(KIND[c.kind]);
  if (c.hex && c.offset != null) out.push(`${signed(c.offset)} s`);
  else if (c.until > now) out.push(`fade ~${Math.round((c.until - now) / 1000)} s`);
  return out.join(' · ');
}

// Why an expected aircraft was or was not matched, one line each, loudest first: its name, how much
// its pitch is bending, what the tone search made of it (hear.js `tried`) and, if a heard curve was
// tried against it, what that made of it. At most `most` lines.
const PITCH = { null: 'pitch matched', short: 'pitch: too little track', tone: 'pitch: no tone', steady: 'pitch: steady tone', rival: 'pitch: fits another', drift: 'pitch: drifting tone', weak: 'pitch: weak' };
const CURVE = { partial: 'curve: not passed yet', shape: 'curve: wrong shape', distance: 'curve: wrong distance', ambiguous: 'curve: fits another' };
export function triedLines(status, name, most = 4) {
  const pitch = new Map(status.tried.map((t) => [t.hex, t.why]));
  const curve = new Map();
  for (const c of status.curves) for (const t of c.tried) if (!curve.has(t.hex) || t.why === null) curve.set(t.hex, t);
  return status.expected.slice(0, most).map((e) => {
    const parts = [name(e.hex)];
    if (e.swing != null) parts.push(`${Math.round(e.swing)} % swing`);
    if (pitch.has(e.hex)) parts.push(PITCH[pitch.get(e.hex)]);
    const t = curve.get(e.hex);
    if (t) parts.push(t.why === null ? `curve ${signed(t.offset)} s` : t.why === 'time' ? `curve: ${signed(t.offset)} s off` : CURVE[t.why]);
    return parts.join(' · ');
  });
}

// Which row each aircraft's name goes on so that none touch: Map hex -> row. `items` are
// { hex, x, w } (left edge and width), most important first. `before` is the last answer: a name
// keeps its row as the timeline slides under it, and only moves up when a higher row has room to
// spare, so two names that are nearly touching do not swap back and forth. A name that fits on no
// row is left out.
export function place(items, rows, before = new Map(), gap = 8) {
  const placed = new Map();
  const used = Array.from({ length: rows }, () => []);
  const fits = (row, it, room = gap) => !used[row].some((o) => it.x < o.x + o.w + room && o.x < it.x + it.w + room);
  const put = (row, it) => (used[row].push(it), placed.set(it.hex, row));
  for (const it of items) {
    const was = before.get(it.hex);
    if (!(was < rows)) continue;
    const row = used.findIndex((_, r) => (r < was ? fits(r, it, 4 * gap) : r === was && fits(r, it)));
    if (row >= 0) put(row, it);
  }
  for (const it of items) {
    if (placed.has(it.hex)) continue;
    const row = used.findIndex((_, r) => fits(r, it));
    if (row >= 0) put(row, it);
  }
  return placed;
}

// The same tracks with the page's per-category trim taken back out of their levels. The demo's sound
// is made from these: its made-up world must not get louder because the page learned it was loud.
export const untrimmed = (tracks, trim) => tracks.map((w) => (trim[w.category] ? { ...w, path: w.path.map((p) => ({ ...p, db: p.db - trim[w.category] })) } : w));

// ---- The audio clock ----

// Wall-clock time for audio, counted in samples. stamp() takes how far the audio clock had got at
// the end of a block (ms) and when the message carrying it arrived (epoch ms), and gives the epoch ms
// of that last sample. Messages arrive late by a varying amount, so the two clocks are tied together
// by the promptest message seen lately, and a late one changes nothing. Only when blocks have kept
// arriving half a second late for 3 s of real time (the audio was suspended, or the machine slept)
// does the tie jump, which the engine sees as the microphone having stopped.
// shortcut: the time sound takes to get through the input device (tens of ms) is not taken off.
export function createClock() {
  let offset = null; // wall-clock ms at audio time 0
  let lateSince = null;
  return {
    reset: () => (offset = lateSince = null),
    stamp(audioMs, arrivedMs) {
      const d = arrivedMs - audioMs;
      if (offset == null || d <= offset) offset = d;
      else if (d > offset + 500) {
        lateSince ??= arrivedMs;
        if (arrivedMs - lateSince > 3000) offset = d;
      }
      if (d <= offset + 500) {
        lateSince = null;
        offset += Math.min(d - offset, 0.01); // an audio clock that runs slow is followed, up to 100 parts in a million
      }
      return audioMs + offset;
    },
  };
}

// ---- Words ----

const list = (type) => (items) => new Intl.ListFormat('en-GB', { type }).format(items);
const and = list('conjunction');
const or = list('disjunction');

// What is being heard, as [headline, a few words more]. `status` is the engine's, `name` gives an
// aircraft's name for its hex, and `stale` is true when flight data has stopped. Only what the engine
// says now decides the words: an aircraft it named a moment ago is not named any longer once it
// reports plain noise, because noise that follows a match may be something else. (It can only pin
// tones on an aircraft while its pitch is bending, so a propeller aircraft is "probably" before and
// after that.) The words only change when the facts do. A headline is short enough for one line on a
// phone, and what follows it for two: listen.css gives them that room and no more.
export function say({ status, name, stale }) {
  if (status.signal === false) return ['No microphone signal', 'Check it is not muted and the right input is chosen.'];
  if (!status.ready) return ['Learning the background', 'About 20 seconds.'];
  const { heard } = status;
  if (!heard.length) return ['Quiet', ''];
  if (stale) return ['Noise', 'No flight data to match it to.'];
  const tones = heard.filter((h) => h.how === 'doppler');
  if (tones.length) return [`Hearing ${and(tones.map((h) => name(h.hex)))}`, 'Matched by pitch.'];
  const [h] = heard;
  if (h.how === 'envelope') return [`Hearing ${name(h.hex)}`, 'Matched by loudness.'];
  const who = h.candidates.map(name);
  if (who.length > 1) return ['Aircraft noise', `Could be ${or(who.length > 3 ? [...who.slice(0, 3), `${who.length - 3} more`] : who)}.`];
  if (who.length) return ['Aircraft noise', `Probably ${who[0]}.`];
  return ['Unexplained noise', 'No tracked aircraft fits it.'];
}

// Why the microphone is not running, as [headline, what to do].
export const PROBLEMS = {
  insecure: ['Microphone needs https', 'Use https, or localhost on the computer running it.'],
  unsupported: ['Microphone not supported', 'Use a current Chrome, Edge, Safari or Firefox.'],
  denied: ['Microphone blocked', "Allow it in the browser's site settings, then press Listen."],
  none: ['No microphone found', 'Connect or enable one, then press Listen.'],
  busy: ["Microphone won't open", 'Close any app using it, then press Listen.'],
  unplugged: ['Microphone disconnected', 'Reconnect it, or press Listen for another input.'],
  suspended: ['Listening is paused', 'Tap the page to carry on.'],
};

// What has been learned at this set, as a short status. `t` is tune()'s result and `floor` the
// warning level in use now, or null while the page has not taken up what was learned.
export function explain(t, { floor }) {
  // Aircraft the page expected and the microphone did not hear never move the level: a covered or
  // muted microphone looks exactly the same. They are only counted, and what to do is the user's call.
  const missed = t.unheard ? ` ${t.unheard} expected aircraft not heard: check the microphone, or raise the level.` : '';
  if (t.floor == null) return `Learning: ${t.heard} of 4 aircraft heard.${missed}`;
  const level = Math.round(t.floor);
  const set = Math.min(65, Math.max(15, level)); // the slider's range
  // The one place the learned level is given, so the one place it is called an estimate. Under 4
  // heard it has only been lowered (tune.js).
  let out =
    t.heard < 4
      ? `Learning: ${t.heard} of 4 aircraft heard. Level lowered to ${level} dBA (estimate).`
      : `Learned from ${t.heard} aircraft: warning level ${level} dBA (estimate), ${t.settled ? 'settled' : `settling ±${Math.max(1, Math.round(t.error))} dB`}.`;
  if (set !== level) out += ` Slider stops at ${set}.`;
  if (floor != null && floor !== set) out += ` You moved it to ${floor}.`;
  const trims = Object.entries(t.trim).map(([category, dB]) => `${CLASS_NAME[category] ?? category} ${Math.abs(dB)} dB ${dB > 0 ? 'louder' : 'quieter'} than predicted`);
  if (trims.length) out += ` By type: ${and(trims)}.`;
  return out + missed;
}

// A few words on a pass that has just finished. `o` is the engine's observation with two things
// added: `name`, and `was`, the warning level in use at the time.
export function recap(o) {
  if (o.how === 'unexplained') return `Last: ${o.seconds} s of unexplained noise.`;
  if (o.how === 'unsure') return `Last: noise while ${o.name} was due, not matched.`;
  if (o.how === 'unheard') return `Last: ${o.name} predicted, not heard.`;
  const by = o.how === 'doppler' ? 'pitch' : 'loudness';
  // Heard against the page's estimate of an aircraft the feed had lost (`lost`, set by listen-core.js).
  if (o.lost) return `Last: ${o.name} heard by ${by}, not used for tuning (estimate: contact lost).`;
  // Heard, but the engine would not take its loudness as that aircraft's own (another was as loud, or
  // the sound did not peak when predicted): there is no figure for it, and none is made up here.
  if (o.floor == null) return `Last: ${o.name} heard by ${by}, not used for tuning.`;
  const off = Math.round(o.was - o.floor); // audible at a lower prediction than the warning level: louder than predicted
  return `Last: ${o.name}, matched by ${by}, ${Math.abs(off) < 2 ? 'about as loud as predicted' : `${Math.abs(off)} dB ${off > 0 ? 'louder' : 'quieter'} than predicted`}.`;
}
// Whether a finished pass is worth that sentence: something was heard, or an aircraft the page
// warned about went unheard. An aircraft predicted too faint to hear, and not heard, is no news.
export const notable = (o, floor, trim = {}) => o.heard === true || o.predPeak + (trim[o.category] ?? 0) >= floor;

// ---- What is stored ----

// The scale stored passes were predicted on. A pass keeps the level the page predicted for it, and
// tune() compares that with what was heard, so passes predicted on another scale would tune this one
// wrongly: when the loudness model changes, this goes up and older passes are dropped. The input
// chosen is kept.
export const SCALE = 2;

// The saved text, checked. Anything that is not the shape written here is left out, so a damaged or
// hand-edited entry cannot stop the panel or reach tune(): a set needs a time and a list, and a pass
// in it needs what remember() required of it when it was stored, with numbers where numbers go.
export function restore(text) {
  let saved = null;
  try {
    saved = JSON.parse(text);
  } catch {}
  const plain = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
  const pass = (o) => plain(o) && typeof o.hex === 'string' && Number.isFinite(o.confidence) && Number.isFinite(o.predPeak) && (o.heard === false || (o.heard === true && Number.isFinite(o.floor)));
  const sets = {};
  for (const [key, set] of Object.entries(plain(saved) && saved.scale === SCALE && plain(saved.sets) ? saved.sets : {})) {
    if (!plain(set) || !Number.isFinite(set.at) || !Array.isArray(set.list)) continue;
    const list = set.list.filter(pass);
    if (list.length) sets[key] = { at: set.at, list };
  }
  // Whether listening was on is not kept: it only ever starts when the button is pressed.
  return { scale: SCALE, device: typeof saved?.device === 'string' ? saved.device : '', sets };
}

// Whether two tunings ({ floor, trim }) are the same thing to the page.
const canon = ({ floor, trim }) => JSON.stringify([floor ?? null, Object.entries(trim ?? {}).sort()]);
export const sameTuning = (a, b) => canon(a) === canon(b);

// What is learned belongs to one set and one environment. 3 decimals is about 100 m.
// The exact place, as app.js sees it: it drops its tuning whenever the coordinates change at all, so
// two addresses a few metres apart are two sets here too.
export const siteKey = (site, env) => `${site.lat},${site.lon} ${env}`;

// `sets` (key -> { at, list }) with one set's list replaced, or removed when it is empty. Only the 12
// sets used most recently are kept, and each pass is kept without its level curve, which tuning
// never reads, so a season of sets cannot fill the browser's storage.
export function file(sets, key, observations, at) {
  const next = { ...sets, [key]: { at, list: observations.map(({ curve, ...o }) => o) } };
  if (!observations.length) delete next[key];
  return Object.fromEntries(Object.entries(next).sort((a, b) => b[1].at - a[1].at).slice(0, 12));
}
