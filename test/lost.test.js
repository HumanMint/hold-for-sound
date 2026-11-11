import test from 'node:test';
import assert from 'node:assert/strict';
import { ENVIRONMENTS } from '../public/predict.js';
import { follow, LOST_S, CAP_S, UNSURE_S } from '../public/lost.js';
import { status } from '../public/status.js';

const T0 = 1_800_000_000_000;
const site = { lat: 34, lon: -118, elevM: 0 };
// A 3 km east-west runway whose east end is 2 km west of the site, as in predict.test.js.
const lon = (metresEast) => -118 + metresEast / 92185;
const runways = [{ airport: 'TEST', ends: [{ id: '09', lat: 34, lon: lon(-5000) }, { id: '27', lat: 34, lon: lon(-2000) }] }];

// The page's side of a poll, as app.js does it: the feed's rows `s` seconds in go through follow(),
// and the windows get their start and end in epoch ms. `s` relative to T0 keeps the numbers readable.
// `age` is how old the answer is (seconds), as app.js passes it: already in each row's `seen_pos`.
function watch(env = 'outdoors') {
  const known = new Map();
  return {
    known,
    poll(s, rows, age = 0) {
      const now = T0 + s * 1000;
      const { tracks, windows } = follow(known, rows, now, site, () => ({ ...ENVIRONMENTS[env], runways }), age);
      const sec = (ms) => (ms - T0) / 1000;
      return { now, tracks, windows: windows.map((w) => ({ ...w, start: now + w.startS * 1000, end: now + w.endS * 1000, from: sec(now + w.startS * 1000), to: sec(now + w.endS * 1000) })) };
    },
  };
}
const state = ({ windows, now }) => status(windows, now, now).state;

// A heavy jet 7 km short of the threshold of runway 27 at 140 kt, which takes it over the site on the
// way down. It touches down 7.3 km on, 101 s later, 2.3 km from the site and still audible there, and
// rolls out away from the site.
const final27 = { hex: 'f1a127', flight: 'TST27  ', category: 'A5', lat: 34, lon: lon(5000), alt_baro: 1300, gs: 140, track: 270, baro_rate: -700, seen_pos: 0 };
const TOUCHDOWN = 7300 / (140 * 0.5144);
// An airliner 10 nm due south at 3000 ft, flying north at 250 kt: overhead in about 144 s.
const inbound = { hex: 'abc123', flight: 'TEST1  ', category: 'A3', lat: 34 - 10 / 60, lon: -118, alt_baro: 3000, gs: 250, track: 0, seen_pos: 0 };
const at = (ac, s) => ({ ...ac, lat: ac.lat + (ac.gs * 0.5144 * s) / 111195 }); // `inbound`, s seconds on
const heli = { hex: 'def456', category: 'A7', lat: 34, lon: -118, alt_baro: 800, gs: 0, seen_pos: 0 };

test('an aircraft lost on final keeps its window through its rollout and no longer', () => {
  const page = watch();
  const first = page.poll(0, [final27]);
  assert.equal(`${first.windows[0].phase} ${first.windows[0].runway}`, 'landing on 27');
  const end = first.windows[0].to;
  assert.ok(end > TOUCHDOWN + 8 && end < TOUCHDOWN + 30, `audible for a few seconds after the sound of touchdown arrives, about ${Math.round(TOUCHDOWN + 7)} s in: got ${end}`);
  assert.equal(first.tracks[0].lost, undefined);

  // The feed never reports it again. Every poll still has it, once, with the same end.
  for (let s = 5; s < end; s += 5) {
    const got = page.poll(s, []);
    assert.deepEqual([got.tracks.length, got.windows.length], [1, 1], `carried on ${s} s in`);
    const [w] = got.windows;
    assert.ok(Math.abs(w.to - end) <= 2, `still ends at touchdown ${s} s in: ${w.to}`);
    assert.equal(w.phase, 'landing on');
    assert.equal(w.seenAt, T0);
    assert.equal(got.tracks[0].seenAt, T0);
    // It is an estimate from the first answer that leaves it out, on the track and on the window alike.
    assert.deepEqual([w.lost, got.tracks[0].lost], [true, true], `${s} s in`);
    if (s > w.from) assert.equal(state(got), 'hold');
  }

  // After its rollout it is gone: no window running on, no track, and nothing kept to bring it back.
  const after = page.poll(Math.ceil(end / 5) * 5 + 5, []);
  assert.deepEqual([after.tracks, after.windows, state(after)], [[], [], 'clear']);
  assert.equal(page.known.size, 0);
});

test('an aircraft lost in the middle of its pass keeps its hold to the predicted end, then clears', () => {
  const page = watch('indoors');
  const seen = page.poll(140, [at(inbound, 140)]);
  const [w] = seen.windows;
  assert.ok(w.from < 140 && w.to > 150 && w.to < 200, `audible now, until some seconds after it is overhead: ${w.from} to ${w.to}`);
  assert.equal(state(seen), 'hold');
  for (let s = 145; s < w.to; s += 5) {
    const got = page.poll(s, []);
    assert.equal(state(got), 'hold', `${s} s in`);
    assert.ok(Math.abs(got.windows[0].to - w.to) <= 2, `the same end ${s} s in: ${got.windows[0].to}`);
  }
  const after = page.poll(Math.ceil(w.to / 5) * 5 + 5, []);
  assert.deepEqual([after.windows, state(after)], [[], 'clear']);
  assert.equal(page.known.size, 0);
});

test('an estimate runs out after two minutes, so a hold on it always ends', () => {
  // A helicopter hovering over the set is audible for as long as anyone can say. Lost, it is not.
  const page = watch('stage');
  assert.ok(page.poll(0, [heli]).windows[0].to > 400);
  for (let s = 5; s < CAP_S; s += 5) {
    const got = page.poll(s, []);
    assert.equal(got.windows[0].end, T0 + CAP_S * 1000, `the hold is cut off where the estimate runs out, ${s} s in`);
    assert.equal(state(got), 'hold');
  }
  // Run out is not gone quiet: it was still due to be heard, so the page says it cannot tell. No
  // hold, no track to draw, and never clear, for two minutes more at most.
  for (let s = CAP_S; s < CAP_S + UNSURE_S; s += 5) {
    const got = page.poll(s, []);
    assert.deepEqual([got.tracks, got.windows.length], [[], 1], `${s} s in`);
    const [w] = got.windows;
    assert.deepEqual([w.unsure, w.lost, w.seenAt, w.end, w.path], [true, true, T0, T0 + (CAP_S + UNSURE_S) * 1000, []]);
    const now = status(got.windows, got.now, got.now);
    assert.deepEqual([now.state, now.unsure.hex, now.until], ['soon', heli.hex, null], `${s} s in`);
  }
  const over = page.poll(CAP_S + UNSURE_S, []);
  assert.deepEqual([over.windows, state(over), page.known.size], [[], 'clear', 0]);

  // The feed can go on listing an aircraft it has lost, with no position or one too old to use. That
  // is no report: the estimate carries on from the last good row, and runs out all the same.
  const listed = watch('stage');
  listed.poll(0, [heli]);
  for (const stale of [{ ...heli, seen_pos: 75 }, { hex: heli.hex, category: 'A7', alt_baro: 800 }]) {
    assert.equal(listed.poll(65, [stale]).windows[0].seenAt, T0);
    assert.equal(listed.poll(CAP_S, [stale]).windows[0].unsure, true);
    assert.deepEqual(listed.poll(CAP_S + UNSURE_S, [stale]).windows, []);
    listed.poll(0, [heli]);
  }

  // The same on final. At 100 kt the jet above is over the set after 1:37 and down after 2:22: its
  // hold is cut off at 2:00 as well, and the page cannot tell until the touchdown it last predicted.
  const far = watch();
  const slow = { ...final27, gs: 100 };
  const landsAt = far.poll(0, [slow]).windows[0].end;
  assert.ok(landsAt > T0 + 135_000 && landsAt < T0 + 155_000, `down about 2:22 in, got ${(landsAt - T0) / 1000}`);
  const late = far.poll(CAP_S - 5, []);
  assert.deepEqual([state(late), late.windows[0].end, late.tracks[0].path.every((p) => p.heardAt <= 5)], ['hold', T0 + CAP_S * 1000, true]); // and nothing is drawn past it
  const out = far.poll(CAP_S, []);
  assert.deepEqual([out.tracks, out.windows[0].unsure, state(out)], [[], true, 'soon']);
  assert.ok(Math.abs(out.windows[0].end - landsAt) < 3000, 'unsure until the touchdown last predicted, not for the full two minutes');
  assert.equal(state(far.poll(150, [])), 'clear');

  // A real aircraft audible now is still a hold, whatever else the page has lost track of.
  const both = watch('stage');
  both.poll(0, [heli]);
  const busy = both.poll(CAP_S + 10, [{ ...heli, hex: 'fresh1' }]);
  assert.deepEqual([state(busy), busy.windows.map((w) => !!w.unsure).sort()], ['hold', [false, true]]);

  // And one that ends before its estimate runs out just ends: nothing was left unsure.
  const done = watch();
  done.poll(0, [final27]);
  assert.deepEqual(done.poll(CAP_S, []).windows, []);
});

test('an aircraft that will not be heard before its estimate runs out is not kept', () => {
  const page = watch();
  const away = { ...inbound, hex: 'away01', track: 180 }; // flying away: never audible
  const near = { ...at(inbound, 60), hex: 'near01' }; // a minute closer than `inbound`
  const seen = page.poll(0, [away, inbound, near]);
  assert.equal(seen.tracks.length, 3, 'each has a track while it is reported');
  const from = Object.fromEntries(seen.windows.map((w) => [w.hex, w.from]));
  assert.ok(from.abc123 > CAP_S && from.near01 < CAP_S && !('away01' in from), `first heard ${from.abc123} s and ${from.near01} s in`);
  // All three leave the feed. Only the one that will be heard within two minutes is carried on.
  const gone = page.poll(5, []);
  assert.deepEqual([gone.tracks.map((w) => w.hex), gone.windows.map((w) => w.hex)], [['near01'], ['near01']]);
  assert.deepEqual([...page.known.keys()], ['near01'], 'and the others are forgotten, not worked out again every poll');
});

test('a fresh report replaces the estimate at once, and nothing is counted twice', () => {
  const page = watch();
  page.poll(0, [final27]);
  assert.equal(page.poll(40, []).windows[0].lost, true);
  // Back in the feed 45 s on, where it should be: one track and one window, from the report.
  const back = { ...final27, lon: lon(5000 - 140 * 0.5144 * 45), alt_baro: 775 };
  const got = page.poll(45, [back, back]); // even if the feed lists it twice
  assert.deepEqual([got.tracks.length, got.windows.length], [1, 1]);
  assert.deepEqual([got.windows[0].lost, got.windows[0].seenAt, got.tracks[0].seenAt], [undefined, got.now, got.now]);
  const [est] = page.poll(40, []).windows; // (asking again changes nothing: the estimate is worked out afresh each time)
  assert.ok(Math.abs(got.windows[0].from - est.from) <= 2 && Math.abs(got.windows[0].to - est.to) <= 2, 'and nothing jumps: it is where the estimate had it');

  // Reported on the ground, off the runway: that is a report too. The estimate does not outlive it,
  // and is not brought back when that row goes as well.
  const landed = { ...final27, alt_baro: 'ground', lat: 34.002, lon: lon(-3500), gs: 12 };
  assert.deepEqual(page.poll(55, [landed]), { now: T0 + 55_000, tracks: [], windows: [] });
  assert.deepEqual(page.poll(60, []).tracks, []);
});

test('an estimate is the last track carried forward in time', () => {
  const page = watch();
  const [was] = page.poll(0, [{ ...final27, seen_pos: 4 }]).tracks;
  const [now] = page.poll(10, []).tracks;
  // Where it was predicted to be 10 s on is where it is put now, and the sound arrives when it was going to.
  for (const t of [0, 20, 60]) {
    const then = was.path.find((p) => p.t === t + 10);
    const p = now.path.find((p) => p.t === t);
    assert.deepEqual([p.x, p.y, p.alt, p.db], [then.x, then.y, then.alt, then.db]);
    assert.ok(Math.abs(p.heardAt - (then.heardAt - 10)) < 1e-9);
  }
  assert.equal(now.seenAt, T0 - 4000, 'counted from the position, not from the poll');
});

test('an aircraft the feed still lists is lost once its position is 20 s old', () => {
  const page = watch();
  const row = (seen_pos) => page.poll(0, [{ ...inbound, seen_pos }]);
  assert.equal(row(LOST_S).tracks[0].lost, undefined);
  const old = row(LOST_S + 5);
  assert.deepEqual([old.tracks[0].lost, old.windows[0].lost, old.windows[0].seenAt], [true, true, T0 - 25_000]);
});

test('a takeoff under way is carried on, and one lined up and lost cannot be told', () => {
  const jet = { hex: 'aaa111', category: 'A3', alt_baro: 'ground', lat: 34, seen_pos: 0 };
  const waiting = { ...jet, hex: 'wa1t', lon: lon(-5000), gs: 0 };
  const page = watch();
  const seen = page.poll(0, [{ ...jet, hex: 'r011', lon: lon(-4500), gs: 60, track: 90 }, waiting]);
  assert.deepEqual(seen.windows.map((w) => w.phase).sort(), ['lined up on', 'taking off from']);
  const got = page.poll(5, []);
  assert.deepEqual(got.windows.map((w) => [w.hex, w.phase, !!w.unsure]), [['r011', 'taking off from', false], ['wa1t', 'lined up on', true]]);
  assert.deepEqual(got.tracks.map((w) => w.hex), ['r011'], 'no takeoff is made up for an aircraft that was waiting and is gone');
  assert.ok(Math.abs(got.windows[0].from - seen.windows.find((w) => w.hex === 'r011').from) <= 2);

  // On its own: it can go at any moment, so the page cannot tell. Never a hold, never clear, no countdown.
  const lone = watch();
  lone.poll(0, [waiting]);
  for (let s = 5; s < CAP_S; s += 5) {
    const now = lone.poll(s, []);
    const told = status(now.windows, now.now, now.now);
    assert.deepEqual([told.state, told.unsure?.hex, told.until, now.tracks], ['soon', 'wa1t', null, []], `${s} s in`);
    assert.deepEqual([now.windows[0].end, now.windows[0].path], [T0 + CAP_S * 1000, []], 'until its position is two minutes old');
  }
  // Then it is dropped, as any estimate is: by then it has gone, or the feed has it again.
  assert.deepEqual([lone.poll(CAP_S, []).windows, lone.known.size], [[], 0]);
  // Lost from a row the feed still lists, its position too old to use, the same.
  const listed = watch();
  listed.poll(0, [waiting]);
  assert.equal(listed.poll(65, [{ ...waiting, seen_pos: 65 }]).windows[0].unsure, true);
  // And once the position the feed still lists is lost (20 s old), though not yet too old to use: never
  // clear, whether or not the row was missing in between.
  const cannotTell = (got) => [state(got), got.windows.map((w) => [w.hex, w.phase, !!w.unsure, w.lost]), got.tracks];
  for (const gap of [[], [5]]) {
    const kept = watch();
    kept.poll(0, [waiting]);
    for (const s of gap) assert.deepEqual(cannotTell(kept.poll(s, [])), ['soon', [['wa1t', 'lined up on', true, undefined]], []]);
    assert.equal(state(kept.poll(15, [{ ...waiting, seen_pos: 15 }])), 'clear', 'not lost yet: its guessed takeoff is over a minute away');
    for (const s of [25, 40, 60]) {
      const got = kept.poll(s, [{ ...waiting, seen_pos: s }]);
      assert.deepEqual(cannotTell(got), ['soon', [['wa1t', 'lined up on', true, true]], []], `${s} s in`);
      assert.deepEqual([got.windows[0].from, got.windows[0].to], [s, CAP_S]);
    }
    assert.deepEqual(cannotTell(kept.poll(90, [])), ['soon', [['wa1t', 'lined up on', true, true]], []], 'and when the row goes');
  }
  // Seen again, it is a report like any other.
  const back = listed.poll(70, [{ ...waiting, lon: lon(-4900), gs: 40, track: 90 }]);
  assert.deepEqual(back.windows.map((w) => [w.phase, !!w.unsure]), [['taking off from', false]]);
  assert.equal(status(back.windows, back.now, back.now).unsure, undefined);

  // One whose takeoff would not be heard is forgotten, not kept as a doubt.
  const far = watch('stage');
  far.poll(0, [{ ...waiting, lon: lon(-2000), true_heading: 270 }]); // lined up on 27, taking off away from the site
  assert.deepEqual([far.poll(5, []).windows, far.known.size], [[], 0]);
});

test('an answer kept a minute does not make an old position a report: lost is measured from the answer', () => {
  // The server keeps a quiet sky's answer for up to a minute (cadence.js): its rows are that much older
  // when the page reads them, and the page adds the answer's age to each.
  const far = { ...inbound, lat: 34 - 25 / 60 }; // 25 nm out: nothing to hear yet
  const held = (rel, age) => watch().poll(0, [{ ...far, seen_pos: rel + age }], age).tracks;
  assert.equal(held(5, 50)[0].lost, undefined, 'fresh in an answer 50 s old');
  assert.equal(held(LOST_S + 1, 0)[0].lost, true);
  assert.equal(held(LOST_S + 1, 50)[0].lost, true, 'as old within its answer, however long the answer was kept');
  assert.equal(held(55, 50).length, 1, 'still predicted from');
  assert.equal(held(61, 50).length, 0, 'too old to predict from, within its answer');
  assert.equal(held(61, 0).length, 0);
});

test('an aircraft dropped from the newest answer is lost at once, whatever the cadence', () => {
  // A helicopter hovering beside the set, in one answer and not in the next, fetched a second after
  // the first and read 10 s, 30 s or a minute later (a quiet answer is kept that long).
  for (const gap of [10, 30, 60]) {
    const page = watch();
    assert.equal(page.poll(0, [heli]).tracks[0].lost, undefined);
    const next = page.poll(gap, [], gap - 1);
    assert.deepEqual([next.tracks[0]?.lost, next.windows[0]?.lost], [true, true], `${gap} s later`);
    assert.equal(page.poll(gap + 5, [], gap + 4).windows[0]?.lost, true, `${gap + 5} s later`);
  }
});

test('the rest of a rollout does not count as arriving again, so a later departure is warned of', () => {
  // app.js's side: an aircraft counts as just landed for 3 min after it was last seen arriving, and on
  // the ground then it is predicted to roll out, not to take off.
  const known = new Map();
  const arrivingAt = new Map();
  const poll = (s, rows) => {
    const now = T0 + s * 1000;
    const opts = (ac) => ({ ...ENVIRONMENTS.outdoors, runways, landed: now - (arrivingAt.get(ac.hex) ?? 0) < 180_000 });
    const { tracks, windows } = follow(known, rows, now, site, opts);
    for (const use of tracks) if (use.phase === 'landing on' && !use.rollout) arrivingAt.set(use.hex, now); // as app.js
    return { now, tracks, windows: windows.map((w) => ({ ...w, start: now + w.startS * 1000, end: now + w.endS * 1000 })) };
  };
  poll(0, [final27]); // on final
  const rolling = poll(10, [{ ...final27, alt_baro: 'ground', lon: lon(-2300), gs: 110, true_heading: 270 }]); // rolling out
  assert.deepEqual(rolling.tracks.map((t) => [t.phase, t.runway, t.rollout]), [['landing on', '27', true]]);
  assert.equal(arrivingAt.get(final27.hex), T0, 'still counted from the approach');
  // The same aircraft, 3 min after its approach, rolling east down 09: a takeoff, not another rollout.
  const out = poll(185, [{ ...final27, alt_baro: 'ground', lon: lon(-4500), gs: 60, track: 90, true_heading: 90 }]);
  assert.deepEqual([out.windows.map((w) => [w.phase, w.runway]), state(out)], [[['taking off from', '09']], 'hold']);
});
