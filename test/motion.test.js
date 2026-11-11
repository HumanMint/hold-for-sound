import test from 'node:test';
import assert from 'node:assert/strict';
import { ENVIRONMENTS, predict } from '../public/predict.js';
import { remember, motion, KEEP_S, MAX_REPORTS } from '../public/motion.js';
import { status } from '../public/status.js';
import { follow } from '../public/lost.js';

const T0 = 1_800_000_000_000;
const site = { lat: 34, lon: -118, elevM: 0 };
const KT = 0.5144;
const RAD = Math.PI / 180;
// A feed row for a helicopter `x` m east and `y` m north of the site.
const row = (x, y, more) => ({ hex: 'heli01', category: 'A7', lat: 34 + y / 111195, lon: -118 + x / 92185, alt_baro: 1000, seen_pos: 0, ...more });

// Polls a helicopter every 5 s for a minute: `at(s)` is its row `s` seconds in. Returns the last row
// and how it has been moving by then.
function watch(at) {
  const history = new Map();
  for (let s = 0; s <= 60; s += 5) remember(history, [at(s)], T0 + s * 1000);
  return { ac: at(60), m: motion(history.get('heli01')) };
}
const state = (w) => status(w ? [{ ...w, start: T0 + w.startS * 1000, end: T0 + w.endS * 1000 }] : [], T0, T0).state;

test('turning across north is a turn of a few degrees, not most of a circle', () => {
  const tracks = [350, 354, 358, 2, 6, 10, 14];
  const history = new Map();
  tracks.forEach((track, i) => remember(history, [row(i * 250, 0, { gs: 100, track })], T0 + i * 5000));
  assert.ok(Math.abs(motion(history.get('heli01')).wander - 0.8) < 1e-9); // 4 degrees every 5 s
});

test('the history is short, bounded, and forgets aircraft that have gone', () => {
  const history = new Map();
  for (let s = 0; s < 200; s++) remember(history, [row(s * 50, 0, { gs: 100, track: 90 })], T0 + s * 1000);
  assert.equal(history.get('heli01').length, MAX_REPORTS); // a report a second: the count is the limit
  history.clear();
  for (let s = 0; s < 200; s += 5) remember(history, [row(s * 50, 0, { gs: 100, track: 90 })], T0 + s * 1000);
  const list = history.get('heli01');
  const n = list.length;
  assert.ok(n < MAX_REPORTS && (list.at(-1).t - list[0].t) / 1000 === KEEP_S); // every 5 s: the age is
  // The feed repeating a position it already gave adds nothing.
  remember(history, [row(195 * 50, 0, { gs: 100, track: 90, seen_pos: 1.5 })], T0 + 196_000);
  assert.equal(history.get('heli01').length, n);
  remember(history, [], T0 + 195_000 + 299_000);
  assert.ok(history.has('heli01'));
  remember(history, [], T0 + 195_000 + 301_000);
  assert.equal(history.size, 0);
});

test('reports on the ground are kept, for whether it is speeding up, and leave its flight alone', () => {
  const history = new Map();
  const at = (s, gs, more) => remember(history, [row(s * 5, 0, { hex: 'heli01', alt_baro: 'ground', gs, track: 90, ...more })], T0 + s * 1000);
  at(0, 3);
  assert.deepEqual(motion(history.get('heli01')), { gaining: false }, 'one report: nothing to compare, and no flight');
  at(4, 14);
  assert.deepEqual(motion(history.get('heli01')), { gaining: true });
  at(8, 14);
  assert.equal(motion(history.get('heli01')).gaining, false, 'as fast is not faster');
  at(30, 20);
  assert.equal(motion(history.get('heli01')).gaining, false, 'its report before was 22 s earlier');
  // In the air, what it did on the ground plays no part in how it has been flying.
  for (let s = 35; s <= 95; s += 5) remember(history, [row(s * 5, 0, { gs: 100, track: 90 })], T0 + s * 1000);
  const m = motion(history.get('heli01'));
  const air = new Map();
  for (let s = 35; s <= 95; s += 5) remember(air, [row(s * 5, 0, { gs: 100, track: 90 })], T0 + s * 1000);
  assert.deepEqual(m, motion(air.get('heli01')));
});

test('a slower speed reported with no new position ends `gaining`, and a speed too old to compare gives none', () => {
  const history = new Map();
  // `s` seconds in, a report whose position was made at `pos` s.
  const at = (s, pos, gs) => remember(history, [row(pos * 5, 0, { alt_baro: 'ground', gs, track: 90, seen_pos: s - pos })], T0 + s * 1000);
  at(0, 0, 13);
  at(5, 5, 14);
  assert.equal(motion(history.get('heli01')).gaining, true);
  at(10, 5, 14); // the same answer again: nothing new
  assert.equal(motion(history.get('heli01')).gaining, true);
  at(15, 5, 12); // its position stuck, its speed falling
  assert.equal(motion(history.get('heli01')).gaining, false);
  at(20, 5, 15); // and rising again, 5 s after the speed before
  assert.equal(motion(history.get('heli01')).gaining, true);
  at(40, 5, 16); // 20 s after it: too long to say it is speeding up now
  assert.equal(motion(history.get('heli01')).gaining, false);
  assert.equal(history.get('heli01').length, 2, 'speeds are kept on the report, not as new positions');
});

test('a backtracking aircraft that slows with its position stuck is no takeoff', () => {
  const lon = (metresEast) => -118 + metresEast / 92185;
  const runways = [{ airport: 'TEST', ends: [{ id: '09', lat: 34, lon: lon(-5000) }, { id: '27', lat: 34, lon: lon(-2000) }] }];
  const history = new Map();
  const known = new Map();
  // On 09's centreline, going east at 13 then 14 kt: a slow start of a roll. Then its position stops
  // updating, and the speed it reports falls to 10 kt.
  const polls = [[0, 0, 13], [5, 5, 14], [10, 5, 12], ...[15, 20, 25, 30, 35, 40, 45, 50].map((s) => [s, 5, 10])];
  const got = polls.map(([s, pos, gs]) => {
    const ac = { hex: 'back01', category: 'A3', alt_baro: 'ground', lat: 34, lon: lon(-4500 + pos * 7), gs, true_heading: 90, track: 90, seen_pos: s - pos };
    const now = T0 + s * 1000;
    remember(history, [ac], now);
    const { tracks, windows } = follow(known, [ac], now, site, () => ({ ...ENVIRONMENTS.outdoors, runways, motion: motion(history.get(ac.hex)) }));
    const told = status(windows.map((w) => ({ ...w, start: now + w.startS * 1000, end: now + w.endS * 1000 })), now, now);
    return [windows[0]?.phase, told.state, !!told.unsure];
  });
  assert.deepEqual(got[1], ['taking off from', 'soon', false]);
  // Slower: only lined up, as it was before it sped up, and no takeoff is made up from a speed it no
  // longer has. Once its position is lost (20 s old) the page cannot tell. Never a hold.
  assert.deepEqual(got.slice(2), [
    ...Array(4).fill(['lined up on', 'soon', false]),
    ...Array(5).fill(['lined up on', 'soon', true]),
  ]);
});

test('a position no aircraft could have flown to starts its history again', () => {
  // A recording looping back: 5 s after its last report it is 8 km away.
  const history = new Map();
  for (let s = 0; s <= 60; s += 5) remember(history, [row(s * 50, 0, { gs: 100, track: 90 })], T0 + s * 1000);
  remember(history, [row(-5000, 0, { gs: 100, track: 0 })], T0 + 65_000);
  assert.equal(history.get('heli01').length, 1);
  // 100 kt for 5 s, with some feed jitter, is not a jump.
  remember(history, [row(-5000, 300, { gs: 100, track: 0 })], T0 + 70_000);
  assert.equal(history.get('heli01').length, 2);
});

test('a helicopter orbiting 4 km out is not a hold because its track points at the set for a moment', () => {
  // A 400 m orbit at 60 kt, clockwise about a point 4 km east, ending heading straight for the set.
  const r = 400;
  const w = (60 * KT) / r; // rad/s
  const at = (s) => {
    const a = Math.PI + w * (s - 60); // bearing from the centre: due south of it at the end
    return row(4000 + r * Math.sin(a), 400 + r * Math.cos(a), { gs: 60, track: (((a / RAD + 90) % 360) + 360) % 360 });
  };
  const { ac, m } = watch(at);
  assert.equal(Math.round(ac.track), 270);
  assert.ok(m.circling);
  const outdoors = { ...ENVIRONMENTS.outdoors };
  assert.ok(predict(ac, site, outdoors), 'its straight line alone crosses the set');
  assert.equal(predict(ac, site, { ...outdoors, motion: m }), null);
});

test('a helicopter hovering beside the set is a hold, and one hovering 2 km away is nothing', () => {
  const near = watch((s) => row(300 + (s % 10), 0, { alt_baro: 500, gs: 3, track: (s * 37) % 360 }));
  const w = predict(near.ac, site, { ...ENVIRONMENTS.outdoors, motion: near.m });
  assert.equal(state(w), 'hold');
  assert.ok(w.endS > 400, 'and stays one');

  // Holding over a spot 2 km out behind walls, wobbling at up to 12 kt, and for now heading for the set.
  const far = watch((s) => row(2000 + 30 * Math.sin(s / 5), 30 * Math.sin(s / 7), { alt_baro: 500, gs: s === 60 ? 12 : 8, track: (s * 53) % 360 }));
  far.ac.track = 270;
  const indoors = { ...ENVIRONMENTS.indoors };
  assert.ok(predict(far.ac, site, indoors), 'its straight line alone reaches the set');
  assert.equal(predict(far.ac, site, { ...indoors, motion: far.m }), null);
});

test('a helicopter flying straight for the set still gets a heads up, less sure when it is not known to fly straight', () => {
  // 100 kt due west, at 3 km and at 6 km after a minute of that.
  const near = watch((s) => row(6000 - 100 * KT * s, 0, { gs: 100, track: 270 }));
  const w = predict(near.ac, site, { ...ENVIRONMENTS.outdoors, motion: near.m });
  assert.equal(state(w), 'soon');
  assert.equal(w.rough, undefined);
  const far = watch((s) => row(9000 - 100 * KT * s, 0, { gs: 100, track: 270 }));
  const later = predict(far.ac, site, { ...ENVIRONMENTS.outdoors, motion: far.m });
  assert.ok(later.startS > 60 && later.rough === undefined, 'a minute of flying straight is believed');

  // The one at 6 km, just seen: nothing says it keeps its heading. It is expected on it all the same, less surely.
  const once = new Map();
  remember(once, [far.ac], T0);
  const first = predict(far.ac, site, { ...ENVIRONMENTS.outdoors, motion: motion(once.get('heli01')) });
  assert.ok(first.rough && Math.abs(first.startS - later.startS) < 1, `as soon, and rough: ${first.startS}`);
});

// The page's side of polls every 5 s, as app.js does it, with a helicopter's history kept as it goes.
// `rowAt(s)` is its row `s` seconds in, or null once the feed has lost it.
function polls(env, rowAt, until) {
  const known = new Map();
  const history = new Map();
  const seen = [];
  for (let s = 0; s <= until; s += 5) {
    const now = T0 + s * 1000;
    const rows = [rowAt(s)].filter(Boolean);
    remember(history, rows, now);
    const { windows } = follow(known, rows, now, site, (ac) => ({ ...ENVIRONMENTS[env], motion: motion(history.get(ac.hex)) }));
    const timed = windows.map((w) => ({ ...w, start: now + w.startS * 1000, end: now + w.endS * 1000 }));
    seen.push({ s, windows, state: status(timed, now, now).state });
  }
  return seen;
}

test('a helicopter that slows to a hover beside the set and is then lost stays a hold', () => {
  // 100 kt due west, coming to a hover 300 m east of the set at 40 s, lost after 70 s.
  const x = (s) => 300 + 100 * KT * Math.max(0, 40 - s);
  const seen = polls('indoors', (s) => s <= 70 && row(x(s), 0, { alt_baro: 500, gs: s < 40 ? 100 : 2, track: 270 }), 180);
  for (const { s, state: st } of seen.filter((p) => p.s >= 40)) assert.equal(st, 'hold', `${s} s in`);
});

test('a circling helicopter is not expected nearer than it has been', () => {
  // A figure eight 3 km east, 1.2 km across, at 60 kt and 1000 ft: never close enough to hear outdoors.
  const r = 300;
  const w = (60 * KT) / (2 * r);
  const at = (s) => {
    const a = w * s;
    return row(3000 + 2 * r * Math.sin(a), r * Math.sin(2 * a), { gs: 60, track: (Math.atan2(2 * r * Math.cos(a), 2 * r * Math.cos(2 * a)) / RAD + 360) % 360 });
  };
  const history = new Map();
  let nearest = Infinity;
  for (let s = 0; s <= 90; s += 5) {
    remember(history, [at(s)], T0 + s * 1000);
    const m = motion(history.get('heli01'));
    nearest = Math.min(nearest, Math.hypot(3000 + 2 * r * Math.sin(w * s), r * Math.sin(2 * w * s)));
    if (!m.circling) continue;
    const { path } = predict(at(s), site, { ...ENVIRONMENTS.outdoors, floor: -Infinity, motion: m });
    const closest = Math.min(...path.map((p) => Math.hypot(p.x, p.y)));
    assert.ok(closest > nearest - 1, `${s} s in: expected ${Math.round(closest)} m away, flown no nearer than ${Math.round(nearest)} m`);
  }
  assert.ok(motion(history.get('heli01')).circling);
});

test('a helicopter circling is expected back at the side of its circle nearest the set', () => {
  // A 400 m orbit at 60 kt about a point 1.5 km east, at 1000 ft, seen at its far side: heard indoors
  // only from the near side.
  const r = 400;
  const w = (60 * KT) / r;
  const at = (s) => {
    const a = Math.PI / 2 + w * (s - 60); // bearing from the centre: due east of it at the end
    return row(1500 + r * Math.sin(a), r * Math.cos(a), { gs: 60, track: (((a / RAD + 90) % 360) + 360) % 360 });
  };
  const { ac, m } = watch(at);
  assert.ok(m.circling);
  assert.equal(predict(ac, site, { ...ENVIRONMENTS.indoors, motion: { ...m, area: [ac] } }), null, 'from where it is now it is not heard');
  assert.ok(predict(ac, site, { ...ENVIRONMENTS.indoors, motion: m }));
});

test('a helicopter that stops circling and heads for the set is expected to come', () => {
  // The 400 m orbit at 60 kt, about a point 3 km east, left 10 s ago at 100 kt due west, at 1000 ft.
  const r = 400;
  const w = (60 * KT) / r;
  const history = new Map();
  let ac;
  for (let s = 0; s <= 70; s += 5) {
    const a = Math.PI + w * (Math.min(s, 60) - 60);
    ac = row(3000 + r * Math.sin(a) - 100 * KT * Math.max(0, s - 60), r * Math.cos(a), { gs: s > 60 ? 100 : 60, track: s > 60 ? 270 : (((a / RAD + 90) % 360) + 360) % 360 });
    remember(history, [ac], T0 + s * 1000);
  }
  const m = motion(history.get('heli01'));
  assert.equal(m.circling, false);
  assert.ok(predict(ac, site, { ...ENVIRONMENTS.outdoors, motion: m }));
});

test('a helicopter drifting slowly and straight is expected to drift on', () => {
  // 10 kt due west from 2 km east, its reported track wandering as a slow helicopter's does.
  const watched = watch((s) => row(2000 - 10 * KT * s, 0, { alt_baro: 500, gs: 10, track: s === 60 ? 90 : 270 }));
  const w = predict(watched.ac, site, { ...ENVIRONMENTS.indoors, motion: watched.m });
  assert.ok(w && w.startS > 0, 'heard once it has drifted to the set');
});

test('a helicopter just seen coming straight for the set is warned of on its heading, and kept when lost', () => {
  // 5 km east, 100 kt due west at 500 ft, seen once and then lost.
  const seen = polls('indoors', (s) => s === 0 && row(5000, 0, { alt_baro: 500, gs: 100, track: 270 }), 10);
  for (const { s, windows } of seen) {
    assert.equal(windows.length, 1, `${s} s in`);
    assert.ok(windows[0].rough && windows[0].peakDb > 60, `${s} s in: rough and loud`);
  }
});
