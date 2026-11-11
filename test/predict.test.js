import test from 'node:test';
import assert from 'node:assert/strict';
import { ENVIRONMENTS, predict, ifDeparts, unseen } from '../public/predict.js';

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

test('an aircraft at runway level that still reports itself as flying is treated as rolling', () => {
  const fast = { hex: 'ccc333', category: 'A3', lat: 34, lon: lon(-4000), alt_baro: 25, gs: 100, track: 90, baro_rate: 0 };
  assert.equal(run(fast, 'outdoors', { runways }).phase, 'taking off from');
  assert.equal(run(fast, 'outdoors', { runways, landed: true }), null); // slowing down after landing
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
  const at = (env, extra) => unseen(site, { ...ENVIRONMENTS[env], runways, ...extra });
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
  assert.deepEqual(at('outdoors', { runways: ns(800, 2000) }), []); // a light aircraft's strip 2 km off, climbing away either way
  // A 2 km runway 3 km off: an airliner's takeoff is heard outdoors, not on a stage, nor above a higher warning level or a trim down.
  const side = ns(2000, 3000);
  assert.equal(at('outdoors', { runways: side })[0]?.category, 'A3');
  assert.deepEqual(at('stage', { runways: side }), []);
  assert.deepEqual(at('outdoors', { runways: side, floor: 50 }), []);
  assert.deepEqual(at('outdoors', { runways: side, trim: { A3: -5 } }), []);
  // Tuning that makes heavies quieter here does not hide an airliner's takeoff from the same runway.
  const big = ns(3000, 3000);
  assert.equal(at('outdoors', { runways: big })[0]?.category, 'A5');
  assert.equal(at('outdoors', { runways: big, trim: { A5: -12 } })[0]?.category, 'A3');
});
