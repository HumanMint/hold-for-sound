import test from 'node:test';
import assert from 'node:assert/strict';
import { holds, status, steady, staleAfter, STALE_MS, SETTLE_MS } from '../public/status.js';

const NOW = 1_000_000;
// A window that starts `from` seconds from now and ends `to` seconds from now.
const win = (hex, from, to) => ({ hex, start: NOW + from * 1000, end: NOW + to * 1000 });

test('overlapping windows run together into one hold, and finished ones are dropped', () => {
  const got = holds([win('gone', -60, -5), win('a', -10, 30), win('b', 20, 90), win('c', 200, 260)], NOW);
  assert.deepEqual(got.map((h) => [h.first.hex, (h.start - NOW) / 1000, (h.end - NOW) / 1000]), [['a', -10, 90], ['c', 200, 260]]);
});

test('a short window inside a long one does not cut the hold short', () => {
  const [hold] = holds([win('long', 0, 120), win('short', 10, 40)], NOW);
  assert.equal(hold.end, NOW + 120_000);
});

test('audible now is a hold that counts down to its end, with the next one after it', () => {
  const got = status([win('a', -10, 30), win('b', 200, 260)], NOW, NOW);
  assert.equal(got.state, 'hold');
  assert.equal(got.until, NOW + 30_000);
  assert.equal(got.current.first.hex, 'a');
  assert.equal(got.next.first.hex, 'b');
});

test('an aircraft within a minute is a heads up, and further out it is clear', () => {
  assert.deepEqual(
    [59, 61].map((s) => status([win('a', s, s + 30)], NOW, NOW).state),
    ['soon', 'clear'],
  );
  assert.equal(status([win('a', 61, 91)], NOW, NOW).until, NOW + 61_000);
});

test('nothing predicted is clear with no countdown', () => {
  assert.deepEqual(status([], NOW, NOW), { state: 'clear', until: null, next: undefined });
});

test('old flight data is never clear, whatever was predicted', () => {
  const last = NOW - STALE_MS - 1;
  assert.equal(status([], NOW, last).state, '');
  assert.equal(status([win('a', -10, 30)], NOW, last).state, '');
  assert.equal(status([], NOW, 0).state, ''); // no data yet
  assert.equal(status([], NOW, NOW - STALE_MS).state, 'clear'); // right at the limit still counts
  // A night with no flight data from 02:00 on: No data every second of 6 h 17 min, whatever came before.
  let shown = steady(status([win('a', -5, 30)], NOW, NOW), NOW, null, NOW);
  assert.equal(shown.state, 'hold');
  const seen = new Set();
  for (let s = 21; s <= 6 * 3600 + 17 * 60; s++) seen.add((shown = steady(status([win('a', -5, 30)], NOW + s * 1000, NOW), NOW + s * 1000, shown, NOW)).state);
  assert.deepEqual([...seen], ['']);
});

test('a quiet sky kept for a minute is trusted for 80 s, one kept 30 s for 40 s, and nothing else for more than 20 s', () => {
  assert.equal(staleAfter(), STALE_MS); // no `every`: a recording, or a server from before it
  assert.equal(staleAfter(4), STALE_MS); // local: 4 s
  assert.equal(staleAfter(10), STALE_MS); // public, busy: 10 s
  assert.equal(staleAfter(60), 80_000); // public, quiet: a minute
  assert.equal(staleAfter(30), 40_000); // public, quiet beside a runway: 30 s
  assert.equal(status([], NOW, NOW - 37_000, staleAfter(30)).state, 'clear');
  assert.equal(status([], NOW, NOW - 40_001, staleAfter(30)).state, '', 'an unseen takeoff cannot hide behind a 30 s answer for long');
  // The page polls every 5 s, so a minute's answer is replaced when it is 60 to 65 s old, after the
  // feed's own second or two of delay: it never reads as no data while that works.
  assert.equal(status([], NOW, NOW - 67_000, staleAfter(60)).state, 'clear');
  assert.equal(status([], NOW, NOW - 80_001, staleAfter(60)).state, '');
  assert.equal(status([], NOW, NOW - 21_000, staleAfter(10)).state, '');
  assert.equal(status([win('a', -10, 30)], NOW, NOW - 70_000, staleAfter(60)).state, 'hold');
});

test('a hold that stops well before it was due is kept up for 10 s before it is called clear', () => {
  const holding = status([win('a', -10, 60)], NOW, NOW);
  // The aircraft drops out of the predictions a second later, 59 s early.
  let shown = steady(status([], NOW + 1000, NOW + 1000), NOW + 1000, holding);
  assert.deepEqual([shown.state, shown.checking, shown.until, shown.current.first.hex], ['hold', true, NOW + 1000 + SETTLE_MS, 'a']);
  shown = steady(status([], NOW + 9000, NOW + 9000), NOW + 9000, shown);
  assert.equal(shown.state, 'hold'); // still waiting, and the wait does not start again
  assert.equal(shown.until, NOW + 1000 + SETTLE_MS);
  shown = steady(status([], NOW + 11_000, NOW + 11_000), NOW + 11_000, shown);
  assert.equal(shown.state, 'clear');
  assert.equal(steady(status([], NOW + 12_000, NOW + 12_000), NOW + 12_000, shown).state, 'clear'); // and it stays clear
});

test('a hold that ends on time is called clear once newer flight data agrees, and one that comes back carries on', () => {
  const holding = status([win('a', -10, 2)], NOW, NOW);
  // The data that timed its end arrived before it ended, so the first second after it is not clear yet.
  const waiting = steady(status([], NOW + 2500, NOW), NOW + 2500, holding, NOW);
  assert.deepEqual([waiting.state, waiting.checking, waiting.early], ['hold', true, false]);
  assert.equal(steady(status([], NOW + 5000, NOW + 5000), NOW + 5000, waiting, NOW + 5000).state, 'clear'); // a newer poll agrees
  assert.equal(steady(status([], NOW + 9000, NOW), NOW + 9000, waiting, NOW).state, 'clear'); // or no poll comes: it does not wait for ever
  assert.equal(steady(status([win('a', -10, 4)], NOW + 3000, NOW + 3000), NOW + 3000, waiting, NOW + 3000).checking, undefined); // it was not over
  const long = status([win('a', -10, 60)], NOW, NOW);
  const checking = steady(status([], NOW + 1000, NOW + 1000), NOW + 1000, long);
  const back = steady(status([win('a', -10, 50)], NOW + 5000, NOW + 5000), NOW + 5000, checking);
  assert.deepEqual([back.state, back.checking, back.until], ['hold', undefined, NOW + 50_000]); // the aircraft is back
  assert.equal(steady(status([], NOW + 1000, 0), NOW + 1000, long).state, ''); // no data is never smoothed over
});

test('an aircraft the page lost track of before it had passed is neither a hold nor clear', () => {
  const lost = { ...win('lost', -100, 60), unsure: true, lost: true };
  const got = status([lost], NOW, NOW);
  assert.deepEqual([got.state, got.unsure.hex, got.until], ['soon', 'lost', null]);
  // A real aircraft still decides: a hold is a hold, and one coming is counted down to.
  assert.equal(status([lost, win('a', -5, 30)], NOW, NOW).state, 'hold');
  const coming = status([lost, win('a', 40, 70)], NOW, NOW);
  assert.deepEqual([coming.state, coming.unsure.hex, coming.until, coming.next.first.hex], ['soon', 'lost', NOW + 40_000, 'a']);
  // It is never itself a hold, and it is over when its window is.
  assert.deepEqual(holds([lost], NOW), []);
  assert.equal(status([lost], NOW + 61_000, NOW + 61_000).state, 'clear');
  assert.equal(status([lost], NOW, 0).state, ''); // and old data is still no data
});
