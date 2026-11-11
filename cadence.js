// How long a public instance keeps one place's flight answer before it asks adsb.lol again: 10 s while
// anything in the last answer may matter soon, a minute while the sky is quiet, or 30 s while it is quiet
// beside a runway. The server decides from what adsb.lol last said, so no page can ask for faster
// updates and spend the day's budget.
//
// Beside a runway an aircraft the feed has not seen on the ground can start its takeoff roll and be heard
// 6 to 15 s later, between two answers: a quiet answer there is kept for half as long, and trusted for
// half as long (staleAfter() in status.js), so the page stops calling it clear sooner after such a
// takeoff. The server's runway table (server.js) says which places are beside one; while it has not
// loaded, every place is.
// Pure, covered by test/cadence.test.js.
//
// A quiet answer is one in which no aircraft could come within SLANT_KM of the place in the time the
// page goes on trusting it (staleAfter() in status.js), whichever way it turned, nor on its present
// heading in the next 15 minutes, and in which nothing has taxied near the place lately. This does not
// look at where the runways are: an aircraft on the ground nearby counts as taxiing when it
// moves, and when it was not in the last answer: one first seen held short or lined up, or one the
// feed had not seen on the ground until now. One that stays put (parked for the night) stops counting.
// shortcut: every number here is an uncalibrated guess, checked only against a few hours of shared
// sessions beside one airport (none overnight), in which no window or takeoff the page warned of within
// 90 s came while it was quiet. RUNWAY_KM is a plain distance, not worked out from predict.js's loudness.
import { staleAfter } from './public/status.js';

export const FAST_S = 10;
export const SLOW_S = 60;
export const RUNWAY_S = 30; // the quiet cadence within RUNWAY_KM of a runway
const RUNWAY_KM = 5; // a takeoff from a runway this close is heard within seconds of starting its roll
const SLANT_KM = 10; // predict.js has a heavy jet audible outdoors to about 6 km at the default level, further below it
const AHEAD_S = 900; // "audible within about 15 minutes", on its present heading
const ELEV_KM = 1; // the place's own height, and a descent meanwhile, are not known: allowed for
const GROUND_KM = 8; // taxiing this close: it may take off from a runway beside the place
const TAXI_KT = 3; // slower than this on the ground is stopped
export const TAXIED_S = 600; // after a taxi, so an aircraft held short or lined up and stopped still counts

const RAD = Math.PI / 180;

// How far `place` is from the nearest runway in `runways` (as runwaysNear() gives them), in km.
function runwayKm(place, runways, kx, ky) {
  let best = Infinity;
  for (const { ends: [a, b] } of runways) {
    const [ax, ay, bx, by] = [(a.lon - place.lon) * kx, (a.lat - place.lat) * ky, (b.lon - place.lon) * kx, (b.lat - place.lat) * ky];
    const len2 = (bx - ax) ** 2 + (by - ay) ** 2;
    const t = len2 ? Math.min(1, Math.max(0, -(ax * (bx - ax) + ay * (by - ay)) / len2)) : 0;
    best = Math.min(best, Math.hypot(ax + t * (bx - ax), ay + t * (by - ay)));
  }
  return best;
}

// `ac` is the feed's rows, `place` { lat, lon }, `now` epoch ms, `was` what this returned for the place
// last time (nothing at first), and `runways` the runways near it, or null when they are not known.
// Returns { every, taxiedAt, ground }: seconds to keep this answer, when an aircraft last taxied near
// the place, and the hex of each aircraft on the ground near it.
export function cadence(ac, place, now, was = {}, runways = null) {
  let taxiedAt = was.taxiedAt ?? 0;
  const ground = [];
  const kx = 6371 * RAD * Math.cos(place.lat * RAD);
  const ky = 6371 * RAD;
  const slow = !runways || runwayKm(place, runways, kx, ky) < RUNWAY_KM ? RUNWAY_S : SLOW_S;
  const REACH_S = staleAfter(slow) / 1000; // how long the page trusts a quiet answer
  let soon = false;
  for (const a of ac) {
    if (a.lat == null || a.lon == null) continue; // the page cannot place it either
    const x = (a.lon - place.lon) * kx;
    const y = (a.lat - place.lat) * ky;
    const d = Math.hypot(x, y);
    if (a.alt_baro === 'ground') {
      if (d >= GROUND_KM) continue;
      ground.push(a.hex);
      if (a.gs >= TAXI_KT || !was.ground?.includes(a.hex)) taxiedAt = now;
      continue;
    }
    const ft = a.alt_geom ?? a.alt_baro;
    const h = typeof ft === 'number' ? Math.max(0, ft * 0.0003048 - ELEV_KM) : 0;
    const v = (a.gs ?? 0) * 0.0005144; // km/s
    // Any heading: as close as it could get before the page stops trusting this answer.
    if (Math.hypot(Math.max(0, d - v * REACH_S), h) < SLANT_KM) soon = true;
    // Its present heading: the closest it comes in the next 15 minutes.
    else if (v > 0 && a.track != null) {
      const vx = v * Math.sin(a.track * RAD);
      const vy = v * Math.cos(a.track * RAD);
      const t = Math.min(AHEAD_S, Math.max(0, -(x * vx + y * vy) / (v * v)));
      if (Math.hypot(x + vx * t, y + vy * t, h) < SLANT_KM) soon = true;
    }
  }
  return { every: soon || now - taxiedAt < TAXIED_S * 1000 ? FAST_S : slow, taxiedAt, ground };
}
