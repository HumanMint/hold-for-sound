import test from 'node:test';
import assert from 'node:assert/strict';
import { absorption, coefficient, lateral, installation, propagation, elevation } from '../public/propagate.js';
const near = (a, b, tolerance = 0.001) => assert.ok(Math.abs(a - b) < tolerance, `${a} != ${b}`);

test('ISO coefficients at 15 C and 70% RH have the expected frequency dependence', () => {
  // Independently evaluated ISO 9613-1 coefficients, dB/km (rounded).
  for (const [f, db] of [[125, 0.375], [1000, 4.079], [2000, 8.777], [4000, 26.608]]) near(coefficient(f) * 1000, db, 0.002);
});

test('absorption starts beyond the source reference and low-frequency engines carry farther', () => {
  for (const kind of ['jet', 'prop', 'piston', 'turboprop', 'heli', null]) {
    assert.equal(absorption(30, kind), 0);
    assert.equal(absorption(305, kind), 0);
    let previous = 0;
    for (let dist = 306; dist < 120000; dist += 173) {
      const loss = absorption(dist, kind);
      assert.ok(Number.isFinite(loss) && loss >= previous);
      assert.ok(loss <= absorption(dist, 'jet') + 1e-10);
      previous = loss;
    }
  }
  for (const [dist, jet, prop] of [[1000, 2.796, 1.487], [3000, 8.056, 4.548], [5000, 11.464, 6.692], [8000, 14.814, 9.001]]) {
    near(absorption(dist, 'jet'), jet);
    near(absorption(dist, 'prop'), prop);
    assert.equal(absorption(dist, null), absorption(dist, 'prop'));
  }
});

test('AIR5662 lateral loss ramps with lateral distance and vanishes directly beneath the source', () => {
  assert.equal(lateral(0, 0), 0);
  near(lateral(0, 1000), 10.857);
  near(lateral(10, 1000), 3.2575, 0.002);
  near(lateral(0, 100), 10.857 * 1.089 * (1 - Math.exp(-0.274)));
  assert.ok(Math.abs(lateral(0, 914) - lateral(0, 915)) < 0.001);
  assert.equal(lateral(51, 1000), 0);
  assert.equal(lateral(-10, 1000), lateral(0, 1000));
  assert.equal(elevation(305, 0), 90);
});

test('installation correction has the standard sign and unknown mounts use the loudest choice', () => {
  near(installation(0, 'wing'), -1.49354);
  near(installation(0, 'fuselage'), -3.0001, 0.002);
  for (let beta = 0; beta <= 90; beta++) {
    assert.equal(installation(beta, 'prop'), 0);
    assert.ok(installation(beta) >= Math.max(0, installation(beta, 'wing'), installation(beta, 'fuselage')));
  }
  near(installation(90, 'wing'), 0);
});

test('spreading doubles distance by 6 dB and ground-roll shielding never increases', () => {
  near(propagation(305, 90, 0, 'jet'), 0);
  near(propagation(610, 90, 0, 'jet') - absorption(610, 'jet'), 20 * Math.log10(2));
  for (const beta of [0, 5, 20, 30, 50, 90]) for (const dist of [30, 305, 1000, 3000, 8000]) {
    const loss = propagation(dist, beta, 2000, 'jet') - 20 * Math.log10(dist / 305) - absorption(dist, 'jet');
    assert.ok(loss <= 3 + 1e-10);
    assert.ok(loss <= 8 * Math.max(0, 1 - beta / 30) + 1e-10);
  }
});

test('absorption follows the engine type and keeps unknowns on the louder curve', () => {
  for (const dist of [305, 1000, 3000, 8000]) {
    for (const kind of [null, undefined, 'turboprop', 'piston', 'prop', 'heli']) near(absorption(dist, kind), absorption(dist, 'prop'));
    assert.ok(absorption(dist, null) <= absorption(dist, 'jet') + 1e-10);
  }
});
