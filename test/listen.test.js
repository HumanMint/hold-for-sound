import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { predict } from '../public/predict.js';
import { BINS, FMIN, FMAX } from '../public/hear.js';
import { tune } from '../public/tune.js';
import { morph } from '../public/map-geo.js';
import { layout, LOW, HIGH, overOf, heardOver, levelY, pitchY, shade, rowBins, ticks, createForecast, levelAt, runs, audible, held, series, place, untrimmed, createClock, say, PROBLEMS, explain, recap, notable, siteKey, file, restore, sameTuning } from '../public/listen-view.js';

// The parts of the listening panel that need no page. What the canvas looks like is checked by eye.

const START = 1_800_000_000_000;
const site = { lat: 40, lon: -100, elevM: 0 };
// An aircraft flying straight and level that passes over the set `over` seconds in, as the feed would report it at second `s`.
const plane = ({ hex, category = 'A3', kt = 250, ft = 3000, over, flight }) => (s) => ({ hex, flight, category, lat: site.lat + (kt * 0.5144 * (s - over)) / 111195, lon: site.lon, alt_baro: ft, gs: kt, track: 0, seen_pos: 0 });
const update = (planes, s, floor = -Infinity) => ({ at: START + s * 1000, tracks: planes.map((p) => predict(p(s), site, { loss: 0, floor })).filter(Boolean) });

test('the timeline fits any width from a small phone to a laptop', () => {
  for (const width of [288, 358, 600, 788, 1344]) {
    for (const listening of [false, true]) {
      const g = layout(width, listening);
      assert.ok(g.xNow > 30 && g.xNow < width / 2, `${width}: now at ${g.xNow}`);
      assert.equal(Math.round((g.xNow / width) * (g.past + g.ahead)), Math.round(g.past));
      assert.ok(g.pitch.y + g.pitch.h < g.level.y && g.level.y + g.level.h < g.rail.y && g.rail.y + g.rail.h < g.axis.y && g.axis.y + g.row <= g.height, 'the bands stack without touching');
      assert.ok(g.ahead >= 240, 'at least four minutes of forecast');
      assert.ok(g.pitch.h >= 3 * g.row, 'room for three rows of names');
    }
    assert.ok(layout(width, true).past >= 120 && layout(width, false).past < 70, 'the past only gets room while listening');
  }
  const phone = layout(358, true);
  assert.ok(Math.abs(phone.width / (phone.past + phone.ahead) - 1) < 0.01, 'a phone shows about a pixel a second');
  assert.equal(layout(1344, false).ahead, 472.5); // nearly all 8 minutes of the forecast
  assert.ok(layout(358, true, 20).height > layout(358, true, 15).height, 'larger text gets taller rows');
});

test('the timeline fills whatever height the page gives it', () => {
  for (const width of [358, 532, 719]) {
    for (const height of [176, 243, 330, 488, 620]) {
      for (const listening of [false, true]) {
        const g = layout(width, listening, 15, height);
        assert.equal(g.height, height);
        assert.ok(g.pitch.y + g.pitch.h < g.level.y && g.level.y + g.level.h < g.rail.y && g.rail.y + g.rail.h < g.axis.y && g.axis.y + g.row <= g.height, 'the bands stack without touching');
        assert.ok(g.pitch.h >= 3 * g.row, 'room for three rows of names');
        assert.ok(g.level.h >= 60, `${width}x${height}: a loudness band of ${g.level.h}`);
        assert.ok(g.pitch.h <= 304, 'never more than a pixel a bin');
      }
    }
  }
  assert.ok(layout(532, true, 15, 330).pitch.h > layout(532, true, 15, 243).pitch.h, 'while listening, more height is more spectrogram');
  assert.ok(layout(532, false, 15, 330).level.h > layout(532, false, 15, 243).level.h, 'otherwise it is more loudness band');
  assert.deepEqual(layout(719, true, 15, layout(719, true).height), layout(719, true), 'given the height it would choose, it is the same timeline');
});

test('pitch and loudness land where the axes say', () => {
  const band = { y: 10, h: 304 };
  assert.equal(pitchY(FMIN, band), 314);
  assert.ok(Math.abs(pitchY(FMAX, band) - 10) < 1e-9);
  assert.ok(Math.abs(pitchY(100, band) - (314 - 48)) < 1e-9, 'an octave is 48 bins');
  assert.ok(pitchY(1000, band) < pitchY(100, band));

  const level = { y: 100, h: 80 };
  assert.equal(levelY(LOW, level), 180);
  assert.equal(levelY(HIGH, level), 100);
  assert.equal(levelY(0, level), 160); // the warning level, a quarter of the way up
  assert.equal(levelY(99, level), 100);
  assert.equal(levelY(-Infinity, level), 180);

  // A measured rise of 3 dB is an aircraft as loud as the background: exactly at the warning level.
  assert.ok(Math.abs(overOf(10 * Math.log10(2))) < 1e-9);
  assert.ok(Math.abs(overOf(20) - 20) < 0.05, 'well above it, the rise is the level');
  assert.ok(overOf(0) < LOW && overOf(-0.3) < LOW && Number.isFinite(levelY(overOf(-0.3), level)), 'no rise is off the bottom, not an error');

  assert.deepEqual([0, 2, 14, 26, 40].map(shade), [0, 0, 0.5, 1, 1]);
});

test('every spectrogram bin is shown, whatever the height in pixels', () => {
  for (const rows of [114, 152, 228, 304, 456, 684]) {
    const map = rowBins(rows);
    assert.equal(map[1], BINS, 'the top row ends at the highest bin');
    assert.equal(map[2 * rows - 2], 0, 'the bottom row starts at the lowest');
    const seen = new Uint8Array(BINS);
    for (let r = 0; r < rows; r++) {
      assert.ok(map[2 * r + 1] > map[2 * r], 'no row is empty');
      if (r) assert.ok(map[2 * r + 1] <= map[2 * r - 2] + 1 && map[2 * r] <= map[2 * r - 2], 'rows go down in pitch');
      for (let b = map[2 * r]; b < map[2 * r + 1]; b++) seen[b] = 1;
    }
    assert.ok(seen.every(Boolean), `${rows} rows leave no bin out`);
  }
});

test('minute marks are thinned out where their words would touch', () => {
  assert.deepEqual(ticks(120, 240, 1).map((t) => t.text), ['−2 min', '−1 min', 'now', '1 min', '2 min', '3 min', '4 min']);
  assert.deepEqual(ticks(120, 240, 0.7).map((t) => t.s), [-120, 0, 120, 240]);
  assert.deepEqual(ticks(45, 315, 1).map((t) => t.s), [0, 60, 120, 180, 240, 300]);
});

test('the forecast keeps what earlier polls said about the past, and the newest guess about the future', () => {
  const jet = plane({ hex: 'jet001', flight: 'TST123', over: 60 });
  const forecast = createForecast();
  forecast.update(update([jet], 0));
  const first = forecast.planes.get('jet001');
  assert.equal(first.name, 'TST123');
  const peak = first.pts.reduce((a, b) => (b.db > a.db ? b : a));
  assert.ok(Math.abs(peak.at - (START + 60_000 + (914 / 343) * 1000)) < 2000, 'loudest when the sound from overhead arrives');
  assert.equal(first.peak, peak.db);
  assert.ok(Math.abs(levelAt(first, peak.at) - peak.db) < 1e-9 && levelAt(first, peak.at + 1000) < peak.db);
  assert.equal(levelAt(first, START - 3_600_000), -Infinity);
  const before = levelAt(first, START + 2000);

  // Five seconds on the feed says it is 400 ft lower. What it was predicted to sound like in those
  // five seconds stays; everything from now on is the new prediction.
  const lower = (s) => ({ ...jet(s), alt_baro: 2600 });
  forecast.update(update([lower], 5));
  const now = forecast.planes.get('jet001');
  assert.equal(levelAt(now, START + 2000), before);
  assert.ok(levelAt(now, peak.at) > peak.db + 0.5, 'lower is louder');
  assert.ok(now.pts.every((p, i) => !i || p.at > now.pts[i - 1].at), 'samples stay in order of time');

  // Gone from the feed: what it did stays on the timeline, and what it was going to do is gone at once.
  // Ahead of now the timeline is only ever the forecast the banner is using.
  forecast.update(update([], 10));
  const gone = forecast.planes.get('jet001');
  assert.ok(gone.pts.length >= 2 && gone.pts.at(-1).at <= START + 10_000, `its last sample is ${(gone.pts.at(-1).at - START) / 1000} s in`);
  assert.equal(levelAt(gone, START + 2000), before);
  forecast.update(update([], 400));
  assert.equal(forecast.planes.size, 0, 'and it is forgotten once it has slid off the timeline');
});

test('the timeline eases a new forecast out of the old one only where that makes sense', () => {
  const jet = plane({ hex: 'jet001', over: 60 });
  const forecast = createForecast();
  forecast.update(update([jet], 0));
  assert.equal(forecast.planes.get('jet001').was, null, 'new: it appears');
  const old = forecast.planes.get('jet001').pts.slice();
  forecast.update(update([(s) => ({ ...jet(s), alt_baro: 2600 })], 5));
  const now = forecast.planes.get('jet001');
  assert.deepEqual(now.was, old, 'eases from what was drawn');
  const ease = morph(now.was, now.pts, 't');
  const peak = now.pts.reduce((a, b) => (b.db > a.db ? b : a));
  const was = ease(0).find((p) => p.t === peak.t);
  assert.ok(Math.abs(was.db - old.reduce((a, b) => (b.db > a.db ? b : a)).db) < 0.5, 'starting from the old peak');
  assert.equal(ease(1), now.pts, 'and ending on the new forecast itself');

  forecast.update(update([(s) => ({ ...jet(s), lon: site.lon + 0.05 })], 10)); // 4 km east: the replay looped
  assert.equal(forecast.planes.get('jet001').was, null, 'a jump cuts');
  forecast.update(update([jet], 15));
  assert.equal(forecast.planes.get('jet001').was, null, 'and so does the jump back');
  forecast.update(update([jet], 20));
  assert.notEqual(forecast.planes.get('jet001').was, null);
  forecast.update(update([], 25));
  assert.equal(forecast.planes.get('jet001').was, null, 'gone: its future is cut, as before');
  forecast.update(update([jet], 30));
  assert.equal(forecast.planes.get('jet001').was, null, 'back again: it appears');
});

test('the hold rail never shows a hold that the page does not have', () => {
  // Case: an aircraft is audible, the rail runs on ahead of now, and then a fresh feed no
  // longer has the aircraft. The banner's windows say clear, so the rail must stop at that update.
  const jet = plane({ hex: 'jet001', over: 20 });
  const floor = 55;
  const forecast = createForecast();
  const first = update([jet], 0, floor);
  const windows = (u) => u.tracks.map((w) => ({ hex: w.hex, start: u.at + w.startS * 1000, end: u.at + w.endS * 1000 }));
  forecast.update(update([jet], 0));
  const [hold] = held(forecast.planes, windows(first), first.at, floor);
  assert.ok(hold[0] < START + 15_000 && hold[1] > START + 30_000, 'a hold from the windows, running on past the peak');
  assert.deepEqual(held(forecast.planes, [], first.at, floor), [], 'with no window, nothing ahead of now is a hold, whatever the kept paths say');

  for (const s of [5, 10, 15]) forecast.update(update([jet], s));
  forecast.update(update([], 20)); // gone from the feed, mid-pass
  const after = held(forecast.planes, [], START + 20_000, floor);
  assert.equal(after.length, 1);
  assert.ok(after[0][1] <= START + 20_000, `the rail ends ${(after[0][1] - START) / 1000} s in, not after the update that lost the aircraft`);
  assert.ok(after[0][0] < START + 15_000, 'what was predicted before that stays as history');

  // The banner goes on saying Hold for a few seconds while it checks the aircraft has gone: the rail
  // runs as long as the banner did, not only as long as the windows.
  const checked = held(forecast.planes, [], START + 20_000, floor, [[START + 12_000, START + 30_000]]);
  assert.deepEqual([checked.length, checked[0][1]], [1, START + 30_000]);

  // A hold in progress: history up to the update and the window from it join into one stretch.
  forecast.update(update([jet], 20));
  const now = update([jet], 20, floor);
  assert.equal(held(forecast.planes, windows(now), now.at, floor).length, 1);
});

test('the stretches predicted audible are the ones the banner counts down to', () => {
  const a = plane({ hex: 'aaa111', over: 60 });
  const b = plane({ hex: 'bbb222', over: 75 }); // overlaps the first
  const c = plane({ hex: 'ccc333', over: 300 });
  const floor = 55;
  const forecast = createForecast();
  forecast.update(update([a, b, c], 0));
  const spans = audible(forecast.planes, floor);
  const [wa, wb, wc] = update([a, b, c], 0, floor).tracks;
  assert.equal(spans.length, 2, 'two aircraft that overlap make one stretch');
  assert.deepEqual(spans.map((span) => span.map((ms) => Math.round(ms - START))), [[wa.startS, wb.endS], [wc.startS, wc.endS]].map((span) => span.map((s) => Math.round(s * 1000))));
  assert.deepEqual(audible(forecast.planes, 200), []);

  // A path with a hole in it (an aircraft waiting on the runway) is two runs, never joined across the silence.
  const held = { pts: [0, 2, 4, 30, 32].map((s) => ({ at: START + s * 1000, db: 60 })) };
  assert.deepEqual(runs(held, START, START + 60_000).map((run) => run.length), [3, 2]);
  assert.deepEqual(audible(new Map([['x', held]]), 50).map(([from, to]) => [from - START, to - START]), [[0, 4000], [30_000, 32_000]]);
  assert.equal(levelAt(held, START + 15_000), -Infinity);
  assert.deepEqual(runs(held, START + 3000, START + 3500).map((run) => run.map((p) => p.at - START)), [[2000, 4000]], 'one sample past each edge, so lines reach it');
  // Only the stretch loud enough to show is drawn, with one sample either side to bring the line down.
  const swell = { pts: [10, 12, 30, 52, 60, 41, 20, 11, 10].map((db, i) => ({ at: START + i * 2000, db })) };
  assert.deepEqual(runs(swell, START, START + 60_000, 35).map((run) => run.map((p) => p.db)), [[30, 52, 60, 41, 20]]);
  assert.deepEqual(runs(swell, START, START + 60_000, 70), []);
});

test('names keep to their rows as the timeline slides, and never touch', () => {
  const items = [{ hex: 'a', x: 100, w: 60 }, { hex: 'b', x: 130, w: 60 }, { hex: 'c', x: 150, w: 60 }, { hex: 'd', x: 400, w: 60 }];
  const rows = place(items, 2);
  assert.deepEqual([...rows], [['a', 0], ['b', 1], ['d', 0]], 'the third has no room on two rows and is left out');
  assert.deepEqual([...place(items, 3)], [['a', 0], ['b', 1], ['c', 2], ['d', 0]]);
  // Later they have all slid left together: nobody changes row.
  const slid = items.map((it) => ({ ...it, x: it.x - 80 }));
  assert.deepEqual([...place(slid, 3, place(items, 3))], [['a', 0], ['b', 1], ['c', 2], ['d', 0]]);
  // Then the first slides off the end, and the two it was holding down close ranks.
  const later = slid.slice(1);
  assert.deepEqual([...place(later, 3, place(items, 3))], [['b', 0], ['c', 1], ['d', 0]]);
  // Two that shared a row and have drifted together: the more important keeps it and the other moves.
  assert.deepEqual([...place([{ hex: 'd', x: 100, w: 60 }, { hex: 'a', x: 90, w: 60 }], 3, new Map([['a', 0], ['d', 0]]))], [['d', 0], ['a', 1]]);
  // A newcomer never pushes a name off the row it already has.
  assert.deepEqual([...place([{ hex: 'new', x: 60, w: 60 }, later[0]], 3, new Map([['b', 0]]))], [['b', 0], ['new', 1]]);
  // A name moves back up once the row above has room to spare, but not while it would only just fit.
  const pair = (x) => [{ hex: 'a', x: 100, w: 60 }, { hex: 'b', x, w: 60 }];
  const apart = new Map([['a', 0], ['b', 1]]);
  assert.equal(place(pair(175), 2, apart).get('b'), 1, '15 px clear of its neighbour: stays');
  assert.equal(place(pair(200), 2, apart).get('b'), 0, '40 px clear: moves up');
  assert.equal(place(pair(175), 2, new Map([['a', 0], ['b', 0]])).get('b'), 0, 'and once up it stays up');
});

test("the demo's sound is made from predictions with the page's trim taken back out", () => {
  const { tracks } = update([plane({ hex: 'jet001', over: 60 }), plane({ hex: 'prop01', category: 'A1', over: 90 })], 0);
  const plain = untrimmed(tracks, { A1: 6 });
  assert.equal(plain[0], tracks[0]);
  assert.ok(plain[1].path.every((p, i) => p.db === tracks[1].path[i].db - 6 && p.heardAt === tracks[1].path[i].heardAt));
});

test('a block of audio is timed by the audio clock, not by when its message arrived', () => {
  const clock = createClock();
  const stamps = [];
  // A block every 100 ms of audio. Messages arrive 5 to 45 ms late, and one is held up for 400 ms.
  for (let i = 1; i <= 100; i++) stamps.push(clock.stamp(i * 100, START + i * 100 + (i === 40 ? 400 : 5 + ((i * 37) % 40))));
  assert.ok(stamps.every((t, i) => Math.abs(t - (START + (i + 1) * 100 + 5)) < 40), 'never further out than the first message was late');
  assert.ok(stamps.slice(15).every((t, i) => Math.abs(t - stamps[i + 14] - 100) < 2), 'once a prompt message has been seen, time moves at the pace of the samples');
  assert.ok(Math.abs(stamps[99] - (START + 10_000 + 5)) < 2, 'and stays tied to that message');

  // The page is blocked for 5 s, then the queued blocks all arrive at once: still no jump.
  let at = stamps[99];
  for (let i = 101; i <= 150; i++) at = clock.stamp(i * 100, START + 15_005);
  assert.ok(Math.abs(at - (START + 15_005)) < 2);

  // The audio is suspended for a minute. Blocks then keep arriving a minute "late": after 3 s the clock believes it.
  const after = [];
  for (let i = 151; i <= 200; i++) after.push(clock.stamp(i * 100, START + 60_000 + i * 100 + 10));
  assert.ok(Math.abs(after[20] - (START + 17_100)) < 20, 'not at once');
  assert.ok(Math.abs(after[49] - (START + 80_010)) < 2, 'but for good once it has lasted');
  assert.equal(after.filter((t, i) => i && t - after[i - 1] > 1000).length, 1, 'in one jump, which the engine takes as the microphone having stopped');

  // An audio clock running 50 parts in a million slow is followed without a jump.
  const slow = createClock();
  let worst = 0;
  for (let i = 1; i <= 36_000; i++) worst = Math.max(worst, Math.abs(slow.stamp(i * 100, START + i * 100.005 + 8) - (START + i * 100.005 + 8)));
  assert.ok(worst < 5, `off by at most ${worst} ms over an hour`);
});

const status = (heard, ready = true) => ({ ready, signal: true, heard });
const heardAs = (hex, how, candidates = []) => ({ hex, how, candidates, confidence: 0.8, tones: [], fundamental: null });
const name = (hex) => ({ aaa111: 'UAL12', bbb222: 'N123AB', ccc333: 'DAL9' })[hex] ?? hex;

test('what is heard is said in words that change only with the facts', () => {
  const head = (s, stale = false) => say({ status: s, name, stale })[0];
  const body = (s, stale = false) => say({ status: s, name, stale })[1];
  assert.deepEqual(say({ status: status([], false), name }), ['Learning the background', 'About 20 seconds.']);
  assert.deepEqual(say({ status: status([]), name }), ['Quiet', '']);
  assert.deepEqual(say({ status: status([heardAs('bbb222', 'doppler')]), name }), ['Hearing N123AB', 'Matched by pitch.']);
  assert.deepEqual(say({ status: status([heardAs('bbb222', 'doppler'), heardAs('aaa111', 'doppler')]), name }), ['Hearing N123AB and UAL12', 'Matched by pitch.']);
  assert.deepEqual(say({ status: status([heardAs('aaa111', 'envelope', ['aaa111'])]), name }), ['Hearing UAL12', 'Matched by loudness.']);
  // A dead or muted microphone is not a quiet set, and it says what to check.
  assert.deepEqual(say({ status: { ready: false, signal: false, heard: [] }, name }), ['No microphone signal', 'Check it is not muted and the right input is chosen.']);
  // Only what the engine says now decides the words. Once it withdraws a match and reports noise with
  // that aircraft as the one candidate, the aircraft is no longer named as heard: the noise may be
  // something else. (Case: noise ahead of a silent tracked aircraft.) That holds
  // whatever else is passed in, such as a note of how it was named a second ago.
  const withdrawn = status([heardAs(null, 'level', ['bbb222'])]);
  for (const was of ['envelope', 'doppler']) {
    assert.deepEqual(say({ status: withdrawn, name, matched: new Map([['bbb222', was]]) }), ['Aircraft noise', 'Probably N123AB.']);
  }
  assert.equal(body(status([heardAs(null, 'level', ['aaa111'])])), 'Probably UAL12.');
  assert.equal(body(status([heardAs(null, 'level', ['aaa111', 'ccc333'])])), 'Could be UAL12 or DAL9.');
  assert.equal(body(status([heardAs(null, 'level', ['aaa111', 'bbb222', 'ccc333', 'd', 'e'])])), 'Could be UAL12, N123AB, DAL9 or 2 more.');
  // Noise with no candidate: said plainly, and never as an aircraft.
  assert.deepEqual(say({ status: status([heardAs(null, 'level')]), name }), ['Unexplained noise', 'No tracked aircraft fits it.']);
  // With flight data stopped, nothing heard is pinned on an aircraft from an old forecast.
  assert.deepEqual(say({ status: status([heardAs('aaa111', 'envelope')]), name, stale: true }), ['Noise', 'No flight data to match it to.']);
  assert.equal(head(status([]), true), 'Quiet');
  // The same facts give the same words, whatever the numbers beside them.
  assert.deepEqual(say({ status: { ...status([]), rise: 0.4, level: -61 }, name }), say({ status: { ...status([]), rise: 1.9, level: -58 }, name }));
  // The panel keeps one line for a headline and two for what follows (listen.css), on a phone 320 px
  // wide: about 26 and 70 characters. Aircraft names aside, nothing said may be longer.
  const every = [
    ...Object.values(PROBLEMS),
    ...[{ ready: false, signal: false, heard: [] }, status([], false), status([]), status([heardAs('bbb222', 'doppler')]), status([heardAs('aaa111', 'envelope')]), withdrawn, status([heardAs(null, 'level', ['aaa111', 'bbb222', 'ccc333', 'd'])]), status([heardAs(null, 'level')])].map((s) => say({ status: s, name })),
    say({ status: withdrawn, name, stale: true }),
  ];
  for (const [title, more] of every) assert.ok(title.length <= 26 && more.length <= 70, `"${title}" and "${more}" fit their lines`);
  // Every problem says what to do: each fix names the action that recovers from it.
  const DO = { insecure: /https|localhost/, unsupported: /Use a current/, denied: /Allow it/, none: /Connect or enable/, busy: /Close/, unplugged: /Reconnect/, suspended: /Tap the page/ };
  assert.deepEqual(Object.keys(PROBLEMS).sort(), Object.keys(DO).sort(), 'every problem has its action checked');
  for (const [key, [title, fix]] of Object.entries(PROBLEMS)) assert.ok(title && DO[key].test(fix), `${key} says what to do: "${fix}"`);
  assert.equal(new Set(Object.values(PROBLEMS).map(([title]) => title)).size, Object.keys(PROBLEMS).length, 'and no two read the same');
});

const pass = (floor, more) => ({ hex: 'aaa111', category: 'A3', how: 'envelope', heard: true, confidence: 0.75, predPeak: floor + 12, floor, ...more });
const missed = (predPeak) => ({ hex: 'aaa111', category: 'A3', how: 'unheard', heard: false, confidence: 0.7, predPeak, floor: null });

test('what was learned is a short status: how many aircraft, the level, and how sure', () => {
  const at = { floor: 35 };
  assert.equal(explain(tune([]), at), 'Learning: 0 of 4 aircraft heard.');
  assert.equal(explain(tune([pass(39)]), at), 'Learning: 1 of 4 aircraft heard.');
  // Aircraft the page expected and the microphone did not hear never move the level, and are never
  // counted as something it was learned from: a covered or muted microphone looks the same. They get
  // a few words of their own, which leave the judgement to the user.
  const NOTE = / (\d+) expected aircraft not heard: check the microphone, or raise the level\.$/;
  assert.equal(explain(tune([pass(39), missed(30)]), at), 'Learning: 1 of 4 aircraft heard. 1 expected aircraft not heard: check the microphone, or raise the level.');
  assert.match(explain(tune([missed(30), missed(31)]), at), /^Learning: 0 of 4 aircraft heard\. /);
  assert.equal(explain(tune([missed(30), missed(31)]), at).match(NOTE)[1], '2');

  const four = explain(tune([38, 39, 39, 40].map((f) => pass(f))), { floor: 39 });
  assert.equal(four, 'Learned from 4 aircraft: warning level 39 dBA (estimate), settling ±1 dB.', 'the level is called an estimate where it is given');
  assert.doesNotMatch(four, NOTE, 'nothing is said about unheard aircraft when there were none');

  // Lowered before four (tune.js): said, with how many it rests on.
  assert.equal(explain(tune([pass(12.7), pass(10)], 20), { floor: 15 }), 'Learning: 2 of 4 aircraft heard. Level lowered to 13 dBA (estimate). Slider stops at 15.');

  const nine = tune([...[38, 39, 39, 40, 39, 39, 38, 40, 39].map((f) => pass(f)), missed(60), missed(61)]);
  const told = explain(nine, { floor: 42 });
  assert.match(told, /^Learned from 9 aircraft: warning level 39 dBA \(estimate\), settled\. You moved it to 42\. /);
  assert.equal(told.match(NOTE)[1], '2', 'the two unheard aircraft are mentioned apart');
  assert.doesNotMatch(told, /unheard|Learned from 11|and 2 that/, 'and not as something the level was learned from');
  assert.equal(nine.floor, tune([38, 39, 39, 40, 39, 39, 38, 40, 39].map((f) => pass(f))).floor, 'which they did not move');
  // Until the page has taken up what was learned there is no slider to compare it with.
  assert.doesNotMatch(explain(nine, { floor: null }), /moved/, 'nothing to say about a change that did not happen');
  assert.doesNotMatch(explain(nine, { floor: 39 }), /moved/);

  // The slider only goes from 15 to 65.
  const loud = explain(tune([70, 70, 71, 71].map((f) => pass(f))), { floor: 65 });
  assert.match(loud, /warning level 71 dBA \(estimate\), settling ±1 dB\. Slider stops at 65\.$/);
  assert.doesNotMatch(loud, /moved/);
  assert.match(explain(tune([9, 9, 10, 10].map((f) => pass(f))), { floor: 15 }), /Slider stops at 15\.$/);

  const mixed = tune([...[41, 41.5, 42, 42, 42, 42.5, 43, 43].map((f) => pass(f)), ...[35, 36, 36, 36.5, 37].map((f) => pass(f, { category: 'A1' }))]);
  assert.match(explain(mixed, { floor: 42 }), /By type: light aircraft 6 dB louder than predicted\.$/);
});

test('a finished pass gets a few words only when it is news', () => {
  const o = { ...pass(39, { peakErr: 1, onsetErr: 0 }), name: 'UAL12', was: 35 };
  assert.equal(recap(o), 'Last: UAL12, matched by loudness, 4 dB quieter than predicted.');
  assert.equal(recap({ ...o, how: 'doppler', floor: 34.6, peakErr: -2 }), 'Last: UAL12, matched by pitch, about as loud as predicted.');
  assert.equal(recap({ ...o, floor: 29 }), 'Last: UAL12, matched by loudness, 6 dB louder than predicted.');
  // Heard, but not measured: the sound peaked more than 3 s from the prediction, or another aircraft was as
  // loud. The engine gives such a pass no floor and a confidence of 0.45. It reads as heard and not used,
  // with no loudness figure made up for it.
  const unmeasured = recap({ ...o, how: 'doppler', floor: null, confidence: 0.45, peakErr: null, onsetErr: null });
  assert.equal(unmeasured, 'Last: UAL12 heard by pitch, not used for tuning.');
  assert.doesNotMatch(unmeasured, /dB|louder|quieter|NaN|null/);
  assert.equal(recap({ ...o, floor: null, confidence: 0.45 }), 'Last: UAL12 heard by loudness, not used for tuning.');
  // Heard against an estimate of an aircraft the feed had lost: not used either, and marked as the estimate it was.
  assert.equal(recap({ ...o, lost: true }), 'Last: UAL12 heard by loudness, not used for tuning (estimate: contact lost).');
  assert.equal(recap({ ...missed(50), name: 'UAL12', was: 35 }), 'Last: UAL12 predicted, not heard.');
  assert.equal(recap({ ...missed(50), how: 'unsure', heard: null, name: 'UAL12', was: 35 }), 'Last: noise while UAL12 was due, not matched.');
  assert.equal(recap({ hex: null, how: 'unexplained', heard: true, seconds: 40, name: null }), 'Last: 40 s of unexplained noise.');

  assert.ok(notable(pass(39), 35));
  assert.ok(notable({ hex: null, how: 'unexplained', heard: true, predPeak: null }, 35));
  assert.ok(notable(missed(41), 35), 'predicted over the warning level and not heard');
  assert.ok(!notable(missed(28), 35), 'predicted too faint to hear, and not heard: no news');
  assert.ok(notable(missed(28), 35, { A3: 8 }), 'unless the trim in use had it over the warning level');
  assert.ok(!notable({ ...missed(28), how: 'unsure', heard: null }, 35));
});

test('what is stored is one list per set and environment, small enough to keep', () => {
  assert.equal(siteKey({ lat: 33.93842, lon: -118.4392741 }, 'indoors'), '33.93842,-118.4392741 indoors');
  assert.notEqual(siteKey({ lat: 40, lon: -100 }, 'indoors'), siteKey({ lat: 40.0003, lon: -100 }, 'indoors'), 'an address a few metres away is another set, as it is to app.js');
  assert.notEqual(siteKey({ lat: 33.938, lon: -118.439 }, 'stage'), siteKey({ lat: 33.938, lon: -118.439 }, 'indoors'));

  const seen = { ...pass(39), curve: { from: START, step: 1000, pred: [1, 2], rise: [0, 1] } };
  const one = file({}, 'a', [seen, seen], 100);
  assert.deepEqual(one, { a: { at: 100, list: [pass(39), pass(39)] } });
  assert.deepEqual(tune(one.a.list), tune([seen, seen]), 'tuning never reads the curve that is left out');
  assert.deepEqual(file(one, 'a', [], 200), {}, 'forgetting a set removes it');

  let sets = {};
  for (let i = 0; i < 20; i++) sets = file(sets, `set ${i}`, [pass(i)], i);
  assert.deepEqual(Object.keys(sets), Array.from({ length: 12 }, (_, i) => `set ${19 - i}`), 'only the dozen used most recently');
  assert.ok(Object.keys(file(sets, 'set 8', [pass(8)], 99))[0] === 'set 8');
});

test('the audio thread hands over a tenth of a second at a time, counted in samples', async () => {
  // listen-worklet.js runs inside an AudioWorklet. These are the three things that scope gives it.
  const sent = [];
  let Tap;
  Object.assign(globalThis, { AudioWorkletProcessor: class { port = { postMessage: (message) => sent.push(message) }; }, registerProcessor: (_, processor) => (Tap = processor), sampleRate: 48000, currentFrame: 0 });
  await import('../public/listen-worklet.js');
  const quantum = Float32Array.from({ length: 128 }, (_, i) => i); // the browser calls process() with 128 frames at a time
  const feed = (tap, quanta) => {
    for (let n = 0; n < quanta; n++, globalThis.currentFrame += 128) assert.equal(tap.process([[quantum]]), true);
  };

  const tap = new Tap({ processorOptions: { every: 1 } });
  feed(tap, 100);
  assert.deepEqual(sent.map((m) => [m.pcm.length, m.frame]), [[4800, 4800], [4800, 9600]], 'each block says how far the audio clock had got at its last sample');
  assert.deepEqual([sent[0].pcm[0], sent[0].pcm[4799], sent[1].pcm[0]], [0, 4799 % 128, 4800 % 128], 'and no sample is lost between blocks');
  assert.equal(tap.process([[]]), true, 'nothing connected is not an error');

  // A 96 kHz device is cut to the 48 kHz the engine takes, two samples averaged into one.
  Object.assign(globalThis, { sampleRate: 96000, currentFrame: 0 });
  sent.length = 0;
  feed(new Tap({ processorOptions: { every: 2 } }), 100);
  assert.deepEqual(sent.map((m) => [m.pcm.length, m.frame]), [[4800, 9600]]);
  assert.deepEqual([...sent[0].pcm.subarray(0, 3)], [0.5, 2.5, 4.5]);
});

test('what the microphone measured is drawn on the same scale as the forecast', () => {
  // Case: a floor of 40 was learned, the user has the slider at 50, and an aircraft
  // predicted at 60 passes exactly as predicted. The forecast draws it 10 dB over the warning level.
  // The microphone measures it 20 dB over the background, which is the learned floor: also +10.
  const rise = 10 * Math.log10(1 + 10 ** (20 / 10)); // what a source 20 dB over the background lifts the level by
  assert.ok(Math.abs(overOf(rise) - 20) < 1e-9);
  assert.ok(Math.abs(heardOver(rise, 50, 40) - (60 - 50)) < 1e-9);
  assert.ok(Math.abs(heardOver(rise, 40, 40) - 20) < 1e-9, 'with the slider where the microphone put it, the two scales are one');
  assert.ok(Math.abs(heardOver(rise, 35, 40) - 25) < 1e-9, 'and a slider moved down shows the same sound further over it');
  // With nothing learned there is nothing to tie the two together: it is drawn against the background as it is.
  assert.ok(Math.abs(heardOver(rise, 50, null) - 20) < 1e-9);
});

test('the pitch overlay is the whole harmonic series when the engine names the note', () => {
  // As the engine filed a light aircraft in the page: the second harmonic upwards, and the note they belong to.
  const tones = { hz: [146.2, 220.1, 293.5, 367.6, 441.1, 513.5, 588.5, 661.6, 734.3], fundamental: 73.4 };
  const drawn = series(tones);
  assert.equal(drawn.length, 10);
  assert.equal(drawn[0], 73.4, 'the strongest ridge, which the engine leaves out of its tones, gets a curve too');
  assert.ok(tones.hz.every((hz) => drawn.some((d) => Math.abs(d / hz - 1) < 0.012)), 'and every tone it found is on the series');
  assert.deepEqual(series({ hz: [212, 517], fundamental: null }), [212, 517], 'tones that are not a series are drawn as they are');
  assert.deepEqual(series({ hz: [], fundamental: 80 }), []);
});

test('saved settings are checked before they are used', () => {
  const good = { hex: 'abc123', category: 'A3', how: 'envelope', heard: true, confidence: 0.75, predPeak: 52, floor: 40 };
  const unheard = { hex: 'abc123', category: 'A3', how: 'unheard', heard: false, confidence: 0.7, predPeak: 52, floor: null };
  const empty = { device: '', sets: {} };
  for (const text of [null, '', 'not json', '42', '"text"', '[]', 'null', '{"sets":null}', '{"sets":[]}', '{"sets":"x"}', '{"on":"yes","device":7}']) assert.deepEqual(restore(text), empty, `${text}`);

  const saved = restore(JSON.stringify({
    on: true,
    device: 'abc',
    before: 35, // from an earlier version: not kept
    sets: {
      'a indoors': { at: 5, list: [good, unheard] },
      'list is an object': { at: 5, list: {} },
      'no time': { list: [good] },
      'not a set': 'x',
      'nothing left': { at: 5, list: [null, 'x', 7, [], { ...good, floor: 'loud' }, { ...good, hex: null }, { ...good, confidence: null }, { ...good, heard: null }] },
      'some good': { at: 9, list: [{ ...good, predPeak: undefined }, good] },
    },
  }));
  assert.deepEqual(saved, { device: 'abc', sets: { 'a indoors': { at: 5, list: [good, unheard] }, 'some good': { at: 9, list: [good] } } });
  for (const set of Object.values(saved.sets)) assert.doesNotThrow(() => tune(set.list));
  assert.deepEqual(restore(JSON.stringify(saved)), saved, 'what it writes, it reads back the same');
});

test('two tunings are the same when the page would treat them the same', () => {
  assert.ok(sameTuning({ floor: null, trim: {} }, { floor: undefined, trim: undefined }));
  assert.ok(sameTuning({ floor: 39.1, trim: { A1: 4, A7: -3 } }, { floor: 39.1, trim: { A7: -3, A1: 4 } }));
  assert.ok(!sameTuning({ floor: 39.1, trim: {} }, { floor: 39, trim: {} }));
  assert.ok(!sameTuning({ floor: 39.1, trim: { A1: 4 } }, { floor: 39.1, trim: {} }));
  assert.ok(!sameTuning({ floor: null, trim: {} }, { floor: 0, trim: {} }));
});

test('a forecast that comes mid-ease eases on from what is drawn, not from the forecast before', async () => {
  const { createForecast } = await import('../public/listen-view.js');
  const T = 1_800_000_000_000;
  const path = (db) => Array.from({ length: 60 }, (_, i) => ({ t: i * 2, heardAt: i * 2, x: 0, y: 0, alt: 300, dist: 300, db }));
  const f = createForecast();
  f.update({ at: T, tracks: [{ hex: 'a', path: path(40) }] });
  f.update({ at: T + 5000, tracks: [{ hex: 'a', path: path(70) }] });
  const plane = f.planes.get('a');
  // Drawn halfway through that ease, at 55 dB, when the next forecast (50 dB) arrives.
  plane.shown = plane.pts.map((p) => ({ ...p, db: 55 }));
  f.update({ at: T + 10_000, tracks: [{ hex: 'a', path: path(50) }] });
  assert.ok(plane.was.length && plane.was.every((p) => p.db === 55), 'the next ease starts where the curve was drawn');
  assert.equal(plane.shown, null);
  f.update({ at: T + 15_000, tracks: [{ hex: 'a', path: path(50) }] });
  assert.ok(plane.was.filter((p) => p.at >= T + 10_000).every((p) => p.db === 50), 'with nothing easing, from the last forecast');
});

test('listening never starts by itself: only a press of the button asks for the microphone', () => {
  assert.equal('on' in restore(JSON.stringify({ on: true, device: 'abc', sets: {} })), false, 'whether it was on last time is not kept');
  const page = readFileSync(new URL('../public/listen.js', import.meta.url), 'utf8');
  assert.doesNotMatch(page, /permissions\.query|saved\.on/);
  assert.deepEqual([...page.matchAll(/\blisten\((?!device\))[^)]*\)/g)].map((m) => m[0]).sort(), ["listen('')", 'listen(core.saved.device)', 'listen(ui.select.value)']);
});
