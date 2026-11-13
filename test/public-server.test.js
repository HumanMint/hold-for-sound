import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { read } from '../log.js';

// Every test server answers the runway table from TEST_RUNWAYS (none, unless a test gives some).
const RUNWAYS = new URL('fixtures/runways.mjs', import.meta.url).pathname;
// Exercise the actual server and its environment, not a second copy of the request guard.
async function server(t, extra = {}) {
  const reserve = http.createServer();
  reserve.listen(0, '127.0.0.1');
  await once(reserve, 'listening');
  const port = reserve.address().port;
  const statsReserve = http.createServer();
  statsReserve.listen(0, '127.0.0.1');
  await once(statsReserve, 'listening');
  const statsPort = statsReserve.address().port;
  await new Promise((done) => statsReserve.close(done));
  await new Promise((done) => reserve.close(done));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, PORT: String(port), OWNER_PORT: String(statsPort), PUBLIC_HOST: 'example.test', PASSWORD: '', LOG_DIR: '', RECEIVER: '', REPLAY: 'test/fixtures/lax.jsonl', ...extra, NODE_OPTIONS: `${extra.NODE_OPTIONS ?? ''} --import=${RUNWAYS}`.trim() },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => child.kill());
  await Promise.race([
    new Promise((ready) => {
      let output = '';
      child.stdout.on('data', (chunk) => {
        output += chunk;
        if (output.includes(`http://127.0.0.1:${port}`) && output.includes(`Stats on 127.0.0.1:${statsPort}`)) ready();
      });
    }),
    once(child, 'exit').then(([code]) => { throw new Error(`server exited ${code}`); }),
    new Promise((_, fail) => { const timer = setTimeout(() => fail(new Error('server did not start')), 5000); timer.unref(); }),
  ]);
  const request = (path, headers = {}, method = 'GET', targetPort = port, payload) => new Promise((done, fail) => {
    const req = http.request({ host: '127.0.0.1', port: targetPort, path, method, headers: { host: targetPort === port ? 'example.test' : `127.0.0.1:${targetPort}`, ...(method !== 'GET' ? { origin: 'https://example.test' } : {}), ...headers } }, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => done({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', fail);
    req.end(payload);
  });
  return { request, statsPort, port, child };
}
const stop = async ({ child }) => { child.kill(); await once(child, 'exit'); };

test('public mode keeps the stats private, refuses unconsented uploads and bounds callers', async (t) => {
  const { request, statsPort } = await server(t);
  const stats = await request('/api/stats', {}, 'GET', statsPort);
  assert.equal(stats.status, 200);
  assert.ok(JSON.parse(stats.body).activity);
  for (const headers of [{ origin: 'https://evil.example' }, { 'x-forwarded-for': '' }, { 'cf-connecting-ip': '192.0.2.3' }, { host: 'evil.example' }]) {
    assert.equal((await request('/api/stats', headers, 'GET', statsPort)).status, 404);
  }
  const page = await request('/');
  assert.equal(page.status, 200);
  assert.equal(page.headers['cache-control'], 'no-store');
  assert.equal((await request('/page.css')).headers['cache-control'], 'no-store');
  const about = await request('/about.html');
  assert.equal(about.status, 200);
  assert.equal(about.headers['cache-control'], 'no-store');
  assert.doesNotMatch(about.body, /<script/, 'the notices page needs no script, so the CSP never blocks it');
  assert.match(page.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.equal(page.headers['referrer-policy'], 'strict-origin');
  for (const [, script] of page.body.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
    const hash = createHash('sha256').update(script).digest('base64');
    assert.ok(page.headers['content-security-policy'].includes(`'sha256-${hash}'`), 'existing inline redirect is explicitly allowed');
  }
  assert.equal((await request('/', { host: 'other.example' })).status, 404);
  for (const headers of [{}, { 'x-forwarded-for': '' }, { 'x-forwarded-for': '127.0.0.1', 'cf-connecting-ip': '127.0.0.1' }]) {
    assert.equal((await request('/api/stats', headers)).status, 404);
  }
  assert.deepEqual(JSON.parse((await request('/api/log')).body), { on: false });
  assert.equal((await request('/api/log', {}, 'POST')).status, 403);
  assert.equal((await request('/api/aircraft?lat=33.938&lon=-118.440')).status, 200);
  for (let i = 0; i < 300; i++) assert.equal((await request('/api/log', { 'cf-connecting-ip': '192.0.2.1' })).status, 200);
  assert.equal((await request('/api/log', { 'cf-connecting-ip': '192.0.2.1' })).status, 429);
  assert.equal((await request('/other/../api/log', { 'cf-connecting-ip': '192.0.2.1' })).status, 429);
  assert.equal((await request('http://example.test/api/log')).status, 400);
  assert.equal((await request('/api/log', { 'cf-connecting-ip': '192.0.2.2' })).status, 200);
});


test('only active opt-in permits optional activity and session writes; revocation fences pending uploads', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hfs-consent-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const mock = join(dir, 'fetch.mjs');
  const release = join(dir, 'release');
  await writeFile(mock, `import { existsSync } from 'node:fs'; globalThis.fetch = async (url) => {
    if (String(url).includes('nominatim')) return Response.json([{display_name:'Private house',lat:'34.0522',lon:'-118.2437'}]);
    if (String(url).includes('open-meteo')) { while (String(url).includes('latitude=34.060') && !existsSync(${JSON.stringify(release)})) await new Promise(done=>setTimeout(done,5)); return Response.json({elevation:[30]}); }
    return new Response('');
  };`);
  const logs = join(dir, 'logs');
  const { request, statsPort, port } = await server(t, { LOG_DIR: logs, NODE_OPTIONS: `--import=${mock}` });
  const geo = { 'cf-connecting-ip': '192.0.2.4', 'x-hfs-country': 'US', 'x-hfs-city': 'Test city', 'x-hfs-lat': '34.052', 'x-hfs-lon': '-118.244' };
  const activity = async () => JSON.parse((await request('/api/stats', {}, 'GET', statsPort)).body).activity;
  assert.deepEqual(JSON.parse((await request('/api/log')).body), { on: true });
  await request('/', geo);
  await request('/api/aircraft?lat=34&lon=-118&log=0123456789abcdef', geo);
  assert.deepEqual((await activity()).regions, []);
  assert.deepEqual(await readdir(logs), []);
  await request('/api/geocode?q=Private%20house', geo);
  assert.deepEqual((await activity()).searches, []);
  assert.equal((await request('/api/log', geo, 'POST', port, '{}')).status, 403);
  assert.equal((await request('/api/sharing', { origin: 'https://evil.example' }, 'POST')).status, 403);
  assert.equal((await request('/api/sharing', {}, 'POST', port, '{}')).status, 413);
  const granted = await request('/api/sharing', geo, 'POST');
  assert.equal(granted.status, 200);
  assert.equal((await activity()).regions[0].pages, 1, 'starting a grant is the one visit counted');
  const grant = JSON.parse(granted.body);
  assert.match(grant.id, /^[0-9a-f]{16}$/);
  const headers = { ...geo, 'x-hfs-share': grant.token };
  const batch = (n) => JSON.stringify({ id: grant.id, n, events: [{ k: 'mark', at: Date.now(), heard: true }] });
  assert.equal((await request('/api/log', headers, 'POST', port, batch(0))).status, 200);
  assert.ok((await readdir(logs)).length);
  assert.equal((await activity()).regions.length, 1);
  assert.equal((await activity()).regions[0].count, 1, 'an upload is not a visit');
  await request('/api/geocode?q=34.05,-118.24', headers);
  assert.equal((await activity()).searches[0].lat, 34.05);
  assert.doesNotMatch(JSON.stringify(await activity()), /Private house/);
  const searchesBefore = JSON.stringify((await activity()).searches);
  const before = (await activity()).regions[0].count;
  // Keep a body pending at the server, then revoke before its final chunk arrives.
  const packet = batch(1);
  let pending;
  const response = new Promise((done, fail) => {
    pending = http.request({ host: '127.0.0.1', port, path: '/api/log', method: 'POST', headers: { host: 'example.test', origin: 'https://example.test', ...headers, 'content-length': Buffer.byteLength(packet) } }, (res) => { res.resume(); res.on('end', () => done(res.statusCode)); });
    pending.on('error', fail);
    pending.write(packet.slice(0, 8));
  });
  pending.flushHeaders();
  await new Promise(done=>setTimeout(done,200)); // the pending request reaches the server before revocation
  const lookup = request('/api/geocode?q=34.06,-118.25', headers);
  for (let i = 0; i < 300; i++) await request('/api/log', geo);
  assert.equal((await request('/api/log', geo)).status, 429, 'quota really is exhausted before withdrawal');
  assert.equal((await request('/api/log', geo)).status, 429);
  assert.equal((await request('/api/sharing', headers, 'DELETE')).status, 200);
  pending.end(packet.slice(8));
  await writeFile(release, 'release');
  assert.equal(await response, 403);
  assert.equal((await lookup).status, 200, 'normal lookup still completes after opting out');
  assert.equal(JSON.stringify((await activity()).searches), searchesBefore, 'lookup completion after revocation adds no activity');
  const file = (await readdir(logs)).find(name=>name.endsWith('.log.jsonl.gz'));
  assert.deepEqual(read(join(logs,file)).filter(row=>row.k==='post').map(row=>row.n), [0]);
  assert.equal((await request('/api/log', { ...headers, 'cf-connecting-ip':'192.0.2.5' }, 'POST', port, batch(2))).status, 403);
  const afterOff = (await activity()).regions[0].count;
  await request('/', { ...headers, 'cf-connecting-ip':'192.0.2.5' });
  assert.equal((await activity()).regions[0].count, afterOff);
  assert.equal(afterOff, before);
});

test('provider throttling pauses every location including queued requests, then recovers', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hfs-feed-backoff-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const clock = join(dir, 'clock');
  const calls = join(dir, 'calls');
  const mock = join(dir, 'fetch.mjs');
  await writeFile(clock, '0');
  await writeFile(calls, '');
  await writeFile(mock, `import { readFileSync, appendFileSync } from 'node:fs';
    const realNow = Date.now; Date.now = () => realNow() + Number(readFileSync(${JSON.stringify(clock)}, 'utf8'));
    let n = 0;
    globalThis.fetch = async () => {
      appendFileSync(${JSON.stringify(calls)}, 'call\\n');
      if (++n === 3) return Response.json({ ac: [], now: Date.now() });
      return new Response('rate limit exceeded', { status: 429, headers: n === 1 ? { 'retry-after': '120' } : {} });
    };`);
  const { request } = await server(t, { REPLAY: '', NODE_OPTIONS: `--import=${mock}` });
  const count = async () => readFile(calls, 'utf8').then(text => text.trim().split('\n').filter(Boolean).length);
  const [first, queued] = await Promise.all([
    request('/api/aircraft?lat=34&lon=-118'), request('/api/aircraft?lat=35&lon=-118'),
  ]);
  assert.equal(first.status, 429);
  assert.ok(Number(first.headers['retry-after']) >= 119);
  assert.equal(queued.status, 429);
  assert.equal(await count(), 1, 'queued requests do not hammer an already throttled provider');
  await writeFile(clock, '121000');
  const again = await request('/api/aircraft?lat=36&lon=-118');
  assert.equal(again.status, 429);
  assert.ok(Number(again.headers['retry-after']) >= 119, 'a repeated throttle doubles the fallback delay');
  await writeFile(clock, '180000');
  assert.equal((await request('/api/aircraft?lat=37&lon=-118')).status, 429);
  assert.equal(await count(), 2);
  await writeFile(clock, '245000');
  const recovered = await request('/api/aircraft?lat=38&lon=-118');
  assert.equal(recovered.status, 200);
  assert.deepEqual(JSON.parse(recovered.body).ac, []);
  const reset = await request('/api/aircraft?lat=39&lon=-118', { 'cf-connecting-ip': '192.0.2.9' }); // a sixth place: another client
  assert.equal(reset.status, 429);
  assert.equal(reset.headers['retry-after'], '60', 'success resets the backoff');
});

test('a malformed successful upstream response never becomes an empty fresh sky', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hfs-feed-malformed-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const mock = join(dir, 'fetch.mjs');
  await writeFile(mock, `globalThis.fetch = async url => String(url).includes('/35.000/')
    ? new Response('upstream authentication failure', { status: 401 })
    : String(url).includes('/36.000/') ? new Response('maintenance', { status: 503, headers: { 'retry-after': '3600' } })
    : Response.json({ error: 'not aircraft data' });`);
  const { request } = await server(t, { REPLAY: '', NODE_OPTIONS: `--import=${mock}` });
  const response = await request('/api/aircraft?lat=34&lon=-118');
  assert.equal(response.status, 502);
  assert.equal(JSON.parse(response.body).ac, undefined);
  assert.equal((await request('/api/aircraft?lat=35&lon=-118')).status, 502, 'upstream 401 must not look like a site login challenge');
  const maintenance = await request('/api/aircraft?lat=36&lon=-118');
  assert.equal(maintenance.status, 502);
  assert.equal(maintenance.headers['retry-after'], undefined, 'non-429 upstream errors do not pause one browser independently');
});

test('an exhausted provider quota pauses every location until its reset, then recovers', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hfs-quota-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const clock = join(dir, 'clock');
  const calls = join(dir, 'calls');
  const mock = join(dir, 'fetch.mjs');
  await writeFile(clock, '0');
  await writeFile(calls, '');
  await writeFile(mock, `import { readFileSync, appendFileSync } from 'node:fs';
    const realNow = Date.now; Date.now = () => realNow() + Number(readFileSync(${JSON.stringify(clock)}, 'utf8'));
    let n = 0;
    globalThis.fetch = async () => {
      appendFileSync(${JSON.stringify(calls)}, 'call\\n');
      if (++n === 1) return new Response('rate limit exceeded', { status: 429, headers: {
        'retry-after': '9', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '3600'
      } });
      return Response.json({ ac: [], now: Date.now() });
    };`);
  const { request } = await server(t, { REPLAY: '', NODE_OPTIONS: `--import=${mock}` });
  const first = await request('/api/aircraft?lat=34&lon=-118');
  assert.equal(first.status, 429);
  assert.equal(JSON.parse(first.body).code, 'flight_quota');
  assert.ok(Number(first.headers['retry-after']) >= 3599);
  await writeFile(clock, '960000');
  const paused = await request('/api/aircraft?lat=35&lon=-118');
  assert.equal(paused.status, 429);
  assert.equal(JSON.parse(paused.body).code, 'flight_quota');
  assert.ok(Number(paused.headers['retry-after']) >= 2638);
  assert.equal((await readFile(calls, 'utf8')).trim(), 'call', 'no provider retry after the ordinary 15-minute backoff');
  await writeFile(clock, '3601000');
  const recovered = await request('/api/aircraft?lat=36&lon=-118');
  assert.equal(recovered.status, 200);
  assert.deepEqual(JSON.parse(recovered.body).ac, []);
});

test('a free flight key reaches only adsb.lol and never public responses or geocoding', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hfs-key-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const mock = join(dir, 'fetch.mjs');
  await writeFile(mock, `import assert from 'node:assert/strict';
    globalThis.fetch = async (url, options) => {
      if (new URL(url).hostname === 'api.adsb.lol') {
        assert.equal(options.headers['x-api-key'], 'test-only-key');
        return Response.json({ ac: [], now: Date.now() });
      }
      assert.equal(options?.headers?.['x-api-key'], undefined);
      if (String(url).includes('nominatim')) return Response.json([]);
      return Response.json({});
    };`);
  const { request } = await server(t, { REPLAY: '', ADSB_LOL_KEY: 'test-only-key', NODE_OPTIONS: `--import=${mock}` });
  const feed = await request('/api/aircraft?lat=34&lon=-118');
  assert.equal(feed.status, 200);
  assert.doesNotMatch(feed.body + JSON.stringify(feed.headers), /test-only-key|x-api-key/);
  assert.equal((await request('/api/geocode?q=Public%20test')).status, 404);
  assert.doesNotMatch((await request('/')).body, /test-only-key/);
});

test('one client address watches a few places and looks up a few addresses per 10 minutes', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hfs-places-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const mock = join(dir, 'fetch.mjs');
  await writeFile(mock, `const wait = setTimeout; globalThis.setTimeout = (fn, ms, ...rest) => wait(fn, Math.min(ms, 1), ...rest);
    globalThis.fetch = async (url) => String(url).includes('nominatim') ? Response.json([]) : new Response('', { status: 500 });`);
  const { request } = await server(t, { NODE_OPTIONS: `--import=${mock}` });
  const me = { 'cf-connecting-ip': '192.0.2.10' };
  for (let i = 0; i < 5; i++) assert.equal((await request(`/api/aircraft?lat=3${i}&lon=-118`, me)).status, 200);
  const sixth = await request('/api/aircraft?lat=39&lon=-118', me);
  assert.equal(sixth.status, 429);
  assert.ok(Number(sixth.headers['retry-after']) > 590);
  assert.equal((await request('/api/aircraft?lat=30.0001&lon=-118', me)).status, 200, 'the same place, rounded, is not a new one');
  assert.equal((await request('/api/aircraft?lat=39&lon=-118', { 'cf-connecting-ip': '192.0.2.11' })).status, 200, 'another address is not held back');
  for (let i = 0; i < 10; i++) assert.equal((await request(`/api/geocode?q=Street%20${i}`, me)).status, 404);
  assert.equal((await request('/api/geocode?q=street%200', me)).status, 404, 'an address already looked up is not a new one');
  assert.equal((await request('/api/geocode?q=Street%2010', me)).status, 429);
});

test('a full cache forgets its oldest answer, not every answer', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hfs-evict-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const calls = join(dir, 'calls');
  const mock = join(dir, 'fetch.mjs');
  await writeFile(calls, '');
  // The queues' gaps are cut to a millisecond, so hundreds of upstream calls take no time.
  await writeFile(mock, `import { appendFileSync } from 'node:fs';
    const wait = setTimeout; globalThis.setTimeout = (fn, ms, ...rest) => wait(fn, Math.min(ms, 1), ...rest);
    globalThis.fetch = async (url) => {
      appendFileSync(${JSON.stringify(calls)}, new URL(url).hostname + '\\n');
      if (String(url).includes('nominatim')) return Response.json([]);
      return Response.json({ ac: [], now: Date.now() });
    };`);
  const { request } = await server(t, { REPLAY: '', NODE_OPTIONS: `--import=${mock}` });
  const count = async (host) => (await readFile(calls, 'utf8')).split('\n').filter((line) => line === host).length;
  const ip = (i) => ({ 'cf-connecting-ip': `10.0.${i >> 8}.${i & 255}` });
  for (let i = 0; i < 202; i++) assert.equal((await request(`/api/aircraft?lat=${i / 100}&lon=0`, ip(i))).status, 200);
  assert.equal(await count('api.adsb.lol'), 202);
  assert.equal((await request('/api/aircraft?lat=1&lon=0', ip(100))).status, 200);
  assert.equal(await count('api.adsb.lol'), 202, 'a place among the newest 200 is still answered from memory');
  for (let i = 0; i < 502; i++) assert.equal((await request(`/api/geocode?q=Street%20${i}`, ip(Math.floor(i / 10)))).status, 404);
  assert.equal(await count('nominatim.openstreetmap.org'), 502);
  assert.equal((await request('/api/geocode?q=Street%20300', ip(30))).status, 404);
  assert.equal(await count('nominatim.openstreetmap.org'), 502, 'an address among the newest 500 is still answered from memory');
});

// An airliner 5 km south of a place at 34,-118, low and inbound: an answer with it in is busy (cadence.js).
const BUSY = '[{ hex: "abc123", lat: 33.955, lon: -118, alt_baro: 3000, gs: 250, track: 0, seen_pos: 0 }]';

test('in public a busy sky\'s answer serves a place for 10 s, and adsb.lol stops before its daily budget, key or no key', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hfs-budget-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const clock = join(dir, 'clock');
  const calls = join(dir, 'calls');
  const mock = join(dir, 'fetch.mjs');
  await writeFile(clock, '0');
  await writeFile(calls, '');
  await writeFile(mock, `import { readFileSync, appendFileSync } from 'node:fs';
    const realNow = Date.now; Date.now = () => realNow() + Number(readFileSync(${JSON.stringify(clock)}, 'utf8'));
    globalThis.fetch = async () => { appendFileSync(${JSON.stringify(calls)}, 'call\\n'); return Response.json({ ac: ${BUSY}, now: Date.now() }); };`);
  const { request } = await server(t, { REPLAY: '', ADSB_LOL_DAY: '2', NODE_OPTIONS: `--import=${mock}` });
  const count = async () => (await readFile(calls, 'utf8')).trim().split('\n').filter(Boolean).length;
  assert.equal(JSON.parse((await request('/api/aircraft?lat=34&lon=-118')).body).every, 10);
  await writeFile(clock, '8000');
  assert.equal((await request('/api/aircraft?lat=34&lon=-118')).status, 200);
  assert.equal(await count(), 1, 'answered from memory for 10 s');
  await writeFile(clock, '11000');
  assert.equal((await request('/api/aircraft?lat=34&lon=-118')).status, 200);
  assert.equal(await count(), 2);
  const over = await request('/api/aircraft?lat=35&lon=-118');
  assert.equal(over.status, 429);
  assert.equal(JSON.parse(over.body).code, 'flight_quota');
  assert.ok(Math.abs(Number(over.headers['retry-after']) - 86_400) < 30, `paused until a day after the first request, got ${over.headers['retry-after']}`);
  assert.equal(await count(), 2, 'no request past the budget');
  await writeFile(clock, String(86_400_000 + 1000));
  assert.equal((await request('/api/aircraft?lat=35&lon=-118')).status, 200, 'a day later it goes on');
});

test('in public a quiet sky\'s answer serves a place for a minute, and the server, not the page, decides', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hfs-cadence-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const clock = join(dir, 'clock');
  const sky = join(dir, 'sky');
  const calls = join(dir, 'calls');
  const mock = join(dir, 'fetch.mjs');
  await writeFile(clock, '0');
  await writeFile(sky, 'quiet');
  await writeFile(calls, '');
  await writeFile(mock, `import { readFileSync, appendFileSync } from 'node:fs';
    const realNow = Date.now; Date.now = () => realNow() + Number(readFileSync(${JSON.stringify(clock)}, 'utf8'));
    const wait = setTimeout; globalThis.setTimeout = (fn, ms, ...rest) => wait(fn, Math.min(ms, 1), ...rest);
    globalThis.fetch = async () => {
      appendFileSync(${JSON.stringify(calls)}, 'call\\n');
      return Response.json({ ac: readFileSync(${JSON.stringify(sky)}, 'utf8') === 'busy' ? ${BUSY} : [], now: Date.now() });
    };`);
  const { request } = await server(t, { REPLAY: '', NODE_OPTIONS: `--import=${mock}` });
  const count = async () => (await readFile(calls, 'utf8')).trim().split('\n').filter(Boolean).length;
  const at = async (s, path = '/api/aircraft?lat=34&lon=-118') => {
    await writeFile(clock, String(s * 1000));
    const res = await request(path);
    assert.equal(res.status, 200);
    return JSON.parse(res.body);
  };
  assert.equal((await at(0)).every, 60);
  const old = await at(59);
  assert.equal(await count(), 1, 'answered from memory for a minute');
  assert.ok(old.age >= 58 && old.age < 60, `the page is told how old it is: ${old.age}`);
  assert.equal((await at(61)).every, 60);
  assert.equal(await count(), 2);
  await writeFile(sky, 'busy');
  assert.equal((await at(100, '/api/aircraft?lat=34&lon=-118&every=1')).every, 60, 'a page cannot ask for faster updates');
  assert.equal(await count(), 2);
  assert.equal((await at(122)).every, 10, 'the next answer has an aircraft inbound');
  assert.equal((await at(130)).every, 10);
  assert.equal(await count(), 3, 'answered from memory for 10 s');
  await at(133);
  assert.equal(await count(), 4);
  await writeFile(sky, 'quiet');
  assert.equal((await at(144)).every, 60, 'gone quiet again');
  await at(200);
  assert.equal(await count(), 5);
});

test('a night of quiet sky, polled every 5 s, costs at most 60 adsb.lol requests an hour: 900 a day last 15 hours', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hfs-night-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const clock = join(dir, 'clock');
  const calls = join(dir, 'calls');
  const mock = join(dir, 'fetch.mjs');
  await writeFile(clock, '0');
  await writeFile(calls, '');
  await writeFile(mock, `import { readFileSync, appendFileSync } from 'node:fs';
    const realNow = Date.now; Date.now = () => realNow() + Number(readFileSync(${JSON.stringify(clock)}, 'utf8'));
    const wait = setTimeout; globalThis.setTimeout = (fn, ms, ...rest) => wait(fn, Math.min(ms, 1), ...rest);
    globalThis.fetch = async () => { appendFileSync(${JSON.stringify(calls)}, 'call\\n'); return Response.json({ ac: [], now: Date.now() }); };`);
  const { request } = await server(t, { REPLAY: '', NODE_OPTIONS: `--import=${mock}` });
  const count = async () => (await readFile(calls, 'utf8')).trim().split('\n').filter(Boolean).length;
  // The page asks every 5 s, so a minute's answer is replaced by the poll at 60 s or the one at 65 s,
  // as the polls fall: here time runs on between them, so at 60.
  for (let s = 0; s < 3600; s += 5) {
    await writeFile(clock, String(s * 1000));
    assert.equal((await request('/api/aircraft?lat=34&lon=-118')).status, 200);
  }
  const hour = await count();
  assert.ok(hour >= Math.ceil(3600 / 65) && hour <= 60, `${hour} an hour`);
  // A busy hour, at 10 s answers, is 240 to 360: 900 would last under 4 hours.
  assert.ok(hour * 15 <= 900, `${hour} an hour: 15 hours cost ${hour * 15}`);
});

// A runway as OurAirports lists it, running east-west about 1 km south of 34,-118.
const RUNWAY_CSV = 'id,airport_ref,airport_ident,length_ft,width_ft,surface,lighted,closed,le_ident,le_latitude_deg,le_longitude_deg,le_elevation_ft,le_heading_degT,le_displaced_threshold_ft,he_ident,he_latitude_deg,he_longitude_deg,he_elevation_ft\n'
  + '1,1,KTST,8000,150,ASP,1,0,09,33.99,-118.02,100,90,0,27,33.99,-117.98,100\n';

test('beside a runway a quiet sky is asked about every 30 s: a quiet night there costs at most 120 adsb.lol requests an hour', async (t) => {
  const up = await upstream(t, () => Response.json({ ac: [], now: Date.now() }));
  const quick = join(up.dir, 'timeout.mjs'); // the queue's 1.6 s gap cut to a millisecond
  await writeFile(quick, 'const wait = setTimeout; globalThis.setTimeout = (fn, ms, ...rest) => wait(fn, Math.min(ms, 1), ...rest);');
  const s = await server(t, { ...up.env, TEST_RUNWAYS: RUNWAY_CSV, NODE_OPTIONS: `${up.env.NODE_OPTIONS} --import=${quick}` });
  const ask = async (sec, lat) => {
    await up.at(sec * 1000);
    const res = await s.request(`/api/aircraft?lat=${lat}&lon=-118`);
    assert.equal(res.status, 200);
    return JSON.parse(res.body).every;
  };
  assert.equal(await ask(0, 35), 60, 'no runway near');
  assert.equal(await ask(0, 34), 30, 'a runway 1 km away');
  assert.equal(await ask(29, 34), 30);
  assert.equal(await up.count(), 2, 'answered from memory for 30 s');
  assert.equal(await ask(31, 34), 30);
  assert.equal(await up.count(), 3);
  // The page asks every 5 s, so a 30 s answer is replaced by the poll at 30 s or the one at 35 s.
  for (let sec = 35; sec < 3635; sec += 5) await ask(sec, 34);
  const hour = (await up.count()) - 3;
  assert.ok(hour >= Math.floor(3600 / 35) && hour <= 120, `${hour} an hour`);
});

test('a place nobody asks about is forgotten a minute after its answer runs out, ten where aircraft are on the ground', async (t) => {
  // The maintenance timer runs every 50 ms instead of every minute.
  const up = await upstream(t, () => Response.json({ ac: [{ hex: 'aaa111', lat: 33.99, lon: -118, alt_baro: 'ground', gs: 0, seen_pos: 0 }], now: Date.now() }));
  const fast = join(up.dir, 'interval.mjs');
  await writeFile(fast, 'const every = setInterval; globalThis.setInterval = (fn, ms, ...rest) => every(fn, Math.min(ms, 50), ...rest);');
  const s = await server(t, { ...up.env, NODE_OPTIONS: `${up.env.NODE_OPTIONS} --import=${fast}` });
  const ask = async (sec) => {
    await up.at(sec * 1000);
    await new Promise((done) => setTimeout(done, 200)); // a sweep or two at this time
    const res = await s.request('/api/aircraft?lat=34&lon=-118');
    assert.equal(res.status, 200);
    return JSON.parse(res.body).every;
  };
  // An aircraft parked 1 km away: new at first, so a taxi; 10 minutes on, known and still, so quiet.
  assert.equal(await ask(0), 10);
  assert.equal(await ask(601), 60);
  // Asked again within ten minutes of that answer running out, the place still knows it was parked.
  assert.equal(await ask(601 + 60 + 590), 60);
  // Left for longer, the place is forgotten: the aircraft is new again, and counts as a taxi.
  assert.equal(await ask(601 + 60 + 590 + 60 + 610), 10);
  assert.equal(await up.count(), 4);
});

test('a provider reset delay longer than a day is held to a day', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hfs-reset-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const mock = join(dir, 'fetch.mjs');
  await writeFile(mock, `globalThis.fetch = async () => new Response('rate limit exceeded', { status: 429, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '99999999' } });`);
  const { request } = await server(t, { REPLAY: '', NODE_OPTIONS: `--import=${mock}` });
  const first = await request('/api/aircraft?lat=34&lon=-118');
  assert.equal(first.status, 429);
  assert.ok(Number(first.headers['retry-after']) <= 86_400, first.headers['retry-after']);
});

test('sharing: three grants per client address, and posts capped per grant and per address each hour', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hfs-share-caps-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const clock = join(dir, 'clock');
  const mock = join(dir, 'clock.mjs');
  await writeFile(clock, '0');
  await writeFile(mock, `import { readFileSync } from 'node:fs';
    const realNow = Date.now; Date.now = () => realNow() + Number(readFileSync(${JSON.stringify(clock)}, 'utf8'));`);
  const { request, port } = await server(t, { LOG_DIR: join(dir, 'logs'), NODE_OPTIONS: `--import=${mock}` });
  const grant = async (ip) => JSON.parse((await request('/api/sharing', { 'cf-connecting-ip': ip }, 'POST')).body);
  const pad = 'x'.repeat(60_000);
  const sent = new Map(); // token -> batches sent
  const post = async (g, ip) => {
    const n = sent.get(g.token) ?? 0;
    sent.set(g.token, n + 1);
    const text = JSON.stringify({ id: g.id, n, events: [{ k: 'mark', at: 0, heard: true, pad }] });
    return (await request('/api/log', { 'cf-connecting-ip': ip, 'x-hfs-share': g.token }, 'POST', port, text)).status;
  };
  let minute = 0;
  const later = () => writeFile(clock, String(++minute * 61_000)); // past the 300-a-minute API limit

  // One grant, posted to from four addresses: it stops at 24 MB.
  const one = await grant('192.0.2.20');
  let ok = 0;
  for (let i = 0; i < 450; i++) {
    const status = await post(one, `192.0.2.${20 + (i % 4)}`);
    if (status !== 200) { assert.equal(status, 429); break; }
    ok++;
  }
  assert.ok(ok >= 400 && ok * 60_000 <= 24 * 1024 ** 2, `${ok} posts of 60 KB`);

  // One address with three grants: it stops at 48 MB, while each grant is still under its own cap.
  const mine = [await grant('192.0.2.30'), await grant('192.0.2.30'), await grant('192.0.2.30')];
  for (let i = 0; i < 3; i++) assert.equal((await request('/api/sharing', { 'cf-connecting-ip': '192.0.2.30' }, 'POST')).status, 200, 'six live grants');
  assert.equal((await request('/api/sharing', { 'cf-connecting-ip': '192.0.2.30' }, 'POST')).status, 429, 'a seventh grant');
  ok = 0;
  for (let i = 0; i < 900; i++) {
    if (i % 290 === 289) await later();
    const status = await post(mine[i % 3], '192.0.2.30');
    if (status !== 200) { assert.equal(status, 429); break; }
    ok++;
  }
  assert.ok(ok >= 800 && ok * 60_000 <= 48 * 1024 ** 2, `${ok} posts of 60 KB`);
  assert.equal(await post(await grant('192.0.2.31'), '192.0.2.31'), 200, 'another address is not held back');
});

test('a public instance can sit behind the access password, and its pages run under the policy', async (t) => {
  const { request } = await server(t, { PASSWORD: 'quiet-on-set' });
  const https = { 'x-forwarded-proto': 'https', 'cf-connecting-ip': '192.0.2.40' };
  const login = await request('/', https);
  assert.equal(login.status, 401);
  assert.match(login.body, /<form method="post">/);
  // Every inline script of the password pages is allowed by its hash, and nothing else is.
  const csp = login.headers['content-security-policy'];
  const hash = (s) => `'sha256-${createHash('sha256').update(s).digest('base64')}'`;
  for (const [, script] of login.body.matchAll(/<script>([^]*?)<\/script>/g)) assert.ok(csp.includes(hash(script)), `login script allowed: ${script.slice(0, 40)}`);
  const trade = await request('/?key=quiet-on-set', https);
  for (const [, script] of trade.body.matchAll(/<script>([^]*?)<\/script>/g)) assert.ok(csp.includes(hash(script)), 'key-link script allowed');
  assert.equal((await request('/app.js', https)).status, 401);
  assert.equal((await request('/about.html', https)).status, 200);
  assert.equal((await request('/', { ...https, 'content-type': 'application/x-www-form-urlencoded' }, 'POST', undefined, 'password=wrong')).status, 401);
  const right = await request('/', { ...https, 'content-type': 'application/x-www-form-urlencoded' }, 'POST', undefined, 'password=quiet-on-set');
  assert.equal(right.status, 200);
  const cookie = right.headers['set-cookie'][0];
  assert.match(cookie, /HttpOnly; SameSite=Lax; Secure/);
  assert.equal((await request('/app.js', { ...https, cookie: cookie.split(';')[0] })).status, 200);
});

// A fetch stand-in whose clock the test moves, counting calls; `answer(url, n)` gives the response.
async function upstream(t, answer) {
  const dir = await mkdtemp(join(tmpdir(), 'hfs-upstream-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const [clock, calls, mock] = ['clock', 'calls', 'fetch.mjs'].map((name) => join(dir, name));
  await writeFile(clock, '0');
  await writeFile(calls, '');
  await writeFile(mock, `import { readFileSync, appendFileSync } from 'node:fs';
    const realNow = Date.now; Date.now = () => realNow() + Number(readFileSync(${JSON.stringify(clock)}, 'utf8'));
    let n = 0;
    globalThis.fetch = async (url) => { appendFileSync(${JSON.stringify(calls)}, 'call\\n'); return (${answer})(String(url), ++n); };`);
  return {
    dir,
    env: { REPLAY: '', NODE_OPTIONS: `--import=${mock}` },
    count: async () => (await readFile(calls, 'utf8')).trim().split('\n').filter(Boolean).length,
    at: (ms) => writeFile(clock, String(ms)),
  };
}

test('adsb.lol also stops before its weekly budget, though each day has room', async (t) => {
  const up = await upstream(t, () => Response.json({ ac: [], now: Date.now() }));
  const s = await server(t, { ...up.env, ADSB_LOL_DAY: '100', ADSB_LOL_WEEK: '2' });
  const me = { 'cf-connecting-ip': '198.51.100.6' };
  assert.equal((await s.request('/api/aircraft?lat=34&lon=-118', me)).status, 200);
  await up.at(2 * 86_400_000);
  assert.equal((await s.request('/api/aircraft?lat=35&lon=-118', me)).status, 200);
  const over = await s.request('/api/aircraft?lat=36&lon=-118', me);
  assert.equal(over.status, 429);
  assert.equal(JSON.parse(over.body).code, 'flight_quota');
  assert.ok(Math.abs(Number(over.headers['retry-after']) - 5 * 86_400) < 30, `until a week after the first, got ${over.headers['retry-after']}`);
  assert.equal(await up.count(), 2);
  await up.at(7 * 86_400_000 + 1000);
  assert.equal((await s.request('/api/aircraft?lat=36&lon=-118', me)).status, 200, 'a week on it goes on');
});

test('the adsb.lol budget survives a restart, keeps no client address, and a file it cannot understand is a spent day', async (t) => {
  const up = await upstream(t, () => Response.json({ ac: [], now: Date.now() }));
  const env = { ...up.env, ADSB_LOL_DAY: '2', STATE_DIR: join(up.dir, 'state') };
  let s = await server(t, env);
  const me = { 'cf-connecting-ip': '198.51.100.7' };
  assert.equal((await s.request('/api/aircraft?lat=34&lon=-118', me)).status, 200);
  assert.equal((await s.request('/api/aircraft?lat=35&lon=-118', me)).status, 200);
  await stop(s);
  s = await server(t, env);
  const over = await s.request('/api/aircraft?lat=36&lon=-118', me);
  assert.equal(over.status, 429, 'a restart does not give the day back');
  assert.equal(JSON.parse(over.body).code, 'flight_quota');
  assert.equal(await up.count(), 2);
  const saved = await readFile(join(up.dir, 'state', 'adsb-lol.json'), 'utf8');
  assert.doesNotMatch(saved, /198\.51|cf-connecting|\d+\.\d+\.\d+\.\d+/, 'times only');
  await stop(s);
  // A file that cannot be read or understood may have held a spent day: it is taken as one, from now.
  for (const [i, damaged] of ['{"spent":[1,', '{"v":2,"spent":[],"pausedUntil":0}'].entries()) {
    await writeFile(join(up.dir, 'state', 'adsb-lol.json'), damaged);
    s = await server(t, env);
    const refused = await s.request(`/api/aircraft?lat=${37 + i}&lon=-118`, me);
    assert.equal(refused.status, 429, `not an empty budget: ${damaged}`);
    assert.equal(JSON.parse(refused.body).code, 'flight_quota');
    assert.ok(Math.abs(Number(refused.headers['retry-after']) - 86_400) < 30, refused.headers['retry-after']);
    await stop(s);
    s = await server(t, env);
    assert.equal((await s.request(`/api/aircraft?lat=${37 + i}&lon=-118`, me)).status, 429, 'and a restart keeps it spent');
    await stop(s);
  }
  assert.equal(await up.count(), 2, 'no request while the budget is unknown');
  await up.at(86_400_000 + 1000);
  s = await server(t, env);
  assert.equal((await s.request('/api/aircraft?lat=39&lon=-118', me)).status, 200, 'a day later it goes on');
  await stop(s);
  await rm(join(up.dir, 'state', 'adsb-lol.json'));
  s = await server(t, env);
  assert.equal((await s.request('/api/aircraft?lat=40&lon=-118', me)).status, 200, 'a missing file is a fresh start');
});

test('a file it cannot understand stays spent until a good one replaces it, even when that save fails', async (t) => {
  const up = await upstream(t, () => Response.json({ ac: [], now: Date.now() }));
  const state = join(up.dir, 'state');
  const env = { ...up.env, ADSB_LOL_DAY: '2', STATE_DIR: state };
  const me = { 'cf-connecting-ip': '198.51.100.8' };
  await mkdir(state, { recursive: true });
  await writeFile(join(state, 'adsb-lol.json'), '{"spent":[1,');
  await mkdir(join(state, 'adsb-lol.json.tmp')); // the replacement cannot be written
  let s = await server(t, env);
  assert.equal((await s.request('/api/aircraft?lat=34&lon=-118', me)).status, 429);
  await stop(s);
  await rm(join(state, 'adsb-lol.json.tmp'), { recursive: true });
  s = await server(t, env);
  assert.equal((await s.request('/api/aircraft?lat=35&lon=-118', me)).status, 429, 'still spent after the restart');
  assert.equal(await up.count(), 0);
  assert.match(await readFile(join(state, 'adsb-lol.json.unread'), 'utf8'), /^\{"spent":\[1,$/, 'a copy is kept for a look');
});

test('an adsb.lol request whose time cannot be saved is not made, and saving is tried again', async (t) => {
  const up = await upstream(t, () => Response.json({ ac: [], now: Date.now() }));
  const state = join(up.dir, 'state');
  const env = { ...up.env, ADSB_LOL_DAY: '2', STATE_DIR: state };
  let s = await server(t, env);
  let said = '';
  s.child.stdout.on('data', (chunk) => said += chunk);
  const me = { 'cf-connecting-ip': '198.51.100.9' };
  assert.equal((await s.request('/api/aircraft?lat=34&lon=-118', me)).status, 200);
  await chmod(state, 0o500); // nothing can be written in it
  try {
    for (const lat of [35, 36]) {
      const refused = await s.request(`/api/aircraft?lat=${lat}&lon=-118`, me);
      assert.equal(refused.status, 503, 'unavailable, not answered');
      assert.equal(JSON.parse(refused.body).error, 'Data service unavailable. Try again shortly.');
      assert.ok(Number(refused.headers['retry-after']) > 0);
    }
  } finally {
    await chmod(state, 0o700);
  }
  assert.equal(await up.count(), 1, 'no request that could not be saved');
  assert.equal(said.match(/adsb\.lol budget cannot be saved/g)?.length, 1, 'said once');
  assert.equal((await s.request('/api/aircraft?lat=37&lon=-118', me)).status, 200, 'saving works again');
  await stop(s);
  s = await server(t, env);
  assert.equal((await s.request('/api/aircraft?lat=38&lon=-118', me)).status, 429, 'the restart remembers both requests');
  assert.equal(await up.count(), 2);
});

test('a provider pause survives a restart, and a long Retry-After is honoured in full', async (t) => {
  const up = await upstream(t, () => new Response('rate limit exceeded', { status: 429, headers: { 'retry-after': '172800' } }));
  const env = { ...up.env, STATE_DIR: join(up.dir, 'state') };
  let s = await server(t, env);
  const first = await s.request('/api/aircraft?lat=34&lon=-118');
  assert.equal(first.status, 429);
  assert.ok(Number(first.headers['retry-after']) >= 172_790, first.headers['retry-after']);
  await stop(s);
  await up.at(25 * 3600_000);
  s = await server(t, env);
  const later = await s.request('/api/aircraft?lat=35&lon=-118');
  assert.equal(later.status, 429, 'still paused a day later, after a restart');
  assert.ok(Math.abs(Number(later.headers['retry-after']) - 23 * 3600) < 30, later.headers['retry-after']);
  assert.equal(await up.count(), 1);
});

test('one IPv6 /64 network is one client for every per-client limit', async (t) => {
  const { request } = await server(t, { LOG_DIR: join(await mkdtemp(join(tmpdir(), 'hfs-v6-')), 'logs') });
  const from = (low) => ({ 'cf-connecting-ip': `2001:db8:1:2:${low}` });
  for (let i = 0; i < 5; i++) assert.equal((await request(`/api/aircraft?lat=3${i}&lon=-118`, from(`${i}::1`))).status, 200);
  assert.equal((await request('/api/aircraft?lat=39&lon=-118', from('ffff:1:2:3'))).status, 429, 'a sixth place from the same /64');
  assert.equal((await request('/api/aircraft?lat=39&lon=-118', { 'cf-connecting-ip': '2001:db8:1:3::1' })).status, 200, 'another /64 is not held back');
  for (let i = 0; i < 6; i++) assert.equal((await request('/api/sharing', from(`${i}::${i}`), 'POST')).status, 200);
  assert.equal((await request('/api/sharing', from('abcd::9'), 'POST')).status, 429, 'a seventh live grant from the same /64');
  assert.equal((await request('/api/sharing', { 'cf-connecting-ip': '::ffff:192.0.2.60' }, 'POST')).status, 200);
});

test('sharing: one address cannot fill the session slots by revoking, a closing page lets its grant go, and uploads are charged in bytes', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hfs-sessions-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const clock = join(dir, 'clock');
  const mock = join(dir, 'clock.mjs');
  await writeFile(clock, '0');
  await writeFile(mock, `import { readFileSync } from 'node:fs';
    const realNow = Date.now; Date.now = () => realNow() + Number(readFileSync(${JSON.stringify(clock)}, 'utf8'));`);
  const { request, port } = await server(t, { LOG_DIR: join(dir, 'logs'), NODE_OPTIONS: `--import=${mock}` });
  const ask = (ip, token) => request('/api/sharing', { 'cf-connecting-ip': ip, ...(token ? { 'x-hfs-share': token } : {}) }, 'POST');
  const post = (g, ip, n, pad = '') => request('/api/log', { 'cf-connecting-ip': ip, 'x-hfs-share': g.token }, 'POST', port, JSON.stringify({ id: g.id, n, events: [{ k: 'mark', at: 0, heard: true, pad }] }));

  // Grant, post, revoke, again: a dozen sessions a day from one address, and no more.
  for (let i = 0; i < 12; i++) {
    const g = JSON.parse((await ask('192.0.2.50')).body);
    assert.equal((await post(g, '192.0.2.50', 0)).status, 200);
    assert.equal((await request('/api/sharing', { 'x-hfs-share': g.token }, 'DELETE')).status, 200);
  }
  assert.equal((await ask('192.0.2.50')).status, 429, 'a thirteenth session');

  // Closing the page gives its grant up a minute later.
  const g = JSON.parse((await ask('192.0.2.51')).body);
  assert.equal((await request('/api/sharing?closing', { 'cf-connecting-ip': '192.0.2.51', 'x-hfs-share': g.token }, 'DELETE')).status, 200);
  assert.equal((await post(g, '192.0.2.51', 0)).status, 200, 'the last upload of a closing page');
  await writeFile(clock, String(61_000));
  assert.equal((await post(g, '192.0.2.51', 1)).status, 403, 'given up a minute after the page closed');

  // 60 KB of three-byte characters is 20,000 characters: it is the bytes that are counted.
  const big = JSON.parse((await ask('192.0.2.52')).body);
  const pad = '€'.repeat(20_000);
  let ok = 0;
  for (let i = 0; i < 450; i++) {
    if (i % 290 === 289) await writeFile(clock, String(61_000 * (2 + i / 289)));
    const { status } = await post(big, '192.0.2.52', i, pad);
    if (status !== 200) { assert.equal(status, 429); break; }
    ok++;
  }
  assert.ok(ok * 60_000 <= 24 * 1024 ** 2, `${ok} posts of 60 KB`);
});

// A page started on a clock the test moves, with a log, for the sharing tests below.
async function sharingServer(t, extra = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'hfs-exchange-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const clock = join(dir, 'clock');
  const mock = join(dir, 'clock.mjs');
  await writeFile(clock, '0');
  await writeFile(mock, `import { readFileSync } from 'node:fs';
    const realNow = Date.now; Date.now = () => realNow() + Number(readFileSync(${JSON.stringify(clock)}, 'utf8'));`);
  const logs = join(dir, 'logs');
  const s = await server(t, { LOG_DIR: logs, NODE_OPTIONS: `--import=${mock}`, ...extra });
  return {
    ...s,
    logs,
    at: (ms) => writeFile(clock, String(ms)),
    ask: (ip, token, more = {}) => s.request('/api/sharing', { 'cf-connecting-ip': ip, ...(token ? { 'x-hfs-share': token } : {}), ...more }, 'POST'),
    close: (ip, token, more = {}) => s.request('/api/sharing?closing', { 'cf-connecting-ip': ip, 'x-hfs-share': token, ...more }, 'DELETE'),
    post: (g, ip, n, heard, more = {}) => s.request('/api/log', { 'cf-connecting-ip': ip, 'x-hfs-share': g.token, ...more }, 'POST', s.port, JSON.stringify({ id: g.id, n, events: [{ k: 'mark', at: 0, heard }] })),
  };
}
const marks = async (logs, id) => read(join(logs, (await readdir(logs)).find((f) => f.endsWith(`-${id}.log.jsonl.gz`)))).filter((e) => e.k === 'mark').map((e) => e.heard);

test('sharing: a duplicated tab presenting the same grant gets a session of its own, and neither loses a mark', async (t) => {
  const s = await sharingServer(t);
  const ip = '192.0.2.70';
  const first = JSON.parse((await s.ask(ip)).body);
  // Both tabs hold the first page's grant in sessionStorage, and both present it.
  const original = JSON.parse((await s.ask(ip, first.token)).body);
  const copy = JSON.parse((await s.ask(ip, first.token)).body);
  assert.equal(new Set([first.id, original.id, copy.id]).size, 3, 'three sessions');
  assert.equal(new Set([first.token, original.token, copy.token]).size, 3);
  for (const [g, heard] of [[original, true], [copy, false]]) assert.equal((await s.post(g, ip, 0, heard)).status, 200);
  assert.deepEqual(await marks(s.logs, original.id), [true]);
  assert.deepEqual(await marks(s.logs, copy.id), [false], 'the copy is not taken for a repeated batch');
  assert.equal((await s.post(first, ip, 0, true)).status, 200, 'the grant presented is left as it was');
});

test('sharing: a close that arrives after the reloaded page has its grant ends only the old one', async (t) => {
  const s = await sharingServer(t);
  const ip = '192.0.2.71';
  const old = JSON.parse((await s.ask(ip)).body);
  const reloaded = JSON.parse((await s.ask(ip, old.token)).body);
  assert.equal((await s.close(ip, old.token)).status, 200, 'the old page closing, late');
  await s.at(61_000);
  assert.equal((await s.post(old, ip, 0, true)).status, 403, 'the old grant is gone a minute after its close');
  assert.equal((await s.post(reloaded, ip, 0, true)).status, 200, 'the reloaded page goes on sharing');
  await s.at(59 * 60_000);
  assert.equal((await s.post(reloaded, ip, 1, false)).status, 200, 'and its grant is renewed as it is used');
});

test('sharing: a grant is exchanged, or closed, only by its own network, and exchanges have their own daily allowance', async (t) => {
  const s = await sharingServer(t);
  const mine = JSON.parse((await s.ask('192.0.2.72')).body);
  // Another network spends its twelve starts, then presents this grant.
  for (let i = 0; i < 12; i++) {
    const g = JSON.parse((await s.ask('192.0.2.73')).body);
    assert.equal((await s.request('/api/sharing', { 'x-hfs-share': g.token }, 'DELETE')).status, 200);
  }
  assert.equal((await s.ask('192.0.2.73', mine.token)).status, 429, 'not exchanged for another network');
  assert.equal((await s.close('192.0.2.73', mine.token)).status, 200);
  await s.at(61_000);
  assert.equal((await s.post(mine, '192.0.2.72', 0, true)).status, 200, 'a close from another network has no effect');

  // Exchanges are not charged to the twelve starts, but are bounded on their own.
  let g = mine;
  for (let i = 0; i < 48; i++) {
    const next = await s.ask('192.0.2.72', g.token);
    assert.equal(next.status, 200, `exchange ${i + 1}`);
    assert.equal((await s.request('/api/sharing', { 'x-hfs-share': g.token }, 'DELETE')).status, 200);
    g = JSON.parse(next.body);
    if (i % 40 === 39) await s.at(61_000 * (2 + i)); // past the 300-a-minute API limit
  }
  for (let i = 0; i < 11; i++) {
    const fresh = await s.ask('192.0.2.72');
    assert.equal(fresh.status, 200, `start ${i + 2}`);
    assert.equal((await s.request('/api/sharing', { 'x-hfs-share': JSON.parse(fresh.body).token }, 'DELETE')).status, 200);
  }
  assert.equal((await s.ask('192.0.2.72', g.token)).status, 429, 'a 49th exchange is a start, and the starts are spent');
});

test('sharing: behind the access password every sharing method needs the cookie, and revoking still works past the API limit', async (t) => {
  const s = await sharingServer(t, { PASSWORD: 'quiet-on-set' });
  const ip = '192.0.2.74';
  const https = { 'x-forwarded-proto': 'https', 'cf-connecting-ip': ip };
  const right = await s.request('/', { ...https, 'content-type': 'application/x-www-form-urlencoded' }, 'POST', undefined, 'password=quiet-on-set');
  const cookie = { cookie: right.headers['set-cookie'][0].split(';')[0] };
  assert.equal((await s.ask(ip)).status, 401, 'no grant without the cookie');
  const g = JSON.parse((await s.ask(ip, null, cookie)).body);
  assert.equal((await s.ask(ip, g.token)).status, 401, 'no exchange without the cookie');
  assert.equal((await s.close(ip, g.token)).status, 401, 'no close without the cookie');
  assert.equal((await s.request('/api/sharing', { 'cf-connecting-ip': ip, 'x-hfs-share': g.token }, 'DELETE')).status, 401, 'no revoke without the cookie');
  assert.equal((await s.post(g, ip, 0, true)).status, 401, 'no upload without the cookie');
  await s.at(61_000);
  assert.equal((await s.post(g, ip, 0, true, cookie)).status, 200, 'the grant was left alone');
  while ((await s.request('/api/log', { 'cf-connecting-ip': ip, ...cookie })).status !== 429);
  assert.equal((await s.request('/api/sharing', { 'cf-connecting-ip': ip, 'x-hfs-share': g.token }, 'DELETE')).status, 401, 'still no revoke without the cookie');
  assert.equal((await s.request('/api/sharing', { 'cf-connecting-ip': ip, 'x-hfs-share': g.token, ...cookie }, 'DELETE')).status, 200, 'revoked past the API limit');
  await s.at(2 * 61_000);
  assert.equal((await s.post(g, ip, 1, true, cookie)).status, 403);
});

// A stand-in for where contact messages are delivered: it keeps what it was sent, and answers `status`
// after `delay` ms.
async function mailbox(t) {
  const got = [];
  const box = { got, status: 200 };
  const stand = http.createServer((req, res) => {
    let text = '';
    req.on('data', (chunk) => text += chunk);
    req.on('end', () => { got.push({ headers: req.headers, body: JSON.parse(text) }); setTimeout(() => res.writeHead(box.status).end(), box.delay ?? 0); });
  });
  stand.listen(0, '127.0.0.1');
  await once(stand, 'listening');
  t.after(() => stand.close());
  box.url = `http://127.0.0.1:${stand.address().port}/send`;
  return box;
}
const note = { name: 'Sam Mixer', email: 'sam@example.test', category: 'inquiry', message: 'A private note about the 6R departures.', website: '' };
const contact = (s, ip, fields = note, more = {}) => s.request('/api/contact', { 'cf-connecting-ip': ip, 'content-type': 'application/x-www-form-urlencoded', ...more }, 'POST', undefined, new URLSearchParams(fields).toString());

test('contact: without CONTACT_URL the form is off', async (t) => {
  const s = await server(t);
  assert.deepEqual(JSON.parse((await s.request('/api/contact')).body), { on: false, sitekey: null });
  assert.doesNotMatch((await s.request('/')).headers['content-security-policy'], /cloudflare/, 'no Turnstile in the CSP');
  assert.equal((await contact(s, '192.0.2.80')).status, 404);
  assert.match((await s.request('/')).body, /contact-form\.js/);
  assert.doesNotMatch((await s.request('/')).body, /Contact me/, 'the button comes only from the script, once the server says it is on');
});

// Every file under `dir`, unzipped, as text.
async function everyFile(dir) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    const data = await readFile(path);
    files.push({ path, text: (path.endsWith('.gz') ? gunzipSync(data) : data).toString() });
  }
  return files;
}

test('contact: a good message reaches the stand-in with the token, and nothing of it is logged or kept, sharing on', async (t) => {
  const box = await mailbox(t);
  const s = await sharingServer(t, { CONTACT_URL: box.url, CONTACT_TOKEN: 'test-token' });
  let output = '';
  s.child.stdout.on('data', (chunk) => output += chunk);
  s.child.stderr.on('data', (chunk) => output += chunk);
  assert.deepEqual(JSON.parse((await s.request('/api/contact')).body), { on: true, sitekey: null });
  // A page sharing its session, with a region for activity.js, sends a message.
  const region = { 'x-hfs-country': 'US', 'x-hfs-city': 'Burbank', 'x-hfs-lat': '34.2', 'x-hfs-lon': '-118.3' };
  const g = JSON.parse((await s.ask('192.0.2.81', null, region)).body);
  assert.equal((await s.post(g, '192.0.2.81', 0, true)).status, 200);
  assert.equal((await s.request(`/api/aircraft?lat=33.938&lon=-118.440&log=${g.id}`, { 'cf-connecting-ip': '192.0.2.81', 'x-hfs-share': g.token })).status, 200);
  const sent = await contact(s, '192.0.2.81', note, { 'x-hfs-share': g.token, ...region });
  assert.equal(sent.status, 200, sent.body);
  const stats = JSON.parse((await s.request('/api/stats', {}, 'GET', s.statsPort)).body);
  assert.ok(stats.activity.regions.length, 'activity was kept for this page');
  const files = await everyFile(s.logs);
  assert.ok(files.some((f) => f.path.endsWith('.log.jsonl.gz')), 'the session was kept');
  assert.ok(files.some((f) => f.path.endsWith('contact.json')), 'and the day\'s send times');
  for (const part of ['Sam Mixer', 'sam@example.test', '6R departures', 'private note']) {
    for (const { path, text } of files) assert.ok(!text.includes(part), `${path} holds nothing of the message: ${part}`);
    assert.ok(!JSON.stringify(stats).includes(part), `the stats and activity hold nothing of the message: ${part}`);
  }
  const day = JSON.parse(files.find((f) => f.path.endsWith('contact.json')).text);
  assert.deepEqual(Object.keys(day), ['v', 'sent']);
  assert.equal(day.sent.length, 1);
  assert.equal(typeof day.sent[0], 'number', 'a time, and nothing else');
  assert.equal(box.got.length, 1);
  assert.equal(box.got[0].headers.authorization, 'Bearer test-token');
  assert.equal(box.got[0].headers['content-type'], 'application/json');
  const { website, ...fields } = note;
  assert.deepEqual(box.got[0].body, { ...fields, site: 'example.test' });
  // Refused ones too: the honeypot, bad fields, extra fields, the wrong encoding, too long.
  const refused = [
    [{ ...note, website: 'http://spam.example' }, 400],
    [{ ...note, name: 'S' }, 400],
    [{ ...note, email: 'sam@example.test\r\nBcc: x@example.test' }, 400],
    [{ ...note, category: 'spam' }, 400],
    [{ ...note, message: 'short' }, 400],
    [{ ...note, extra: '1' }, 400],
    [{ ...note, message: 'x'.repeat(17 * 1024) }, 413],
  ];
  for (const [fields, status] of refused) assert.equal((await contact(s, '192.0.2.82', fields)).status, status, JSON.stringify(fields).slice(0, 80));
  assert.equal((await contact(s, '192.0.2.82', note, { 'content-type': 'application/json' })).status, 415);
  assert.equal(box.got.length, 1, 'nothing refused was delivered');
  // A failed delivery is said to have failed.
  box.status = 500;
  const failed = await contact(s, '192.0.2.83');
  assert.equal(failed.status, 502);
  assert.equal(JSON.parse(failed.body).error, 'Not sent. Try again later.');
  await stop(s);
  for (const part of ['Sam Mixer', 'sam@example.test', '6R departures', 'test-token', 'spam.example']) assert.ok(!output.includes(part), `the log holds nothing of the message: ${part}`);
  assert.doesNotMatch(output, /contact/i);
});

test('contact: with a Turnstile site key, the check is required, its token and the address are relayed, and the CSP allows it', async (t) => {
  const box = await mailbox(t);
  const sitekey = '1x00000000000000000000AA';
  const s = await server(t, { CONTACT_URL: box.url, CONTACT_SITEKEY: sitekey });
  const without = await server(t);
  assert.deepEqual(JSON.parse((await s.request('/api/contact')).body), { on: true, sitekey });
  // The CSP: Turnstile's host for scripts and frames, and every other directive as it was.
  const policy = (csp) => Object.fromEntries(csp.split(';').map((d) => d.trim().split(/\s+/)).map(([name, ...values]) => [name, values]));
  const page = await s.request('/');
  const csp = policy(page.headers['content-security-policy']);
  const before = policy((await without.request('/')).headers['content-security-policy']);
  assert.deepEqual(csp['script-src'], [...before['script-src'], 'https://challenges.cloudflare.com']);
  assert.deepEqual(csp['frame-src'], ['https://challenges.cloudflare.com']);
  const rest = ({ 'script-src': _, 'frame-src': __, ...others }) => others;
  assert.deepEqual(rest(csp), rest(before), 'everything else kept');
  assert.equal(before['frame-src'], undefined);
  assert.ok(!page.headers['content-security-policy'].includes("'unsafe-eval'"));
  assert.ok(!csp['script-src'].includes("'unsafe-inline'"));
  // Nothing on the page itself asks Cloudflare for anything: only contact-form.js knows the address,
  // and it loads it when the dialog is opened.
  assert.doesNotMatch(page.body, /challenges\.cloudflare\.com/);
  const script = await s.request('/contact-form.js');
  const [opening] = script.body.match(/addEventListener\('click', \(\) => \{[^]*?\}\);/);
  assert.match(opening, /showCheck\(\)/, 'loaded on opening the dialog');
  assert.equal(script.body.match(/turnstile\(\)/g).length, 1, 'and nowhere else');
  assert.doesNotMatch(script.body.slice(script.body.indexOf("fetch('api/contact')\n")), /turnstile|showCheck/, 'not on load');

  const token = 'XXXX.DUMMY.TOKEN.XXXX';
  assert.equal((await contact(s, '2001:db8:7:8::1234', { ...note, 'cf-turnstile-response': token })).status, 200);
  const { website, ...fields } = note;
  assert.deepEqual(box.got[0].body, { ...fields, token, ip: '2001:db8:7:8::1234', site: 'example.test' }, 'the address before /64 grouping');
  const missing = await contact(s, '192.0.2.92');
  assert.equal(missing.status, 400);
  assert.equal(JSON.parse(missing.body).error, 'Complete the check and try again.');
  assert.equal((await contact(s, '192.0.2.92', { ...note, 'cf-turnstile-response': 'x'.repeat(2049) })).status, 400);
  // A check the receiving end refuses does not spend the day's 30 for everyone else.
  box.status = 400;
  for (let i = 0; i < 31; i++) {
    const refused = await contact(s, `198.51.100.${i + 1}`, { ...note, 'cf-turnstile-response': token });
    assert.equal(refused.status, 400, `failed check ${i + 1}`);
  }
  box.status = 200;
  assert.equal((await contact(s, '203.0.113.50', { ...note, 'cf-turnstile-response': token })).status, 200, 'a real visitor still gets through');
  assert.equal((await contact(without, '192.0.2.92', { ...note, 'cf-turnstile-response': token })).status, 404, 'no form there at all');
  // The receiver's 400 is a failed check.
  box.status = 400;
  const failed = await contact(s, '192.0.2.93', { ...note, 'cf-turnstile-response': token });
  assert.equal(failed.status, 400);
  assert.equal(JSON.parse(failed.body).error, 'Complete the check and try again.');
  assert.equal(box.got.at(-1).body.ip, '192.0.2.93');
});

test('contact: without a site key the check\'s field is refused, and no address is relayed', async (t) => {
  const box = await mailbox(t);
  const s = await server(t, { CONTACT_URL: box.url });
  const refused = await contact(s, '192.0.2.94', { ...note, 'cf-turnstile-response': 'XXXX.DUMMY.TOKEN.XXXX' });
  assert.equal(refused.status, 400);
  assert.equal((await contact(s, '192.0.2.94')).status, 200);
  assert.equal(box.got.length, 1);
  assert.deepEqual(Object.keys(box.got[0].body), ['name', 'email', 'category', 'message', 'site']);
  box.status = 400;
  const failed = await contact(s, '192.0.2.95');
  assert.equal(failed.status, 502, 'a 400 without a check is not a failed check');
});

test('contact: a page that has gone before its message\'s turn is not sent for', async (t) => {
  const box = await mailbox(t);
  box.delay = 800;
  const s = await server(t, { CONTACT_URL: box.url });
  const first = contact(s, '192.0.2.86');
  await new Promise((done) => setTimeout(done, 200));
  // A second page posts, then gives up before the first delivery and the gap after it are over.
  const second = http.request({ host: '127.0.0.1', port: s.port, path: '/api/contact', method: 'POST', headers: { host: 'example.test', origin: 'https://example.test', 'cf-connecting-ip': '192.0.2.87', 'content-type': 'application/x-www-form-urlencoded' } });
  second.on('error', () => {});
  second.end(new URLSearchParams(note).toString());
  await new Promise((done) => setTimeout(done, 200));
  second.destroy();
  assert.equal((await first).status, 200);
  await new Promise((done) => setTimeout(done, 1500)); // past the second one's turn
  assert.equal(box.got.length, 1, 'the second was never sent');
  box.delay = 0;
  assert.equal((await contact(s, '192.0.2.88')).status, 200, 'and the line goes on');
  assert.equal(box.got.length, 2);
});

test('contact: the day\'s send times survive a restart, and an unreadable file is a day spent', async (t) => {
  const box = await mailbox(t);
  const dir = await mkdtemp(join(tmpdir(), 'hfs-contact-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let s = await server(t, { CONTACT_URL: box.url, STATE_DIR: dir });
  assert.equal((await contact(s, '192.0.2.89')).status, 200);
  await stop(s);
  s = await server(t, { CONTACT_URL: box.url, STATE_DIR: dir });
  assert.equal((await contact(s, '192.0.2.90')).status, 200);
  assert.equal(JSON.parse(await readFile(join(dir, 'contact.json'), 'utf8')).sent.length, 2, 'the first send was not forgotten');
  await stop(s);
  await writeFile(join(dir, 'contact.json'), '{ not json');
  s = await server(t, { CONTACT_URL: box.url, STATE_DIR: dir });
  const refused = await contact(s, '192.0.2.91');
  assert.equal(refused.status, 429);
  assert.ok(Number(refused.headers['retry-after']) > 23 * 3600);
  assert.equal(box.got.length, 2);
});

test('contact: the 4th message in 15 minutes from one network is refused, with the wait', async (t) => {
  const box = await mailbox(t);
  const s = await server(t, { CONTACT_URL: box.url });
  for (let i = 0; i < 3; i++) assert.equal((await contact(s, `2001:db8:5:6::${i + 1}`)).status, 200);
  const fourth = await contact(s, '2001:db8:5:6::9');
  assert.equal(fourth.status, 429);
  assert.ok(Number(fourth.headers['retry-after']) > 800);
  assert.equal(JSON.parse(fourth.body).error, 'Too many messages. Try again later.');
  assert.equal((await contact(s, '192.0.2.84')).status, 200, 'another network is not held back');
  assert.equal(box.got.length, 4);
  assert.equal(box.got[0].headers.authorization, undefined, 'no token set, none sent');
});

test('contact: a wrong Origin is refused in public mode, and behind the password it needs the cookie', async (t) => {
  const box = await mailbox(t);
  const s = await server(t, { CONTACT_URL: box.url, PASSWORD: 'quiet-on-set' });
  const https = { 'x-forwarded-proto': 'https' };
  assert.equal((await contact(s, '192.0.2.85', note, { ...https, origin: 'https://evil.example' })).status, 403);
  assert.equal((await contact(s, '192.0.2.85', note, https)).status, 401, 'no message without the cookie');
  assert.equal((await s.request('/api/contact', { 'cf-connecting-ip': '192.0.2.85' })).status, 401, 'nor whether the form is on');
  const right = await s.request('/', { ...https, 'cf-connecting-ip': '192.0.2.85', 'content-type': 'application/x-www-form-urlencoded' }, 'POST', undefined, 'password=quiet-on-set');
  const cookie = right.headers['set-cookie'][0].split(';')[0];
  assert.equal((await contact(s, '192.0.2.85', note, { ...https, cookie, origin: 'https://evil.example' })).status, 403);
  assert.equal((await contact(s, '192.0.2.85', note, { ...https, cookie })).status, 200);
  assert.equal(box.got.length, 1);
});

test('live weather is rounded, cached through failure and uses the existing upstream counter', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hfs-weather-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const mock = join(dir, 'fetch.mjs');
  const calls = join(dir, 'weather-calls');
  await writeFile(mock, `import { appendFileSync } from 'node:fs';
    globalThis.fetch = async (url, options) => {
      if (String(url).includes('/v1/forecast')) {
        appendFileSync(${JSON.stringify(calls)}, JSON.stringify({url, ua:options.headers['user-agent']})+'\\n');
        if (String(url).includes('latitude=12.347')) throw Error('offline');
        return Response.json({hourly:{time:[Math.floor(Date.now()/1000)],temperature_2m:[20],temperature_80m:[19],wind_speed_10m:[5],wind_direction_10m:[0]}});
      }
      return Response.json({ac:[],now:Date.now()});
    };`);
  const { request, statsPort } = await server(t, { REPLAY: '', STATE_DIR: dir, TEST_WEATHER: '1', NODE_OPTIONS: `--import=${mock}` });
  const first = JSON.parse((await request('/api/aircraft?lat=12.34567&lon=-65.4321')).body);
  assert.equal(first.weather, null, 'weather never delays the first flight response');
  for (let i = 0; i < 100; i++) {
    const next = JSON.parse((await request('/api/aircraft?lat=12.34568&lon=-65.4322')).body);
    if (next.weather) { assert.equal(next.weather.temperature_2m, 20); break; }
    await new Promise(done => setTimeout(done, 10));
    assert.ok(i < 99, 'background refresh completes');
  }
  const failed = '/api/aircraft?lat=12.3471&lon=-65.4321';
  assert.equal(JSON.parse((await request(failed)).body).weather, null);
  await new Promise(done => setTimeout(done, 1200));
  for (let i = 0; i < 3; i++) assert.equal(JSON.parse((await request(failed)).body).weather, null);
  const recorded = (await readFile(calls, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(recorded.length, 2, 'one attempt per rounded place, including failure');
  assert.equal(new URL(recorded[0].url).searchParams.get('latitude'), '12.346');
  assert.equal(new URL(recorded[0].url).searchParams.get('longitude'), '-65.432');
  assert.equal(recorded[0].ua, 'flight-noise-poc/0.1');
  for (const lat of [13, 14, 15]) await request(`/api/aircraft?lat=${lat}&lon=-65.432`);
  assert.equal((await request('/api/aircraft?lat=16&lon=-65.432')).status, 429, 'weather cannot bypass the place limit');
  const stats = JSON.parse((await request('/api/stats', {}, 'GET', statsPort)).body);
  assert.ok(stats.upstream >= 4, 'weather calls count alongside flight calls');
  assert.equal('weather' in stats, false, 'stats shape is unchanged');
});
