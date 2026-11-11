import test from 'node:test';
import assert from 'node:assert/strict';
import { consent } from '../consent.js';
test('consent is explicit, bounded, expires, and cannot revive a revoked grant', () => {
 let now=0;const c=consent(()=>now,1);
 assert.equal(c.get(undefined),null);
 const one=c.start();assert.ok(c.valid(one));assert.equal(c.start(),null);
 c.stop(one.token);assert.equal(c.valid(one),false);
 const two=c.start();assert.notEqual(one.id,two.id);
 assert.equal(c.valid(one),false);now=24*3600_000;assert.equal(c.valid(two),false);
 assert.ok(c.start());
});

test('one client address holds at most six live grants, each an hour long and renewed while in use, up to a day', () => {
  let now = 0;
  const c = consent(() => now);
  const mine = Array.from({ length: 6 }, () => c.start('192.0.2.1'));
  assert.ok(mine.every(Boolean));
  assert.equal(c.start('192.0.2.1'), null, 'a seventh from the same address');
  assert.ok(c.start('192.0.2.2'), 'another address is not blocked');
  c.stop(mine[0].token);
  assert.ok(c.start('192.0.2.1'), 'a revoked grant frees its place');

  now = 59 * 60_000;
  assert.ok(c.valid(mine[1]), 'used within the hour: renewed');
  now = 61 * 60_000;
  assert.equal(c.get(mine[2].token), null, 'unused for an hour: gone');
  assert.ok(c.valid(mine[1]));
  for (now = 61 * 60_000; now < 24 * 3600_000; now += 30 * 60_000) assert.ok(c.valid(mine[1]), `still in use at ${now / 60_000} min`);
  now = 24 * 3600_000;
  assert.equal(c.valid(mine[1]), false, 'never past a day');
});

test('one client address starts at most twelve grants a day, and revoking one gives none back', () => {
  let now = 0;
  const c = consent(() => now);
  for (let i = 0; i < 12; i++) {
    const g = c.start('192.0.2.1');
    assert.ok(g, `grant ${i + 1}`);
    c.stop(g.token);
  }
  assert.equal(c.start('192.0.2.1'), null, 'a thirteenth in the same day');
  assert.ok(c.start('192.0.2.2'), 'another address is not blocked');
  now = 24 * 3600_000 - 1;
  assert.equal(c.start('192.0.2.1'), null);
  now = 24 * 3600_000;
  assert.ok(c.start('192.0.2.1'), 'a day after the first');
});

test('a tab exchanges its own live grant for a new one, outside the twelve starts, and a closing page gives its grant up a minute later', () => {
  let now = 0;
  const c = consent(() => now);
  const g = c.start('192.0.2.1');
  assert.equal(c.exchange(g, '192.0.2.2'), null, 'not for another client address');
  assert.equal(c.exchange(null, '192.0.2.1'), null);
  const next = c.exchange(g, '192.0.2.1');
  assert.ok(next && next.id !== g.id && next.token !== g.token, 'a new session');
  assert.equal(c.get(g.token), g, 'the grant presented is left as it was');
  for (let i = 0; i < 11; i++) c.stop(c.start('192.0.2.1').token);
  assert.equal(c.start('192.0.2.1'), null, 'twelve starts, the exchange not among them');

  c.close(next.token, '192.0.2.2');
  now = 61_000;
  assert.ok(c.valid(next), 'a close from another client address does nothing');
  c.close(g.token, '192.0.2.1');
  now += 50_000;
  assert.ok(c.valid(g), 'the last upload of a closing page still arrives');
  now += 9_000;
  assert.ok(c.valid(g), 'a use while closing does not renew it');
  now += 1000;
  assert.equal(c.get(g.token), null, 'closed: gone a minute later');
  assert.equal(c.exchange(g, '192.0.2.1'), null, 'and cannot be exchanged');
  assert.ok(c.valid(next), 'the other grant goes on');
});

test('one client address exchanges at most 48 grants a day, within its six live grants', () => {
  let now = 0;
  const c = consent(() => now);
  let g = c.start('192.0.2.1');
  for (let i = 0; i < 5; i++) assert.ok(c.exchange(g, '192.0.2.1'));
  assert.equal(c.exchange(g, '192.0.2.1'), null, 'a seventh live grant');
  now = 2 * 3600_000; // all of them expired
  g = c.start('192.0.2.1');
  for (let i = 5; i < 48; i++) {
    const next = c.exchange(g, '192.0.2.1');
    assert.ok(next, `exchange ${i + 1}`);
    c.stop(g.token);
    g = next;
  }
  assert.equal(c.exchange(g, '192.0.2.1'), null, 'a 49th in the same day');
  now = 24 * 3600_000;
  assert.equal(c.exchange(g, '192.0.2.1'), null, 'unused for a day: expired');
  g = c.start('192.0.2.1');
  assert.ok(c.exchange(g, '192.0.2.1'), 'a day after the first');
});
