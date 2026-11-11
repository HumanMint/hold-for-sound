// Sharing a session with the developer: the switch at the bottom of the page, and the two marks a
// person taps to say what they hear. Off until the switch is on, and absent altogether when the
// server keeps no log (GET api/log). What is recorded and sent is in share-core.js; this file is the
// page around it. See the events described in app.js.
// The line under the switch is the consent: it must go on saying everything that is sent, the
// spectrogram and what can show in it included. Change it when share-core.js sends anything new.

import { createShare } from './share-core.js?v=7';

const send = (name, detail) => document.dispatchEvent(new CustomEvent(name, { detail }));
// The switch is remembered in this browser. A page loaded with it on starts a new session. A tab
// reloaded or duplicated presents the grant it had (kept in sessionStorage) and is given a new one of
// its own, which the server does not count as another start. This version requires accepting the
// problem-report and personal-experiment confirmation.
const CHOICE = 'hfs:share:v3';
const stored = (on) => {
  try {
    if (on == null) return localStorage.getItem(CHOICE) === 'on';
    if (on) localStorage.setItem(CHOICE, 'on');
    else localStorage.removeItem(CHOICE);
  } catch {}
  return false;
};

const TAB = 'hfs:grant';
const kept = (token) => {
  try {
    if (token === undefined) return sessionStorage.getItem(TAB);
    if (token) sessionStorage.setItem(TAB, token);
    else sessionStorage.removeItem(TAB);
  } catch {}
  return null;
};

let grant = null;
let starting = false;
// The remembered choice was refused a grant: the switch stays on, so that turning it off withdraws it.
let waiting = '';
let change = 0;
// `closing`: the page is closing, and the server lets the grant go a minute after its last upload. Its
// token stays in the tab, for a reload to present.
function revoke(previous, closing) {
  if (previous?.token) fetch(`api/sharing${closing ? '?closing' : ''}`, { method: 'DELETE', headers: { 'x-hfs-share': previous.token }, keepalive: true }).catch(() => {});
  if (!closing) kept(null);
}

// `off` cancels it when sharing is switched off.
async function post(text, off) {
  // keepalive: a batch sent as the page is hidden or closed still arrives.
  if (!grant) return { full: true };
  const res = await fetch('api/log', { method: 'POST', headers: { 'x-hfs-share': grant.token }, body: text, keepalive: true, signal: AbortSignal.any?.([off, AbortSignal.timeout(15_000)]) ?? off });
  if (res.status === 403 || res.status === 404) return { full: true }; // the server keeps no log any more
  if (res.status === 400 || res.status === 413) return {}; // it will never take this batch: let it go
  if (!res.ok) throw new Error(res.status);
  return res.json();
}

// The page's events are followed from the start, so that a session knows the set and the banner it
// begins with. Until the switch is on nothing is kept of them but the last of each.
const core = createShare({ post, id: () => grant.id, announce: (id) => {
  send('hfs:share', { id, token: id ? grant?.token : null });
  if (!id) { revoke(grant); grant = null; }
}, changed: () => { starting = false; waiting = ''; change++; stored(false); show(); }, trimmed: () => show() });
for (const name of ['update', 'status', 'tune', 'heard']) document.addEventListener(`hfs:${name}`, (e) => core[name](e.detail));
let show = () => {};

// `retry`: this start comes from the remembered choice (on load, or again after a refusal), how many
// tries are left. A refusal then stays in this tab: the choice, and sharing in other tabs, are kept.
async function choose(on, retry = 0) {
  if (on && (core.on || starting)) return;
  const mine = ++change;
  starting = on;
  waiting = '';
  if (!on) {
    core.stop();
    revoke(grant);
    grant = null;
    stored(false);
    show();
    return;
  }
  stored(true); // Make a pending opt-in cancellable by Off in another tab.
  show();
  try {
    const previous = kept();
    const exchange = /^[\w-]{32}$/.test(previous) ? { 'x-hfs-share': previous } : {};
    const response = await fetch('api/sharing', { method: 'POST', headers: exchange, signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error('Sharing unavailable');
    const issued = await response.json();
    if (!/^[0-9a-f]{16}$/.test(issued.id) || !/^[\w-]{32}$/.test(issued.token)) throw new Error('Invalid sharing grant');
    if (mine !== change) { revoke(issued); return; }
    grant = { id: issued.id, token: issued.token };
    kept(grant.token);
    starting = false;
    core.start();
    show();
  } catch {
    if (mine !== change) return;
    starting = false;
    if (!retry) stored(false);
    else waiting = retry > 1 ? 'Sharing unavailable. Trying again…' : 'Sharing unavailable. Reload to try again.';
    show();
    if (!retry) document.querySelector('.share-state').textContent = 'Sharing unavailable. Try again.';
    // A closing page's grant is let go a minute after it closes.
    if (retry > 1) setTimeout(() => mine === change && stored() && choose(true, retry - 1), 65_000);
  }
}

function build() {
  document.querySelector('footer').insertAdjacentHTML(
    'afterbegin',
    `<div class="share">
      <label><input type="checkbox" role="switch" aria-describedby="shares"> Share data with the developer</label>
      <p id="shares">Sends the set's coordinates, the page's predictions, your marks, sound levels, and a detailed spectrogram of the sound: from 30 s before to 30 s after each predicted aircraft, and to a minute after each mark; and from 10 s before to 10 s after other aircraft-like noise lasting 20 s or more, up to 15 min an hour. Not a recording, but sounds near the microphone, speech included, can show in it. Audio is never sent. Also shares your approximate connection region (from Cloudflare) and rounded searched locations with lookup results, kept for about 24 hours, without the addresses typed. Session files are kept for up to 90 days. Only the developer sees them. Your choice is remembered in this browser. <a href="about.html#privacy" target="_blank" rel="noopener">Privacy</a></p>
      <p class="share-id" hidden>Session ID <span></span></p>
      <span class="share-state" role="status"></span>
    </div>
    <dialog class="share-confirm" aria-labelledby="share-confirm-title" aria-describedby="share-confirm-purpose">
      <h2 id="share-confirm-title" tabindex="-1" autofocus>Share a problem report?</h2>
      <p id="share-confirm-purpose">Please share only if the page isn't working as expected.</p>
      <ul>
        <li><b>No audio recording is uploaded.</b> Microphone diagnostics include sound levels and a spectrogram—a visual pattern of sound. Nearby speech can show in it.</li>
        <li><b>Shares set coordinates, predictions and your marks,</b> plus approximate connection region (from Cloudflare) and rounded search results, without the addresses typed.</li>
        <li><b>No device name, model or microphone ID is added to session files.</b> Normal web requests still send IP and browser information.</li>
      </ul>
      <p>Region and searches: about 24 hours. Session files: kept for up to 90 days. You can switch sharing off at any time. <a href="about.html#privacy" target="_blank" rel="noopener">Privacy</a></p>
      <p class="share-acknowledgment">I understand this is a personal experiment, not a production service.</p>
      <form method="dialog">
        <button class="quiet" value="decline">Decline</button>
        <button value="accept">Accept and share</button>
      </form>
    </dialog>`,
  );
  // In the top line on a tablet, along the bottom edge on a phone (share.css): places that are theirs
  // alone, so showing them moves nothing.
  document.querySelector('header').insertAdjacentHTML(
    'beforeend',
    `<div id="marks" hidden>
      <button type="button" value="heard">I hear an aircraft</button>
      <button type="button">Quiet now</button>
      <span role="status"></span>
    </div>`,
  );
  const toggle = document.querySelector('.share input');
  const marks = document.getElementById('marks');
  const confirmation = document.querySelector('.share-confirm');
  const session = document.querySelector('.share-id');
  let confirming = 0;
  show = () => {
    marks.hidden = !core.on;
    // The session's id, so its user can ask for it to be deleted.
    session.hidden = !(core.on && grant);
    session.lastElementChild.textContent = grant?.id ?? '';
    toggle.checked = starting || core.on || !!waiting;
    // Near the session's size the server takes no more spectrogram; the rest is still sent.
    document.querySelector('.share-state').textContent = starting ? 'Starting sharing…' : waiting || (core.on && !core.spec ? 'Spectrogram: stopped, session full' : '');
  };

  toggle.addEventListener('change', () => {
    if (!toggle.checked) return void choose(false);
    show(); // The switch stays off until the visitor accepts and a grant arrives.
    confirming = change;
    confirmation.returnValue = '';
    confirmation.showModal();
  });
  // Native close is queued: an Off from another tab must still win before this handler runs.
  confirmation.addEventListener('close', () => {
    if (confirmation.returnValue === 'accept' && confirming === change) choose(true);
    else show();
  });
  // A tap is answered on the button itself, which is filled for a moment, and in words for a screen reader only.
  marks.addEventListener('click', (e) => {
    const button = e.target.closest('button');
    if (!button) return;
    core.mark(button.value === 'heard');
    core.flush();
    clearTimeout(button.done);
    button.dataset.done = '';
    button.done = setTimeout(() => delete button.dataset.done, 1500);
    marks.lastElementChild.textContent = `Marked at ${new Date().toLocaleTimeString('en-GB')}`;
  });

  setInterval(() => core.flush(), 20_000);
  document.addEventListener('visibilitychange', () => document.hidden && core.flush());
  // The last upload goes first; then the grant is let go, unless the page is only put aside (bfcache).
  addEventListener('pagehide', (event) => {
    core.flush();
    if (!event.persisted) revoke(grant, true);
  });

  addEventListener('storage', (event) => {
    if (event.key !== CHOICE || event.newValue === 'on') return;
    choose(false);
    if (confirmation.open) confirmation.close('decline');
  });
  if (stored()) choose(true, 3);
}

// Only once the server says it keeps a log: without one nothing is put on the page and nothing is
// ever kept or sent. And only once the whole page has loaded, so that app.js is there to hear which
// session is being shared.
fetch('api/log')
  .then((res) => res.ok && res.json())
  .then(async (log) => {
    if (!log?.on) return;
    if (document.readyState !== 'complete') await new Promise((done) => addEventListener('load', done, { once: true }));
    build();
  })
  .catch(() => {});
