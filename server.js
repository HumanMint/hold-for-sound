// Static files plus a thin proxy to the free flight-data and geocoding services,
// which browsers can't call directly. All prediction happens in the browser.
// Two things are off unless their environment variable is set: PASSWORD puts everything behind an
// access password (access.js), and RECEIVER adds an ADS-B receiver of your own to the feeds
// (receiver.js). A third, LOG_DIR, keeps the sessions that people choose to share (log.js). A fourth,
// CONTACT_URL, is where the contact form's messages go (contact.js). Traffic is always counted (stats.js).
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { copyFileSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { queue } from './queue.js';
import { createHash } from 'node:crypto';
import { gate, SCRIPTS } from './access.js';
import { traffic, client, direct, network } from './stats.js';
import { snapshot, merge } from './receiver.js';
import { createLog, read, body } from './log.js';
import { activity } from './activity.js';
import { consent } from './consent.js';
import { retryAfter } from './public/feed.js';
import { cadence, FAST_S, TAXIED_S } from './cadence.js';
import { check, limits, webhook, dispatch, MAX_BODY } from './contact.js';

const PORT = process.env.PORT || 8787;
const RADIUS_NM = 30;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
// A public instance: loopback only, behind a tunnel, with the operator's stats on a separate port.
const PUBLIC_HOST = process.env.PUBLIC_HOST;
const ADSB_LOL_KEY = process.env.ADSB_LOL_KEY; // optional official free key; server-only, never returned to a viewer
if (PUBLIC_HOST && process.env.RECEIVER) throw new Error('Public mode requires RECEIVER unset.');
const admit = process.env.PASSWORD && gate(process.env.PASSWORD);
// The password pages' own inline scripts, allowed by hash in a public instance's content security policy.
const LOGIN_HASHES = admit ? SCRIPTS.map((s) => ` 'sha256-${createHash('sha256').update(s).digest('base64')}'`).join('') : '';
const RECEIVER = process.env.RECEIVER; // the URL of a receiver's aircraft.json
const log = createLog(process.env.LOG_DIR, PUBLIC_HOST ? { sessionMax: 32 * 1024 ** 2, dirMax: 512 * 1024 ** 2, maxSessions: 200 } : {}); // keeps nothing unless LOG_DIR is set
const seen = traffic();
const activitySeen = activity();
const sharing = consent();

// Per client address, the distinct keys it used in the last `ms`: a new one past `max` is refused, and
// the answer is how many seconds until one frees up (0 when allowed).
function distinct(max, ms) {
  const clients = new Map(); // address -> Map(key -> first used)
  const prune = (used, now) => { for (const [key, at] of used) if (now - at >= ms) used.delete(key); };
  return {
    use(who, key, now = Date.now()) {
      let used = clients.get(who);
      if (!used) {
        if (clients.size >= 5000) clients.delete(clients.keys().next().value);
        clients.set(who, used = new Map());
      }
      prune(used, now);
      if (used.has(key)) return 0;
      if (used.size >= max) return Math.ceil((used.values().next().value + ms - now) / 1000);
      used.set(key, now);
      return 0;
    },
    sweep(now = Date.now()) { for (const [who, used] of clients) if ((prune(used, now), !used.size)) clients.delete(who); },
  };
}
// Bytes (or anything) spent per key in a window of `ms` from its first use: false once past `limit`.
function meter(limit, ms) {
  const keys = new Map(); // key -> { at, used }
  return {
    spend(key, amount, now = Date.now()) {
      let m = keys.get(key);
      if (!m || now - m.at >= ms) {
        keys.delete(key);
        if (keys.size >= 5000) keys.delete(keys.keys().next().value);
        keys.set(key, m = { at: now, used: 0 });
      }
      if (m.used + amount > limit) return false;
      m.used += amount;
      return true;
    },
    sweep(now = Date.now()) { for (const [key, m] of keys) if (now - m.at >= ms) keys.delete(key); },
  };
}
// In public: a few places watched and addresses looked up per client address, so one visitor cannot
// spend the free services' allowances. Shared posts are capped per grant and per address: a real
// session posts at most about 15 MB an hour.
const places = distinct(5, 10 * MIN);
const searches = distinct(10, 10 * MIN);
const grantBytes = meter(24 * 1024 ** 2, HOUR);
const clientBytes = meter(48 * 1024 ** 2, HOUR);
// Client addresses are held in memory only, and dropped once their window has passed.
setInterval(() => {
  activitySeen.report();
  sharing.prune();
  seen.prune();
  forgetLookups();
  for (const limit of [places, searches, grantBytes, clientBytes, contacts]) limit.sweep();
  for (const [ip, hit] of callers) if (Date.now() - hit.at >= MIN) callers.delete(ip);
  forgetAnswers();
}, MIN).unref();
// Everything in public/ is served, by file extension. The page's own scripts and styles are asked for
// under r/<release>/, which is stripped here: a new release is a new address for every file they load,
// so no browser can run a copy cached from an earlier one. The release is a hash of public/, worked out
// at start in public mode and on each page otherwise, so nobody has to remember to change it.
const RELEASE_DIR = new URL('public/', import.meta.url);
function releaseOf() {
  const hash = createHash('sha256');
  for (const name of readdirSync(RELEASE_DIR, { recursive: true }).map(String).sort()) {
    try { hash.update(name).update(readFileSync(new URL(name, RELEASE_DIR))); } catch {} // a folder
  }
  return hash.digest('hex').slice(0, 12);
}
const RELEASE = PUBLIC_HOST && releaseOf();
const TYPES = { html: 'text/html', js: 'text/javascript', css: 'text/css', svg: 'image/svg+xml', png: 'image/png', woff2: 'font/woff2', json: 'application/json' };

// Both feeds are free, need no key, and return the same readsb JSON. The second is the fallback, and
// is not used in public. Each has its own pause: a provider that answers 429 is not asked again until
// its delay has passed, in every mode, and the other is asked meanwhile. adsb.lol's budget pauses only
// adsb.lol. adsb.lol's pause is saved with its budget.
// shortcut: adsb.fi's pause is kept in memory only, so a restart asks it again.
const FEEDS = [
  { url: (lat, lon) => `https://api.adsb.lol/v2/point/${lat}/${lon}/${RADIUS_NM}`, until: 0, quota: false, backoff: 60 },
  { url: (lat, lon) => `https://opendata.adsb.fi/api/v3/lat/${lat}/lon/${lon}/dist/${RADIUS_NM}`, until: 0, quota: false, backoff: 60 },
];
const LOL = FEEDS[0];
const USED = PUBLIC_HOST ? [LOL] : FEEDS;

async function getJson(url) {
  seen.count('upstream');
  const headers = { 'user-agent': 'flight-noise-poc/0.1' };
  if (ADSB_LOL_KEY && new URL(url).hostname === 'api.adsb.lol') headers['x-api-key'] = ADSB_LOL_KEY;
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
  // adsb.lol advertises the exhausted window as a delay in seconds, even without Retry-After. A delay
  // is honoured in full up to 31 days; a longer one (an epoch time, say) is not a delay, and waits a day.
  const quota = res.status === 429 && res.headers.get('x-ratelimit-remaining') === '0';
  const delay = (name) => {
    const seconds = retryAfter(res.headers.get(name));
    return seconds > 31 * 86_400 ? 86_400 : seconds;
  };
  if (!res.ok) throw Object.assign(new Error(`${new URL(url).host} answered ${res.status}`), {
    status: res.status === 429 ? 429 : undefined, quota,
    retryAfter: res.status === 429 ? Math.max(delay('retry-after'), quota ? delay('x-ratelimit-reset') : 0) : 0,
  });
  return res.json();
}

// A feed's `backoff` is in seconds: repeated throttles back off to at most 15 minutes, or the provider's
// longer delay. Every feed in use paused: the answer counts down to the first to come back.
const flightLimited = () => {
  const next = USED.reduce((a, b) => (b.until < a.until ? b : a));
  return Object.assign(new Error('Flight-data service is busy.'), {
    status: 429, code: next.quota ? 'flight_quota' : undefined, retryAfter: Math.max(1, Math.ceil((next.until - Date.now()) / 1000)),
  });
};
// adsb.lol's free allowance is spent by this whole server, key or no key (a key can be revoked for
// repeated 429s). Requests are counted over the last day, 7 days and 30 days, and it
// pauses, as for an exhausted quota, before any limit is reached.
// A free key's allowance (seen 2026-11-11): 1,000 a day, 5,000 a week, 10,000 a month, 1,000 an hour, 120 a minute.
const BUDGET = { day: Number(process.env.ADSB_LOL_DAY) || 900, week: Number(process.env.ADSB_LOL_WEEK) || 4500, month: Number(process.env.ADSB_LOL_MONTH) || 9000 };
const spent = []; // epoch ms of each adsb.lol request in the last 30 days, oldest first
// Those times and any provider pause are kept in STATE_DIR (or LOG_DIR), so a restart forgets neither:
// times only, never a client address. Without either directory, in memory only. A request whose time
// cannot be saved is not made, and a file that cannot be read or understood counts as a day spent.
const STATE_DIR = process.env.STATE_DIR || process.env.LOG_DIR;
const STATE = STATE_DIR && join(STATE_DIR, 'adsb-lol.json');
let unsaved = false; // a write failed: said once, and tried again by each request
function save() {
  if (!STATE) return true;
  try {
    writeFileSync(`${STATE}.tmp`, JSON.stringify({ v: 1, spent, pausedUntil: LOL.until, quota: LOL.quota }), { mode: 0o600 });
    renameSync(`${STATE}.tmp`, STATE); // whole or not at all
    if (unsaved) console.log('The adsb.lol budget is saved again.');
    unsaved = false;
    return true;
  } catch (e) {
    if (!unsaved) console.log(`The adsb.lol budget cannot be saved, so adsb.lol is not asked: ${e.code ?? e.message}`);
    unsaved = true;
    return false;
  }
}
if (STATE) {
  try {
    mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
    const saved = JSON.parse(readFileSync(STATE, 'utf8'));
    const time = (at) => Number.isFinite(at) && at >= 0;
    // Files from before `v` are version 1.
    if ((saved?.v ?? 1) !== 1 || !Array.isArray(saved.spent) || !saved.spent.every(time) || !time(saved.pausedUntil)) throw new Error('not a budget');
    spent.push(...saved.spent.sort((a, b) => a - b).slice(-Math.max(BUDGET.day, BUDGET.week, BUDGET.month)));
    LOL.until = Math.min(saved.pausedUntil, Date.now() + 31 * DAY);
    LOL.quota = saved.quota === true;
  } catch (e) {
    if (e.code !== 'ENOENT') {
      spent.push(...Array(BUDGET.day).fill(Date.now()));
      console.log(`The saved adsb.lol budget cannot be read (${e.code ?? e.message}): today's is taken as spent.`);
      // A copy is kept for a look. The file itself stays until the spent day replaces it, so a failed save
      // leaves it to be read as spent again after a restart.
      try { copyFileSync(STATE, `${STATE}.unread`); } catch {}
      save();
    }
  }
}
// The contact form is on only with somewhere to send its messages. They go one at a time, like the
// other upstream calls, each answered within TOTAL_MS of its arrival (contact.js). The day's send
// times are kept beside the adsb.lol budget.
const deliver = process.env.CONTACT_URL && webhook({ url: process.env.CONTACT_URL, token: process.env.CONTACT_TOKEN, site: PUBLIC_HOST || 'local' });
const contactLine = queue(1000);
const contacts = limits({ file: deliver && STATE_DIR ? join(STATE_DIR, 'contact.json') : undefined });
const sendContact = deliver && dispatch({ line: contactLine, deliver });
function overBudget(now) {
  while (spent.length && now - spent[0] >= 30 * DAY) spent.shift();
  const first = spent.findIndex((at) => now - at < DAY);
  const today = first < 0 ? 0 : spent.length - first;
  const until = Math.max(
    today >= BUDGET.day ? spent.at(-BUDGET.day) + DAY : 0,
    spent.length >= BUDGET.week ? spent.at(-BUDGET.week) + 7 * DAY : 0,
    spent.length >= BUDGET.month ? spent.at(-BUDGET.month) + 30 * DAY : 0,
  );
  return until > now ? until : 0;
}

// adsb.lol is asked only within its budget, and only once the time of asking is saved.
function spend() {
  const until = overBudget(Date.now());
  if (until) {
    Object.assign(LOL, { quota: true, until });
    return false;
  }
  spent.push(Date.now());
  if (save()) return true;
  spent.pop(); // not asked
  throw Object.assign(new Error('The adsb.lol budget cannot be saved.'), { status: 503, retryAfter: 60 });
}

async function fetchAircraft(lat, lon) {
  // This runs inside the queue: jobs already waiting must also respect a new provider pause.
  let error;
  for (const feed of USED) {
    if (Date.now() < feed.until) continue;
    try {
      if (feed === LOL && !spend()) continue;
      const url = feed.url(lat, lon);
      const data = await getJson(url);
      if (!Array.isArray(data?.ac)) throw new Error('Invalid flight-data response.');
      const { ac, now } = data;
      feed.backoff = 60;
      return { source: new URL(url).host, now, ac }; // now: when the feed took this snapshot, epoch ms
    } catch (e) {
      if (e.status === 429) {
        feed.quota = !!e.quota;
        feed.until = Date.now() + Math.max(feed.backoff, e.retryAfter) * 1000;
        feed.backoff = Math.min(feed.backoff * 2, 900);
        if (feed === LOL) save();
      } else error = e;
    }
  }
  // Every feed in use is paused, and none failed otherwise.
  throw error ?? flightLimited();
}

// Several people may be watching different addresses. Each address costs one upstream request per 4 s,
// and all of them share one line to the feeds, so a public link can't be used to hammer a free service.
// In public, where the page smooths between updates, it is one per 10 s while anything in the last
// answer may matter soon, and one a minute while the sky is quiet (cadence.js): the server decides, so
// no page can spend the day's budget faster. The line also keeps under adsb.lol's 20 requests in 30 s.
const FRESH_MS = PUBLIC_HOST ? FAST_S * 1000 : 4000;
const feedLine = queue(PUBLIC_HOST ? 1600 : 1000);
const recent = new Map(); // "lat,lon" -> { at, fresh, was, body }, oldest first: `was` is cadence()'s last answer
// A place nobody asks about any more is forgotten, answer and all, a minute after its answer runs out:
// time for the next poll of a page still watching it to find what cadence() said last. Ten minutes where
// aircraft were on the ground near it, or one taxied, so a page that comes back within the taxi hold
// finds the aircraft parked there already known (cadence.js). Forgetting sooner never hides anything:
// an aircraft not known on the ground counts as a taxi.
function forgetAnswers(now = Date.now()) {
  for (const [key, hit] of recent) {
    const ground = hit.was?.ground?.length || now - (hit.was?.taxiedAt ?? 0) < TAXIED_S * 1000;
    if (now - hit.at > hit.fresh + (ground ? TAXIED_S * 1000 : MIN)) recent.delete(key);
  }
}

// REPLAY=test/fixtures/lax.jsonl plays a recording of the feed on a loop instead of calling the live
// services: the same traffic every time, for demos and for working on the page. Each line is { at, ac }.
// Aircraft jump when the recording loops. A shared session's feed file (log.js) is such a recording,
// and one with a single snapshot is that snapshot, served again and again.
const replay = process.env.REPLAY && read(process.env.REPLAY);
const started = Date.now();
function replayed() {
  const t = Date.now();
  const span = replay.at(-1).at - replay[0].at;
  const at = replay[0].at + (span && (t - started) % span);
  const frame = replay.findLast((f) => f.at <= at);
  return { source: 'a recording', now: t - (at - frame.at), ac: frame.ac };
}

function aircraft(lat, lon) {
  if (replay) return replayed();
  const key = `${lat},${lon}`;
  let hit = recent.get(key);
  if (!hit || Date.now() - hit.at > hit.fresh) {
    recent.delete(key);
    if (recent.size >= 200) recent.delete(recent.keys().next().value);
    // Until it is known to be quiet, and after a failure, an answer is kept for the short time.
    const kept = { at: Date.now(), fresh: FRESH_MS, was: hit?.was };
    kept.body = feedLine(() => fetchAircraft(lat, lon)).then((data) => {
      if (PUBLIC_HOST) {
        if (!runwayList) runwayTable(false); // for the next answer: until then this place may be beside a runway
        const runways = runwayList && nearby(runwayList, +lat, +lon);
        kept.was = cadence(data.ac, { lat: +lat, lon: +lon }, Date.now(), kept.was, runways);
        kept.fresh = kept.was.every * 1000;
      }
      return { ...data, every: kept.fresh / 1000 }; // the page trusts a longer-kept answer longer (status.js)
    });
    recent.set(key, hit = kept);
  }
  return hit.body;
}

// The receiver is asked at most once a second, however many addresses are being watched. One that
// does not answer, or answers with an error or something that is not an aircraft.json, is left out
// without a word.
// shortcut: while a receiver is unreachable every answer waits out this 2 s timeout. Back off after a
// failure if that ever happens on a set.
let own = { at: 0, body: null };
function receiver() {
  if (Date.now() - own.at > 1000) {
    const body = fetch(RECEIVER, { signal: AbortSignal.timeout(2000) })
      .then(async (res) => (res.ok ? snapshot(await res.json(), Date.now()) : null))
      .catch(() => null);
    own = { at: Date.now(), body };
  }
  return own.body;
}

// The feed's aircraft, with the receiver's added when there is one. If the feeds fail the request
// fails, receiver or no receiver: one antenna sees part of the sky, and the page must not call it clear.
async function everything(lat, lon) {
  if (!RECEIVER) return aircraft(lat, lon);
  const [feed, mine] = await Promise.all([aircraft(lat, lon), receiver()]);
  return merge(feed, mine, { lat: +lat, lon: +lon, radiusNm: RADIUS_NM });
}

// Runway ends from OurAirports (public domain): fetched once, kept in memory. In public it is fetched at
// start, for the flight cadence (cadence.js), which takes every place as beside a runway until it has it.
let runwayRows; // the fetch
let runwayList = null; // its rows, once they have come
let runwaysFailed = 0;
// `retry`: try again at once after a failure, as a lookup does; the flight cadence waits 10 minutes.
async function runwayTable(retry = true) {
  if (!runwayRows) {
    if (!retry && Date.now() - runwaysFailed < 10 * MIN) return null;
    seen.count('upstream');
    runwayRows = fetch('https://davidmegginson.github.io/ourairports-data/runways.csv', { signal: AbortSignal.timeout(30000) })
      .then((res) => {
        if (!res.ok) throw new Error(`runways: ${res.status}`);
        return res.text();
      })
      .then((csv) => (runwayList = csv.split('\n').slice(1).map((line) => line.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/).map((cell) => cell.replace(/"/g, '')))));
  }
  try {
    return await runwayRows;
  } catch {
    runwayRows = undefined; // the page still works without runways
    runwaysFailed = Date.now();
    return null;
  }
}
// Columns: 2 airport, 7 closed, then id/lat/lon/elevation ft for each end at 8-11 and 14-17. 0.25° is about 15 nm.
const nearby = (rows, lat, lon) =>
  rows
    .filter((c) => c[7] === '0' && c[9] && c[15] && Math.hypot(c[9] - lat, (c[10] - lon) * Math.cos((lat * Math.PI) / 180)) < 0.25)
    .map((c) => ({
      airport: c[2],
      elevM: c[11] || c[17] ? (c[11] || c[17]) * 0.3048 : undefined,
      ends: [{ id: c[8], lat: +c[9], lon: +c[10] }, { id: c[14], lat: +c[15], lon: +c[16] }],
    }));
async function runwaysNear(lat, lon) {
  const rows = await runwayTable();
  return rows ? nearby(rows, lat, lon) : [];
}
if (PUBLIC_HOST && !replay) runwayTable(false);

async function lookUp(q) {
  // Typed coordinates are used as they are, so a location that must stay private never goes to the
  // public address lookup. (They still go, rounded, to the elevation and flight services.)
  const typed = q.match(/^(-?\d+(?:\.\d+)?)\s*[,\s]\s*(-?\d+(?:\.\d+)?)$/);
  const hit =
    typed && Math.abs(typed[1]) <= 90 && Math.abs(typed[2]) <= 180
      ? { display_name: `${typed[1]}, ${typed[2]}`, lat: typed[1], lon: typed[2] }
      : (await getJson(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(q)}`))[0];
  if (!hit) return null;
  // 3 decimals, about 100 m, as for the flight services: the elevation data is no finer than that.
  const { elevation } = await getJson(`https://api.open-meteo.com/v1/elevation?latitude=${(+hit.lat).toFixed(3)}&longitude=${(+hit.lon).toFixed(3)}`);
  return { name: hit.display_name, lat: +hit.lat, lon: +hit.lon, elevM: elevation[0], runways: await runwaysNear(+hit.lat, +hit.lon) };
}

// Nominatim allows one request a second, so lookups queue up and repeats are answered from memory.
const geocodeLine = queue(1100);
// Held for a day at most (public/about.html says so), in memory only.
const lookups = new Map(); // address -> { at, result }
function forgetLookups(now = Date.now()) {
  for (const [key, held] of lookups) if (now - held.at < DAY) break; else lookups.delete(key); // oldest first
}
function geocode(q) {
  const key = q.toLowerCase();
  const now = Date.now();
  forgetLookups(now);
  if (!lookups.has(key)) {
    if (lookups.size >= 500) lookups.delete(lookups.keys().next().value);
    const result = geocodeLine(() => lookUp(q));
    result.catch(() => lookups.delete(key)); // don't remember failures
    lookups.set(key, { at: now, result });
  }
  return lookups.get(key).result;
}

// Login posts being read, or made to wait after a wrong password. Only a few at a time, so a flood of
// them cannot pile up in memory; the rest are told to come back.
const MAX_ENTERING = 20;
let entering = 0;

// The password typed into the login form. It is one short field, so a long body is not one.
async function posted(req) {
  let body = '';
  req.setEncoding('utf8');
  for await (const chunk of req) if ((body += chunk).length > 2000) return '';
  return new URLSearchParams(body).get('password') ?? '';
}

let active = 0;
const callers = new Map(); // public API counts for one minute; at most 5000 callers
async function handle(req, res) {
  res.setHeader('x-robots-tag', 'noindex, nofollow'); // a link shared with friends is not for search engines
  const json = (status, body) => res.writeHead(status, { 'content-type': 'application/json', ...(PUBLIC_HOST ? { 'cache-control': 'no-store' } : {}) }).end(JSON.stringify(body));
  const refuse = (seconds, error) => {
    seen.count('refused');
    res.setHeader('retry-after', String(seconds));
    return json(429, { error });
  };
  try {
    if (!URL.canParse(req.url, 'http://localhost')) return json(400, { error: 'not an address' });
    const url = new URL(req.url, 'http://localhost');
    const grant = sharing.get(req.headers['x-hfs-share']);
    // cloudflared supplies cf-connecting-ip. The public instance accepts loopback connections only.
    // Every per-client limit counts an IPv6 client by its /64 (stats.js).
    const who = network(PUBLIC_HOST ? (req.headers['cf-connecting-ip'] || 'local') : client(req));
    // DELETE api/sharing?closing: the page is closing, and its grant goes a minute after its last upload.
    // Only from the grant's own client address; switching sharing off works from anywhere.
    const withdraw = () => (url.searchParams.has('closing') ? sharing.close(req.headers['x-hfs-share'], who) : sharing.stop(req.headers['x-hfs-share']));
    if (PUBLIC_HOST) {
      res.setHeader('referrer-policy', 'strict-origin');
      res.setHeader('x-content-type-options', 'nosniff');
      res.setHeader('permissions-policy', 'camera=(), microphone=(self), geolocation=(self)');
      res.setHeader('content-security-policy', `default-src 'self'; script-src 'self' 'sha256-fOyL/EgYifGLDk26qXFnthKltRdK5PQBM7j6dKRHmCU='${LOGIN_HASHES}; style-src 'self' 'unsafe-inline'; img-src 'self' https://tile.openstreetmap.org; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`);
      if (!req.url.startsWith('/') || req.url.startsWith('//')) return json(400, { error: 'not an address' });
      if (req.headers.host !== PUBLIC_HOST) return json(404, { error: 'not found' });
      if (req.method !== 'GET' && req.headers.origin !== `https://${PUBLIC_HOST}`) return json(403, { error: 'Same-origin requests only.' });
      // Revocation must work even when this caller has exhausted the API quota, but not before the
      // password: behind one, it too needs the cookie.
      if (req.method === 'DELETE' && url.pathname === '/api/sharing') {
        const locked = admit && admit({ path: url.pathname, cookies: req.headers.cookie, https: req.headers['x-forwarded-proto'] === 'https' });
        if (locked?.status) return res.writeHead(locked.status, locked.headers).end(locked.body);
        withdraw();
        return json(200, { ok: true });
      }
      // A POST to the page itself is the password form, accepted only when there is a password.
      const upload = req.method === 'POST' && (['/api/log', '/api/sharing', '/api/contact'].includes(url.pathname) || (admit && url.pathname === '/'));
      if (req.method !== 'GET' && !upload) {
        seen.count('refused');
        res.setHeader('connection', 'close');
        return json(405, { error: 'GET only.' });
      }
      if (url.pathname.startsWith('/api/')) {
        const now = Date.now();
        let hit = callers.get(who);
        if (!hit || now - hit.at >= 60_000) {
          if (callers.size >= 5000) callers.delete(callers.keys().next().value);
          callers.set(who, hit = { at: now, count: 0 });
        }
        if (++hit.count > 300) {
          seen.count('refused');
          res.setHeader('retry-after', '60');
          return json(429, { error: 'Too many requests. Try again in a minute.' });
        }
      }
      if (active >= 32) {
        seen.count('refused');
        res.setHeader('retry-after', '5');
        return json(429, { error: 'Busy. Try again in a few seconds.' });
      }
    }
    active++;
    let released = false;
    const release = () => { if (!released) { released = true; active--; } };
    res.once('finish', release);
    res.once('close', release);
    // The counters are for the operator, on this machine only. Reading them counts for nothing.
    if (url.pathname === '/api/stats') return !PUBLIC_HOST && direct(req) ? json(200, seen.report()) : json(404, { error: 'not found' });
    seen.count('requests');
    if (admit) {
      const post = req.method === 'POST' && url.pathname === '/';
      if (post && entering >= MAX_ENTERING) return res.writeHead(429, { 'content-type': 'text/plain', connection: 'close' }).end('Busy. Try again in a moment.');
      if (post) entering++;
      try {
        const { ok, wrong, waiting, status, headers, body } = admit({
          path: url.pathname,
          cookies: req.headers.cookie,
          key: url.searchParams.get('key'),
          tried: post ? await posted(req) : null,
          https: req.headers['x-forwarded-proto'] === 'https',
        });
        if (ok) seen.visitor(who);
        else if (status && !waiting) seen.stranger(who); // a key link on its way in is not turned away
        if (wrong) {
          seen.count('badPasswords');
          // shortcut: this slows one guesser, not many guessing at once. Count attempts per address if
          // badPasswords in /api/stats ever climbs.
          await new Promise((done) => setTimeout(done, 1000));
        }
        if (status) return res.writeHead(status, headers).end(body);
      } finally {
        if (post) entering--;
      }
    } else seen.visitor(who);
    const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1).replace(/^r\/[\w-]+\//, '');
    const type = TYPES[name.split('.').pop()];
    if (type && /^[\w-]+([./][\w-]+)*$/.test(name)) {
      let body = await readFile(new URL(`public/${name}`, import.meta.url)).catch(() => null);
      if (body && name === 'index.html') {
        seen.count('pages');
        body = body.toString().replaceAll('r/RELEASE/', `r/${RELEASE || releaseOf()}/`);
      }
      if (body) return res.writeHead(200, { 'content-type': type, 'cache-control': PUBLIC_HOST ? 'no-store' : 'no-cache' }).end(body);
    }
    if (url.pathname === '/api/aircraft') {
      seen.count('api');
      const lat = parseFloat(url.searchParams.get('lat'));
      const lon = parseFloat(url.searchParams.get('lon'));
      if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180)) return json(400, { error: 'lat and lon are required' });
      // 3 decimals is about 100 m: plenty for a 30 nm query, and coarser than the address itself.
      const place = `${lat.toFixed(3)},${lon.toFixed(3)}`;
      const wait = PUBLIC_HOST && places.use(who, place);
      if (wait) return refuse(wait, 'Too many locations. Try again in a few minutes.');
      seen.watching(place);
      const { now, ...data } = await everything(lat.toFixed(3), lon.toFixed(3));
      // A page that is sharing its session names it. One that has gone, or switched sharing off since
      // it asked, has closed the connection: what it was not given is not kept.
      if (!req.socket.destroyed && sharing.valid(grant) && url.searchParams.get('log') === grant.id) log.frame(grant.id, now, data.ac);
      // age: seconds since the feed took this snapshot. The page uses it to refuse old data and to
      // allow for the delay; a feed that gives no time is taken at its word.
      return json(200, { ...data, age: now ? Math.max(0, (Date.now() - now) / 1000) : 0 });
    }
    if (url.pathname === '/api/sharing') {
      if (req.method === 'DELETE') {
        withdraw();
        return json(200, { ok: true });
      }
      if (req.method !== 'POST') return json(405, { error: 'POST or DELETE.' });
      if (req.headers['transfer-encoding'] || Number(req.headers['content-length'] || 0) !== 0) {
        res.setHeader('connection', 'close');
        return json(413, { error: 'No request body expected.' });
      }
      if (!log.request('GET').on) return json(503, { error: 'Sharing is unavailable.' });
      // A reloaded or duplicated tab presents the grant it had, for a new one of its own (consent.js).
      const next = sharing.exchange(grant, who) ?? sharing.start(who);
      if (!next) return json(429, { error: 'Sharing is busy. Try again later.' });
      // A grant is asked for once a page load, when sharing is on: the only visit counted.
      if (PUBLIC_HOST && req.headers['cf-connecting-ip']) activitySeen.visit(req.headers, true);
      return json(200, { id: next.id, token: next.token });
    }
    // The session log (log.js). Not counted as `api`: these ask nothing of the flight services.
    if (url.pathname === '/api/log') {
      if (req.method === 'POST' && !grant) return json(403, { error: 'Sharing is off.' });
      const text = req.method === 'POST' && log.on ? await body(req) : '';
      if (req.method === 'POST' && !sharing.valid(grant)) return json(403, { error: 'Sharing is off.' });
      const size = text == null ? 0 : Buffer.byteLength(text, 'utf8');
      if (req.method === 'POST' && text != null && !(grantBytes.spend(grant.token, size) && clientBytes.spend(who, size))) {
        return refuse(600, 'Too much shared this hour. Try again later.');
      }
      if (req.method === 'POST' && text != null) {
        let id;
        try { id = JSON.parse(text)?.id; } catch { return json(400, { error: 'Not JSON.' }); }
        if (id !== grant.id) return json(403, { error: 'Wrong sharing session.' });
      }
      if (text == null) res.setHeader('connection', 'close'); // too long: the rest of it is not read
      const { status, ...answer } = log.request(req.method, text);
      return json(status, answer);
    }
    // The contact form (contact.js). Nothing of a message is logged or kept: it is checked and handed on.
    if (url.pathname === '/api/contact') {
      const arrived = Date.now();
      let gone = false;
      res.once('close', () => { gone = true; });
      if (req.method !== 'POST') return json(200, { on: !!deliver });
      if (!deliver) return json(404, { error: 'Contact form is off.' });
      // Outside public mode too, a browser may post only from this page's own address (or a proxy's).
      const from = req.headers.origin?.replace(/^https?:\/\//, '');
      if (from && from !== req.headers.host && from !== req.headers['x-forwarded-host']) return json(403, { error: 'Same-origin requests only.' });
      if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/x-www-form-urlencoded') return json(415, { error: 'Form posts only.' });
      const text = await body(req, MAX_BODY);
      if (text == null) {
        res.setHeader('connection', 'close'); // too long: the rest of it is not read
        return json(413, { error: 'Message too long.' });
      }
      const { message, error } = check(text);
      if (error) return json(400, { error });
      const wait = contacts.take(who);
      if (wait === null) return json(503, { error: 'Not sent. Try again later.' });
      if (wait) return refuse(wait, 'Too many messages. Try again later.');
      // A page that has gone, or waited past its time, before this one's turn is not sent for.
      const sent = await sendContact(message, { arrived, gone: () => gone || req.socket.destroyed }).catch(() => 'failed');
      if (sent === 'sent') return json(200, { ok: true });
      if (sent === 'unconfirmed') return json(504, { error: 'Delivery unconfirmed' });
      return json(sent === 'dropped' ? 503 : 502, { error: 'Not sent. Try again later.' });
    }
    if (url.pathname === '/api/geocode') {
      seen.count('api');
      const q = url.searchParams.get('q')?.trim();
      if (!q || q.length > 200) return json(400, { error: 'q is required, up to 200 characters' });
      const wait = PUBLIC_HOST && searches.use(who, q.toLowerCase());
      if (wait) return refuse(wait, 'Too many lookups. Try again in a few minutes.');
      let hit;
      try {
        hit = await geocode(q);
        if (sharing.valid(grant)) activitySeen.search(hit ? 'found' : 'unmatched', hit);
      } catch (error) {
        if (sharing.valid(grant)) activitySeen.search('unavailable');
        throw error;
      }
      return hit ? json(200, hit) : json(404, { error: 'no match for that address' });
    }
    json(404, { error: 'not found' });
  } catch (e) {
    if (e.retryAfter > 0) res.setHeader('retry-after', String(e.retryAfter));
    json(e.status ?? 502, { code: e.code === 'flight_quota' ? 'flight_quota' : undefined, error: e.code === 'flight_quota' ? 'Flight-data provider quota exhausted.' : PUBLIC_HOST ? (e.status === 429 ? 'Busy. Try again in a few seconds.' : 'Data service unavailable. Try again shortly.') : e.message });
  }
}

// Listen on localhost and, when Tailscale is up, on this machine's tailnet address. Never the LAN.
// A public instance listens on loopback only, behind a tunnel.
const hosts = ['127.0.0.1'];
if (!PUBLIC_HOST) try {
  const ip = execFileSync('tailscale', ['ip', '-4'], { encoding: 'utf8' }).trim();
  if (ip) hosts.push(ip);
} catch {}
// A request must arrive whole within 15 s, so a sender that dribbles one in cannot hold a place for long.
for (const host of hosts) {
  const server = http.createServer({ requestTimeout: 15_000, connectionsCheckingInterval: 5000 }, handle);
  if (PUBLIC_HOST) server.maxConnections = 128;
  server.listen(PORT, host, () => console.log(`http://${host}:${PORT}`));
}
console.log(admit ? 'An access password is set.' : 'No access password: anyone who can reach this can use it.');
if (RECEIVER) console.log(`Adding aircraft from the receiver at ${new URL(RECEIVER).host}.`); // and stops here if that is no URL
if (log.on) console.log(`Keeping the sessions people share in ${process.env.LOG_DIR}.`);

// The log tells the same story as /api/stats: one line for every ten minutes in which anything happened.
const TEN_MIN = 600_000;
setInterval(() => {
  const line = seen.line(TEN_MIN);
  if (line) console.log(line);
}, TEN_MIN);

// A public instance's stats, for an optional local dashboard, are on their own loopback port, never
// the public listener.
if (process.env.OWNER_PORT) {
  if (!PUBLIC_HOST) throw new Error('OWNER_PORT requires PUBLIC_HOST.');
  http.createServer({ requestTimeout: 5000 }, (req, res) => {
    const allowed = req.method === 'GET' && req.url === '/api/stats' && direct(req)
      && !req.headers['cf-connecting-ip'] && !req.headers.origin
      && req.headers.host === `127.0.0.1:${process.env.OWNER_PORT}`;
    res.writeHead(allowed ? 200 : 404, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(allowed ? { ...seen.report(), activity: activitySeen.report() } : { error: 'not found' }));
  }).listen(process.env.OWNER_PORT, '127.0.0.1', () => console.log(`Stats on 127.0.0.1:${process.env.OWNER_PORT}`));
}
