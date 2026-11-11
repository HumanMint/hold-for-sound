// The microphone, spectrogram and timeline. Draws inside <section id="listen">; see the events described in app.js.
//
// One timeline, with time running left to right past a "now" line. Right of it is the forecast: each
// aircraft's predicted loudness against the warning level. Left of it is what the microphone heard: a
// spectrogram, and the loudness it measured on the forecast's own scale. The forecast slides left and
// becomes the recording. hear.js decides which aircraft a sound belongs to. listen-core.js holds what
// the panel knows and decides: the set it is at, the engine, what was learned and what the page is
// told with `hfs:tune`. This file is the page around that: it captures the audio and draws. The
// helpers that need neither a page nor any state are in listen-view.js.
//
// The engine runs here on the main thread, not in a Worker. Measured in Chrome on a desktop, with a
// 48 kHz microphone, it takes about 3 ms of each second, and 17 ms with the processor slowed six times
// to stand in for a phone. That is too little to be worth copying every poll's tracks to a Worker and
// waiting on it for the curves as they are drawn.
// shortcut: two tabs listening at one set each keep their own list and the last to save wins.

import { BINS } from './hear.js';
import { createCore } from './listen-core.js';
import { easeOut, morph } from './map-geo.js';
import { layout, LOW, heardOver, levelY, pitchY, shade, rowBins, ticks, levelAt, runs, held, series, place, untrimmed, createClock, say, PROBLEMS, explain, recap } from './listen-view.js';

const box = document.getElementById('listen');
const put = (el, text) => {
  if (el.textContent !== text) el.textContent = text;
};

// Said by the button that asks for the microphone, for as long as it is offering to.
const CONSENT = 'Audio is not recorded or sent.';

// What the panel knows and decides is in listen-core.js: the set it is at, the engine, what was
// heard and learned, and what the page is told. This file is the page around it.
const send = (name, detail) => document.dispatchEvent(new CustomEvent(name, { detail }));
// When the banner said Hold: [from, to] in ms, the last one open (to: null) while it still does.
const banner = [];
const core = createCore({
  load() {
    try {
      return localStorage.getItem('hfs:listen');
    } catch {
      return null;
    }
  },
  save(text) {
    try {
      localStorage.setItem('hfs:listen', text);
    } catch {}
  },
  send,
  changed: () => show(),
  report: (detail) => send('hfs:heard', detail),
});

let selected = null;
let problem = ''; // why the microphone is not running: a key of PROBLEMS
let run = 0; // goes up whenever listening starts or stops, so a slow start can tell it was overtaken
let stream = null; // the microphone
let audio = null; // and its AudioContext
let timer; // the demo's
const clock = createClock();

const name = (hex) => core.forecast.planes.get(hex)?.name ?? hex;

// ---- Listening ----

const COLS = 1600; // 200 s of spectrogram columns: a little more than the timeline ever shows
const cols = { at: new Float64Array(COLS), shade: new Uint8Array(COLS * BINS), n: 0 };
let behind = false; // columns arrived while the page was hidden, and are not on the tape yet

// A stretch of audio from either source, with the wall-clock time of its last sample.
function hear(pcm, end) {
  for (const col of core.hear(pcm, end)) {
    const i = cols.n++ % COLS;
    cols.at[i] = col.at;
    const q = cols.shade.subarray(i * BINS, (i + 1) * BINS);
    for (let b = 0; b < BINS; b++) q[b] = 255 * shade(col.above[b]);
    if (showing()) view.tape?.add(col.at, q);
    else behind = true;
  }
}

// The timeline as it is for what is being listened to now, with nothing on it from before.
function clear() {
  cols.n = 0;
  if (!ui) return;
  fit(true);
  show();
}

function begin(kind, sampleRate) {
  problem = '';
  core.begin(kind, sampleRate);
  clock.reset();
  clear();
}

function stop() {
  run++;
  clearInterval(timer);
  stream?.getTracks().forEach((track) => track.stop());
  audio?.close();
  stream = audio = null;
  problem = '';
  core.stop();
  clear();
}

function fail(kind) {
  stop();
  problem = kind;
  show();
}

async function listen(device) {
  stop();
  const mine = run;
  if (!isSecureContext) return fail('insecure');
  if (!navigator.mediaDevices?.getUserMedia || !window.AudioWorkletNode) return fail('unsupported');
  let mic;
  try {
    // The browser's own clean-up would wreck the level tracking, so all of it is off.
    mic = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: device ? { exact: device } : undefined, channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
  } catch (e) {
    if (mine !== run) return;
    const gone = e.name === 'NotFoundError' || e.name === 'OverconstrainedError';
    if (device && gone) return listen(''); // the input chosen last time is not there: use whatever is
    return fail(e.name === 'NotAllowedError' || e.name === 'SecurityError' ? 'denied' : gone ? 'none' : 'busy');
  }
  if (mine !== run) return mic.getTracks().forEach((track) => track.stop());
  try {
    stream = mic;
    const context = (audio = new AudioContext({ latencyHint: 'playback' }));
    await context.audioWorklet.addModule(new URL('listen-worklet.js', import.meta.url));
    if (mine !== run) return;
    const every = Math.ceil(context.sampleRate / 48000);
    begin('mic', context.sampleRate / every);
    // One channel in whatever the input has, and no output: nothing reaches the speakers.
    const tap = new AudioWorkletNode(context, 'hfs-tap', { numberOfOutputs: 0, channelCount: 1, channelCountMode: 'explicit', processorOptions: { every } });
    tap.port.onmessage = ({ data }) => mine === run && hear(data.pcm, clock.stamp((data.frame / context.sampleRate) * 1000, Date.now()));
    context.createMediaStreamSource(mic).connect(tap);
    const [track] = mic.getAudioTracks();
    track.onended = () => mine === run && fail('unplugged');
    // Muted by the system or a switch on the device: the engine is told, so that it learns nothing from the silence.
    track.onmute = track.onunmute = () => mine === run && core.mute(track.muted);
    core.mute(track.muted);
    context.onstatechange = () => {
      if (mine !== run) return;
      if (context.state === 'running') clock.reset();
      problem = context.state === 'running' ? '' : 'suspended';
      show();
    };
    // A page that was reloaded has not been touched yet, and some browsers hold the audio until it is.
    context.resume().catch(() => {});
    setTimeout(() => context.state !== 'running' && context.onstatechange(), 1000);
    core.saved.device = device;
    core.keep();
    inputs();
  } catch {
    // shortcut: anything else (a device at a rate the engine cannot take, a browser quirk) gets the
    // same words as a microphone that is in use; give each its own once they have been seen on a set.
    if (mine === run) fail('busy');
  }
}

// The choice of input, shown when there is more than one real device. A mixer may feed a line from the cart.
async function inputs() {
  const all = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput' && d.deviceId);
  const using = stream?.getAudioTracks()[0].getSettings().deviceId;
  ui.select.replaceChildren(...all.map((d, i) => new Option(d.label || `Input ${i + 1}`, d.deviceId, false, d.deviceId === using)));
  ui.input.hidden = all.filter((d) => d.deviceId !== 'default' && d.deviceId !== 'communications').length < 2;
}

// The demo: synth.js makes the sound a microphone would pick up from the aircraft now predicted, and
// the engine hears that instead. Its world is 4 dB noisier than the page assumes, so there is
// something for the tuning to find.
async function demo() {
  stop();
  const mine = run;
  const { createSynth } = await import('./synth.js');
  if (mine !== run) return;
  const sampleRate = 16000;
  // Against the user's own warning level, which is what the page goes by until the demo has learned one.
  const synth = createSynth({ sampleRate, background: (core.own ?? core.feed.floor) + 4 });
  begin('demo', sampleRate);
  let at = Date.now();
  timer = setInterval(() => {
    let seconds = (Date.now() - at) / 1000;
    if (seconds > 10) [at, seconds] = [Date.now() - 1000, 1]; // the page was asleep: skip what was missed, and the engine starts over
    const { tracks, trim, at: from } = core.feed;
    const pcm = synth.render(untrimmed(tracks, trim), from, at, seconds);
    at += (pcm.length / sampleRate) * 1000;
    hear(pcm, at);
  }, 250);
}

// ---- The panel ----

let ui = null; // its elements, once there is an address

function build() {
  box.innerHTML = `
    <h2>Timeline <span class="tag">Demo</span></h2>
    <div class="say" role="status"><p class="head"></p><p class="body"></p></div>
    <div class="chart"><canvas role="img" aria-label="Timeline. Before now: what the microphone heard. After now: when each aircraft is predicted to be audible, and how loud. The list of aircraft gives the same as text."></canvas></div>
    <ul class="key">
      <li class="mic"><i class="k-heard"></i>Heard, by pitch</li>
      <li class="mic"><i class="k-level"></i><span class="k-heard-as"></span></li>
      <li><i class="k-pred"></i>Predicted loudness</li>
      <li><i class="k-hold"></i>Hold</li>
      <li class="mic"><i class="k-pitch"></i>Predicted pitch</li>
    </ul>
    <p class="about"></p>
    <div class="learned">
      <p class="last"></p>
      <p class="tuning"></p>
      <p class="forget">
        <button type="button" class="ask quiet">Forget what was learned here</button>
        <span class="confirm" hidden>Forget it?
          <button type="button" class="yes quiet">Forget</button> <button type="button" class="no quiet">Keep</button></span>
      </p>
    </div>
    <div class="controls">
      <button type="button" class="go"></button>
      <label class="input" hidden>Input <select></select></label>
      <button type="button" class="again quiet">Learn the background again</button>
      <button type="button" class="demo quiet"></button>
    </div>`;
  const $ = (selector) => box.querySelector(selector);
  ui = { say: $('.say'), head: $('.head'), body: $('.body'), chart: $('.chart'), canvas: $('canvas'), learned: $('.learned'), last: $('.last'), tuning: $('.tuning'), forget: $('.forget'), ask: $('.ask'), confirm: $('.confirm'), about: $('.about'), go: $('.go'), input: $('.input'), select: $('select'), again: $('.again'), demo: $('.demo'), heardAs: $('.k-heard-as') };
  ctx = ui.canvas.getContext('2d');

  // Listening only ever starts here, when the button is pressed: never by itself on load.
  ui.go.onclick = () => {
    if (core.source !== 'mic') return listen(core.saved.device);
    stop();
  };
  ui.demo.onclick = () => {
    if (core.source === 'demo') stop();
    else demo();
  };
  ui.select.onchange = () => listen(ui.select.value);
  // For when the microphone has been moved or a new steady noise has started: otherwise the engine
  // takes some minutes to stop calling the difference a noise.
  ui.again.onclick = () => core.again();
  // Asked twice, because what it throws away took hours of aircraft to learn. Keyboard focus goes with the question.
  const asking = (on) => ((ui.ask.hidden = on), (ui.confirm.hidden = !on), (on ? $('.no') : ui.ask).focus());
  ui.ask.onclick = () => asking(true);
  $('.no').onclick = () => asking(false);
  $('.yes').onclick = () => {
    asking(false);
    core.forget();
    show();
    ui.go.focus(); // the button that was pressed is gone
  };
  ui.canvas.onclick = (e) => {
    const hex = hit(e.offsetX * view.k, e.offsetY * view.k);
    if (hex) send('hfs:select', { hex: hex === selected ? null : hex });
  };
  ui.canvas.onpointermove = (e) => (ui.canvas.style.cursor = hit(e.offsetX * view.k, e.offsetY * view.k) ? 'pointer' : '');

  new ResizeObserver(() => fit()).observe(ui.chart);
  new IntersectionObserver(([entry]) => ((onScreen = entry.isIntersecting), wake())).observe(ui.chart);
  document.fonts.ready.then(() => fit(true)); // the words on the canvas need the page's typeface
  fit();
  pace();
}

// Everything in the panel that is words. Only text that changed is touched.
function show() {
  if (!ui) return;
  const { source, feed } = core;
  const [head, body] = problem ? PROBLEMS[problem] : source ? say({ status: core.ear.status(), name, stale: core.stale() }) : ['', ''];
  put(ui.head, head);
  put(ui.body, body);
  ui.say.hidden = !head;
  box.dataset.source = source;
  put(ui.go, source === 'mic' ? 'Stop listening' : 'Listen with the microphone');
  put(ui.demo, source === 'demo' ? 'Stop the demo' : 'Try it with demo sound');
  put(ui.about, source === 'mic' ? '' : CONSENT);
  ui.input.hidden ||= source !== 'mic';
  ui.again.hidden = source !== 'mic';
  ui.demo.hidden = source === 'mic';
  // Until a floor is learned, what the microphone measures cannot be placed against the warning level.
  put(ui.heardAs, feed.learned == null ? 'Heard loudness, over background' : 'Heard loudness');
  const t = core.learned();
  put(ui.last, core.last ? recap(core.last) : '');
  // The slider is only compared with what was learned once the page has that in effect.
  put(ui.tuning, (source === 'demo' ? 'Demo only. ' : '') + explain(t, { floor: core.inStep() ? feed.floor : null }));
  ui.learned.hidden = !source && !t.passes;
  ui.forget.hidden = source === 'demo' || !core.list.length;
}

// ---- Drawing ----

let ctx = null;
let view = null; // the canvas's shape in device pixels, from fit()
let onScreen = true;
let queued = false;
let wasStale = false;
let rowOf = new Map(); // which row each aircraft's name is on
const widths = new Map(); // text -> its width on the canvas
// A new forecast's curves ease out of the old ones over as long as the map takes over the same change.
// Only the curves: the hold rail and the names' words are the newest forecast's at once.
const EASE_MS = 1500;
let since = 0; // when the newest forecast came
const morphs = new WeakMap(); // a plane's `was` -> its easing into `pts`
const eased = (plane, k) => {
  if (!morphs.has(plane.was)) morphs.set(plane.was, morph(plane.was, plane.pts, 't'));
  return morphs.get(plane.was)(k);
};
const showing = () => view && !document.hidden && onScreen;

// The spectrogram as a strip of pixels that is only added to. Each pixel column is one `ms` of time
// and they are kept in a ring, so a new column of sound touches one column of pixels and nothing is
// drawn twice. `ink` is the colour as [r, g, b]; how loud is how opaque, so the panel shows through.
function createTape(width, height, ms, ink) {
  const canvas = Object.assign(document.createElement('canvas'), { width, height });
  const c = canvas.getContext('2d');
  const strip = c.createImageData(1, height);
  const px = new Uint32Array(strip.data.buffer); // one number per pixel: alpha, blue, green, red
  const colour = (ink[2] << 16) | (ink[1] << 8) | ink[0];
  const rows = rowBins(height);
  const sum = new Uint16Array(height); // the columns that fell in this pixel so far, added up
  let count = 0;
  let filling = null; // the pixel column those belong to
  let head = null; // the newest pixel column that is up to date
  const x = (slot) => ((slot % width) + width) % width;
  // Blank the columns up to `slot`: the ring still holds what was there one width ago.
  function reach(slot) {
    if (head == null || slot - head >= width) c.clearRect(0, 0, width, height);
    else for (let s = head + 1; s <= slot; s++) c.clearRect(x(s), 0, 1, height);
    head = slot;
  }
  return {
    // One column of sound: its time, and its shade (0 to 255) per frequency bin.
    add(at, shades) {
      const slot = Math.floor(at / ms);
      if (head != null && slot <= head - width) return;
      if (head == null || slot > head) reach(slot);
      if (slot !== filling) {
        filling = slot;
        count = 0;
        sum.fill(0);
      }
      count++;
      for (let r = 0; r < height; r++) {
        let most = 0;
        for (let b = rows[2 * r]; b < rows[2 * r + 1]; b++) if (shades[b] > most) most = shades[b];
        sum[r] += most;
        px[r] = (Math.round(sum[r] / count) << 24) | colour;
      }
      c.putImageData(strip, x(slot), 0);
    },
    // Onto the page, with pixel column `slot` just left of `right`.
    draw(to, slot, right, top) {
      if (head == null || slot > head) reach(slot);
      const cut = x(slot + 1); // where the oldest column sits in the ring
      to.drawImage(canvas, cut, 0, width - cut, height, right - width, top, width - cut, height);
      if (cut) to.drawImage(canvas, 0, 0, cut, height, right - cut, top, cut, height);
    },
  };
}

// Size the canvas to its box and the screen's pixels, and read the theme. Called when the box, the
// zoom, the colour scheme or what is being listened to changes; everything else is draw(). The box's
// size is the page's to give (listen.css, page.css), and the timeline is laid out to fill it.
function fit(force) {
  if (!ui) return;
  const width = ui.chart.clientWidth;
  const height = ui.chart.clientHeight;
  const style = getComputedStyle(ui.chart);
  const k = devicePixelRatio || 1;
  const { source } = core;
  const sig = [width, height, k, style.fontSize, source].join();
  if (!width || !height || (!force && sig === view?.sig)) return;
  const g = layout(width, !!source, parseFloat(style.fontSize), height);
  const W = (ui.canvas.width = Math.round(width * k));
  ui.canvas.height = Math.round(g.height * k);
  const band = (b) => ({ y: Math.round(b.y * k), h: Math.round(b.h * k) });
  const theme = getComputedStyle(document.documentElement);
  const paint = Object.fromEntries(['panel', 'line', 'ink', 'ink-2', 'accent', 'hold'].map((name) => [name, theme.getPropertyValue(`--${name}`).trim()]));
  const xNow = Math.round(g.xNow * k);
  const ms = ((g.past + g.ahead) * 1000) / W;
  view = { sig, g, k, W, H: ui.canvas.height, ms, xNow, paint, pitch: band(g.pitch), level: band(g.level), rail: band(g.rail), axis: Math.round(g.axis.y * k), row: Math.round(g.row * k), em: parseFloat(style.fontSize) * k, family: style.fontFamily, hits: [], t0: 0, tape: null };
  widths.clear();
  if (source) {
    ctx.fillStyle = paint.ink; // the canvas turns any CSS colour into #rrggbb
    view.tape = createTape(xNow, view.pitch.h, ms, [1, 3, 5].map((i) => parseInt(ctx.fillStyle.slice(i, i + 2), 16)));
    for (let n = Math.max(0, cols.n - COLS); n < cols.n; n++) view.tape.add(cols.at[n % COLS], cols.shade.subarray((n % COLS) * BINS, (n % COLS + 1) * BINS));
  }
  behind = false;
  draw();
}

function draw() {
  const { k, W, H, ms, xNow, paint, pitch, level, rail, axis, row, em, family, g } = view;
  const c = ctx;
  const now = Date.now();
  const slot = Math.floor(now / ms);
  const t0 = (view.t0 = slot * ms); // "now", moved back to a whole pixel, so everything slides together
  const X = (t) => xNow + (t - t0) / ms;
  const from = t0 - xNow * ms;
  const to = t0 + (W - xNow) * ms;
  const { feed, source, ear, heard, tones } = core;
  const planes = core.forecast.planes;
  const floor = feed.floor;
  const old = core.stale();
  if (old !== wasStale) {
    wasStale = old;
    show();
  }
  const base = level.y + level.h;
  const crisp = (v) => Math.round(v) + (Math.round(k) % 2) / 2; // a hairline's middle, so it fills whole pixels
  const pen = (width, colour, dash = []) => {
    c.lineWidth = width * k;
    c.strokeStyle = colour;
    c.setLineDash(dash.map((d) => d * k));
  };
  const rule = (x1, y1, x2, y2) => {
    c.beginPath();
    c.moveTo(x1, y1);
    c.lineTo(x2, y2);
    c.stroke();
  };
  const widthOf = (text, weight) => {
    c.font = `${weight} ${em}px ${family}`;
    const id = weight + text;
    if (!widths.has(id)) widths.set(id, c.measureText(text).width);
    return widths.get(id);
  };
  // Words on a plate of the panel's colour, so they read over whatever is underneath. `x` is the left
  // edge, or the right edge or the middle with `align`; `y` is the middle of the line.
  const write = (text, x, y, colour, weight = 500, align = 0) => {
    const w = widthOf(text, weight);
    const left = Math.round(x - w * align);
    c.globalAlpha = 0.85;
    c.fillStyle = paint.panel;
    c.fillRect(left - 3 * k, Math.round(y - row / 2), w + 6 * k, row);
    c.globalAlpha = 1;
    c.fillStyle = colour;
    c.fillText(text, left, y);
  };

  c.clearRect(0, 0, W, H);
  c.lineJoin = c.lineCap = 'round';
  c.textBaseline = 'middle';

  // What was heard, by pitch.
  view.tape?.draw(c, slot, xNow, pitch.y);

  // Loudness: every aircraft's predicted level as an outline, and under it what the microphone measured.
  const shapes = [];
  const along = calm.matches ? 1 : easeOut((now - since) / EASE_MS);
  let easing = false;
  for (const plane of planes.values()) {
    if (plane.peak < floor + LOW) continue;
    const pts = along < 1 && plane.was ? eased(plane, along) : plane.pts;
    easing ||= pts !== plane.pts;
    const lines = runs({ pts }, from, to, floor + LOW).map((run) => run.map((p) => [X(p.at), levelY(p.db - floor, level), p]));
    const inView = (q) => q[2].at >= from && q[2].at <= to;
    const top = lines.flat().reduce((most, q) => (inView(q) && q[2].db > (most?.[2].db ?? floor + LOW) ? q : most), null);
    if (!top) continue;
    // Its loudest moment is on the timeline, not still to slide in from the right or already gone off the left.
    const peaked = !lines.flat().some((q) => !inView(q) && q[2].db > top[2].db);
    shapes.push({ plane, lines, x: top[0], y: top[1], db: top[2].db, at: top[2].at, peaked, chosen: plane.hex === selected });
  }
  shapes.sort((a, b) => a.chosen - b.chosen || a.at - b.at); // the selected aircraft is drawn last, on top
  const trace = (points, closed) => {
    c.beginPath();
    points.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y)));
    if (!closed) return;
    c.lineTo(points.at(-1)[0], base);
    c.lineTo(points[0][0], base);
    c.closePath();
  };
  pen(1, paint.line);
  rule(0, crisp(levelY(20, level)), W, crisp(levelY(20, level)));
  rule(0, crisp(base), W, crisp(base));
  c.save();
  c.beginPath();
  c.rect(0, level.y, W, level.h);
  c.clip();
  for (const s of shapes) {
    c.fillStyle = s.chosen ? paint.accent : paint.ink;
    c.globalAlpha = s.chosen ? 0.3 : 0.14;
    for (const points of s.lines) trace(points, true), c.fill();
  }
  c.globalAlpha = 0.45;
  c.fillStyle = paint.ink;
  let swell = [];
  for (const [i, h] of heard.entries()) {
    if (h.at >= from) swell.push([X(h.at), levelY(heardOver(h.rise, floor, feed.learned), level)]);
    if (swell.length && (i === heard.length - 1 || heard[i + 1].at - h.at > 2500)) {
      trace(swell, true);
      c.fill();
      swell = [];
    }
  }
  c.globalAlpha = 1;
  for (const s of shapes) {
    // Thinner if it never reaches the warning level, and dotted while it is an estimate of an aircraft the feed has lost.
    pen(s.chosen ? 2.5 : s.db < floor ? 1 : 1.5, s.chosen ? paint.accent : paint.ink, s.plane.lost ? [1, 4] : []);
    for (const points of s.lines) trace(points), c.stroke();
  }
  c.restore();
  pen(1, paint['ink-2']);
  rule(0, crisp(levelY(0, level)), W, crisp(levelY(0, level)));
  write('Warning level', W - 5 * k, levelY(0, level) - row / 2 - k, paint['ink-2'], 500, 1);
  if (!old) write('+20 dB', W - 5 * k, levelY(20, level) - row / 2 - k, paint['ink-2'], 500, 1);

  // When the page expects to be holding: the same moments the banner counts down to.
  c.fillStyle = paint.hold;
  for (const [a, b] of held(planes, feed.windows, feed.at, floor, banner.map(([since, until]) => [since, until ?? now]))) if (b >= from && a <= to) c.fillRect(Math.round(X(a)), rail.y, Math.max(2 * k, Math.round(X(b) - X(a))), rail.h);

  // Where the tones of a matched aircraft should be: over what was heard, to check by eye, and on ahead.
  if (ear) {
    c.save();
    c.beginPath();
    c.rect(0, pitch.y, W, pitch.h);
    c.clip();
    for (const [hex, tone] of tones) {
      const plane = planes.get(hex);
      if (!plane) tones.delete(hex);
      // Only over the stretches where it is predicted loud enough for the engine to be looking for it:
      // an aircraft that comes round again gets its curves again, with nothing drawn across the quiet between.
      for (const loud of plane ? runs(plane, from, to, floor - 15) : []) {
        for (const hz of series(tone)) {
          let down = false;
          c.beginPath();
          ear.curve(hex, hz, loud[0].at, loud.at(-1).at, 500).forEach((heardHz, i) => {
            const y = pitchY(heardHz, pitch);
            if (!(y > pitch.y && y < pitch.y + pitch.h)) return (down = false);
            c[down ? 'lineTo' : 'moveTo'](X(loud[0].at + i * 500), y);
            down = true;
          });
          // Dashed, so that the sound itself shows through the gaps.
          pen(3.5, paint.panel, [4, 7]);
          c.stroke();
          pen(1.5, hex === selected ? paint.accent : paint.ink, [4, 7]);
          c.stroke();
        }
      }
    }
    c.restore();
  }

  pen(2, paint.ink);
  rule(xNow, 0, xNow, rail.y + rail.h + 4 * k);

  // Names, each on a pole standing on the loudest moment of its aircraft's pass.
  const flags = shapes
    .filter((s) => (s.db >= floor && s.peaked) || s.chosen || tones.has(s.plane.hex))
    .sort((a, b) => b.chosen - a.chosen || Math.abs(a.at - t0) - Math.abs(b.at - t0))
    .map((s) => {
      const text = s.plane.lost ? `${s.plane.name} (estimate)` : s.plane.name;
      const w = widthOf(text, s.chosen ? 700 : 500);
      const flip = s.x + w + 8 * k > W; // no room on the right: the name goes left of its pole
      return { hex: s.plane.hex, s, text, x: flip ? s.x - w - 5 * k : s.x + 5 * k, w };
    });
  // While listening they keep to the rows above the spectrogram's own labels, and clear of the demo's mark.
  if (source === 'demo') flags.unshift({ hex: '', x: 6 * k, w: widthOf('Demo sound', 700) + 6 * k });
  rowOf = place(flags, source ? (g.width < 600 ? 2 : 3) : 3, new Map(rowOf).set('', 0), 10 * k);
  view.hits = [];
  for (const f of flags) {
    if (!f.s || !rowOf.has(f.hex)) continue;
    const y = pitch.y + rowOf.get(f.hex) * row + row / 2 + 2 * k;
    const colour = f.s.chosen ? paint.accent : paint.ink;
    c.globalAlpha = f.s.chosen ? 1 : 0.4;
    pen(1, colour);
    rule(crisp(f.s.x), y + row / 2, crisp(f.s.x), Math.max(f.s.y, level.y));
    c.globalAlpha = 1;
    write(f.text, f.x, y, colour, f.s.chosen ? 700 : 500);
    view.hits.push({ hex: f.hex, x0: f.x - 8 * k, x1: f.x + f.w + 8 * k, y0: y - row / 2 - 4 * k, y1: y + row / 2 + 4 * k });
  }

  // Old flight data: the forecast is left where it was, under a veil, so that it cannot pass for live.
  if (old) {
    c.globalAlpha = 0.72;
    c.fillStyle = paint.panel;
    c.fillRect(xNow + k, 0, W, rail.y + rail.h);
    c.globalAlpha = 1;
    write(feed.dataAt === 0 ? 'No flight data for this location yet.' : `No flight data since ${new Date(feed.dataAt ?? feed.at).toLocaleTimeString('en-GB')}`, xNow + 8 * k, levelY(20, level) - row / 2 - k, paint.ink, 700);
  }

  // The spectrogram's own labels go over anything that has slid under them.
  if (view.tape) {
    pen(1, paint['ink-2']);
    for (const [hz, text] of [[100, '100 Hz'], [1000, '1 kHz']]) {
      const y = crisp(pitchY(hz, pitch));
      rule(0, y, 5 * k, y);
      write(text, 9 * k, y, paint['ink-2']);
    }
    if (source === 'demo') write('Demo sound', 9 * k, pitch.y + row / 2 + 2 * k, paint.ink, 700);
  }

  // The minutes either side of now.
  for (const { s, text } of ticks(g.past, g.ahead, 1000 / ms / k, em / k)) {
    const x = X(t0 + s * 1000);
    const w = widthOf(text, s ? 500 : 700);
    if (x - w / 2 < 2 * k || x + w / 2 > W - 2 * k) continue;
    pen(1, paint['ink-2']);
    if (s) rule(crisp(x), rail.y + rail.h + k, crisp(x), rail.y + rail.h + 4 * k);
    c.fillStyle = s ? paint['ink-2'] : paint.ink;
    c.fillText(text, Math.round(x - w / 2), axis + row / 2);
  }
  return easing;
}

// The aircraft under a point on the canvas: its name, or its shape in the loudness band.
function hit(x, y) {
  const { hits, level, rail, ms, xNow, t0, k } = view;
  const flag = hits.find((h) => x >= h.x0 && x <= h.x1 && y >= h.y0 && y <= h.y1);
  if (flag) return flag.hex;
  if (y < level.y - 4 * k || y > rail.y + rail.h + 4 * k) return null;
  let best = null;
  let most = core.feed.floor + LOW;
  for (const plane of core.forecast.planes.values()) {
    const db = levelAt(plane, t0 + (x - xNow) * ms);
    if (db > most) [best, most] = [plane.hex, db];
  }
  return best;
}

// Four frames a second is as fast as the timeline moves a pixel, and every frame while a new forecast
// eases in; one a second for people who have asked for less motion. Nothing is drawn while the page
// is hidden or the panel is scrolled away.
function tick() {
  if (!showing() || queued) return;
  queued = true;
  requestAnimationFrame(() => {
    queued = false;
    if (draw()) tick();
  });
}
function wake() {
  if (!showing()) return;
  if (behind) fit(true);
  else tick();
}
const calm = matchMedia('(prefers-reduced-motion: reduce)');
let beat;
const pace = () => {
  clearInterval(beat);
  beat = setInterval(tick, calm.matches ? 1000 : 250);
};
calm.addEventListener('change', pace);
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => fit(true));
addEventListener('resize', () => fit()); // zooming changes the pixels without changing the box
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  audio?.resume().catch(() => {});
  wake();
});
// Browsers hold audio back until the page has been touched; any touch will do.
for (const type of ['pointerdown', 'keydown']) document.addEventListener(type, () => audio && audio.state !== 'running' && audio.resume().catch(() => {}));
navigator.mediaDevices?.addEventListener('devicechange', () => core.source === 'mic' && inputs());

// ---- The page's events ----

document.addEventListener('hfs:update', (e) => {
  const first = !core.feed;
  // An update that comes while curves are still easing eases on from where they are drawn, not from
  // the forecast before: tell the forecast what is on screen.
  const along = calm.matches ? 1 : easeOut((Date.now() - since) / EASE_MS);
  if (along < 1) for (const plane of core.forecast?.planes.values() ?? []) if (plane.was) plane.shown = eased(plane, along);
  const moved = core.update(e.detail);
  since = Date.now();
  if (first) build();
  // Another set or environment: the core has started afresh, and so does the timeline. A demo stops,
  // because what it found, and the room it made up, belong to the set it was started on.
  if (moved && core.source === 'demo') stop();
  else if (moved) clear();
  show();
  tick();
});
document.addEventListener('hfs:select', (e) => {
  selected = e.detail.hex;
  tick();
});
document.addEventListener('hfs:status', (e) => {
  const open = banner.at(-1)?.[1] === null;
  if (e.detail.state === 'hold' && !open) banner.push([Date.now(), null]);
  else if (e.detail.state !== 'hold' && open) banner.at(-1)[1] = Date.now();
  if (banner.length > 60) banner.shift(); // far more than the timeline can show
});
