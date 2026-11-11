import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { Readable } from 'node:stream';
import { randomBytes } from 'node:crypto';
import { createLog, read, body, summary, spectrogram, ID, MAX_POST, SESSION_MAX, DIR_MAX } from '../log.js';

// The session log on the server: what it keeps, under which names, and where it stops.

const DAY = Date.UTC(2026, 10, 10, 15); // 10 November 2026
const ONE = '0123456789abcdef';
const TWO = 'fedcba9876543210';
const temp = () => mkdtempSync(join(tmpdir(), 'hfs-log-'));
const batch = (id, n, events = [{ k: 'mark', at: DAY, heard: true }]) => JSON.stringify({ id, n, sent: DAY - 400, events });
// A feed row as a live feed sends it: the fields the page reads, and some of the forty it does not.
const row = (hex, more) => ({ hex, flight: 'DAL1897 ', t: 'B738', desc: 'BOEING 737-800', category: 'A3', alt_baro: 1200, alt_geom: 1250, gs: 140.5, track: 263.4, baro_rate: -700, seen_pos: 0.4, lat: 33.94, lon: -118.38, squawk: '1200', rssi: -21.3, messages: 9000, mlat: [], nav_qnh: 1013.6, ...more });
const page = ({ squawk, rssi, messages, mlat, nav_qnh, ...kept }) => kept;
// A chunk of spectrogram as the page sends it: `cols` columns of 304 bytes, here random, which is the
// worst there is to compress.
const chunk = (at, cols = 80, more = {}) => ({ k: 'spec', from: DAY, at, rate: 8, cols, bins: 304, fmin: 50, octave: 48, lo: -127.5, step: 0.5, data: randomBytes(cols * 304).toString('base64'), ...more });

test('nothing is kept unless LOG_DIR is set', () => {
  const parent = temp();
  for (const dir of [undefined, '']) {
    const log = createLog(dir);
    assert.equal(log.on, false);
    assert.deepEqual(log.request('GET', ''), { status: 200, on: false });
    assert.equal(log.request('POST', batch(ONE, 0)).status, 404);
    log.frame(ONE, DAY, [row('a1b2c3')]);
  }
  assert.deepEqual(readdirSync(parent), []);
});

test('a session is two files named from its day and id, and a batch is stored once, in order', () => {
  const dir = join(temp(), 'made', 'if-missing');
  let now = DAY;
  const log = createLog(dir, { clock: () => now });
  assert.deepEqual(log.request('GET', ''), { status: 200, on: true });

  const site = { k: 'site', at: DAY - 900, lat: 33.938, lon: -118.44, elevM: 5, airports: ['KLAX'], env: 'outdoors' };
  assert.deepEqual(log.request('POST', batch(ONE, 0, [site])), { status: 200, ok: true });
  now += 20_000;
  assert.deepEqual(log.request('POST', batch(ONE, 1)), { status: 200, ok: true });
  // The answer to that one was lost, so the page sends it again: it is not stored twice.
  assert.deepEqual(log.request('POST', batch(ONE, 1)), { status: 200, ok: true });
  now += 86_400_000; // past midnight the session keeps its name
  assert.deepEqual(log.request('POST', batch(ONE, 2, [{ k: 'mark', at: now, heard: false }])), { status: 200, ok: true });
  log.frame(ONE, now, [row('a1b2c3')]);

  assert.deepEqual(readdirSync(dir).sort(), [`2026-11-10-${ONE}.feed.jsonl.gz`, `2026-11-10-${ONE}.log.jsonl.gz`]);
  assert.deepEqual(read(join(dir, `2026-11-10-${ONE}.log.jsonl.gz`)), [
    { k: 'session', v: 1, id: ONE, at: DAY },
    { k: 'post', n: 0, at: DAY, sent: DAY - 400 },
    site,
    { k: 'post', n: 1, at: DAY + 20_000, sent: DAY - 400 },
    { k: 'mark', at: DAY, heard: true },
    { k: 'post', n: 2, at: now, sent: DAY - 400 },
    { k: 'mark', at: now, heard: false },
  ]);

  // A restart finds the session by its files and carries on in them.
  const again = createLog(dir, { clock: () => now });
  assert.deepEqual(again.request('POST', batch(ONE, 3)), { status: 200, ok: true });
  assert.equal(readdirSync(dir).length, 2);
  assert.equal(read(join(dir, `2026-11-10-${ONE}.log.jsonl.gz`)).filter((e) => e.k === 'session').length, 1);
});

test('the feed a sharing page was served is read back by the REPLAY loader as the same frames', () => {
  const dir = temp();
  const log = createLog(dir, { clock: () => DAY });
  log.frame(ONE, DAY, [row('a1b2c3')]); // nobody has posted under this id yet: a feed request starts no session
  assert.deepEqual(readdirSync(dir), []);

  log.request('POST', batch(ONE, 0));
  const frames = [
    { at: DAY + 1000, ac: [row('a1b2c3'), row('d4e5f6', { alt_baro: 'ground', true_heading: 70.3, track: undefined })] },
    { at: DAY + 6000, ac: [row('a1b2c3', { lat: 33.941, seen_pos: 22.5 })] },
    { at: DAY + 11_000.4, ac: [] },
  ];
  for (const f of frames) log.frame(ONE, f.at, f.ac);
  log.frame(ONE, DAY + 6000, [row('late00')]); // a snapshot no newer than the last one kept is the same one, served again
  log.frame(ONE, DAY + 11_000, [row('late00')]);
  log.frame(TWO, DAY + 20_000, [row('a1b2c3')]);
  log.frame('../../x', DAY + 20_000, [row('a1b2c3')]);
  log.frame(null, DAY + 20_000, [row('a1b2c3')]);

  assert.deepEqual(readdirSync(dir).sort(), [`2026-11-10-${ONE}.feed.jsonl.gz`, `2026-11-10-${ONE}.log.jsonl.gz`]);
  // Only what the page reads of each row, and nothing the row did not have.
  const kept = frames.map((f) => ({ at: Math.round(f.at), ac: f.ac.map((ac) => JSON.parse(JSON.stringify(page(ac)))) }));
  assert.deepEqual(read(join(dir, `2026-11-10-${ONE}.feed.jsonl.gz`)), kept);
  assert.ok(!('track' in kept[0].ac[1]) && kept[0].ac[1].true_heading === 70.3);

  // The loader still reads a recording that is plain text, as the one in the repository is.
  const fixture = read(new URL('fixtures/lax.jsonl', import.meta.url));
  assert.equal(fixture.length, 67);
  assert.deepEqual(fixture, readFileSync(new URL('fixtures/lax.jsonl', import.meta.url), 'utf8').trim().split('\n').map(JSON.parse));
});

test('nothing a client sends can name a file, and what is not a batch is refused', () => {
  const parent = temp();
  const dir = join(parent, 'logs');
  const log = createLog(dir, { clock: () => DAY });
  const events = [{ k: 'mark', at: DAY, heard: true }];
  for (const id of ['../../etc/passwd', `../${ONE}`, `${ONE}/../x`, ONE.toUpperCase(), `${ONE}0`, ONE.slice(1), `${ONE}\n`, '', '................', 42, null, [ONE], { toString: () => ONE }]) {
    assert.equal(ID.test(typeof id === 'string' ? id : ''), false);
    assert.equal(log.request('POST', JSON.stringify({ id, n: 0, sent: DAY, events })).status, 400, JSON.stringify(id));
  }
  for (const text of ['', 'not json', 'null', '[]', '"text"', JSON.stringify({ id: ONE }), JSON.stringify({ id: ONE, n: 0, events: [] }), JSON.stringify({ id: ONE, n: 0, events: {} }), JSON.stringify({ id: ONE, n: 0, events: ['line\nbreak'] }), JSON.stringify({ id: ONE, n: 0, events: [[1]] }), JSON.stringify({ id: ONE, n: 0, events: [null] }), JSON.stringify({ id: ONE, n: '0', events }), JSON.stringify({ id: ONE, events })]) {
    assert.equal(log.request('POST', text).status, 400, text);
  }
  assert.equal(log.request('POST', null).status, 413); // longer than a post may be
  for (const method of ['PUT', 'DELETE', 'PATCH', 'HEAD']) assert.equal(log.request(method, batch(ONE, 0)).status, 405);
  assert.deepEqual(readdirSync(dir), []);
  assert.deepEqual(readdirSync(parent), ['logs']);

  // A record is stored as one line whatever is in it, so it cannot pass for a line of the server's own.
  log.request('POST', batch(ONE, 0, [{ k: 'mark', note: 'a\n{"k":"session","id":"forged"}' }]));
  const lines = read(join(dir, `2026-11-10-${ONE}.log.jsonl.gz`));
  assert.deepEqual(lines.map((e) => e.k), ['session', 'post', 'mark']);
});

test('a session stops at its size, and is told so', () => {
  const dir = temp();
  const log = createLog(dir, { sessionMax: 600, clock: () => DAY });
  const sizeOf = (id) => readdirSync(dir).filter((f) => f.includes(id)).reduce((sum, f) => sum + readFileSync(join(dir, f)).length, 0);
  let n = 0;
  let answer;
  while ((answer = log.request('POST', batch(ONE, n))).ok) {
    log.frame(ONE, DAY + n * 5000, [row('a1b2c3')]);
    assert.ok(++n < 20, 'it stops');
  }
  assert.deepEqual(answer, { status: 200, full: true });
  assert.ok(n >= 1 && sizeOf(ONE) <= 600);
  const size = sizeOf(ONE);
  log.frame(ONE, DAY + 500_000, [row('a1b2c3')]);
  assert.deepEqual(log.request('POST', batch(ONE, n + 1)), { status: 200, full: true });
  assert.equal(sizeOf(ONE), size, 'nothing more is written for it, feed included');
  // Another session still has its own room, and sharing is still offered.
  assert.deepEqual(log.request('POST', batch(TWO, 0)), { status: 200, ok: true });
  assert.deepEqual(log.request('GET', ''), { status: 200, on: true });
});

test('the directory stops at its size and its number of sessions, until some are deleted', () => {
  const dir = temp();
  let now = DAY;
  const MAX = 4 * MAX_POST;
  const log = createLog(dir, { dirMax: MAX, clock: () => now });
  const total = () => readdirSync(dir).reduce((sum, f) => sum + readFileSync(join(dir, f)).length, 0);
  const id = (i) => i.toString(16).padStart(16, '0');
  // About 30 KB a post once it is compressed: random text does not shrink much.
  const big = (session, n) => batch(session, n, [{ k: 'mark', note: randomBytes(30_000).toString('base64') }]);
  let i = 0;
  while (log.request('POST', big(id(i), 0)).ok) assert.ok(++i < 20, 'it stops taking new sessions');
  // New sessions stop while there is still room for one post, so none begins that could not store its first.
  assert.ok(i >= 3 && total() > MAX - MAX_POST && total() <= MAX);
  assert.deepEqual(log.request('GET', ''), { status: 200, on: false }, 'and the page no longer offers the switch');
  // Sessions under way go on to the very end of the room, and no further.
  let n = 1;
  while (log.request('POST', big(id(0), n)).ok) assert.ok(++n < 20, 'it stops');
  assert.ok(total() <= MAX && total() > MAX - MAX_POST);
  // The feed fills what is left and stops there too.
  const sky = (k) => Array.from({ length: 400 }, (_, j) => row(randomBytes(3).toString('hex'), { lat: 33 + (j + k) / 977 }));
  for (let k = 1; k <= 30; k++) log.frame(id(0), DAY + k * 5000, sky(k));
  const size = total();
  assert.ok(size <= MAX && size > MAX - 10_000);
  log.frame(id(0), DAY + 500_000, sky(0));
  assert.deepEqual(log.request('POST', big(id(0), n + 1)), { status: 200, full: true });
  assert.equal(total(), size, 'what does not fit is not written, in part or in whole');

  // Deleting sessions makes room again, without a restart, within a minute.
  for (const file of readdirSync(dir)) rmSync(join(dir, file));
  now += 61_000;
  assert.deepEqual(log.request('GET', ''), { status: 200, on: true });
  assert.deepEqual(log.request('POST', batch(id(50), 0)), { status: 200, ok: true });

  const few = createLog(temp(), { maxSessions: 2, clock: () => DAY });
  assert.equal(few.request('POST', batch(id(1), 0)).ok, true);
  assert.equal(few.request('POST', batch(id(2), 0)).ok, true);
  assert.deepEqual(few.request('POST', batch(id(3), 0)), { status: 200, full: true });
  assert.equal(few.request('POST', batch(id(2), 1)).ok, true, 'the sessions it has carry on');
  assert.deepEqual(few.request('GET', ''), { status: 200, on: false });
});

test('a file that is not a session, and a directory that stops taking writes, are left alone', () => {
  const dir = temp();
  writeFileSync(join(dir, 'notes.txt'), 'x'.repeat(5000));
  const log = createLog(dir, { dirMax: MAX_POST + 1000, clock: () => DAY });
  assert.equal(log.request('POST', batch(ONE, 0)).ok, true, "someone else's file does not count against the log");

  const gone = join(temp(), 'logs');
  const lost = createLog(gone, { clock: () => DAY });
  rmSync(dirname(gone), { recursive: true });
  const said = [];
  const print = console.log;
  console.log = (line) => said.push(line);
  try {
    assert.deepEqual(lost.request('POST', batch(ONE, 0)), { status: 200, full: true });
    assert.deepEqual(lost.request('POST', batch(TWO, 0)), { status: 200, full: true });
    assert.deepEqual(lost.request('GET', ''), { status: 200, on: false });
  } finally {
    console.log = print;
  }
  assert.deepEqual(said, ['The session log has stopped: ENOENT'], 'said once, and with nothing of the visitor in it');
  assert.equal(existsSync(gone), false);
});

test('a body longer than a post may be is given up on, without reading the rest', async () => {
  const req = (chunks, headers = {}) => Object.assign(Readable.from(chunks, { objectMode: false }), { headers });
  assert.equal(await body(req([Buffer.from('{"id":'), Buffer.from('"x"}')])), '{"id":"x"}');
  assert.equal(await body(req([Buffer.alloc(MAX_POST, 'a')])), 'a'.repeat(MAX_POST));
  assert.equal(await body(req([Buffer.alloc(MAX_POST, 'a'), Buffer.from('b')])), null);
  // One that says how long it is, is not read at all.
  let read = 0;
  const long = req((function* () { for (;;) (read++, yield Buffer.alloc(1024)); })(), { 'content-length': String(MAX_POST + 1) });
  assert.equal(await body(long), null);
  assert.equal(read, 0);
  // One that does not say, stops being listened to once it is too long.
  const endless = req((function* () { for (let i = 0; i < 1000; i++) (read++, yield Buffer.alloc(1024)); })());
  assert.equal(await body(endless), null);
  assert.equal(endless.listenerCount('data'), 0);
});

test('a file cut short by a server that stopped mid-write is read up to the cut', () => {
  const dir = temp();
  const log = createLog(dir, { clock: () => DAY });
  log.request('POST', batch(ONE, 0));
  log.request('POST', batch(ONE, 1, Array.from({ length: 40 }, (_, i) => ({ k: 'mark', at: DAY + i * 977, heard: i % 3 === 0 }))));
  const file = join(dir, `2026-11-10-${ONE}.log.jsonl.gz`);
  const whole = read(file);
  assert.equal(whole.length, 44);
  const data = readFileSync(file);
  writeFileSync(file, data.subarray(0, data.length - 30));
  const cut = read(file);
  assert.ok(cut.length >= 3 && cut.length < 44);
  assert.deepEqual(cut, whole.slice(0, cut.length));
});

test('a summary says when, where to 3 decimals, how long and how much, and trusts nothing in the file', () => {
  const events = [
    { k: 'session', v: 1, id: ONE, at: DAY },
    { k: 'post', n: 0, at: DAY, sent: DAY - 3200 },
    { k: 'site', at: DAY - 3300, lat: 33.93812345, lon: -118.44054321, elevM: 5, airports: ['KLAX'], env: 'outdoors' },
    { k: 'poll', at: DAY - 3250, windows: [] },
    { k: 'listen', at: DAY, rate: 48000 },
    { k: 'mic', at: DAY }, { k: 'mic', at: DAY + 1000 }, { k: 'mic', at: DAY + 2000 },
    { k: 'post', n: 1, at: DAY + 45 * 60_000, sent: DAY + 45 * 60_000 - 3900 },
    { k: 'poll', at: DAY + 5000, windows: [] },
    { k: 'pass', at: DAY + 9000, hex: 'a1b2c3' },
    { k: 'mark', at: DAY + 9000, heard: true }, { k: 'mark', at: DAY + 60_000, heard: false }, { k: 'mark', at: DAY + 90_000, heard: true },
    // Two stretches of spectrogram: 10 s + 10 s + 4 s, and later 6 s.
    { k: 'spec', from: DAY, at: DAY, rate: 8, cols: 80, bins: 304 }, { k: 'spec', from: DAY, at: DAY + 10_000, rate: 8, cols: 80, bins: 304 }, { k: 'spec', from: DAY, at: DAY + 20_000, rate: 8, cols: 32, bins: 304 },
    { k: 'spec', from: DAY + 300_000, at: DAY + 300_000, rate: 8, cols: 48, bins: 304 },
  ];
  assert.deepEqual(summary(events), { at: DAY, minutes: 45, where: '33.938, -118.441 outdoors', polls: 2, micS: 3, passes: 1, heard: 2, quiet: 1, stretches: 2, specMin: 0.5, clockS: 3.2 });
  // What a page posted is printed as numbers and one plain word, whatever it sent.
  const hostile = summary([{ k: 'session', at: DAY }, { k: 'post', at: DAY }, { k: 'site', lat: '\u001b[2J', lon: {}, env: '\u001b]0;owned\u0007' }]);
  assert.equal(hostile.where, 'NaN, NaN ?');
  assert.equal(hostile.clockS, null);
  const odd = summary([{ k: 'session', at: DAY }, { k: 'spec', from: 'x', cols: '\u001b[2J', rate: 0 }, { k: 'spec', from: {}, cols: 80, rate: 'fast' }]);
  assert.deepEqual([odd.stretches, odd.specMin], [1, 0]);
});

test('a chunk of spectrogram is kept as bytes in a file of its own, and only if it is the size it says', () => {
  const dir = temp();
  const log = createLog(dir, { clock: () => DAY });
  const good = chunk(DAY + 125);
  const bytes = Buffer.from(good.data, 'base64');
  // Too few bytes, too many, none, not text, a size that is no size, and one made to look right by lying about its columns.
  const small = chunk(DAY + 125, 3); // 912 bytes: base64 with no padding to hide behind
  const bad = [{ data: small.data.slice(0, -4) }, { data: `${small.data}AAAA` }, { data: '' }, { data: undefined }, { data: [1, 2] }, { cols: 0, data: '' }, { cols: -3 }, { cols: 2.5 }, { bins: '304' }, { cols: 3.0001 }, { bins: 0 }, { cols: 6, bins: 152.5 }, { cols: 4 }];
  for (const more of bad) assert.equal(log.request('POST', batch(ONE, 0, [{ k: 'mark', at: DAY, heard: true }, { ...small, ...more }])).status, 400, JSON.stringify(more).slice(0, 60));
  assert.deepEqual(readdirSync(dir), [], 'and nothing of such a post is kept');

  assert.deepEqual(log.request('POST', batch(ONE, 0, [good])), { status: 200, ok: true });
  assert.deepEqual(log.request('POST', batch(ONE, 1, [{ k: 'mark', at: DAY, heard: true }, chunk(DAY + 10_125, 3)])), { status: 200, ok: true });
  assert.deepEqual(readdirSync(dir).sort(), [`2026-11-10-${ONE}.log.jsonl.gz`, `2026-11-10-${ONE}.spec.bin.gz`]);
  // In the log, the chunk's line without its bytes; in the other file, the bytes as they were sent.
  const { data, ...head } = good;
  assert.deepEqual(read(join(dir, `2026-11-10-${ONE}.log.jsonl.gz`)).filter((e) => e.k === 'spec')[0], head);
  const [stretch] = spectrogram(join(dir, `2026-11-10-${ONE}.spec.bin.gz`));
  assert.deepEqual([stretch.from, stretch.rate, stretch.at.length, stretch.at[0], stretch.at[1], stretch.at[82]], [DAY, 8, 83, DAY + 125, DAY + 250, DAY + 10_375]);
  assert.deepEqual(Array.from(stretch.db[1], (db) => (db + 127.5) / 0.5), Array.from(bytes.subarray(304, 608)));
  assert.deepEqual([stretch.freqs.length, stretch.freqs[0], stretch.freqs[48]], [304, 50, 100]);

  // A file cut short mid-chunk is read up to the chunk before.
  const file = join(dir, `2026-11-10-${ONE}.spec.bin.gz`);
  const whole = readFileSync(file);
  writeFileSync(file, whole.subarray(0, whole.length - 200));
  assert.equal(spectrogram(file)[0].at.length, 80);
});

test('the sizes a session and the directory stop at hold for the spectrogram too, with a twelve-hour day to spare', () => {
  // One session's size is all three of its files together. The spectrogram stops an eighth short of
  // it, and the rest of the session goes on into that eighth.
  const dir = temp();
  const log = createLog(dir, { sessionMax: 100_000, clock: () => DAY });
  const sizeOf = (kind = '') => readdirSync(dir).filter((f) => f.includes(kind)).reduce((sum, f) => sum + readFileSync(join(dir, f)).length, 0);
  let n = 0;
  let answer;
  while ((answer = log.request('POST', batch(ONE, n, [chunk(DAY + n * 10_000)]))).spec !== false) assert.ok(answer.ok && ++n < 20, 'it stops');
  assert.deepEqual(answer, { status: 200, ok: true, spec: false });
  assert.ok(n === 3 && sizeOf() <= 87_500, `${n} chunks, ${sizeOf()} bytes`);
  const spec = sizeOf('spec');
  const lines = read(join(dir, readdirSync(dir).find((f) => f.includes('log')))).length;
  // A post with spectrogram and something else: the something else is kept, without the chunk's line.
  assert.deepEqual(log.request('POST', batch(ONE, ++n, [{ k: 'mark', at: DAY, heard: true }, chunk(DAY)])), { status: 200, ok: true, spec: false });
  const stored = read(join(dir, readdirSync(dir).find((f) => f.includes('log'))));
  assert.deepEqual(stored.slice(lines).map((e) => e.k), ['post', 'mark']);
  // The rest goes on until the session is full, and then stops too.
  while ((answer = log.request('POST', batch(ONE, ++n))).ok) {
    log.frame(ONE, DAY + n * 5000, [row('a1b2c3')]);
    assert.ok(n < 2000, 'it stops');
  }
  assert.deepEqual(answer, { status: 200, full: true }, 'and the rest of the session stops with it');
  assert.ok(sizeOf() <= 100_000 && sizeOf() > 95_000 && sizeOf('spec') === spec, `${sizeOf()} bytes`);
  log.frame(ONE, DAY, [row('a1b2c3')]);
  assert.ok(sizeOf() <= 100_000);

  // An hour with aircraft never out of earshot, stored for real: 360 chunks of the worst kind (random
  // bytes do not compress at all; real sound comes to two thirds of this), a feed frame of 45 aircraft
  // every 5 s, and the page's other records.
  const busy = temp();
  const hour = createLog(busy, { clock: () => DAY });
  const sky = Array.from({ length: 45 }, (_, i) => row(i.toString(16).padStart(6, '0'), { lat: 33.9 + i / 100, lon: -118.4 + i / 77, gs: 140.5 + i }));
  const other = Array.from({ length: 24 }, (_, i) => ({ k: 'mic', at: DAY + i, level: -61.2, background: -66.4, rise: 5.2, bands: Array.from({ length: 38 }, (_, b) => -70 - ((b * 7 + i) % 31)) }));
  for (let i = 0; i < 360; i++) {
    assert.deepEqual(hour.request('POST', batch(TWO, 2 * i, [chunk(DAY + i * 10_000)])), { status: 200, ok: true });
    assert.deepEqual(hour.request('POST', batch(TWO, 2 * i + 1, other)), { status: 200, ok: true });
    for (const k of [0, 1]) hour.frame(TWO, DAY + i * 10_000 + k * 5000, sky.map((ac) => ({ ...ac, seen_pos: (i * 7 + k) % 9 })));
  }
  const MB = 1024 * 1024;
  const size = readdirSync(busy).reduce((sum, f) => sum + readFileSync(join(busy, f)).length, 0);
  assert.ok(size > 9 * MB && size < 12 * MB, `${(size / MB).toFixed(1)} MB an hour at the very worst`);
  assert.ok(12 * size < SESSION_MAX * 0.6, 'a twelve-hour day is well inside what one session may keep');
  assert.ok(DIR_MAX >= 8 * SESSION_MAX && DIR_MAX >= 12 * 12 * size, 'and the directory holds a dozen such days');
});

test('a batch sent again after the server restarted is still not stored twice', () => {
  const dir = temp();
  const log = createLog(dir, { clock: () => DAY });
  log.request('POST', batch(ONE, 0));
  log.request('POST', batch(ONE, 1));
  // The server stops before its answer to batch 1 gets back, so the page sends it again to the next one.
  const again = createLog(dir, { clock: () => DAY });
  assert.deepEqual(again.request('POST', batch(ONE, 1)), { status: 200, ok: true });
  assert.deepEqual(again.request('POST', batch(ONE, 2)), { status: 200, ok: true });
  assert.deepEqual(read(join(dir, `2026-11-10-${ONE}.log.jsonl.gz`)).filter((e) => e.k === 'post').map((e) => e.n), [0, 1, 2]);
});

test('sessions are deleted once the day they began is 90 days old', () => {
  const dir = temp();
  const old = '2026-08-12'; // 90 days before DAY
  const kept = '2026-08-13';
  for (const day of [old, kept]) for (const kind of ['log.jsonl.gz', 'feed.jsonl.gz', 'spec.bin.gz']) writeFileSync(join(dir, `${day}-${ONE}.${kind}`), 'x');
  writeFileSync(join(dir, 'notes.txt'), 'not a session');
  const log = createLog(dir, { clock: () => DAY });
  assert.deepEqual(readdirSync(dir).sort(), [`${kept}-${ONE}.feed.jsonl.gz`, `${kept}-${ONE}.log.jsonl.gz`, `${kept}-${ONE}.spec.bin.gz`, 'notes.txt']);
  assert.equal(log.request('GET').on, true);
});

test('a batch that does not fit the directory is not stored in part, and is stored whole once there is room', () => {
  const dir = temp();
  const options = { dirMax: 100_000, clock: () => DAY };
  let log = createLog(dir, options);
  assert.deepEqual(log.request('POST', batch(ONE, 0)), { status: 200, ok: true });
  const file = (kind) => join(dir, `2026-11-10-${ONE}.${kind}.gz`);
  const before = readFileSync(file('log.jsonl'));
  // Another session fills the directory to 84.5 KB of its 100 KB.
  writeFileSync(join(dir, `2026-11-10-${TWO}.feed.jsonl.gz`), randomBytes(84_512 - before.length));
  log = createLog(dir, options);
  const mixed = batch(ONE, 1, [{ k: 'mark', at: DAY, heard: true }, chunk(DAY)]);
  assert.deepEqual(log.request('POST', mixed), { status: 200, full: true });
  assert.deepEqual(readFileSync(file('log.jsonl')), before, 'not its mark, nor its chunk\'s line');
  assert.equal(existsSync(file('spec.bin')), false);
  // After a restart, with room again, the page's repeat of it is stored, all of it.
  rmSync(join(dir, `2026-11-10-${TWO}.feed.jsonl.gz`));
  log = createLog(dir, options);
  assert.deepEqual(log.request('POST', mixed), { status: 200, ok: true });
  assert.deepEqual(read(file('log.jsonl')).map((e) => e.k), ['session', 'post', 'mark', 'post', 'mark', 'spec']);
  assert.equal(spectrogram(file('spec.bin'))[0].at.length, 80);
});

test('once a session\'s spectrogram has stopped, every answer says so: a repeat, and after a restart', () => {
  const dir = temp();
  const options = { sessionMax: 64_000, clock: () => DAY };
  let log = createLog(dir, options);
  const specs = () => readFileSync(join(dir, `2026-11-10-${ONE}.spec.bin.gz`)).length;
  let n = 0;
  while (log.request('POST', batch(ONE, n, [chunk(DAY + n * 10_000)])).spec !== false) assert.ok(++n < 10);
  const kept = specs();
  // The answer to that batch was lost, and the page sends it again.
  assert.deepEqual(log.request('POST', batch(ONE, n, [chunk(DAY + n * 10_000)])), { status: 200, ok: true, spec: false });
  // The server restarts: the repeat is answered the same, and a later chunk small enough to fit is still not kept.
  log = createLog(dir, options);
  assert.deepEqual(log.request('POST', batch(ONE, n, [chunk(DAY + n * 10_000)])), { status: 200, ok: true, spec: false });
  assert.deepEqual(log.request('POST', batch(ONE, n + 1, [chunk(DAY + 100_000, 1)])), { status: 200, ok: true, spec: false });
  assert.deepEqual(log.request('POST', batch(ONE, n + 2)), { status: 200, ok: true, spec: false });
  assert.equal(specs(), kept);
});
