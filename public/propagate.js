// Pure propagation losses in dB; distances in metres, angles in degrees.
const RAD = Math.PI / 180;
export const REFERENCE_M = 305; // existing rounded 1000 ft source reference
const BANDS = [63, 125, 250, 500, 1000, 2000, 4000, 8000];
// shortcut: representative emitted A-weighted octave spectra, not measured type spectra.
// Revisit with calibrated spectra; low-frequency engines share the louder-at-distance curve.
const SPECTRA = { jet: [-22, -13, -7, -3, 0, -1, -5, -12], prop: [-12, -5, -1, 0, -2, -6, -12, -20] };

// ISO 9613-1:1993 pure-tone equations; 15 C, 70% RH, 101.325 kPa.
// Formula cross-check: https://acoustic-toolbox.readthedocs.io/en/latest/standards/iso_9613_1_1993/
export function coefficient(f) {
  const T = 288.15, ratio = T / 293.15;
  const h = 70 * 10 ** (-6.8346 * (273.16 / T) ** 1.261 + 4.6151); // molar percent, NOT fraction
  const oxygen = 24 + 4.04e4 * h * (0.02 + h) / (0.391 + h);
  const nitrogen = ratio ** -0.5 * (9 + 280 * h * Math.exp(-4.170 * (ratio ** (-1 / 3) - 1)));
  return 8.686 * f * f * (1.84e-11 * Math.sqrt(ratio) + ratio ** -2.5 * (
    0.01275 * Math.exp(-2239.1 / T) / (oxygen + f * f / oxygen) +
    0.1068 * Math.exp(-3352 / T) / (nitrogen + f * f / nitrogen)));
}
const ALPHA = BANDS.map(coefficient);
// shortcut: 100 m lookup spacing and a 100 km cap keep the per-sample work constant.
// Loss is concave: interpolation underestimates it (the louder choice); the cap does too.
const STEP = 100;
const TABLES = Object.fromEntries(Object.entries(SPECTRA).map(([kind, spectrum]) => {
  // First propagate the spectral shape to the source-level reference; subsequent losses start there.
  const power = spectrum.map((db, b) => 10 ** ((db - ALPHA[b] * REFERENCE_M) / 10));
  const total = power.reduce((a, b) => a + b);
  return [kind, Float64Array.from({ length: 1001 }, (_, i) => -10 * Math.log10(
    power.reduce((sum, p, b) => sum + p * 10 ** (-ALPHA[b] * i * STEP / 10), 0) / total))];
}));
export function absorption(dist, kind) {
  // Unknowns could be low-frequency: using the jet curve could suppress a warning.
  const table = TABLES[kind === 'jet' ? 'jet' : 'prop'];
  const index = Math.min(Math.max(0, dist - REFERENCE_M) / STEP, table.length - 1);
  const lo = Math.floor(index), hi = Math.min(lo + 1, table.length - 1);
  return table[lo] + (table[hi] - table[lo]) * (index - lo);
}

// ECAC Doc 29 v2 (4th ed), 4.5.4, equations 4-18/4-19, adapted from SAE AIR5662:
// https://www.ecac-ceac.org/images/documents/ECAC-Doc_29_4th_edition_Dec_2016_Volume_2.pdf
// Soft level ground only; beta clamped at zero for a receiver above the aircraft.
export function lateral(beta, lateralM) {
  beta = Math.max(0, beta);
  if (beta > 50) return 0;
  const factor = lateralM > 914 ? 1 : Math.min(1, 1.089 * -Math.expm1(-0.00274 * Math.max(0, lateralM)));
  return factor * Math.max(0, 1.137 - 0.0229 * beta + 9.72 * Math.exp(-0.142 * beta));
}

// Doc 29 4.5.3 eq 4-15/4-16: additive engine-installation correction, not a loss.
export function installation(phi, mount) {
  if (mount === 'prop') return 0;
  if (mount !== 'wing' && mount !== 'fuselage') return Math.max(0, installation(phi, 'wing'), installation(phi, 'fuselage'));
  phi = Math.max(0, Math.min(90, phi)) * RAD;
  const [a, b, c] = mount === 'wing' ? [0.0039, 0.062, 0.8786] : [0.1225, 0.329, 1];
  return 10 * Math.log10((a * Math.cos(phi) ** 2 + Math.sin(phi) ** 2) ** b /
    (c * Math.sin(2 * phi) ** 2 + Math.cos(2 * phi) ** 2));
}

export const elevation = (alt, ground) => Math.atan2(Math.max(0, alt), ground) / RAD;
export function propagation(dist, beta, lateralM, kind) {
  // shortcut: each sample is a short segment, using Doc 29 4.5.5 nearest-point geometry. Unknown surfaces
  // cannot justify full soft-ground shielding: cap it at an uncalibrated 3 dB, and never
  // exceed the previous horizon allowance. Revisit with measured surface/path data, especially rolls.
  const groundLoss = Math.min(lateral(beta, lateralM), 3, 8 * Math.max(0, 1 - beta / 30));
  // shortcut: no bank/mount data: use the loudest installation, including unshielded propellers.
  return 20 * Math.log10(dist / REFERENCE_M) + absorption(dist, kind) + groundLoss - installation(beta, kind && kind !== 'jet' ? 'prop' : undefined);
}
