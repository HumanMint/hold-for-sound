// Source level in dBA at 1000 ft. Pure; point coordinates are metres relative to the set.
import { engine } from './engine.js';

// shortcut: inherited uncalibrated reference levels, not certification measurements.
const CATEGORY = { A1: 68, A2: 76, A3: 80, A4: 82, A5: 86, A6: 98, A7: 78 };
const ENGINE = { jet: 76, turboprop: 72, piston: 68, prop: 72, heli: 78 };

// shortcut: rough relative offsets only, NOT an EPNdB-to-dBA conversion. From EASA jet
// certification workbook MAdB_JETS_20261112_: maximum lateral / approach by model family,
// minus ERJ 170 family maxima (93.4 / 95.2 EPNdB), rounded, floored at zero for safety.
// A319/320/321 include all -1/-2 variants respectively; B738 only 737-800; MD88 only MD-88.
// Reproduction authorised with attribution: https://www.easa.europa.eu/copyright-disclaimer
// Replace with appropriately licensed LAmax curves when available.
const TYPE = {
  A319: [2, 0], A320: [1, 1], A321: [5, 2], B738: [2, 2], B38M: [0, 0],
  E170: [0, 0], E75L: [0, 0], E75S: [0, 0], E190: [0, 0],
  CRJ7: [0, 0], CRJ9: [0, 0], E50P: [0, 0], E55P: [0, 0], MD88: [4, 0],
};

// shortcut: power thresholds are guesses, not observed throttle settings. Height is relative
// to the runway for a departure, otherwise the set; level-off stops the climb power increment.
export function phase(ac, p) {
  if (p.phase) return p.phase;
  const vz = p.vz ?? (ac.baro_rate ?? ac.geom_rate ?? 0) * 0.3048 / 60;
  if (vz > 2.5) return p.alt < 450 && (p.speed ?? (ac.gs ?? 0) * 0.5144) < 130 ? 'takeoff' : 'climb';
  return vz < (engine(ac) === 'heli' ? -0.5 : -2.5) ? 'descent' : 'cruise';
}

// Angle from the velocity vector to the set, including climb angle: 0 ahead, 180 behind.
// A missing direction uses the loudest lobe rather than silencing an uncertain aircraft.
export function angle(p) {
  if (p.directionKnown === false) return null;
  const speed = Math.hypot(p.vx ?? 0, p.vy ?? 0, p.vz ?? 0);
  const dist = Math.hypot(p.x, p.y, p.alt);
  if (!speed || !dist) return null;
  const dot = -((p.vx ?? 0) * p.x + (p.vy ?? 0) * p.y + (p.vz ?? 0) * p.alt) / (speed * dist);
  return Math.acos(Math.max(-1, Math.min(1, dot))) * 180 / Math.PI;
}

export function source(ac, p, trim = {}) {
  const kind = engine(ac);
  const state = phase(ac, p);
  const power = state === 'takeoff' ? 6 : state === 'climb' ? 4 : state === 'cutback' ? 4 : state === 'approach' || state === 'descent' ? -4 : state === 'rollout' ? p.boost ?? -4 : 0;
  const high = ['takeoff', 'climb', 'cutback'].includes(state);
  const offsets = TYPE[ac.t];
  const type = offsets ? offsets[high ? 0 : 1] : 0;
  let base = Math.max(CATEGORY[ac.category] ?? ENGINE[kind] ?? 76, ENGINE[kind] ?? 0);
  // shortcut: light business jets at full power can greatly exceed their size reference.
  // An uncalibrated power floor, restricted to the supported type; does not raise approach.
  if (ac.t === 'E55P' && high) base = Math.max(base, 84);
  const a = angle(p);
  let direct = 0;
  // shortcut: broad jet aft lobe peaking at 130 degrees; additive only until ahead levels
  // are calibrated. No extra convective gain: that could double-count the empirical lobe.
  if (kind === 'jet') {
    const lobe = a == null ? 1 : a < 90 ? 0 : a < 130 ? (a - 90) / 40 : 1 - (a - 130) / 200;
    direct = (high ? 4 : 1) * lobe;
  }
  // shortcut: propeller broadside lobe, and rotor descent BVI, are conservative guesses;
  // rotor variability is too large to justify reducing an entire class.
  if (['piston', 'turboprop', 'prop'].includes(kind)) direct = 3 * (a == null ? 1 : Math.sin(a * Math.PI / 180) ** 2);
  if (kind === 'heli') direct = state === 'descent' || state === 'approach' ? 8 : 0; // cancels descent's -4 and adds 4
  return base + type + power + direct + (trim[ac.category] ?? 0);
}
