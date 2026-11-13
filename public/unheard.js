// Quiet microphone evidence for this window only. No tuning or evidence survives a listening gap.
// shortcut: 20 s of continuous listening and a 3 dB rise are uncalibrated; check more aircraft and inputs.
export const UNHEARD_MS = 20_000;
export const MIC_FRESH_MS = 2000;

export function unheard(known, windows, now, sample) {
  const s = sample?.status;
  if (sample?.demo || sample?.stale || !s?.ready || !s.signal || !Number.isFinite(s.rise) || now < s.at || now - s.at > MIC_FRESH_MS) {
    known.clear();
    return [];
  }
  const active = windows.filter((w) => w.category === 'A7' && !w.lost && !w.unsure && w.start <= now && w.end > now);
  const here = new Set(active.map((w) => w.hex));
  for (const hex of known.keys()) if (!here.has(hex)) known.delete(hex);
  const out = [];
  for (const w of active) {
    let k = known.get(w.hex);
    if (!k || s.at - k.at > MIC_FRESH_MS || s.at < k.at) k = { from: Math.max(s.at, w.start), heard: false };
    k.at = s.at;
    // Any rise is enough: sound need not have been confidently assigned to this helicopter.
    k.heard ||= s.rise >= 3 || s.noise || (s.heard ?? []).length > 0;
    known.set(w.hex, k);
    if (!k.heard && s.at - k.from >= UNHEARD_MS) out.push(w.hex);
  }
  return out;
}

// Apply only to a current, reported helicopter window. Keep the window so the banner cannot go Clear.
export function notHeard(windows, evidence, now) {
  const ids = evidence && now >= evidence.at && now - evidence.at <= MIC_FRESH_MS ? evidence.hexes : [];
  return windows.map((w) => ids.includes(w.hex) && w.category === 'A7' && !w.lost && !w.unsure && w.start <= now && w.end > now ? { ...w, notHeard: true } : w);
}
