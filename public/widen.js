// Audible windows widened by how late or early the feed has been running here (`hfs:timing`, measured
// from the curves of aircraft tones in hear.js). Pure, shared by the page and the tests.
//
// - A window opens earlier by an aircraft's offset when its sound came early, and closes later when it
//   came late, to at most LATE_S. It is never narrowed: a hold must not end on a measurement.
// - An aircraft's own offset is used if it has one, else `lag`, what the last few aircraft said.
// - A window resting on an estimate (`lost` or `unsure`, lost.js) is not widened: the offset was
//   measured against reported positions, not against a guess at where the aircraft has got to.
// - A widened end, once announced, stands. The prediction drops a window as soon as its own end has
//   passed, and with it the padding that said the sound would go on: so the last widened window of
//   each aircraft is kept until its widened end, re-timed to each poll, and a newer window for that
//   aircraft never ends before it.

export const LATE_S = 15; // the most a window is widened by

// One poll. `audible` are follow()'s windows (startS/endS from `now`), `timing` is { offsets, lag }
// from `hfs:timing`, and `kept` a Map the caller keeps between polls (hex -> { win, at }), cleared
// when the set changes. Returns the windows with start/end in epoch ms, sorted by start, no
// aircraft twice.
export function widen(audible, now, timing, kept) {
  const late = (w) => (w.lost || w.unsure ? 0 : 1000 * Math.max(-LATE_S, Math.min(LATE_S, timing.offsets?.[w.hex] ?? timing.lag ?? 0)));
  const out = new Map();
  for (const w of audible) {
    const d = late(w);
    const end = now + w.endS * 1000;
    const win = { ...w, start: now + w.startS * 1000 + Math.min(0, d), end: end + Math.max(0, d) };
    const k = kept.get(w.hex);
    if (k && k.win.end > now) {
      // An unsure window is no hold: the widened one it followed is, until its end.
      if (w.unsure) {
        out.set(w.hex, shifted(k, now));
        continue;
      }
      win.end = Math.max(win.end, k.win.end);
    }
    if (win.end > end) kept.set(w.hex, { win, at: now });
    else kept.delete(w.hex);
    out.set(w.hex, win);
  }
  for (const [hex, k] of kept) {
    if (k.win.end <= now) kept.delete(hex);
    else if (!out.has(hex)) out.set(hex, shifted(k, now));
  }
  return [...out.values()].sort((a, b) => a.start - b.start);
}

// A kept window as at `now`: its seconds counted from now, and its path's too.
function shifted({ win, at }, now) {
  const dt = (now - at) / 1000;
  return { ...win, startS: win.startS - dt, endS: win.endS - dt, path: (win.path ?? []).map((p) => ({ ...p, t: p.t - dt, heardAt: p.heardAt - dt })) };
}
