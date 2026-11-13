import test from 'node:test';
import assert from 'node:assert/strict';
import { ENVIRONMENTS, predict, ifDeparts, unseen } from '../public/predict.js';
import { remember, motion } from '../public/motion.js';
import { status } from '../public/status.js';

const site = { lat: 34, lon: -118, elevM: 0 };
const run = (ac, env, extra) => predict(ac, site, { ...ENVIRONMENTS[env], ...extra });

// An airliner 10 nm due south at 3000 ft, flying north at 250 kt: overhead in about 144 s.
const inbound = { hex: 'abc123', flight: 'TEST1  ', category: 'A3', lat: 34 - 10 / 60, lon: -118, alt_baro: 3000, gs: 250, track: 0 };

test('inbound airliner is predicted ahead of time outdoors', () => {
  const w = run(inbound, 'outdoors');
  assert.ok(w.startS > 60 && w.startS < 144, `starts before it is overhead, got ${w.startS}`);
  assert.ok(w.endS > 150, `still audible after passing, got ${w.endS}`);
  assert.ok(Math.abs(w.peakAltFt - 3000) < 1 && w.peakDistM < 1000, 'peaks overhead');
  assert.equal(w.flight, 'TEST1');
});

test('walls shorten or remove the interruption', () => {
  const outdoors = run(inbound, 'outdoors');
  const indoors = run(inbound, 'indoors');
  assert.ok(indoors.endS - indoors.startS < outdoors.endS - outdoors.startS);
  assert.equal(run(inbound, 'stage'), null);
});

test('aircraft that never come close are ignored', () => {
  assert.equal(run({ ...inbound, track: 180 }, 'outdoors'), null); // flying away
  assert.equal(run({ ...inbound, alt_baro: 'ground' }, 'outdoors'), null);
  assert.equal(run({ ...inbound, seen_pos: 90 }, 'outdoors'), null);
});

test('a helicopter overhead is audible right now, even on a stage', () => {
  const w = run({ hex: 'def456', category: 'A7', lat: 34, lon: -118, alt_baro: 800, gs: 0 }, 'stage');
  assert.ok(w.startS <= 0 && w.endS > 400, `audible now and staying, got ${w.startS} to ${w.endS}`);
});

test('selected altitude stops a descent, unless it is the other way', () => {
  const descending = { ...inbound, alt_baro: 9000, baro_rate: -3000 };
  assert.ok(run(descending, 'outdoors').peakAltFt < 4000); // would level off low
  assert.ok(Math.abs(run({ ...descending, nav_altitude_mcp: 8000 }, 'outdoors').peakAltFt - 8000) < 1);
  assert.ok(run({ ...descending, nav_altitude_mcp: 12000 }, 'outdoors').peakAltFt < 4000); // e.g. a go-around altitude
});

// A 3 km east-west runway whose east end is 2 km west of the site: taking off on 09 goes over the site.
const lon = (metresEast) => -118 + metresEast / 92185;
const runways = [{ airport: 'TEST', ends: [{ id: '09', lat: 34, lon: lon(-5000) }, { id: '27', lat: 34, lon: lon(-2000) }] }];
const jet = { hex: 'aaa111', category: 'A3', alt_baro: 'ground', lat: 34 };

test('a jet on the runway is predicted before it leaves the ground', () => {
  const linedUp = run({ ...jet, lon: lon(-5000), gs: 0 }, 'outdoors', { runways });
  assert.equal(`${linedUp.phase} ${linedUp.runway}`, 'lined up on 09');
  assert.ok(linedUp.startS > 20 && linedUp.peakAltFt > 500, 'it is heard later, climbing over the site');

  const rolling = run({ ...jet, lon: lon(-4500), gs: 60, track: 90 }, 'outdoors', { runways });
  assert.equal(`${rolling.phase} ${rolling.runway}`, 'taking off from 09');
  assert.ok(rolling.startS < linedUp.startS, 'already moving, so sooner');

  const away = run({ ...jet, lon: lon(-2500), gs: 60, track: 270 }, 'outdoors', { runways });
  assert.equal(away.runway, '27');
  assert.ok(away.peakDb < rolling.peakDb - 10, 'departing away from the site is much quieter');

  const idling = run({ ...jet, lon: lon(-2000), gs: 0 }, 'outdoors', { runways });
  assert.ok(idling.startS > 20, `quiet until it starts to roll, got ${idling.startS}`);
});

test('an aircraft lines up and starts its roll on the paved entry before the runway end', () => {
  const m = (gaining) => ({ motion: { gaining } });
  const entry = { ...jet, lon: lon(-5150), true_heading: 90 }; // 150 m before the end of 09, on its centreline
  const lined09 = run({ ...entry, gs: 0 }, 'outdoors', { runways });
  assert.deepEqual([lined09.phase, lined09.runway], ['lined up on', '09']);
  assert.equal(run({ ...entry, gs: 0, lon: lon(-5250) }, 'outdoors', { runways }), null); // 250 m before: not yet on the runway
  const lined = run({ ...entry, gs: 0 }, 'outdoors', { runways });

  // 14 kt and faster than its report before: rolling, and heard sooner than the 20 s a lined-up one is given.
  const starting = run({ ...entry, gs: 14 }, 'outdoors', { runways, ...m(true) });
  assert.equal(starting.phase, 'taking off from');
  assert.ok(starting.startS < lined.startS - 15, `${starting.startS} against ${lined.startS}`);
  // Not speeding up, or slower than 10 kt: only lined up.
  assert.equal(run({ ...entry, gs: 14 }, 'outdoors', { runways, ...m(false) }).phase, 'lined up on');
  assert.equal(run({ ...entry, gs: 14 }, 'outdoors', { runways }).phase, 'lined up on');
  assert.equal(run({ ...entry, gs: 8 }, 'outdoors', { runways, ...m(true) }).phase, 'lined up on');
  // Speeding up while still turning onto the runway, or along a parallel taxiway 120 m off: no takeoff.
  assert.equal(run({ ...entry, gs: 14, true_heading: 30 }, 'outdoors', { runways, ...m(true) }), null);
  assert.equal(run({ ...entry, gs: 14, lat: 34 + 120 / 111195 }, 'outdoors', { runways, ...m(true) }), null);
  // In the second half of 09, going east: not a roll on 09. Going that way it can only be taxiing back
  // to the end of 27 (the shortcut in takeoff()), so it is lined up on 27, which departs away from the
  // site: later and much quieter than a departure on 09, and no hold now.
  const far = run({ ...entry, gs: 14, lon: lon(-3000) }, 'outdoors', { runways, ...m(true) });
  assert.deepEqual([far.phase, far.runway], ['lined up on', '27']);
  const on09 = run({ ...entry, gs: 0, lon: lon(-4500) }, 'outdoors', { runways });
  assert.ok(far.startS > 20 && far.peakDb < on09.peakDb - 10, `${far.startS} s, ${far.peakDb} against ${on09.peakDb} dB`);
});

test('on the ground a stale heading or a lagging track never hides a takeoff', () => {
  const way = (deg) => ({ motion: { gaining: false, way: deg } });
  const at = (more, extra) => run({ ...jet, lon: lon(-4900), gs: 40, ...more }, 'outdoors', { runways, ...extra });
  const phase = (w) => w && `${w.phase} ${w.runway}`;
  // The track lags a turn onto the runway: the heading is the one to go by, and its movement agrees.
  assert.equal(phase(at({ track: 180, true_heading: 90 })), 'taking off from 09');
  assert.equal(phase(at({ track: 180, true_heading: 90 }, way(85))), 'taking off from 09');
  // The heading is stale: moving east along 09 says the track is right.
  assert.equal(phase(at({ track: 90, true_heading: 180 }, way(92))), 'taking off from 09');
  // Nothing to tell them apart: the takeoff is kept.
  assert.equal(phase(at({ track: 90, true_heading: 180 })), 'taking off from 09');
  assert.equal(phase(at({ track: 90, true_heading: 180 }, way(135))), 'taking off from 09');
  // Turning off south, its track left behind on the runway: the movement says the heading is right.
  assert.equal(at({ track: 90, true_heading: 180 }, way(175)), null);
  // No heading: the track, as before.
  assert.equal(phase(at({ track: 90 })), 'taking off from 09');

  // A jet rolling east down 09 at 60 kt, its heading stuck at 180, polled every 5 s as the page does:
  // on every poll its takeoff is already audible or due within half a minute, and the banner says so.
  const history = new Map();
  for (let s = 0; s <= 20; s += 5) {
    const now = 1_800_000_000_000 + s * 1000;
    const row = { ...jet, lon: lon(-4500 + 60 * 0.5144 * s), gs: 60, track: 90, true_heading: 180, seen_pos: 0 };
    remember(history, [row], now);
    const w = run(row, 'outdoors', { runways, motion: motion(history.get(row.hex)) });
    assert.ok(phase(w) === 'taking off from 09' && w.startS < 30, `${s} s in`);
    const told = status([{ ...w, start: now + w.startS * 1000, end: now + w.endS * 1000 }], now, now);
    assert.deepEqual([told.state, told.until], [w.startS <= 0 ? 'hold' : 'soon', now + (w.startS <= 0 ? w.endS : w.startS) * 1000], `${s} s in`);
  }
});

test('an aircraft at runway level that still reports itself as flying is treated as rolling', () => {
  const fast = { hex: 'ccc333', category: 'A3', lat: 34, lon: lon(-4000), alt_baro: 25, gs: 100, track: 90, baro_rate: 0 };
  assert.equal(run(fast, 'outdoors', { runways }).phase, 'taking off from');
  assert.equal(run(fast, 'outdoors', { runways, landed: true, floor: -Infinity }).phase, 'landing on'); // rolling out after landing
  assert.equal(run({ ...fast, alt_baro: 1500 }, 'outdoors', { runways }).phase, undefined); // really flying
});

test('aircraft on the ground are ignored when they just landed or are off the runway', () => {
  assert.equal(run({ ...jet, lon: lon(-4500), gs: 60, track: 90 }, 'outdoors', { runways, landed: true }), null);
  assert.equal(run({ ...jet, lon: lon(-4500), gs: 60, track: 90 }, 'outdoors'), null); // no runway data
  assert.equal(run({ ...jet, lat: 34.002, lon: lon(-3500), gs: 12, track: 90 }, 'outdoors', { runways }), null); // taxiway
  assert.equal(run({ ...jet, lon: lon(-3500), gs: 12, track: 0 }, 'outdoors', { runways }), null); // crossing the runway
});

test('an aircraft on final lands instead of flying on past the airport', () => {
  // 8 km short of runway 09, which points at the site: it touches down 4.7 km away and is never heard.
  const final09 = { hex: 'bbb222', category: 'A3', lat: 34, lon: lon(-13000), alt_baro: 1375, gs: 140, track: 90, baro_rate: -700 };
  assert.ok(run(final09, 'outdoors').peakDistM < 500, 'without runway data it seems to pass low overhead');
  assert.equal(run(final09, 'outdoors', { runways }), null);

  // 8 km short of runway 27: it passes over the site on the way down.
  const final27 = { ...final09, lon: lon(6000), track: 270 };
  const w = run(final27, 'outdoors', { runways });
  assert.equal(`${w.phase} ${w.runway}`, 'landing on 27');
  assert.ok(w.peakAltFt > 300 && w.peakAltFt < 450, `about 380 ft over the site, got ${w.peakAltFt}`);
});

test('an aircraft that has just landed rolls out, quieter as it slows, and is quiet at taxiing speed', () => {
  // 8 km short of runway 27, which it lands on 2 km from the site and rolls out away from it.
  const final27 = { hex: 'bbb222', category: 'A3', lat: 34, lon: lon(6000), alt_baro: 1375, gs: 140, track: 270, baro_rate: -700 };
  const w = run(final27, 'outdoors', { runways });
  const touchdown = 8300 / (140 * 0.5144);
  const rolling = w.path.filter((p) => p.t > touchdown);
  assert.ok(rolling.length > 10 && rolling.every((p) => p.alt === 0), 'on the runway after touchdown');
  assert.ok(rolling.at(-1).t < touchdown + 30, `down to taxiing speed within 30 s, got ${rolling.at(-1).t - touchdown}`);
  assert.ok(rolling.every((p, i) => i === 0 || (p.db < rolling[i - 1].db && p.x < rolling[i - 1].x)), 'away from the site and quieter');
  const heavy = run({ ...final27, category: 'A5' }, 'outdoors', { runways });
  const down = heavy.path.find((p) => p.t > touchdown);
  assert.ok(heavy.endS > down.heardAt + 4, `a heavy is heard for a while after touchdown: ${heavy.endS} against ${down.heardAt}`);

  // Reported on the ground, just landed: the rest of its rollout. Slow, or not just landed, it is not one.
  const ground = { ...jet, lon: lon(-2300), gs: 110, true_heading: 270 };
  const rest = run(ground, 'outdoors', { runways, landed: true, floor: 30 });
  assert.equal(`${rest.phase} ${rest.runway}`, 'landing on 27');
  assert.ok(rest.startS < 0 && rest.endS > 10 && rest.endS < 30, `heard now and for some seconds, got ${rest.startS} to ${rest.endS}`);
  assert.ok(rest.path.slice(0, 16).every((p) => p.x === rest.path[0].x), 'nothing is made up for before its report');
  assert.equal(run({ ...ground, gs: 25 }, 'outdoors', { runways, landed: true, floor: -Infinity }), null);
  assert.equal(run(ground, 'outdoors', { runways }).phase, 'taking off from');
  // The rest of a rollout is marked, so the page does not take it for an approach (app.js).
  assert.deepEqual([rest.rollout, w.rollout, run(ground, 'outdoors', { runways }).rollout], [true, undefined, undefined]);
});

test('a taxiing aircraft is flagged by its worst-case takeoff, narrowed by where it is and the runway in use', () => {
  const taxi = { ...jet, lat: 34.002, lon: lon(-3500), gs: 12, track: 90 };
  const opts = { ...ENVIRONMENTS.outdoors, runways };
  const worst = ifDeparts(taxi, site, opts);
  assert.equal(worst.runway, '09');
  const known = ifDeparts(taxi, site, opts, new Set(['TEST 27']));
  assert.equal(known.runway, '27');
  assert.ok(known.peakDb < worst.peakDb);
  assert.equal(ifDeparts(taxi, site, { ...opts, landed: true }), null);
  assert.equal(ifDeparts({ ...taxi, gs: 0 }, site, opts), null); // parked
  assert.equal(ifDeparts({ ...taxi, lat: 34.2 }, site, opts), null); // on the ground somewhere else

  // Stopped at a holding point, 90 m off the centreline and 100 m before the end of 09: about to go.
  const holding = { ...jet, lat: 34 + 90 / 111195, lon: lon(-5100), gs: 0 };
  assert.equal(ifDeparts(holding, site, opts).runway, '09');
  assert.equal(ifDeparts({ ...holding, lat: 34 + 140 / 111195 }, site, opts), null); // parked 140 m off
  assert.equal(ifDeparts({ ...holding, lon: lon(-4500) }, site, opts), null); // beside the runway, away from its ends
  assert.equal(ifDeparts(holding, site, { ...opts, landed: true }), null);

  const atThe27End = { ...taxi, lat: 34.001, lon: lon(-2100) };
  assert.equal(ifDeparts(atThe27End, site, opts).runway, '27'); // about to enter 27, so not the worst case
  assert.equal(ifDeparts(atThe27End, site, opts, new Set(['TEST 09'])).runway, '09'); // unless 09 is the way in use
});

test('the result carries the whole predicted path, and trim shifts a class up or down', () => {
  const w = run(inbound, 'outdoors');
  assert.equal(w.path.length, 256); // every 2 s from 30 s ago to 8 min ahead, past the audible stretch too
  const overhead = w.path.reduce((a, b) => (b.dist < a.dist ? b : a));
  assert.ok(Math.abs(overhead.t - 144) <= 2 && Math.abs(overhead.heardAt - overhead.t - 914 / 343) < 0.1, 'sound lags the aircraft');
  assert.ok(Math.abs(overhead.x) < 1 && Math.abs(overhead.y) < 130 && Math.abs(overhead.alt - 914) < 1);
  assert.equal(overhead.db, w.peakDb);

  assert.ok(Math.abs(run(inbound, 'outdoors', { trim: { A3: -6 } }).peakDb - (w.peakDb - 6)) < 1e-9);
  assert.equal(run(inbound, 'outdoors', { trim: { A1: -6 } }).peakDb, w.peakDb);
  // An aircraft that is never audible still has a path when asked with no floor.
  assert.equal(run(inbound, 'stage'), null);
  assert.equal(run(inbound, 'stage', { floor: -Infinity }).path.length, 256);
});

test('takeoffs the feed may show too late: heard where a runway is near, not where walls or distance stop them', () => {
  const at = (env, extra) => unseen(site, { ...ENVIRONMENTS[env], floor: ENVIRONMENTS[env].floor + 5, runways, ...extra });
  // Beside the 3 km runway above (a heavy's): the roll is heard within seconds, from either end.
  const near = at('outdoors');
  assert.deepEqual(near.map((e) => `${e.runway} ${e.category}`).sort(), ['09 A5', '27 A5']);
  assert.ok(near[0].leadS >= 0 && near[0].leadS < 15, `heard almost as it rolls, got ${near[0].leadS}`);
  // On a stage the roll is not heard, only the climb-out over the set on 09, about a minute after it starts.
  const stage = at('stage');
  assert.equal(stage.map((e) => e.runway).join(), '09');
  assert.ok(stage[0].leadS > 50 && stage[0].leadS < 90, `about a minute, got ${stage[0].leadS}`);
  const ns = (len, metresNorth, id = 'X') => [{ airport: id, ends: [{ id: '09', lat: 34 + metresNorth / 111195, lon: lon(-len / 2) }, { id: '27', lat: 34 + metresNorth / 111195, lon: lon(len / 2) }] }];
  assert.deepEqual(at('outdoors', { runways: ns(3000, 50000) }), []); // 50 km away
  assert.deepEqual(at('outdoors', { runways: ns(800, 3000) }), []); // a light aircraft's strip 3 km off, climbing away either way
  // A 2 km runway 3 km off: an airliner's takeoff is heard outdoors, not on a stage, nor above a higher warning level or a trim down.
  const side = ns(2000, 3000);
  assert.equal(at('outdoors', { runways: side })[0]?.category, 'A3');
  assert.deepEqual(at('stage', { runways: side }), []);
  assert.deepEqual(at('outdoors', { runways: side, floor: 60 }), []);
  assert.deepEqual(at('outdoors', { runways: side, trim: { A1: -15, A2: -15, A3: -15 } }), []);
  // Tuning that makes heavies quieter here does not hide an airliner's takeoff from the same runway.
  const big = ns(3000, 3000);
  assert.equal(at('outdoors', { runways: big })[0]?.category, 'A5');
  assert.equal(at('outdoors', { runways: big, trim: { A5: -20 } })[0]?.category, 'A3');
});

test('a lightweight stage gives less protection than a purpose-built stage', () => {
  const at = (env, ac = inbound) => run(ac, env, { floor: -Infinity });
  assert.deepEqual(ENVIRONMENTS.warehouse, { loss: 25, floor: 30 });
  assert.equal(at('warehouse').peakDb, at('indoors').peakDb);
  assert.ok(Math.abs(at('warehouse').peakDb - at('stage').peakDb - 20) < 1e-9);
  assert.ok(run(inbound, 'warehouse'), 'the lightweight roof must not hide this pass');
  const heli = { hex: 'def456', category: 'A7', lat: 34, lon: -118, alt_baro: 800, gs: 0 };
  assert.ok(Math.abs(at('outdoors', heli).peakDb - at('warehouse', heli).peakDb - 20) < 1e-9);
});

test('the loudness scale stays near the one the recorded reference passes were matched on', () => {
  // Peaks the earlier single-formula model gave (outdoors, nothing else): see ANCHOR_DB in predict.js.
  const site = { lat: 34, lon: -118, elevM: 0 };
  const north = (m) => 34 + m / 111195;
  const peak = (ac) => Math.max(...predict(ac, site, { loss: 0, floor: -Infinity }).path.map((p) => p.db));
  const overhead = peak({ hex: 'a', t: 'E75L', category: 'A3', lat: north(-20000), lon: -118, alt_baro: 3000, gs: 250, track: 0, seen_pos: 0 });
  const abeam = peak({ hex: 'b', t: 'E75L', category: 'A3', lat: north(-6000), lon: -118 + 380 / 92185, alt_baro: 300, gs: 140, track: 0, baro_rate: -700, seen_pos: 0 });
  assert.ok(overhead > 67.24 - 3 && overhead < 67.24 + 1, `overhead: ${overhead}, was 67.24`);
  assert.ok(abeam > 68.25 && abeam < 68.25 + 6, `low and to the side: ${abeam}, was 68.25`);
});
