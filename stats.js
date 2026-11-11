// Traffic counters, so the operator can see whether a public link is being hit by strangers.
// Kept in memory only, and gone at a restart. No client address is ever written to the log, and none
// is held for more than a day.
import { isIPv6 } from 'node:net';

const HOUR = 3600_000;
const DAY = 24 * HOUR;

// The client's address. A proxy in front puts the real one in x-forwarded-for, replacing anything
// the client sent.
export const client = (req) => (req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress || '').slice(0, 64);

// The client a per-client limit counts: an IPv4 address as it is (also when IPv6-mapped), and an IPv6
// address as its /64, since one network is given the whole /64 to choose from.
export function network(address) {
  const ip = address.replace(/%.*$/, '').toLowerCase();
  if (!isIPv6(ip)) return address;
  // Each group as a number; an IPv4 address written at the end is the last two groups.
  const groups = (part) => (part ? part.split(':').flatMap((g) => (g.includes('.') ? ((b) => [b[0] * 256 + b[1], b[2] * 256 + b[3]])(g.split('.').map(Number)) : [parseInt(g, 16)])) : []);
  const [head, tail] = ip.split('::');
  const all = tail === undefined ? groups(head) : [...groups(head), ...Array(8 - groups(head).length - groups(tail).length).fill(0), ...groups(tail)];
  if (all.slice(0, 5).every((g) => !g) && all[5] === 0xffff) return [all[6] >> 8, all[6] & 255, all[7] >> 8, all[7] & 255].join('.');
  return `${all.slice(0, 4).map((g) => g.toString(16)).join(':')}::/64`;
}

// True for a request made on this machine itself. The proxy also connects from here, but it always
// sets x-forwarded-for.
export const direct = (req) => /^(::ffff:)?127\.|^::1$/.test(req.socket.remoteAddress) && !('x-forwarded-for' in req.headers);

// Keys seen lately, each with when it was last seen. Past `max` keys, or a day, the one seen longest
// ago is forgotten, so memory stays bounded whatever is thrown at it.
// shortcut: no count can pass `max`; raise it if the link ever has that many real visitors a day.
function lately(max) {
  const seen = new Map(); // key -> epoch ms, the longest ago first
  return {
    add(key, now) {
      seen.delete(key);
      seen.set(key, now);
      if (seen.size > max) seen.delete(seen.keys().next().value);
    },
    drop: (key) => seen.delete(key),
    // Forgets keys a day old; how many are left.
    prune(now) {
      for (const [key, at] of seen) if (now - at >= DAY) seen.delete(key); else break;
      return seen.size;
    },
    within(ms, now) {
      this.prune(now);
      return [...seen.values()].filter((at) => now - at < ms).length;
    },
  };
}

export function traffic(clock = Date.now, max = 5000) {
  const since = clock();
  const total = { requests: 0, pages: 0, api: 0, refused: 0, badPasswords: 0, upstream: 0 };
  let logged = { ...total }; // the totals when the last log line was written
  const visitors = lately(max);
  const strangers = lately(max);
  const sets = lately(max);
  return {
    count: (what) => total[what]++,
    // An address that gets in is no stranger, even if it saw the login page first.
    visitor(address) {
      visitors.add(address, clock());
      strangers.drop(address);
    },
    stranger(address) {
      total.refused++;
      strangers.add(address, clock());
    },
    watching: (set) => sets.add(set, clock()),
    // Run by the server's maintenance timer, so no address outlives a day while nobody reads the
    // counters. The answer is how many addresses are still held.
    prune() {
      const now = clock();
      sets.prune(now);
      return visitors.prune(now) + strangers.prune(now);
    },
    // What /api/stats answers. An optional local dashboard can read this shape: don't change it.
    report() {
      const now = clock();
      const distinct = (who) => ({ hour: who.within(HOUR, now), day: who.within(24 * HOUR, now) });
      return { since, now, ...total, visitors: distinct(visitors), strangers: distinct(strangers), addresses: sets.within(60_000, now) };
    },
    // One line for the log about the `ms` since the last one, or null when nothing happened in it.
    line(ms) {
      const now = clock();
      const counts = Object.keys(total).map((name) => [name, total[name] - logged[name]]);
      logged = { ...total };
      if (!counts.some(([, n]) => n)) return null;
      counts.push(['visitors', visitors.within(ms, now)], ['strangers', strangers.within(ms, now)], ['addresses', sets.within(60_000, now)]);
      return `traffic, ${ms / 60_000} min: ${counts.map(([name, n]) => `${n} ${name}`).join(', ')}`;
    },
  };
}
