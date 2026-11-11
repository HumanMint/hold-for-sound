// What the "Use my location" button decides: what a reading from the device becomes, and what to say
// when there is none to use. Pure functions of plain values, shared by the page and the tests.
// app.js asks the browser, once for each press, and does what this says.
//
// A set is the exact coordinates the page has: what the microphone learns is filed under them
// (siteKey in listen-view.js), and app.js drops its tuning when they change at all. A device's
// position wanders from one reading to the next, so a reading near the place being watched is that
// place, not a new one.
// shortcut: every number here is reasoned from what phones usually report, not measured on a set.
// Revisit them if a real phone is refused outdoors, or a set moves when it should not.


// How long to wait for the device: long enough for a phone outdoors, short enough to give up and type.
export const WAIT_MS = 20_000;
// A reading that claims no better than this is not used. 100 m is the grid the flight services are
// asked on, and being that far out changes the estimate for an aircraft 300 m overhead by half a dB.
// A phone in the open reports 5 to 20 m and Wi-Fi about 65 m. Worse than 100 m is a mobile mast or
// an internet address, which can be kilometres out, and the page would be predicting for another place.
export const ROUGH_M = 100;
// A reading this near the place being watched is the same set, whatever accuracy it claims: between
// buildings a phone wanders by tens of metres while reporting better, a set is about this large, and
// 50 m changes the same estimate by a tenth of a dB.
export const SAME_M = 50;

const TYPE = 'type the address';
// Metres between two places, the short way round the globe. Flat-map arithmetic would do for a set
// anywhere people film, but it puts two points either side of the date line a world apart, and a set
// must never change because of where on Earth it is.
function apartM(a, b) {
  const rad = Math.PI / 180;
  const h = Math.sin(((b.lat - a.lat) * rad) / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(((b.lon - a.lon) * rad) / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.min(1, Math.sqrt(h)));
}
const about = (m) => (m < 950 ? `${Math.max(10, Math.round(m / 10) * 10)}\u00a0m` : `${Math.round(m / 100) / 10}\u00a0km`); // number and unit kept on one line

// `reading` is the browser's { latitude, longitude, accuracy }: accuracy is the radius in metres it
// is 95% sure of. `site` is the place being watched ({ lat, lon }), or null. Returns { q }, the text
// to put in the address field and watch, or { say } when the reading changes nothing.
export function locate({ latitude, longitude, accuracy }, site) {
  if (!(accuracy <= ROUGH_M)) return { say: `Location only good to about ${about(accuracy)}: too rough. Try again outdoors, or ${TYPE}.` };
  if (site) {
    const apart = apartM({ lat: latitude, lon: longitude }, site);
    // Two readings that are each within their accuracy of the truth can be twice that apart.
    if (apart <= Math.max(SAME_M, 2 * accuracy)) {
      return { say: `Same set: about ${about(apart)} from the spot being watched. To move it, ${TYPE}.` };
    }
  }
  // 4 decimals is about 11 m: as fine as a phone's fix gets, so the field claims no more than the device knows.
  return { q: `${latitude.toFixed(4)}, ${longitude.toFixed(4)}` };
}

// Why the browser cannot be asked at all, or '' when it can. On a plain address a browser has the
// feature and refuses to use it, so that is checked first.
export function blocked(secure, supported) {
  if (!secure) return `Location needs https. Instead, ${TYPE}.`;
  if (!supported) return `This browser can't share its location. Instead, ${TYPE}.`;
  return '';
}

// What to say when the browser was asked and gave no position. `code` is its error's: 1 not allowed,
// 2 no position to give, 3 too slow.
export function failed(code) {
  if (code === 1) return `Location is blocked. Allow it for this site in settings and press again, or ${TYPE}.`;
  if (code === 3) return `No location after ${WAIT_MS / 1000} seconds. Try again outdoors, or ${TYPE}.`;
  return `Location unavailable. Try again outdoors, or ${TYPE}.`;
}
