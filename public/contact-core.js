// What the contact form says after a send, with no page in it. `res` is the server's answer, or null
// when none came (the wait ran out or the connection dropped): the message may have gone, or not.

import { retryAfter, retryIn } from './feed.js?v=3';

export const WAIT_MS = 20_000; // how long the page waits for an answer; the server answers well within it
export const UNCONFIRMED = 'Delivery unconfirmed';

export function said(res, answer = {}) {
  // 504 is the server's own "no answer from delivery"; 524 is a proxy's, which gave up waiting on it.
  if (!res || res.status === 504 || res.status === 524) return UNCONFIRMED;
  if (res.ok) return 'Sent';
  if (res.status === 429) return `Too many messages. Try again in ${retryIn(retryAfter(res.headers.get('retry-after')) || 60)}.`;
  return answer.error || 'Not sent. Try again later.';
}
