import test from 'node:test';
import assert from 'node:assert/strict';
import { ENVIRONMENTS, predict } from '../public/predict.js';
import { metresPerPixel, zoomFor, tiles, toScreen, sample, heard, edge, hit, place, labelSides, ringStep, compass, easeOut, morph } from '../public/map-geo.js';

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} expected ${b} ± ${tol}, got ${a}`);

test('scale matches Web Mercator: the equator is 40,075 km round', () => {
  near(metresPerPixel(0, 0) * 256, 40075017, 10);
  near(metresPerPixel(60, 10), metresPerPixel(0, 10) / 2, 0.01);
});

test('zoom is the closest one that still shows the wanted radius', () => {
  const lat = 33.938;
  for (const [w, h] of [[320, 272], [390, 293], [900, 675], [1600, 900]]) {
    const z = zoomFor(lat, w, h, 12000);
    assert.ok((Math.min(w, h) / 2) * metresPerPixel(lat, z) >= 12000, `${w}x${h} shows 12 km`);
    assert.ok((Math.min(w, h) / 2) * metresPerPixel(lat, z + 1) < 12000, `${w}x${h} is not zoomed out further than needed`);
  }
});

test('tiles cover the box, with the set at its centre', () => {
  // 0°N 0°E is the corner shared by the four middle tiles of zoom 1.
  const four = tiles({ lat: 0, lon: 0 }, 1, 200, 100);
  assert.deepEqual(four.map((t) => [t.z, t.x, t.y, t.left, t.top]), [[1, 0, 0, -156, -206], [1, 1, 0, 100, -206], [1, 0, 1, -156, 50], [1, 1, 1, 100, 50]]);

  // Santa Monica Bay at zoom 11 is tile 350/818 (checked against the slippy-map formula by hand).
  const site = { lat: 33.938, lon: -118.44 };
  const got = tiles(site, 11, 390, 293);
  const home = got.find((t) => t.left <= 195 && t.left + 256 > 195 && t.top <= 146.5 && t.top + 256 > 146.5);
  assert.deepEqual([home.x, home.y], [350, 818]);
  const left = Math.min(...got.map((t) => t.left));
  const top = Math.min(...got.map((t) => t.top));
  assert.ok(left <= 0 && top <= 0 && Math.max(...got.map((t) => t.left)) + 256 >= 390 && Math.max(...got.map((t) => t.top)) + 256 >= 293);
  assert.ok(got.length <= 9, 'no tiles that are out of view');

  // High-density screens: the next zoom's tiles at half size, over the same ground.
  const sharp = tiles(site, 11, 390, 293, 1);
  assert.ok(sharp.every((t) => t.z === 12 && t.size === 128));
  near(Math.min(...sharp.map((t) => t.left)), left, 128);
});

test('tiles wrap around the date line and stop at the poles', () => {
  const got = tiles({ lat: 80, lon: 179.9 }, 2, 600, 600);
  assert.ok(got.every((t) => t.x >= 0 && t.x < 4 && t.y >= 0 && t.y < 4));
  assert.ok(got.some((t) => t.x === 0) && got.some((t) => t.x === 3));
});

test('north is up and the set is in the middle', () => {
  const view = { w: 400, h: 300, mpp: 50 };
  assert.deepEqual(toScreen(view, { x: 0, y: 0 }), { x: 200, y: 150 });
  assert.deepEqual(toScreen(view, { x: 1000, y: 2000 }), { x: 220, y: 110 });
});

const site = { lat: 34, lon: -118, elevM: 0 };
// An airliner 10 nm due south at 3000 ft, flying north at 250 kt: overhead in about 144 s.
const inbound = { hex: 'abc123', category: 'A3', lat: 34 - 10 / 60, lon: -118, alt_baro: 3000, gs: 250, track: 0 };
const { path } = predict(inbound, site, { ...ENVIRONMENTS.outdoors, floor: -Infinity });

test('an aircraft moves along its path between samples', () => {
  const a = sample(path, 't', 0);
  const b = sample(path, 't', 5);
  near(b.y - a.y, 250 * 0.5144 * 5, 1, 'five seconds of flight');
  near(a.heading, 0, 1e-9, 'heading north');
  assert.equal(a.off, false);
  near(sample(path, 't', 3).y, (sample(path, 't', 2).y + sample(path, 't', 4).y) / 2, 1e-6);
});

test('an aircraft waits at the end of its path', () => {
  assert.equal(sample(path, 't', 9999).off, true);
  assert.equal(sample(path, 't', 9999).y, path.at(-1).y);
  assert.equal(sample(path, 't', -9999).y, path[0].y);
  const hover = [{ t: 0, heardAt: 1, x: 5, y: 5, alt: 200, dist: 200, db: 60 }];
  assert.equal(sample(hover, 't', 3).x, 5);
  assert.equal(sample(hover, 't', 3).heading, undefined);
});

test('the sound heard now was made further back along the path', () => {
  // 100 s in, the aircraft is 5.7 km south, closing at 3/8 the speed of sound: what is heard is 26 s old.
  const now = sample(path, 't', 100);
  const source = sample(path, 'heardAt', 100);
  near(source.heardAt, 100, 1e-9);
  near(source.t + source.dist / 343, 100, 0.01, 'left the aircraft, then crossed the distance');
  near(100 - source.t, 26.5, 1, 'age of the sound');
  near(now.y - source.y, (100 - source.t) * 250 * 0.5144, 1, 'that far behind the aircraft');
  // 10 nm away the sound is 54 s old, further back than the path reaches: nothing to mark.
  assert.equal(sample(path, 'heardAt', 0).off, true);
});

test('the heard stretch matches the predicted window', () => {
  const floor = ENVIRONMENTS.outdoors.floor;
  const w = predict(inbound, site, ENVIRONMENTS.outdoors);
  const runs = heard(path, floor, 0);
  assert.equal(runs.length, 1);
  const run = runs[0];
  near(run[0].db, floor, 1e-9, 'starts where it crosses the floor');
  near(run.at(-1).db, floor, 1e-9, 'ends where it drops below it');
  assert.ok(run.every((p) => p.db >= floor - 1e-9));
  near(run[1].heardAt, w.startS, 0.01, 'first whole sample is the window start');
  near(run.at(-2).heardAt, w.endS, 0.01);
  assert.ok(run[0].y < 0 && run.at(-1).y > 0, 'spans the set, south to north');
});

test('the heard stretch drops what has already been heard', () => {
  const floor = ENVIRONMENTS.outdoors.floor;
  const late = heard(path, floor, 150)[0];
  near(late[0].heardAt, 150, 1e-6, 'starts at the sound arriving now');
  assert.ok(late[0].y > heard(path, floor, 0)[0][0].y);
  assert.deepEqual(heard(path, floor, 9999), []);
  assert.deepEqual(heard(path, 200, 0), [], 'never that loud');
});

test('a path eases into its new shape, matched by time, and lands on it exactly', () => {
  // Heading north, then corrected to north-east and cut short (on final, it ends at touchdown).
  const old = Array.from({ length: 6 }, (_, i) => ({ t: i * 2, x: 0, y: i * 100, db: 60 }));
  const next = Array.from({ length: 3 }, (_, i) => ({ t: i * 2 + 1, x: i * 70, y: i * 70, db: 70 }));
  const ease = morph(old, next, 't');
  const start = ease(0);
  assert.deepEqual(start.slice(0, 3).map((p) => [p.t, p.x, p.y, p.db]), [[1, 0, 50, 60], [3, 0, 150, 60], [5, 0, 250, 60]], 'each new point starts where the old path was at its time');
  assert.deepEqual(start.slice(3).map((p) => [p.t, p.y]), [[6, 300], [8, 400], [10, 500]], 'and the old path runs on past the new end');
  const half = ease(0.5);
  assert.equal(half, start, 'every frame writes into the same points');
  assert.deepEqual(half.slice(3).map((p) => [p.t, p.x, p.y]), [[5.5, 70, 220], [6.5, 70, 270], [7.5, 70, 320]], 'which close in on the new end');
  assert.ok(half.every((p, i) => !i || p.t >= half[i - 1].t), 'in order of time throughout');
  assert.equal(ease(1), next, 'at the end it is the new path itself');

  // Longer than before (a takeoff becomes a climb-out): the new stretch grows out of the old end.
  const grow = morph(next, old, 't')(0);
  assert.equal(grow.length, old.length);
  assert.deepEqual([grow[0].y, grow.at(-1).x, grow.at(-1).y], [0, 140, 140]);
  assert.equal(morph([], next, 't')(0), next, 'nothing to ease from: it appears');
});

test('easing is quick to start and lands gently', () => {
  assert.deepEqual([-1, 0, 0.5, 1, 2].map(easeOut), [0, 0, 0.75, 1, 1]);
});

test('off-screen aircraft are pinned to the edge in their direction', () => {
  assert.deepEqual(edge({ x: 100, y: 80 }, 400, 300, 20), { x: 100, y: 80, off: false });
  assert.deepEqual(edge({ x: 1200, y: 150 }, 400, 300, 20), { x: 380, y: 150, off: true });
  const corner = edge({ x: -1800, y: -1350 }, 400, 300, 20);
  near(corner.x, 20 + (180 - 130 * (4 / 3)), 1e-9); // top edge is reached first on a 4:3 diagonal
  near(corner.y, 20, 1e-9);
});

test('a tap picks the nearest aircraft within reach, and labels count', () => {
  const marks = [
    { hex: 'a', x: 100, y: 100 },
    { hex: 'b', x: 130, y: 100, box: { x: 142, y: 90, w: 80, h: 20 } },
  ];
  assert.equal(hit(marks, 104, 103), 'a');
  assert.equal(hit(marks, 120, 100), 'b');
  assert.equal(hit(marks, 200, 100), 'b', 'on its label');
  assert.equal(hit(marks, 100, 123), null, 'out of reach');
  assert.equal(hit([], 5, 5), null);

  // An aircraft that will be heard, with parked ones around it: a near miss still picks it.
  const apron = [{ hex: 'parked', x: 100, y: 100 }, { hex: 'heard', x: 112, y: 100, loud: true }];
  assert.equal(hit(apron, 104, 100), 'heard', '4 px from the parked one, 8 from the one that matters');
  assert.equal(hit(apron, 100, 100), 'parked', 'but a tap right on the parked one picks it');
  assert.equal(hit(apron, 140, 100), null, 'the head start does not lengthen the reach');
});

test('labels avoid each other, the edges and reserved boxes', () => {
  const label = (hex, x, y, must) => ({ hex, x, y, w: 80, h: 20, must });
  const overlap = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

  const two = place([label('a', 100, 100), label('b', 104, 104)], 400, 300);
  assert.equal(two.get('a').side, 0, 'first choice is to the right');
  assert.ok(!overlap(two.get('a'), two.get('b')));

  const atEdge = place([label('a', 380, 150)], 400, 300);
  assert.equal(atEdge.get('a').side, 1, 'no room on the right, so left');
  // Pinned in the top-right corner with the left taken: the label goes below and slides in from the edge.
  const corner = place([label('a', 382, 18)], 400, 300, [{ x: 250, y: 0, w: 120, h: 30 }]).get('a');
  assert.deepEqual([corner.side, corner.x, corner.y], [3, 318, 30]);

  const taken = [{ x: 0, y: 0, w: 400, h: 300 }];
  assert.equal(place([label('a', 100, 100)], 400, 300, taken).size, 0, 'left out when nothing is clear');
  const forced = place([label('a', 390, 295, true)], 400, 300, taken).get('a');
  assert.ok(forced.x + forced.w <= 398 && forced.y + forced.h <= 298, 'a selected label is kept, on screen');

  // No room for the full wording anywhere, but the short one fits to the right.
  const tight = [{ x: 262, y: 100, w: 20, h: 100 }, { x: 60, y: 100, w: 130, h: 100 }, { x: 190, y: 60, w: 60, h: 78 }, { x: 190, y: 162, w: 60, h: 60 }];
  assert.equal(place([label('a', 200, 150)], 400, 300, tight).size, 0);
  const short = place([{ ...label('a', 200, 150), narrow: 40 }], 400, 300, tight).get('a');
  assert.deepEqual([short.side, short.w, short.short], [0, 40, true]);
  assert.equal(two.get('a').short, false);

  const below = place([{ ...label('a', 200, 150), order: [3, 2, 0, 1] }], 400, 300);
  assert.equal(below.get('a').side, 3, 'takes the first side it was given');

  // Right, left, above and below are all blocked: it goes to a corner rather than being dropped.
  const hemmed = [{ x: 212, y: 146, w: 60, h: 8 }, { x: 128, y: 146, w: 60, h: 8 }, { x: 196, y: 120, w: 8, h: 10 }, { x: 196, y: 170, w: 8, h: 10 }];
  const cornered = place([label('a', 200, 150)], 400, 300, hemmed).get('a');
  assert.equal(cornered.side, 4, 'up and to the right');
  assert.ok(!hemmed.some((b) => overlap(b, cornered)));
});

test('a label keeps off the path ahead of its aircraft', () => {
  const rad = Math.PI / 180;
  assert.deepEqual(labelSides(270 * rad), [2, 3, 0, 1], 'heading west: above or below, then right (behind), left last');
  assert.deepEqual(labelSides(80 * rad), [2, 3, 1, 0], 'heading east: right is ahead, so last');
  assert.deepEqual(labelSides(10 * rad), [0, 1, 3, 2], 'heading north: right or left, above last');
  assert.deepEqual(labelSides(170 * rad), [0, 1, 2, 3]);
  assert.deepEqual(labelSides(undefined), [0, 1, 2, 3]);
});

test('rings are round numbers, two or three in view', () => {
  for (const radius of [1200, 4600, 9300, 18500, 37000, 74000]) {
    const step = ringStep(radius);
    const count = Math.floor(radius / step);
    assert.ok(count >= 2 && count <= 3, `${radius} m gives ${count} rings of ${step} m`);
  }
});

test('compass words', () => {
  assert.equal(compass(0, 1), 'north');
  assert.equal(compass(1, 1), 'north-east');
  assert.equal(compass(-1, 0), 'west');
  assert.equal(compass(-1, -1), 'south-west');
  assert.equal(compass(-0.1, 1), 'north');
});
