// What drives an aircraft, from what its feed row already says: its ICAO type designator (`t`), else
// the size category its transponder reports. Pure, shared by the page and the tests.
// Returns 'jet', 'turboprop', 'piston', 'prop' (a propeller, not known which), 'heli', or null.
// shortcut: a small hand-made table of common types and families. A type not in it is unknown: a size
// category says nothing about the engine (a C-130 is a large turboprop, an SJ30 a light jet), except
// that a rotorcraft is a helicopter. Grow the table from the session logs if many show as unknown.

const HELI = /^(R22|R44|R66|AS50|AS55|AS65|AS32|EC\d\d|H160|A1[0-8]9|B06T?|B4(07|12|27|29|30)|B505|S76|S92|H60|UH1|H47|H64|MD52|MD60|H500|EN28|EN48|G2CA|KMAX|V22)$/;
const JET =
  /^(A3\d\d|A3\dK|A[12]\dN|B7\d[\dA-Z]|B3[789X]M|BCS[13]|CRJ\d|E1[79]\d|E1[34]5|E35L|E45X|E[12]9[05]|E75[LS]|E50P|E55P|E545|E550|MD[89]\d|DC\d\d|C(25[ABC]|5\d[\dX]|6[58][0A]|7[05]0)|HDJT|SF50|EA50|PC24|PRM1|BE40|B46[123]|RJ[178][05X]|LJ\d\d|CL30|CL35|CL60|C101|GL[57]T|GLEX|GLF\d|G150|G280|GALX|ASTR|FA\d[\dX]|F2TH|F900|H25[ABC]|C17|K35R|T38|F16|F18|F35)$/;
const TURBOPROP =
  /^(AT[4-7]\d|DH8[A-D]|DHC6|DHC7|B190|BE9L|BE99|BE10|BE20|BE30|B350|PC6T|PC7|PC9|PC12|PC21|C208|C425|C441|SF34|SB20|E120|JS3[12]|JS41|D228|D328|F50|L410|SW4|TBM[7-9]|P180|P46T|KODI|C130|C30J|C212|CL44|A400|C295|AT[5-8]T)$/;
const PISTON = /^(C1\d\d|C2\d\d|C3\d\d|C4\d\d|[PT]2\d\d|T18\d|P28.|P32.|PA\d\d|BE\d\d|SR2\d|S22T|DA\d\d|DV20|M20.|AA5|BL8|CH7.|SLG\d|PTS\d|RV\d+|J3|SHIP)$/; // SHIP: an airship, which has piston engines

const BY_CATEGORY = { A7: 'heli' };

export function engine({ t, category }) {
  // The order matters where the patterns overlap: C208 and BE20 are turboprops, BE40 a jet.
  for (const [kind, re] of [['heli', HELI], ['jet', JET], ['turboprop', TURBOPROP], ['piston', PISTON]]) if (re.test(t ?? '')) return kind;
  return BY_CATEGORY[category] ?? null;
}

// The icon's shape: everything with a propeller looks the same.
export const shape = (kind) => (kind === 'turboprop' || kind === 'piston' ? 'prop' : kind ?? 'unknown');
export const ENGINE_NAME = { jet: 'Jet', turboprop: 'Turboprop', piston: 'Piston propeller', prop: 'Propeller', heli: 'Helicopter' };
