// A receiver of your own: an ADS-B receiver near the set sees aircraft on the ground at a small
// airport sooner and more often than the community feeds do. readsb, dump1090-fa and tar1090 all
// serve what it hears as aircraft.json, with the feeds' own field names.
// It only ever adds to a feed that answered. One antenna sees a part of the sky, so it is never
// served alone, and never makes an old feed look fresh.
// shortcut: only ever run against a stand-in serving that JSON, because nobody here has the hardware
// yet. Check it against a real receiver before relying on it.

// What the community feed knows about an aircraft that a receiver often has not heard yet.
const TYPE = ['t', 'desc', 'category', 'flight'];

// A receiver's aircraft.json in the feed's terms: its `now` is in seconds, not ms, and its list is
// `aircraft`, not `ac`. `askedAt` is when it answered, epoch ms. A receiver whose clock runs ahead is
// taken to have made the snapshot then. One whose clock runs behind looks old, so the feed wins.
// Anything that is not an aircraft.json throws, and the caller carries on without the receiver.
export function snapshot(json, askedAt) {
  if (!Array.isArray(json?.aircraft)) throw new Error('not an aircraft.json');
  return { now: Math.min(json.now * 1000 || Infinity, askedAt), ac: json.aircraft.filter((ac) => typeof ac?.hex === 'string') };
}

// The feed's answer with the receiver's aircraft added, for the set at `lat`, `lon`. `feed` and `own`
// are { now, ac } with `now` in epoch ms; `own` is nothing when the receiver did not answer. Each
// aircraft comes from whichever source saw its position last, allowing for how old each snapshot is.
// The answer stays measured from the feed's snapshot (`now` and every seen_pos): how fresh it is, is
// how fresh the feed's view of the whole sky is.
export function merge(feed, own, { lat, lon, radiusNm }) {
  if (!own) return feed;
  // Seconds the receiver's snapshot is older (+) or newer (-) than the feed's. A feed that gives no
  // time is taken to be as fresh as the receiver.
  const behind = feed.now == null ? 0 : (feed.now - own.now) / 1000;
  const all = new Map(feed.ac.map((ac) => [ac.hex, ac]));
  let used = 0;
  // One degree of latitude is 60 nm.
  const near = (ac) => Math.hypot(ac.lat - lat, (ac.lon - lon) * Math.cos((lat * Math.PI) / 180)) * 60 <= radiusNm;
  // A position with no height cannot be predicted from, so it must not replace one that can.
  const usable = (ac) => ac.lat != null && ac.lon != null && (ac.alt_baro != null || ac.alt_geom != null);
  for (const mine of own.ac.filter((ac) => usable(ac) && near(ac))) {
    const seenPos = (mine.seen_pos ?? 0) + behind;
    const theirs = all.get(mine.hex);
    if (theirs?.lat != null && (theirs.seen_pos ?? 0) <= seenPos) continue; // the feed's position is as fresh
    const merged = { ...mine, seen_pos: seenPos };
    for (const field of TYPE) if (merged[field] == null && theirs?.[field] != null) merged[field] = theirs[field];
    all.set(mine.hex, merged);
    used++;
  }
  return { ...feed, source: used ? `${feed.source} and your receiver` : feed.source, ac: [...all.values()] };
}
