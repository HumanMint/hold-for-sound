import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { feedResponse, retryAfter, retryIn, wait, pacer, ASK_S } from '../public/feed.js';

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

test('however long the server says a pause lasts, the page asks it again within a minute', async () => {
  // The overnight session: a quota answer said 6 h, and the page made no request for 6 h 17 min. The
  // server answers a paused request itself, so asking costs the provider nothing, and a pause it ends
  // early (a restart with a new key) is seen within a minute.
  const now = Date.parse('2026-11-11T02:00:07Z');
  const quota = await feedResponse(Response.json({ code: 'flight_quota' }, { status: 429, headers: { 'retry-after': '22620' } })).catch((e) => e);
  assert.equal(ASK_S, 60);
  assert.deepEqual(wait(quota.retryAfter, now), { retryAt: now + 22_620_000, askAt: now + 60_000 }, 'the countdown says 6h 17m; the next ask is a minute away');
  // The rest wait as long as they are told, up to that minute, and a failure that names no wait asks at the next poll.
  const busy = await feedResponse(new Response('', { status: 429 })).catch((e) => e);
  assert.deepEqual(wait(busy.retryAfter, now), { retryAt: now + 60_000, askAt: now + 60_000 });
  assert.deepEqual(wait(5, now), { retryAt: now + 5000, askAt: now + 5000 });
  assert.deepEqual(wait(0, now), { retryAt: now, askAt: now });
  // Asking again while still paused: the server's newer word is the countdown, and a failure with no
  // word of its own (a gateway error) keeps the one already shown.
  const later = now + 60_000;
  assert.deepEqual(wait(22_560, later, now + 22_620_000), { retryAt: later + 22_560_000, askAt: later + 60_000 });
  assert.deepEqual(wait(0, later, now + 22_620_000), { retryAt: now + 22_620_000, askAt: later });
  assert.equal(retryIn(22_620), '6h 17m');
});

test('the poller, every 5 s against a server paused for 6 h, asks once a minute and sees the pause end early', async () => {
  // The server's pause would run 6h 17m; it is restarted with a new key 10 minutes in.
  const start = Date.parse('2026-11-11T02:00:07Z');
  const pausedUntil = start + 22_620_000;
  const restarted = start + 10 * 60_000;
  const answer = (now) => (now < restarted
    ? new Response(JSON.stringify({ code: 'flight_quota' }), { status: 429, headers: { 'retry-after': String(Math.ceil((pausedUntil - now) / 1000)) } })
    : Response.json({ ac: [] }));
  const pace = pacer();
  const asked = [];
  let data = 0;
  for (let now = start; now <= start + 30 * 60_000 && !data; now += 5000) {
    if (!pace.due(now)) continue; // poll() in app.js
    asked.push(now);
    try {
      await feedResponse(answer(now));
      pace.worked();
      data = now;
    } catch (e) {
      pace.failed(e.retryAfter, now);
      assert.equal(pace.retryAt, pausedUntil, 'the countdown shown is the server\'s');
    }
  }
  assert.ok(data && data - restarted <= ASK_S * 1000, `data ${(data - restarted) / 1000} s after the restart`);
  assert.ok(asked.every((at, i) => !i || at - asked[i - 1] === 60_000), 'once a minute while paused');
  assert.equal(pace.retryAt, 0);
  // poll() asks the pacer, and nothing else, whether to ask.
  const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const poll = app.slice(app.indexOf('async function poll() {')).split('\n');
  assert.equal(poll[1].trim(), 'if (!site || !pace.due(Date.now())) return;');
  assert.ok(app.includes('pace.failed(e.retryAfter, Date.now());') && app.includes('pace.worked();'));
  assert.doesNotMatch(app, /feedRetryAt|askAt/);
});
