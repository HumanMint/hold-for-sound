import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The server itself, run as `npm start` runs it, for what only shows with real requests.

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const temp = () => mkdtempSync(join(tmpdir(), 'hfs-server-'));
const wait = (ms) => new Promise((done) => setTimeout(done, ms));

// server.js on a port of its own, with nothing from this shell's settings. No `tailscale` on its PATH,
// so it listens on localhost only.
async function serve(t, env) {
  const port = 20_000 + Math.floor(Math.random() * 20_000);
  const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PATH: '/nonexistent', PORT: port, PASSWORD: '', REPLAY: '', RECEIVER: '', LOG_DIR: '', ...env } });
  t.after(() => child.kill());
  await new Promise((done, fail) => {
    child.stdout.on('data', (text) => String(text).includes('http://127.0.0.1') && done());
    child.on('exit', (code) => fail(new Error(`server.js exited with ${code}`)));
  });
  return `http://127.0.0.1:${port}`;
}

test('a recording of one snapshot is replayed as that snapshot, again and again', async (t) => {
  const file = join(temp(), 'one.jsonl');
  writeFileSync(file, `${JSON.stringify({ at: 1_800_000_000_000, ac: [{ hex: 'a1b2c3', lat: 33.94, lon: -118.4, alt_baro: 2000 }] })}\n`);
  const url = await serve(t, { REPLAY: file });
  for (let i = 0; i < 2; i++) {
    const res = await fetch(`${url}/api/aircraft?lat=33.938&lon=-118.440`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.deepEqual(data.ac.map((ac) => ac.hex), ['a1b2c3']);
    assert.ok(data.age < 1);
  }
});

test('a feed request given up on before its answer leaves nothing in the session log', async (t) => {
  // A receiver that takes 1.5 s to answer holds every feed answer back that long.
  const slow = http.createServer((req, res) => setTimeout(() => res.end(JSON.stringify({ now: Date.now() / 1000, aircraft: [] })), 1500));
  await new Promise((done) => slow.listen(0, '127.0.0.1', done));
  t.after(() => slow.close());
  const dir = temp();
  const url = await serve(t, { REPLAY: 'test/fixtures/lax.jsonl', LOG_DIR: dir, RECEIVER: `http://127.0.0.1:${slow.address().port}/aircraft.json` });
  const { id, token } = await (await fetch(`${url}/api/sharing`, { method: 'POST' })).json();
  const headers = { 'x-hfs-share': token };
  const posted = await fetch(`${url}/api/log`, { method: 'POST', headers, body: JSON.stringify({ id, n: 0, sent: Date.now(), events: [{ k: 'mark', at: Date.now(), heard: true }] }) });
  assert.deepEqual(await posted.json(), { ok: true });
  const feed = () => readdirSync(dir).filter((f) => f.endsWith('.feed.jsonl.gz'));

  // The page cancels this one request 100 ms after asking.
  const off = new AbortController();
  setTimeout(() => off.abort(), 100);
  await assert.rejects(fetch(`${url}/api/aircraft?lat=33.938&lon=-118.440&log=${id}`, { signal: off.signal, headers }), { name: 'AbortError' });
  await wait(2500);
  assert.deepEqual(feed(), [], 'nothing was written after the page gave up');

  // One that waits for its answer is kept.
  assert.equal((await fetch(`${url}/api/aircraft?lat=33.938&lon=-118.440&log=${id}`, { headers })).status, 200);
  assert.equal(feed().length, 1);
});

// Flight providers stood in for by `answer(host)`, on a clock moved by `at(ms)`; `calls()` lists the hosts asked.
function providers(answer) {
  const dir = temp();
  const [clock, calls, mock] = ['clock', 'calls', 'fetch.mjs'].map((name) => join(dir, name));
  writeFileSync(clock, '0');
  writeFileSync(calls, '');
  writeFileSync(mock, `import { readFileSync, appendFileSync } from 'node:fs';
    const realNow = Date.now; Date.now = () => realNow() + Number(readFileSync(${JSON.stringify(clock)}, 'utf8'));
    globalThis.fetch = async (url) => { const host = new URL(url).hostname; appendFileSync(${JSON.stringify(calls)}, host + '\\n'); return (${answer})(host); };`);
  return {
    env: { NODE_OPTIONS: `--import=${mock}` },
    at: (ms) => writeFileSync(clock, String(ms)),
    calls: () => readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean),
  };
}

test('without PUBLIC_HOST too, a provider that said to wait is not asked again until then', async (t) => {
  // Both providers say 6 hours. The page asks again within a minute (feed.js): the server answers
  // from the pause, and asks neither.
  const up = providers(() => new Response('rate limit exceeded', { status: 429, headers: { 'retry-after': '21600' } }));
  const url = await serve(t, up.env);
  const first = await fetch(`${url}/api/aircraft?lat=34&lon=-118`);
  assert.equal(first.status, 429);
  assert.ok(Number(first.headers.get('retry-after')) >= 21_590);
  assert.deepEqual(up.calls(), ['api.adsb.lol', 'opendata.adsb.fi']);
  up.at(61_000);
  const again = await fetch(`${url}/api/aircraft?lat=34&lon=-118`);
  assert.equal(again.status, 429);
  assert.ok(Math.abs(Number(again.headers.get('retry-after')) - 21_539) <= 2, again.headers.get('retry-after'));
  assert.equal(up.calls().length, 2, 'neither provider was asked again');
});

test('without PUBLIC_HOST, a pause from adsb.lol leaves adsb.fi in use, and asks adsb.lol no more meanwhile', async (t) => {
  const up = providers((host) => (host === 'api.adsb.lol' ? new Response('', { status: 429, headers: { 'retry-after': '21600' } }) : Response.json({ ac: [], now: Date.now() })));
  const url = await serve(t, up.env);
  for (const ms of [0, 61_000, 3600_000]) {
    up.at(ms);
    const res = await fetch(`${url}/api/aircraft?lat=34&lon=-118`);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).source, 'opendata.adsb.fi');
  }
  assert.deepEqual(up.calls(), ['api.adsb.lol', 'opendata.adsb.fi', 'opendata.adsb.fi', 'opendata.adsb.fi']);
  up.at(21_601_000);
  await fetch(`${url}/api/aircraft?lat=34&lon=-118`);
  assert.equal(up.calls().at(-2), 'api.adsb.lol', 'and asks it again once its pause is over');
});
