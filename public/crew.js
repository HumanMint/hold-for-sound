import { ENVIRONMENTS } from './predict.js';

export function parse(hash, min, max) {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  if (params.size !== 3 || [...params.keys()].some(key => !['set', 'env', 'level'].includes(key))) return null;
  const parts = params.get('set')?.split(',');
  const number = text => typeof text === 'string' && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(text.trim()) ? Number(text) : NaN;
  const [lat, lon] = (parts ?? []).map(number);
  const env = params.get('env');
  const level = number(params.get('level'));
  if (parts?.length !== 2 || !Number.isFinite(lat) || Math.abs(lat) > 90 || !Number.isFinite(lon) || Math.abs(lon) > 180 || !Object.hasOwn(ENVIRONMENTS, env) || !Number.isFinite(level) || level < min || level > max) return null;
  return { lat, lon, env, level };
}

// Keep the server's rounded place even at a rounding boundary.
function coordinate(value) {
  let rounded = +value.toFixed(4);
  if (rounded.toFixed(3) !== value.toFixed(3)) rounded += Math.sign(value - rounded) * 0.0001;
  return rounded.toFixed(4);
}

export function link(url, site, env, level) {
  const clean = new URL(url);
  clean.search = '';
  clean.username = clean.password = '';
  clean.hash = `set=${coordinate(site.lat)},${coordinate(site.lon)}&env=${env}&level=${level}`;
  return clean.href;
}

export function matches(crew, site, env, level) {
  return !!site && crew.lat.toFixed(3) === site.lat.toFixed(3) && crew.lon.toFixed(3) === site.lon.toFixed(3) && crew.env === env && crew.level === +level;
}
