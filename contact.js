// The contact form (POST api/contact): what a message must be, how many may be sent, and how one is
// delivered. Nothing of a message is kept or logged here: it is checked, handed on, and forgotten.
// Delivery is one function, so the way messages leave can change without touching the rest.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { UNCHECKED, WAIT_MS } from './public/contact-core.js';

export { UNCHECKED };

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
export const MAX_BODY = 16 * 1024;
export const CATEGORIES = ['feedback', 'inquiry', 'general'];
const FIELDS = ['name', 'email', 'category', 'message', 'website'];
export const CHECK_FIELD = 'cf-turnstile-response'; // the Turnstile check's answer, when there is one
const CONTROL = /\p{Cc}/u;
const length = (text) => [...text].length;

// A urlencoded body to { message } or { error }. Only the form's fields, each exactly once, with the
// check's answer among them exactly when `checked` (CONTACT_SITEKEY is set). The message is
// { name, email, category, message }, trimmed, its line breaks as \n, and the answer as `token`.
// shortcut: MAX_BODY is percent-encoded bytes, so a long message in a non-Latin script can be refused
// as too long before its 5,000 characters.
export function check(text, { checked = false } = {}) {
  const form = new URLSearchParams(text ?? '');
  const keys = [...form.keys()];
  const fields = checked ? [...FIELDS, CHECK_FIELD] : FIELDS;
  if (keys.length !== fields.length || !fields.every((field) => keys.filter((key) => key === field).length === 1)) return { error: checked && !keys.includes(CHECK_FIELD) ? UNCHECKED : 'Unexpected form fields.' };
  if (form.get('website') !== '') return { error: 'Not sent.' };
  const name = form.get('name').trim();
  const email = form.get('email').trim();
  const category = form.get('category');
  const message = form.get('message').replace(/\r\n?/g, '\n').trim();
  if (length(name) < 2 || length(name) > 100 || CONTROL.test(name)) return { error: 'Name: 2 to 100 characters.' };
  if (email.length > 254 || CONTROL.test(email) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { error: 'Enter a valid email.' };
  if (!CATEGORIES.includes(category)) return { error: 'Choose a category.' };
  if (length(message) < 10 || length(message) > 5000 || CONTROL.test(message.replace(/[\n\t]/g, ''))) return { error: 'Message: 10 to 5,000 characters.' };
  if (!checked) return { message: { name, email, category, message } };
  const token = form.get(CHECK_FIELD);
  if (!token || token.length > 2048 || CONTROL.test(token)) return { error: UNCHECKED };
  return { message: { name, email, category, message, token } };
}

// Per client network, `perClient` messages in `clientMs`, and `perDay` a day from everyone. take(who)
// is 0 when this one may go (and counts it), the seconds until one may, or null when its time cannot
// be saved (it is not counted, and must not go).
// The day's send times, and nothing else (no sender, address or network), are kept in `file` when
// there is one, so a restart gives nothing back: written whole or not at all, a file that cannot be
// read or understood counts as the day spent, and a missing one is a fresh start. The per-network
// counts are in memory only.
export function limits({ perClient = 3, clientMs = 15 * MIN, perDay = 30, clock = Date.now, file } = {}) {
  const clients = new Map(); // network -> times, oldest first; at most 5000 networks
  const all = [];
  const drop = (times, ms, now) => { while (times.length && now - times[0] >= ms) times.shift(); };
  const save = () => {
    if (!file) return true;
    try {
      writeFileSync(`${file}.tmp`, JSON.stringify({ v: 1, sent: all }), { mode: 0o600 });
      renameSync(`${file}.tmp`, file);
      return true;
    } catch (e) {
      console.log(`The contact form's day cannot be saved, so nothing is sent: ${e.code ?? e.message}`);
      return false;
    }
  };
  if (file) {
    try {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      const saved = JSON.parse(readFileSync(file, 'utf8'));
      if (saved?.v !== 1 || !Array.isArray(saved.sent) || !saved.sent.every((at) => Number.isFinite(at) && at >= 0)) throw new Error('not a contact budget');
      all.push(...saved.sent.sort((a, b) => a - b).slice(-perDay));
    } catch (e) {
      if (e.code !== 'ENOENT') {
        all.push(...Array(perDay).fill(clock()));
        console.log(`The contact form's saved day cannot be read (${e.code ?? e.message}): today's is taken as spent.`);
        save();
      }
    }
  }
  return {
    take(who) {
      const now = clock();
      drop(all, DAY, now);
      const mine = clients.get(who) ?? [];
      drop(mine, clientMs, now);
      const wait = Math.max(
        mine.length >= perClient ? mine.at(-perClient) + clientMs - now : 0,
        all.length >= perDay ? all.at(-perDay) + DAY - now : 0,
      );
      if (wait > 0) return Math.ceil(wait / 1000);
      all.push(now);
      if (!save()) {
        all.pop();
        return null;
      }
      clients.delete(who);
      if (clients.size >= 5000) clients.delete(clients.keys().next().value);
      clients.set(who, [...mine, now]);
      return 0;
    },
    sweep() {
      const now = clock();
      for (const [who, times] of clients) if ((drop(times, clientMs, now), !times.length)) clients.delete(who);
    },
  };
}

// Delivery by an HTTPS POST of JSON to `url`, with `token` as a bearer token when there is one, given
// `ms` to answer. Only a 2xx is sent: a redirect is not followed (it would arrive as a GET with no
// body), and anything else throws, without the message, with the answer's `status`. No answer in time
// throws with `unconfirmed`, since the message may have arrived.
export function webhook({ url, token, site, fetch = globalThis.fetch }) {
  if (!/^https?:$/.test(new URL(url).protocol)) throw new Error('CONTACT_URL must be an http(s) URL.');
  return async (message, ms = 10_000) => {
    const headers = { 'content-type': 'application/json', 'user-agent': 'flight-noise-poc/0.1' };
    if (token) headers.authorization = `Bearer ${token}`;
    let res;
    try {
      res = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ ...message, site }), redirect: 'error', signal: AbortSignal.timeout(ms) });
      await res.body?.cancel();
    } catch (e) {
      const late = e?.name === 'TimeoutError' || e?.name === 'AbortError';
      throw Object.assign(new Error(late ? 'contact delivery did not answer in time' : 'contact delivery failed'), { unconfirmed: late });
    }
    if (!(res.status >= 200 && res.status < 300)) throw Object.assign(new Error(`contact delivery answered ${res.status}`), { status: res.status });
  };
}

// The server answers the page within TOTAL_MS of a message's arrival, a margin inside the page's wait,
// so the page never gives up on a message that then goes.
export const TOTAL_MS = WAIT_MS - 5000;

// Messages go one at a time through `line`, each within `totalMs` of its arrival. One whose sender has
// gone (`gone()`) or whose time has run out before its turn is dropped unsent, and a delivery is given
// only the time left, and none is begun with less than `leastMs` left. send(message, { arrived, gone })
// resolves 'sent', 'dropped', 'unconfirmed', 'unchecked' (delivery answered 400 to a message carrying
// a check's token: the check failed) or 'failed'; it rejects only when the line is full.
export function dispatch({ line, deliver, totalMs = TOTAL_MS, leastMs = 1000, clock = Date.now }) {
  return (message, { arrived = clock(), gone = () => false } = {}) => line(async () => {
    const left = arrived + totalMs - clock();
    if (gone() || left < leastMs) return 'dropped';
    try {
      await deliver(message, left);
      return 'sent';
    } catch (e) {
      if (e.unconfirmed) return 'unconfirmed';
      return e.status === 400 && message?.token ? 'unchecked' : 'failed';
    }
  });
}
