import test from 'node:test';
import assert from 'node:assert/strict';
import { check, limits, webhook } from '../contact.js';

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
