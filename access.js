// The access password: it keeps strangers and crawlers off a public link. A gate, not a vault.
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';

// login.html as written is what follows a wrong password. The first visit gets it without that line.
const WRONG = readFileSync(new URL('login.html', import.meta.url), 'utf8');
const LOGIN = WRONG.replace(/ *<p id="wrong">.*\n/, '');
// Sent with the cookie once the password is right. The server can't see the path it is published
// under, so the page itself goes to its own address, without the key and ending in a slash.
const HEAD = '<!doctype html><meta charset="utf-8"><meta name="robots" content="noindex, nofollow"><title>Hold for Sound</title>';
const WELCOME = `${HEAD}
<script>location.replace(location.pathname.replace(/\\/*$/, '/'))</script>`;
// Sent for a link that carries the password as ?key=. The browser keeps a cookie to the folder of
// the address it came from, so the key is only traded for the cookie at the address that ends in a
// slash: this page goes there first if it has to, posts the key as the login form would, and then
// goes to the clean address. At the address without the slash the cookie would reach every site on
// this host.
const TRADE = `${HEAD}
<script>
if (!location.pathname.endsWith('/')) location.replace(location.pathname + '/' + location.search);
else fetch(location.pathname, { method: 'POST', body: new URLSearchParams({ password: new URLSearchParams(location.search).get('key') }) }).finally(() => location.replace(location.pathname));
</script>`;
// Everything login.html loads, and the notices page (public/about.html). Nothing else is served without access.
const OPEN = new Set(['/about.html', '/theme.css', '/icon.svg', '/fonts/barlow-semi-condensed-500.woff2', '/fonts/barlow-semi-condensed-700.woff2', '/fonts/barlow-semi-condensed-800.woff2']);
const YEAR_S = 365 * 24 * 3600;
// The inline scripts of the pages above, for a content security policy that names them by hash.
export const SCRIPTS = [WRONG, WELCOME, TRADE].flatMap((page) => [...page.matchAll(/<script>([^]*?)<\/script>/g)].map((m) => m[1]));

// The cookie holds a hash of the password, never the password. It needs nothing stored, so it
// outlives a restart, and it stops working the moment the password is changed.
const token = (password) => createHash('sha256').update(`hold-for-sound ${password}`).digest('base64url');
function same(a, b) {
  const [x, y] = [Buffer.from(a), Buffer.from(b)];
  return x.length === y.length && timingSafeEqual(x, y);
}

// gate(password) gives the check for one request: { path, cookies, key, tried, https }, where
// `cookies` is the cookie header, `key` a password carried by a link's ?key=, and `tried` one posted
// by the login form (or by the page a key link gets). It answers { ok, wrong, waiting, status,
// headers, body }. With a `status`, send that instead of serving the request; without one, serve it.
// `ok` says whether this client has access, `wrong` that the password it tried was not the one, and
// `waiting` that it was sent the page that trades a link's key for the cookie.
export function gate(password) {
  const want = token(password);
  const html = (status, body, more) => ({ status, headers: { 'content-type': 'text/html', 'cache-control': 'no-store', ...more }, body });
  return ({ path, cookies = '', key, tried, https }) => {
    // A browser can hold two of these, one set at the address with a closing slash and one without.
    const known = cookies.split(/;\s*/).some((cookie) => same(cookie, `hfs=${want}`));
    // A password only counts on the page itself, so the address the welcome page cleans is the page's.
    if (path === '/' && key != null && tried == null) return known ? { ok: true, ...html(200, WELCOME) } : { ok: false, waiting: true, ...html(200, TRADE) };
    if (path === '/' && tried != null) {
      if (!known && !same(token(tried), want)) return { ok: false, wrong: true, ...html(401, WRONG) };
      // No Path: the browser keeps the cookie to the directory the page is published under.
      return { ok: true, ...html(200, WELCOME, { 'set-cookie': `hfs=${want}; Max-Age=${YEAR_S}; HttpOnly; SameSite=Lax${https ? '; Secure' : ''}` }) };
    }
    if (known) return { ok: true };
    if (OPEN.has(path)) return { ok: false };
    if (path.startsWith('/api/')) {
      return { ok: false, status: 401, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, body: JSON.stringify({ error: 'Password needed. Reload the page.' }) };
    }
    return { ok: false, ...html(401, LOGIN) };
  };
}
