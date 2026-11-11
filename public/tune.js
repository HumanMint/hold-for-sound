// Turns the passes the microphone has observed (see hear.js) into what the page should assume about
// this set, ready to send as `hfs:tune`. Pure functions of plain JSON. What is learned belongs to one
// set and one environment (outdoors, indoors, stage), so the caller keeps one stored list for each.
//
//   remember(stored, fresh) → the list to store: `stored` plus the `fresh` observations worth
//       learning from, cut to the newest 80. Old passes drop off, so it follows a set that changes.
//   tune(stored, level) → { floor, trim, passes, heard, unheard, error, settled, early }
//       floor     the predicted level (predict.js's dB, as the slider shows) at which an aircraft is
//                 just audible here through this microphone: its noise is then as loud as the
//                 background. null until 4 passes have been heard, except that from 2 it may lower
//                 `level`, the user's own warning level (see below).
//       trim      dB to add per size category, e.g. { A1: 4 }, for categories that are louder (+) or
//                 quieter (-) here than the rest. Only for a category with 5 heard passes.
//       heard     how many passes the floor rests on
//       unheard   how many aircraft predicted loud were not heard at all. They are counted, for the
//                 page to mention, and never move the floor (see below). `passes` is both together.
//       error     roughly how many dB either way the floor is still uncertain
//       settled   true once 8 passes have been heard and they agree to within 2 dB
//       early     true when `floor` is that lowering of `level`, from fewer than 4
//
// Only passes the engine was confident about count (TRUSTED or more), and only the ones that were
// heard and measured move the floor: tones that followed one aircraft's Doppler curve, or a swell
// only one aircraft explains. Observations hold predictions with the trim taken out, so the result
// does not chase itself when it is fed back into the predictions.
//
// Silence never raises the floor. An aircraft predicted loud that was not heard could mean the
// prediction is too loud, but it looks exactly like a microphone that has been covered, unplugged or
// turned down since it last heard one, and a floor raised on that would quietly stop the page warning.
// shortcut: so a set where the predictions run far too loud is only corrected by the aircraft that
// are heard, or by the user moving the slider; the page can say how many went unheard and leave the
// judgement to them.
//
// Missing aircraft the microphone hears is the costly mistake. A wrong choice of where the microphone
// is (a sound stage for one at an open window) can put every prediction 20 dB or more too low. So before there are 4, 2 heard passes that both put the floor at least LEAST
// under the user's level lower it, to the higher of what they say. Never above that level: raising
// it still takes 4.

export const TRUSTED = 0.5;
const KEEP = 80;
const ENOUGH = 4; // heard passes before there is a floor
const EARLY = 2; // heard passes that may lower the user's level before that
const PER_CATEGORY = 5; // heard passes before a category gets its own trim
const LIMIT = 12; // dB: the most a trim may be
const LEAST = 2; // dB: a smaller difference between categories is within the noise of a few passes

const MISSED = 20; // unheard passes kept, apart from the heard ones, so a deaf day cannot push those out

const sure = (o) => o.hex && o.confidence >= TRUSTED && o.predPeak != null;
const learns = (o) => sure(o) && o.heard === true && o.floor != null;
const missed = (o) => sure(o) && o.heard === false;
export function remember(stored, fresh) {
  const all = [...stored, ...fresh].filter((o) => learns(o) || missed(o));
  let heard = all.filter(learns).length - KEEP; // how many of the oldest of each kind to drop
  let unheard = all.filter(missed).length - MISSED;
  return all.filter((o) => (learns(o) ? heard-- <= 0 : unheard-- <= 0));
}

// The floor these passes disagree with least. Each pulls towards its own estimate, however far off
// it is, so one wild pass moves the answer no more than any other (a weighted median).
function settle(passes) {
  const cost = (floor) => passes.reduce((sum, o) => sum + o.confidence * Math.abs(floor - o.floor), 0);
  const tries = passes.map((o) => o.floor);
  const least = Math.min(...tries.map(cost));
  const ties = tries.filter((floor) => cost(floor) <= least + 1e-9);
  return (Math.min(...ties) + Math.max(...ties)) / 2;
}

export function tune(observations, level = null) {
  const heard = observations.filter(learns);
  const unheard = observations.filter(missed).length;
  const result = { floor: null, trim: {}, passes: heard.length + unheard, heard: heard.length, unheard, error: null, settled: false, early: false };
  if (heard.length < ENOUGH) {
    const most = Math.max(...heard.map((o) => o.floor));
    if (heard.length >= EARLY && level != null && most <= level - LEAST) Object.assign(result, { floor: Math.round(most * 10) / 10, early: true });
    return result;
  }

  const floor = settle(heard);
  const off = heard.map((o) => Math.abs(o.floor - floor)).sort((a, b) => a - b);
  // The usual error of a median, from the middle disagreement. It is never taken as under 1 dB.
  result.error = Math.round(((1.9 * Math.max(off[off.length >> 1], 1)) / Math.sqrt(heard.length)) * 10) / 10;
  result.floor = Math.round(floor * 10) / 10;
  result.settled = heard.length >= 2 * ENOUGH && result.error <= 2;
  for (const category of new Set(heard.map((o) => o.category))) {
    const same = heard.filter((o) => o.category === category);
    if (same.length < PER_CATEGORY) continue;
    // Just audible at a lower prediction than the rest means louder than predicted: trim it up.
    const trim = Math.max(-LIMIT, Math.min(LIMIT, Math.round(floor - settle(same))));
    if (Math.abs(trim) >= LEAST) result.trim[category] = trim;
  }
  return result;
}
