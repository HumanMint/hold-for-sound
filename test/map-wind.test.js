import test from 'node:test';
import assert from 'node:assert/strict';
import { windAngle, windSpeed, calmWind, windReadout } from '../public/map-wind.js';
import { freshWeather } from '../public/weather.js';

test('wind arrows point downwind on a north-up map, including wrapped bearings', () => {
  for (const [from, to] of [[0, 180], [90, 270], [180, 0], [270, 90], [360, 180], [-90, 90], [45, 225]]) {
    assert.equal(windAngle(from), to);
  }
});
test('wind conversion, compass labels, stable tag and unit labels', () => {
  assert.ok(Math.abs(windSpeed(1) - 2.236936) < 0.000001);
  assert.ok(Math.abs(windSpeed(1, 'knots') - 1.943844) < 0.000001);
  const w = { wind_speed_10m: 3, wind_direction_10m: 270 };
  assert.equal(windReadout(w).text, 'W 7 mph');
  assert.equal(windReadout(w, 'knots').text, 'W 6 knots');
  assert.match(windReadout(w).label, /Wind from west, 7 mph/);
  assert.equal(windReadout(w).tag, '');
  assert.equal(windReadout({ ...w, temperature_2m: 10, temperature_80m: 12 }).tag, 'Stable air');
  assert.equal(windReadout({ ...w, wind_direction_10m: 359 }).text, 'N 7 mph');
});
test('calm cutoff suppresses arrow; missing or invalid wind never invents a value', () => {
  assert.equal(calmWind(0.4999), true);
  assert.equal(calmWind(0.5), false);
  for (const speed of [0, 0.49]) {
    const value = windReadout({ wind_speed_10m: speed });
    assert.equal(value.text, 'Calm');
    assert.equal(value.angle, null);
  }
  assert.equal(windReadout({ wind_speed_10m: 0.5, wind_direction_10m: 0 }).angle, 180);
  for (const w of [null, {}, { wind_speed_10m: -1 }, { wind_speed_10m: NaN }, { wind_speed_10m: Infinity }, { wind_speed_10m: 2 }, { wind_speed_10m: 2, wind_direction_10m: NaN }]) {
    assert.equal(windReadout(w), null);
  }
});
test('prediction weather is fresh through one hour, never from a future or missing timestamp', () => {
  const now = 1800000000000;
  const w = { at: now };
  assert.equal(freshWeather(w, now), w);
  assert.equal(freshWeather(w, now + 3600000), w);
  assert.equal(freshWeather(w, now + 3600001), null);
  assert.equal(freshWeather(w, now - 1), null);
  for (const missing of [null, undefined, {}, { at: NaN }, { at: Infinity }, { at: '1800000000000' }]) assert.equal(freshWeather(missing, now), null);
  assert.equal(freshWeather(w, NaN), null);
});
