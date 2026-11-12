import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { check, limits, webhook, dispatch, TOTAL_MS } from '../contact.js';
import { said, UNCONFIRMED, WAIT_MS } from '../public/contact-core.js';
import { queue } from '../queue.js';

const good = { name: 'Sam Mixer', email: 'sam@example.test', category: 'feedback', message: 'The banner went clear too early.', website: '' };
const form = (fields) => new URLSearchParams(fields).toString();

test('a good message is the four fields, trimmed, with its line breaks as \\n', () => {
  assert.deepEqual(check(form({ ...good, name: '  Sam Mixer ', message: 'Line one\r\nline two.' })), {
    message: { name: 'Sam Mixer', email: 'sam@example.test', category: 'feedback', message: 'Line one\nline two.' },
  });
  for (const category of ['feedback', 'inquiry', 'general']) assert.ok(check(form({ ...good, category })).message);
});

test('the honeypot filled is refused', () => {
  assert.equal(check(form({ ...good, website: 'http://spam.example' })).error, 'Not sent.');
});

test('only the form\'s fields, each exactly once', () => {
  const { website, ...missing } = good;
  assert.ok(check(form(missing)).error);
  assert.ok(check(`${form(good)}&extra=1`).error);
  assert.ok(check(`${form(good)}&name=Again`).error);
  assert.ok(check('').error);
  assert.ok(check(null).error);
});

test('each field is checked as the form says', () => {
  const bad = {
    name: ['S', 'x'.repeat(101), 'Sam\u0007', 'Sam\nMixer', '   '],
    email: ['sam', 'sam@example', 'sam@exa mple.test', 'sam@example.test\r\nBcc: x@example.test', `${'a'.repeat(250)}@b.cd`],
    category: ['', 'spam', 'Feedback'],
    message: ['too short', 'x'.repeat(5001), 'Ten chars ok\u0000'],
  };
  for (const [field, values] of Object.entries(bad)) {
    for (const value of values) assert.ok(check(form({ ...good, [field]: value })).error, `${field}: ${JSON.stringify(value).slice(0, 40)}`);
  }
  assert.ok(check(form({ ...good, name: 'x'.repeat(100), message: 'é'.repeat(5000) })).message, 'limits are characters, not bytes');
  assert.ok(check(form({ ...good, message: 'Tabs\tand\nlines are fine.' })).message);
});

test('3 messages per network per 15 minutes, and 30 a day from everyone', () => {
  let now = 0;
  const limit = limits({ clock: () => now });
  for (let i = 0; i < 3; i++) assert.equal(limit.take('a'), 0);
  assert.equal(limit.take('a'), 900);
  assert.equal(limit.take('b'), 0, 'another network is not held back');
  now = 15 * 60_000;
  assert.equal(limit.take('a'), 0);
  for (let i = 0; limit.take(`c${i}`) === 0; i++) assert.ok(i < 30);
  assert.equal(limit.take('d'), 24 * 3600 - 15 * 60, 'the day\'s cap counts from the oldest of the 30');
  now = 24 * 3600_000;
  assert.equal(limit.take('d'), 0);
});

test('delivery posts JSON with the token, and anything but a 2xx is not sent', async () => {
  const calls = [];
  const answer = { status: 204 };
  const fetch = async (url, options) => { calls.push({ url, ...options }); return new Response(null, answer); };
  const deliver = webhook({ url: 'https://mail.example.test/send', token: 'secret', site: 'local', fetch });
  await deliver({ name: 'Sam', email: 'sam@example.test', category: 'general', message: 'Hello there, page.' });
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].headers.authorization, 'Bearer secret');
  assert.deepEqual(JSON.parse(calls[0].body), { name: 'Sam', email: 'sam@example.test', category: 'general', message: 'Hello there, page.', site: 'local' });
  answer.status = 500;
  await assert.rejects(deliver({ name: 'Sam', email: 'sam@example.test', category: 'general', message: 'Hello there, page.' }), (e) => !e.message.includes('Hello'));
  answer.status = 200;
  await webhook({ url: 'https://mail.example.test/send', site: 'x', fetch })({});
  assert.equal(calls.at(-1).headers.authorization, undefined, 'no token, no header');
  assert.throws(() => webhook({ url: 'file:///etc/passwd', site: 'x', fetch }));
});

test('the page says Delivery unconfirmed when no answer came, or a gateway gave up waiting', () => {
  const answer = (status, headers = {}) => ({ status, ok: status >= 200 && status < 300, headers: new Headers(headers) });
  assert.equal(said(null), UNCONFIRMED);
  assert.equal(UNCONFIRMED, 'Delivery unconfirmed');
  assert.equal(said(answer(504), { error: 'Delivery unconfirmed' }), UNCONFIRMED);
  assert.equal(said(answer(524)), UNCONFIRMED);
  assert.equal(said(answer(200), { ok: true }), 'Sent');
  assert.equal(said(answer(502), { error: 'Not sent. Try again later.' }), 'Not sent. Try again later.');
  assert.equal(said(answer(500)), 'Not sent. Try again later.');
  assert.match(said(answer(429, { 'retry-after': '120' })), /^Too many messages\. Try again in /);
});

test('the server answers a message well inside the page\'s wait', () => {
  assert.ok(TOTAL_MS + 5000 <= WAIT_MS, `${TOTAL_MS} ms against the page's ${WAIT_MS}`);
});

// A delivery that takes `takes` ms, or throws as unconfirmed when given less.
const slow = (takes, started) => (message, ms) => {
  started.push({ message, at: Date.now(), ms });
  return new Promise((done, fail) => setTimeout(() => (ms < takes ? fail(Object.assign(new Error('late'), { unconfirmed: true })) : done()), Math.min(ms, takes)));
};

test('three messages at once behind slow deliveries: none is begun, or answered, past its time', async () => {
  // The case found, at a fiftieth of the time: the page waits 400 ms, the server 300, a delivery takes 185.
  const totalMs = 300;
  const started = [];
  const send = dispatch({ line: queue(20), deliver: slow(185, started), totalMs, leastMs: 20 });
  const arrived = Date.now();
  const ended = [];
  const results = await Promise.all([1, 2, 3].map((n) => send(n, { arrived }).then((result) => (ended.push(Date.now() - arrived), result))));
  assert.deepEqual(results, ['sent', 'unconfirmed', 'dropped']);
  assert.deepEqual(started.map((s) => s.message), [1, 2], 'the third is never sent');
  for (const { at, ms } of started) assert.ok(at - arrived + ms <= totalMs + 5, 'a delivery is given only the time left');
  for (const at of ended) assert.ok(at <= totalMs + 40, `answered ${at} ms after arrival`);
});

test('a message whose page has gone before its turn is dropped unsent', async () => {
  const started = [];
  const send = dispatch({ line: queue(0), deliver: slow(0, started), totalMs: 1000, leastMs: 20 });
  assert.equal(await send('gone', { gone: () => true }), 'dropped');
  assert.equal(await send('late', { arrived: Date.now() - 1000 }), 'dropped');
  assert.equal(await send('here'), 'sent');
  assert.deepEqual(started.map((s) => s.message), ['here']);
});

// An HTTP stand-in for the delivery address: `answer(req, res)` replies, and every request is kept.
async function standIn(t, answer) {
  const seen = [];
  const stand = http.createServer((req, res) => {
    let text = '';
    req.on('data', (chunk) => text += chunk);
    req.on('end', () => { seen.push({ method: req.method, url: req.url, body: text }); answer(req, res); });
  });
  stand.listen(0, '127.0.0.1');
  await once(stand, 'listening');
  t.after(() => { stand.closeAllConnections(); stand.close(); });
  return { seen, url: `http://127.0.0.1:${stand.address().port}/send` };
}

test('a redirect is not delivered: it is neither followed nor taken for success', async (t) => {
  for (const [status, location] of [[302, '/ok'], [307, '/ok'], [301, '/ok'], [300, null]]) {
    const box = await standIn(t, (req, res) => (req.url === '/ok' ? res.writeHead(200).end() : res.writeHead(status, location ? { location } : {}).end()));
    const deliver = webhook({ url: box.url, site: 'local' });
    await assert.rejects(deliver({ name: 'Sam', message: 'Hello there, page.' }), (e) => !e.unconfirmed && !e.message.includes('Hello'), `${status}`);
    assert.deepEqual(box.seen.map((r) => `${r.method} ${r.url}`), ['POST /send'], `${status}: nothing followed`);
  }
});

test('a delivery that does not answer in time is unconfirmed, not failed', async (t) => {
  const box = await standIn(t, () => {}); // never answers
  const deliver = webhook({ url: box.url, site: 'local' });
  await assert.rejects(deliver({ name: 'Sam' }, 200), (e) => e.unconfirmed === true);
  assert.equal(box.seen.length, 1, 'it did arrive');
  const refused = webhook({ url: 'http://127.0.0.1:9/send', site: 'local' });
  await assert.rejects(refused({ name: 'Sam' }, 2000), (e) => !e.unconfirmed, 'no connection at all is not sent');
});

test('the day\'s sends are saved, so a restart gives none back; an unreadable file is a spent day', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hfs-contact-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'state', 'contact.json');
  let now = 1_000_000;
  const clock = () => now;
  const first = limits({ clock, file });
  for (let i = 0; i < 30; i++) assert.equal(first.take(`n${i}`), 0, 'a missing file is a fresh start');
  const saved = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(Object.keys(saved), ['v', 'sent']);
  assert.equal(saved.sent.length, 30);
  assert.ok(saved.sent.every((at) => typeof at === 'number'), 'times only');
  assert.doesNotMatch(await readFile(file, 'utf8'), /n\d/, 'no network');
  now += 60_000;
  assert.equal(limits({ clock, file }).take('new'), 24 * 3600 - 60, 'after a restart the day is still spent');
  now += 24 * 3600_000;
  assert.equal(limits({ clock, file }).take('new'), 0, 'and comes back a day after');

  for (const text of ['not json', '{"v":1,"sent":"x"}', '{"v":2,"sent":[]}']) {
    await writeFile(file, text);
    assert.ok(limits({ clock, file }).take('a') > 0, `${text}: taken as a spent day`);
    assert.ok(limits({ clock, file }).take('a') > 0, `${text}: and still after a restart`);
  }
});

test('a send whose time cannot be saved is refused, and not counted', { skip: process.getuid?.() === 0 && 'root can write anywhere' }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hfs-contact-'));
  t.after(async () => { await chmod(dir, 0o700); await rm(dir, { recursive: true, force: true }); });
  const limit = limits({ file: join(dir, 'contact.json') });
  await chmod(dir, 0o500);
  assert.equal(limit.take('a'), null);
  await chmod(dir, 0o700);
  for (let i = 0; i < 3; i++) assert.equal(limit.take('a'), 0, 'the refused one did not count');
});
