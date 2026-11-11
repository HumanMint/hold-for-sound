// What the listening panel knows and decides, with no page in it: which set and environment it is
// at, the engine and what it has heard, what was learned, and what the page is told. listen.js gives
// it the page's events and the audio, and draws what it holds. It runs the same under `node --test`,
// where test/listen-core.test.js plays app.js's side of the exchange.
//
//   const core = createCore({ load, save, send, clock, changed, report })
//       load()            the saved text, or null          save(text)    keep it
//       send(name, detail)    an event for the page: `hfs:tune` or `hfs:timing`
//       clock()           epoch ms now (Date.now)          changed()     something to show has changed
//       report(detail)    each second of listening, what was measured in it: listen.js sends it as
//                         `hfs:heard` (app.js describes it). It changes nothing here.
//   core.update(detail) → true if this is another set or environment than the last. Every `hfs:update`.
//   core.begin(kind, sampleRate)    start listening to 'mic' or 'demo'        core.stop()
//   core.hear(pcm, endMs) → the spectrogram columns that audio completed
//   core.forget()         throw away what was learned at this set
//   core.again()          learn the background again (the microphone was moved)
//   core.mute(on)         the browser says the microphone is muted, or is back
//   To show: feed, source, ear, forecast, heard, tones, fitted, last, list, own, saved, learned(), stale(), inStep()
//   `fitted` is the newest fit of each curve the engine fitted in the last 5 minutes (hear.js `curves`).
//
// The rules that keep the warning level right:
// - What was learned belongs to one set and one environment. When either changes, the engine, the
//   forecast and everything heard so far are started afresh before anything of the new one is taken
//   in, so a pass under way at the old set can never be filed under the new one.
// - Nothing is matched or learned on old flight data. Once the newest data is 20 s old the engine is
//   told to expect nobody (no tracks, no floor), but kept, with the background it has learned. When
//   fresh data arrives it is given tracks again, and no pass whose sound reaches back before then is
//   learned, so the sound heard during the gap is never matched against either forecast.
// - The page says what tuning it has in effect in every update (`learned` and `trim`). Whenever that
//   is not what was learned here, it is told. Nothing is remembered about what was sent before.
// - A demo's tuning is sent marked `demo`, which the page applies without saving and undoes by itself
//   at the next unmarked one. Starting a demo always sends a marked one and stopping it an unmarked
//   one, so whatever the user does to the slider in between is undone, here too: the user's level is
//   put back before the real tuning is worked out again. A demo's passes never reach storage.
// - How late the feed runs is measured from curves (hear.js `curves`): each aircraft whose curve was
//   matched to its track gives its own offset. The page is sent `hfs:timing` whenever what it should
//   use changes: each aircraft's latest offset for 10 minutes, and the middle of the last five
//   aircraft's for the rest, once there are two. A curve heard at any time while the flight data was
//   old, or while its aircraft's track was an estimate, gives none, and all of it is dropped whenever
//   the engine is replaced (above). Never stored.
// - Nothing is learned from an estimate. The page carries on an aircraft the feed has lost (lost.js)
//   and marks its track `lost`. The engine is given that track like any other, so it still expects
//   the aircraft and can name it, but a pass whose peak was due while the track was an estimate is
//   never stored: when and how loud it was predicted to be were both guesses.

import { createEar } from './hear.js';
import { tune, remember } from './tune.js';
import { STALE_MS } from './status.js';
import { LOST_S } from './lost.js';
import { createForecast, notable, siteKey, file, restore, sameTuning } from './listen-view.js';

const OWN_TIMING_MS = 600_000; // how long an aircraft's own measured offset is used
const KEEP_TIMING_MS = 1_800_000; // and how long it counts towards the middle of the last five

export function createCore({ load, save, send, clock = Date.now, changed = () => {}, report = () => {} }) {
  const saved = restore(load()); // { device, sets }: the input chosen, and a list per set
  const keep = () => save(JSON.stringify(saved));

  let feed = null; // the last `hfs:update`
  let key = ''; // the set and environment it is for
  let list = []; // what the microphone has learned there
  let demoList = []; // what the demo has, which is never saved
  let own = null; // the warning level the page uses when nothing is learned: the user's own setting
  let real = null; // while a demo runs: { own } from before it, which the demo's slider must not change
  let source = ''; // what is being listened to: '', 'mic' or 'demo'
  let rate = 0; // its sample rate
  let ear = null; // the engine, while listening
  let muted = false; // the browser says the microphone is muted
  let forecast = createForecast();
  let wasStale = false; // the engine in use has been given no tracks, because flight data was old
  let back = 0; // when flight data last turned fresh after being old: passes reaching back before it are not learned
  let cut = false; // flight data that was there has gone old, and not yet come back
  let gaps = []; // [[from, to], ...]: the stretches in which flight data was old. The last `to` is Infinity until it is fresh again
  const heard = []; // { at, rise } once a second: how far the sound was above the background
  const tones = new Map(); // hex -> { hz: [...], fundamental, confidence }: aircraft matched by pitch
  let seenAt = null; // `at` of the last engine status dealt with
  const since = []; // the spectrogram columns not yet given to report(): it gets a second of them at a time
  let last = null; // the last pass worth a sentence
  const guessed = new Map(); // hex -> [[from, to], ...]: the stretches in which its track was an estimate (`lost`). The last `to` is Infinity until it is reported again
  let fitted = []; // the newest fit of each curve heard lately, to draw
  const timing = new Map(); // hex -> { offset, at }: how many seconds after its track an aircraft's curve said it passed, and when
  let told = '{"offsets":{},"lag":null}'; // the last `hfs:timing`, as JSON

  const stale = () => !feed || clock() - (feed.dataAt ?? feed.at) > (feed.staleMs ?? STALE_MS);
  const learned = () => tune(source === 'demo' ? demoList : list, own);
  const inEffect = () => ({ floor: feed.learned ?? null, trim: feed.trim ?? {} });

  // Tell the page what was learned, if that is not what it has. `anyway` is for the end of a demo:
  // the page undoes a demo at the next unmarked tuning, even one that changes nothing.
  function sync(anyway) {
    if (!feed) return;
    const { floor, trim, early } = learned();
    if (anyway || !sameTuning({ floor, trim }, inEffect())) send('hfs:tune', { floor, trim, ...(early && { early }), ...(source === 'demo' && { demo: true }) });
  }

  // Tell the page how late the feed has been running here, if that has changed.
  function timed() {
    const now = clock();
    for (const [hex, t] of timing) if (t.at < now - KEEP_TIMING_MS) timing.delete(hex);
    const recent = [...timing.values()].sort((a, b) => b.at - a.at).slice(0, 5).map((t) => t.offset).sort((a, b) => a - b);
    const offsets = Object.fromEntries([...timing].filter(([, t]) => t.at >= now - OWN_TIMING_MS).map(([hex, t]) => [hex, t.offset]));
    const detail = { offsets, lag: recent.length >= 2 ? recent[recent.length >> 1] : null, ...(source === 'demo' && { demo: true }) };
    const text = JSON.stringify(detail);
    if (text !== told) send('hfs:timing', detail);
    told = text;
  }

  // A new engine: no pass under way, and no tone matched, can carry over into it.
  function newEar() {
    if (source) (ear = createEar({ sampleRate: rate })).mute(muted);
    timing.clear();
    if (feed) timed();
    fitted = [];
    tones.clear();
    seenAt = null;
    since.length = 0;
  }
  // And nothing heard before, either.
  function afresh() {
    newEar();
    heard.length = 0;
    last = null;
  }

  // Called before tracks or audio reach the engine. Old flight data must not be matched against, so
  // when it goes stale the engine is told to expect nobody, and keeps listening: replacing it cost
  // 20 s of learning the background each time, and once learned a takeoff as the background. When the
  // data is fresh again, what reaches back into the gap is not learned (gap()). Returns whether the
  // data is stale now.
  function gate() {
    const old = stale();
    if (old && !wasStale && feed) {
      ear?.update({ at: clock(), tracks: [], trim: feed.trim ?? {}, floor: null });
      cut = true;
      gaps = [...gaps.filter(([, to]) => to >= clock() - 600_000), [clock(), Infinity]]; // the engine keeps 10 min
    }
    if (!old && cut) {
      [back, cut] = [clock(), false];
      gaps.at(-1)[1] = back;
    }
    return (wasStale = old);
  }

  // Whether a pass's peak was due while its aircraft's track was the page's estimate.
  const guess = (o) => (guessed.get(o.hex) ?? []).some(([from, to]) => o.at >= from && o.at < to);
  // Whether a pass's sound reaches back before the flight data last came back: it may straddle a gap.
  const gap = (o) => (o.curve?.from ?? o.at) < back;
  // Whether a curve's tones were heard while the flight data was old or its aircraft's track was an
  // estimate: then the track it was measured against was not the feed's.
  const unsure = (c) => [...gaps, ...(guessed.get(c.hex) ?? [])].some(([from, to]) => c.from < to && c.to >= from);

  function learn(fresh) {
    for (const o of fresh) {
      if (o.how === 'doppler') tones.set(o.hex, { hz: o.tones, fundamental: o.fundamental, confidence: 1 });
      // "Louder than predicted" is against the level the page takes as just audible: what was learned
      // if anything was, and not wherever the user has since moved the slider.
      if (notable(o, feed.floor, feed.trim)) last = { ...o, name: forecast.planes.get(o.hex)?.name ?? o.hex, was: feed.learned ?? feed.floor, lost: guess(o) };
    }
    fresh = fresh.filter((o) => !guess(o));
    if (source === 'demo') demoList = remember(demoList, fresh);
    else {
      list = remember(list, fresh);
      saved.sets = file(saved.sets, key, list, clock());
      keep();
    }
    sync();
  }

  return {
    saved,
    keep,
    learned,
    stale,
    // Whether the page has what was learned here in effect, so that its slider can be compared with it.
    inStep: () => !!feed && sameTuning(learned(), inEffect()),
    get feed() { return feed; },
    get source() { return source; },
    get ear() { return ear; },
    get forecast() { return forecast; },
    get heard() { return heard; },
    get tones() { return tones; },
    get fitted() { return fitted; },
    get last() { return last; },
    get list() { return list; },
    get own() { return own; },

    update(detail) {
      gate(); // a gap in the flight data that ends with this update still counts
      const k = siteKey(detail.site, detail.env);
      const moved = k !== key;
      if (moved) {
        key = k;
        list = saved.sets[k]?.list ?? [];
        demoList = [];
        real = null; // the page has dropped its tuning, so its slider is the real level of the new one
        forecast = createForecast();
        afresh();
      }
      feed = detail;
      for (const w of feed.tracks) {
        const spans = guessed.get(w.hex) ?? [];
        const open = spans.at(-1)?.[1] === Infinity;
        // It became an estimate when its position turned LOST_S old, or by the time of the answer that
        // left it out, which can be before this update came. Contact that flickers leaves several
        // stretches, and a peak in any of them was a guess.
        if (w.lost && !open) guessed.set(w.hex, [...spans.slice(-7), [Math.min(w.seenAt + LOST_S * 1000, feed.dataAt ?? feed.at), Infinity]]);
        if (!w.lost && open) spans.at(-1)[1] = feed.at;
      }
      for (const [hex, spans] of guessed) if (spans.at(-1)[1] < feed.at - 600_000 || guessed.size > 500) guessed.delete(hex); // the engine keeps 10 min; the oldest go first
      if (feed.learned == null) own = feed.floor;
      forecast.update(feed);
      if (!gate()) ear?.update(feed);
      sync();
      return moved;
    },

    begin(kind, sampleRate) {
      [source, rate, demoList, muted] = [kind, sampleRate, [], false];
      if (kind === 'demo') real = { own };
      afresh();
      wasStale = stale();
      if (!wasStale) ear.update(feed);
      sync(kind === 'demo'); // the page must know a demo has begun even when it has nothing to say yet
    },

    stop() {
      const demo = source === 'demo';
      [source, ear, demoList] = ['', null, []];
      if (real) own = real.own;
      real = null;
      afresh();
      sync(demo);
    },

    hear(pcm, endMs) {
      const old = gate();
      const columns = ear.push(pcm, endMs);
      since.push(...columns);
      const s = ear.status();
      if (s.at === seenAt) return columns;
      seenAt = s.at;
      // The engine's level is smoothed over 6 s, so it describes the moment 3 s before.
      if (s.ready) heard.push({ at: s.at - 3000, rise: s.rise });
      while (heard[0]?.at < s.at - 240_000) heard.shift();
      // The tones from the second the engine was surest of them, which is the set it files with the pass.
      for (const h of s.heard) if (h.how === 'doppler' && h.confidence > (tones.get(h.hex)?.confidence ?? 0)) tones.set(h.hex, { hz: h.tones, fundamental: h.fundamental, confidence: h.confidence });
      // Curves matched to a track say how late the feed was for it, unless that track was an estimate
      // or the data old at any time while they were heard.
      for (const c of s.curves) if (c.hex && c.offset != null && !old && !unsure(c)) timing.set(c.hex, { offset: Math.round(c.offset * 2) / 2, at: s.at });
      timed();
      // A new fit replaces the last one for its aircraft and any with no aircraft that it overlaps. One
      // with no aircraft is not added over an aircraft's: it is the same sound, before it was matched.
      const over = (a, b) => a.from <= b.to && b.from <= a.to;
      for (const c of s.curves.filter((c) => c.at != null)) {
        if (!c.hex && fitted.some((f) => f.hex && over(f, c))) continue;
        fitted = [...fitted.filter((f) => !((c.hex && f.hex === c.hex) || (!f.hex && over(f, c)))), c];
      }
      fitted = fitted.filter((f) => f.to >= s.at - 300_000);
      const fresh = ear.observations().map((o) => (old || gap(o) ? { ...o, stale: true } : o));
      // On old flight data the engine has no tracks: whatever it files is not a pass, and nor is one across a gap.
      if (fresh.some((o) => !o.stale)) learn(fresh.filter((o) => !o.stale));
      // The columns up to the status's own moment: audio comes in pieces that need not end on the second.
      const second = since.splice(0, since.findLastIndex((col) => col.at <= s.at) + 1);
      report({ demo: source === 'demo', rate, status: s, columns: second, observations: fresh.map((o) => (guess(o) ? { ...o, lost: true } : o)), stale: old });
      changed();
      return columns;
    },

    forget() {
      list = [];
      last = null;
      saved.sets = file(saved.sets, key, list, clock());
      keep();
      sync();
    },

    again() {
      ear.forget();
      changed();
    },

    // The browser's word on whether the microphone is muted. It outlives a change of engine.
    mute(on) {
      ear.mute((muted = on));
    },
  };
}
