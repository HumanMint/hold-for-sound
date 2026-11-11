// What an opened row in the aircraft list says: labels and values from the prediction and the feed's
// own row, and nothing the feed did not send. The callsign is the row's heading, so it is not here.
// Pure, shared by the page and the tests.

import { CLASS_NAME } from './predict.js';
import { engine, ENGINE_NAME } from './engine.js';

const mmss = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const num = (n) => Math.round(n).toLocaleString('en-US');
const clock = (ms) => new Date(ms).toLocaleTimeString('en-GB'); // as the log reads
const cap = (s) => s[0].toUpperCase() + s.slice(1);

// Where the aircraft is now, seen from the set: "9 km NE".
const POINTS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
export function where(w) {
  const p = w.path.find((p) => p.t >= 0) ?? w.path[0];
  const km = Math.hypot(p.x, p.y) / 1000;
  const turns = Math.atan2(p.x, p.y) / (Math.PI / 4); // eighths of a circle clockwise from north, -4 to 4
  return `${km < 10 ? km.toFixed(1) : Math.round(km)} km ${POINTS[(Math.round(turns) + 8) % 8]}`; // kept on one line
}

// [label, value] pairs for a window `w` (an audible one, a taxiing one with no start, or an `unsure`
// one) and `ac`, the feed's row for it ({} when there is none). `now` is epoch ms.
export function details(w, ac, now) {
  const taxi = w.start == null;
  const last = (k) => (w.lost || w.unsure ? `Last ${k.toLowerCase()}` : k); // the feed's values are from before contact was lost
  const rate = ac.baro_rate ?? ac.geom_rate;
  const kind = engine({ t: ac.t ?? w.t, category: ac.category ?? w.category });
  const size = CLASS_NAME[ac.category ?? w.category];
  const rows = [
    ['Runway', w.phase && !w.unsure && (taxi ? `Likely ${w.runway} at ${w.airport}` : `${cap(w.phase)} ${w.runway} at ${w.airport}`)],
    ['From set', !taxi && w.path?.length > 0 && where(w)],
    ['Contact lost', (w.lost || w.unsure) && `${mmss(now - w.seenAt)} ago`],
    ['Audible', w.unsure ? null : taxi ? `About ${mmss((w.endS - w.startS) * 1000)} if it takes off` : `${clock(w.start)} to ${clock(w.end)}, ${mmss(w.end - w.start)}`],
    ['Est. peak', !w.unsure && `${Math.round(w.peakDb)} dBA at the mic`],
    ['At peak', !w.unsure && w.peakDistM != null && `${(w.peakDistM / 1000).toFixed(1)} km away, ${num(Math.round(w.peakAltFt / 100) * 100)} ft up`],
    [last('Altitude'), ac.alt_baro === 'ground' ? 'On the ground' : typeof ac.alt_baro === 'number' && `${num(ac.alt_baro)} ft`],
    [last('Ground speed'), typeof ac.gs === 'number' && `${num(ac.gs)} kt`],
    [last('Vertical rate'), typeof rate === 'number' && ac.alt_baro !== 'ground' && (Math.abs(rate) < 100 ? 'Level' : `${rate > 0 ? 'Climbing' : 'Descending'} ${num(Math.abs(rate))} ft/min`)],
    ['Squawk', ac.squawk],
    ['Registration', ac.r],
    ['Type', [ac.t ?? w.t, ac.desc ?? w.desc].filter(Boolean).join(', ')],
    ['Operator', ac.ownOp],
    ['Built', ac.year],
    ['Engine', ENGINE_NAME[kind] ?? 'Unknown'],
    ['Class', size && size !== 'helicopter' && cap(size)], // a helicopter's engine has said it
  ];
  return rows.filter(([, v]) => v != null && v !== false && v !== '').map(([k, v]) => [k, String(v)]);
}
