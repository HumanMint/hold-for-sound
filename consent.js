// Ephemeral capabilities for sessions whose visitor has explicitly enabled sharing.
// A grant lasts an hour, and each use renews it, up to a day. One client address holds at most
// `perClient` live grants, so one script cannot take them all, and starts at most `perDay` a day:
// each grant can begin a session on disk, and revoking one does not give its start back.
// A reloaded or duplicated tab presents the grant it had and exchanges it for a new one (a new
// session), which is not charged to `perDay` but to an allowance of its own, `perDayExchanged`. The
// grant presented is left as it was, so each page owns its own token: a late close of an old page can
// end only that page's grant, and two tabs never share a session or its batch numbers.
import { randomBytes } from 'node:crypto';
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
export function consent(clock = Date.now, max = 2000, perClient = 6, perDay = 12, perDayExchanged = 48) {
  const grants = new Map();
  // client address -> when each of its grants of the last day began, oldest first: started, and exchanged
  const started = new Map();
  const exchanged = new Map();
  function prune() {
    const now = clock();
    for (const [token, grant] of grants) if (now >= grant.until) grants.delete(token);
    for (const days of [started, exchanged]) for (const [who, times] of days) {
      while (times.length && now - times[0] >= DAY) times.shift();
      if (!times.length) days.delete(who);
    }
  }
  function issue(who, days, limit) {
    prune();
    const times = days.get(who) ?? [];
    if (grants.size >= max || times.length >= limit || [...grants.values()].filter((grant) => grant.who === who).length >= perClient) return null;
    const now = clock();
    if (!days.has(who) && days.size >= 5000) days.delete(days.keys().next().value);
    days.set(who, [...times, now]);
    const grant = { id: randomBytes(8).toString('hex'), token: randomBytes(24).toString('base64url'), who, born: now, until: now + HOUR };
    grants.set(grant.token, grant);
    return grant;
  }
  return {
    start: (who) => issue(who, started, perDay),
    // A live grant of this client address, presented by a reloaded or duplicated tab, for a new one.
    exchange(grant, who) {
      if (!grant || this.get(grant.token) !== grant || grant.who !== who) return null;
      return issue(who, exchanged, perDayExchanged);
    },
    get(token) {
      const grant = grants.get(token);
      if (!grant) return null;
      if (clock() >= grant.until) { grants.delete(token); return null; }
      return grant;
    },
    // A grant the page is still using is renewed: it lasts another hour, but never past a day. One whose
    // page is closing is not.
    valid(grant) {
      if (!grant || this.get(grant.token) !== grant) return false;
      if (!grant.closing) grant.until = Math.min(grant.born + DAY, clock() + HOUR);
      return true;
    },
    // Its page is closing: the grant goes in a minute, time for the last upload. Only its own client
    // address can say so.
    close(token, who) {
      const grant = this.get(token);
      if (grant?.who === who) Object.assign(grant, { closing: true, until: Math.min(grant.until, clock() + MIN) });
    },
    stop(token) { grants.delete(token); },
    prune,
  };
}
