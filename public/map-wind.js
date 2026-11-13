// Pure map wind readout. Bearings are clockwise from north; the arrow starts pointing north.
import { stability } from './weather.js';
const directions = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const names = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'];
const bearing = (degrees) => ((degrees % 360) + 360) % 360;
export const windAngle = (from) => bearing(from + 180);
export const windSpeed = (speed, unit = 'mph') => speed * (unit === 'knots' ? 3600 / 1852 : 3600 / 1609.344);
// shortcut: below 0.5 m/s is calm; replace with measured local wind when available.
export const calmWind = (speed) => speed < 0.5;
export function windReadout(w, unit = 'mph') {
  if (!w || !Number.isFinite(w.wind_speed_10m) || w.wind_speed_10m < 0) return null;
  const calm = calmWind(w.wind_speed_10m);
  if (!calm && !Number.isFinite(w.wind_direction_10m)) return null;
  const i = Math.round(bearing(w.wind_direction_10m) / 45) % 8;
  const speed = Math.round(windSpeed(w.wind_speed_10m, unit));
  const stable = stability(w) === 'F';
  return {
    angle: calm ? null : windAngle(w.wind_direction_10m),
    text: calm ? 'Calm' : `${directions[i]} ${speed} ${unit}`,
    tag: stable ? 'Stable air' : '',
    label: `${calm ? 'Wind calm' : `Wind from ${names[i]}, ${speed} ${unit}`}${stable ? ', stable air' : ''}. Switch to ${unit === 'mph' ? 'knots' : 'mph'}`,
  };
}
