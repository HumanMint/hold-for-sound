// HTTP failures must stay failures, including an HTML error page from the public proxy.
// Retry-After is shared with the server, which pauses the upstream across all watched locations.
export function retryAfter(value, now = Date.now()) {
  if (!value) return 0;
  const seconds = Number(value);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now;
  return Number.isFinite(ms) ? Math.max(0, Math.ceil(ms / 1000)) : 0;
}

export async function feedResponse(response) {
  const fail = (message) => Object.assign(new Error(message), {
    name: 'FeedError', retryAfter: retryAfter(response.headers.get('retry-after')) || (response.status === 429 ? 60 : 0),
  });
  let quota = false;
  if (response.status === 429) {
    try { quota = (await response.json())?.code === 'flight_quota'; }
    catch (error) { if (error.name === 'AbortError') throw error; }
  }
  if (!response.ok) throw fail(quota ? 'Flight-data provider quota exhausted.' : response.status === 429
    ? 'Flight-data service is busy. Retrying automatically.'
    : 'Flight-data service is unavailable. Retrying automatically.');
  let data;
  try { data = await response.json(); } catch (error) {
    if (error.name === 'AbortError') throw error;
    throw fail('Flight-data service returned an unreadable response. Retrying automatically.');
  }
  if (!Array.isArray(data?.ac)) throw fail('Flight-data service returned incomplete data. Retrying automatically.');
  return data;
}

export function retryIn(seconds) {
  const s = Math.max(0, Math.ceil(seconds));
  if (s >= 3600) return `${Math.floor(s / 3600)}h ${Math.floor(s % 3600 / 60)}m`;
  if (s >= 60) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${s}s`;
}
