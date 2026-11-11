import test from 'node:test';
import assert from 'node:assert/strict';
import { cadence as decide, FAST_S, SLOW_S, RUNWAY_S } from '../cadence.js';
import { staleAfter } from '../public/status.js';

const place = { lat: 34, lon: -118 };
const T = 1_800_000_000_000;
const KM_LAT = 1 / 111.195; // degrees of latitude in a km
// An aircraft `km` due south of the place, flying `track` at `gs` kt and `ft` feet.
const south = (km, { ft = 3000, gs = 250, track = 0, ...rest } = {}) => ({ hex: 'abc123', lat: place.lat - km * KM_LAT, lon: place.lon, alt_baro: ft, gs, track, ...rest });
// Unless a test says otherwise, the place has no runway near it.
const cadence = (ac, at, now, was, runways = []) => decide(ac, at, now, was, runways);
const every = (ac, now = T, was, runways) => cadence(ac, place, now, was, runways).every;
// A 3 km runway running east from `km` km due south of the place, as runwaysNear() in server.js gives it.
const runwaySouth = (km) => [{ airport: 'TEST', ends: [{ id: '09', lat: place.lat - km * KM_LAT, lon: place.lon }, { id: '27', lat: place.lat - km * KM_LAT, lon: place.lon + 3 / (111.195 * Math.cos(place.lat * Math.PI / 180)) }] }];

test('an empty sky, or one with only far or high aircraft going elsewhere, is asked about once a minute', () => {
  assert.equal(every([]), SLOW_S);
  assert.equal(every([south(50, { track: 180 })]), SLOW_S, 'flying away, 50 km out');
  assert.equal(every([south(5, { ft: 37000, gs: 480, track: 90 })]), SLOW_S, 'cruising past, 11 km up');
  assert.equal(every([{ hex: 'nopos', alt_baro: 2000, gs: 200 }]), SLOW_S, 'no position: the page cannot place it either');
});

test('anything that could be overhead before a quiet answer runs out, or will pass within 15 minutes, is asked about every 10 s', () => {
  assert.equal(every([south(15, { track: 180 })]), FAST_S, 'low and 15 km out: it could turn back within 80 s');
  assert.equal(every([south(25, { track: 180, gs: 120 })]), SLOW_S, 'slow and 25 km out, going away');
  assert.equal(every([south(50)]), FAST_S, 'inbound 50 km out at 250 kt: overhead in about 6.5 minutes');
  assert.equal(every([south(50, { gs: 80 })]), SLOW_S, 'inbound 50 km out at 80 kt: more than 15 minutes away');
  assert.equal(every([south(2, { ft: 1200, gs: 0, category: 'A7' })]), FAST_S, 'a hovering helicopter nearby');
});

test('a taxi near the place keeps it at 10 s for 10 minutes, so an aircraft held short or lined up still counts', () => {
  const taxi = south(3, { alt_baro: 'ground', gs: 12 });
  const first = cadence([taxi], place, T);
  assert.deepEqual(first, { every: FAST_S, taxiedAt: T, ground: ['abc123'] });
  const stopped = { ...taxi, gs: 0 };
  const held = cadence([stopped], place, T + 9 * 60_000, first);
  assert.deepEqual(held, { every: FAST_S, taxiedAt: T, ground: ['abc123'] });
  assert.equal(every([stopped], T + 11 * 60_000, held), SLOW_S, 'parked at the gate all night');
  assert.equal(every([south(20, { alt_baro: 'ground', gs: 20 })]), SLOW_S, 'taxiing at an airport 20 km away');
});

test('an aircraft first seen stopped on the ground nearby counts as a taxi: it may be lined up', () => {
  const parked = south(3, { hex: 'aaa111', alt_baro: 'ground', gs: 0 });
  const night = cadence([parked], place, T - 20 * 60_000, cadence([parked], place, T - 30 * 60_000));
  assert.equal(night.every, SLOW_S);
  const lined = south(2.5, { hex: 'bbb222', alt_baro: 'ground', gs: 0 });
  const seen = cadence([parked, lined], place, T, night);
  assert.deepEqual([seen.every, seen.taxiedAt], [FAST_S, T]);
});

test('a quiet sky beside a runway is asked about every 30 s, and trusted for 40 s', () => {
  // A takeoff the feed did not see on the ground can be heard 6 to 15 s into its roll.
  assert.equal(every([], T, undefined, runwaySouth(2)), RUNWAY_S, 'a runway 2 km away');
  assert.equal(every([], T, undefined, runwaySouth(4.9)), RUNWAY_S);
  assert.equal(every([], T, undefined, runwaySouth(6)), SLOW_S, 'the nearest runway 6 km away');
  assert.equal(every([], T, undefined, []), SLOW_S, 'no runway in reach');
  assert.equal(every([], T, undefined, null), RUNWAY_S, 'runways not known yet: as if beside one');
  assert.equal(staleAfter(RUNWAY_S), 40_000);
  // Beside the middle of a long runway whose ends are both further than 5 km off.
  const long = [{ airport: 'TEST', ends: [{ id: '09', lat: place.lat - KM_LAT, lon: place.lon - 6 / 92.2 }, { id: '27', lat: place.lat - KM_LAT, lon: place.lon + 6 / 92.2 }] }];
  assert.equal(every([], T, undefined, long), RUNWAY_S, 'measured to the runway, not to its ends');
  // What is busy elsewhere is busy here too.
  assert.equal(every([south(50)], T, undefined, runwaySouth(2)), FAST_S);
});
