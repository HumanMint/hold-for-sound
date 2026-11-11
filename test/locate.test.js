import test from 'node:test';
import assert from 'node:assert/strict';
import { locate, blocked, failed, ROUGH_M, SAME_M, WAIT_MS } from '../public/locate.js';
import { siteKey } from '../public/listen-view.js';

// Beside LAX, where the recording in test/fixtures was made.
const LAT = 33.93842;
const LON = -118.43927;
const M = 1 / 111_195; // one metre north, in degrees
const reading = (north = 0, accuracy = 10) => ({ latitude: LAT + north * M, longitude: LON, accuracy });
// The server's side of it, as lookUp() in server.js reads typed coordinates.
const TYPED = /^(-?\d+(?:\.\d+)?)\s*[,\s]\s*(-?\d+(?:\.\d+)?)$/;
const watched = (q) => {
  const [, lat, lon] = q.match(TYPED);
  return { lat: +lat, lon: +lon };
};

test('a good reading becomes coordinates the server takes as typed, to 4 decimals', () => {
  const { q, say } = locate(reading(), null);
  assert.equal(q, '33.9384, -118.4393');
  assert.equal(say, undefined);
  assert.match(q, TYPED, 'so it never goes to the public address lookup');
  assert.equal(locate({ latitude: -0.00001, longitude: 7, accuracy: 5 }, null).q, '-0.0000, 7.0000', 'always 4 decimals, never an exponent');
  assert.match(locate({ latitude: -0.00001, longitude: 179.99999, accuracy: 5 }, null).q, TYPED);
});

test('pressing again at the same set keeps the set, and so what was learned there', () => {
  const site = watched(locate(reading(), null).q);
  // A phone wandering by tens of metres, and one between buildings that is further out than it says.
  for (const [north, accuracy] of [[0, 10], [12, 10], [-30, 15], [45, 5], [-49, 5]]) {
    const again = locate(reading(north, accuracy), site);
    assert.equal(again.q, undefined, `${north} m away, good to ${accuracy} m`);
    assert.match(again.say, /^Same set: /);
  }
  // What was learned is filed under the set's coordinates, so keeping the set is what keeps it. Had
  // those readings been used, most would have been another set to the microphone's store.
  assert.notEqual(siteKey(watched(locate(reading(45, 5), null).q), 'outdoors'), siteKey(site, 'outdoors'));
});

test('how near counts as the same set grows with what the reading claims', () => {
  const site = { lat: LAT, lon: LON };
  assert.ok(locate(reading(SAME_M - 2, 5), site).say, 'inside the least radius, however sure the reading');
  assert.ok(locate(reading(SAME_M + 10, 5), site).q, 'a sure reading 60 m away is another spot');
  assert.ok(locate(reading(120, 65), site).say, 'two Wi-Fi readings good to 65 m can be 130 m apart');
  assert.ok(locate(reading(140, 65), site).q);
  assert.ok(locate(reading(2 * ROUGH_M + 10, ROUGH_M), site).q, 'never more than twice the worst reading used');
  // East and west count as far as north and south, at this latitude.
  const east = (m, accuracy) => ({ latitude: LAT, longitude: LON + (m * M) / Math.cos((LAT * Math.PI) / 180), accuracy });
  assert.ok(locate(east(45, 5), site).say);
  assert.ok(locate(east(60, 5), site).q);
});

test('the same-set message gives the distance, rounded, and never "0 m"', () => {
  const site = { lat: LAT, lon: LON };
  assert.equal(locate(reading(0, 5), site).say, 'Same set: about 10\u00a0m from the spot being watched. To move it, type the address.');
  assert.match(locate(reading(34, 5), site).say, /about 30\u00a0m from/);
  assert.match(locate(reading(160, 90), site).say, /about 160\u00a0m from/);
});

test('a move to another set is used, and is another set', () => {
  const site = { lat: LAT, lon: LON };
  const moved = locate(reading(800, 10), site);
  assert.equal(moved.q, '33.9456, -118.4393');
  assert.notEqual(siteKey(watched(moved.q), 'outdoors'), siteKey(site, 'outdoors'));
});

test('a rough reading is refused, with how rough and what to do instead', () => {
  assert.ok(locate(reading(0, ROUGH_M), null).q, 'the limit itself is good enough');
  const wifi = locate(reading(0, 400), null);
  assert.equal(wifi.q, undefined);
  assert.equal(wifi.say, 'Location only good to about 400\u00a0m: too rough. Try again outdoors, or type the address.');
  assert.match(locate(reading(0, 1432), null).say, /good to about 1\.4\u00a0km/);
  assert.match(locate(reading(0, 25_000), null).say, /good to about 25\u00a0km/);
  assert.match(locate(reading(0, 975), null).say, /good to about 1\u00a0km/);
  // Rough is refused before anything else: it neither moves a set nor claims to be at it.
  assert.match(locate(reading(0, 400), { lat: LAT, lon: LON }).say, /too rough/);
  assert.match(locate(reading(5000, 400), { lat: LAT, lon: LON }).say, /too rough/);
});

test('each reason there is no reading says what it is and what to do', () => {
  const TYPE = /(Instead,|, or) type the address\.$/;
  assert.equal(blocked(true, true), '');
  assert.match(blocked(false, true), /^Location needs https\. Instead, /);
  assert.equal(blocked(false, false), blocked(false, true), 'a plain address is the reason, even where the browser has no location either');
  assert.match(blocked(true, false), /^This browser can't share its location\. Instead, /);
  assert.match(failed(1), /^Location is blocked\. Allow it for this site in settings and press again, or /);
  assert.match(failed(2), /^Location unavailable\. Try again outdoors, or /);
  assert.match(failed(3), new RegExp(`^No location after ${WAIT_MS / 1000} seconds\\. Try again outdoors, or `));
  assert.equal(failed(undefined), failed(2), 'an error with no code is no position');
  for (const say of [blocked(false, true), blocked(true, false), failed(1), failed(2), failed(3)]) assert.match(say, TYPE, 'the address field always works');
  assert.equal(new Set([blocked(false, true), blocked(true, false), failed(1), failed(2), failed(3)]).size, 5, 'no two reasons read the same');
});

test('how far apart two readings are does not depend on where on Earth the set is', () => {
  // Either side of the date line, 22 m apart: the same set, not one a world away.
  assert.match(locate({ latitude: 0, longitude: -179.9999, accuracy: 10 }, { lat: 0, lon: 179.9999 }).say, /^Same set: /);
  // Beside the pole, opposite longitudes 44 m apart.
  assert.match(locate({ latitude: 89.9998, longitude: -90, accuracy: 10 }, { lat: 89.9998, lon: 90 }).say, /^Same set: /);
  // And far apart is still far apart there.
  assert.ok(locate({ latitude: 0, longitude: -179.99, accuracy: 10 }, { lat: 0, lon: 179.99 }).q);
});
