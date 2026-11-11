// Which aircraft the page predicts on each poll, including the ones the feed has lost. Pure, shared
// by the page and the tests.
//
// The free feeds lose an aircraft that is low: behind buildings or terrain, or under what the
// receivers nearby can see. That is where an aircraft landing beside the set is loudest. The feed
// goes on repeating its last position for about a minute, and then drops the row. So an aircraft is
// followed by its newest position, whether or not the feed still lists it:
// - With no position for LOST_S it is `lost`: what the page shows from then on is an estimate. Every
//   track and window carries `seenAt` (epoch ms of the position it rests on), and `lost: true` then.
// - When the feed gives no usable row any more, the last one is carried forward (predict() works out
//   from the age of a position where the aircraft has got to), but only while that matters: while it
//   has an audible window that has not ended, and that starts before the estimate runs out.
// - An estimate runs out when its position is CAP_S old, and its window is cut off there, so a hold
//   that rests on an estimate always ends. An aircraft on final is no exception, though the runway
//   fixes its path and the path stops at touchdown: it is still slowing down, so an old estimate
//   has it over the set too soon.
// - Running out is not the same as going quiet. If the aircraft was still due to be heard when its
//   estimate ran out, its window is kept with `unsure: true` and no track, until the moment it was
//   last predicted to end, and for UNSURE_S at most. The banner then says it cannot tell: neither a
//   hold, which nothing supports any more, nor clear, which nothing supports either.
// - A row with a position replaces the estimate at once, even one that predicts nothing (it landed).
// shortcut: CAP_S comes from six jet landings in an earlier LAX recording: predicted from a position up to
// 2 min old, touchdown was within 9 s (within 3 s under 100 s); from 3 min it was 17 to 48 s early.
// Measure it again, and for light aircraft, on a recording made beside an airport with poor low coverage.
// shortcut: an aircraft lined up on a runway is not carried forward, because when it goes was a
// guess already. One the feed loses there is not warned about until it is seen again.

import { located, predict } from './predict.js';
import { STALE_MS } from './status.js';

export const LOST_S = STALE_MS / 1000; // as old as the whole feed may get before the page stops trusting it
export const CAP_S = 120; // how old a position an estimate may rest on
export const UNSURE_S = 120; // how long after that the page goes on saying it cannot tell, at most

// One poll. `known` is a Map the caller keeps between polls and this fills in: hex -> { ac, at }, the
// row behind each aircraft's last prediction and the epoch ms of the poll it came in. `rows` are the
// feed's, with the feed's own delay already added to `seen_pos`, and `optsFor(ac)` gives predict()'s
// options for an aircraft. Returns what predict() makes of every aircraft followed: `tracks` with no
// floor (the whole path of each) and `windows`, the audible ones. No aircraft is in either twice.
export function follow(known, rows, now, site, optsFor) {
  const tracks = [];
  const windows = [];
  const mark = (ac) => ({ seenAt: now - (ac.seen_pos ?? 0) * 1000, ...(ac.seen_pos > LOST_S && { lost: true }) });
  // Kept with an aircraft's row for when its estimate runs out: the window as last predicted, when it
  // was due to start, and how long the page then goes on saying it cannot tell. `left` is the seconds
  // the estimate has left.
  const due = (win, left) => win && { win, from: now + win.startS * 1000, until: now + Math.min(win.endS, left + UNSURE_S) * 1000 };
  const here = new Set();
  for (const ac of rows) {
    if (!located(ac) || here.has(ac.hex)) continue;
    here.add(ac.hex);
    const opts = optsFor(ac);
    const track = predict(ac, site, { ...opts, floor: -Infinity });
    if (!track) {
      known.delete(ac.hex); // reported, with nothing to predict (on the ground, say): no estimate outlives that
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
      if (last.until > now && last.from < now + left * 1000) windows.push({ ...last.win, startS: (last.from - now) / 1000, endS: (last.until - now) / 1000, path: [], unsure: true, ...mark(ac) });
      else known.delete(hex);
      continue;
    }
    const opts = { ...optsFor(ac), maxAge: Infinity };
    const track = predict(ac, site, { ...opts, floor: -Infinity });
    const win = track && track.phase !== 'lined up on' && predict(ac, site, opts);
    if (!win || win.startS >= left) {
      known.delete(hex); // nothing left to hear of it, or nothing that can still be trusted
      continue;
    }
    Object.assign(last, due(win, left));
    // Nothing of an estimate is shown past the moment it runs out: not its window, and not its path.
    const inTime = (p) => p.heardAt <= left;
    tracks.push({ ...track, path: track.path.filter(inTime), ...mark(ac) });
    windows.push({ ...win, path: win.path.filter(inTime), endS: Math.min(win.endS, left), ...mark(ac) });
  }
  return { tracks, windows };
}
