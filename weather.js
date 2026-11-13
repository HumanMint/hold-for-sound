// Hourly model weather; the caller supplies the shared upstream queue and traffic-counting fetch.
export const VARIABLES = 'temperature_2m,temperature_80m,temperature_120m,temperature_180m,wind_speed_10m,wind_speed_80m,wind_speed_120m,wind_speed_180m,wind_direction_10m,wind_direction_80m,wind_direction_120m,wind_direction_180m,cloud_cover,is_day,shortwave_radiation,boundary_layer_height';
const HOUR = 3600_000;
export function weatherCache(line, getJson, clock = Date.now) {
  const cache = new Map();
  const calls = [];
  return (lat, lon) => {
    const key = `${Number(lat).toFixed(3)},${Number(lon).toFixed(3)}`;
    const now = clock();
    let hit = cache.get(key);
    if (!hit || now - hit.at >= HOUR) {
      while (calls.length && now - calls[0] >= 24 * HOUR) calls.shift();
      // shortcut: bounded memory and 4,000 weather attempts/day leave room for elevation requests;
      // a restart resets this allowance. Use durable accounting if weather traffic grows.
      if (calls.length >= 4000) return null;
      if (cache.size >= 200) cache.delete(cache.keys().next().value);
      hit = { at: now, body: null };
      cache.set(key, hit);
      const [latitude, longitude] = key.split(',');
      calls.push(now);
      line(async () => {
        const data = await getJson(`https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&hourly=${VARIABLES}&forecast_hours=2&wind_speed_unit=ms&timeformat=unixtime`);
        const hourly = data?.hourly;
        const i = hourly?.time?.findLastIndex(t => t * 1000 <= clock());
        if (!(i >= 0)) return;
        hit.body = { at: hourly.time[i] * 1000 };
        for (const name of VARIABLES.split(',')) hit.body[name] = hourly[name]?.[i] ?? null;
      }).catch(() => {}); // failures are cached too; no weather is a normal answer
    }
    return hit.body;
  };
}
