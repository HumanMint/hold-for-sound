import test from 'node:test';
import assert from 'node:assert/strict';
import { traffic, client, direct, network } from '../stats.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const req = (remoteAddress, headers = {}) => ({ socket: { remoteAddress }, headers });

test('the report has exactly the shape the dashboard reads', () => {
  let now = 1_794_300_000_000;
  const seen = traffic(() => now);
  for (const what of ['requests', 'requests', 'requests', 'pages', 'api', 'badPasswords', 'upstream', 'upstream']) seen.count(what);
  seen.visitor('192.0.2.1');
  seen.stranger('203.0.113.9');
  seen.watching('33.938,-118.440');
  now += 30 * MIN;

  const report = seen.report();
  assert.deepEqual(report, {
    since: 1_794_300_000_000,
    now: 1_794_300_000_000 + 30 * MIN,
    requests: 3,
    pages: 1,
    api: 1,
    refused: 1,
    badPasswords: 1,
    upstream: 2,
    visitors: { hour: 1, day: 1 },
    strangers: { hour: 1, day: 1 },
    addresses: 0, // nobody has asked about that set for half an hour
  });
  assert.deepEqual(Object.keys(report), ['since', 'now', 'requests', 'pages', 'api', 'refused', 'badPasswords', 'upstream', 'visitors', 'strangers', 'addresses']);
});

test('visitors and strangers are distinct addresses in the last hour and day', () => {
  let now = 0;
  const seen = traffic(() => now);
  seen.stranger('a');
  seen.stranger('a');
  seen.stranger('b');
  seen.visitor('friend');
  now = 90 * MIN;
  seen.stranger('c');
  seen.watching('1.000,2.000');
  seen.watching('1.000,2.000');
  seen.watching('3.000,4.000');
  assert.deepEqual(seen.report().strangers, { hour: 1, day: 3 });
  assert.deepEqual(seen.report().visitors, { hour: 0, day: 1 });
  assert.equal(seen.report().refused, 4);
  assert.equal(seen.report().addresses, 2);
  now = 25 * 60 * MIN;
  assert.deepEqual(seen.report().strangers, { hour: 0, day: 1 });
  assert.deepEqual(seen.report().visitors, { hour: 0, day: 0 });

  // Someone who saw the login page and then got in is no stranger.
  seen.stranger('friend');
  seen.visitor('friend');
  assert.deepEqual(seen.report().strangers, { hour: 0, day: 1 });
  assert.deepEqual(seen.report().visitors, { hour: 1, day: 1 });
});

test('memory stays bounded however many addresses turn up', () => {
  const seen = traffic(() => 0, 100);
  for (let i = 0; i < 20_000; i++) {
    seen.stranger(`2001:db8::${i.toString(16)}`);
    seen.visitor(`10.0.${i >> 8}.${i & 255}`);
    seen.watching(`${i},0`);
  }
  const report = seen.report();
  assert.deepEqual([report.strangers.day, report.visitors.day, report.addresses], [100, 100, 100]);
  assert.equal(report.refused, 20_000); // the totals still count everything
});

test('only a request made on the machine itself, not through the proxy, may read the counters', () => {
  assert.equal(direct(req('127.0.0.1')), true);
  assert.equal(direct(req('::1')), true);
  assert.equal(direct(req('::ffff:127.0.0.1')), true);
  // A proxy on this machine connects from loopback too, but always says who it is forwarding for.
  assert.equal(direct(req('127.0.0.1', { 'x-forwarded-for': '203.0.113.9' })), false);
  assert.equal(direct(req('127.0.0.1', { 'x-forwarded-for': '' })), false);
  assert.equal(direct(req('192.0.2.2')), false); // another machine
  assert.equal(direct(req(undefined)), false);
});

test("the client's address is the one the proxy reports, else the socket's", () => {
  assert.equal(client(req('127.0.0.1', { 'x-forwarded-for': '203.0.113.9' })), '203.0.113.9');
  assert.equal(client(req('127.0.0.1', { 'x-forwarded-for': '203.0.113.9, 198.51.100.1' })), '203.0.113.9');
  assert.equal(client(req('192.0.2.2')), '192.0.2.2');
  assert.equal(client(req('127.0.0.1', { 'x-forwarded-for': 'x'.repeat(9000) })).length, 64);
});

test('the log line covers one period, names no address, and is skipped when nothing happened', () => {
  let now = 0;
  const seen = traffic(() => now);
  assert.equal(seen.line(10 * MIN), null);

  seen.count('requests');
  seen.count('requests');
  seen.count('api');
  seen.count('upstream');
  seen.visitor('192.0.2.1');
  seen.stranger('203.0.113.9');
  seen.watching('33.938,-118.440');
  assert.equal(seen.line(10 * MIN), 'traffic, 10 min: 2 requests, 0 pages, 1 api, 1 refused, 0 badPasswords, 1 upstream, 1 visitors, 1 strangers, 1 addresses');

  now = 10 * MIN;
  assert.equal(seen.line(10 * MIN), null);
  seen.count('requests');
  seen.count('badPasswords');
  seen.stranger('198.51.100.7');
  assert.equal(seen.line(10 * MIN), 'traffic, 10 min: 1 requests, 0 pages, 0 api, 1 refused, 1 badPasswords, 0 upstream, 0 visitors, 1 strangers, 0 addresses');
  assert.equal(seen.report().requests, 3); // the totals go on
});

test('an IPv6 client is its /64 network, and an IPv4-mapped address is the IPv4 address', () => {
  assert.equal(network('192.0.2.1'), '192.0.2.1');
  assert.equal(network('::ffff:192.0.2.1'), '192.0.2.1');
  assert.equal(network('::FFFF:c000:0201'), '192.0.2.1');
  assert.equal(network('2001:db8:1:2::1'), '2001:db8:1:2::/64');
  assert.equal(network('2001:0DB8:0001:0002:ffff:ffff:ffff:ffff'), '2001:db8:1:2::/64');
  assert.equal(network('2001:db8:1:2:aaaa:bbbb:192.0.2.9'), '2001:db8:1:2::/64');
  assert.equal(network('fe80::1%eth0'), 'fe80:0:0:0::/64');
  assert.notEqual(network('2001:db8:1:3::1'), network('2001:db8:1:2::1'));
  assert.equal(network('::1'), '0:0:0:0::/64');
  assert.equal(network('local'), 'local');
  assert.equal(network('not:an:address'), 'not:an:address');
});

test('addresses are forgotten after a day by the maintenance prune, even when nobody reads the counters', () => {
  let now = 0;
  const seen = traffic(() => now);
  seen.visitor('192.0.2.1');
  now = HOUR;
  seen.stranger('192.0.2.2');
  now = DAY - 1;
  assert.equal(seen.prune(), 2, 'both held, under a day');
  now = DAY;
  assert.equal(seen.prune(), 1, 'the visitor, seen a day ago, is gone');
  now = DAY + HOUR;
  assert.equal(seen.prune(), 0);
});
