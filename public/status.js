// What the status banner says, worked out from the audible windows. Pure functions, shared by the
// page and the tests.

export const STALE_MS = 20_000; // flight data older than this is not trusted
// A public server keeps a quiet sky's answer for a minute, or 30 s beside a runway, rather than 10 s
// (cadence.js), and says so with `every`, the seconds it keeps the answer. The data may then be that
// much older, and is trusted a third longer than that: 80 s, or 40 s. The server only goes quiet when
// nothing could be heard within this time.
// shortcut: the third over a slow answer is a guess, like the 10 s over a fast one. The page polls every
// 5 s and the feed is a second or two behind, so a 30 s answer is read at most about 37 s old.
export const staleAfter = (every = 0) => (every > 10 ? Math.max(STALE_MS, (every * 4000) / 3) : STALE_MS);
export const SOON_MS = 60_000; // an aircraft this close turns "clear" into "heads up"

// Overlapping windows run together into one hold. `windows` have start/end in epoch ms and are sorted
// by start. Returns the holds that have not ended yet, in order, each { start, end, first }, where
// `first` is the aircraft that starts it.
export function holds(windows, now) {
  const out = [];
  for (const w of windows) {
    if (w.end <= now || w.unsure) continue; // over, or an aircraft the page lost track of: no hold rests on that
    const last = out.at(-1);
    if (last && w.start <= last.end) last.end = Math.max(last.end, w.end);
    else out.push({ start: w.start, end: w.end, first: w });
  }
  return out;
}

// `state` is 'hold' (audible now), 'soon' (audible within a minute), 'clear', or '' when the flight
// data is too old to say. `until` is the moment the countdown runs to: the end of this hold, or the
// start of the next one (null when nothing is predicted). `current` is the hold under way and `next`
// the one after it. `staleMs` is staleAfter() for the newest answer.
// A window marked `unsure` belongs to an aircraft the feed lost so long ago that nothing can be
// predicted from its last position any more, though it was still due to be heard (lost.js). It is no
// hold, and while one is open the state is never 'clear': it is 'soon', with the window as `unsure`.
export function status(windows, now, lastData, staleMs = STALE_MS) {
  if (now - lastData > staleMs) return { state: '' }; // never call it clear on old data
  const [a, b] = holds(windows, now);
  if (a && a.start <= now) return { state: 'hold', until: a.end, current: a, next: b };
  const unsure = windows.find((w) => w.unsure && w.start <= now && w.end > now);
  if (unsure) return { state: 'soon', unsure, until: a ? a.start : null, next: a };
  return { state: a && a.start - now < SOON_MS ? 'soon' : 'clear', until: a ? a.start : null, next: a };
}

export const SETTLE_MS = 10_000; // how long a hold that stopped early is kept up before it is called clear
const CONFIRM_MS = 6000; // the longest a hold that ended on time waits for newer flight data to agree

// A hold is not called over on the first sign of it. A borderline aircraft can drop out of the
// predictions for a poll or two, and a fresh report of an aircraft the feed had lost can end the
// hold sooner than the estimate said (lost.js): so a hold that stops well before it was due
// (`early`) is kept up for 10 s. One that ends on time was timed by a prediction made before it
// ended, and the next one often adds a second or two: so it is kept up until flight data newer than
// its end agrees. `was` is what this returned last time, or null, and `polledAt` is when the newest
// flight data arrived. While it is holding on, the result has `checking: true`, and `until` is the
// latest the wait can end.
export function steady(s, now, was, polledAt = now) {
  if (s.state === 'hold' || !s.state || was?.state !== 'hold') return s; // holding, no data, or nothing to hold on to
  const lostAt = was.checking ? was.lostAt : now;
  const due = was.checking ? was.due : was.until; // when the hold was predicted to end
  const early = due - lostAt >= 3000;
  if (early ? now - lostAt >= SETTLE_MS : polledAt >= due || now - lostAt >= CONFIRM_MS) return s;
  return { state: 'hold', checking: true, early, lostAt, due, until: lostAt + (early ? SETTLE_MS : CONFIRM_MS), current: was.current, next: s.next };
}
