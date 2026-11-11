// The opt-in session log. A page whose user has switched sharing on (public/share.js) posts what it
// predicted, what the microphone measured and what the person marked, and this keeps it, with the
// flight feed that page was served, so a developer can replay the session later. It is on only when
// LOG_DIR is set. No sound is ever sent, and no visitor's address is kept.
//
// Each session has up to three files in LOG_DIR, named from the day it began (UTC) and its id:
//   <day>-<id>.log.jsonl.gz    one JSON object a line: a `session` line from this server, then the
//                              page's records in the order it made them, with a `post` line from this
//                              server before each batch (public/share-core.js lists the records)
//   <day>-<id>.feed.jsonl.gz   the feed as that page was served it, one { at, ac } a line: what REPLAY reads
//   <day>-<id>.spec.bin.gz     the listening engine's spectrogram around each aircraft, long noise and mark.
//                              Chunk after chunk, each a line of JSON (the `spec` record without its
//                              `data`: it says how to read the bytes) and then cols × bins bytes, one
//                              column after another. spectrogram() below reads it back into dB.
// Every append is a gzip stream of its own, and streams one after another are one valid gzip file, so
// nothing is held open and nothing is lost when the server stops. Beside LAX a session is at most
// 8.5 MB an hour this way: 6 of spectrogram if aircraft are never out of earshot, 1.8 of feed (7 as
// text), and the rest the page's records.
//
//   node log.js <LOG_DIR or files>     prints a line about each session: when, where, how long, how much
//
// A public link may be in front of this. A name is built only from the day and an id that fits ID, a
// post is MAX_POST at most, and a session and the directory each have a size they stop at
// (SESSION_MAX, 30 hours of the above, and DIR_MAX, and 2000 sessions). At either, the page is told
// `full` and stops sending. A batch is stored whole or not at all. The spectrogram stops sooner, an
// eighth of the session short of its size (4 MB of the public 32): a post holding any is then answered
// `spec: false` and only the rest of it is kept, so the page's cheaper records, about 0.3 MB an hour,
// go on to the end. From then on every answer for that session, repeats and after a restart included,
// says `spec: false`.
//
// A session's files are deleted once the day it began is KEEP_DAYS old: when the log is created, and
// every day after.
// shortcut: files are written with the synchronous calls, a few KB at a time, so the order on disk is
// the order they came in. Give each session a queue if the disk is ever slow enough to notice.
import { appendFileSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { gunzipSync, gzipSync, constants } from 'node:zlib';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ID = /^[0-9a-f]{16}$/; // a session id: 64 random bits, made by the page
const FILES = { log: 'log.jsonl.gz', feed: 'feed.jsonl.gz', spec: 'spec.bin.gz' };
const NAME = /^(\d{4}-\d{2}-\d{2})-([0-9a-f]{16})\.(log\.jsonl|feed\.jsonl|spec\.bin)\.gz$/;
export const MAX_POST = 64 * 1024; // bytes: 10 s of spectrogram is 33 KB, and the page's other records 15 KB every 20 s
const MB = 1024 * 1024;
export const SESSION_MAX = 256 * MB;
export const DIR_MAX = 2048 * MB;
export const KEEP_DAYS = 90;
const DAY = 24 * 3600_000;
// What the page reads of a feed row (predict.js, map.js). A live row has some forty fields.
const FIELDS = ['hex', 'flight', 't', 'desc', 'category', 'alt_baro', 'alt_geom', 'gs', 'track', 'true_heading', 'baro_rate', 'geom_rate', 'nav_altitude_mcp', 'seen_pos', 'lat', 'lon'];
const thin = (ac) => Object.fromEntries(FIELDS.filter((field) => ac[field] != null).map((field) => [field, ac[field]]));

// A log or feed file as its objects, gzipped or not (the recording in test/fixtures is not). This is
// also how REPLAY loads its file. A last line cut short, by a server stopped in the middle of an
// append, is left out.
export function read(file) {
  let data = readFileSync(file);
  if (data[0] === 0x1f && data[1] === 0x8b) data = gunzipSync(data, { finishFlush: constants.Z_SYNC_FLUSH });
  return data
    .toString()
    .split('\n')
    .flatMap((line, i, all) => {
      try {
        return line ? [JSON.parse(line)] : [];
      } catch (e) {
        if (i === all.length - 1) return [];
        throw e;
      }
    });
}

// The spectrogram a session kept (its .spec.bin.gz), as stretches of unbroken time, oldest first:
//   { from, rate, freqs, at, db }    `freqs[b]` is the centre of bin b in Hz, `at[i]` the epoch ms of
//                                    column i, and `db[i][b]` its level in dB below full scale
// A level is right to half the step it was stored in (0.25 dB), and nothing reads lower than the
// chunk's `lo`. Chunks are joined into one stretch when they say they belong to one (`from`).
export function spectrogram(file) {
  const data = gunzipSync(readFileSync(file), { finishFlush: constants.Z_SYNC_FLUSH });
  const stretches = [];
  for (let pos = 0; pos < data.length; ) {
    const end = data.indexOf(10, pos);
    if (end < 0) break;
    const head = JSON.parse(data.subarray(pos, end));
    pos = end + 1 + head.cols * head.bins;
    if (pos > data.length) break; // cut short by a server that stopped mid-write
    let s = stretches.at(-1);
    if (s?.from !== head.from) stretches.push((s = { from: head.from, rate: head.rate, freqs: Float64Array.from({ length: head.bins }, (_, b) => head.fmin * 2 ** (b / head.octave)), at: [], db: [] }));
    for (let i = 0; i < head.cols; i++) {
      const bytes = data.subarray(end + 1 + i * head.bins, end + 1 + (i + 1) * head.bins);
      s.at.push(head.at + (i * 1000) / head.rate);
      s.db.push(Float32Array.from(bytes, (byte) => head.lo + head.step * byte));
    }
  }
  return stretches;
}

// A request's body as text, or null when it is longer than `max` bytes: it stops listening there, and
// the caller answers and closes the connection.
export function body(req, max = MAX_POST) {
  return new Promise((done, fail) => {
    if (req.headers['content-length'] > max) return done(null);
    const parts = [];
    let size = 0;
    req.on('data', function take(chunk) {
      if ((size += chunk.length) <= max) return parts.push(chunk);
      req.off('data', take);
      done(null);
    });
    req.on('end', () => done(Buffer.concat(parts).toString()));
    req.on('error', fail);
  });
}

// createLog(dir) gives the log kept in `dir`, or one that keeps nothing when `dir` is not set:
//   log.on                       whether there is a log at all
//   log.request(method, text)    answers /api/log: GET says whether sharing is offered, POST stores a
//                                batch, { id, n, sent, events }. `text` is the body, null when it was too
//                                long. Returns { status, ...what to send as JSON }.
//   log.frame(id, at, ac)        the feed just served to the page with this session id: `at` is when
//                                the feed took the snapshot, epoch ms. Kept if the session is known.
// A session begins with its first post, never with a feed request.
export function createLog(dir, { sessionMax = SESSION_MAX, specMax = sessionMax - sessionMax / 8, dirMax = DIR_MAX, maxSessions = 2000, keepDays = KEEP_DAYS, clock = Date.now } = {}) {
  if (!dir) {
    return {
      on: false,
      request: (method) => (method === 'GET' ? { status: 200, on: false } : { status: 404, error: 'This server keeps no session log.' }),
      frame() {},
    };
  }
  mkdirSync(dir, { recursive: true });
  let sessions = new Map(); // id -> { name, bytes, n, lastAt, full }
  let total = 0; // bytes in all of them
  let scanned = 0; // when the directory was last read
  let dead = false; // a write failed: nothing more is written, so a torn file is not added to

  // What is on disk. Read at the start, and again (a minute apart at most) when the log looks full,
  // so that deleting old sessions makes room without a restart.
  function scan() {
    const found = new Map();
    total = 0;
    for (const file of readdirSync(dir)) {
      const [, day, id] = NAME.exec(file) ?? [];
      if (!id) continue;
      // A session already known stays the same object: a write may be holding it. Of one found on disk
      // the last batch stored is not known until it posts again (stored(), below).
      const s = found.get(id) ?? Object.assign(sessions.get(id) ?? { n: null, lastAt: 0 }, { name: `${day}-${id}`, bytes: 0 });
      const { size } = statSync(join(dir, file));
      s.bytes += size;
      total += size;
      found.set(id, s);
    }
    sessions = found;
    scanned = clock();
  }
  // Sessions that began keepDays ago or more are deleted, then what is left is read again.
  function expire() {
    for (const file of readdirSync(dir)) {
      const [, day] = NAME.exec(file) ?? [];
      if (day && Date.parse(day) + keepDays * DAY <= clock()) {
        try { unlinkSync(join(dir, file)); } catch (e) { console.log(`A session file could not be deleted: ${e.code ?? e.message}`); }
      }
    }
    scan();
  }
  expire();
  setInterval(expire, DAY).unref();
  const again = () => !dead && clock() - scanned > 60_000 && scan();

  // Whether a new session can begin: not when the directory has no room left for one more post, so
  // sharing is never offered to a page whose first batch would be turned away.
  function room() {
    const fits = () => !dead && total + MAX_POST <= dirMax && sessions.size < maxSessions;
    if (!fits()) again();
    return fits();
  }

  // Whether `size` more bytes fit the session and the directory. Past the session's size it is full
  // for good.
  function fits(s, size) {
    if (dead || s.full) return false;
    if (s.bytes + size > sessionMax) return !(s.full = true);
    if (total + size > dirMax) again();
    return total + size <= dirMax;
  }
  // Gzipped `data` added to one of the session's files: false if it could not be.
  function write(s, kind, data) {
    try {
      appendFileSync(join(dir, `${s.name}.${FILES[kind]}`), data);
    } catch (e) {
      dead = true;
      console.log(`The session log has stopped: ${e.code ?? e.message}`);
      return false;
    }
    s.bytes += data.length;
    total += data.length;
    return true;
  }

  // From its log, the last batch a session stored, so that after a restart a batch sent again is still
  // known, and whether its spectrogram has stopped (`spec: false` on a `post` line).
  function stored(s) {
    try {
      const posts = read(join(dir, `${s.name}.${FILES.log}`)).filter((line) => line.k === 'post');
      return { n: posts.at(-1)?.n ?? -1, nospec: posts.some((line) => line.spec === false) };
    } catch {
      return { n: -1, nospec: false }; // no log, or one that cannot be read: it is carried on from here
    }
  }

  function store(text) {
    if (text == null) return { status: 413, error: `A post is ${MAX_POST} bytes at most.` };
    let post;
    try {
      post = JSON.parse(text);
    } catch {
      return { status: 400, error: 'Not JSON.' };
    }
    const { id, n, sent, events } = post ?? {};
    const record = (e) => e && typeof e === 'object' && !Array.isArray(e);
    if (typeof id !== 'string' || !ID.test(id) || !Number.isInteger(n) || !Array.isArray(events) || !events.length || !events.every(record)) {
      return { status: 400, error: 'A post is { id, n, sent, events }.' };
    }
    // A chunk of spectrogram is kept as bytes in a file of its own: that is a fifth smaller than the
    // same as text, and leaves the log something a person can read. Its line in the log, without the
    // bytes, says it was there.
    let chunks = [];
    const posted = { k: 'post', n, at: clock(), sent: Number.isFinite(sent) ? sent : null };
    let lines = [posted];
    for (const event of events) {
      const { data, ...head } = event;
      lines.push(event.k === 'spec' ? head : event);
      if (event.k !== 'spec') continue;
      const bytes = Buffer.from(typeof data === 'string' ? data : '', 'base64');
      const count = (v) => Number.isInteger(v) && v > 0;
      if (!count(head.cols) || !count(head.bins) || bytes.length !== head.cols * head.bins) return { status: 400, error: 'A spectrogram is cols × bins bytes.' };
      chunks.push(gzipSync(Buffer.concat([Buffer.from(`${JSON.stringify(head)}\n`), bytes])));
    }
    let s = sessions.get(id);
    if (!s) {
      if (!room()) return { status: 200, full: true };
      s = { name: `${new Date(clock()).toISOString().slice(0, 10)}-${id}`, bytes: 0, n: -1, nospec: false, lastAt: 0 };
      lines.unshift({ k: 'session', v: 1, id, at: clock() });
    }
    // A batch sent again, because its answer was lost on the way back, is not stored twice, and is
    // answered as it was the first time.
    if (s.n == null) Object.assign(s, stored(s));
    const ok = () => (s.nospec ? { status: 200, ok: true, spec: false } : { status: 200, ok: true });
    if (n <= s.n) return ok();
    // No room left for spectrogram: the rest of the post is kept without it, and the page is told. Once
    // stopped, a session's spectrogram stays stopped, and its log says so for after a restart.
    const jsonl = (all) => `${all.map((line) => JSON.stringify(line)).join('\n')}\n`;
    const spec = !chunks.length || (!s.nospec && s.bytes + gzipSync(jsonl(lines)).length + chunks.reduce((sum, c) => sum + c.length, 0) <= specMax);
    if (!spec) {
      [lines, chunks] = [lines.filter((line) => line.k !== 'spec'), []];
      posted.spec = false;
    }
    // All of the batch is written, or none of it: it is acknowledged only once it is all there.
    const log = gzipSync(jsonl(lines));
    if (!fits(s, log.length + chunks.reduce((sum, c) => sum + c.length, 0))) return { status: 200, full: true };
    if (!write(s, 'log', log)) return { status: 200, full: true };
    sessions.set(id, s);
    if (!chunks.every((chunk) => write(s, 'spec', chunk))) return { status: 200, full: true };
    s.n = n;
    s.nospec ||= !spec;
    return ok();
  }

  return {
    on: true,
    request(method, text) {
      if (method === 'GET') return { status: 200, on: room() };
      if (method !== 'POST') return { status: 405, error: 'GET or POST.' };
      return store(text);
    },
    frame(id, at, ac) {
      const s = sessions.get(id); // only ids that were posted are in there: nothing is named after this one
      at = Math.round(at ?? clock());
      try {
        // The same snapshot is served to every poll within a few seconds: once is enough.
        if (!s || at <= s.lastAt) return;
        const data = gzipSync(`${JSON.stringify({ at, ac: ac.map(thin) })}\n`);
        if (fits(s, data.length) && write(s, 'feed', data)) s.lastAt = at;
      } catch {
        // A feed this cannot make sense of is the page's to deal with: keeping it must never cost the page its answer.
      }
    },
  };
}

// What a session's log holds, to pick the sessions worth replaying. `events` is read() of its log file.
// Times are this server's, from the lines it wrote itself. `clockS` is how far the device's clock was
// behind (+) or ahead (-) of the server's, from the post that was quickest to arrive: the page's
// records carry the device's time and the feed file the feed's.
export function summary(events) {
  const of = (k) => events.filter((e) => e.k === k);
  const posts = of('post');
  const from = of('session')[0]?.at ?? posts[0]?.at;
  const site = of('site')[0];
  const marks = of('mark');
  const spec = of('spec');
  const skew = posts.filter((p) => p.sent != null).map((p) => p.at - p.sent);
  return {
    at: from,
    minutes: Math.round(((posts.at(-1)?.at ?? from) - from) / 60_000),
    // What a page posted is not to be trusted, even to print: numbers and one plain word only.
    where: site ? `${(+site.lat).toFixed(3)}, ${(+site.lon).toFixed(3)} ${/^\w+$/.test(site.env) ? site.env : '?'}` : 'no set',
    polls: of('poll').length,
    micS: of('mic').length,
    passes: of('pass').length,
    heard: marks.filter((m) => m.heard).length,
    quiet: marks.filter((m) => !m.heard).length,
    stretches: new Set(spec.map((c) => +c.from)).size,
    specMin: Math.round(spec.reduce((sum, c) => sum + (c.cols / c.rate || 0), 0) / 6) / 10,
    clockS: skew.length ? Math.round(Math.min(...skew) / 100) / 10 : null,
  };
}

// node log.js <LOG_DIR or log files>
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const files = process.argv.slice(2).flatMap((path) => (statSync(path).isDirectory() ? readdirSync(path).sort().map((file) => join(path, file)) : [path]));
  for (const file of files.filter((file) => file.endsWith('.log.jsonl.gz'))) {
    const feed = file.replace('.log.', '.feed.');
    try {
      const s = summary(read(file));
      const size = [file, feed, file.replace('.log.jsonl.', '.spec.bin.')].reduce((sum, f) => sum + (statSync(f, { throwIfNoEntry: false })?.size ?? 0), 0);
      const clock = Math.abs(s.clockS) >= 1 ? [`device clock ${Math.abs(s.clockS)} s ${s.clockS > 0 ? 'behind' : 'ahead'}`] : [];
      const marks = `${s.heard + s.quiet} marks (${s.heard} aircraft, ${s.quiet} quiet)`;
      const when = `${new Date(s.at).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
      const spec = `${s.stretches} stretches of spectrogram (${s.specMin} min)`;
      console.log([feed, when, `${s.minutes} min`, s.where, `${s.polls} polls`, `${s.micS} s of microphone`, spec, `${s.passes} passes`, marks, `${(size / MB).toFixed(1)} MB`, ...clock].join('  '));
    } catch (e) {
      console.log(`${file}  cannot be read: ${e.message}`);
    }
  }
}
