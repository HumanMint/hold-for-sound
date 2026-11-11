import test from 'node:test';
import assert from 'node:assert/strict';
import { predict, ENVIRONMENTS } from '../public/predict.js';
import { createSynth } from '../public/synth.js';
import { createCore } from '../public/listen-core.js';
import { siteKey, recap } from '../public/listen-view.js';
import { follow } from '../public/lost.js';

// The life of the warning level: the exchange of `hfs:update` and `hfs:tune` between the listening
// panel and the page, as addresses and environments change, flight data goes stale, a demo starts and
// stops, the page is reloaded, and the user moves the slider. The panel's side is the real one
// (listen-core.js, with hear.js hearing synth.js). The page's side is page() below.

const RATE = 16000;
const START = 1_800_000_000_000;
const A = { name: 'A', lat: 40, lon: -100, elevM: 0, runways: [] };
const B = { ...A, name: 'B', lat: 40.3 }; // 33 km away: nothing that passes A is heard there
const C = { ...A, name: 'C', lat: 39.7 };

// app.js's side, kept in step with public/app.js by hand: its `hfs:tune` handler, endDemo(), untune(),
// what moving the slider and changing the address or environment do, and what it saves and reloads.
function page({ site = A, env = 'outdoors', slider = ENVIRONMENTS[env].floor } = {}) {
  let tuned = { floor: null, trim: {} };
  let offset = 0;
  let manual = null;
  let real = null;
  let stored = null;
  const endDemo = () => {
    if (!real) return;
    ({ tuned, offset, manual } = real);
    slider = real.floor;
    real = null;
  };
  const untune = () => {
    endDemo();
    if (manual != null) slider = manual;
    tuned = { floor: null, trim: {} };
    offset = 0;
    manual = null;
  };
  const save = () => {
    if (!real) stored = { env, floor: slider, manual, offset, site };
  };
  save();
  return {
    get site() { return site; },
    get env() { return env; },
    get slider() { return slider; },
    get tuned() { return tuned; },
    get offset() { return offset; },
    get demo() { return !!real; },
    tune(detail) {
      if (detail.demo) real ??= { tuned, offset, manual, floor: slider };
      else endDemo();
      tuned = { floor: detail.floor ?? null, trim: detail.trim ?? {}, early: !!detail.early };
      if (tuned.floor != null) {
        manual ??= slider;
        slider = Math.min(65, Math.max(15, Math.round(tuned.floor + offset))); // the input clamps it to its own range
      } else {
        if (manual != null) slider = manual;
        manual = null;
        offset = 0;
      }
      save();
    },
    move(to) {
      slider = to;
      if (tuned.floor != null) {
        offset = slider - tuned.floor;
        if (tuned.early) manual = slider;
      }
      save();
    },
    setEnv(to) {
      untune();
      env = to;
      slider = ENVIRONMENTS[to].floor;
      save();
    },
    setSite(to) {
      if (to.lat !== site.lat || to.lon !== site.lon) untune();
      site = to;
      save();
    },
    reload() {
      ({ env, site } = stored);
      [tuned, manual, real] = [{ floor: null, trim: {} }, null, null];
      slider = stored.manual ?? stored.floor;
      offset = stored.offset ?? 0;
    },
  };
}

// The two sides wired together, with a clock. `traffic` is where the aircraft really are: functions
// giving each one's feed row at a second (see flying). `feed` turns those rows into what the feed
// reports that second, which is all of them unless a test has it lose one. The page follows the feed
// as app.js does, through lost.js; the sound is always made from where the aircraft really are. The
// microphone stays at A whatever address is typed.
function rig({ stored = null, ...page0 } = {}) {
  let text = stored;
  let now = START;
  let core;
  const sent = [];
  const timings = []; // every `hfs:timing`, which app.js takes up at its next poll
  const pg = page(page0);
  const boot = () =>
    (core = createCore({
      load: () => text,
      save: (to) => (text = to),
      clock: () => now,
      send(name, detail) {
        if (name === 'hfs:timing') return timings.push(detail);
        assert.equal(name, 'hfs:tune');
        sent.push(detail);
        pg.tune(detail);
      },
    }));
  boot();
  const tracks = (site, trim) => r.traffic.map((p) => predict(p((now - START) / 1000), site, { loss: 0, floor: -Infinity, trim })).filter(Boolean);
  const known = new Map();
  const paged = (site, trim) => follow(known, r.feed(r.traffic.map((p) => p((now - START) / 1000)), (now - START) / 1000), now, site, () => ({ loss: 0, floor: pg.slider, trim })).tracks;
  const r = {
    pg,
    sent,
    timings,
    traffic: [],
    feed: (rows) => rows,
    get core() { return core; },
    get stored() { return JSON.parse(text ?? '{}'); },
    list: (site, env) => r.stored.sets?.[siteKey(site, env)]?.list ?? [],
    // A poll: app.js sends an update, and polls again at once after every `hfs:tune` it gets. Returns
    // whether the panel reported another set or environment (listen.js then stops a demo).
    poll(age = 0) {
      for (let n = 0, moved = false; ; n++) {
        const before = sent.length;
        moved = core.update({ at: now, dataAt: now - age * 1000, site: pg.site, env: pg.env, floor: pg.slider, trim: pg.tuned.trim, learned: pg.tuned.floor, aircraft: [], tracks: paged(pg.site, pg.tuned.trim), windows: [], taxiing: [] }) || moved;
        if (sent.length === before) return moved;
        assert.ok(n < 3, 'the page and the panel settle on one tuning and stop talking');
      }
    },
    // Listen for a while: a poll every 5 s, with the feed `age` seconds behind, and the sound heard a second at a time.
    listen(seconds, voice, age = 0) {
      for (const end = now + seconds * 1000; now < end; ) {
        r.poll(age);
        const pcm = voice.render(tracks(A, {}), now, now, 5);
        for (let i = 0; i < 5; i++) core.hear(pcm.subarray(i * RATE, (i + 1) * RATE), (now += 1000));
      }
    },
    reload() {
      pg.reload();
      boot();
      r.poll();
    },
  };
  return r;
}

// An aircraft flying straight and level that is over A (or `east` metres from it) `over` seconds in.
const flying = ({ hex, category = 'A3', track = 90, kt = 250, ft = 3000, over, east = 0 }) => (s) => {
  const gone = kt * 0.5144 * (s - over);
  const x = east + gone * Math.sin((track * Math.PI) / 180);
  const y = gone * Math.cos((track * Math.PI) / 180);
  return { hex, category, lat: A.lat + y / 111195, lon: A.lon + x / (111195 * Math.cos((A.lat * Math.PI) / 180)), alt_baro: ft, gs: kt, track, seen_pos: 0 };
};
// One jet over a 50 dB background, with the page warning at 60: heard by its swell, and filed about 85 s in.
const jet = flying({ hex: 'jet001', over: 55 });
const quiet = () => createSynth({ sampleRate: RATE, background: 50 });
// Five jets 45 s apart in a world 8 dB louder than predicted, over a 65 dB background. With the page
// warning at 65 each is heard clearly, and from the fourth (filed about 205 s in) the floor comes out near 57.
const five = Array.from({ length: 5 }, (_, i) => flying({ hex: `jet${i}`, track: 40 * i, ft: 1500 + 250 * (i % 5), over: 45 + 45 * i, east: 200 * (i % 4) }));
const loud = () => createSynth({ sampleRate: RATE, background: 65, louder: 8 });
// What `n` clear passes at one floor look like in storage.
const passes = (floor, n = 4) => Array.from({ length: n }, () => ({ hex: 'abc123', category: 'A3', how: 'envelope', heard: true, confidence: 0.75, predPeak: floor + 12, floor }));
const saved = (sets) => JSON.stringify({ on: false, device: '', sets: Object.fromEntries(sets.map(([site, env, floor, n]) => [siteKey(site, env), { at: START, list: passes(floor, n) }])) });

test('a pass heard with the microphone is filed under the set it was heard at, and tunes the page', () => {
  const r = rig({ slider: 60 });
  r.traffic = [jet];
  r.poll();
  r.core.begin('mic', RATE);
  r.listen(100, quiet());
  assert.equal(r.list(A, 'outdoors').length, 1);
  assert.equal(r.list(A, 'outdoors')[0].how, 'envelope');
  assert.deepEqual(r.sent, [], 'one pass is not enough to move the warning level');

  const many = rig({ slider: 65 });
  many.traffic = five;
  many.poll();
  many.core.begin('mic', RATE);
  many.listen(270, loud());
  assert.ok(many.list(A, 'outdoors').length >= 4, 'each pass is stored as it is filed');
  assert.ok(Math.abs(many.pg.tuned.floor - 57) <= 2 && !many.pg.demo, `the page was told ${many.pg.tuned.floor}`);
  assert.equal(many.pg.slider, Math.round(many.pg.tuned.floor));
  assert.ok(many.sent.every((d) => !('demo' in d)));
  assert.ok(many.core.inStep());
});

test('two passes heard under the user\'s level lower it before there are four', () => {
  const r = rig({ slider: 65 });
  r.traffic = five;
  r.poll();
  r.core.begin('mic', RATE);
  r.listen(100, loud());
  assert.equal(r.list(A, 'outdoors').length, 1);
  assert.deepEqual(r.sent, [], 'one pass is not enough');
  r.listen(40, loud());
  assert.equal(r.list(A, 'outdoors').length, 2);
  const floor = Math.max(...r.list(A, 'outdoors').map((o) => o.floor));
  assert.ok(floor < 63, `both heard well under 65, at ${floor}`);
  assert.deepEqual(r.sent, [{ floor, trim: {}, early: true }], 'lowered to the higher of the two');
  assert.equal(r.pg.slider, Math.round(floor));
  assert.ok(r.core.inStep(), 'and the panel and page agree on it');
});

test('a third pass that withdraws the early lowering leaves the slider where the user last put it', () => {
  const r = rig({ stored: saved([[A, 'outdoors', 42, 2]]), slider: 65 });
  r.poll();
  assert.deepEqual([r.pg.tuned.floor, r.pg.slider], [42, 42], 'two passes lower 65 to 42');
  r.pg.move(30);
  r.poll();
  r.traffic = [jet];
  r.core.begin('mic', RATE);
  r.listen(300, createSynth({ sampleRate: RATE, background: 65 })); // with the slider at 30 the pass ends only when the jet is far away
  assert.deepEqual(r.list(A, 'outdoors').map((o) => o.floor), [42, 42, 64.8], 'the third is heard just under 65');
  assert.deepEqual([r.pg.tuned.floor, r.pg.slider, r.pg.offset], [null, 30, 0], 'the lowering is withdrawn, and 30 stays');
  r.reload();
  assert.deepEqual([r.pg.tuned.floor, r.pg.slider], [null, 30]);

  // Left alone, the slider goes back to the user's 65.
  const alone = rig({ stored: saved([[A, 'outdoors', 42, 2]]), slider: 65 });
  alone.poll();
  alone.traffic = [jet];
  alone.core.begin('mic', RATE);
  alone.listen(300, createSynth({ sampleRate: RATE, background: 65 }));
  assert.equal(alone.list(A, 'outdoors').length, 3);
  assert.deepEqual([alone.pg.tuned.floor, alone.pg.slider, alone.pg.offset], [null, 65, 0]);
});

test('a pass heard while the feed had lost its aircraft is named, and not learned from', () => {
  // The jet of the test above, which was heard and filed. This time the feed stops hearing from it
  // 25 s in, half a minute before it is overhead, and repeats that position for a minute before it
  // drops the row. The page carries the jet on, and from 20 s without a position marks it as lost.
  const lose = (from) => (rows, s) => (s < from ? rows : [{ ...jet(from), seen_pos: s - from }]);
  const r = rig({ slider: 60 });
  r.traffic = [jet];
  r.feed = lose(25);
  r.poll();
  r.core.begin('mic', RATE);
  const voice = quiet();
  r.listen(55, voice);
  assert.equal(r.core.forecast.planes.get('jet001').lost, true, 'the timeline knows its forecast is an estimate');
  assert.ok(r.core.ear.status().expected.some((e) => e.hex === 'jet001'), 'the engine still expects it');
  r.listen(45, voice);
  // It flew on exactly as estimated, so the engine heard it just as it did above: but when and how
  // loud it was predicted to be was a guess, and nothing is stored.
  assert.deepEqual([r.core.last.hex, r.core.last.heard, r.core.last.lost], ['jet001', true, true]);
  assert.equal(recap(r.core.last), 'Last: jet001 heard by loudness, not used for tuning (estimate: contact lost).');
  assert.deepEqual(r.stored.sets ?? {}, {});
  assert.deepEqual(r.sent, []);

  // Lost only after it has passed: the pass was timed by reports, and is filed as usual.
  const after = rig({ slider: 60 });
  after.traffic = [jet];
  after.feed = lose(60);
  after.poll();
  after.core.begin('mic', RATE);
  after.listen(100, quiet());
  assert.deepEqual(after.list(A, 'outdoors').map((o) => o.hex), ['jet001']);
  assert.equal(after.core.last.lost, false);

  // Contact that flickers. Its position stops at 30 s, so it is an estimate from 50 s; at 60 s one
  // report comes, already 19 s old, and then nothing again. The peak, 58 s in, fell in the first
  // lost stretch, which the second must not wipe out.
  const flicker = rig({ slider: 60 });
  flicker.traffic = [jet];
  flicker.feed = (rows, s) => (s < 30 ? rows : s < 60 ? [{ ...jet(30), seen_pos: s - 30 }] : [{ ...jet(41), seen_pos: s - 41 }]);
  flicker.poll();
  flicker.core.begin('mic', RATE);
  flicker.listen(110, quiet());
  assert.deepEqual([flicker.core.last.hex, flicker.core.last.lost], ['jet001', true]);
  assert.deepEqual(flicker.stored.sets ?? {}, {});

  // Lost between two updates. Its last position is from 37 s in, so it is an estimate from 57 s,
  // though the page only finds out at the update 60 s in. The peak at 58 s was a guess all the same.
  const between = rig({ slider: 60 });
  between.traffic = [jet];
  between.feed = lose(37);
  between.poll();
  between.core.begin('mic', RATE);
  between.listen(100, quiet());
  assert.deepEqual([between.core.last.hex, between.core.last.lost], ['jet001', true]);
  assert.deepEqual(between.stored.sets ?? {}, {});

  // Lost and found again well before it passes: the pass was timed by reports, and is filed.
  const later = flying({ hex: 'jet080', over: 80 });
  const found = rig({ slider: 60 });
  found.traffic = [later];
  found.feed = (rows, s) => (s >= 30 && s < 60 ? [{ ...later(30), seen_pos: s - 30 }] : rows);
  found.poll();
  found.core.begin('mic', RATE);
  found.listen(130, quiet());
  assert.deepEqual(found.list(A, 'outdoors').map((o) => o.hex), ['jet080']);
  assert.equal(found.core.last.lost, false);
});

// Finding 1.
test('a pass under way when the address changes is not filed under the new address', () => {
  const r = rig({ slider: 60 });
  r.traffic = [jet];
  r.poll();
  r.core.begin('mic', RATE);
  const voice = quiet();
  r.listen(70, voice); // the jet passed over 15 s ago, and its pass is not finished
  r.pg.setSite(B);
  assert.equal(r.poll(), true, 'the panel sees that this is another set');
  r.listen(60, voice); // the same sound goes on: the microphone has not moved
  assert.deepEqual(r.list(B, 'outdoors'), [], 'nothing heard at A is stored under B');
  assert.deepEqual(r.list(A, 'outdoors'), [], 'and the cut-short pass is not filed at all');
  assert.equal(r.core.last, null);
  assert.ok(r.core.ear.status().ready, 'the microphone is still being listened to, with a new engine');

  // The same for a new environment at the same address.
  const e = rig({ slider: 60 });
  e.traffic = [jet];
  e.poll();
  e.core.begin('mic', RATE);
  e.listen(70, voice);
  e.pg.setEnv('indoors');
  assert.equal(e.poll(), true);
  e.listen(60, voice);
  assert.deepEqual(e.stored.sets ?? {}, {});
  // A newly seen aircraft comes with the last 30 s of its path, and no more: nothing drawn is from before the change.
  assert.equal(e.core.forecast.planes.get('jet001').pts.some((p) => p.at < START + 38_000), false, 'the forecast shown starts again too');
});

// Finding 2.
test('nothing is matched or learned while flight data is stale', () => {
  // Case: a stale snapshot, and aircraft passing all the same. Nothing may be stored,
  // and the page's warning level may not move.
  const r = rig({ slider: 65 });
  r.traffic = five;
  r.poll(30);
  r.core.begin('mic', RATE);
  r.listen(270, loud(), 30);
  assert.deepEqual(r.stored.sets ?? {}, {});
  assert.deepEqual(r.sent, []);
  assert.equal(r.pg.slider, 65);
  assert.ok(r.core.stale());
  assert.equal(r.core.ear.status().heard.some((h) => h.hex || h.candidates.length), false, 'the engine has no aircraft to name');
  assert.equal(r.core.last, null);

  // Flight data that stops in the middle of a pass and comes back before its end: the pass straddles
  // the gap, and is not filed either.
  const gap = rig({ slider: 60 });
  gap.traffic = [jet];
  gap.poll();
  gap.core.begin('mic', RATE);
  const voice = quiet();
  gap.listen(45, voice);
  gap.listen(30, voice, 30);
  gap.listen(60, voice);
  assert.deepEqual(gap.stored.sets ?? {}, {});
  assert.ok(!gap.core.stale());

  // Case: the data comes back two seconds after the aircraft's peak. The sound
  // of the gap must not be matched against the forecast that arrives after it.
  const late = rig({ slider: 60 });
  late.traffic = [flying({ hex: 'jet058', over: 58 })];
  late.poll();
  late.core.begin('mic', RATE);
  const sound = quiet();
  late.listen(35, sound);
  late.listen(25, sound, 30);
  late.listen(90, sound);
  assert.deepEqual(late.stored.sets ?? {}, {});
  assert.deepEqual(late.sent, []);

  // And the next aircraft after the data is back is heard and filed as usual.
  gap.traffic = [flying({ hex: 'jet002', over: 190 })];
  gap.listen(110, voice);
  assert.deepEqual(gap.list(A, 'outdoors').map((o) => o.hex), ['jet002']);
});

test('the engine keeps listening, and its background, while flight data is stale', () => {
  // The overnight session: data that went stale and fresh 43 times in 43 min. Each time the engine was
  // replaced it spent 20 s learning the background, and once learned a takeoff as the background.
  // Here the data goes stale 35 s in, while the jet is coming, and is back after it has passed.
  const r = rig({ slider: 60 });
  r.traffic = [jet];
  r.poll();
  r.core.begin('mic', RATE);
  const voice = quiet();
  r.listen(35, voice);
  const ear = r.core.ear;
  const before = ear.status().background;
  assert.ok(ear.status().ready);
  r.listen(10, voice, 30);
  assert.ok(r.core.stale());
  assert.equal(r.core.ear, ear, 'the same engine');
  assert.deepEqual(ear.status().expected, [], 'it expects nobody on old data');
  r.listen(30, voice, 30);
  const loudest = Math.max(...r.core.heard.filter((h) => h.at > START + 45_000).map((h) => h.rise));
  assert.ok(loudest >= 10, `the jet was heard over the background it already knew: +${loudest} dB`);
  r.listen(40, voice);
  assert.equal(r.core.ear, ear);
  assert.ok(ear.status().ready, 'no 20 s of learning again');
  assert.ok(Math.abs(ear.status().background - before) <= 2, `the background stayed ${before} dB, not the jet: ${ear.status().background}`);
  assert.deepEqual(r.stored.sets ?? {}, {}, 'and the pass across the gap is not learned');

  // The next aircraft is expected, heard and filed as usual.
  r.traffic = [flying({ hex: 'jet002', over: 150 })];
  r.listen(30, voice);
  assert.ok(ear.status().expected.some((e) => e.hex === 'jet002'));
  r.listen(60, voice);
  assert.deepEqual(r.list(A, 'outdoors').map((o) => o.hex), ['jet002']);
});

// Finding 3.
test('each address and environment gets its own learned level, or none', () => {
  const r = rig({ stored: saved([[A, 'outdoors', 48], [C, 'outdoors', 42], [A, 'indoors', 31]]) });
  r.poll();
  assert.deepEqual([r.pg.tuned.floor, r.pg.slider], [48, 48], 'at page load the page is told what was learned at A');
  assert.equal(r.sent.length, 1);
  r.poll();
  r.poll();
  assert.equal(r.sent.length, 1, 'and is not told again while it has it');

  r.pg.setSite({ ...A, lat: 40.0003 }); // 33 m from A is another set to app.js, so it is one here
  r.poll();
  assert.deepEqual([r.pg.tuned.floor, r.pg.slider], [null, 45], "a set next door does not get A's 48");
  r.pg.setSite(A);
  r.poll();
  assert.deepEqual([r.pg.tuned.floor, r.pg.slider], [48, 48]);

  r.pg.setSite(B); // nothing was ever learned at B
  r.poll();
  assert.deepEqual([r.pg.tuned.floor, r.pg.slider], [null, 45], "B does not keep warning at A's 48");

  r.pg.setSite(C);
  r.poll();
  assert.deepEqual([r.pg.tuned.floor, r.pg.slider], [42, 42], 'C gets its own');

  r.pg.setEnv('indoors'); // nothing learned at C indoors
  r.poll();
  assert.deepEqual([r.pg.tuned.floor, r.pg.slider], [null, 35]);
  r.pg.setSite(A);
  r.poll();
  assert.deepEqual([r.pg.tuned.floor, r.pg.slider], [31, 31]);
  r.reload();
  assert.deepEqual([r.pg.tuned.floor, r.pg.slider], [31, 31], 'and it is told again after a reload');

  // Forgetting what was learned puts the slider back where the user had it.
  r.core.forget();
  r.poll();
  assert.deepEqual([r.pg.tuned.floor, r.pg.slider], [null, 35]);
  assert.deepEqual(r.list(A, 'indoors'), []);
  assert.equal(r.list(A, 'outdoors').length, 4, 'only this set and environment is forgotten');
});

// A demo that has learned a floor: the five loud jets, heard as demo sound. Returns what it learned.
function demoLearns(r) {
  r.traffic = five;
  r.poll();
  const [told, kept] = [r.sent.length, JSON.stringify(r.stored)];
  r.core.begin('demo', RATE);
  r.listen(230, loud());
  assert.ok(r.pg.demo && Math.abs(r.pg.tuned.floor - 57) <= 2, `the demo has tuned the page to ${r.pg.tuned.floor}`);
  assert.ok(r.sent.length > told && r.sent.slice(told).every((d) => d.demo === true), 'everything a demo sends is marked as a demo');
  assert.equal(JSON.stringify(r.stored), kept, 'and nothing it hears is stored');
  return r.pg.tuned.floor;
}

// Finding 5.
test('stopping a demo puts back the warning level, whatever the user did to the slider meanwhile', () => {
  // Case: the user's own level, a demo that learns another, and the slider moved during it.
  const r = rig({ slider: 65 });
  const floor = demoLearns(r);
  assert.equal(r.pg.slider, Math.round(floor));
  r.pg.move(r.pg.slider + 5);
  r.poll();
  r.core.stop();
  r.poll();
  assert.deepEqual([r.pg.slider, r.pg.tuned.floor, r.pg.offset, r.pg.demo], [65, null, 0, false]);
  assert.deepEqual(r.sent.at(-1), { floor: null, trim: {} }, 'the last word is an ordinary one');

  // A demo that learned nothing still begins with a marked word and ends with an ordinary one, so
  // the page knows it is in a demo from the first second: a slider moved before the demo has learned
  // anything goes back too.
  const idle = rig({ slider: 45 });
  idle.poll();
  idle.core.begin('demo', RATE);
  idle.poll();
  assert.ok(idle.pg.demo);
  idle.pg.move(55);
  idle.poll();
  idle.core.stop();
  idle.poll();
  assert.deepEqual(idle.sent, [{ floor: null, trim: {}, demo: true }, { floor: null, trim: {} }]);
  assert.deepEqual([idle.pg.slider, idle.pg.demo], [45, false]);

  // The second case: a real learned floor with the user's own 3 dB on top of it, then a demo, then a reload.
  const own = rig({ stored: saved([[A, 'outdoors', 60]]), slider: 65 });
  own.poll();
  own.pg.move(63);
  own.poll();
  assert.deepEqual([own.pg.tuned.floor, own.pg.slider, own.pg.offset], [60, 63, 3]);
  own.traffic = five;
  own.core.begin('demo', RATE);
  own.poll();
  assert.deepEqual([own.pg.tuned.floor, own.pg.slider, own.pg.demo], [null, 65, true], "a demo starts from the user's own level, not from what the microphone learned");
  own.listen(230, loud());
  assert.ok(own.pg.demo && Math.abs(own.pg.tuned.floor - 57) <= 2, `the demo has tuned the page to ${own.pg.tuned.floor}`);
  own.reload(); // in the middle of the demo
  assert.deepEqual([own.pg.tuned.floor, own.pg.slider, own.pg.offset, own.pg.demo], [60, 63, 3, false], "the real floor and the user's own setting are both back");
  assert.equal(own.list(A, 'outdoors').length, 4, 'and the real passes are untouched');

  // Or stopped in the ordinary way, after moving the slider during the demo as well.
  const stop = rig({ stored: saved([[A, 'outdoors', 60]]), slider: 65 });
  stop.poll();
  stop.pg.move(63);
  demoLearns(stop);
  stop.pg.move(50);
  stop.core.stop();
  stop.poll();
  assert.deepEqual([stop.pg.tuned.floor, stop.pg.slider, stop.pg.offset, stop.pg.demo], [60, 63, 3, false]);
});

test("a demo's slider does not change the level two passes lowered", () => {
  const r = rig({ stored: saved([[A, 'outdoors', 42, 2], [A, 'indoors', 34, 2]]), slider: 65 });
  r.poll();
  r.pg.move(45);
  r.poll();
  assert.deepEqual([r.pg.tuned.floor, r.pg.slider, r.pg.offset], [42, 45, 3]);
  r.core.begin('demo', RATE);
  r.poll();
  r.pg.move(20);
  r.poll();
  r.core.stop();
  r.poll();
  assert.deepEqual([r.pg.tuned.floor, r.pg.slider, r.pg.offset, r.pg.demo], [42, 45, 3, false]);

  // Reloaded in the middle of a demo instead.
  r.core.begin('demo', RATE);
  r.poll();
  r.pg.move(20);
  r.poll();
  r.reload();
  assert.deepEqual([r.pg.tuned.floor, r.pg.slider, r.pg.offset, r.pg.demo], [42, 45, 3, false]);

  // A demo stopped by a change of environment leaves the new one its own level: indoors 35, which
  // the two indoor passes at 34 do not lower.
  r.core.begin('demo', RATE);
  r.poll();
  r.pg.move(20);
  r.poll();
  r.pg.setEnv('indoors');
  if (r.poll()) r.core.stop();
  r.poll();
  assert.deepEqual([r.pg.tuned.floor, r.pg.slider, r.pg.demo], [null, 35, false]);
});

// Finding 4.
test('nothing of a demo survives a change of environment and a reload', () => {
  const r = rig({ slider: 65 });
  demoLearns(r);
  r.pg.setEnv('indoors');
  if (r.poll()) r.core.stop(); // as listen.js does: a demo belongs to the set it was started on
  r.poll();
  assert.deepEqual([r.pg.slider, r.pg.tuned.floor, r.pg.demo], [35, null, false]);
  r.reload();
  assert.deepEqual([r.pg.slider, r.pg.tuned.floor, r.pg.demo], [35, null, false], 'indoors keeps its own level after a reload');
  assert.deepEqual(r.stored, {}, 'and there is nothing saved that a demo left behind');
  r.pg.setEnv('outdoors');
  r.poll();
  assert.equal(r.pg.tuned.floor, null);
});

// Finding 9.
test('damaged saved settings do not stop the panel', () => {
  for (const stored of ['{"sets":null}', `{"sets":{"${siteKey(A, 'outdoors')}":{"at":1,"list":{}}}}`, 'not json', '{"on":true,"sets":{"x":7}}']) {
    const r = rig({ stored });
    assert.doesNotThrow(() => r.poll(), stored);
    assert.deepEqual(r.sent, []);
    assert.equal(r.core.learned().floor, null);
  }
});

test('a feed running late is measured from the curve of an aircraft and sent to the page, and dropped when listening stops', () => {
  const r = rig({ slider: 45 });
  const prop = flying({ hex: 'a1b2c3', category: 'A1', track: 0, kt: 140, ft: 1000, over: 65 });
  r.traffic = [prop];
  r.feed = (rows, s) => [prop(s - 6)]; // the feed shows where it was 6 s before
  r.poll();
  r.core.begin('mic', RATE);
  r.listen(110, createSynth({ sampleRate: RATE, background: 40 }));
  const last = r.timings.at(-1);
  assert.ok(Math.abs(last.offsets.a1b2c3 + 6) <= 1.5, `heard ${last.offsets.a1b2c3} s from its track`);
  assert.equal(last.lag, null, 'one aircraft is not enough to say how late the feed runs for the rest');
  assert.ok(r.timings.length <= 25, `sent ${r.timings.length} times in 110 s: only when it changes`);
  assert.deepEqual(r.sent, [], 'and the warning level is left alone');
  r.core.stop();
  assert.deepEqual(r.timings.at(-1), { offsets: {}, lag: null });
});

test('no timing is learned from a curve heard while the data was old or the track an estimate', () => {
  // The propeller aircraft of the test above, with its feed 6 s late.
  const prop = flying({ hex: 'a1b2c3', category: 'A1', track: 0, kt: 140, ft: 1000, over: 65 });
  const offsets = (r) => r.timings.flatMap((t) => Object.values(t.offsets));
  // The flight data is old from 35 s to 60 s. The tones heard after it comes back are traced back
  // into the gap until 90 s, and say nothing until then; the ones heard wholly after it are measured.
  const gap = rig({ slider: 45 });
  gap.traffic = [prop];
  gap.feed = (rows, s) => [prop(s - 6)];
  gap.poll();
  gap.core.begin('mic', RATE);
  const voice = createSynth({ sampleRate: RATE, background: 40 });
  gap.listen(35, voice);
  gap.listen(25, voice, 30);
  gap.listen(25, voice);
  assert.deepEqual(offsets(gap), [], 'no offset from tones that span the gap');
  gap.listen(25, voice);
  assert.ok(offsets(gap).length && offsets(gap).every((o) => Math.abs(o + 6) <= 1.5), `then measured as usual: ${offsets(gap)}`);

  // The feed loses it at 15 s, so its track is an estimate from 35 s, and has it again at 80 s.
  const lost = rig({ slider: 45 });
  lost.traffic = [prop];
  lost.feed = (rows, s) => (s >= 15 && s < 80 ? [{ ...prop(9), seen_pos: s - 15 }] : [prop(s - 6)]);
  lost.poll();
  lost.core.begin('mic', RATE);
  lost.listen(105, createSynth({ sampleRate: RATE, background: 40 }));
  assert.deepEqual(offsets(lost), [], 'no offset from tones heard while it was an estimate');
});

test('the newest fit of each curve is kept to draw, and one with no aircraft gives way to its aircraft', () => {
  const r = rig({ slider: 45 });
  const prop = flying({ hex: 'a1b2c3', category: 'A1', track: 0, kt: 140, ft: 1000, over: 65 });
  r.traffic = [prop];
  r.poll();
  r.core.begin('mic', RATE);
  r.listen(110, createSynth({ sampleRate: RATE, background: 40 }));
  const mine = r.core.fitted.filter((f) => f.hex === 'a1b2c3');
  assert.equal(mine.length, 1, 'one fit for its aircraft, the newest');
  assert.ok(!r.core.fitted.some((f) => !f.hex && f.from <= mine[0].to && mine[0].from <= f.to), 'and none with no aircraft over it');
  r.core.stop();
  assert.deepEqual(r.core.fitted, []);
});
