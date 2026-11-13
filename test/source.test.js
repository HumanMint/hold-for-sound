import test from 'node:test';
import assert from 'node:assert/strict';
import { source, phase, angle } from '../public/source.js';
import { predict } from '../public/predict.js';

const ac = { t: 'E75L', category: 'A3' };
const p = { x: 0, y: -1000, alt: 0, vx: 0, vy: 100, vz: 0, phase: 'takeoff' };
const atAngle = (deg) => ({ ...p, x: 1000 * Math.sin(deg * Math.PI / 180), y: -1000 * Math.cos(deg * Math.PI / 180) });

test('jet power lobe peaks behind at 130 degrees, without reducing ahead estimates', () => {
  assert.equal(angle(p), 0);
  assert.equal(angle(atAngle(180)), 180);
  assert.equal(source(ac, p), 86);
  assert.equal(source(ac, atAngle(130)), 90);
  assert.ok(source(ac, atAngle(180)) < source(ac, atAngle(130)));
  assert.ok(source(ac, atAngle(180)) > source(ac, p));
  assert.equal(source(ac, { ...p, vx: 0, vy: 0 }), 90);
  assert.equal(angle({ ...p, directionKnown: false }), null);
  assert.equal(angle({ ...p, y: 0, alt: 1000, vy: 0, vz: 10 }), 180);
});

test('type offsets, engine fallback and category fallback keep larger references', () => {
  assert.equal(source({ t: 'MD88', category: 'A3' }, p), source(ac, p) + 4);
  assert.equal(source({ t: 'E55P', category: 'A2' }, p), 90);
  assert.equal(source({ t: 'E55P', category: 'A2' }, { ...p, phase: 'approach' }), 72);
  assert.equal(source({ t: 'SF50', category: 'A1' }, p), 82);
  assert.equal(source({ t: 'ZZZZ', category: 'A5' }, p), 92);
  assert.equal(source({}, p), 82);
  assert.equal(source({ t: 'C172' }, { ...p, phase: 'cruise' }), 68);
});

test('power follows point phase, feed vertical rate, height, speed and level-off', () => {
  const point = { ...p, phase: undefined, alt: 200, speed: 100, vz: 5 };
  assert.equal(phase(ac, point), 'takeoff');
  assert.equal(phase(ac, { ...point, alt: 1000 }), 'climb');
  assert.equal(phase(ac, { ...point, speed: 150 }), 'climb');
  assert.equal(phase(ac, { ...point, vz: 0 }), 'cruise');
  assert.equal(phase({ baro_rate: -700 }, { ...point, vz: undefined }), 'descent');
  assert.equal(source(ac, { ...p, phase: 'cutback' }), 84);
  assert.equal(source(ac, { ...p, phase: 'approach' }), 76);
  assert.equal(source(ac, { ...p, phase: 'rollout', boost: -10 }), 70);
});

test('propellers peak broadside; helicopters are louder descending without quieting cruise', () => {
  const prop = { t: 'C172', category: 'A1' };
  assert.equal(source(prop, atAngle(90)) - source(prop, p), 3);
  const heli = { t: 'B407', category: 'A7' };
  assert.equal(source(heli, { ...p, phase: 'cruise' }), 78);
  assert.equal(source(heli, { ...p, phase: 'descent' }), 82);
});

test('trim remains an additive per-category correction at every path point', () => {
  for (const state of ['takeoff', 'cutback', 'approach', 'rollout', 'cruise']) {
    const point = { ...p, phase: state };
    assert.equal(source(ac, point, { A3: -7 }), source(ac, point) - 7);
    assert.equal(source(ac, point, { A2: 9 }), source(ac, point));
  }
  const row = { ...ac, lat: 34, lon: -118, alt_baro: 2000, gs: 180, track: 90, baro_rate: 1000, nav_altitude_mcp: 2500 };
  const site = { lat: 34, lon: -118, elevM: 0 };
  const plain = predict(row, site, { loss: 0, floor: -Infinity });
  const tuned = predict(row, site, { loss: 0, floor: -Infinity, trim: { A3: 3 } });
  for (const [i, point] of plain.path.entries()) {
    assert.ok(Math.abs(tuned.path[i].db - point.db - 3) < 1e-10);
    for (const key of ['x', 'y', 'alt', 'dist', 'heardAt']) assert.equal(tuned.path[i][key], point[key]);
  }
});
