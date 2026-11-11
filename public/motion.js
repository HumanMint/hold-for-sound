// How each aircraft has been moving lately, from its last few reports: how much it has been turning,
// and whether it is going anywhere at all. Pure, shared by the page and the tests. predict.js uses it
// for helicopters.

import { local } from './predict.js';

const KT = 0.5144;

export const KEEP_S = 90; // reports this much older than an aircraft's newest are forgotten
export const MAX_REPORTS = 30; // and never more than this many
const GONE_S = 300; // an aircraft with no report for this long is forgotten (lost.js gives up well before)

const wrap = (deg) => ((((deg + 180) % 360) + 360) % 360) - 180; // -180 to 180: 359 -> 1 is a turn of 2

// One poll. `history` is a Map the caller keeps between polls: hex -> reports, oldest first, each
// { t, lat, lon, gs, track } with `t` the epoch ms of the position. `rows` are the feed's, with the
// feed's own delay already in `seen_pos`. A position the feed repeats is not added again.
export function remember(history, rows, now) {
  for (const ac of rows) {
    if (ac.lat == null || ac.lon == null || ac.alt_baro === 'ground') continue;
    const t = now - (ac.seen_pos ?? 0) * 1000;
    let list = history.get(ac.hex) ?? [];
    const last = list.at(-1);
    if (last && t - last.t < 1000) continue;
    const reach = last && 1000 + 2 * Math.max(ac.gs ?? 0, last.gs ?? 0, 100) * KT * ((t - last.t) / 1000); // m: twice its speed, and 1 km
    if (last && Math.hypot(...Object.values(local(ac, last))) > reach) list = [];
    list.push({ t, lat: ac.lat, lon: ac.lon, gs: ac.gs, track: ac.track });
    while (list.length > MAX_REPORTS || t - list[0].t > KEEP_S * 1000) list.shift();
    history.set(ac.hex, list);
  }
  for (const [hex, list] of history) if (now - list.at(-1).t > GONE_S * 1000) history.delete(hex);
}

// What an aircraft's reports say about how it has been moving, as of its newest one, or null for none:
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
