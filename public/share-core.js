// What the page shares once its user has switched sharing on, with no page in it: the session, the
// records made from the page's events, and the batches posted to the server, which keeps them
// (log.js). share.js is the page around this. It runs the same under `node --test`
// (test/share.test.js).
//
// No sound is ever in a record, and nothing from before the switch went on. What comes nearest to
// sound is the engine's own spectrogram around each aircraft, each aircraft-like noise and each mark
// (`spec`, below): how loud each of 304 pitches was, 8 times a second. That cannot be played back and
// is not an audio recording, but loud sounds near the microphone, speech among them, do show in
// it, and the page says so beside its switch. Nothing finer may be added.
//
//   const share = createShare({ post, announce, changed, clock })
//       post(text, signal)   sends one batch. A promise of the server's answer: { full: true } when
//                       its log has no more room, anything else once the batch is dealt with. It rejects
//                       when the batch did not get through, and the same batch is sent again next time.
//                       `signal` aborts when sharing is switched off: the request is to be cancelled.
//       announce(id)    the session's id while sharing, or null: app.js names it in its feed requests
//       changed()       `on` went false by itself, because the log is full
//   share.start()   share.stop()       the switch. Nothing is kept, recorded or sent before start().
//   share.update(d)  share.status(d)  share.tune(d)  share.heard(d)     the page's events, every one
//   share.mark(heard)                  the person hears an aircraft (true), or says it is quiet (false)
//   share.flush()                      send what is waiting: every 20 s, after a mark, when the page is hidden.
//                                      The spectrogram goes last, so the rest is not kept waiting behind it.
//   share.on                           whether a session is being shared now
//
// The records, one JSON object each (README.md says how to read a log):
//   site    { at, lat, lon, elevM, airports, env }    first, and again when the set or environment changes.
//           Coordinates as the page uses them. Never the address typed or the place's name.
//   poll    { at, age, n, floor, learned, trim, demo, windows, taxi }    every `hfs:update`.
//           `age` is the feed's delay in seconds and `n` how many aircraft it listed. What the banner
//           made of it is the `status` that follows. A window is { hex, flight, t, cat, phase, airport,
//           runway, start, end, peak, dist, alt, seen, lost, unsure }: `seen` is how many seconds old its position was. `demo: true` while the
//           demo sound has tuned the page.
//   status  { at, state, until, checking, early, unsure }    the banner changed, as app.js's `hfs:status`
//           says it: 'hold', 'soon', 'clear', or '' for no data, and what it counts down to. Also what it
//           was showing when the session began.
//   tune    { at, floor, trim, demo }     what the microphone (or the demo) told the page it had learned
//   listen  { at, rate }                  the microphone started, or started again, at this sample rate
//   mic     { at, ready, signal, level, background, rise, noise, expected, heard, stale, bands }    once a second.
//           The engine's status (hear.js) and coarse() of that second. `stale: true` on old flight data.
//           No `bands` for a second whose audio began before the switch went on.
//   pass    an observation as the engine filed it (hear.js), with `lost: true` if its peak was due while
//           the track was an estimate, and `stale: true` if the flight data was old: neither is learned from
//   mark    { at, heard }                 the person tapped "I hear an aircraft" (true) or "Quiet now" (false)
//   spec    { from, at, rate, cols, bins, fmin, octave, lo, step, data }    up to 10 s of the engine's
//           spectrogram, in a post of its own. `data` is base64 of `cols` columns of `bins` bytes, the
//           first column at `at` and `rate` of them a second. A byte is a level: lo + step × byte, in dB
//           below full scale. Bin b is centred on fmin × 2^(b / octave) Hz. `from` is when its stretch began:
//           chunks with one `from` follow each other without a gap. See "The spectrogram" below for when.

import { BINS, FMIN, FMAX } from './hear.js';

const PER = 8; // of the engine's bins to a band: a sixth of an octave
export const BANDS = BINS / PER; // 38, from 50 Hz to 4 kHz

// One second of the engine's spectrogram (its columns, 8 of them) as a single coarse spectrum: the
// mean power in each band over the second, in whole dB below full scale. It is kept for the whole
// session, as the cheap record of what the microphone was given.
export function coarse(columns) {
  const bands = new Array(BANDS);
  for (let band = 0; band < BANDS; band++) {
    let power = 0;
    for (const { db } of columns) for (let b = band * PER; b < (band + 1) * PER; b++) power += 10 ** (db[b] / 10);
    bands[band] = Math.round(10 * Math.log10(power / (columns.length * PER)));
  }
  return bands;
}

// The spectrogram in full, as the engine made it: a byte for each bin of each column, in half-dB
// steps from LO up to full scale. Anything quieter than LO, which is under a 16-bit microphone's own
// noise, reads as LO.
export const STEP = 0.5;
export const LO = -127.5;
const COLUMNS_S = 8; // hear.js makes a column every eighth of a second
const REACH_MS = 125; // and its `at` is the middle of the quarter second of audio it describes
const OCTAVE = Math.round(BINS / Math.log2(FMAX / FMIN)); // 48 bins to the octave
export const BEFORE_MS = 30_000; // kept from before something was first expected, heard or marked
export const AFTER_MS = 30_000; // and after the last of it
export const AFTER_MARK_MS = 60_000; // longer after a mark: that is when the page and the ears disagreed
const RING = (BEFORE_MS / 1000) * COLUMNS_S; // columns remembered, in case they turn out to be wanted
const CHUNK = 10 * COLUMNS_S; // columns to a `spec` record: 24 KB, 32 KB as base64
const GAP_MS = 1500 / COLUMNS_S; // a column later than this after the one before it does not follow it

function base64(bytes) {
  let text = '';
  for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
  return btoa(text);
}

const whole = (v) => (Number.isFinite(v) ? Math.round(v) : null);
const tenth = (v) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : null);
const some = (list) => (list?.length ? list : undefined); // an empty list is left out of a record
const who = (w) => ({ hex: w.hex, flight: w.flight, t: w.t, cat: w.category, phase: w.phase, airport: w.airport, runway: w.runway });

const site = ({ at, site: { lat, lon, elevM, runways = [] }, env }) => ({ k: 'site', at, lat, lon, elevM, airports: [...new Set(runways.map((r) => r.airport))], env });

function poll(d, demo) {
  return {
    k: 'poll',
    at: d.at,
    age: d.dataAt === 0 ? null : tenth((d.at - (d.dataAt ?? d.at)) / 1000),
    n: d.aircraft.length,
    floor: d.floor,
    learned: d.learned ?? null,
    trim: Object.keys(d.trim ?? {}).length ? d.trim : undefined,
    demo: demo || undefined,
    windows: d.windows.map((w) => ({ ...who(w), start: whole(w.start), end: whole(w.end), peak: tenth(w.peakDb), dist: whole(w.peakDistM), alt: whole(w.peakAltFt), seen: tenth((d.at - w.seenAt) / 1000), lost: w.lost, unsure: w.unsure })),
    taxi: some(d.taxiing.map((w) => ({ ...who(w), peak: tenth(w.peakDb), secs: whole(w.endS - w.startS) }))),
  };
}

const LEVEL_MS = 6000; // how far back the engine's level reaches (SMOOTH in hear.js)
const status = (at, d) => ({ k: 'status', at, state: d.state, until: whole(d.until), checking: d.checking || undefined, early: d.early || undefined, unsure: d.unsure ?? undefined });

const mic = ({ status: s, columns, stale }) => ({
  k: 'mic',
  at: Math.round(s.at),
  ready: s.ready,
  signal: s.signal,
  level: s.level,
  background: s.background,
  rise: s.rise,
  noise: s.noise,
  expected: some(s.expected),
  heard: some(s.heard.map((h) => ({ hex: h.hex, how: h.how, confidence: h.confidence, candidates: some(h.candidates), tones: some(h.tones), fundamental: h.fundamental ?? undefined }))),
  stale: stale || undefined,
  bands: columns.length ? coarse(columns) : undefined,
});

function spec(from, columns) {
  const bytes = new Uint8Array(columns.length * BINS);
  columns.forEach((col, i) => bytes.set(col.bytes, i * BINS));
  return { k: 'spec', from, at: columns[0].at, rate: COLUMNS_S, cols: columns.length, bins: BINS, fmin: FMIN, octave: OCTAVE, lo: LO, step: STEP, data: base64(bytes) };
}

const newId = () => [...crypto.getRandomValues(new Uint8Array(8))].map((byte) => byte.toString(16).padStart(2, '0')).join('');

// `room` is the most characters in one batch and `max` the most kept waiting while the network is
// down: at a busy airport about 20 minutes of them, 4 MB.
export function createShare({ post, announce = () => {}, changed = () => {}, clock = Date.now, id = newId, room = 30_000, max = 4_000_000 }) {
  let session = null; // while sharing: { id, since, n, pending, sending, off }: `since` when it began, `pending` and
  // `sending` a batch not yet through and the sending of it, `off` what cancels that
  let queue = []; // records waiting to be sent, as { text, keep }
  let bulk = []; // and the chunks of spectrogram, as text: each is a post of its own, after the rest
  let waiting = 0; // characters in both
  let feed = null; // the last `hfs:update`
  let banner = null; // the last `hfs:status`
  let key = ''; // the set and environment the last `site` record was for
  let demo = false; // the demo sound has tuned the page
  let micAt = 0; // `at` of the last second of microphone recorded

  // When the network has been down too long the oldest go: of the spectrogram first, which is nearly
  // all of the bulk, then of the rest. `keep` marks what cannot be made again from anything else:
  // the set, the marks and the passes go last of all.
  function add(record, keep = false) {
    const text = JSON.stringify(record);
    if (record.k === 'spec') bulk.push(text);
    else queue.push({ text, keep });
    waiting += text.length;
    while (waiting > max && bulk.length + queue.length > 1) {
      waiting -= (bulk.length ? bulk.shift() : queue.splice(Math.max(0, queue.findIndex((r) => !r.keep)), 1)[0].text).length;
    }
  }

  // ---- The spectrogram around each aircraft and each mark ----
  // The last 30 s of columns are remembered, as bytes of this module's own: the engine goes on using
  // its arrays. A stretch is wanted from 30 s before the page or the engine expects or hears anything
  // until 30 s after the last of it, and from 30 s before a mark until a minute after. Wanted columns
  // are sent 10 s at a time. Stretches that touch or overlap are one: a column is never sent twice,
  // and one that follows the last column sent carries on that column's stretch.
  let ring = []; // { at, bytes }, the newest last
  let until = 0; // columns up to this moment are wanted
  let sentTo = 0; // `at` of the last column put in a record
  let stretch = 0; // when the stretch it belongs to began
  let chunk = []; // the columns of the record being filled

  function cut() {
    if (chunk.length) add(spec(stretch, chunk));
    chunk = [];
  }
  function take(col) {
    if (col.at - sentTo > GAP_MS) {
      cut();
      stretch = col.at;
    }
    chunk.push(col);
    sentTo = col.at;
    if (chunk.length === CHUNK) cut();
  }
  function want(from, to) {
    until = Math.max(until, to);
    for (const col of ring) if (col.at >= from && col.at > sentTo) take(col);
  }
  function column({ at, db }) {
    const col = { at: Math.round(at), bytes: Uint8ClampedArray.from(db, (v) => (v - LO) / STEP) }; // rounded, and held to 0 to 255
    ring.push(col);
    if (ring.length > RING) ring.shift();
    if (col.at <= until) take(col);
    else cut();
  }

  function place() {
    key = `${feed.site.lat},${feed.site.lon} ${feed.env}`;
    add(site(feed), true);
  }

  function end(full) {
    session.off.abort();
    session = null;
    [queue, bulk, waiting, ring, chunk, until, sentTo] = [[], [], 0, [], [], 0, 0];
    announce(null);
    if (full) changed();
  }

  // The next batch: records from the front of the line, as many as there is room for (always one).
  // With none of those left, one chunk of spectrogram.
  function pack(s) {
    const batch = queue.length ? [] : [bulk.shift()];
    for (let size = 0; queue.length && (!batch.length || size + queue[0].text.length <= room); size += batch.at(-1).length) batch.push(queue.shift().text);
    waiting -= batch.reduce((sum, text) => sum + text.length, 0);
    return `{"id":"${s.id}","n":${s.n++},"sent":${clock()},"events":[${batch.join(',')}]}`;
  }

  async function send(s) {
    try {
      while (session === s && (s.pending ??= queue.length || bulk.length ? pack(s) : null)) {
        const answer = await post(s.pending, s.off.signal);
        if (session !== s) return; // switched off while it was on its way
        if (answer?.full) return end(true);
        s.pending = null;
      }
    } catch {
      // Not through: said nowhere, and tried again at the next flush.
    }
  }

  return {
    get on() { return !!session; },

    start() {
      if (session) end();
      session = { id: id(), since: clock(), n: 0, pending: null, sending: null, off: new AbortController() };
      [key, micAt] = ['', 0];
      if (feed) place();
      if (banner) add(status(clock(), banner));
      announce(session.id);
      this.flush(); // the server learns of the session now, so that it keeps the feed from the next poll on
    },

    // Off: nothing more is kept or recorded, what was waiting is not sent, and a batch on its way is cancelled.
    stop() {
      if (session) end();
    },

    update(d) {
      feed = d;
      if (!session) return;
      const moved = key !== `${d.site.lat},${d.site.lon} ${d.env}`;
      if (moved) place();
      add(poll(d, demo));
      if (moved) this.flush(); // a session that began before the first update is made known to the server here
    },

    status(d) {
      banner = d;
      if (session) add(status(clock(), d));
    },

    tune(d) {
      demo = !!d.demo;
      if (session) add({ k: 'tune', at: clock(), floor: d.floor ?? null, trim: d.trim ?? {}, demo: demo || undefined });
    },

    // A second of listening (listen-core.js). Nothing the demo sound produced is recorded, or remembered,
    // and no column whose audio began before the switch went on.
    heard(d) {
      const { at, expected, heard, noise } = d.status;
      if (!session || d.demo || at == null) return;
      if (at - micAt > 5000) add({ k: 'listen', at: Math.round(at), rate: d.rate });
      micAt = at;
      const columns = d.columns.filter((col) => col.at - REACH_MS >= session.since);
      // The engine's level is smoothed over the 6 s before, so the first seconds after the switch went
      // on still carry sound from before it: their levels are not sent either.
      // shortcut: the background is a long-run quiet level and still rests partly on earlier minutes.
      const record = mic({ ...d, columns: columns.length === d.columns.length ? columns : [] });
      if (at - LEVEL_MS < session.since) Object.assign(record, { level: null, rise: null });
      add(record);
      for (const o of d.observations) add({ k: 'pass', ...o, stale: d.stale || undefined }, true);
      // The page predicts an aircraft audible now (an estimate and a "cannot tell" count), or the
      // engine expects one, has named one, or hears noise it takes for one.
      if (expected.length || heard.length || noise || feed?.windows.some((w) => w.start <= at && w.end >= at)) want(at - BEFORE_MS, at + AFTER_MS);
      for (const col of columns) column(col);
    },

    mark(heard) {
      if (!session) return;
      const at = clock();
      add({ k: 'mark', at, heard }, true);
      want(at - BEFORE_MS, at + AFTER_MARK_MS);
    },

    // One batch at a time, each until the server has answered for it. A batch that did not get
    // through is kept as it is and sent again, so the server can tell a repeat by its number. Asked
    // again while it is sending, it gives the same promise: there is never a second line to the server.
    // shortcut: when the page is closed only the batch it sends at that moment arrives: everything
    // waiting but the spectrogram (its last 20 s at most are lost). If a batch was already on its way
    // just then, what was recorded since it was made is lost too. Send those with requests of their
    // own if that ever matters.
    // shortcut: the spectrogram goes as base64 in JSON like everything else, a third more to upload
    // than its bytes (12 MB an hour at most, not 9). Post the bytes themselves if mobile data matters.
    flush() {
      const s = session;
      if (!s) return Promise.resolve();
      cut(); // what there is of the spectrogram goes now, not when its 10 s are full
      if (!s.sending && (s.pending || queue.length || bulk.length)) s.sending = send(s).finally(() => (s.sending = null));
      return s.sending ?? Promise.resolve();
    },
  };
}
