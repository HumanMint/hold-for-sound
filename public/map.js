// The map of aircraft around the set. Draws inside <section id="map">; see the events described in app.js.
// The set stays in the middle and the map never pans. Geometry lives in map-geo.js, where it is tested.
import { windReadout } from './map-wind.js';
import { CLASS_NAME, located, local } from './predict.js';
import { STALE_MS, SOON_MS } from './status.js'; // when the page stops trusting its data, and when "clear" becomes "heads up"
import { metresPerPixel, zoomFor, tiles, toScreen, sample, edge, overlaps, hit, place, labelSides, ringStep, compass, CUT_M, easeOut, morph, heardOn, heardNow, clocks, moving, trustLeftS } from './map-geo.js';

// Free, keyless basemap, fetched by the browser. OpenStreetMap's tile policy asks for a visible credit,
// the browser's own caching and Referer, and only the tiles being looked at. This map never pans, so
// that is 40 at most per zoom level, and usually a dozen or two. Set TILES to null to draw without a basemap.
const TILES = {
  url: (z, x, y) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png`,
  credit: '© OpenStreetMap contributors',
  about: 'https://www.openstreetmap.org/copyright',
};

// The default view reaches at least this far in every direction: about as far as a jet is heard
// there. Outdoors that is also a minute's flying, so what is on the map is what the heads-up is about.
const REACH_M = { outdoors: 6000, indoors: 3000, stage: 2000 };
const STEPS = [-2, 1]; // zoom levels offered around the default: two wider, one closer
const SLIP_MS = 1500; // a new update's correction to an aircraft's position, and to its predicted path, is eased in over this long

const root = document.getElementById('map');
root.innerHTML = `<div class="map-frame map-empty">
  <div class="map-tiles" aria-hidden="true"></div>
  <canvas role="img" aria-describedby="map-says" aria-label="Aircraft around the set and where each is predicted to go. The list of aircraft on this page gives the same predictions as text."></canvas>
  <p class="map-notice"></p>
  <button type="button" class="map-wind" hidden><span class="map-wind-row"><span class="map-wind-arrow" aria-hidden="true">↑</span><span class="map-wind-value"></span></span><span class="map-wind-tag"></span></button>
  <div class="map-zoom"><button type="button" aria-label="Zoom in">+</button><button type="button" aria-label="Zoom out">&minus;</button></div>
  <div class="map-foot"><p class="map-caption"></p><a class="map-credit" target="_blank" rel="noopener"></a></div>
  <p class="map-says" id="map-says"></p>
  <i class="map-probe" hidden></i>
</div>`;
const $ = (selector) => root.querySelector(selector);
const frame = $('.map-frame');
const canvas = $('canvas');
const ctx = canvas.getContext('2d');
const [zoomIn, zoomOut] = root.querySelectorAll('.map-zoom button');
if (TILES) Object.assign($('.map-credit'), { href: TILES.about, textContent: TILES.credit });

const send = (name, detail) => document.dispatchEvent(new CustomEvent(name, { detail }));
const mmss = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const put = (el, text) => el.textContent !== text && (el.textContent = text);
const still = matchMedia('(prefers-reduced-motion: reduce)');

let last = null; // the latest hfs:update
let banner = ''; // the page's status, from hfs:status: 'hold', 'soon', 'clear', or '' for none
// The feed can be behind while requests still succeed, so freshness is judged by the data, not the poll.
const staleMs = () => last.staleMs ?? STALE_MS;
const isStale = (now) => now - (last.dataAt ?? last.at) > staleMs();
let craft = []; // every aircraft in it that has a position: { hex, ac, track, win, taxiing, lost, at }
let selected = null;
let windUnit = 'mph';
let step = 0; // zoom, relative to the default for this box
let view = { w: 0, h: 0, dpr: 1, zoom: 10, mpp: 100 };
let marks = []; // what the last frame drew, for clicks: { hex, x, y, box, loud }
const drawn = new Map(); // hex -> where it was last drawn, in metres from the set
const slip = new Map(); // hex -> { x, y, at }: how far the latest update moved it from where it was drawn
const reshape = new Map(); // hex -> { from, shift, at, ease }: the path drawn before the latest update, and how far behind it is
const trails = new Map(); // hex -> its reported positions over the last minute (none are added while it is lost)
const sides = new Map(); // hex -> the side of the aircraft its label was last on
try {
  if (localStorage.getItem('hfs-map-unit') === 'knots') windUnit = 'knots';
  step = Math.max(STEPS[0], Math.min(STEPS[1], +localStorage.getItem('hfs-map') || 0));
} catch {}

function showWind() {
  const value = last?.dataAt ? windReadout(last.weather, windUnit) : null;
  const button = $('.map-wind');
  button.hidden = !value;
  if (!value) return;
  put($('.map-wind-value'), value.text);
  put($('.map-wind-tag'), value.tag);
  $('.map-wind-tag').hidden = !value.tag;
  const arrow = $('.map-wind-arrow');
  arrow.hidden = value.angle === null;
  arrow.style.transform = `rotate(${value.angle ?? 0}deg)`;
  button.setAttribute('aria-label', value.label);
}
$('.map-wind').addEventListener('click', () => {
  windUnit = windUnit === 'mph' ? 'knots' : 'mph';
  try { localStorage.setItem('hfs-map-unit', windUnit); } catch {}
  showWind();
  draw();
});

// Colours and type come from theme.css. A canvas can't use var(), so they are read through a hidden
// element (which also resolves anything the theme computes) and read again whenever they might change.
const theme = {};
const probe = $('.map-probe');
const dot = Object.assign(document.createElement('canvas'), { width: 1, height: 1 }).getContext('2d', { willReadFrequently: true });
function readTheme() {
  const style = getComputedStyle(probe);
  for (const name of ['panel', 'ink', 'ink-2', 'accent', 'clear', 'soon', 'hold', 'fill-soon', 'on-fill-soon', 'fill-hold', 'on-fill-hold']) {
    probe.style.color = `var(--${name})`;
    theme[name] = style.color;
  }
  for (const name of ['font', 'font-num']) {
    probe.style.fontFamily = `var(--${name})`;
    theme[name] = style.fontFamily;
  }
  theme.em = parseFloat(getComputedStyle(frame).fontSize); // canvas text follows the reader's font size
  // The basemap only comes in a light style: a dark panel means its tiles are inverted (see map.css).
  dot.fillStyle = theme.panel;
  dot.fillRect(0, 0, 1, 1);
  const [r, g, b] = dot.getImageData(0, 0, 1, 1).data;
  frame.classList.toggle('map-dark', r * 0.299 + g * 0.587 + b * 0.114 < 128);
}

// Aircraft seen from above, nose up, two units long: half of each outline, mirrored when built.
const outline = (half) => {
  const path = new Path2D();
  const all = [...half, ...half.slice(1, -1).reverse().map(([x, y]) => [-x, y])];
  all.forEach(([x, y], i) => (i ? path.lineTo(x, y) : path.moveTo(x, y)));
  path.closePath();
  return path;
};
const circle = (x, y, r) => {
  const path = new Path2D();
  path.arc(x, y, r, 0, 2 * Math.PI);
  return path;
};
const JET = outline([[0, -1], [0.14, -0.62], [0.16, -0.18], [1, 0.38], [1, 0.58], [0.16, 0.3], [0.13, 0.72], [0.42, 0.92], [0.42, 1.04], [0, 0.94]]);
const PROP = outline([[0, -1], [0.15, -0.74], [0.16, -0.38], [1, -0.32], [1, -0.04], [0.16, 0.02], [0.1, 0.74], [0.4, 0.78], [0.4, 0.98], [0, 0.94]]);
const HELI = outline([[0, -0.62], [0.26, -0.44], [0.28, 0.04], [0.08, 0.3], [0.07, 0.86], [0.3, 0.86], [0.3, 1.02], [0, 1.02]]);
const ROTOR = new Path2D('M-0.66 -0.8L0.66 0.52M0.66 -0.8L-0.66 0.52');
const OTHER = circle(0, 0, 0.5);
// Outline and half-length in pixels for each size category the transponder reports.
const SHAPES = { A1: [PROP, 7], A2: [JET, 8], A3: [JET, 10], A4: [JET, 10.5], A5: [JET, 13], A6: [JET, 9], A7: [HELI, 8] };

function glyph(p, heading, category, scale, colour, hollow) {
  const [shape, size] = SHAPES[category] ?? [OTHER, 6];
  const s = size * scale;
  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.rotate(heading ?? 0);
  ctx.scale(s, s);
  ctx.lineJoin = 'round';
  // Solid with a rim of panel colour to lift it off the basemap, or hollow for "not really here":
  // old data, or an aircraft the feed has lost, whose position is the page's estimate.
  ctx.lineWidth = (hollow ? 1.5 : 2.5) / s;
  ctx.strokeStyle = hollow ? colour : theme.panel;
  ctx.fillStyle = hollow ? theme.panel : colour;
  if (!hollow) ctx.stroke(shape);
  ctx.fill(shape);
  if (hollow) ctx.stroke(shape);
  if (shape === HELI) {
    ctx.lineCap = 'round';
    ctx.lineWidth = 3.5 / s;
    ctx.strokeStyle = theme.panel;
    if (!hollow) ctx.stroke(ROTOR);
    ctx.lineWidth = 1.5 / s;
    ctx.strokeStyle = colour;
    ctx.stroke(ROTOR);
  }
  ctx.restore();
}

function line(points, width, colour) {
  ctx.beginPath();
  points.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
  ctx.lineWidth = width;
  ctx.strokeStyle = colour;
  ctx.stroke();
}

const face = (weight, size, family = 'font') => `${weight} ${Math.round(theme.em * size * 10) / 10}px ${theme[family]}`;
// Text with a rim of panel colour, so it reads over the basemap.
function text(string, x, y, colour, font, align = 'center') {
  ctx.font = font;
  ctx.textAlign = align;
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.lineWidth = 3;
  ctx.strokeStyle = theme.panel;
  ctx.strokeText(string, x, y);
  ctx.fillStyle = colour;
  ctx.fillText(string, x, y);
}

const name = (c) => c.ac.flight?.trim() || c.hex; // the same name the list gives it
const state = (c, now) => (!c.win || c.win.end <= now ? null : c.win.start <= now ? 'hold' : c.win.start - now < SOON_MS ? 'soon' : 'later');
const rank = (s) => ['hold', 'soon', 'later', null].indexOf(s);

// Where an aircraft is `t` seconds after the update: along its predicted path, or where it was reported
// if it has none (parked, taxiing, or a position too old to extrapolate).
function position(c, t, now) {
  const m = c.track ? sample(c.track.path, 't', t) : { ...c.at };
  m.heading ??= c.at.heading;
  const s = slip.get(c.hex);
  const k = s ? 1 - easeOut((now - s.at) / SLIP_MS) : 0;
  if (k > 0) {
    m.x += s.x * k;
    m.y += s.y * k;
  }
  return m;
}

// Its predicted path as drawn: easing out of the one drawn before the latest update, at the same pace
// as the aircraft itself. Only the line moves; whether and when it is heard is the latest update's.
function shape(c, now) {
  const r = reshape.get(c.hex);
  const k = r ? easeOut((now - r.at) / SLIP_MS) : 1;
  if (k >= 1) return c.track.path;
  r.ease ??= morph(r.from.map((q) => ({ ...q, t: q.t - r.shift, heardAt: q.heardAt - r.shift })), c.track.path, 't');
  return r.ease(k);
}

function draw() {
  if (document.hidden) return; // updates keep arriving in a hidden tab; nothing is drawn until it is shown
  if (devicePixelRatio !== view.dpr && view.w) return layout(); // moved to another screen
  const now = Date.now();
  const { w, h, mpp } = view;
  ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  marks = [];
  if (!last) return;
  const { site, floor } = last;
  const stale = isStale(now);
  // Things are placed at `t`, which stands still with reduced motion; what is heard is decided at `real`.
  const { draw: t, real } = clocks((now - last.at) / 1000, still.matches, trustLeftS(last.at, last.dataAt ?? last.at, staleMs()));
  const at = (m) => toScreen(view, m);
  const centre = { x: w / 2, y: h / 2 };
  const small = face(500, 0.87);
  const size = 1 + Math.min(0, step) * 0.1; // aircraft are drawn a little smaller on the wider views
  // A few words beside a point on a path. They are kept until everything else is drawn, then put on
  // whichever side is free, the one away from the set first. `across` is the direction across the path.
  const notes = []; // { string, colour, spots: [{ x, y, align }] }
  const beside = (string, colour, p, heading, gap) => {
    const across = { x: Math.cos(heading), y: Math.sin(heading) };
    const away = (p.x - centre.x) * across.x + (p.y - centre.y) * across.y < 0 ? -1 : 1;
    const spots = [away, -away].map((k) => ({ x: p.x + across.x * gap * k, y: p.y + across.y * gap * k, align: across.x * k > 0.3 ? 'left' : across.x * k < -0.3 ? 'right' : 'center' }));
    notes.push({ string, colour, spots });
    return across;
  };

  // Range rings: the scale of the map, and distance is what sets both loudness and delay.
  const ring = ringStep((Math.min(w, h) / 2) * mpp);
  ctx.globalAlpha = 0.25;
  ctx.lineWidth = 1;
  ctx.strokeStyle = theme['ink-2'];
  for (let r = ring; r / mpp < Math.hypot(w, h) / 2; r += ring) ctx.stroke(circle(centre.x, centre.y, r / mpp));
  ctx.globalAlpha = 1;

  // Runways, with each airport named once.
  const fields = new Map();
  ctx.lineCap = 'butt';
  for (const rw of site.runways ?? []) {
    const ends = rw.ends.map((end) => at(local(end, site)));
    line(ends, Math.max(2.5, 60 / mpp), theme['ink-2']);
    const f = fields.get(rw.airport) ?? { x: 0, n: 0, top: Infinity, low: -Infinity, length: 0 };
    fields.set(rw.airport, {
      x: f.x + ends[0].x + ends[1].x,
      n: f.n + 2,
      top: Math.min(f.top, ends[0].y, ends[1].y),
      low: Math.max(f.low, ends[0].y, ends[1].y),
      length: Math.max(f.length, Math.hypot(ends[0].x - ends[1].x, ends[0].y - ends[1].y)),
    });
  }
  for (const [airport, f] of fields) {
    if (f.length < 24) continue; // too small on screen to be worth a name
    const onSet = (y) => Math.abs(f.x / f.n - centre.x) < 40 && Math.abs(y - centre.y - 10) < 30;
    const y = [f.low + theme.em * 0.8, f.top - theme.em * 0.8].find((y) => !onSet(y));
    if (y != null) text(airport, f.x / f.n, y, theme['ink-2'], small);
  }

  // Everything in range as a quiet mark; the ones to be heard, and the selected one, are kept for later.
  const loud = [];
  for (const c of craft) {
    const m = position(c, t, now);
    drawn.set(c.hex, m);
    const p = at(m);
    const s = stale ? null : state(c, now);
    if (s || c.hex === selected || (c.taxiing && !stale)) {
      loud.push({ c, m, p, s });
      continue;
    }
    if (p.x < -20 || p.y < -20 || p.x > w + 20 || p.y > h + 20) continue;
    marks.push({ hex: c.hex, x: p.x, y: p.y });
    ctx.globalAlpha = 0.8;
    if (c.ground) {
      ctx.fillStyle = theme['ink-2'];
      ctx.fill(circle(p.x, p.y, 1.75));
    } else glyph(p, m.heading, c.ac.category, 0.68 * size, theme['ink-2'], stale || c.lost);
    ctx.globalAlpha = 1;
  }
  loud.sort((a, b) => rank(b.s) - rank(a.s) || (b.c.win?.start ?? 0) - (a.c.win?.start ?? 0)); // soonest drawn last, on top

  // Predicted paths. The line is firm for a minute, then dotted and fading: it is a straight-line guess.
  for (const { c, m, s } of stale ? [] : loud) {
    if (!c.track) continue;
    const chosen = c.hex === selected;
    const path = shape(c, now);
    const runs = s ? heardOn(c.track.path, path, floor, real) : []; // the newest prediction's, placed on the line as drawn
    const colour = s === 'hold' ? theme.hold : s === 'soon' ? theme.soon : theme.ink;
    const trail = trails.get(c.hex) ?? [];
    ctx.globalAlpha = 0.6;
    line((c.lost ? trail : [...trail, m]).map(at), 1, theme['ink-2']); // where it has actually been for the last minute
    // Lost: the trail stops where it was last reported, and everything from there on is dotted.
    ctx.setLineDash([2, 5]);
    if (c.lost && trail.length) line([trail.at(-1), m].map(at), 1, theme['ink-2']);
    ctx.setLineDash([]);

    // Nothing matters after the last of it is heard, so the line stops there.
    const until = runs.length ? runs.at(-1).at(-1).t + 15 : t + 300;
    const ahead = [{ ...m, t }, ...path.filter((q) => q.t > t && q.t <= until)];
    for (let from = 0; from < ahead.length - 1; ) {
      let to = from + 1;
      while (to < ahead.length - 1 && ahead[to].t - ahead[from].t < 30) to++;
      const lead = ahead[from].t - t;
      ctx.globalAlpha = Math.max(runs.length ? 0.25 : 0, 1 - Math.max(0, lead - 30) / 270);
      ctx.setLineDash(lead >= 60 || c.lost ? [2, 5] : []);
      line(ahead.slice(from, to + 1).map(at), chosen ? 2 : 1.5, chosen ? theme.accent : theme.ink);
      from = to;
    }
    ctx.setLineDash([]);

    // The stretch that will be heard, as wide as it is predicted to be loud, with an in and an out mark.
    for (const run of runs) {
      const pts = run.map(at);
      if (Math.hypot(pts.at(-1).x - pts[0].x, pts.at(-1).y - pts[0].y) < 4) continue; // hovering: no length to draw
      const across = pts.map((_, i) => {
        const a = pts[Math.max(i - 1, 0)];
        const b = pts[Math.min(i + 1, pts.length - 1)];
        const d = Math.hypot(b.x - a.x, b.y - a.y) || 1;
        return { x: (a.y - b.y) / d, y: (b.x - a.x) / d };
      });
      const half = run.map((q) => 1.5 + 5.5 * Math.min(1, (q.db - floor) / 25));
      const side = (sign) => pts.map((p, i) => ({ x: p.x + across[i].x * half[i] * sign, y: p.y + across[i].y * half[i] * sign }));
      const lead = run[0].t - real;
      const firm = lead <= 60 ? 1 : Math.max(0.4, 1 - (lead - 60) / 400);
      ctx.beginPath();
      [...side(1), ...side(-1).reverse()].forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.globalAlpha = (s === 'later' ? 0.5 : 0.8) * firm;
      ctx.fillStyle = colour;
      ctx.fill();
      ctx.globalAlpha = firm;
      const mark = (i) => line([-7, 7].map((k) => ({ x: pts[i].x + across[i].x * k, y: pts[i].y + across[i].y * k })), 2, colour);
      if (run[0].heardAt > real + 0.01) mark(0);
      mark(pts.length - 1);
    }
    ctx.globalAlpha = 1;

    // Sound is slow: what is heard right now was made back here.
    // shortcut: this is the predicted path run backwards, which is straight; a turning aircraft's real
    // track (the thin trail) can sit beside the ring. Keep timed positions in the trail if that matters.
    // Drawn on the eased line; whether it is heard now is the newest prediction's, at the real time.
    const source = sample(path, 'heardAt', t);
    if (s === 'hold' && heardNow(c.track.path, floor, real)) {
      const p = at(source);
      ctx.fillStyle = theme.panel;
      ctx.fill(circle(p.x, p.y, 4.5));
      ctx.lineWidth = 2;
      ctx.strokeStyle = colour;
      ctx.stroke(circle(p.x, p.y, 4.5));
      if (chosen && source.heading != null) beside('heard now', colour, p, source.heading, 13);
    }

    // The selected aircraft's path is ruled in minutes from now.
    for (let minute = 1; chosen && minute <= 5 && t + minute * 60 <= until; minute++) {
      const q = sample(path, 't', t + minute * 60);
      if (q.off || q.heading == null) break;
      const p = at(q);
      const across = beside(`${minute} min`, theme.accent, p, q.heading, 14);
      line([-5, 5].map((k) => ({ x: p.x + across.x * k, y: p.y + across.y * k })), 1.5, theme.accent);
    }
  }

  // The set. It shows the page's status the way the banner's lamp does, by colour and by shape: a
  // disc when clear, a triangle when an aircraft is coming, a square when one is audible.
  // It is the banner's own status, not one worked out here, so the two can never disagree (the banner
  // holds on for a few seconds when an aircraft drops out early).
  const worst = stale ? null : banner || null;
  const status = !worst ? theme['ink-2'] : worst === 'hold' ? theme.hold : worst === 'soon' ? theme.soon : theme.clear;
  ctx.fillStyle = theme.panel;
  ctx.fill(circle(centre.x, centre.y, 12.5));
  ctx.lineWidth = 2;
  ctx.strokeStyle = status;
  ctx.stroke(circle(centre.x, centre.y, 10.5));
  ctx.fillStyle = status;
  ctx.beginPath();
  if (worst === 'hold') ctx.rect(centre.x - 4.5, centre.y - 4.5, 9, 9);
  else if (worst === 'soon') [[0, -6], [5.5, 4], [-5.5, 4]].forEach(([x, y]) => ctx.lineTo(centre.x + x, centre.y + y));
  else if (worst) ctx.arc(centre.x, centre.y, 5, 0, 2 * Math.PI);
  ctx.fill(); // nothing inside the ring when the data is old
  text('Set', centre.x, centre.y + 13 + theme.em * 0.75, theme.ink, face(700, 0.87));

  // The aircraft that matter, each with a label: its name, and when it is heard.
  const tagFont = face(500, 1);
  const whenFont = face(700, 1, 'font-num');
  const gap = 17; // from an aircraft to its label
  const arrow = (x, y, toward, length, colour, rim) => {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(Math.atan2(toward.x - centre.x, centre.y - toward.y));
    ctx.beginPath();
    [[0, -length], [length * 0.85, length * 0.7], [-length * 0.85, length * 0.7]].forEach(([ax, ay]) => ctx.lineTo(ax, ay));
    ctx.closePath();
    ctx.lineJoin = 'round';
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = theme.panel;
    if (rim) ctx.stroke();
    ctx.fillStyle = colour;
    ctx.fill();
    ctx.restore();
  };
  const labels = [];
  for (const { c, p, m, s } of loud) {
    const e = edge(p, w, h, 11);
    // Lined up but not yet rolling, or lost by the feed: the time is a guess, so it says so.
    const guess = c.lost || c.track?.phase === 'lined up on' ? '~' : '';
    const when = s === 'hold' ? `${c.lost ? '~' : ''}${mmss(c.win.end - now)} left` : s ? `in ${guess}${mmss(c.win.start - now)}` : c.taxiing && !stale ? 'taxiing' : '';
    ctx.font = tagFont;
    const nameW = ctx.measureText(name(c)).width + (e.off ? 15 : 0);
    ctx.font = whenFont;
    const whenW = when ? ctx.measureText(when.replace(/\d/g, '0')).width + 7 : 0; // digits change; the box shouldn't
    const mark = { hex: c.hex, x: e.x, y: e.y, loud: true };
    marks.push(mark);
    // Beside the path, not on it; and on the side it had last time if that is still a good one.
    let order = labelSides(m.heading);
    order = [...order.slice(0, 3).filter((side) => side === sides.get(c.hex)), ...order];
    let from = e;
    if (e.off) {
      // Beyond the edge: the label sits against the edge in its direction, with an arrow in it, so it
      // can't be taken for the name of some aircraft that is on the map.
      const side = e.x >= w - 12 ? 1 : e.x <= 12 ? 0 : e.y <= 12 ? 3 : 2;
      from = { x: side === 1 ? w - 2 + gap : side === 0 ? 2 - gap : e.x, y: side === 3 ? 2 - gap : side === 2 ? h - 2 + gap : e.y };
      order = [side];
    }
    // Where there is no room for the time as well, the name alone still says which aircraft this is.
    labels.push({ hex: c.hex, x: from.x, y: from.y, w: Math.ceil(nameW + whenW + 14), narrow: when ? Math.ceil(nameW + 14) : 0, h: Math.round(theme.em * 1.6), must: c.hex === selected, order, c, p, m, s, e, when, mark });
  }
  labels.sort((a, b) => b.must - a.must || rank(a.s) - rank(b.s) || (a.c.win?.start ?? 0) - (b.c.win?.start ?? 0));
  const inFrame = (el) => {
    const a = el.getBoundingClientRect();
    const b = frame.getBoundingClientRect();
    return { x: a.x - b.x, y: a.y - b.y, w: a.width, h: a.height };
  };
  // Labels keep clear of the controls and words laid over the map, of the set, and of each other's aircraft.
  const taken = ['.map-wind', '.map-zoom', '.map-notice', '.map-caption', '.map-credit'].map((selector) => inFrame($(selector)));
  taken.push({ x: centre.x - 16, y: centre.y - 13, w: 32, h: 26 + theme.em * 1.5 });
  for (const l of labels) if (!l.e.off) taken.push({ x: l.e.x - 12, y: l.e.y - 12, w: 24, h: 24 });
  const boxes = place(labels, w, h, taken, gap);

  labels.reverse(); // the soonest, and the selected one, are drawn last and so on top
  for (const { c, p, m, s, e, hex } of labels) {
    const colour = stale ? theme['ink-2'] : s === 'hold' ? theme.hold : s === 'soon' ? theme.soon : theme.ink;
    const unsure = stale || c.lost; // drawn hollow and grey: this is not a reported position
    if (e.off) {
      if (!boxes.has(hex)) arrow(e.x, e.y, p, 7, colour, true); // no room for its label: the arrow alone
    } else if (c.ground) {
      ctx.fillStyle = theme.panel;
      ctx.fill(circle(e.x, e.y, 5));
      ctx.fillStyle = colour;
      ctx.fill(circle(e.x, e.y, 3.25));
    } else glyph(e, m.heading, c.ac.category, size, unsure ? theme['ink-2'] : colour, unsure);
    if (hex === selected && !(e.off && boxes.has(hex))) {
      ctx.lineWidth = 2;
      ctx.strokeStyle = theme.accent;
      ctx.stroke(circle(e.x, e.y, e.off ? 12 : (SHAPES[c.ac.category]?.[1] ?? 6) + 6));
    }
  }
  for (const l of labels) {
    const box = boxes.get(l.hex);
    if (!box) continue;
    if (!l.e.off) sides.set(l.hex, box.side);
    l.mark.box = box;
    // Filled like the status banner once it is the banner's business: coming within a minute, or audible.
    const lit = l.s === 'hold' || l.s === 'soon';
    const ink = lit ? theme[`on-fill-${l.s}`] : theme.ink;
    ctx.beginPath();
    ctx.roundRect(box.x, box.y, box.w, box.h, 3);
    ctx.fillStyle = lit ? theme[`fill-${l.s}`] : theme.panel;
    ctx.fill();
    ctx.lineWidth = l.must ? 2 : 1;
    ctx.strokeStyle = l.must ? theme.accent : lit ? theme[l.s] : theme['ink-2'];
    ctx.stroke();
    const arrowLeft = l.e.off && l.e.x < box.x + box.w / 2; // the arrow goes at the end nearer the edge
    if (l.e.off) arrow(arrowLeft ? box.x + 12 : box.x + box.w - 12, box.y + box.h / 2, l.p, 5, ink, false);
    ctx.textBaseline = 'middle';
    ctx.fillStyle = ink;
    ctx.font = tagFont;
    ctx.textAlign = 'left';
    ctx.fillText(name(l.c), box.x + 7 + (arrowLeft ? 15 : 0), box.y + box.h / 2 + 0.5);
    ctx.font = whenFont;
    ctx.textAlign = 'right';
    if (!box.short) ctx.fillText(l.when, box.x + box.w - 7 - (l.e.off && !arrowLeft ? 15 : 0), box.y + box.h / 2 + 0.5);
  }

  // The words beside paths, then the names of the rings, each only where nothing else is.
  for (let r = ring; r / mpp < h / 2 - 12; r += ring) notes.push({ string: `${r / 1000} km`, colour: theme['ink-2'], spots: [{ x: centre.x, y: centre.y - r / mpp, align: 'center' }] });
  const busy = [...taken, ...boxes.values()];
  ctx.font = small;
  for (const note of notes) {
    const width = ctx.measureText(note.string).width;
    const boxAt = (s) => ({ x: s.x - (s.align === 'left' ? 0 : s.align === 'right' ? width : width / 2), y: s.y - theme.em / 2, w: width, h: theme.em });
    const spot = note.spots.find((s) => !busy.some((box) => overlaps(box, boxAt(s))));
    if (!spot) continue;
    busy.push(boxAt(spot));
    text(note.string, spot.x, spot.y, note.colour, small, spot.align);
  }
}

// The words around the drawing: the notice, the selected aircraft's caption, and the text description.
function words() {
  const now = Date.now();
  const stale = last && isStale(now);
  frame.classList.toggle('map-empty', !last || last.dataAt === 0);
  frame.classList.toggle('map-stale', !!stale);
  put(
    $('.map-notice'),
    last?.dataAt === 0 ? 'No flight data for this location yet.' : !last
      ? performance.now() < 1500 // a saved address brings its first update almost at once: don't flash this
        ? ''
        : 'No flight data yet.'
      : stale
        ? `No flight data for ${mmss(now - (last.dataAt ?? last.at))}. Positions are old.`
        : craft.length
          ? ''
          : 'No aircraft in range.',
  );
  if (!last) return;

  const near = (m) => `${(Math.hypot(m.x, m.y) / 1000).toFixed(1)} km ${compass(m.x, m.y)}`; // on the map, where the set is plain to see
  const far = (m) => `${near(m)} of the set`; // read out
  const c = craft.find((x) => x.hex === selected);
  let caption = '';
  if (c) {
    const m = drawn.get(c.hex) ?? c.at;
    const s = stale ? null : state(c, now);
    // What the label on the map doesn't say. When it is heard, and for how long, is in the label and the list.
    const kind = c.ac.desc || c.ac.t || CLASS_NAME[c.ac.category];
    const feet = Math.round(m.alt / 0.3048 / 100) * 100;
    const where = c.ac.alt_baro === 'ground' || !(feet > 0) ? `On the ground, ${near(m)}` : `${near(m)}, ${feet.toLocaleString()} ft up`;
    const doing = c.track?.phase ? ` ${c.track.phase[0].toUpperCase()}${c.track.phase.slice(1)} runway ${c.track.runway}.` : '';
    const note = stale ? ' Old position.' : s ? '' : c.taxiing ? ' May take off.' : ' Not expected to be heard.';
    const lost = c.lost && !stale ? ` Estimate: contact lost ${mmss(now - c.track.seenAt)} ago.` : '';
    caption = `${name(c)}${kind ? `, ${kind}` : ''}. ${where[0].toUpperCase()}${where.slice(1)}.${doing}${note}${lost}`;
  }
  put($('.map-caption'), caption);

  const coming = craft
    .filter((x) => state(x, now))
    .sort((a, b) => a.win.start - b.win.start)
    .slice(0, 6)
    .map((x) => `${name(x)}, ${far(drawn.get(x.hex) ?? x.at)}, ${x.win.start <= now ? 'heard now' : `heard in ${mmss(x.win.start - now)}`}${x.lost ? ' (estimate: contact lost)' : ''}`);
  put(
    $('.map-says'),
    last.dataAt === 0 ? 'No flight data for this location yet.' : stale
      ? 'No flight data. The positions on the map are old.'
      : `North is up and the set is in the middle. The map reaches ${Math.round((Math.min(view.w, view.h) / 2) * view.mpp / 1000)} km in every direction. ` +
          `${craft.length} aircraft in range. ${coming.length ? `Predicted to be heard: ${coming.join('; ')}.` : 'None predicted to be heard.'}`,
  );
}

// The basemap: one <img> per tile, kept across redraws so the browser never fetches a tile twice.
const imgs = new Map(); // "z/x/y" -> <img>
function basemap() {
  if (!TILES || !last || !view.w) return;
  const lit = () => frame.classList.toggle('map-has-tiles', [...imgs.values()].some((img) => img.naturalWidth));
  const snap = (v) => `${Math.round(v * view.dpr) / view.dpr}px`; // whole device pixels, or the tiles show seams
  const wanted = new Set();
  // High-density screens get the next zoom's tiles at half size, which is four times as many: only
  // while that stays a modest ask of a free tile server. A large panel gets the standard, softer ones.
  const sharp = view.dpr >= 1.5 ? tiles(last.site, view.zoom, view.w, view.h, 1) : [];
  for (const tile of sharp.length && sharp.length <= 40 ? sharp : tiles(last.site, view.zoom, view.w, view.h)) {
    const key = `${tile.z}/${tile.x}/${tile.y}`;
    wanted.add(key);
    let img = imgs.get(key);
    if (!img) {
      img = Object.assign(new Image(), { alt: '', decoding: 'async', draggable: false, onload: lit });
      // The tile policy wants a Referer. This sends the page's origin and never its path.
      img.referrerPolicy = 'strict-origin';
      img.onerror = () => {
        img.remove(); // offline, or turned away: the map still reads without its basemap
        if (imgs.get(key) === img) imgs.delete(key); // a newer request for the same tile may have taken its place
      };
      img.src = TILES.url(tile.z, tile.x, tile.y);
      imgs.set(key, img);
      $('.map-tiles').append(img);
    }
    Object.assign(img.style, { left: snap(tile.left), top: snap(tile.top), width: `${tile.size}px`, height: `${tile.size}px` });
  }
  for (const [key, img] of imgs) {
    if (wanted.has(key)) continue;
    img.remove();
    imgs.delete(key);
  }
  lit();
}

// Fits the canvas and the basemap to whatever box the page gives the map.
function layout() {
  const w = frame.clientWidth;
  const h = frame.clientHeight;
  if (!w || !h) return;
  const dpr = devicePixelRatio || 1;
  const zoom = zoomFor(last?.site.lat ?? 0, w, h, REACH_M[last?.env] ?? REACH_M.outdoors) + step;
  view = { w, h, dpr, zoom, mpp: metresPerPixel(last?.site.lat ?? 0, zoom) };
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  zoomIn.disabled = step >= STEPS[1];
  zoomOut.disabled = step <= STEPS[0];
  basemap();
  draw();
}

function zoomBy(by) {
  step = Math.max(STEPS[0], Math.min(STEPS[1], step + by));
  try {
    localStorage.setItem('hfs-map', step);
  } catch {}
  layout();
  words();
}
zoomIn.addEventListener('click', () => zoomBy(1));
zoomOut.addEventListener('click', () => zoomBy(-1));

// shortcut: aircraft can't be picked on the map from the keyboard; the list on the page is the way to
// do that, and it sends the same hfs:select.
canvas.addEventListener('click', (e) => {
  const hex = hit(marks, e.offsetX, e.offsetY);
  if (hex || selected) send('hfs:select', { hex: hex === selected ? null : hex });
});
canvas.addEventListener('pointermove', (e) => {
  canvas.style.cursor = e.pointerType === 'mouse' && hit(marks, e.offsetX, e.offsetY) ? 'pointer' : '';
});

document.addEventListener('hfs:select', (e) => {
  selected = e.detail.hex;
  draw();
  words();
});

document.addEventListener('hfs:update', (e) => {
  const next = e.detail;
  const now = Date.now();
  const moved = !last || next.site.lat !== last.site.lat || next.site.lon !== last.site.lon;
  const refit = moved || !view.w || next.env !== last.env; // a new place, or walls that change how far matters
  if (moved) for (const map of [drawn, slip, reshape, trails, sides]) map.clear();
  const before = new Map(craft.map((c) => [c.hex, c.track]));
  const shift = last && (next.at - last.at) / 1000; // how far the paths' clock moved on
  last = next;
  showWind();

  const tracks = new Map(next.tracks.map((track) => [track.hex, track]));
  const wins = new Map(next.windows.map((win) => [win.hex, win]));
  const taxiing = new Set(next.taxiing.map((win) => win.hex));
  craft = next.aircraft
    .filter((ac) => located(ac)) // as predict() does: an older position is not where it is
    .map((ac) => {
      const track = tracks.get(ac.hex);
      const heading = ac.track ?? ac.true_heading;
      const feet = ac.alt_geom ?? ac.alt_baro;
      const at = { ...local(ac, next.site), alt: typeof feet === 'number' ? feet * 0.3048 - next.site.elevM : 0, heading: heading == null ? undefined : (heading * Math.PI) / 180 };
      return { hex: ac.hex, ac, track, win: wins.get(ac.hex), taxiing: taxiing.has(ac.hex), lost: !!track?.lost, ground: ac.alt_baro === 'ground' && !track, at };
    });
  // An aircraft the feed has dropped, carried on by the page: it has a track and no row. The track
  // has the row's name, type and size category, which is all that is read from `ac` for it.
  const rows = new Set(craft.map((c) => c.hex));
  for (const track of next.tracks) if (!rows.has(track.hex)) craft.push({ hex: track.hex, ac: track, track, win: wins.get(track.hex), lost: !!track.lost, at: sample(track.path, 't', 0) });

  for (const c of craft) {
    const p = c.track ? sample(c.track.path, 't', 0) : c.at;
    const was = drawn.get(c.hex);
    // A prediction is never quite where the next report puts the aircraft: slide to it, don't jump.
    // A big jump is a different aircraft position altogether (the replay looping), so that one cuts.
    if (was && !still.matches && Math.hypot(was.x - p.x, was.y - p.y) < CUT_M) slip.set(c.hex, { x: was.x - p.x, y: was.y - p.y, at: now });
    else slip.delete(c.hex);
    // Its path eases the same way, from the one drawn (which may itself have been easing still).
    const old = before.get(c.hex);
    const r = reshape.get(c.hex);
    if (slip.has(c.hex) && c.track && old) reshape.set(c.hex, { from: r?.ease && now - r.at < SLIP_MS ? r.ease(easeOut((now - r.at) / SLIP_MS)).map((q) => ({ ...q })) : old.path, shift, at: now, ease: null });
    else reshape.delete(c.hex);
    const trail = trails.get(c.hex) ?? [];
    if (!c.lost) {
      if (trail.length && Math.hypot(trail.at(-1).x - p.x, trail.at(-1).y - p.y) > 3000) trail.length = 0;
      trail.push({ x: p.x, y: p.y });
    }
    if (trail.length > 12) trail.shift();
    trails.set(c.hex, trail);
  }
  const here = new Set(craft.map((c) => c.hex));
  for (const map of [drawn, slip, reshape, trails, sides]) for (const hex of map.keys()) if (!here.has(hex)) map.delete(hex);

  readTheme();
  if (refit) layout();
  else draw();
  words();
  animate();
});

// About 15 frames a second while something on the map moves, and one redraw a second otherwise, for
// the countdowns; nothing at all while the page is hidden. With reduced motion nothing moves.
let frameId = 0;
let timer = 0;
let lastFrame = 0;
function animate() {
  if (frameId || document.hidden || !last) return;
  const now = Date.now();
  const eased = Math.max(-Infinity, ...[...slip.values()].map((s) => s.at));
  if (moving({ reduced: still.matches, fresh: !isStale(now), tracks: craft.filter((c) => c.track).length, eased, now, ms: SLIP_MS })) frameId = requestAnimationFrame(loop);
}
function loop(ts) {
  frameId = 0;
  if (ts - lastFrame >= 60) {
    lastFrame = ts;
    draw();
  }
  animate();
}
function run() {
  cancelAnimationFrame(frameId);
  frameId = 0;
  clearInterval(timer);
  if (document.hidden) return;
  timer = setInterval(() => {
    words();
    if (!frameId) draw();
    animate();
  }, 1000);
  draw();
  words();
  animate();
}
document.addEventListener('visibilitychange', run);
document.addEventListener('hfs:status', (e) => {
  banner = e.detail.state;
  draw();
});
still.addEventListener('change', () => {
  if (still.matches) for (const map of [slip, reshape]) map.clear(); // stop where the new prediction is, now
  run();
});
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  readTheme();
  draw();
});
document.fonts?.addEventListener('loadingdone', () => {
  readTheme();
  draw();
});
new ResizeObserver(layout).observe(frame);

readTheme();
run();
