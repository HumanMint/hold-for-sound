// Pure prediction math, shared by the browser and `node --test`.
// shortcut: every acoustic number here is an uncalibrated guess; replace with per-type noise data
// (e.g. FAA AEDT noise-power-distance curves) once this has been compared against real sets.

const FT = 0.3048;
const KT = 0.5144;
const SOUND_MS = 343;
const RAD = Math.PI / 180;

export const HORIZON_S = 480;
export const MAX_AGE_S = 60; // a position older than this is too old to extrapolate from
// Whether a feed row says where the aircraft is: it has a position, and one no older than `maxAge` seconds.
export const located = (ac, maxAge = MAX_AGE_S) => ac.lat != null && ac.lon != null && !(ac.seen_pos > maxAge);

// Loudest level (dBA) heard 1000 ft from the aircraft, keyed by the size category its transponder reports.
const SOURCE_DBA = { A1: 68, A2: 76, A3: 80, A4: 82, A5: 86, A6: 98, A7: 78 };
export const CLASS_NAME = {
  A1: 'light aircraft',
  A2: 'small jet or turboprop',
  A3: 'large jet',
  A4: 'large jet',
  A5: 'heavy jet',
  A6: 'military jet',
  A7: 'helicopter',
};

// loss: dB the building takes off. floor: default level the set is quiet enough to notice.
export const ENVIRONMENTS = {
  outdoors: { loss: 0, floor: 45 },
  indoors: { loss: 25, floor: 35 },
  stage: { loss: 45, floor: 25 },
};

// Typical takeoff: acceleration (m/s²), liftoff speed and climb speed (m/s), climb rate (m/s).
// shortcut: three coarse profiles by size; use per-type performance if takeoff timing proves too loose.
const TAKEOFF = { A1: [1.5, 31, 41, 3.5], A2: [2.2, 59, 87, 12.7] };
const TAKEOFF_JET = [2, 77, 93, 12.7];
const LINE_UP_S = 20; // an aircraft lined up but not moving is guessed to start its roll this much later

// Metres east/north of the site. Flat earth is fine at this range.
export const local = (p, site) => ({
  x: (p.lon - site.lon) * RAD * 6371000 * Math.cos(site.lat * RAD),
  y: (p.lat - site.lat) * RAD * 6371000,
});

// Where `pos` sits on each runway, seen from both ends: metres along it and metres off its centreline.
const lanes = (pos, site, runways) =>
  runways.flatMap((rw) =>
    [0, 1].map((i) => {
      const a = local(rw.ends[i], site);
      const b = local(rw.ends[1 - i], site);
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      const ux = (b.x - a.x) / len;
      const uy = (b.y - a.y) / len;
      return {
        airport: rw.airport,
        runway: rw.ends[i].id,
        opposite: rw.ends[1 - i].id,
        up: (rw.elevM ?? site.elevM) - site.elevM, // runway height above the site
        len,
        ux,
        uy,
        along: (pos.x - a.x) * ux + (pos.y - a.y) * uy,
        cross: Math.abs((pos.x - a.x) * uy - (pos.y - a.y) * ux),
        // 1 = pointing straight down the runway, -1 = straight back up it
        facing: (deg) => Math.sin(deg * RAD) * ux + Math.cos(deg * RAD) * uy,
      };
    }),
  );

// Each path gives the aircraft's position `age` seconds after its last report, or null once it is silent.

// Default: it keeps doing what it is doing.
function straight(ac, pos, alt0, vz, site) {
  const speed = (ac.gs ?? 0) * KT;
  const track = (ac.track ?? 0) * RAD;
  const selected = ac.nav_altitude_mcp == null ? null : ac.nav_altitude_mcp * FT - site.elevM;
  const toSelected = selected != null && (selected - alt0) * vz > 0; // only trust it if the aircraft is going that way
  const boost = ac.category === 'A7' ? 0 : vz > 2.5 ? 4 : vz < -2.5 ? -4 : 0; // climbing is high power, descending near idle
  return {
    at: (age) => {
      // Climb or descend to the selected altitude when broadcast, otherwise level off after 2 min.
      let alt = alt0 + vz * (toSelected ? age : Math.min(age, 120));
      if (toSelected) alt = vz > 0 ? Math.min(alt, selected) : Math.max(alt, selected);
      return { x: pos.x + speed * Math.sin(track) * age, y: pos.y + speed * Math.cos(track) * age, alt: Math.max(alt, 100), boost };
    },
  };
}

// A helicopter can turn or stop at any moment, so its straight line is only a guess. `m` is how it has
// been moving lately (motion.js), or null for none known.
// - Hovering: it stays where it is, or drifts on the way it has been if it has been flying slowly and
//   straight. Circling: it goes to the place it has been in lately that is nearest the site. Neither
//   follows how it flew before it slowed or turned.
// - Otherwise it flies straight on, but its heading grows less sure: none at first, then over SPREAD_S
//   out to a spread set by how much it has turned in the last minute. The line is turned about where
//   it is now through nine equally likely headings within that spread, and `ground` is the distance
//   from the site that at least half of them get as close as: the loudness at least half would give.
//   `spread` (radians) is how far the heading may have turned by then. With under 20 s of reports
//   there is nothing to spread it by: it stays on its heading, as unsure as a typical one.
// Following its present turn, and its change of speed, were tried: on the recordings they raised
// more false alarms than they removed.
// shortcut: the spread is fitted to 10 helicopters in two short recordings: the
// heading they actually went 30 to 120 s on, against how much they had turned. Fit it again on more.
const SPREAD_S = 30;
const FAN = [-1.59, -0.97, -0.59, -0.28, 0, 0.28, 0.59, 0.97, 1.59]; // nine equally likely headings, in spreads
const ROUGH_DEG = 10; // a window that starts where a helicopter's heading is less sure than this is rough
function helicopter(ac, pos, alt0, vz, site, m) {
  const line = straight(ac, pos, alt0, vz, site);
  if (!m) return line;
  if (m.hovering || m.circling) {
    const drift = m.slow && !m.circling ? m.drift : { x: 0, y: 0 };
    const to = m.hovering ? pos : m.area.map((p) => local(p, site)).sort((a, b) => Math.hypot(a.x, a.y) - Math.hypot(b.x, b.y))[0];
    return {
      at: (age) => {
        const k = Math.min(1, Math.max(0, age) / 20); // from where it is to where it is going, over 20 s
        return { ...line.at(age), x: pos.x + (to.x - pos.x) * k + drift.x * age, y: pos.y + (to.y - pos.y) * k + drift.y * age };
      },
    };
  }
  const widest = Math.min(90, 4 + 22 * (m.wander ?? 1)) * RAD; // wander not known yet: a typical 1 deg/s
  return {
    at: (age) => {
      const p = line.at(age);
      const spread = widest * Math.min(1, Math.max(0, age) / SPREAD_S);
      if (m.wander == null) return { ...p, spread };
      const dx = p.x - pos.x;
      const dy = p.y - pos.y;
      const ground = FAN.map((z) => {
        const a = z * spread;
        return Math.hypot(pos.x + dx * Math.cos(a) + dy * Math.sin(a), pos.y - dx * Math.sin(a) + dy * Math.cos(a));
      }).sort((a, b) => a - b)[4];
      return { ...p, ground, spread };
    },
  };
}

// On final approach to a known runway: it follows the centreline down and goes quiet at touchdown,
// instead of "flying" straight on past the airport.
// shortcut: silent after touchdown; reverse thrust can be heard close to a runway and isn't modelled.
function landing(ac, pos, alt0, vz, site, runways) {
  const speed = (ac.gs ?? 0) * KT;
  const lane = lanes(pos, site, runways)
    .filter(
      (l) =>
        l.along > -20000 &&
        l.along < 300 &&
        l.cross < 150 + 0.035 * Math.max(0, -l.along) && // within about 2° of the centreline
        alt0 - l.up < 150 + 0.105 * Math.max(0, -l.along) && // below a 6° path to the threshold
        ac.track != null &&
        l.facing(ac.track) > 0.96 &&
        vz < -0.5 &&
        speed > 20 &&
        speed < 115,
    )
    .sort((a, b) => a.cross - b.cross)[0]; // parallel runways: the one it is lined up with
  if (!lane) return null;
  const toGo = 300 - lane.along; // touchdown is about 300 m past the threshold
  return {
    ...lane,
    phase: 'landing on',
    at: (age) => {
      const gone = speed * age;
      if (gone >= toGo) return null;
      return { x: pos.x + lane.ux * gone, y: pos.y + lane.uy * gone, alt: lane.up + (alt0 - lane.up) * (1 - gone / toGo), boost: -4 };
    },
  };
}

// On a runway: it accelerates down the runway, lifts off, and climbs straight out. `alt0` is given for
// aircraft that report themselves as flying, which only count if they are at runway level.
// shortcut: an aircraft taxiing back along the runway looks lined up; needs taxiway data to tell apart.
function takeoff(ac, pos, site, runways, alt0) {
  const speed = (ac.gs ?? 0) * KT;
  const rolling = speed > 15;
  const heading = ac.track ?? ac.true_heading;
  const lane = lanes(pos, site, runways).find(
    (l) =>
      l.cross < 40 &&
      l.along > -50 &&
      l.along < l.len &&
      !(alt0 - l.up > 60) &&
      (rolling
        ? heading != null && l.facing(heading) > 0.94
        : l.along < l.len / 2 && (heading == null || Math.abs(l.facing(heading)) > 0.94)), // stopped or slow: it will use the long way
  );
  if (!lane) return null;
  const [accel, liftoff, climbSpeed, climbRate] = TAKEOFF[ac.category] ?? TAKEOFF_JET;
  const v0 = rolling ? speed : 0;
  const start = rolling ? 0 : LINE_UP_S + (ac.seen_pos ?? 0);
  const tClimb = Math.max(0, (climbSpeed - v0) / accel);
  const tLiftoff = Math.max(0, (liftoff - v0) / accel);
  return {
    ...lane,
    phase: rolling ? 'taking off from' : 'lined up on',
    at: (age) => {
      if (!rolling && age < start) return null; // idling on the runway
      const t = Math.max(0, age - start);
      const gone = t < tClimb ? v0 * t + (accel * t * t) / 2 : v0 * tClimb + (accel * tClimb * tClimb) / 2 + climbSpeed * (t - tClimb);
      return { x: pos.x + lane.ux * gone, y: pos.y + lane.uy * gone, alt: lane.up + climbRate * Math.max(0, t - tLiftoff), boost: 6 };
    },
  };
}

// Returns the first stretch of time this aircraft is predicted to be louder than `floor` at the site,
// or null. Times are seconds from now (negative startS = already audible) and include how long the
// sound takes to arrive. `runways` near the site let it recognise takeoffs and landings; `landed`
// marks an aircraft that was on final approach a few minutes ago, so on a runway it is slowing down,
// not about to depart. `trim` adds dB to a size category's source level, e.g. { A3: -4 }. `maxAge` is
// how old a position may be: lost.js raises it to carry on an aircraft the feed has stopped reporting.
// `motion` is how a helicopter has been moving (motion.js). Its window has `rough: true` when it starts
// where the helicopter's heading is too unsure to stand behind.
//
// The result also carries `path`: the whole predicted flight, audible or not, as one sample every 2 s:
// { t, heardAt, x, y, alt, dist, db }. `t` is when the aircraft is there and `heardAt` when that sound
// reaches the site (both seconds from now), x/y are metres east/north of the site, alt is metres above
// it, dist is the straight-line distance, db the predicted level. A helicopter's x/y are its straight
// line, and its dist and db are what at least half its likely headings give. Pass floor: -Infinity to
// get the path of an aircraft that is never audible.
export function predict(ac, site, { loss, floor, runways = [], landed = false, trim = {}, maxAge = MAX_AGE_S, motion = null }) {
  if (!located(ac, maxAge)) return null; // no position, or too old to extrapolate
  const pos = local(ac, site);
  let path;
  if (ac.alt_baro === 'ground') {
    path = !landed && takeoff(ac, pos, site, runways);
  } else {
    const altFt = ac.alt_geom ?? ac.alt_baro;
    if (typeof altFt !== 'number') return null;
    const alt0 = altFt * FT - site.elevM;
    const vz = ((ac.baro_rate ?? ac.geom_rate ?? 0) * FT) / 60;
    const final = landing(ac, pos, alt0, vz, site, runways);
    // Many aircraft keep reporting "flying" on the runway: at runway level and not climbing means rolling.
    const rolling = !final && vz < 1.5 && takeoff(ac, pos, site, runways, alt0);
    path = rolling ? !landed && rolling : final ?? (ac.category === 'A7' ? helicopter(ac, pos, alt0, vz, site, motion) : straight(ac, pos, alt0, vz, site));
  }
  if (!path) return null;

  const heli = ac.category === 'A7';
  const source = (SOURCE_DBA[ac.category] ?? 76) + (trim[ac.category] ?? 0);
  const wall = heli ? loss * 0.8 : loss; // rotor thump gets through walls better

  const samples = [];
  let win = null;
  let done = false; // the first audible stretch has ended; later ones are left for a later poll
  // Start in the past: sound arriving now left the aircraft several seconds ago, and it may already be audible.
  for (let t = -30; t <= HORIZON_S; t += 2) {
    const p = path.at(t + (ac.seen_pos ?? 0));
    let db = -Infinity;
    let heardAt = t;
    if (p) {
      const ground = p.ground ?? Math.hypot(p.x, p.y);
      const dist = Math.max(Math.hypot(ground, p.alt), 30);
      const km = dist / 1000;
      heardAt = t + dist / SOUND_MS;
      db =
        source +
        p.boost -
        20 * Math.log10(dist / 305) - // spreading, relative to the 1000 ft reference
        (3.5 * Math.min(km, 3) + Math.max(km - 3, 0)) - // air absorption
        8 * Math.max(0, 1 - Math.atan2(p.alt, ground) / RAD / 30) - // ground and buildings shield aircraft near the horizon
        wall;
      samples.push({ t, heardAt, x: p.x, y: p.y, alt: p.alt, dist, db });
      if (db >= floor && !done) {
        win ??= { startS: heardAt, peakDb: -Infinity, ...(p.spread > ROUGH_DEG * RAD && { rough: true }) };
        win.endS = heardAt;
        if (db > win.peakDb) Object.assign(win, { peakDb: db, peakDistM: dist, peakAltFt: p.alt / FT });
      }
    }
    if (db < floor && win && !done) {
      if (win.endS >= 0) done = true;
      else win = null; // that pass was over before now
    }
  }

  return (
    win && {
      hex: ac.hex,
      flight: ac.flight?.trim(),
      t: ac.t,
      desc: ac.desc,
      category: ac.category,
      phase: path.phase,
      airport: path.airport,
      runway: path.runway,
      opposite: path.opposite,
      margin: win.peakDb - floor,
      ...win,
      path: samples,
    }
  );
}

// For an aircraft still taxiing: the loudest it would be if it took off, or null. It is assumed to use
// the runway end it is about to enter, else a direction seen in use (`inUse` holds "AIRPORT RUNWAY"),
// else any runway at its airport.
export function ifDeparts(ac, site, opts, inUse = new Set()) {
  if (ac.alt_baro !== 'ground' || !(ac.gs >= 5) || ac.lat == null) return null;
  const ends = (opts.runways ?? [])
    .flatMap((rw) =>
      rw.ends.map((end, i) => ({
        ...end,
        key: `${rw.airport} ${end.id}`,
        opposite: `${rw.airport} ${rw.ends[1 - i].id}`,
        away: Math.hypot(...Object.values(local(end, ac))),
      })),
    )
    .sort((a, b) => a.away - b.away);
  if (!(ends[0]?.away < 5000)) return null; // not at an airport we have runways for
  const here = ends.filter((e) => e.key.split(' ')[0] === ends[0].key.split(' ')[0]);
  const used = here.filter((e) => inUse.has(e.key));
  const likely = ends[0].away < 500 && !inUse.has(ends[0].opposite) ? [ends[0]] : used.length ? used : here;
  return (
    likely
      .map((end) => predict({ ...ac, lat: end.lat, lon: end.lon, gs: 0, track: undefined, true_heading: undefined, seen_pos: 0 }, site, opts))
      .filter(Boolean)
      .sort((a, b) => b.peakDb - a.peakDb)[0] ?? null
  );
}

// The largest aircraft likely to take off from a runway this long (metres or more): heavy, airliner,
// small jet or turboprop, light aircraft. Anything smaller can use it too.
// shortcut: by length alone; an airport's own fleet would be better, e.g. heavies at a short cargo field.
const DEPARTS = [[2400, 'A5'], [1500, 'A3'], [900, 'A2'], [0, 'A1']];

// Takeoffs the feed may show too late: the feed often sees an aircraft only once it is rolling or
// airborne, so a departure can be heard before the page has warned of it. For each runway end, the
// takeoff of the loudest aircraft likely to use it, as predict() models it, if that would be heard at
// the set: { airport, runway, category, leadS, peakDb }, soonest first. `leadS` is how long after it
// starts to roll it is heard, the most warning the page could give from the moment it is rolling.
// `opts` as for predict(). Depends only on the set and the settings, not on the traffic.
// shortcut: both directions of every runway count; the direction in use (wind) would narrow it.
export function unseen(site, opts) {
  return (opts.runways ?? [])
    .flatMap((rw) => {
      // Every class that fits the runway is tried, not only the largest: tuning can make a smaller one
      // the louder here, and its takeoff is the one that would be heard first.
      const len = Math.hypot(...Object.values(local(rw.ends[0], rw.ends[1])));
      const fits = DEPARTS.slice(DEPARTS.findIndex(([m]) => len >= m)).map(([, c]) => c);
      return rw.ends.map((end) => {
        const heard = fits
          .map((category) => {
            const ac = { hex: `${rw.airport} ${end.id}`, category, alt_baro: 'ground', gs: 0, lat: end.lat, lon: end.lon, seen_pos: 0 };
            const w = predict(ac, site, { ...opts, runways: [rw], landed: false }); // lined up at the threshold
            return w && { airport: rw.airport, runway: end.id, category, leadS: w.startS - LINE_UP_S, peakDb: w.peakDb };
          })
          .filter(Boolean)
          .sort((a, b) => a.leadS - b.leadS);
        return heard[0];
      });
    })
    .filter(Boolean)
    .sort((a, b) => a.leadS - b.leadS);
}
