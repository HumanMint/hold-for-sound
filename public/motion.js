// How each aircraft has been moving lately, from its last few reports: how much it has been turning,
// whether it is going anywhere at all, whether it is speeding up, and which way it has been moving.
// Pure, shared by the page and the tests. predict.js uses it for helicopters, and on the ground for an
// aircraft starting its takeoff roll and for which way an aircraft is pointing.

import { local } from './predict.js';

const KT = 0.5144;
const RAD = Math.PI / 180;

export const KEEP_S = 90; // reports this much older than an aircraft's newest are forgotten
export const MAX_REPORTS = 30; // and never more than this many
const GONE_S = 300; // an aircraft with no report for this long is forgotten (lost.js gives up well before)
// shortcut: GAINING_S, WAY_S and WAY_M are uncalibrated guesses.
const GAINING_S = 15; // `gaining` compares the newest speed with one at most this much older
const WAY_S = 10; // `way` is how it has moved over at most this long
const WAY_M = 25; // and only once that is this far: closer, where a position is reported is too rough

const wrap = (deg) => ((((deg + 180) % 360) + 360) % 360) - 180; // -180 to 180: 359 -> 1 is a turn of 2

// One poll. `history` is a Map the caller keeps between polls: hex -> reports, oldest first, each
// { t, lat, lon, gs, track } with `t` the epoch ms of the position, and `ground: true` on a report
// made on the ground. `rows` are the feed's, with the feed's own delay already in `seen_pos`. A
// position the feed repeats is not added again, but a new speed with it is kept on the report as
// `later: { t, gs }`, `t` being the poll's time: the feed says nothing of how old a speed is.
export function remember(history, rows, now) {
  for (const ac of rows) {
    if (ac.lat == null || ac.lon == null) continue;
    const t = now - (ac.seen_pos ?? 0) * 1000;
    let list = history.get(ac.hex) ?? [];
    const last = list.at(-1);
    if (last && t - last.t < 1000) {
      if (ac.gs != null && ac.gs !== (last.later ?? last).gs) last.later = { t: now, gs: ac.gs };
      continue;
    }
    const reach = last && 1000 + 2 * Math.max(ac.gs ?? 0, last.gs ?? 0, 100) * KT * ((t - last.t) / 1000); // m: twice its speed, and 1 km
    if (last && Math.hypot(...Object.values(local(ac, last))) > reach) list = [];
    list.push({ t, lat: ac.lat, lon: ac.lon, gs: ac.gs, track: ac.track, ...(ac.alt_baro === 'ground' && { ground: true }) });
    while (list.length > MAX_REPORTS || t - list[0].t > KEEP_S * 1000) list.shift();
    history.set(ac.hex, list);
  }
  for (const [hex, list] of history) if (now - list.at(-1).t > GONE_S * 1000) history.delete(hex);
}

// What an aircraft's reports say about how it has been moving, as of its newest one, or null for none:
//   gaining   the newest speed it reported is faster than the one before, reported at most 15 s
//             earlier: a slower one since, even with no new position, ends it
//   way       deg, the way it has moved over the last 10 s, when that is 25 m or more (else absent)
// and, from its reports in the air only (none of these when it has none):
//   wander    deg/s its track has turned on average, either way; null with under 20 s of reports
//   drift     { x, y } its average velocity, m/s east and north
//   hovering  under 15 kt now
//   slow      under 15 kt in every report
//   circling  over 45 s or more it has got less than half as far as it has flown, and it is still
//             turning: 20 degrees or more in its last 10 s
//   area      its reports' positions, { lat, lon }
// shortcut: 15 kt, one half and 20 degrees are judged from two recordings, which have no hovering.
export function motion(list) {
  if (!list?.length) return null;
  const speeds = list.slice(-2).flatMap((r) => [{ t: r.t, gs: r.gs }, ...(r.later ? [r.later] : [])]);
  const [before, newest] = speeds.slice(-2);
  const gaining = !!newest && newest.t - before.t <= GAINING_S * 1000 && newest.gs > before.gs;
  const last = list.at(-1);
  const from = list.find((r) => last.t - r.t <= WAY_S * 1000);
  const moved = local(from, last); // where it was, seen from where it is
  const way = Math.hypot(moved.x, moved.y) >= WAY_M ? (Math.atan2(-moved.x, -moved.y) / RAD + 360) % 360 : null;
  const ground = { gaining, ...(way != null && { way }) };
  const air = list.filter((r) => !r.ground);
  return air.length ? { ...flight(air), ...ground } : ground;
}

function flight(list) {
  const last = list.at(-1);
  const span = (last.t - list[0].t) / 1000;
  let turned = 0;
  let lately = 0; // degrees turned in the last 10 s
  let flown = 0;
  for (let i = 1; i < list.length; i++) {
    if (list[i].track != null && list[i - 1].track != null) {
      const turn = Math.abs(wrap(list[i].track - list[i - 1].track));
      turned += turn;
      if (last.t - list[i - 1].t <= 10_000) lately += turn;
    }
    flown += Math.hypot(...Object.values(local(list[i], list[i - 1])));
  }
  const from = local(list[0], last); // where it was, seen from where it is
  return {
    wander: span >= 20 ? turned / span : null,
    drift: span > 0 ? { x: -from.x / span, y: -from.y / span } : { x: 0, y: 0 },
    hovering: last.gs < 15,
    slow: list.every((r) => r.gs < 15),
    circling: span >= 45 && Math.hypot(from.x, from.y) < flown / 2 && lately >= 20,
    area: list.map(({ lat, lon }) => ({ lat, lon })),
  };
}
