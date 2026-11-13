// shortcut: stability cutoffs and acoustic gains are uncalibrated guesses, not ray tracing.
const RAD = Math.PI / 180;
const finite = Number.isFinite;
export function freshWeather(w, now) {
  return w && finite(w.at) && finite(now) && now >= w.at && now - w.at <= 3600_000 ? w : null;
}

export function stability(w) {
  if (!w) return 'D';
  if (finite(w.temperature_2m) && finite(w.temperature_80m)) {
    const delta = w.temperature_80m - w.temperature_2m;
    if (delta > 0.5) return 'F';
    if (delta < -0.8 && w.is_day === 1) return 'B';
  }
  if (!finite(w.wind_speed_10m) || !finite(w.cloud_cover) || !finite(w.is_day)) return 'D';
  if (w.is_day === 0 && w.cloud_cover < 40 && w.wind_speed_10m < 3) return 'F';
  if (w.is_day === 1 && w.shortwave_radiation > 400 && w.wind_speed_10m < 5) return 'B';
  return 'D';
}

// Bearing is from the set TO the source, degrees clockwise from north; wind is FROM.
// Downwind propagation is already the lateral attenuation baseline: no additional wind gain.
export function weatherLevel(w, { bearing, elevation, distance, altitude }, now) {
  if (!freshWeather(w, now)) return 0;
  if (![bearing, elevation, distance, altitude].every(finite) || elevation >= 15 || distance <= 0) return 0;
  // shortcut: taper to zero by 15 degrees and within 1 km; tune with measured low-angle passes.
  const shallow = Math.max(0, Math.min(1, (15 - elevation) / 10)) * Math.min(1, distance / 1000);
  const cls = stability(w);
  let gain = cls === 'F' ? 5 : cls === 'B' ? -1 : 0;
  if (finite(w.wind_speed_10m) && finite(w.wind_direction_10m)) {
    // A source opposite the wind's origin sends sound upwind toward the set.
    const upwind = Math.max(0, -Math.cos((bearing - w.wind_direction_10m) * RAD));
    const shear = finite(w.wind_speed_80m) ? Math.max(0, w.wind_speed_80m - w.wind_speed_10m) : 0;
    gain -= 3 * upwind * Math.min(1, (w.wind_speed_10m + shear) / 5);
  }
  // shortcut: at most 3 dB quieter (well below measured shadows), never for low nearby aircraft.
  // A grid forecast cannot establish a shadow at the microphone; revisit only with field validation.
  if (gain < 0 && altitude < 100 && distance < 3000) return 0;
  return Math.max(-3, gain) * shallow;
}
