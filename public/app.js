import { ENVIRONMENTS, CLASS_NAME, HORIZON_S, ifDeparts, unseen } from './predict.js';
import { freshWeather } from './weather.js';
import { parse as crewParse, link as crewLink, matches as crewMatches } from './crew.js';
import { follow } from './lost.js';
import { notHeard } from './unheard.js';
import { widen } from './widen.js';
import { remember, motion } from './motion.js';
import { status, steady, staleAfter } from './status.js';
import { locate, blocked, failed, WAIT_MS } from './locate.js';
import { engine, shape, ENGINE_NAME } from './engine.js';
import { details, where } from './details.js';
import { feedResponse, retryIn, pacer } from './feed.js?v=3';

const $ = (id) => document.getElementById(id);
document.documentElement.dataset.started = ''; // boot.js: the page has started
const form = $('setup');
const settings = $('settings');
$('change').addEventListener('click', () => {
  settings.showModal();
  settings.scrollTop = 0;
});
$('close-settings').addEventListener('click', () => settings.close());
const mmss = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
// The page is brought up to date every second. Only text that changed is touched, so nothing flickers
// and hover, focus, and selection stay where they are.
const put = (el, text) => {
  if (el.textContent !== text) el.textContent = text;
};

let site = null; // { name, lat, lon, elevM, runways }
let windows = []; // predicted audible windows, start/end in epoch ms
let lastData = 0; // epoch ms the newest flight data describes: the last good poll, less the feed's own delay
let polledAt = 0; // epoch ms that data arrived
let every = 0; // seconds the server keeps this answer: 10 in public, a minute while the sky is quiet (cadence.js)
let feedError = ''; // the error from the last poll, or '' if it worked
const pace = pacer(); // when to ask for flight data again, and when the server said it may come back (feed.js)
let holding = false;
let shown = null; // the status on the banner, as status.js returned it
const warned = new Map(); // hex -> epoch ms of its last heads-up
let taxiing = []; // aircraft on the ground that would be audible if they took off
const arrivingAt = new Map(); // hex -> epoch ms last seen on final approach
const inUse = new Set(); // "AIRPORT RUNWAY" for runway directions seen in use
const known = new Map(); // hex -> the feed row behind its last prediction, so one the feed loses can be carried on (lost.js)
const moves = new Map(); // hex -> its last few reports, for how it has been moving (motion.js)
let selected = null; // hex of the aircraft picked in the list, on the map, or on the timeline
let listedAt = 0; // when the list was last brought up to date
let shareToken = '';
let shared = ''; // added to the feed request while this session is being shared (share.js)
let unshare = new AbortController(); // cancels a feed request that names a session no longer shared
document.addEventListener('hfs:share', (e) => {
  unshare.abort();
  unshare = new AbortController();
  shared = e.detail.id ? `&log=${e.detail.id}` : '';
  shareToken = e.detail.token || '';
});

// The other parts of the page (map.js, listen.js) are separate modules. They never import this file;
// everything is passed as events on `document`:
//   hfs:update  from here after every poll. detail: { at, dataAt, staleMs, site, env, floor, trim, learned, aircraft, tracks, windows, taxiing, weather }
//               `at` is the moment the paths are measured from. `dataAt` is how fresh the feed's data is
//               (earlier than `at` when the feed is behind): nothing may look live once it is `staleMs`
//               old (20 s, or 80 s on a quiet sky's answer kept for a minute: staleAfter() in status.js).
//               `weather` is the forecast used by prediction, null when unavailable or older than an hour.
//               Weather withdrawal repeats the last update with the same flight timestamps and weather: null.
//               `aircraft` is the raw feed, `tracks` is predict() for every aircraft with no floor (so each
//               has its whole `path`), `windows` are the audible ones with start/end in epoch ms
//               (widened by `hfs:timing`). Both carry `seenAt`, the epoch ms of the position they rest
//               on, and `lost: true` once the answer leaves it out or its position is 20 s older than the answer: this
//               is an estimate. An aircraft
//               the feed has dropped can still be in `tracks` and `windows`, with no row in `aircraft`
//               (lost.js has the rules). Nothing may show an estimate as a reported position.
//   hfs:status  from here when the banner changes. detail: { state, until, checking, early, unsure, notHeard }:
//               `state` is 'hold', 'soon', 'clear', or '' when there is nothing to go on. It is the one
//               status every part of the page shows. The rest is steady() in status.js as the banner
//               shows it: `until` the epoch ms it counts down to (null for none), `checking` a hold kept
//               up after its prediction ended, `early` when that ended well before it was due, and
//               `unsure` the hex of an aircraft lost while still due (null for none). Sent again when
//               any of it changes. `notHeard` is the hex of a current helicopter downgraded by the
//               microphone (null for none); the state remains heads up.
//   hfs:select  from anyone. detail: { hex } or { hex: null }. Everyone highlights that aircraft.
//   hfs:tune    from listen.js. detail: { floor, trim, early, demo }: what the microphone has learned
//               about this set and environment, with floor: null when that is nothing. `early: true`
//               marks a floor that only lowers the user's own level, from under 4 passes (tune.js).
//               `demo: true` marks tuning from the demo sound: it is applied but never saved, and everything it changed is put
//               back by the next hfs:tune without it. hfs:update's `trim` and `learned` are the tuning
//               in effect (`learned` is the floor, null for none), so listen.js can see what the page
//               has and send again whenever that is not what it has learned.
//   hfs:heard   from listen.js, once for each second of listening. detail: { demo, rate, status, columns,
//               observations, stale }: the engine's status for that second (hear.js), the spectrogram
//               columns it made in it (read them, never change them), and the passes it filed, each
//               with `lost: true` if it was not learned from because its track was an estimate. `demo`
//               marks the demo sound, `stale` old flight data, and `rate` is the sample rate.
//               Nothing on the page acts on it: share.js records it when the user has sharing on.
//   hfs:timing  from listen.js. detail: { offsets, lag, demo }: how many seconds after (+) or before (-)
//               its track an aircraft was heard to pass, measured from the curve of its tones (hear.js
//               `curves`). `offsets` maps hex to that aircraft's own, and `lag` is what the last few
//               said, for the rest (null for nothing yet). poll() below widens each audible window by
//               it (widen.js), to at most LATE_S: earlier starts when the sound came early, later ends
//               when it came late, never the other way, and never a `lost` one. Not saved.
//   hfs:audibility from listen.js. detail: { at, hexes }: current helicopters not heard after 20 s
//               of continuous ready, real microphone listening. Any rise restores the hold for that
//               window. Empty on stop, mute, background reset or set/environment change. Expires in
//               2 s; no estimates, stale data or demo can downgrade a hold. Never saved or uploaded.
//   hfs:share   from share.js. detail: { id, token }: the consented session being shared, or null. poll() below names it
//               in its request, so the server keeps the feed it serves beside that session's log.
const send = (name, detail) => document.dispatchEvent(new CustomEvent(name, { detail }));

// `floor` is the level the microphone found to be just audible here, `trim` its dB correction per
// aircraft class. The slider follows the learned floor; moving the slider keeps your offset from it.
// `manual` is where the slider stood before the microphone took it over, and where it goes back to
// when the microphone has nothing to say any more (null while the slider is your own). An early floor
// only stands in for your own level, so moving the slider under one sets that level too.
let tuned = { floor: null, trim: {} };
let audibility = null; // ephemeral microphone evidence, expires after two seconds
let timing = { offsets: {}, lag: null }; // how late the feed has been running here (hfs:timing)
const widened = new Map(); // hex -> the last window widened by it, kept to its widened end (widen.js)
let offset = 0;
let manual = null;
let crewLevel = null; // linked manual level, awaiting this device's first learned floor
let real = null; // while a demo is tuning the page: { tuned, offset, manual, floor } from before it, to put back

// Put back everything a demo changed.
function endDemo() {
  if (!real) return;
  ({ tuned, offset, manual } = real);
  form.floor.value = real.floor;
  real = null;
}

// What was learned belongs to one set and one environment, so it is dropped when either changes.
// listen.js then sends what it knows about the new one.
function untune() {
  audibility = null;
  crewLevel = null;
  endDemo();
  if (manual != null) form.floor.value = manual;
  tuned = { floor: null, trim: {} };
  timing = { offsets: {}, lag: null };
  offset = 0;
  manual = null;
}

const label = (w) => [w.flight || w.hex, w.desc || w.t, CLASS_NAME[w.category]].filter(Boolean).join(', ');
const doing = (w) => `${w.phase ? `, ${w.phase} runway ${w.runway}` : ''}${w.lost ? ' (estimate: contact lost)' : ''}`;
const loudness = (w) => (w.margin < 5 ? 'faint' : w.margin < 15 ? 'audible' : 'loud');
const clock = (at = Date.now()) => new Date(at).toLocaleTimeString('en-GB'); // 19:04:31, the way time-of-day timecode reads
const airportsOf = (list) => [...new Set(list.map((w) => w.airport))].join(' and ');

// Takeoffs that would be heard here before the feed may show them (predict.js), for the set and
// settings in use. Worked out again only when one of those changes.
let weather = null;
let update = null;
function sendUpdate(detail) {
  update = detail;
  send('hfs:update', detail);
}
// Withdraw the weather without advancing the flight data's clock.
function clearWeather() {
  weather = null;
  if (update?.weather) sendUpdate({ ...update, weather: null });
}
let rolls = { key: '', list: [] };
function takeoffs() {
  const opts = { loss: ENVIRONMENTS[form.env.value].loss, floor: +form.floor.value, runways: site.runways, trim: tuned.trim, weather: freshWeather(weather, Date.now()), weatherAt: Date.now() };
  const key = JSON.stringify([site.lat, site.lon, opts.loss, opts.floor, opts.trim, opts.weather]);
  if (rolls.key !== key) rolls = { key, list: unseen(site, opts) };
  return rolls.list;
}

// `kind` is hold, soon, or clear: it picks the mark beside the entry.
function log(kind, text) {
  const li = document.createElement('li');
  li.dataset.kind = kind;
  li.append(Object.assign(document.createElement('span'), { textContent: text }), ' ', Object.assign(document.createElement('time'), { textContent: clock() }));
  $('log').prepend(li);
  if ($('log').children.length > 200) $('log').lastChild.remove(); // a shoot day is long
}

function save() {
  if (real) return; // nothing a demo changed is kept
  try {
    localStorage.setItem('hfs', JSON.stringify({ q: form.q.value, env: form.env.value, floor: form.floor.value, manual, offset, site }));
  } catch {}
}

// The one-line summary the setup form folds down to, and who set the warning level.
function showSetup() {
  const mic = tuned.floor != null;
  $('crew').hidden = !site;
  $('floorOut').textContent = form.floor.value;
  $('where').textContent = site ? site.name : 'Choose a location';
  $('change').textContent = site ? 'Change' : 'Set up';
  const by = real ? 'the demo sound' : 'the microphone';
  $('levels').textContent = `${form.querySelector('[name=env]:checked').dataset.short}, warns above ${form.floor.value} dBA${mic ? ` (set by ${by})` : ''}`;
  const moved = Math.round(offset);
  $('floorBy').textContent = mic ? `Set by ${by}${moved ? `, then moved ${moved > 0 ? 'up' : 'down'} ${Math.abs(moved)} dB by you` : ''}.` : '';
}

function showSite() {
  const map = Object.assign(document.createElement('a'), {
    href: `https://adsb.lol/?lat=${site.lat.toFixed(3)}&lon=${site.lon.toFixed(3)}&zoom=10`, // about 100 m, as the server asks the flight services
    target: '_blank',
    rel: 'noopener',
    textContent: 'Open live map',
  });
  const airports = [...new Set(site.runways.map((r) => r.airport))];
  const near = airports.length ? `, runways at ${airports.slice(0, 4).join(', ')}${airports.length > 4 ? ' and more' : ''}` : '';
  $('site').replaceChildren(`Watching ${site.name} (${Math.round(site.elevM)} m elevation${near}). `, map);
  settings.close();
  showSetup();
  keepAwake();
}

// Keep the screen on while watching. The browser drops the lock whenever the page is hidden, so it is
// asked for again each time the page comes back.
let awake = null; // the lock, or the request for it while that is under way
async function keepAwake() {
  if (!site || awake || document.visibilityState !== 'visible') return;
  // The screen may sleep where the browser cannot keep it on (an old one, or a page not on https) or
  // the device will not let it just now (low battery mode does this). Whichever it is, the mixer's
  // part is the same, so that is all that is said. While it works there is nothing to say.
  let sleeps = !navigator.wakeLock;
  if (!sleeps) {
    try {
      awake = navigator.wakeLock.request('screen');
      // Released because the page was hidden (asked for again when it is shown), or by the device
      // itself, in which case asking again finds out whether it will still allow it.
      (await awake).addEventListener('release', () => {
        awake = null;
        keepAwake();
      });
    } catch {
      awake = null;
      sleeps = true;
    }
  }
  $('awake').textContent = sleeps ? 'Screen may sleep. Turn off auto-lock.' : '';
  $('awake').toggleAttribute('data-warn', sleeps);
}
document.addEventListener('visibilitychange', keepAwake);

async function poll() {
  if (!site || !pace.due(Date.now())) return;
  const place = site;
  try {
    const res = await fetch(`api/aircraft?lat=${site.lat}&lon=${site.lon}${shared}`, { signal: shared ? unshare.signal : undefined, headers: shareToken ? { 'x-hfs-share': shareToken } : {} });
    if (res.status === 401) return location.reload(); // the access password changed: the server now shows its login page
    const data = await feedResponse(res);
    if (site !== place) return; // a request from the previous location cannot populate the new one
    const now = Date.now();
    // The snapshot is `age` seconds old by the time it gets here (the feed's own delay, and the server
    // shares one answer for up to 4 s, 10 s in public, a minute in public while the sky is quiet), so
    // every position is that much older than it says.
    const age = data.age ?? 0;
    weather = freshWeather(data.weather, now);
    every = data.every ?? 0;
    for (const ac of data.ac) if (ac.seen_pos != null) ac.seen_pos += age;
    remember(moves, data.ac, now);
    // First poll: aircraft already on the ground may have just landed, so count them as arriving 3 min ago.
    // That holds back taxi warnings for them for a while without hiding a takeoff.
    if (!lastData) for (const ac of data.ac) if (ac.alt_baro === 'ground') arrivingAt.set(ac.hex, now - 180_000);
    const sinceArriving = (ac) => now - (arrivingAt.get(ac.hex) ?? 0);
    const opts = (ac) => ({
      loss: ENVIRONMENTS[form.env.value].loss,
      floor: +form.floor.value,
      runways: site.runways,
      landed: sinceArriving(ac) < 180_000, // still rolling out or clearing the runway, not lining up
      trim: tuned.trim,
      motion: motion(moves.get(ac.hex)),
      weather,
      weatherAt: now,
    });
    // Every aircraft's whole path and which runway it is using, and the ones that will be heard. Both
    // include aircraft the feed has lost for as long as their last prediction still matters.
    const { tracks, windows: audible } = follow(known, data.ac, now, site, opts, age);
    // Where the microphone has heard the feed run early or late, the window opens earlier or closes
    // later by as much, and a widened end stands once announced (widen.js).
    windows = widen(audible, now, timing, widened);
    for (const use of tracks) {
      // An estimate counts here too: an aircraft lost on final that turns up on the runway has landed.
      if (use.phase === 'landing on' && !use.rollout) arrivingAt.set(use.hex, now); // the approach, not the rollout after it
      if (use.runway && use.phase !== 'lined up on') {
        inUse.add(`${use.airport} ${use.runway}`);
        inUse.delete(`${use.airport} ${use.opposite}`);
      }
    }
    // Only warn about taxiing aircraft we know are heading out: not ones that landed in the last 10 min.
    taxiing = data.ac
      .filter((ac) => sinceArriving(ac) > 600_000 && !windows.some((w) => w.hex === ac.hex))
      .map((ac) => ifDeparts(ac, site, opts(ac), inUse))
      .filter(Boolean);
    lastData = now - age * 1000;
    polledAt = now;
    feedError = '';
    pace.worked();
    sendUpdate({ at: now, dataAt: lastData, staleMs: staleAfter(every), site, env: form.env.value, floor: +form.floor.value, trim: tuned.trim, learned: tuned.floor, aircraft: data.ac, tracks, windows, taxiing, weather });
    $('feed').textContent = `${data.ac.length} aircraft within 30 nm from ${data.source}, at ${clock(lastData)}`;
  } catch (e) {
    if (site !== place) return;
    if (e.name === 'AbortError') return; // sharing went off while it was asking: the next poll asks again
    clearWeather();
    pace.failed(e.retryAfter, Date.now());
    feedError = e.name === 'FeedError' ? e.message : 'Unable to reach flight data. Retrying automatically.';
    $('feed').textContent = feedError;
  }
  render();
}

// The banner: a state (hold, soon, clear, or '' for none), its word, the countdown, and two lines of
// detail. The mark beside the word blinks when the state changes, and only then. The slim bar is the
// banner's state, mark, word and countdown again, and is only ever set here, in the same breath.
let banner = '';
let told = ''; // the last hfs:status, as JSON
const bar = $('bar');
const both = [$('status'), bar];
// `bound` marks a countdown that is a limit and not a promise ("or less"): the slim bar must say so too.
function show(state, word, count, what, then, bound = false) {
  if (bar.className !== state) for (const el of both) el.className = state;
  for (const el of both) {
    el.toggleAttribute('data-stale', !state); // no state while watching means the data can't be trusted
    put(el.querySelector('.word'), word);
    put(el.querySelector('.count'), count);
  }
  put(bar.querySelector('.count'), count && bound ? `${count} or less` : count);
  put($('what'), what);
  put($('then'), then);
  document.title = count ? `${word} ${count}` : word;
  if (banner !== word && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    for (const el of both) el.querySelector('.lamp').animate({ opacity: [1, 0.15, 1] }, { duration: 500, iterations: 3 });
  }
  banner = word;
}
// The slim bar comes up when the banner's word is half off the top of the screen, and goes when it is
// back: the word hands over to the bar, so there is never a countdown on show with no word to it, and
// the bar does not arrive while the banner can still be read.
// It is worked out from where the word is, on every scroll and resize and once a second (render), and
// not from an observer: a jump from below the screen to above it crosses nothing an observer watches.
const word = document.querySelector('#status .state');
function placeBar() {
  const { top, height } = word.getBoundingClientRect();
  const hide = top + height / 2 >= 0;
  if (bar.hidden !== hide) bar.hidden = hide;
}
addEventListener('scroll', placeBar, { passive: true });
addEventListener('resize', placeBar);

// One row per aircraft. A row is kept from one second to the next and only moved or changed when it
// has to be, so the one under the pointer or holding keyboard focus doesn't jump.
function list(el, items, now) {
  const old = new Map([...el.children].map((li) => [li.dataset.hex, li]));
  items.forEach((w, i) => {
    let li = old.get(w.hex);
    old.delete(w.hex);
    if (!li) {
      li = $('row').content.firstElementChild.cloneNode(true);
      li.dataset.hex = w.hex;
    }
    const at = el.children[i] ?? null;
    // moveBefore keeps keyboard focus on a row that changes place; browsers without it drop the focus.
    if (at !== li && li.isConnected && el.moveBefore) el.moveBefore(li, at);
    else if (at !== li) el.insertBefore(li, at);
    fill(li, w, now);
  });
  for (const li of old.values()) li.remove();
}

// Marks a row as the selected aircraft, or not.
function pick(li) {
  const on = li.dataset.hex === selected;
  li.classList.toggle('selected', on);
  li.firstElementChild.setAttribute('aria-pressed', on);
}

// The feed's own row for each aircraft, for the details of an opened row. One the feed has lost is
// looked up in `known` instead, which has its last row.
let feed = new Map();
document.addEventListener('hfs:update', (e) => (feed = new Map(e.detail.aircraft.map((ac) => [ac.hex, ac]))));

// The details of an opened row, as labels and values. Kept in place while the labels stay the same,
// so only a value that changed is touched.
function facts(dl, pairs) {
  if (dl.children.length !== pairs.length || pairs.some(([k], i) => dl.children[i].firstChild.textContent !== k)) {
    dl.replaceChildren(
      ...pairs.map(([k]) => {
        const div = document.createElement('div');
        div.append(Object.assign(document.createElement('dt'), { textContent: k }), document.createElement('dd'));
        return div;
      }),
    );
  }
  pairs.forEach(([, v], i) => put(dl.children[i].lastChild, v));
}

function fill(li, w, now) {
  const set = (name, text) => put(li.querySelector(`.${name}`), text);
  pick(li);
  const ac = feed.get(w.hex) ?? known.get(w.hex)?.ac ?? {};
  const drives = engine({ t: ac.t ?? w.t, category: ac.category ?? w.category });
  const icon = li.querySelector('.engine');
  const named = ENGINE_NAME[drives] ?? 'Engine unknown';
  icon.dataset.shape = shape(drives);
  if (icon.getAttribute('aria-label') !== named) icon.setAttribute('aria-label', named); // read out as part of the row's name
  // Only the open row has its details: worked out every second for one aircraft, not for all of them.
  if (li.dataset.hex === selected) facts(li.querySelector('.facts'), details(w, ac, now));
  set('flight', w.flight || w.hex);
  set('type', w.desc || w.t || '');
  set('loud', loudness(w));
  li.querySelector('.meter').style.setProperty('--lit', Math.min(8, Math.max(1, Math.ceil(w.margin / 3))));
  const kind = CLASS_NAME[w.category];
  if (w.start == null) {
    // Taxiing: no time can be predicted until it is on a runway.
    set('when', 'Taxiing');
    set('lasts', 'no time yet');
    set('doing', [kind, `at ${w.airport}`, `likely runway ${w.runway}`].filter(Boolean).join(', '));
    set('sure', 'if it takes off');
    return;
  }
  if (w.unsure) {
    // Lost too long ago to predict from, and it had not passed: no time, no place, only that it may be there.
    set('when', 'Lost');
    set('lasts', `${mmss(now - w.seenAt)} ago`);
    set('doing', [kind, 'may still be audible'].filter(Boolean).join(', '));
    set('sure', 'no position');
    return;
  }
  const lead = w.start - now;
  const confidence = w.lost || w.rough || w.phase === 'lined up on' ? 'low' : lead < 60_000 ? 'high' : lead < 180_000 ? 'medium' : 'low';
  set('when', w.notHeard ? 'Not heard' : lead <= 0 ? 'Now' : mmss(lead));
  set('lasts', lead <= 0 ? `${mmss(w.end - now)} left` : `for ${mmss(w.end - w.start)}`);
  set('doing', [kind, w.phase && `${w.phase} runway ${w.runway}`, where(w), w.lost && `contact lost ${mmss(now - w.seenAt)} ago`].filter(Boolean).join(', '));
  set('sure', `${w.lost ? 'estimate, ' : ''}${confidence} confidence`);
}

function render() {
  if (weather && !freshWeather(weather, Date.now())) clearWeather();
  if (!site) return;
  placeBar();
  const now = Date.now();
  const audible = notHeard(windows, audibility, now);
  shown = steady(status(audible, now, lastData, staleAfter(every)), now, shown, polledAt);
  const { state, until, current, next, checking, early, unsure, notHeard: quiet } = shown;
  const said = { state, until: until ?? null, checking: !!checking, early: !!early, unsure: unsure?.hex ?? null, notHeard: quiet?.hex ?? null };
  if (JSON.stringify(said) !== told) {
    told = JSON.stringify(said);
    send('hfs:status', said);
  }
  if (!state) {
    const waiting = !lastData && !feedError;
    // The request can work while the feed itself has fallen behind: that is not this device's fault.
    const retry = pace.retryAt > now ? ` Retry in ${retryIn((pace.retryAt - now) / 1000)}.` : '';
    const why = (feedError || 'The feed is running behind.') + retry;
    if (feedError) $('feed').textContent = why;
    show(
      '',
      waiting ? 'Waiting' : 'No data',
      '',
      // What to do comes first and large, so that it is what is left where the words are cut.
      waiting ? 'for flight data' : "Don't rely on this page",
      waiting ? '' : `${lastData ? `Last data ${mmss(now - lastData)} ago. ` : ''}${why}`,
    );
    return;
  }

  const live = audible.filter((w) => w.end > now);
  const hold = state === 'hold';
  // A hold is often several aircraft run together: say how long the first lasts, then the whole of it.
  const about = (h) => {
    const others = h.end > h.first.end ? ` Others follow: ${mmss(h.end - h.start)} in all.` : '';
    return `${label(h.first)}${doing(h.first)}, ${loudness(h.first)} for about ${mmss(h.first.end - h.first.start)}.${others}`;
  };
  // A taxiing aircraft can take off before anything that has a time, so it is said in every state,
  // and said first: the sentence is cut short where the banner has no room, and this is the part that
  // changes what the countdown is worth.
  const taxi = taxiing.length ? `${taxiing.length} aircraft taxiing at ${airportsOf(taxiing)}` : '';
  // The warning's own words come before how many and where, so that they are what is left when a
  // narrow screen or large text cuts the sentence.
  const mayDepart = taxi ? `May take off sooner: ${taxi}. ` : '';
  // A takeoff here can be heard within seconds of the feed first showing it, or before, so no clear
  // spell is promised beyond the next aircraft that has a time. A taxiing aircraft already says so.
  const rolling = taxi ? [] : takeoffs();
  // The airport comes last and the time early, so that a narrow screen cuts the name, not the meaning.
  const from = [...new Set(rolling.map((r) => r.airport))].slice(0, 2); // the soonest heard
  const fast = rolling.length ? `Heard ${mmss(rolling[0].leadS * 1000)} into a takeoff. ` : '';
  // A quiet sky is asked about once a minute (cadence.js): a takeoff, or anything else new, can show
  // that much later, so a clear spell says so.
  const checked = every > 10 ? ` Checked every ${mmss(every * 1000)}.` : '';

  if (checking) {
    show('hold', 'Hold', early ? mmss(until - now) : '', 'checking it is quiet', `${mayDepart}${label(current.first)}${doing(current.first)}.`);
  } else if (hold) {
    const after = next ? `Then ${mmss(next.start - until)} of quiet.` : 'Nothing predicted after it.';
    show('hold', 'Hold', mmss(until - now), 'until it is quiet', `${mayDepart}${label(current.first)}${doing(current.first)}. ${after}`);
  } else if (unsure) {
    // The feed lost an aircraft that was still due to be heard, too long ago to predict from. That is
    // neither a hold nor clear, and there is nothing to count down to.
    const then = next ? `Next: ${about(next)}` : '';
    show('soon', 'Heads up', '', 'an aircraft may still be audible', `${mayDepart}Listen before you roll: lost contact with ${label(unsure)} ${mmss(now - unsure.seenAt)} ago. ${then}`);
  } else if (quiet) {
    show('soon', 'Heads up', '', 'not heard', label(quiet));
  } else if (state === 'soon') {
    show('soon', 'Heads up', mmss(until - now), 'until an aircraft is audible', `${mayDepart}${about(next)}`);
  } else if (next) {
    const more = taxi ? 'or less: one may take off' : fast ? `or less: takeoffs at ${from.join(' and ')}` : 'until the next aircraft';
    show('clear', 'Clear', mmss(until - now), more, `${mayDepart}${fast}Next: ${about(next)}${checked}`, !!(taxi || fast));
  } else if (taxi) {
    // No countdown: nobody can say how long it stays quiet with an aircraft about to depart.
    show('clear', 'Clear', '', 'for now: one may take off', `${taxi}.${checked}`);
  } else if (fast) {
    show('clear', 'Clear', '', `until a takeoff at ${from.join(' or ')}`, `${fast}${checked}`.trim());
  } else {
    show('clear', 'Clear', `${HORIZON_S / 60}:00+`, 'nothing predicted', checked.trim());
  }

  if (unsure && now - (warned.get(`lost ${unsure.hex}`) ?? 0) > 300_000) {
    warned.set(`lost ${unsure.hex}`, now);
    log('soon', `Contact lost with ${label(unsure)}. It may still be audible.`);
  }
  for (const w of live) {
    if (w.start > now && w.start - now < 90_000 && now - (warned.get(w.hex) ?? 0) > 300_000) {
      warned.set(w.hex, now);
      log('soon', `Heads up: ${label(w)}${doing(w)} in ${mmss(w.start - now)}, ${loudness(w)} for about ${mmss(w.end - w.start)}.`);
    }
  }
  // Several aircraft often start taxiing together: one entry for all of them keeps the log quiet.
  const leaving = taxiing.filter((w) => now - (warned.get(`taxi ${w.hex}`) ?? 0) > 600_000);
  for (const w of leaving) warned.set(`taxi ${w.hex}`, now);
  if (leaving.length) {
    const who = leaving.length > 1 ? `${leaving.map((w) => w.flight || w.hex).join(', ')} are` : `${label(leaving[0])} is`;
    log('soon', `Heads up: ${who} taxiing at ${airportsOf(leaving)} and may take off.`);
  }
  // The banner already waits before calling a hold that stopped early clear (see steady), so the log follows it.
  if (hold && !holding) {
    holding = true;
    log('hold', `Hold: ${label(current.first)}${doing(current.first)}. Clear in about ${mmss(until - now)}.`);
  } else if (!hold && holding) {
    holding = false;
    // When the hold ends in "cannot tell", the lost-contact entry above has said so: there is no clear to log.
    if (unsure) holding = false;
    else if (quiet) log('soon', `Not heard: ${label(quiet)}.`);
    else if (state === 'soon') log('soon', `Quiet for ${mmss(next.start - now)} only, then ${label(next.first)}.`);
    else log('clear', next ? `Clear. Next aircraft in ${mmss(next.start - now)}.` : 'Clear. Nothing else predicted.');
  }

  // A row that changes place or list can lose keyboard focus: put it back on the same aircraft.
  const focused = document.activeElement.closest('.traffic li')?.dataset.hex;
  listedAt = now;
  list($('upcoming'), live, now);
  list($('ground'), taxiing, now);
  if (focused && !document.activeElement.closest('.traffic li')) document.querySelector(`.traffic li[data-hex="${focused}"] button`)?.focus();
  put($('none'), fast || taxi ? 'None predicted.' : `None in the next ${HORIZON_S / 60} minutes.`);
  $('none').hidden = live.length > 0;
}

form.addEventListener('input', (e) => {
  if (['env', 'floor'].includes(e.target.name)) crewLevel = null;
  if (e.target.name === 'env') {
    untune();
    form.floor.value = ENVIRONMENTS[form.env.value].floor;
  }
  if (e.target.name === 'floor' && tuned.floor != null) {
    offset = form.floor.value - tuned.floor;
    if (tuned.early) manual = +form.floor.value;
  }
  showSetup();
});
document.addEventListener('hfs:tune', (e) => {
  if (e.detail.demo) real ??= { tuned, offset, manual, floor: form.floor.value };
  else endDemo();
  tuned = { floor: e.detail.floor ?? null, trim: e.detail.trim ?? {}, early: !!e.detail.early };
  if (tuned.floor != null) {
    if (crewLevel != null && !e.detail.demo) {
      manual = crewLevel;
      offset = crewLevel - tuned.floor;
      crewLevel = null;
    }
    manual ??= +form.floor.value;
    form.floor.value = Math.round(tuned.floor + offset); // the input clamps it to its own range
  } else {
    if (manual != null) form.floor.value = manual; // nothing learned any more: back to your own setting
    manual = null;
    offset = 0;
  }
  save();
  showSetup();
  poll();
});
// Quiet evidence applies at once; its expiry restores predictions even if audio stops arriving.
document.addEventListener('hfs:audibility', (e) => {
  audibility = e.detail;
  render();
});
// How late the feed has been running here. Taken up at the next poll, which works the windows out again.
document.addEventListener('hfs:timing', (e) => (timing = { offsets: e.detail.offsets ?? {}, lag: e.detail.lag ?? null }));
// Both lists: an aircraft that will be heard, or one that is taxiing.
document.querySelector('.traffic').addEventListener('click', (e) => {
  const hex = e.target.closest('button')?.closest('li')?.dataset.hex; // the row itself, not its details
  if (hex) send('hfs:select', { hex: hex === selected ? null : hex });
});
document.addEventListener('hfs:select', (e) => {
  selected = e.detail.hex;
  const box = document.querySelector('.traffic');
  box.querySelectorAll('li').forEach(pick);
  render(); // fills in the details of the row just opened
  // While the data is stale render() stops short of the list, so fill the row from what it last showed.
  const li = box.querySelector(`li[data-hex="${selected}"]`);
  const w = [...windows, ...taxiing].find((x) => x.hex === selected);
  if (li && w && listedAt) fill(li, w, listedAt);
  // Beside the map the list scrolls inside its own box, so bring an aircraft picked on the map into view.
  if (box.scrollHeight > box.clientHeight) box.querySelector('.selected')?.scrollIntoView({ block: 'nearest' });
});
form.addEventListener('change', () => {
  save();
  poll();
});
// Look up what is in the field and start watching it. `mine`: the field holds this device's location,
// which the server takes as typed coordinates, so there is no address to find or to misspell.
let watching = 0;
async function watch(mine, crew) {
  const ticket = ++watching;
  const query = form.q.value.trim();
  const example = [...$('examples').querySelectorAll('button')].find(button => button.dataset.q === query);
  $('site').textContent = 'Looking up…';
  try {
    const res = await fetch(`api/geocode?q=${encodeURIComponent(query)}`, { headers: shareToken ? { 'x-hfs-share': shareToken } : {} });
    if (res.status === 401) return location.reload(); // as in poll()
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    if (ticket !== watching) return; // a later choice owns the location, even if it answers first
    if (example) data.name = example.dataset.name;
    const moved = !site || data.lat !== site.lat || data.lon !== site.lon;
    if (moved) {
      weather = null;
      untune();
      lastData = polledAt = listedAt = every = 0;
      shown = null;
      holding = false;
      windows = [];
      taxiing = [];
      for (const map of [known, moves, arrivingAt, inUse, warned, widened]) map.clear();
      $('upcoming').replaceChildren();
      $('ground').replaceChildren();
      $('none').hidden = true;
    }
    site = data;
    if (crew) {
      untune();
      form.env.value = crew.env;
      form.floor.value = crew.level;
      crewLevel = +form.floor.value;
    }
    rolls = { key: '', list: [] }; // new runways or elevation: work the takeoffs out again
    save();
    showSite();
    if (moved) {
      sendUpdate({ at: Date.now(), dataAt: 0, site, env: form.env.value, floor: +form.floor.value, trim: tuned.trim, learned: tuned.floor, aircraft: [], tracks: [], windows: [], taxiing: [], weather: null });
      send('hfs:select', { hex: null });
    }
    poll();
  } catch (err) {
    if (ticket !== watching) return;
    $('site').textContent = mine
      ? `Couldn't look up your location (${err.message}). Press Watch this address to try again.`
      : `Couldn't find that address (${err.message}). Check it, or enter latitude and longitude.`;
  }
}
form.addEventListener('submit', (e) => {
  e.preventDefault();
  watch(false, applyingCrew);
  applyingCrew = null;
});

let applyingCrew = null;
$('crew').addEventListener('click', async () => {
  if (!site) return;
  const url = crewLink(location.href, site, form.env.value, form.floor.value);
  $('crew-url').hidden = true;
  if (navigator.share) {
    try { await navigator.share({ url }); return; }
    catch (err) { if (err.name === 'AbortError') return; }
  }
  try {
    await navigator.clipboard.writeText(url);
    $('crew').textContent = 'Copied';
    setTimeout(() => $('crew').textContent = 'Crew link', 2000);
  } catch {
    $('crew-url').value = url;
    $('crew-url').hidden = false;
    $('crew-url').select();
  }
});
function receiveCrew(crew) {
  form.q.value = `${crew.lat}, ${crew.lon}`;
  form.q.dispatchEvent(new Event('input', { bubbles: true }));
  applyingCrew = crew;
  form.requestSubmit();
}

$('examples').addEventListener('click', (event) => {
  const button = event.target.closest('button[data-q]');
  if (!button) return;
  form.q.value = button.dataset.q;
  form.q.dispatchEvent(new Event('input', { bubbles: true }));
  form.requestSubmit();
});

// "Use my location". The browser is asked where the device is once for each press and at no other
// time, and it does its own asking for permission. locate.js says what a reading means: the field is
// filled, so what will be used can be seen, or the place being watched is kept.
const here = $('here');
const USE = here.textContent;
const WAITING = 'Allow location if the browser asks.';
let finding = false;
let asked = 0; // counts presses, and anything that overrules one: an answer to an earlier count is dropped
// Typing in the field, or watching what is in it, is the user's own choice of set: a location answer
// still on its way must not overrule that when it arrives.
form.q.addEventListener('input', () => asked++);
form.addEventListener('submit', () => asked++);
function find(on) {
  finding = on;
  here.setAttribute('aria-disabled', on);
  here.textContent = on ? 'Finding your location…' : USE;
}
here.addEventListener('click', () => {
  if (finding) return; // one question at a time
  const no = blocked(isSecureContext, 'geolocation' in navigator);
  if (no) return void ($('site').textContent = no);
  const mine = ++asked;
  find(true);
  $('site').textContent = WAITING;
  const done = ({ q, say }) => {
    find(false);
    // Overruled while it was waiting: what the user did wins, and the answer is dropped.
    if (asked !== mine) {
      if ($('site').textContent === WAITING) $('site').textContent = '';
    } else if (q) {
      form.q.value = q;
      watch(true);
    } else $('site').textContent = say;
  };
  navigator.geolocation.getCurrentPosition(
    ({ coords }) => done(locate(coords, site)),
    (err) => done({ say: failed(err.code) }),
    { enableHighAccuracy: true, timeout: WAIT_MS, maximumAge: 0 },
  );
});

let savedLevel;
try {
  const saved = JSON.parse(localStorage.getItem('hfs'));
  if (saved) {
    savedLevel = saved.floor;
    form.q.value = saved.q;
    form.env.value = saved.env;
    // The slider starts at your own setting. If the microphone had moved it, listen.js says so again
    // after the first update, and your offset from what it learned is applied again.
    form.floor.value = saved.manual ?? saved.floor;
    offset = saved.offset ?? 0;
    site = saved.site;
  }
} catch {}
const crew = crewParse(location.hash, +form.floor.min, +form.floor.max);
const clearCrew = () => history.replaceState(history.state, '', location.pathname + location.search);
if (location.hash && !crew) clearCrew();
let useCrew = crew && (!site || crewMatches(crew, site, form.env.value, savedLevel));
if (crew && !useCrew) {
  const confirm = $('crew-confirm');
  confirm.addEventListener('close', () => {
    clearCrew();
    if (confirm.returnValue === 'use') receiveCrew(crew);
  }, { once: true });
  confirm.showModal();
}
showSetup();
if (useCrew) { clearCrew(); receiveCrew(crew); }
if (!site && !useCrew) settings.showModal();
if (!useCrew && site && !site.runways) form.requestSubmit(); // saved before runways were looked up: look the address up again
else if (!useCrew && site) {
  showSite();
  poll();
}
setInterval(poll, 5000);
setInterval(render, 1000);
