// Pure geometry for the map (map.js): no DOM, so `node --test` can reach it. Screen units are CSS pixels,
// ground units are the metres east/north of the set that predict.js uses.

const RAD = Math.PI / 180;
const TILE = 256;

// Web Mercator: metres on the ground per pixel at this latitude and zoom.
export const metresPerPixel = (lat, zoom) => (156543.03392 * Math.cos(lat * RAD)) / 2 ** zoom;

// The zoom that shows at least `radiusM` in every direction from the centre of a w x h box.
export function zoomFor(lat, w, h, radiusM) {
  const zoom = Math.floor(Math.log2((156543.03392 * Math.cos(lat * RAD) * Math.min(w, h)) / 2 / radiusM));
  return Math.max(3, Math.min(15, zoom));
}

// The map tiles that cover a w x h box centred on the site, and where each one goes. `detail` 1 uses
// the next zoom's tiles at half size, for high-density screens.
export function tiles(site, zoom, w, h, detail = 0) {
  const z = zoom + detail;
  const size = TILE / 2 ** detail;
  const n = 2 ** z;
  const s = Math.sin(site.lat * RAD);
  const cx = ((site.lon + 180) / 360) * n; // the site, in tiles from the top-left of the world
  const cy = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n;
  const out = [];
  for (let y = Math.floor(cy - h / 2 / size); y <= Math.floor(cy + h / 2 / size); y++) {
    if (y < 0 || y >= n) continue; // past the poles
    for (let x = Math.floor(cx - w / 2 / size); x <= Math.floor(cx + w / 2 / size); x++) {
      out.push({ z, x: ((x % n) + n) % n, y, left: w / 2 + (x - cx) * size, top: h / 2 + (y - cy) * size, size });
    }
  }
  return out;
}

// Metres from the set to pixels in the box. North is up.
// shortcut: one scale for the whole view, so a point 55 km north of the set sits about 0.6% (under a
// pixel at that zoom) off the tiles at mid latitudes; project through lat/lon if sets get near the poles.
export const toScreen = (view, p) => ({ x: view.w / 2 + p.x / view.mpp, y: view.h / 2 - p.y / view.mpp });

// The point of a predicted path where `key` ('t' or 'heardAt') equals `v`, between its 2 s samples.
// Outside the path it is the nearest end with `off` set: an aircraft lined up on a runway waits at the
// first sample, and one that has landed stays at the last. `heading` is radians clockwise from north.
export function sample(path, key, v) {
  let i = 1;
  while (i < path.length - 1 && path[i][key] < v) i++;
  const a = path[i - 1];
  const b = path[i] ?? a;
  const span = b[key] - a[key];
  const raw = span > 0 ? (v - a[key]) / span : 0;
  const k = Math.min(1, Math.max(0, raw));
  const mix = (name) => a[name] + (b[name] - a[name]) * k;
  const moved = Math.hypot(b.x - a.x, b.y - a.y) > 1;
  return {
    t: mix('t'),
    heardAt: mix('heardAt'),
    x: mix('x'),
    y: mix('y'),
    alt: mix('alt'),
    dist: mix('dist'),
    db: mix('db'),
    heading: moved ? Math.atan2(b.x - a.x, b.y - a.y) : undefined,
    off: raw !== k,
  };
}

// A correction to an aircraft's position bigger than this is not one: the replay looped, or the feed
// mixed up two reports. Its new position and path are cut to, not eased into.
export const CUT_M = 1500;
// How far past an update the map may carry aircraft on, in seconds: until the data in it is too old to
// trust. `at` is when the update came, `dataAt` when its data was measured (earlier when the answer was
// kept a while), `staleMs` how long the page trusts data (from hfs:update).
export const trustLeftS = (at, dataAt, staleMs) => Math.max(0, (dataAt + staleMs - at) / 1000);
// How much of the way an easing has gone when `p` of its time has passed: quick to start, gentle to land.
export const easeOut = (p) => 1 - (1 - Math.min(1, Math.max(0, p))) ** 2;

// One drawn path easing into the next. `from` and `to` are points in order of `key`, with the same
// number fields. Each point of `to` starts where `from` was at the same `key` (its nearer end, beyond
// it), and each point of `from` past the end of `to` closes in on that end, so a path that got shorter
// draws in rather than being cut. Returns the path `k` of the way there (0 to 1), written into the
// same points on every call, so a frame allocates nothing; at 1 it is `to` itself. `close` gives, by
// field, a change too small to draw: when nothing `from` covers changes by more, it is `to` itself
// from the start, and a stretch that only runs on past the old end (the newer prediction reaching a
// few seconds further) appears with it.
export function morph(from, to, key, close = {}) {
  if (!from.length || !to.length) return () => to;
  const fields = Object.keys(to[0]).filter((f) => typeof to[0][f] === 'number');
  let i = 0;
  const at = (v) => {
    while (i < from.length - 1 && from[i + 1][key] <= v) i++;
    const a = from[i];
    const b = from[i + 1] ?? a;
    const k = b[key] > a[key] ? Math.min(1, Math.max(0, (v - a[key]) / (b[key] - a[key]))) : 0;
    return Object.fromEntries(fields.map((f) => [f, a[f] + (b[f] - a[f]) * k]));
  };
  const end = to.at(-1);
  const pairs = [...to.map((b) => [at(b[key]), b]), ...from.filter((a) => a[key] > end[key]).map((a) => [a, end])];
  const last = from.at(-1)[key];
  if (pairs.every(([a, b]) => b[key] > last || fields.every((f) => Math.abs(a[f] - b[f]) <= (close[f] ?? 0)))) return () => to; // nothing to ease
  const out = pairs.map(([, b]) => ({ ...b }));
  return (k) => {
    if (k >= 1) return to;
    for (let n = 0; n < pairs.length; n++) {
      const [a, b] = pairs[n];
      for (const f of fields) out[n][f] = a[f] + (b[f] - a[f]) * k;
    }
    return out;
  };
}

// The stretches of a path that are still to be heard at the set: at or above `floor`, and the sound
// not yet arrived `now` seconds after the update. Each is a list of points; the ends are placed where
// the level crosses the floor, not on the nearest sample.
export function heard(path, floor, now) {
  const first = sample(path, 'heardAt', now);
  const rest = [...(first.off ? [] : [first]), ...path.filter((p) => p.heardAt > now)];
  const runs = [];
  let run = null;
  for (let i = 0; i < rest.length; i++) {
    const p = rest[i];
    const q = rest[i - 1];
    const joined = q && p.t - q.t < 3; // a longer gap is an aircraft waiting or silent, not a line to draw
    const cross = () => {
      const k = (floor - q.db) / (p.db - q.db);
      return { ...p, x: q.x + (p.x - q.x) * k, y: q.y + (p.y - q.y) * k, t: q.t + (p.t - q.t) * k, db: floor };
    };
    if (p.db >= floor) {
      if (!run || !joined) runs.push((run = joined && q.db < floor ? [cross()] : []));
      run.push(p);
    } else if (run) {
      if (joined) run.push(cross());
      run = null;
    }
  }
  return runs.filter((r) => r.length > 1);
}

// heard() on `latest`, the newest prediction, drawn on `shown`, the path as drawn while it eases into
// `latest`. Which stretches are still to be heard, where they begin and end, and how loud each point is
// are the newest prediction's; each point only takes its place from `shown` at the same time `t`.
export function heardOn(latest, shown, floor, now) {
  const runs = heard(latest, floor, now);
  if (shown === latest) return runs;
  return runs.map((run) => run.map((q) => {
    const p = sample(shown, 't', q.t);
    return { ...q, x: p.x, y: p.y };
  }));
}

// Whether what is heard at the set `now` seconds after the update comes from this path at or above `floor`.
export function heardNow(path, floor, now) {
  const p = sample(path, 'heardAt', now);
  return !p.off && p.db >= floor;
}

// The map's two clocks, in seconds since the update, both stopped at `cap` once the data is too old to
// carry on. `real` decides what is heard and when; `draw` places things, and stands still with reduced
// motion, so aircraft step once per update while what is heard still keeps time.
export function clocks(age, reduced, cap) {
  const real = Math.min(age, cap);
  return { real, draw: reduced ? 0 : real };
}

// Whether the map needs animation frames: only while something on it moves. Aircraft move along their
// predicted paths (`tracks` of them) while the data is `fresh`, and a correction eases in for `ms`
// after `eased`, the time the latest one began. With reduced motion nothing moves.
export const moving = ({ reduced, fresh, tracks, eased, now, ms }) => !reduced && fresh && (tracks > 0 || now - eased < ms);

// Where to draw something that may be outside the box: itself, or the point on the box's inner edge
// that lies in its direction from the centre, with `off` set.
export function edge(p, w, h, inset) {
  const dx = p.x - w / 2;
  const dy = p.y - h / 2;
  const k = Math.min((w / 2 - inset) / Math.abs(dx), (h / 2 - inset) / Math.abs(dy));
  return k >= 1 ? { x: p.x, y: p.y, off: false } : { x: w / 2 + dx * k, y: h / 2 + dy * k, off: true };
}

// Whether two boxes ({ x, y, w, h }) share any area.
export const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

// Picks the aircraft under a click or tap: a label's box first, otherwise the nearest mark within
// `reach` pixels (22 gives a 44 px touch target). `marks` are { hex, x, y, box?, loud? }; a `loud` one
// (it will be heard) counts as 10 px nearer, so it isn't lost among the aircraft parked around it.
// shortcut: nearest wins, so one aircraft in a tight group (parked at a terminal) may need a closer zoom.
export function hit(marks, x, y, reach = 22) {
  const point = { x, y, w: 0, h: 0 };
  const labelled = marks.find((m) => m.box && overlaps(m.box, point));
  if (labelled) return labelled.hex;
  let best = null;
  let bestD = Infinity;
  for (const m of marks) {
    const d = Math.hypot(m.x - x, m.y - y);
    if (d <= reach && d - (m.loud ? 10 : 0) < bestD) [best, bestD] = [m.hex, d - (m.loud ? 10 : 0)];
  }
  return best;
}

// Gives each label a box beside its mark, on the first of its sides (0 right, 1 left, 2 above, 3 below,
// then the four corners) that stays inside the w x h box and clear of `taken` boxes and earlier labels.
// A label slides along the mark to stay in the box, so a mark at the edge keeps its label. `labels` are
// { hex, x, y, w, h, narrow, must, order } in priority order, `order` being the sides to try first,
// best first. One that fits nowhere is tried again at its `narrow` width (a shorter wording), which
// the box reports as `short`; if that fits nowhere either it is left out, unless it is a `must`.
// shortcut: first fit, nothing is moved to make room, so a crowded moment can leave a later aircraft
// without a label. It is still drawn, and still in the list on the page.
export function place(labels, w, h, taken = [], gap = 12) {
  const placed = new Map();
  const used = [...taken];
  const fits = (b) => b.x >= 2 && b.y >= 2 && b.x + b.w <= w - 2 && b.y + b.h <= h - 2 && !used.some((u) => overlaps(u, b));
  for (const l of labels) {
    let box;
    for (const width of l.narrow ? [l.w, l.narrow] : [l.w]) {
      const across = Math.max(2, Math.min(w - 2 - width, l.x - width / 2));
      const down = Math.max(2, Math.min(h - 2 - l.h, l.y - l.h / 2));
      const near = gap * 0.75; // a corner sits a little closer in, but still clear of the mark itself
      const sides = [
        { x: l.x + gap, y: down },
        { x: l.x - gap - width, y: down },
        { x: across, y: l.y - gap - l.h },
        { x: across, y: l.y + gap },
        { x: l.x + near, y: l.y - near - l.h },
        { x: l.x - near - width, y: l.y - near - l.h },
        { x: l.x + near, y: l.y + near },
        { x: l.x - near - width, y: l.y + near },
      ].map((s, side) => ({ ...s, w: width, h: l.h, side, short: width !== l.w }));
      const order = [...(l.order ?? []).map((side) => sides[side]), ...sides];
      // Nothing is clear for a label that must show: keep its first choice on screen and let it overlap.
      box ??= l.must ? { ...order[0], x: Math.max(2, Math.min(w - 2 - width, order[0].x)), y: Math.max(2, Math.min(h - 2 - l.h, order[0].y)), forced: true } : undefined;
      const clear = order.find(fits);
      if (clear) {
        box = clear;
        break;
      }
    }
    if (!box) continue;
    used.push(box);
    placed.set(l.hex, box);
  }
  return placed;
}

// Distance between range rings, in metres: a round number that puts two or three rings in view.
export const ringStep = (radiusM) => [500, 1000, 2000, 3000, 5000, 10000, 15000, 20000, 30000, 50000, 100000].find((s) => radiusM / s < 4) ?? 200000;

// The sides to try for an aircraft's label, best first: beside its path, then behind it, and only then
// ahead, where the label would cover where it is going. `heading` is radians clockwise from north.
export function labelSides(heading) {
  if (heading == null) return [0, 1, 2, 3];
  const east = Math.sin(heading);
  const north = Math.cos(heading);
  return Math.abs(east) > Math.abs(north) ? [2, 3, ...(east > 0 ? [1, 0] : [0, 1])] : [0, 1, ...(north > 0 ? [3, 2] : [2, 3])];
}

const POINTS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
// Compass word for a direction given as metres east and north.
export const compass = (x, y) => POINTS[((Math.round(Math.atan2(x, y) / RAD / 45) % 8) + 8) % 8];
