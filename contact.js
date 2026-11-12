// The contact form (POST api/contact): what a message must be, how many may be sent, and how one is
// delivered. Nothing of a message is kept or logged here: it is checked, handed on, and forgotten.
// Delivery is one function, so the way messages leave can change without touching the rest.

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
export const MAX_BODY = 16 * 1024;
export const CATEGORIES = ['feedback', 'inquiry', 'general'];
const FIELDS = ['name', 'email', 'category', 'message', 'website'];
const CONTROL = /\p{Cc}/u;
const length = (text) => [...text].length;

// A urlencoded body to { message } or { error }. Only the form's fields, each exactly once. The
// message is { name, email, category, message }, trimmed, its line breaks as \n.
// shortcut: MAX_BODY is percent-encoded bytes, so a long message in a non-Latin script can be refused
// as too long before its 5,000 characters.
export function check(text) {
  const form = new URLSearchParams(text ?? '');
  const keys = [...form.keys()];
  if (keys.length !== FIELDS.length || !FIELDS.every((field) => keys.filter((key) => key === field).length === 1)) return { error: 'Unexpected form fields.' };
  if (form.get('website') !== '') return { error: 'Not sent.' };
  const name = form.get('name').trim();
  const email = form.get('email').trim();
  const category = form.get('category');
  const message = form.get('message').replace(/\r\n?/g, '\n').trim();
  if (length(name) < 2 || length(name) > 100 || CONTROL.test(name)) return { error: 'Name: 2 to 100 characters.' };
  if (email.length > 254 || CONTROL.test(email) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { error: 'Enter a valid email.' };
  if (!CATEGORIES.includes(category)) return { error: 'Choose a category.' };
  if (length(message) < 10 || length(message) > 5000 || CONTROL.test(message.replace(/[\n\t]/g, ''))) return { error: 'Message: 10 to 5,000 characters.' };
  return { message: { name, email, category, message } };
}

// Per client network, `perClient` messages in `clientMs`, and `perDay` a day from everyone. take(who)
// is 0 when this one may go (and counts it), or the seconds until one may.
export function limits({ perClient = 3, clientMs = 15 * MIN, perDay = 30, clock = Date.now } = {}) {
  const clients = new Map(); // network -> times, oldest first; at most 5000 networks
  const all = [];
  const drop = (times, ms, now) => { while (times.length && now - times[0] >= ms) times.shift(); };
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
      clients.delete(who);
      if (clients.size >= 5000) clients.delete(clients.keys().next().value);
      clients.set(who, [...mine, now]);
      all.push(now);
      return 0;
    },
    sweep() {
      const now = clock();
      for (const [who, times] of clients) if ((drop(times, clientMs, now), !times.length)) clients.delete(who);
    },
  };
}

// Delivery by an HTTPS POST of JSON to `url`, with `token` as a bearer token when there is one. Any 2xx
// is sent; anything else throws, without the message.
export function webhook({ url, token, site, fetch = globalThis.fetch }) {
  if (!/^https?:$/.test(new URL(url).protocol)) throw new Error('CONTACT_URL must be an http(s) URL.');
  return async (message) => {
    const headers = { 'content-type': 'application/json', 'user-agent': 'flight-noise-poc/0.1' };
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ ...message, site }), signal: AbortSignal.timeout(10_000) });
    await res.body?.cancel();
    if (!(res.status >= 200 && res.status < 300)) throw new Error(`contact delivery answered ${res.status}`);
  };
}
