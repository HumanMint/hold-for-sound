import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse, link, matches } from '../public/crew.js';
import { ENVIRONMENTS } from '../public/predict.js';
const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const [, min, max] = html.match(/name="floor" min="(\d+)" max="(\d+)"/).map(Number);
const hash = '#set=33.938,-118.440&env=indoors&level=35';
test('crew fragment validates every field against page settings', () => {
  assert.deepEqual(parse(hash, min, max), { lat: 33.938, lon: -118.44, env: 'indoors', level: 35 });
  for (const env of Object.keys(ENVIRONMENTS)) for (const level of [min, max]) assert.ok(parse(`#set=-90,180&env=${env}&level=${level}`, min, max));
  for (const set of ['', ',', '1', '1,2,3', 'Infinity,2', 'NaN,2', '91,0', '0,-181', '0x10,2']) assert.equal(parse(`#set=${set}&env=indoors&level=35`, min, max), null);
  for (const level of ['', 'Infinity', 'NaN', '14', '66']) assert.equal(parse(hash.replace('level=35', `level=${level}`), min, max), null);
  for (const bad of ['', hash.replace('indoors', 'toString'), hash.replace('&env=indoors', ''), hash + '&env=stage', hash + '&other=1']) assert.equal(parse(bad, min, max), null);
});
test('links discard access queries and old fragments and retain the shared rounded place', () => {
  for (const lat of [33.938, 33.93849, 33.93851, -33.93849, -33.93851]) {
    const url = new URL(link('https://example.invalid/watch/?key=secret&other=1#old', { lat, lon: -118.44 }, 'indoors', 35));
    assert.equal(url.search, '');
    assert.equal(url.pathname, '/watch/');
    const crew = parse(url.hash, min, max);
    assert.equal(crew.lat.toFixed(3), lat.toFixed(3));
    assert.ok(matches(crew, { lat, lon: -118.44 }, 'indoors', '35'));
    assert.equal(matches(crew, { lat, lon: -118.44 }, 'stage', 35), false);
    assert.equal(matches(crew, null, 'indoors', 35), false);
    assert.equal(matches(crew, { lat, lon: -118.44 }, 'indoors', 36), false);
  }
});
