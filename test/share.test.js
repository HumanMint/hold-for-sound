import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createShare, coarse, BANDS, LO, STEP, BEFORE_MS, AFTER_MS, AFTER_MARK_MS } from '../public/share-core.js';
import { createCore } from '../public/listen-core.js';
import { createSynth } from '../public/synth.js';
import { BINS, FREQS } from '../public/hear.js';
import { follow } from '../public/lost.js';
import { createLog, read, spectrogram, ID, MAX_POST } from '../log.js';

// What a page that has sharing switched on records and sends (share-core.js), with the real listening
// panel (listen-core.js, hearing synth.js) and the real server log (log.js) on either side of it.

const RATE = 16000;
const START = 1_800_000_000_000;
const SET = { name: '5555 Melrose Ave, a place nobody is to learn', lat: 40, lon: -100, elevM: 12, runways: [{ airport: 'KXYZ', ends: [{ id: '09', lat: 40.2, lon: -100.3 }, { id: '27', lat: 40.2, lon: -100.2 }] }] };

// An `hfs:update` as app.js makes one, from feed rows.
function update(now, rows, { site = SET, env = 'outdoors', floor = 60, age = 0, known = new Map(), ...more } = {}) {
  const { tracks, windows } = follow(known, rows, now, site, () => ({ loss: 0, floor, runways: site.runways, trim: {} }));
  const timed = windows.map((w) => ({ ...w, start: now + w.startS * 1000, end: now + w.endS * 1000 })).sort((a, b) => a.start - b.start);
  return { at: now, dataAt: now - age * 1000, site, env, floor, trim: {}, learned: null, aircraft: rows, tracks, windows: timed, taxiing: [], ...more };
}
// A jet flying east at 3000 ft that is over the set `over` seconds after START.
const jet = (hex, over) => (now) => {
  const gone = 250 * 0.5144 * ((now - START) / 1000 - over);
  return { hex, flight: `${hex.toUpperCase()} `, t: 'B738', desc: 'BOEING 737-800', category: 'A3', lat: SET.lat, lon: SET.lon + gone / (111195 * Math.cos((SET.lat * Math.PI) / 180)), alt_baro: 3000, gs: 250, track: 90, seen_pos: 0 };
};

// A sharing page with a server that answers as `answer` says, and everything it was sent.
function rig({ answer = () => ({ ok: true }), ...options } = {}) {
  const r = { now: START, posts: [], said: [], full: 0 };
  r.share = createShare({
    clock: () => r.now,
    announce: (id) => r.said.push(id),
    changed: () => r.full++,
    post: async (text) => (r.posts.push(text), answer(text)),
    ...options,
  });
  r.events = () => r.posts.flatMap((text) => JSON.parse(text).events);
  r.kinds = () => r.events().map((e) => e.k);
  // Every column of spectrogram sent, in the order sent: when it was, the stretch it was sent as part of, and its bytes.
  r.columns = () =>
    r.events().filter((e) => e.k === 'spec').flatMap((e) => {
      const bytes = Buffer.from(e.data, 'base64');
      assert.equal(bytes.length, e.cols * e.bins);
      return Array.from({ length: e.cols }, (_, i) => ({ from: e.from, at: e.at + (i * 1000) / e.rate, bytes: bytes.subarray(i * e.bins, (i + 1) * e.bins) }));
    });
  return r;
}

// A second of listening as the panel reports it, ending `s` seconds after START: the engine's status
// and its 8 columns. Every level in a column is made from the column's own time, so that a column
// read back can be told from every other.
const level = (at, b) => -100 + (((at - START) / 125) % 90) * 0.5 + (b % 8);
const second = (s, status = {}, more = {}) => ({
  demo: false,
  rate: 48000,
  stale: false,
  observations: [],
  status: { at: START + s * 1000, ready: true, signal: true, level: -60, background: -61, rise: 1, noise: false, expected: [], heard: [], ...status },
  columns: Array.from({ length: 8 }, (_, i) => START + s * 1000 - (7 - i) * 125).map((at) => ({ at, db: Float32Array.from({ length: BINS }, (_, b) => level(at, b)) })),
  ...more,
});
// Seconds `from` to `to`, with whatever `status(s)` says the engine found in each.
function hear(r, from, to, status = () => ({}), more) {
  for (let s = from; s <= to; s++) {
    r.now = START + s * 1000;
    r.share.heard(second(s, status(s), more));
  }
}
// The stretches sent, as [from, first column, last column, columns] in seconds after START.
const stretches = (r) => Object.values(Object.groupBy(r.columns(), (c) => c.from)).map((cols) => [(cols[0].from - START) / 1000, (cols[0].at - START) / 1000, (cols.at(-1).at - START) / 1000, cols.length]);
// No column twice, each stretch unbroken, and every byte the level that column had.
function sound(r) {
  const cols = r.columns();
  assert.equal(new Set(cols.map((c) => c.at)).size, cols.length, 'no column is sent twice');
  for (const [i, c] of cols.entries()) {
    if (i && c.from === cols[i - 1].from) assert.equal(c.at - cols[i - 1].at, 125, 'a stretch has no gap in it');
    assert.equal(c.from <= c.at, true);
    for (const b of [0, 7, 150, BINS - 1]) assert.equal(LO + STEP * c.bytes[b], level(c.at, b));
  }
}

test('a second of spectrogram becomes one coarse spectrum: 38 bands, whole dB, the mean of the power', () => {
  const column = (db, more = {}) => ({ db: Float32Array.from({ length: BINS }, (_, b) => more[b] ?? db) });
  const second = (make) => Array.from({ length: 8 }, (_, i) => make(i));
  assert.equal(BANDS, 38);
  assert.equal(BINS, BANDS * 8);

  assert.deepEqual(coarse(second(() => column(-60.4))), new Array(38).fill(-60));
  // Seven quiet columns and one that is 10 dB up: (7 + 10) / 8 of the power, 3.3 dB more.
  assert.deepEqual(coarse(second((i) => column(i === 3 ? -50 : -60))), new Array(38).fill(-57));
  // A tone in one of the engine's bins stands out of its band, and of no other: an eighth of its power.
  const tone = coarse(second(() => column(-80, { 43: -20 })));
  assert.equal(tone.length, 38);
  assert.equal(tone[5], -29);
  assert.deepEqual(tone.filter((_, band) => band !== 5), new Array(37).fill(-80));
  // The second is one row whatever was in it: a word spoken in a quarter of it is spread over all of it.
  const word = coarse(second((i) => column(i < 2 ? -30 : -70)));
  assert.deepEqual(word, new Array(38).fill(-36));
  // Digital silence is a number too, so it survives being written as JSON.
  assert.deepEqual(JSON.parse(JSON.stringify(coarse(second(() => column(-200))))), new Array(38).fill(-200));
  assert.ok(coarse([column(-61.2)]).every(Number.isInteger));
});

test('a location awaiting its first feed logs an unknown age, not time since the epoch', async () => {
  const r = rig();
  r.share.start();
  r.share.update(update(r.now, [], { dataAt: 0 }));
  await r.share.flush();
  assert.equal(r.events().find(e => e.k === 'poll').age, null);
  r.now += 5000;
  r.share.update(update(r.now, [], { age: 1.5 }));
  await r.share.flush();
  assert.equal(r.events().filter(e => e.k === 'poll').at(-1).age, 1.5);
});

test('nothing is recorded or sent before the switch is on, and switching off stops everything at once', async () => {
  const r = rig();
  const { share } = r;
  const ac = jet('aaa111', 30);
  share.update(update(r.now, [ac(r.now)]));
  share.status({ state: 'clear' });
  share.tune({ floor: 55, trim: {} });
  share.mark(true);
  await share.flush();
  assert.equal(share.on, false);
  assert.deepEqual([r.posts, r.said], [[], []]);

  share.start();
  assert.equal(share.on, true);
  assert.match(r.said[0], ID);
  await share.flush();
  // Known to the server at once, so that the feed is kept from the next poll on: with the set it is
  // at and what the banner was showing, which are the last the page said of each while it was off.
  assert.deepEqual(r.events().map((e) => [e.k, e.state]), [['site', undefined], ['status', 'clear']]);
  r.now += 5000;
  share.update(update(r.now, [ac(r.now)]));
  share.mark(true);
  share.status({ state: 'soon' });
  await share.flush();
  assert.deepEqual(r.kinds(), ['site', 'status', 'poll', 'mark', 'status']);
  const sent = r.posts.length;

  // Off with records still waiting: they are not sent, and nothing after them is.
  share.update(update(r.now + 5000, [ac(r.now + 5000)]));
  share.mark(false);
  share.stop();
  assert.equal(share.on, false);
  assert.equal(r.said.at(-1), null);
  await share.flush();
  share.update(update(r.now + 10_000, [ac(r.now + 10_000)]));
  share.status({ state: 'hold' });
  share.tune({ floor: 50, trim: {} });
  share.heard({ demo: false, rate: RATE, status: { at: r.now, ready: true, signal: true, level: -40, background: -50, rise: 10, noise: true, expected: [], heard: [] }, columns: [], observations: [] });
  share.mark(true);
  await share.flush();
  assert.equal(r.posts.length, sent);

  // On again is another session, with nothing of the last one in it.
  share.start();
  await share.flush();
  assert.notEqual(r.said.at(-1), r.said[0]);
  assert.deepEqual(JSON.parse(r.posts.at(-1)).events.map((e) => [e.k, e.state]), [['site', undefined], ['status', 'hold']]);
  assert.equal(JSON.parse(r.posts.at(-1)).n, 0);
});

test('a batch on its way when the switch goes off is the last thing sent', async () => {
  let arrive;
  const r = rig({ answer: () => new Promise((done) => (arrive = done)) });
  r.share.update(update(r.now, []));
  r.share.start();
  r.share.mark(true);
  const flushing = r.share.flush();
  r.share.stop();
  arrive({ ok: true });
  await flushing;
  await r.share.flush();
  assert.equal(r.posts.length, 1);
  assert.deepEqual(r.said.map((id) => typeof id), ['string', 'object']);
});

test('a batch is what the server stores: the set by its coordinates, each poll with what the page decided', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hfs-share-'));
  const log = createLog(dir, { clock: () => START });
  const r = rig({ answer: (text) => log.request('POST', text) });
  const { share } = r;
  const known = new Map();
  const ac = jet('aaa111', 60);
  share.update(update(r.now, [ac(r.now)], { known }));
  share.start();
  for (let i = 0; i < 12; i++) {
    r.now += 5000;
    const d = update(r.now, i < 6 ? [ac(r.now)] : [], { known, age: 1.5 }); // the feed loses it on its way in
    share.update(d);
    if (i === 3) share.mark(true);
    if (i === 8) share.mark(false);
  }
  share.tune({ floor: 57, trim: { A3: -2 } });
  await share.flush();

  const post = JSON.parse(r.posts[0]);
  assert.deepEqual(Object.keys(post), ['id', 'n', 'sent', 'events']);
  assert.deepEqual([post.id, post.n, post.sent], [r.said[0], 0, START]);
  assert.ok(r.posts.every((text) => text.length < MAX_POST / 2));

  const [file] = readdirSync(dir);
  assert.equal(file, `${new Date(START).toISOString().slice(0, 10)}-${post.id}.log.jsonl.gz`);
  const stored = read(join(dir, file));
  assert.deepEqual(stored.filter((e) => e.k !== 'session' && e.k !== 'post'), r.events());
  assert.deepEqual(stored.slice(0, 3).map((e) => e.k), ['session', 'post', 'site']);

  // Where: coordinates, elevation and the airports' names. Never what was typed or the place's name.
  assert.deepEqual(stored[2], { k: 'site', at: START, lat: 40, lon: -100, elevM: 12, airports: ['KXYZ'], env: 'outdoors' });
  assert.ok(!r.posts.join('').includes('Melrose') && !r.posts.join('').includes('nobody'));

  const polls = stored.filter((e) => e.k === 'poll');
  assert.equal(polls.length, 12);
  const first = polls[0];
  assert.deepEqual([first.at, first.age, first.n, first.floor, first.learned], [START + 5000, 1.5, 1, 60, null]);
  const [w] = first.windows;
  assert.deepEqual(Object.keys(w), ['hex', 'flight', 't', 'cat', 'start', 'end', 'peak', 'dist', 'alt', 'seen']);
  assert.deepEqual([w.hex, w.flight, w.t, w.cat, w.seen], ['aaa111', 'AAA111', 'B738', 'A3', 0]);
  assert.ok(w.start > first.at && w.end > w.start && w.peak > 60 && w.dist > 900 && w.alt > 2900);
  // Once the feed has lost it the window is marked as the estimate it is, and then as "cannot tell".
  const lost = polls.find((p) => p.windows.some((x) => x.lost));
  assert.ok(lost && lost.windows[0].seen > 20 && polls.indexOf(lost) >= 9);
  assert.ok(polls.every((p) => p.windows.every((x) => !('path' in x))));
  assert.deepEqual(stored.filter((e) => e.k === 'mark').map((e) => [e.at - START, e.heard]), [[20_000, true], [45_000, false]]);
  assert.deepEqual(stored.at(-1), { k: 'tune', at: r.now, floor: 57, trim: { A3: -2 } });
});

// The listening panel hearing a jet over a 50 dB background for `seconds`, with the page warning at 60:
// it is heard by its swell and filed as a pass about 85 s in. Everything the panel reports goes to `share`.
function listen(r, kind, seconds) {
  const reports = [];
  const core = createCore({ load: () => null, save() {}, send: (name, detail) => r.share.tune(detail), clock: () => r.now, report: (d) => (reports.push(d), r.share.heard(d)) });
  const voice = createSynth({ sampleRate: RATE, background: 50 });
  const ac = jet('aaa111', 55);
  const known = new Map();
  const poll = () => {
    const d = update(r.now, [ac(r.now)], { known });
    core.update(d);
    r.share.update(d);
    return d;
  };
  poll();
  core.begin(kind, RATE);
  for (const end = r.now + seconds * 1000; r.now < end; ) {
    const d = poll();
    const pcm = voice.render(d.tracks, r.now, r.now, 5);
    for (let i = 0; i < 5; i++) core.hear(pcm.subarray(i * RATE, (i + 1) * RATE), (r.now += 1000));
  }
  return reports;
}

test('the microphone is reported once a second, as levels and a coarse spectrum, with every pass', async () => {
  const r = rig();
  r.share.start();
  const reports = listen(r, 'mic', 100);
  await r.share.flush();

  // The hook: one report for each second of audio, with that second's 8 columns and nothing of the next.
  assert.ok(reports.length >= 98 && reports.length <= 100);
  assert.ok(reports.every((d, i) => !i || d.status.at - reports[i - 1].status.at === 1000));
  assert.ok(reports.every((d) => d.columns.length === 8 && d.demo === false && d.rate === RATE));
  assert.equal(reports.flatMap((d) => d.observations).length, 1);

  const events = r.events();
  const mic = events.filter((e) => e.k === 'mic');
  assert.equal(mic.length, reports.length, 'one record a second');
  assert.deepEqual(events.filter((e) => e.k === 'listen'), [{ k: 'listen', at: Math.round(reports[0].status.at), rate: RATE }]);
  for (const m of mic) {
    assert.equal(m.bands.length, 38);
    assert.ok(m.bands.every((v) => Number.isInteger(v) && v < 0 && v > -200));
    assert.ok(!('columns' in m) && !('pcm' in m));
  }
  // The engine's own numbers, as it gives them.
  const loud = mic.find((m) => m.noise);
  const s = reports.find((d) => Math.round(d.status.at) === loud.at).status;
  assert.deepEqual([loud.ready, loud.signal, loud.level, loud.background, loud.rise], [true, true, s.level, s.background, s.rise]);
  assert.deepEqual(loud.expected, s.expected);
  assert.ok(mic.some((m) => m.heard?.[0].hex === 'aaa111' && m.heard[0].how === 'envelope'), 'and what it named');
  assert.ok(mic.at(-1).rise < 3 && !('heard' in mic.at(-1)), 'quiet again once it has passed');
  // Every pass the engine files, whole.
  const [pass] = events.filter((e) => e.k === 'pass');
  assert.deepEqual(pass, { k: 'pass', ...reports.flatMap((d) => d.observations)[0] });
  assert.deepEqual([pass.hex, pass.how, pass.heard], ['aaa111', 'envelope', true]);
  // All of that is small: an hour of polls and listening like this is about a megabyte before it is compressed.
  const size = events.filter((e) => e.k !== 'spec').reduce((sum, e) => sum + JSON.stringify(e).length, 0);
  assert.ok(size * 36 < 1_500_000, `${size} characters for 100 s`);

  // The spectrogram itself is kept around the pass: from 30 s before the engine first expected the
  // jet until 30 s after it last did, as the engine's own columns, 8 a second.
  const expecting = mic.filter((m) => m.expected).map((m) => m.at);
  const cols = r.columns();
  assert.ok(cols.length > 400 && new Set(cols.map((c) => c.from)).size === 1, 'one stretch');
  assert.ok(cols.every((c, i) => !i || c.at - cols[i - 1].at === 125));
  assert.ok(Math.abs(cols[0].at - Math.max(reports[0].columns[0].at, expecting[0] - BEFORE_MS)) <= 1000);
  assert.ok(Math.abs(cols.at(-1).at - Math.min(reports.at(-1).status.at, expecting.at(-1) + AFTER_MS)) <= 1000);
  // Each is the engine's column of that moment, to the half dB: all 304 bins, as it measured them.
  const made = new Map(reports.flatMap((d) => d.columns).map((col) => [Math.round(col.at), col.db]));
  for (const c of [cols[0], cols[200], cols.at(-1)]) {
    const db = made.get(c.at);
    assert.equal(c.bytes.length, FREQS.length);
    assert.ok(c.bytes.every((byte, b) => Math.abs(LO + STEP * byte - Math.max(db[b], LO)) <= STEP / 2 + 1e-4));
  }
});

test('nothing the demo sound produces is recorded as microphone data', async () => {
  const r = rig();
  r.share.start();
  const reports = listen(r, 'demo', 100);
  await r.share.flush();
  assert.ok(reports.length >= 98 && reports.every((d) => d.demo === true));
  assert.equal(reports.flatMap((d) => d.observations).length, 1, 'the demo did hear a pass');
  assert.ok(reports.some((d) => d.status.noise && d.status.expected.length), 'and all that would start a capture');
  // A mark is real whatever is being listened to, but there is no sound of the demo's to go with it.
  r.share.mark(true);
  await r.share.flush();
  const kinds = new Set(r.kinds());
  assert.deepEqual([...kinds].sort(), ['mark', 'poll', 'site', 'tune']);
  // The polls made while a demo has the page tuned say so, and so does what it told the page.
  const events = r.events();
  assert.ok(events.filter((e) => e.k === 'tune').every((e) => e.demo === true));
  assert.ok(events.filter((e) => e.k === 'poll').slice(1).every((e) => e.demo === true));
  // The page's own tuning back in effect: an ordinary `hfs:tune` ends it.
  r.share.tune({ floor: null, trim: {} });
  r.share.update(update(r.now, []));
  await r.share.flush();
  assert.ok(!('demo' in r.events().at(-1)));
});

test('with the network down a bounded amount waits, the marks among it, and nothing is said', async () => {
  let up = false;
  const dir = mkdtempSync(join(tmpdir(), 'hfs-share-'));
  const log = createLog(dir, { clock: () => START });
  const r = rig({ max: 5000, room: 2000, answer: (text) => (up ? log.request('POST', text) : Promise.reject(new Error('offline'))) });
  const { share } = r;
  share.update(update(r.now, []));
  share.start();
  await share.flush();
  for (let i = 0; i < 400; i++) {
    r.now += 5000;
    share.update(update(r.now, []));
    if (i % 100 === 0) share.mark(i % 200 === 0);
    if (i % 4 === 3) await share.flush();
  }
  // Every try was the same batch again, unchanged, so the server can tell a repeat from a new one.
  assert.ok(r.posts.length > 50 && new Set(r.posts).size === 1);
  assert.equal(JSON.parse(r.posts[0]).n, 0);

  up = true;
  r.posts.length = 0;
  await share.flush();
  const events = r.events();
  assert.ok(r.posts.every((text) => text.length <= 2100), 'in batches no longer than there is room for');
  assert.deepEqual(r.posts.map((text) => JSON.parse(text).n), r.posts.map((_, n) => n));
  assert.ok(r.posts.join('').length < 5000 + 2000 + 20 * 100, `${r.posts.join('').length} characters kept`);
  assert.ok(events.filter((e) => e.k === 'poll').length > 30);
  assert.equal(events[0].k, 'site', 'the set is kept');
  assert.deepEqual(events.filter((e) => e.k === 'mark').map((e) => e.heard), [true, false, true, false], 'and every mark');
  assert.equal(events.at(-1).at, r.now, 'the newest polls are the ones kept');
  // Stored once each, in order.
  const [file] = readdirSync(dir);
  assert.deepEqual(read(join(dir, file)).filter((e) => e.k !== 'session' && e.k !== 'post'), events);
  const sent = r.posts.length;
  await share.flush();
  assert.equal(r.posts.length, sent, 'and nothing is sent when nothing is waiting');
});

test('a server that has no more room stops the sharing quietly', async () => {
  const r = rig({ answer: () => ({ full: true }) });
  r.share.update(update(r.now, []));
  r.share.start();
  await r.share.flush();
  assert.equal(r.share.on, false);
  assert.deepEqual([r.said.length, r.said.at(-1), r.full], [2, null, 1]);
  const sent = r.posts.length;
  r.share.mark(true);
  r.share.update(update(r.now + 5000, []));
  await r.share.flush();
  assert.equal(r.posts.length, sent);
});

test('the spectrogram is kept from 30 s before something is first expected or heard until 30 s after the last of it', async () => {
  const r = rig();
  r.share.start();
  // Four minutes with nothing predicted and nothing heard: remembered for 30 s, and none of it sent.
  hear(r, 1, 240);
  await r.share.flush();
  assert.deepEqual(r.kinds().filter((k) => k !== 'mic'), ['listen']);

  // Then the engine hears noise from 4:01 to 4:20, and nothing more for three minutes.
  hear(r, 241, 260, () => ({ noise: true, rise: 9 }));
  hear(r, 261, 440);
  await r.share.flush();
  sound(r);
  const [from, first, last, columns] = stretches(r)[0];
  assert.equal(stretches(r).length, 1);
  assert.deepEqual([first, last], [241 - BEFORE_MS / 1000, 260 + AFTER_MS / 1000]);
  assert.deepEqual([from, columns], [first, (last - first) * 8 + 1]);
  // 10 s at a time at most, each in a post of its own, and no post near the most one may be.
  const specs = r.posts.filter((text) => text.includes('"k":"spec"'));
  assert.ok(specs.length >= 7 && specs.every((text) => JSON.parse(text).events.length === 1));
  assert.ok(r.events().every((e) => e.k !== 'spec' || e.cols <= 80) && r.posts.every((text) => text.length < MAX_POST * 0.6));
  // Whenever it sends, everything else goes first: the one batch a closing page gets out is not the spectrogram.
  hear(r, 441, 460, () => ({ noise: true }));
  r.share.mark(true);
  const before = r.posts.length;
  await r.share.flush();
  const kinds = r.posts.slice(before).map((text) => JSON.parse(text).events.map((e) => e.k));
  assert.deepEqual([kinds[0].filter((k) => k === 'mic').length, kinds[0].at(-1), kinds[0].includes('spec')], [20, 'mark', false]);
  assert.ok(kinds.length >= 4 && kinds.slice(1).every((batch) => batch.length === 1 && batch[0] === 'spec'));
  // Each says how to read itself: the engine's 304 bins, 48 to the octave from 50 Hz, 8 columns a second.
  const { data, ...head } = JSON.parse(specs[0]).events[0];
  assert.deepEqual(head, { k: 'spec', from: START + 211_000, at: START + 211_000, rate: 8, cols: 80, bins: 304, fmin: 50, octave: 48, lo: -127.5, step: 0.5 });
  assert.ok(Array.from(FREQS).every((hz, b) => Math.abs(hz - head.fmin * 2 ** (b / head.octave)) < hz * 1e-6));

  // Each of the four things that start one does so alone: the engine expecting an aircraft, naming
  // one, hearing noise, and the page predicting one audible (an estimate and a "cannot tell" too).
  const starts = [
    (s) => ({ expected: s === 100 ? [{ hex: 'aaa111', level: 48, swing: null }] : [] }),
    (s) => ({ heard: s === 100 ? [{ hex: 'aaa111', how: 'doppler', confidence: 0.6, candidates: [], tones: [80], fundamental: 80 }] : [] }),
    (s) => ({ noise: s === 100 }),
  ];
  const windows = [{}, { lost: true }, { unsure: true, path: [] }].map((more) => ({ windows: [{ hex: 'aaa111', category: 'A3', start: START + 99_500, end: START + 100_500, peakDb: 70, seenAt: START, ...more }] }));
  for (const [status, page] of [...starts.map((status) => [status, {}]), ...windows.map((page) => [() => ({}), page])]) {
    const one = rig();
    one.share.update({ ...update(START, []), ...page });
    one.share.start();
    hear(one, 1, 200, status);
    await one.share.flush();
    sound(one);
    assert.deepEqual(stretches(one), [[70, 70, 130, 481]]);
  }
});

test('stretches that touch or overlap are one, with no column sent twice, and a later one is its own', async () => {
  const r = rig();
  r.share.start();
  const noise = (...at) => (s) => ({ noise: at.some(([from, to]) => s >= from && s <= to) });
  // Noise at 1:40, again 50 s after it stopped (the 30 s after one and before the next overlap), then
  // exactly a minute after that (they touch), then five minutes later.
  hear(r, 1, 800, noise([100, 110], [160, 165], [225, 230], [530, 540]));
  await r.share.flush();
  sound(r);
  assert.deepEqual(stretches(r), [
    [70, 70, 260, 190 * 8 + 1],
    [500, 500, 570, 70 * 8 + 1],
  ]);

  // A stretch still open when the next begins is carried on, and one that the microphone drops out
  // of is two: the columns either side of the gap do not follow one another.
  const gap = rig();
  gap.share.start();
  hear(gap, 1, 60, () => ({ noise: true }));
  hear(gap, 65, 120, () => ({ noise: true }));
  await gap.share.flush();
  sound(gap);
  assert.deepEqual(stretches(gap), [
    [0.125, 0.125, 60, 60 * 8],
    [64.125, 64.125, 120, 56 * 8],
  ]);
});

test('a mark keeps the 30 s before the tap and the minute after it', async () => {
  const r = rig();
  r.share.start();
  hear(r, 1, 300);
  r.now = START + 300_400;
  r.share.mark(true);
  await r.share.flush(); // share.js sends a mark at once: what led up to it goes with it
  assert.deepEqual(stretches(r), [[270.5, 270.5, 300, 29.5 * 8 + 1]]);
  hear(r, 301, 500);
  await r.share.flush();
  sound(r);
  // Tapped at 5:00.4: from the first column after 4:30.4 to the last before 6:00.4.
  assert.equal(AFTER_MARK_MS, 60_000);
  assert.deepEqual(stretches(r), [[270.5, 270.5, 360.375, (360.375 - 270.5) * 8 + 1]]);
  assert.deepEqual(r.events().filter((e) => e.k === 'mark'), [{ k: 'mark', at: START + 300_400, heard: true }]);

  // A second tap inside that minute runs it on, and "Quiet now" keeps as much as "I hear an aircraft".
  hear(r, 501, 600);
  r.share.mark(true);
  hear(r, 601, 640);
  r.now = START + 640_000;
  r.share.mark(false);
  hear(r, 641, 900);
  await r.share.flush();
  sound(r);
  // (What is remembered is 240 columns: the one made exactly 30 s before the tap has just gone.)
  assert.deepEqual(stretches(r).at(-1), [570.125, 570.125, 700, 130 * 8]);
  assert.equal(stretches(r).length, 2);

  // With no microphone on there is no sound to keep: the mark goes alone.
  const deaf = rig();
  deaf.share.start();
  deaf.share.mark(true);
  await deaf.share.flush();
  assert.deepEqual(deaf.kinds(), ['mark']);
});

test('no spectrogram is kept or sent while sharing is off, or from the demo sound', async () => {
  const r = rig();
  // Off: the engine hears an aircraft, and nothing of it is remembered for when the switch goes on.
  hear(r, 1, 100, () => ({ noise: true, expected: [{ hex: 'aaa111', level: 50, swing: null }] }));
  r.now = START + 100_500;
  r.share.mark(true);
  r.share.start();
  r.share.mark(true);
  await r.share.flush();
  assert.deepEqual(r.kinds(), ['mark']);
  assert.ok(!r.posts.join('').includes('"spec"'));

  // On, with the demo sound: its columns are not remembered either, so a mark has nothing to send.
  hear(r, 101, 200, () => ({ noise: true, expected: [{ hex: 'aaa111', level: 50, swing: null }] }), { demo: true });
  r.now = START + 200_500;
  r.share.mark(false);
  await r.share.flush();
  assert.deepEqual(r.kinds(), ['mark', 'mark']);

  // Real listening is kept. Switched off in the middle of a stretch, what was waiting is dropped with the rest.
  hear(r, 201, 215, () => ({ noise: true }));
  await r.share.flush();
  const sent = r.columns().length;
  assert.equal(sent, 15 * 8);
  hear(r, 216, 222, () => ({ noise: true }));
  r.share.stop();
  await r.share.flush();
  hear(r, 223, 260, () => ({ noise: true }));
  r.share.mark(true);
  await r.share.flush();
  assert.equal(r.columns().length, sent);
  // On again: a new session starts with nothing remembered from the last.
  r.share.start();
  r.now = START + 261_000;
  r.share.mark(true);
  await r.share.flush();
  assert.equal(r.columns().length, sent);
});

test('a stretch is stored by the server and read back into dB by bin and time, right to a quarter of a dB', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hfs-share-'));
  const log = createLog(dir, { clock: () => START });
  const r = rig({ answer: (text) => log.request('POST', text) });
  r.share.update(update(r.now, []));
  r.share.start();
  // Levels of every kind: ordinary ones, the loudest there can be and beyond, digital silence, and far under the scale.
  const levels = new Map();
  const any = (at, b) => (b === 0 ? -200 : b === 1 ? -140.2 : b === 2 ? 0 : b === 3 ? 3.7 : -120 + ((at * 7 + b * 13) % 1171) / 10);
  for (let s = 1; s <= 25; s++) {
    const d = second(s, { noise: true });
    for (const col of d.columns) levels.set(col.at, (col.db = Float32Array.from({ length: BINS }, (_, b) => any(col.at, b))));
    r.share.heard(d);
  }
  await r.share.flush();
  for (let s = 100; s <= 104; s++) r.share.heard(second(s, { noise: true })); // a second stretch, much later
  await r.share.flush();

  const files = readdirSync(dir).sort();
  assert.deepEqual(files.map((f) => f.slice(28)), ['log.jsonl.gz', 'spec.bin.gz']);
  const [one, two] = spectrogram(join(dir, files[1]));
  assert.deepEqual([one.from, one.rate, one.at.length, one.db.length, one.at[0], one.at.at(-1)], [START + 125, 8, 200, 200, START + 125, START + 25_000]);
  assert.deepEqual([two.from, two.at.length], [START + 99_125, 40]);
  assert.deepEqual(Array.from(one.freqs), Array.from({ length: BINS }, (_, b) => 50 * 2 ** (b / 48)));
  assert.ok(Math.abs(one.freqs[BINS - 1] - FREQS[BINS - 1]) < 0.01);
  let worst = 0;
  one.at.forEach((at, i) => {
    const was = levels.get(at);
    assert.equal(one.db[i].length, BINS);
    for (let b = 4; b < BINS; b++) worst = Math.max(worst, Math.abs(one.db[i][b] - was[b]));
    // Nothing reads under the bottom of the scale or over full scale.
    assert.deepEqual(Array.from(one.db[i].subarray(0, 4)), [LO, LO, 0, 0]);
  });
  assert.ok(worst <= STEP / 2 + 1e-4 && worst > 0.2, `${worst} dB`);

  // The log itself says each chunk was there, without the bytes, and stays small enough to read.
  const lines = read(join(dir, files[0]));
  const spec = lines.filter((e) => e.k === 'spec');
  assert.deepEqual(spec.map((e) => [e.from - START, e.at - START, e.cols]), [[125, 125, 80], [125, 10_125, 80], [125, 20_125, 40], [99_125, 99_125, 40]]);
  assert.ok(spec.every((e) => !('data' in e)));
});

test('with the network down the spectrogram is the first thing let go', async () => {
  let up = false;
  const r = rig({ max: 400_000, answer: () => (up ? { ok: true } : Promise.reject(new Error('offline'))) });
  r.share.update(update(r.now, []));
  r.share.start();
  await r.share.flush();
  hear(r, 1, 600, () => ({ noise: true }));
  r.share.mark(true);
  up = true;
  await r.share.flush();
  const kinds = r.kinds();
  assert.ok(r.posts.join('').length < 400_000 + 40_000);
  assert.equal(kinds.filter((k) => k === 'mic').length, 600, 'every second of the cheap record');
  assert.ok(kinds.includes('site') && kinds.includes('mark'));
  // Ten minutes of spectrogram is 2 MB: only the newest of it is still there.
  const cols = r.columns();
  assert.ok(cols.length >= 5 * 80 && cols.length <= 8 * 80, `${cols.length} columns`);
  assert.equal(cols.at(-1).at, START + 600_000);
  assert.ok(cols.every((c, i) => !i || c.at - cols[i - 1].at === 125), 'and unbroken');
});

test('switching off cancels a batch on its way, and the next session has a line of its own', async () => {
  const signals = [];
  const r = rig({ post: (text, signal) => (r.posts.push(text), signals.push(signal), new Promise(() => {})) });
  r.share.update(update(r.now, []));
  r.share.start();
  assert.equal(signals.length, 1);
  assert.equal(signals[0]?.aborted, false);
  r.share.stop();
  assert.equal(signals[0].aborted, true, 'cancelled, so the server is not left to finish it');
  r.share.start();
  assert.equal(signals[1].aborted, false);
});

test('nothing heard before the switch went on is sent, not even the rest of that second', async () => {
  const r = rig();
  hear(r, 1, 9);
  // On 600 ms into the tenth second: of its 8 columns, each the middle of a quarter second of audio,
  // only those whose audio began after the tap may be kept.
  r.now = START + 9600;
  r.share.start();
  const since = r.now;
  hear(r, 10, 20, () => ({ noise: true }));
  r.share.mark(true);
  await r.share.flush();
  const cols = r.columns();
  assert.ok(cols.length > 0);
  assert.ok(cols.every((c) => c.at - 125 >= since), `the first column is at ${cols[0].at - since} ms`);
  assert.equal(cols[0].at, START + 9750); // its audio began at 9.625 s
  const mic = r.events().filter((e) => e.k === 'mic');
  assert.equal(mic.length, 11);
  assert.equal(mic[0].bands, undefined, 'the second the switch went on in has no spectrum');
  assert.ok(mic.slice(1).every((m) => m.bands.length === BANDS));
  // Levels are smoothed over the 6 s before, so the first seconds' levels are not sent either.
  assert.ok(mic.every((m) => (m.at - 6000 < since ? m.level === null && m.rise === null : m.level !== null)), mic.map((m) => `${m.at - since}:${m.level}`).join(' '));
  assert.ok(mic.some((m) => m.level !== null));
});

test('the line under the switch says when the spectrogram is kept', () => {
  const line = readFileSync(new URL('../public/share.js', import.meta.url), 'utf8').match(/<p id="shares">(.*?)<\/p>/)[1];
  assert.equal([BEFORE_MS, AFTER_MS, AFTER_MARK_MS].join(), '30000,30000,60000', 'what the line says');
  for (const words of ['30 s before to 30 s after each aircraft or aircraft-like noise', 'a minute after each mark', 'speech included']) assert.ok(line.includes(words), words);
});

test('the log says what the banner said, held hold and all, not a reckoning of its own', async () => {
  const r = rig();
  const ac = jet('aaa111', 60);
  r.share.update(update(r.now, [ac(r.now)]));
  // The banner keeps a hold up for 10 s after it stopped early (status.js steady), though the windows say clear.
  r.share.status({ state: 'hold', until: START + 10_000.4, checking: true, early: true, unsure: null });
  r.share.start();
  r.now += 5000;
  r.share.update(update(r.now, []));
  r.share.status({ state: 'clear', until: null, checking: false, early: false, unsure: null });
  await r.share.flush();
  const events = r.events();
  assert.deepEqual(events.filter((e) => e.k === 'status').map(({ at, ...e }) => e), [
    { k: 'status', state: 'hold', until: START + 10_000, checking: true, early: true },
    { k: 'status', state: 'clear', until: null },
  ]);
  assert.ok(!events.some((e) => e.k === 'poll' && 'state' in e), 'a poll does not work out a status of its own');
});
