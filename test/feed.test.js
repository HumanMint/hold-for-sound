import test from 'node:test';
import assert from 'node:assert/strict';
import { feedResponse, retryAfter, retryIn } from '../public/feed.js';

test('feed errors handle proxy HTML, malformed success and provider retry delays', async () => {
  await assert.rejects(feedResponse(new Response('<html>Bad gateway</html>', { status: 502 })),
    error => error.name === 'FeedError' && /service is unavailable/.test(error.message) && !error.message.includes('Unexpected'));
  await assert.rejects(feedResponse(new Response('not JSON')), /unreadable response/);
  await assert.rejects(feedResponse(Response.json({})), /incomplete data/);
  await assert.rejects(feedResponse(new Response('rate limit exceeded', { status: 429, headers: { 'retry-after': '120' } })),
    error => error.retryAfter === 120 && /service is busy/.test(error.message));
  await assert.rejects(feedResponse(new Response('', { status: 429 })), error => error.retryAfter === 60);
  await assert.rejects(feedResponse(new Response('', { status: 429, headers: { 'retry-after': '5' } })), error => error.retryAfter === 5);
  assert.deepEqual(await feedResponse(Response.json({ ac: [], age: 0 })), { ac: [], age: 0 });
});

test('aborting a response body keeps AbortError so sharing changes do not show a feed failure', async () => {
  const stream = new ReadableStream({ start(controller) { controller.error(new DOMException('Aborted', 'AbortError')); } });
  await assert.rejects(feedResponse(new Response(stream)), { name: 'AbortError' });
});

test('Retry-After accepts seconds and HTTP dates without turning invalid values into waits', () => {
  const now = Date.parse('2026-11-11T00:00:00Z');
  assert.equal(retryAfter('18', now), 18);
  assert.equal(retryAfter('Wed, 11 Nov 2026 00:02:00 GMT', now), 120);
  for (const value of [null, '', 'invalid', '-1', 'Infinity', 'Tue, 10 Nov 2026 23:59:00 GMT']) {
    assert.equal(retryAfter(value, now), 0);
  }
});

test('quota errors are explicit and long retry countdowns stay readable', async () => {
  await assert.rejects(feedResponse(Response.json({ code: 'flight_quota' }, { status: 429, headers: { 'retry-after': '44283' } })), e => /quota exhausted/.test(e.message) && e.retryAfter === 44283);
  assert.equal(retryIn(44283), '12h 18m');
  assert.equal(retryIn(65), '1m 5s');
  assert.equal(retryIn(4.5), '5s');
});
