import test from 'node:test';
import assert from 'node:assert/strict';
import { details } from '../public/details.js';

const NOW = 1_800_000_000_000;
const path = [{ t: 0, x: 3000, y: 3000 }]; // 4.2 km north-east of the set
const win = { hex: 'a1', flight: 'SWA598', t: 'B737', desc: 'BOEING 737-700', category: 'A3', start: NOW + 30_000, end: NOW + 75_000, peakDb: 61.6, peakDistM: 1234, peakAltFt: 1460, path };
const row = { hex: 'a1', flight: 'SWA598  ', r: 'N123SW', t: 'B737', category: 'A3', alt_baro: 2475, gs: 216.3, baro_rate: 1856, squawk: '4521', ownOp: 'Southwest Airlines', year: '2004' };
const as = (pairs) => Object.fromEntries(pairs);

test('a full row: every field with its unit', () => {
  const got = as(details({ ...win, phase: 'taking off from', runway: '25R', airport: 'KLAX' }, row, NOW));
  assert.equal(got.Runway, 'Taking off from 25R at KLAX');
  assert.equal(got['From set'], '4.2\u00a0km\u00a0NE');
  assert.match(got.Audible, /^\d\d:\d\d:\d\d to \d\d:\d\d:\d\d, 0:45$/);
  assert.equal(got['Est. peak'], '62 dBA at the mic');
  assert.equal(got['At peak'], '1.2 km away, 1,500 ft up');
  assert.equal(got.Altitude, '2,475 ft');
  assert.equal(got['Ground speed'], '216 kt');
  assert.equal(got['Vertical rate'], 'Climbing 1,856 ft/min');
  assert.equal(got.Squawk, '4521');
  assert.equal(got.Callsign, undefined); // the row's heading already
  assert.equal(got.Registration, 'N123SW');
  assert.equal(got.Type, 'B737, BOEING 737-700');
  assert.equal(got.Operator, 'Southwest Airlines');
  assert.equal(got.Built, '2004');
  assert.equal(got.Engine, 'Jet');
  assert.equal(got.Class, 'Large jet');
  assert.equal(got['Contact lost'], undefined);
});

test('what the feed did not send is left out, never shown empty or undefined', () => {
  const got = details({ hex: 'b2', category: 'A1', start: NOW, end: NOW + 20_000, peakDb: 50, path }, { hex: 'b2', alt_baro: 900, baro_rate: -40 }, NOW);
  assert.deepEqual(got.map(([k]) => k), ['From set', 'Audible', 'Est. peak', 'Altitude', 'Vertical rate', 'Engine', 'Class']);
  assert.equal(as(got)['Vertical rate'], 'Level');
  assert.equal(as(got).Engine, 'Unknown'); // a light category does not say propeller or jet
  for (const [k, v] of got) assert.ok(v && !/undefined|null|NaN/.test(v), `${k}: ${v}`);
  // No feed row at all, and nothing to go on for the engine.
  const bare = details({ hex: 'c3', start: NOW, end: NOW + 1000, peakDb: 40, path: [] }, {}, NOW);
  assert.deepEqual(bare.map(([k]) => k), ['Audible', 'Est. peak', 'Engine']);
  assert.equal(as(bare).Engine, 'Unknown');
});

test('an estimate says when contact was lost, and the feed values are the last ones', () => {
  const got = as(details({ ...win, lost: true, seenAt: NOW - 45_000 }, { ...row, alt_baro: 'ground' }, NOW));
  assert.equal(got['Contact lost'], '0:45 ago');
  assert.equal(got['Last altitude'], 'On the ground');
  assert.equal(got['Last ground speed'], '216 kt');
  assert.equal(got.Altitude, undefined);
});

test('lost too long ago: no time, place or loudness, only what is known of the aircraft', () => {
  const got = details({ ...win, phase: 'landing on', runway: '27', airport: 'TEST', unsure: true, path: [], seenAt: NOW - 130_000 }, row, NOW);
  assert.deepEqual(got.slice(0, 2), [['Contact lost', '2:10 ago'], ['Last altitude', '2,475 ft']]);
  assert.ok(!got.some(([k]) => ['Audible', 'Est. peak', 'At peak', 'From set', 'Runway'].includes(k)));
});

test('taxiing: the likely runway and how long a takeoff would be heard', () => {
  const got = as(details({ ...win, start: undefined, end: undefined, startS: 20, endS: 100, phase: 'lined up on', runway: '25R', airport: 'KLAX' }, { ...row, alt_baro: 'ground', gs: 12 }, NOW));
  assert.equal(got.Runway, 'Likely 25R at KLAX');
  assert.equal(got.Audible, 'About 1:20 if it takes off');
  assert.equal(got['From set'], undefined);
  assert.equal(got.Altitude, 'On the ground');
  assert.equal(got['Vertical rate'], undefined);
});

test('a helicopter is not called one twice', () => {
  const got = as(details({ ...win, t: 'R44', category: 'A7' }, { ...row, t: 'R44', category: 'A7' }, NOW));
  assert.equal(got.Engine, 'Helicopter');
  assert.equal(got.Class, undefined);
});
