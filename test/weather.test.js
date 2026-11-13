import test from 'node:test';
import assert from 'node:assert/strict';
import { stability, weatherLevel } from '../public/weather.js';
import { weatherCache } from '../weather.js';
import { predict } from '../public/predict.js';
const now = 1794500000000;
const w = { at: now, wind_speed_10m: 5, wind_speed_80m: 8, wind_direction_10m: 0, temperature_2m: 20, temperature_80m: 19.5, is_day: 1, cloud_cover: 50 };
const point = { bearing: 180, elevation: 3, distance: 5000, altitude: 260 };
test('stability and low-angle wind sign, conservative shadow and ground exclusion', () => {
  assert.equal(stability(w), 'D');
  assert.equal(weatherLevel(w, point, now), -3);
  assert.equal(weatherLevel(w, { ...point, bearing: 0 }, now), 0);
  assert.equal(weatherLevel({ ...w, temperature_80m: 22 }, { ...point, bearing: 0 }, now), 5);
  assert.equal(weatherLevel({ ...w, temperature_80m: 18 }, point, now), -3);
  for (const weather of [null, { ...w, at: now - 3600001 }, { ...w, at: now + 1 }]) assert.equal(weatherLevel(weather, point, now), 0);
  assert.equal(weatherLevel(w, { ...point, elevation: 15 }, now), 0);
  assert.equal(weatherLevel(w, { ...point, altitude: 0, distance: 500 }, now), 0);
  assert.equal(weatherLevel(w, { ...point, altitude: 50, distance: 2500 }, now), 0);
  assert.equal(weatherLevel({ at: now }, point, now), 0);
  assert.equal(weatherLevel(w, { ...point, bearing: NaN }, now), 0);
});
test('prediction without weather is identical; low-angle weather reaches path levels', () => {
  const ac = { hex: 'abc123', lat: 0.045, lon: 0, alt_baro: 1000, gs: 150, track: 90, category: 'A3' };
  const site = { lat: 0, lon: 0, elevM: 0 };
  const opts = { loss: 0, floor: -Infinity };
  const base = predict(ac, site, opts);
  assert.deepEqual(predict(ac, site, { ...opts, weather: null, weatherAt: now }), base);
  const shadow = predict(ac, site, { ...opts, weather: { ...w, wind_direction_10m: 180 }, weatherAt: now });
  assert.ok(shadow.path.some((p, i) => p.db < base.path[i].db));
  assert.ok(shadow.path.every((p, i) => p.db >= base.path[i].db - 3.000001));
});
test('weather cache coalesces rounded places, expires hourly and caches failure', async () => {
  let time = now, calls = 0, fail = false, task;
  const cache = weatherCache(job => (task = Promise.resolve().then(job)), async url => {
    calls++;
    const u = new URL(url);
    assert.equal(u.searchParams.get('latitude'), '12.346');
    assert.equal(u.searchParams.get('longitude'), '-65.432');
    if (fail) throw Error('offline');
    return { hourly: { time: [Math.floor(time / 1000)], temperature_2m: [20] } };
  }, () => time);
  assert.equal(cache(12.34567, -65.4321), null);
  assert.equal(cache(12.34568, -65.4322), null);
  await task;
  assert.equal(cache(12.34567, -65.4321).temperature_2m, 20);
  assert.equal(calls, 1);
  time += 3600000; fail = true;
  assert.equal(cache(12.34567, -65.4321), null);
  await task.catch(() => {});
  assert.equal(cache(12.34567, -65.4321), null);
  assert.equal(calls, 2);
  // A place nobody asks about again is forgotten an hour after it was last fetched.
  cache.sweep();
  assert.equal(cache.size(), 1);
  time += 3600000;
  cache.sweep();
  assert.equal(cache.size(), 0);
});
test('weather never makes a helicopter quieter: its fanned headings may be far from the line the wind is judged on', () => {
  // 6 km east, heading west at 100 kt and 1000 ft, unsure of its heading; the wind blows from the west,
  // so wherever the straight line puts it east of the set the sound comes upwind.
  const site = { lat: 0, lon: 0, elevM: 0 };
  const ac = { hex: 'heli01', category: 'A7', t: 'B407', lat: 0, lon: 6000 / 111320, alt_baro: 1000, gs: 100, track: 270, seen_pos: 0 };
  const motion = { wander: 3, area: [ac] };
  const opts = { loss: 0, floor: -Infinity, motion };
  const calm = predict(ac, site, opts).path;
  const windy = predict(ac, site, { ...opts, weather: { ...w, wind_direction_10m: 270 }, weatherAt: now }).path;
  assert.ok(calm.some((p, i) => p.dist > 3000 && windy[i].db === calm[i].db), 'a reachable case');
  windy.forEach((p, i) => assert.ok(p.db >= calm[i].db - 1e-9, `${p.t} s: ${p.db} < ${calm[i].db}`));
});
