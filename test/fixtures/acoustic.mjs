// shortcut: freeze the invented sound envelope used by the listening and sharing tests. Their timings,
// overlapping sources and noise bursts must stay fixed when propagation assumptions change.
// Real propagation and its integration are exercised in propagate.test.js and predict.test.js.
const LEVEL = { A1: 68, A2: 76, A3: 80, A4: 82, A5: 86, A6: 98, A7: 78 };
export function syntheticEnvelope(track, trim = {}) {
  const source = (LEVEL[track.category] ?? 76) + (trim?.[track.category] ?? 0);
  return { ...track, path: track.path.map(p => {
    const km = p.dist / 1000;
    const beta = Math.atan2(p.alt, Math.hypot(p.x, p.y)) * 180 / Math.PI;
    return { ...p, db: source - 20 * Math.log10(p.dist / 305) -
      (3.5 * Math.min(km, 3) + Math.max(km - 3, 0)) - 8 * Math.max(0, 1 - beta / 30) };
  }) };
}
