import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gate } from '../access.js';

const admit = gate('quiet-on-set');
const page = (more) => admit({ path: '/', ...more });
// The cookie a right password earns, as a browser would send it back.
const cookieFor = (check, password) => check({ path: '/', tried: password }).headers['set-cookie'].split(';')[0];
const cookie = cookieFor(admit, 'quiet-on-set');

test('without the cookie the page is a login page and the API is a 401', () => {
  for (const cookies of [undefined, 'hfs=', 'hfs=quiet-on-set', 'other=1; hfs=nonsense']) {
    const login = page({ cookies });
    assert.equal(login.ok, false);
    assert.equal(login.status, 401);
    assert.match(login.body, /<form method="post">/);
    assert.doesNotMatch(login.body, /id="wrong"/); // nothing was tried, so nothing was wrong
    assert.match(login.body, /name="robots" content="noindex, nofollow"/);

    const api = admit({ path: '/api/aircraft', cookies });
    assert.equal(api.status, 401);
    assert.equal(api.headers['content-type'], 'application/json');
    assert.ok(JSON.parse(api.body).error);
  }
});

test('the cookie lets everything through, even beside another copy that has stopped working', () => {
  for (const path of ['/', '/app.js', '/api/aircraft', '/api/geocode']) {
    assert.deepEqual(admit({ path, cookies: cookie }), { ok: true });
    assert.deepEqual(admit({ path, cookies: `theme=dark; hfs=old; ${cookie}` }), { ok: true });
  }
});

test('a link that carries the password trades it for the cookie only at the address that ends in a slash', () => {
  // The link itself sets no cookie: at /hold-for-sound?key=… the browser would keep it for the whole host.
  const trade = page({ key: 'quiet-on-set' });
  assert.deepEqual([trade.ok, trade.waiting, trade.status, trade.headers['set-cookie']], [false, true, 200, undefined]);
  assert.doesNotMatch(trade.body, /quiet-on-set/);
  const script = trade.body.match(/<script>([^]*)<\/script>/)[1];
  const run = (pathname) => {
    const did = [];
    const fetch = (to, { method, body }) => (did.push(`${method} ${to} ${body}`), { finally: (then) => then() });
    new Function('location', 'fetch', script)({ pathname, search: '?key=quiet-on-set', replace: (to) => did.push(`go ${to}`) }, fetch);
    return did;
  };
  assert.deepEqual(run('/hold-for-sound'), ['go /hold-for-sound/?key=quiet-on-set']); // first to the slash, key and all
  assert.deepEqual(run('/hold-for-sound/'), ['POST /hold-for-sound/ password=quiet-on-set', 'go /hold-for-sound/']); // then the trade, then the clean address
  assert.deepEqual(run('/'), ['POST / password=quiet-on-set', 'go /']);
  // A wrong key gets the same page: the post it makes is what is refused and counted.
  assert.equal(page({ key: 'nope' }).body, trade.body);
  // Someone already in gets the clean address at once.
  assert.deepEqual([page({ key: 'anything', cookies: cookie }).ok, page({ key: 'anything', cookies: cookie }).headers['set-cookie']], [true, undefined]);
});

test('a right password sets the cookie and sends the page to its own clean address', () => {
  const welcome = page({ tried: 'quiet-on-set' });
  assert.equal(welcome.ok, true);
  assert.equal(welcome.status, 200);
  assert.deepEqual(admit({ path: '/app.js', cookies: cookie }), { ok: true });

  // The server can't see the path it is published under, so the page works its own address out.
  const script = welcome.body.match(/<script>(.*)<\/script>/)[1];
  const lands = (pathname) => {
    let went;
    new Function('location', script)({ pathname, replace: (to) => (went = to) });
    return went;
  };
  assert.equal(lands('/hold-for-sound/'), '/hold-for-sound/');
  assert.equal(lands('/hold-for-sound'), '/hold-for-sound/');
  assert.equal(lands('/'), '/');
});

test('a wrong password gets the login page again, saying so', () => {
  for (const tried of ['', 'quiet-on-set ', 'Quiet-On-Set', 'x'.repeat(5000)]) {
    const again = page({ tried });
    assert.equal(again.ok, false);
    assert.equal(again.wrong, true);
    assert.equal(again.status, 401);
    assert.match(again.body, /id="wrong">Wrong password\./);
    assert.equal(again.headers['set-cookie'], undefined);
  }
  // Someone already in who posts an old password is not turned away for it.
  assert.equal(page({ tried: 'old-password', cookies: cookie }).ok, true);
});

test('a password only counts on the page itself', () => {
  assert.equal(admit({ path: '/api/aircraft', tried: 'quiet-on-set' }).status, 401);
  assert.equal(admit({ path: '/app.js', tried: 'quiet-on-set' }).status, 401);
  assert.equal(admit({ path: '/api/aircraft', key: 'quiet-on-set' }).status, 401);
  assert.equal(admit({ path: '/app.js', key: 'quiet-on-set' }).waiting, undefined);
});

test('the cookie lasts a year, hides the password, and is Secure only over https', () => {
  const plain = page({ tried: 'quiet-on-set' }).headers['set-cookie'];
  const secure = page({ tried: 'quiet-on-set', https: true }).headers['set-cookie'];
  assert.match(plain, /^hfs=[\w-]{43}; Max-Age=31536000; HttpOnly; SameSite=Lax$/);
  assert.equal(secure, `${plain}; Secure`);
  assert.doesNotMatch(plain, /quiet-on-set|Path/i); // no Path: the browser keeps it to where the page is published
});

test('changing the password ends every access the old one gave', () => {
  const changed = gate('new-password');
  assert.equal(changed({ path: '/', cookies: cookie }).status, 401);
  assert.equal(changed({ path: '/api/aircraft', cookies: cookie }).status, 401);
  assert.deepEqual(changed({ path: '/', cookies: cookieFor(changed, 'new-password') }), { ok: true });
});

test('nothing is served without access but what the login page loads, and the notices page', () => {
  const root = fileURLToPath(new URL('../public', import.meta.url));
  const files = readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => `/${relative(root, join(entry.parentPath, entry.name)).split(sep).join('/')}`);
  assert.ok(files.includes('/app.js') && files.includes('/fonts/OFL.txt'), `found the files, got ${files}`);
  const open = [...files, '/', '/index.html', '/api/aircraft', '/api/geocode', '/api/anything', '/login.html'].filter((path) => !admit({ path }).status);

  // What the login page and the notices page load: their own files, and the typeface the stylesheet names.
  const loads = (file) => [...readFileSync(new URL(file, import.meta.url), 'utf8').matchAll(/(?:href|src)="(?!https:|\.\/")([^"]+)"/g)].map((m) => `/${m[1]}`);
  const links = loads('../login.html');
  const fonts = [...readFileSync(new URL('../public/theme.css', import.meta.url), 'utf8').matchAll(/url\(([^)]+)\)/g)].map((m) => `/${m[1]}`);
  assert.deepEqual(open.sort(), [...new Set([...links, ...loads('../public/about.html'), ...fonts, '/about.html'])].sort());
  assert.deepEqual(links.sort(), ['/icon.svg', '/theme.css']);
  for (const path of open) assert.equal(admit({ path }).ok, false); // served, but not counted as having access
});
