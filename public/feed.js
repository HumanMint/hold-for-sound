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

// After a poll that failed: `retryAt`, when the server said data may come back (the countdown shown;
// an earlier one is kept when this failure gave none), and `askAt`, when to ask it again. The server
// holds every pause itself and answers a paused request without asking the provider, so the page asks
// again within ASK_S whatever it was told. A pause the server ends early (restarted with a new key,
// say) is then seen within a minute, not after the hours a provider's quota reset can say.
export const ASK_S = 60;
export function wait(retryAfterS, now, retryAt = 0) {
  return {
    retryAt: retryAfterS > 0 ? now + retryAfterS * 1000 : Math.max(retryAt, now),
    askAt: now + Math.min(retryAfterS || 0, ASK_S) * 1000,
  };
}

// The poller's side of that: app.js asks `due(now)` before each poll, and tells it how each one went.
// `retryAt` is the countdown to show.
export function pacer() {
  let retryAt = 0;
  let askAt = 0;
  return {
    get retryAt() { return retryAt; },
    due: (now) => now >= askAt,
    failed(retryAfterS, now) { ({ retryAt, askAt } = wait(retryAfterS, now, retryAt)); },
    worked() { retryAt = askAt = 0; },
  };
}

export function retryIn(seconds) {
  const s = Math.max(0, Math.ceil(seconds));
  if (s >= 3600) return `${Math.floor(s / 3600)}h ${Math.floor(s % 3600 / 60)}m`;
  if (s >= 60) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${s}s`;
}
