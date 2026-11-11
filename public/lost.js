// Which aircraft the page predicts on each poll, including the ones the feed has lost. Pure, shared
// by the page and the tests.
//
// The free feeds lose an aircraft that is low: behind buildings or terrain, or under what the
// receivers nearby can see. That is where an aircraft landing beside the set is loudest. The feed
// goes on repeating its last position for about a minute, and then drops the row. So an aircraft is
// followed by its newest position, whether or not the feed still lists it:
// - It is `lost` once the newest answer does not list it with a position, or lists one LOST_S older
//   than the answer itself: what the page shows from then on is an estimate. Every track and window
//   carries `seenAt` (epoch ms of the position it rests on), and `lost: true` then. How long the server
//   keeps an answer (cadence.js) does not come into it: an answer kept a minute is no evidence that an
//   aircraft it leaves out is still where it was.
// - When the feed gives no usable row any more, the last one is carried forward (predict() works out
//   from the age of a position where the aircraft has got to), but only while that matters: while it
//   has an audible window that has not ended, and that starts before the estimate runs out.
// - An estimate runs out when its position is CAP_S old, and its window is cut off there, so a hold
//   that rests on an estimate always ends. An aircraft on final is no exception, though the runway
//   fixes its path and the path stops at the end of its rollout: it is still slowing down, so an old
//   estimate has it over the set too soon.
// - Running out is not the same as going quiet. If the aircraft was still due to be heard when its
//   estimate ran out, its window is kept with `unsure: true` and no track, until the moment it was
//   last predicted to end, and for UNSURE_S at most. The banner then says it cannot tell: neither a
//   hold, which nothing supports any more, nor clear, which nothing supports either.
// - A row with a position replaces the estimate at once, even one that predicts nothing (it landed).
// - An aircraft lined up on a runway has no estimate to carry forward: when it goes was a guess
//   already. One the feed loses there can go at any moment, so if its takeoff would be heard, its
//   window is `unsure` from the moment it is lost until it is seen again or its position is CAP_S
//   old, and then it is dropped. That holds whether the feed drops its row or goes on listing an old
//   position: it never shows as clear while it may still be waiting there.
// shortcut: CAP_S comes from six jet landings in an earlier LAX recording: predicted from a position up to
// 2 min old, touchdown was within 9 s (within 3 s under 100 s); from 3 min it was 17 to 48 s early.
// Measure it again, and for light aircraft, on a recording made beside an airport with poor low coverage.
// shortcut: CAP_S for a lined-up aircraft rests on one, which the feed lost lined up and which rolled
// 96 s after its last position.

import { located, predict, MAX_AGE_S } from './predict.js';
import { STALE_MS } from './status.js';

export const LOST_S = STALE_MS / 1000; // a position this much older than its answer is no longer a report
export const CAP_S = 120; // how old a position an estimate may rest on
export const UNSURE_S = 120; // how long after that the page goes on saying it cannot tell, at most

// One poll. `known` is a Map the caller keeps between polls and this fills in: hex -> { ac, at }, the
// row behind each aircraft's last prediction and the epoch ms of the poll it came in. `rows` are the
// feed's, with the feed's own delay already added to `seen_pos`, and `optsFor(ac)` gives predict()'s
// options for an aircraft. Returns what predict() makes of every aircraft followed: `tracks` with no
// floor (the whole path of each) and `windows`, the audible ones. No aircraft is in either twice.
// `age` is how old the answer itself is, in seconds, already in every row's `seen_pos`: a position is
// lost, and too old to predict from, by its age within the answer, not by how long the answer was kept.
export function follow(known, rows, now, site, optsFor, age = 0) {
  const tracks = [];
  const windows = [];
  const maxAge = MAX_AGE_S + age;
  const mark = (ac, lost = ac.seen_pos > LOST_S + age) => ({ seenAt: now - (ac.seen_pos ?? 0) * 1000, ...(lost && { lost: true }) });
  // Kept with an aircraft's row for when its estimate runs out: the window as last predicted, when it
  // was due to start, and how long the page then goes on saying it cannot tell. `left` is the seconds
  // the estimate has left.
  const due = (win, left) => win && { win, from: now + win.startS * 1000, until: now + Math.min(win.endS, left + UNSURE_S) * 1000 };
  // Lined up and lost, with `left` seconds until its position is CAP_S old: if its takeoff would be
  // heard, an `unsure` window from now until then, with no path and no track; else it is forgotten.
  const waiting = (ac, opts, left) => {
    const win = predict(ac, site, opts);
    if (!win) return known.delete(ac.hex);
    known.set(ac.hex, { ac, at: now, win, from: now, until: now + left * 1000 }); // and nothing is left when it runs out
    windows.push({ ...win, startS: 0, endS: left, path: [], unsure: true, ...mark(ac) });
  };
  const here = new Set();
  for (const ac of rows) {
    if (!located(ac, maxAge) || here.has(ac.hex)) continue;
    here.add(ac.hex);
    const opts = { ...optsFor(ac), maxAge };
    const track = predict(ac, site, { ...opts, floor: -Infinity });
    if (!track) {
      known.delete(ac.hex); // reported, with nothing to predict (on the ground, say): no estimate outlives that
      continue;
    }
    if (track.phase === 'lined up on' && ac.seen_pos > LOST_S + age) {
      waiting(ac, opts, CAP_S - ac.seen_pos);
      continue;
    }
    const win = predict(ac, site, opts);
    known.set(ac.hex, { ac, at: now, ...due(win, CAP_S - (ac.seen_pos ?? 0)) });
    tracks.push({ ...track, ...mark(ac) });
    if (win) windows.push({ ...win, ...mark(ac) });
  }
  for (const [hex, last] of known) {
    if (here.has(hex)) continue;
    const ac = { ...last.ac, seen_pos: (last.ac.seen_pos ?? 0) + (now - last.at) / 1000 };
    const left = CAP_S - ac.seen_pos; // seconds until the estimate runs out
    if (left <= 0) {
      // Run out. It is kept, with no position and no track, only if it was being heard, or due to be,
      // before that, and only until it was last predicted to end.
      if (last.until > now && last.from < now + left * 1000) windows.push({ ...last.win, startS: (last.from - now) / 1000, endS: (last.until - now) / 1000, path: [], unsure: true, ...mark(ac, true) });
      else known.delete(hex);
      continue;
    }
    const opts = { ...optsFor(ac), maxAge: Infinity };
    const track = predict(ac, site, { ...opts, floor: -Infinity });
    if (track?.phase === 'lined up on') {
      waiting(ac, opts, left);
      continue;
    }
    const win = track && predict(ac, site, opts);
    if (!win || win.startS >= left) {
      known.delete(hex); // nothing left to hear of it, or nothing that can still be trusted
      continue;
    }
    Object.assign(last, due(win, left));
    // Nothing of an estimate is shown past the moment it runs out: not its window, and not its path.
    const inTime = (p) => p.heardAt <= left;
    tracks.push({ ...track, path: track.path.filter(inTime), ...mark(ac, true) });
    windows.push({ ...win, path: win.path.filter(inTime), endS: Math.min(win.endS, left), ...mark(ac, true) });
  }
  return { tracks, windows };
}
