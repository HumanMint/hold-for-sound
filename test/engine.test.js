import test from 'node:test';
import assert from 'node:assert/strict';
import { engine, shape } from '../public/engine.js';

test('the type designator decides, and the category only when the type is not in the table', () => {
  const cases = [
    // [t, category, expected]
    ['B738', 'A3', 'jet'],
    ['B77W', 'A5', 'jet'],
    ['A21N', 'A3', 'jet'],
    ['A35K', 'A5', 'jet'],
    ['E75L', 'A3', 'jet'],
    ['B763', undefined, 'jet'], // no category in the row
    ['E55P', 'A2', 'jet'], // A2 is "small jet or turboprop"
    ['E50P', 'A1', 'jet'], // a light jet in A1
    ['C25A', 'A2', 'jet'],
    ['BE40', 'A2', 'jet'], // a Beech that is a jet
    ['GLF6', 'A3', 'jet'],
    ['B461', 'A3', 'jet'], // not a Bell helicopter
    ['AT76', 'A2', 'turboprop'],
    ['DH8D', 'A2', 'turboprop'],
    ['BE30', undefined, 'turboprop'],
    ['B350', 'A1', 'turboprop'],
    ['PC12', 'A1', 'turboprop'],
    ['C208', 'A1', 'turboprop'], // a Cessna 2xx that is a turboprop
    ['SF34', 'A2', 'turboprop'],
    ['C172', 'A1', 'piston'],
    ['C172', 'A2', 'piston'], // the table wins over a category that is too large
    ['PA27', 'A3', 'piston'],
    ['P28A', 'A1', 'piston'],
    ['SR22', 'A1', 'piston'],
    ['BE58', 'A1', 'piston'],
    ['R44', 'A7', 'heli'],
    ['AS50', 'A7', 'heli'],
    ['EC35', undefined, 'heli'],
    ['B407', 'A7', 'heli'],
    ['CL44', undefined, 'turboprop'], // look-alike designators the table must not take for a family
    ['CL35', 'A2', 'jet'],
    ['C101', undefined, 'jet'],
    ['C212', 'A2', 'turboprop'],
    ['C30J', 'A4', 'turboprop'],
    ['ZZZZ', 'A1', null], // a size says nothing of the engine
    ['SJ30', 'A1', null],
    [undefined, 'A3', null],
    [undefined, 'A5', null],
    [undefined, 'A7', 'heli'],
    [undefined, 'A2', null], // small jet or turboprop: not known
    ['NG5', 'B4', null],
    [undefined, 'C2', null],
    [undefined, undefined, null],
  ];
  for (const [t, category, want] of cases) assert.equal(engine({ t, category }), want, `${t} ${category}`);
});

test('every propeller has one icon, and an unknown one has its own', () => {
  assert.deepEqual(['jet', 'turboprop', 'piston', 'prop', 'heli', null].map(shape), ['jet', 'prop', 'prop', 'prop', 'heli', 'unknown']);
});
