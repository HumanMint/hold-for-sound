import test from 'node:test';
import assert from 'node:assert/strict';
import { snapshot, merge } from '../receiver.js';

// A set beside LAX. One hundredth of a degree of latitude is 0.6 nm.
const set = { lat: 33.94, lon: -118.44, radiusNm: 30 };
const T = 1_794_300_000_000; // epoch ms
const near = (hex, more) => ({ hex, lat: 33.95, lon: -118.43, alt_baro: 1500, seen_pos: 0, ...more });
const byHex = (answer) => Object.fromEntries(answer.ac.map((ac) => [ac.hex, ac]));
const close = (a, b) => Math.abs(a - b) < 1e-9;

test("a receiver's aircraft.json is read in seconds, the feed's in milliseconds", () => {
  const json = { now: T / 1000 - 0.4, messages: 12345, aircraft: [{ hex: 'a1b2c3' }] };
  assert.deepEqual(snapshot(json, T), { now: T - 400, ac: [{ hex: 'a1b2c3' }] });
  // A receiver whose clock runs ahead, or that gives no time, is taken to have answered just now.
  assert.equal(snapshot({ now: T / 1000 + 90, aircraft: [] }, T).now, T);
  assert.equal(snapshot({ aircraft: [] }, T).now, T);
});

test('an answer that is not an aircraft.json is a receiver that failed', () => {
  // An error page that happens to be JSON, a list that is not one, nothing at all.
  for (const json of [{ error: 'receiver down' }, { now: T / 1000 }, { now: T / 1000, aircraft: {} }, null, 'busy', []]) assert.throws(() => snapshot(json, T));
  // Rows that are not aircraft are dropped, so one bad row cannot break the feed's answer.
  assert.deepEqual(snapshot({ aircraft: [null, 7, { flight: 'NOHEX' }, { hex: 'a1b2c3' }] }, T).ac, [{ hex: 'a1b2c3' }]);
});

test('each aircraft comes from whichever source saw its position last, allowing for how old each snapshot is', () => {
  // The feed's snapshot is 6 s old and the receiver's 0.2 s, so the feed's "0.5 s ago" was 6.5 s ago.
  const feed = { source: 'api.adsb.lol', now: T - 6000, ac: [near('aaaaaa', { seen_pos: 0.5, lat: 34.02 }), near('bbbbbb', { seen_pos: 0.5, lat: 34.02 }), near('cccccc', { seen_pos: 1 })] };
  const own = { now: T - 200, ac: [near('aaaaaa', { seen_pos: 3, lat: 33.92 }), near('bbbbbb', { seen_pos: 20, lat: 33.92 }), near('dddddd', { seen_pos: 0.1 })] };
  const answer = merge(feed, own, set);
  const ac = byHex(answer);

  assert.equal(answer.now, T - 6000); // still the feed's snapshot: everything is measured from it
  assert.equal(answer.source, 'api.adsb.lol and your receiver');
  assert.equal(ac.aaaaaa.lat, 33.92); // the receiver's, seen 3.2 s ago against the feed's 6.5 s
  assert.ok(close(ac.aaaaaa.seen_pos, 3 - 5.8)); // 2.8 s after the feed's snapshot was made
  assert.equal(ac.bbbbbb.lat, 34.02); // the feed's, seen 6.5 s ago against the receiver's 20.2 s
  assert.equal(ac.bbbbbb.seen_pos, 0.5);
  assert.equal(ac.cccccc.seen_pos, 1); // an aircraft only the feed has, untouched
  assert.ok(close(ac.dddddd.seen_pos, 0.1 - 5.8)); // an aircraft only the receiver has: the one this is for
  assert.equal(answer.ac.length, 4);

  // The other way round: a fresh feed and a receiver that has fallen behind.
  const late = merge({ ...feed, now: T }, { ...own, now: T - 30_000 }, set);
  assert.equal(byHex(late).aaaaaa.lat, 34.02);
  assert.equal(late.now, T);
  assert.ok(close(byHex(late).dddddd.seen_pos, 30.1));

  // A position with no age given is as old as its snapshot, whichever source it is from.
  const bare = merge({ ...feed, ac: [near('aaaaaa', { seen_pos: undefined, lat: 34.02 })] }, { now: T - 3000, ac: [near('aaaaaa', { seen_pos: undefined, lat: 33.92 })] }, set);
  assert.equal(byHex(bare).aaaaaa.lat, 33.92); // the feed's is 6 s old and the receiver's 3 s
});

test('a receiver that hears nothing does not make an old feed look fresh', () => {
  // Case: a feed two minutes behind and a receiver answering now with no aircraft.
  const stale = { source: 'api.adsb.lol', now: T - 120_000, ac: [near('aaaaaa')] };
  assert.deepEqual(merge(stale, { now: T, ac: [] }, set), stale);
  assert.equal(merge(stale, { now: T, ac: [near('bbbbbb')] }, set).now, T - 120_000); // nor does one that hears something
});

test('a receiver position that cannot be predicted from does not replace one that can', () => {
  // Case: the feed has the aircraft with its height; the receiver has a newer
  // position and no height yet. Taking the receiver's would lose the warning.
  const feed = { source: 'api.adsb.lol', now: T, ac: [near('aaaaaa', { seen_pos: 5, alt_baro: 1200, gs: 140 })] };
  const kept = merge(feed, { now: T, ac: [{ hex: 'aaaaaa', lat: 33.96, lon: -118.43, seen_pos: 0.2 }] }, set);
  assert.deepEqual(kept, feed);
  // With a height it is taken, on the ground included.
  assert.equal(byHex(merge(feed, { now: T, ac: [near('aaaaaa', { alt_baro: 'ground', seen_pos: 0.2 })] }, set)).aaaaaa.alt_baro, 'ground');
  assert.equal(byHex(merge(feed, { now: T, ac: [{ hex: 'aaaaaa', lat: 33.96, lon: -118.43, alt_geom: 1300 }] }, set)).aaaaaa.alt_geom, 1300);
});

test("the feed's type fields are kept when the receiver has none", () => {
  const feed = { source: 'api.adsb.lol', now: T, ac: [near('aaaaaa', { seen_pos: 9, t: 'C172', desc: 'CESSNA 172 Skyhawk', category: 'A1', flight: 'N123AB  ', alt_baro: 800 })] };
  const own = { now: T, ac: [near('aaaaaa', { alt_baro: 'ground', gs: 12 }), near('bbbbbb', { category: 'A7' })] };
  const ac = byHex(merge(feed, own, set));
  assert.deepEqual(ac.aaaaaa, near('aaaaaa', { alt_baro: 'ground', gs: 12, t: 'C172', desc: 'CESSNA 172 Skyhawk', category: 'A1', flight: 'N123AB  ' }));
  assert.deepEqual(ac.bbbbbb, near('bbbbbb', { category: 'A7' })); // unknown to the feed: nothing to add

  // What the receiver did hear about the aircraft is newer than what the feed says.
  const heard = { now: T, ac: [near('aaaaaa', { category: 'A2', flight: 'N999ZZ  ' })] };
  assert.deepEqual(byHex(merge(feed, heard, set)).aaaaaa, near('aaaaaa', { category: 'A2', flight: 'N999ZZ  ', t: 'C172', desc: 'CESSNA 172 Skyhawk' }));
});

test("only the receiver's aircraft with a position inside the feed's radius are added", () => {
  const feed = { source: 'api.adsb.lol', now: T, ac: [near('aaaaaa')] };
  const own = { now: T, ac: [near('inside', { lat: 34.42 }), near('beyond', { lat: 34.45 }), near('east', { lat: 33.94, lon: -117.85 }), { hex: 'nowhere', seen: 2 }, near('aaaaaa', { lat: 50, seen_pos: -5 })] };
  const answer = merge(feed, own, set);
  assert.deepEqual(answer.ac.map((ac) => ac.hex), ['aaaaaa', 'inside', 'east']); // 28.8 nm north and 29.4 nm east are in, 30.6 nm is out
  assert.equal(byHex(answer).aaaaaa.lat, 33.95);
});

test('a receiver that did not answer, or had nothing newer, leaves the feed as it is', () => {
  const feed = { source: 'api.adsb.lol', now: T, ac: [near('aaaaaa', { t: 'B738' })] };
  assert.equal(merge(feed, null, set), feed);
  assert.equal(merge(feed, { now: T, ac: [near('aaaaaa', { seen_pos: 4 })] }, set).source, 'api.adsb.lol'); // answered, but is not named
  // A feed that gives no time is taken to be as fresh as the receiver.
  const untimed = merge({ source: 'a feed', ac: [near('aaaaaa', { seen_pos: 2 })] }, { now: T, ac: [near('aaaaaa', { seen_pos: 1, lat: 33.92 })] }, set);
  assert.deepEqual([untimed.now, byHex(untimed).aaaaaa.lat, byHex(untimed).aaaaaa.seen_pos], [undefined, 33.92, 1]);
});
