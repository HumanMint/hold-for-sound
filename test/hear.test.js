import test from 'node:test';
import assert from 'node:assert/strict';
import { predict } from '../public/predict.js';
import { createEar, FREQS } from '../public/hear.js';
import { createSynth, fundamentalOf } from '../public/synth.js';
import { tune, remember, TRUSTED } from '../public/tune.js';

// Everything here is heard through synth.js: these tests show the engine does what it was designed
// to do on invented sound. They say nothing about real aircraft through a real phone.

const RATE = 16000;
const START = 1_800_000_000_000;
const site = { lat: 40, lon: -100, elevM: 0 };

// An aircraft flying straight and level that is over the point `east`/`north` metres from the set
// `over` seconds in. Returns the function that gives its feed row at any second.
const plane = ({ hex, category, track, kt, ft, over, east = 0, north = 0 }) => (s) => {
  const gone = kt * 0.5144 * (s - over);
  const x = east + gone * Math.sin((track * Math.PI) / 180);
  const y = north + gone * Math.cos((track * Math.PI) / 180);
  return { hex, category, lat: site.lat + y / 111195, lon: site.lon + x / (111195 * Math.cos((site.lat * Math.PI) / 180)), alt_baro: ft, gs: kt, track, seen_pos: 0 };
};
const tracksOf = (planes, s, trim) => planes.map((p) => predict(p(s), site, { loss: 0, floor: -Infinity, trim })).filter(Boolean);

// The page's loop without the page. Every 5 s the aircraft in `feed` are predicted and handed to the
// ear, the ones in `sounding` are turned into sound, and the ear hears it a second at a time. `each`
// gets the status after every second. `floor` and `trim` may be functions, to feed tuning back in.
// `sound` may change the tracks that are turned into sound: it gets them and the second they are for.
function listen({ seconds, feed = [], sounding = feed, floor = 50, trim = {}, synth = {}, sound = (tracks) => tracks, each }) {
  const ear = createEar({ sampleRate: RATE });
  const voice = createSynth({ sampleRate: RATE, ...synth });
  const now = (v) => (typeof v === 'function' ? v() : v);
  for (let s = 0; s < seconds; s += 5) {
    const at = START + s * 1000;
    ear.update({ at, tracks: tracksOf(feed, s, now(trim)), trim: now(trim), floor: now(floor) });
    const pcm = voice.render(sound(tracksOf(sounding, s), s), at, at, 5);
    for (let i = 0; i < 5; i++) {
      ear.push(pcm.subarray(i * RATE, (i + 1) * RATE), at + (i + 1) * 1000);
      each?.(ear.status(), s + i + 1, ear);
    }
  }
  return ear;
}
// Who the ear named, second by second: "hex/how" -> how many seconds. `at` picks seconds to keep the status of.
function named({ at = [], each, ...run }) {
  const seconds = {};
  const statuses = {};
  const ear = listen({
    ...run,
    each(status, s, ear) {
      for (const h of status.heard) seconds[`${h.hex}/${h.how}`] = (seconds[`${h.hex}/${h.how}`] ?? 0) + 1;
      if (at.includes(s)) statuses[s] = status;
      each?.(status, s, ear);
    },
  });
  return { seconds, statuses, observations: ear.observations(), ear };
}
const aircraftNamed = (seconds) => Object.keys(seconds).filter((key) => !key.startsWith('null/'));

test('a tone lands in the right bin at the right level, at any sample rate and block size', () => {
  for (const sampleRate of [16000, 44100, 48000]) {
    const pcm = Float32Array.from({ length: 2.05 * sampleRate }, (_, i) => 0.5 * Math.sin((2 * Math.PI * 440 * i) / sampleRate));
    const columns = createEar({ sampleRate }).push(pcm, START + 2050);
    assert.equal(columns.length, 15, 'a quarter second to fill the first, then 8 a second');
    assert.ok(Math.abs(columns[0].at - (START + 125)) < 1 && Math.abs(columns[14].at - (START + 1875)) < 1, 'stamped with the middle of what they cover');
    const { db } = columns[14];
    const peak = db.indexOf(Math.max(...db));
    assert.ok(Math.abs(FREQS[peak] / 440 - 1) < 0.01, `${sampleRate}: peak at ${FREQS[peak]} Hz`);
    assert.ok(Math.abs(db[peak] + 6) < 1.5, `${sampleRate}: half scale is -6 dB, got ${db[peak]}`);

    // The same audio in awkward pieces gives the same columns.
    const pieces = createEar({ sampleRate });
    const again = [];
    for (let i = 0; i < pcm.length; i += 1000) again.push(...pieces.push(pcm.subarray(i, i + 1000), START + (Math.min(i + 1000, pcm.length) / sampleRate) * 1000));
    assert.equal(again.length, 15);
    assert.ok(again[14].db.every((v, b) => Math.abs(v - db[b]) < 1e-3));
  }
  // A jump in time means the microphone stopped: what came before is not joined to what comes after.
  const ear = createEar({ sampleRate: RATE });
  const short = new Float32Array(0.2 * RATE);
  assert.equal(ear.push(short, START + 200).length + ear.push(short, START + 400).length, 2);
  assert.equal(ear.push(short, START + 10_200).length, 0);
});

// Three light aircraft the page expects, but only the first makes a sound. One decoy flies the same
// route 25 s behind; the other crosses 1.2 km to the north at the same moment.
const prop = plane({ hex: 'a1b2c3', category: 'A1', track: 0, kt: 140, ft: 1000, over: 65 });
const behind = plane({ hex: 'decoy1', category: 'A1', track: 0, kt: 140, ft: 1000, over: 90 });
const beside = plane({ hex: 'decoy2', category: 'A1', track: 90, kt: 140, ft: 1000, over: 65, north: 1200 });

test('a propeller aircraft is picked out of three candidates by its Doppler curve, and its note recovered', () => {
  const note = fundamentalOf({ hex: 'a1b2c3', category: 'A1' });
  const { seconds, statuses, observations, ear } = named({
    at: [50, 80],
    seconds: 135,
    feed: [prop, behind, beside],
    sounding: [prop],
    synth: { background: 40, speech: { db: 60 } }, // with people talking over it
  });
  assert.deepEqual(aircraftNamed(seconds).map((key) => key.split('/')[0]).filter((hex) => hex !== 'a1b2c3'), [], 'no decoy is ever named');
  assert.ok(seconds['a1b2c3/doppler'] >= 25, `named by its tones for ${seconds['a1b2c3/doppler']} s`);
  // Coming straight in, its pitch is not changing yet, so tones could not be told from a steady hum.
  assert.ok(statuses[50].expected.find((e) => e.hex === 'a1b2c3').swing < 2 && !statuses[50].heard.some((h) => h.how === 'doppler'));
  assert.deepEqual(statuses[80].expected.map((e) => e.hex).sort(), ['a1b2c3', 'decoy1', 'decoy2'], 'all three are expected at once');
  assert.ok(statuses[80].expected.find((e) => e.hex === 'a1b2c3').swing > 40);

  const pass = observations.find((o) => o.hex === 'a1b2c3');
  assert.equal(pass.how, 'doppler');
  assert.ok(pass.confidence >= 0.9, `confidence ${pass.confidence}`);
  assert.ok(Math.abs(pass.fundamental / note - 1) < 0.02, `note ${pass.fundamental} Hz, really ${note}`);
  assert.ok(Math.abs(pass.floor - 40) < 2, `aircraft exactly as loud as predicted over a 40 dB background: floor ${pass.floor}`);
  assert.ok(Math.abs(pass.peakErr) <= 2 && Math.abs(pass.onsetErr) <= 3, `timing ${pass.onsetErr} s, ${pass.peakErr} s`);
  assert.equal(observations.find((o) => o.hex === 'decoy2').how, 'unsure', 'the decoy that was predicted at the same time learns nothing');

  // The curve to draw over the spectrogram: above the note coming in, on it overhead, below it going away.
  const curve = ear.curve('a1b2c3', note, START + 35_000, START + 95_000, 1000);
  assert.ok(curve[0] > note * 1.2 && curve[60] < note * 0.85, `${curve[0]} to ${curve[60]}`);
  assert.ok(Math.abs(curve[31] / note - 1) < 0.03, 'heard at its true pitch as it passes overhead');
  assert.ok(curve.every((hz, i) => i === 0 || hz <= curve[i - 1]));
  assert.ok(Number.isNaN(ear.curve('nobody', note, START, START, 1000)[0]));
});

test('a steady hum with harmonics is not pinned on any aircraft', () => {
  // The hum starts after the background is learned, while three silent aircraft pass with changing Doppler.
  const { seconds, observations } = named({ seconds: 115, feed: [prop, behind, beside], sounding: [], synth: { hum: { hz: 60, db: 50, from: START + 30_000 } } });
  assert.deepEqual(aircraftNamed(seconds), []);
  assert.ok(seconds['null/level'] > 30, 'it is heard as noise, just not as one of them');
  assert.deepEqual(remember([], observations), [], 'and nothing is learned from those passes');
});

const jet = plane({ hex: 'jet001', category: 'A3', track: 90, kt: 250, ft: 3000, over: 55 });
const lookalike = plane({ hex: 'jet002', category: 'A3', track: 90, kt: 250, ft: 3000, over: 57, north: 400 });
const loud50 = { seconds: 100, floor: 60, synth: { background: 50 } };
const quietJets = (over) => over.map((s) => plane({ hex: `jet${s}`, category: 'A3', track: s, kt: 250, ft: 3000, over: s }));

test('a jet with no tones is heard by its swell, and named only when one candidate explains it', () => {
  const alone = named({ ...loud50, feed: [jet] });
  assert.deepEqual(aircraftNamed(alone.seconds), ['jet001/envelope']);
  assert.ok(alone.seconds['jet001/envelope'] >= 25);
  const [pass] = alone.observations;
  assert.equal(pass.how, 'envelope');
  assert.ok(pass.confidence >= TRUSTED);
  assert.ok(Math.abs(pass.floor - 50) < 2, `floor ${pass.floor}`);
  assert.ok(Math.abs(pass.peakErr) <= 2 && Math.abs(pass.onsetErr) <= 3);
  assert.equal(pass.curve.pred.length, pass.curve.rise.length);
  assert.deepEqual(JSON.parse(JSON.stringify(pass)), pass, 'plain JSON, ready for localStorage');

  // Two jets predicted over the set within two seconds of each other: it could be either.
  const two = named({ ...loud50, feed: [jet, lookalike], sounding: [jet] });
  assert.deepEqual(aircraftNamed(two.seconds), []);
  assert.ok(two.seconds['null/level'] >= 30);
  assert.deepEqual(two.observations.map((o) => o.how), ['unsure', 'unsure']);

  // The same jet with no transponder: heard, and reported as explained by no track.
  let nobody = 0;
  const dark = listen({ ...loud50, feed: [], sounding: [jet], each: (status) => (nobody += status.heard.some((h) => h.hex === null && h.candidates.length === 0)) });
  assert.ok(nobody >= 30);
  const [event] = dark.observations();
  assert.equal(event.how, 'unexplained');
  assert.ok(event.rise > 10 && event.seconds > 30);
});

test('speech-like bursts 30 dB over the background do not count as aircraft', () => {
  let noise = 0;
  let most = 0;
  const ear = listen({
    seconds: 120,
    synth: { background: 40, speech: { db: 70 } },
    each: (status) => ((noise += status.noise || status.heard.length), (most = Math.max(most, status.rise))),
  });
  assert.equal(noise, 0);
  assert.ok(most < 1.5, `the level rose ${most} dB`);
  assert.deepEqual(ear.observations(), []);
});

test('an aircraft that makes no sound is recorded as unheard, and counts once this engine has heard one', () => {
  const { seconds, observations } = named({ ...loud50, feed: [jet], sounding: [], synth: { background: 50, speech: { db: 70 } } });
  assert.deepEqual(seconds, {});
  const [pass] = observations;
  assert.equal(pass.how, 'unheard');
  assert.equal(pass.heard, false);
  assert.ok(pass.predPeak > 60 && pass.floor === null);
  assert.ok(pass.confidence < TRUSTED, 'a microphone that has heard no aircraft yet may be covered, or the wrong one');

  // One aircraft heard and measured, and the next to pass in silence is evidence.
  const jets = quietJets([60, 120]);
  const later = named({ ...loud50, seconds: 180, feed: jets, sounding: [jets[0]] }).observations;
  assert.deepEqual(later.map((o) => `${o.hex} ${o.how} ${o.confidence >= TRUSTED ? 'trusted' : 'doubted'}`), ['jet60 envelope trusted', 'jet120 unheard trusted']);
});

test('a page reopened with a deaf microphone does not raise a floor learned on an earlier day', () => {
  // Four passes heard last time gave a floor of 50. Today the microphone gives only its own hiss, 100 dB
  // down (covered, or the wrong input), and three jets predicted 16 dB over that floor go by.
  const earlier = [49.6, 50.1, 50.3, 50.8].map((floor) => ({ hex: 'abc123', category: 'A3', how: 'envelope', heard: true, confidence: 0.75, predPeak: 66, floor }));
  const { seconds, observations } = named({ ...loud50, seconds: 240, feed: quietJets([60, 120, 180]), sounding: [], synth: { background: 0 } });
  assert.deepEqual(seconds, {});
  assert.deepEqual(observations.map((o) => `${o.how} ${o.predPeak > 65}`), Array(3).fill('unheard true'));
  assert.deepEqual(remember(earlier, observations), earlier, 'none of them is kept');
  assert.equal(tune(remember(earlier, observations)).floor, 50.2);
});

test('the past of a track is what earlier polls said, not the newest poll projected backwards', () => {
  const ear = createEar({ sampleRate: RATE });
  const north = plane({ hex: 'turner', category: 'A1', track: 0, kt: 140, ft: 1000, over: 20 });
  ear.update({ at: START, tracks: tracksOf([north], 0), floor: 50 });
  const past = ear.curve('turner', 100, START - 20_000, START + 3000, 1000);
  const ahead = ear.curve('turner', 100, START + 15_000, START + 40_000, 1000);
  // Five seconds on it has turned east, so the new poll's idea of where it came from is wrong.
  const turned = { ...north(5), track: 90 };
  ear.update({ at: START + 5000, tracks: [predict(turned, site, { loss: 0, floor: -Infinity })], floor: 50 });
  assert.deepEqual(ear.curve('turner', 100, START - 20_000, START + 3000, 1000), past);
  assert.notDeepEqual(ear.curve('turner', 100, START + 15_000, START + 40_000, 1000), ahead);
});

test('twenty passes in a world 8 dB louder than predicted teach the floor, and it holds up', () => {
  // Jets and light aircraft a minute apart, at different heights, offsets and headings, over a
  // background loud enough that it is quiet between them. The page starts out believing a floor of 70
  // and follows what is learned, as it does through `hfs:tune`.
  const traffic = Array.from({ length: 20 }, (_, i) =>
    i % 3 === 2
      ? plane({ hex: `prop${i}`, category: 'A1', track: 40 * i, kt: 140, ft: 800 + 100 * (i % 4), over: 60 + 60 * i, east: 100 * (i % 3) })
      : plane({ hex: `jet${i}`, category: 'A3', track: 40 * i, kt: 250, ft: 1500 + 250 * (i % 5), over: 60 + 60 * i, east: 200 * (i % 4) }),
  );
  let stored = [];
  let learned = tune(stored);
  const history = [];
  listen({
    seconds: 1260,
    feed: traffic,
    floor: () => learned.floor ?? 70,
    trim: () => learned.trim,
    synth: { background: 65, louder: 8 },
    each(status, s, ear) {
      const fresh = ear.observations();
      if (!fresh.length) return;
      stored = remember(stored, fresh);
      learned = tune(stored);
      history.push(learned.floor);
    },
  });
  // Aircraft are 8 dB louder than predicted over a 65 dB background, so one predicted at 57 is just audible.
  assert.equal(stored.length, 20, 'every pass was heard confidently enough to keep');
  assert.deepEqual(history.slice(0, 3), [null, null, null], 'no floor until there is enough to go on');
  assert.ok(Math.abs(learned.floor - 57) <= 2, `learned ${learned.floor}`);
  assert.ok(learned.settled && learned.heard === 20 && learned.error <= 2);
  assert.ok(history.slice(3).every((floor) => Math.abs(floor - 57) <= 2), `on the way: ${history}`);
  assert.deepEqual(learned.trim, {}, 'both kinds are 8 dB louder, so neither is trimmed against the other');

  const wild = { ...stored[0], floor: stored[0].floor + 40 };
  assert.ok(Math.abs(tune([...stored, wild]).floor - learned.floor) <= 1, 'one wild pass barely moves it');

  // Aircraft predicted well above the floor that nobody heard do not move it, however many: a covered
  // microphone hears nothing either.
  const silent = { ...stored[0], how: 'unheard', heard: false, floor: null, confidence: 0.7, predPeak: learned.floor + 8 };
  assert.equal(tune([...stored, ...Array(40).fill(silent)]).floor, learned.floor);

  const doubtful = { ...stored[0], how: 'unsure', heard: null, confidence: 0.2, floor: 90 };
  const faint = { ...stored[0], confidence: 0.3, floor: 90 };
  assert.deepEqual(tune([...stored, ...Array(10).fill(doubtful), ...Array(10).fill(faint)]), learned, 'nothing is learned from low-confidence passes');
  assert.equal(remember(stored, [doubtful, faint]).length, 20);
});

// What follows guards against learning something false. Each case was first seen going wrong.

const due80 = plane({ hex: 'jet080', category: 'A3', track: 90, kt: 250, ft: 3000, over: 80 });

test('a microphone that gives nothing names nobody and records nothing', () => {
  // Half a minute of room noise, then nothing at all, or as good as nothing, while a jet is predicted overhead.
  for (const [what, db] of [['digital silence', -Infinity], ['90 dB down', -90]]) {
    const { seconds, statuses, observations } = named({ at: [25, 80], seconds: 130, feed: [due80], sounding: [], synth: { gain: { db, from: START + 30_000 } } });
    assert.deepEqual(seconds, {}, `${what}: nobody is named`);
    assert.equal(statuses[25].signal, true);
    assert.ok(statuses[80].signal === false && !statuses[80].ready && !statuses[80].noise, `${what}: the status says there is no signal`);
    assert.deepEqual(observations, [], `${what}: no pass is recorded, heard or unheard`);
  }
  // The page can also say so itself, for a microphone the browser reports as muted while sound still arrives.
  const signal = {};
  const told = named({
    seconds: 130,
    feed: [due80],
    each(status, s, ear) {
      if (s === 30) ear.mute(true);
      if (s === 110) ear.mute(false);
      signal[s] = ear.status().signal;
    },
  });
  assert.deepEqual([signal[29], signal[30], signal[80], signal[110], signal[112]], [true, false, false, false, true]);
  assert.deepEqual([told.seconds, told.observations], [{}, []], 'a jet that passed while it was muted leaves no trace');
});

// A motor's tone, at one steady loudness from 25 to 125 s. Its pitch is `hz` at 70 s, and u seconds from
// then it is hz * exp(slide * u + bend * u * u): `slide` is a steady drift, `bend` makes it curve.
const motor = (hz, slide, bend = 0, harmonics = 1) => ({ hz: hz * Math.exp(-45 * slide + 2025 * bend), db: 55, slide: slide - 90 * bend, bend, harmonics, from: START + 25_000, to: START + 125_000 });
const silent = (category, kt, ft, over) => plane({ hex: 'silent', category, track: 0, kt, ft, over });
// Nobody is named while it plays beside that one silent aircraft, and nothing is learned.
function notAnAircraft(what, quiet, synth) {
  const { seconds, observations } = named({ seconds: 150, feed: [quiet], sounding: [], synth });
  assert.deepEqual(aircraftNamed(seconds), [], what);
  assert.ok(seconds['null/level'] > 30, `${what}: it is heard as noise`);
  assert.deepEqual(remember([], observations), [], `${what}: nothing is learned from it`);
}

test('a tone that drifts steadily is not taken for an aircraft whose Doppler curve it crosses', () => {
  // No aircraft makes a sound. A whine drifts by a fraction of a percent a second, as a motor running
  // down or up does, while a silent light aircraft passes: for a while the two curves run side by side.
  // Only a straight line through the places the tone was seen tells them apart.
  for (const slide of [-0.003, -0.0015, 0.003]) notAnAircraft(`sliding ${slide * 100} % a second`, silent('A1', 140, 3000, 65), { tone: motor(650, slide) });
  // With ten harmonics the falling curve slides off one onto the next one down, and the sightings lie
  // on two lines: each stretch of them needs a line of its own.
  notAnAircraft('ten harmonics', silent('A1', 140, 3000, 65), { tone: motor(88, -0.004, 0, 10) });
  // At the very bottom and top of what it listens to, a steady tone would land outside the spectrogram
  // once the aircraft's Doppler shift is undone the other way: where that cannot be checked, no claim.
  for (const hz of [52, 3930]) notAnAircraft(`a steady ${hz} Hz`, silent('A1', 140, 1000, 65), { tone: motor(hz, 0) });
});

test('a motor whose pitch bends is not taken for an aircraft either', () => {
  // Four harmonics of 180 Hz falling 0.4 % a second and a little faster as it goes, beside a light
  // aircraft low overhead: the curve is nearly a straight line for the 30 s that are searched.
  notAnAircraft('bending a little', silent('A1', 140, 1000, 70), { tone: motor(180, -0.004, -0.00004, 4) });
  // Bending more, on eight harmonics: each beats a straight line by a little, short of the bar, and
  // those leftovers must not add up to an aircraft.
  notAnAircraft('bending more, eight harmonics', silent('A1', 100, 1500, 85), { tone: motor(420, -0.006, -0.0003, 8) });
  // With people talking over it the sightings come in pieces, and a line through one piece is only a
  // tangent: the line through all of them is the one to beat.
  notAnAircraft('bending, under speech', silent('A1', 120, 5000, 85), { tone: motor(300, -0.004, -0.00012, 8), speech: { db: 72 } });
});

test('tones alone do not make a pass that is learned from', () => {
  // The worst case for the tone check: a light aircraft's own tones, Doppler and all, but at one steady
  // loudness for 70 s, as no aircraft passing overhead sounds. Then a jet that makes no sound at all.
  const light = plane({ hex: 'a1b2c3', category: 'A1', track: 0, kt: 140, ft: 1000, over: 70 });
  const steady = (tracks, s) => tracks.map((w) => ({ ...w, path: w.path.map((p) => ({ ...p, db: Math.abs(s + p.t - 70) < 35 ? 55 : -Infinity })) }));
  const { seconds, observations } = named({ seconds: 250, feed: [light, plane({ hex: 'jet170', category: 'A3', track: 90, kt: 250, ft: 5000, over: 170 })], sounding: [light], sound: steady });
  assert.ok(seconds['a1b2c3/doppler'] >= 10, 'the tones do follow its curve');
  const pass = observations.find((o) => o.hex === 'a1b2c3');
  assert.deepEqual([pass.how, pass.floor, pass.peakErr], ['doppler', null, null], 'but the loudness was not an aircraft passing');
  assert.ok(pass.confidence < TRUSTED, `so it is doubted: ${pass.confidence}`);
  const after = observations.find((o) => o.hex === 'jet170');
  assert.ok(after.how === 'unheard' && after.confidence < TRUSTED, 'and it does not show that this microphone hears aircraft');
});

test('steady noise is not pinned on the only aircraft around', () => {
  // One silent jet, high and slow, so its predicted loudness hardly changes for minutes: with nothing
  // to compare it against, a noise that switches on and stays on must not be read as its swell. Nor
  // must one that switches on, or off, just as a faster jet's swell is due.
  const slow = plane({ hex: 'slowjet', category: 'A3', track: 90, kt: 140, ft: 10000, over: 65 });
  const swift = (over) => plane({ hex: 'swift1', category: 'A3', track: 90, kt: 250, ft: 3000, over });
  const cases = [
    ['a hum', slow, { hum: { hz: 60, db: 50, from: START + 30_000 } }],
    ['a fan', slow, { fan: { db: 50, from: START + 30_000 } }],
    ['a hum that starts as a jet is due', swift(45), { hum: { hz: 60, db: 50, from: START + 40_000 } }],
    ['a fan that starts as a jet is due', swift(45), { fan: { db: 50, from: START + 40_000 } }],
  ];
  for (const [what, quiet, synth] of cases) {
    const { seconds, observations } = named({ seconds: 135, feed: [quiet], sounding: [], synth });
    assert.deepEqual(aircraftNamed(seconds), [], what);
    assert.ok(seconds['null/level'] > 20, `${what} is heard as noise`);
    assert.deepEqual(remember([], observations), [], `nothing is learned from ${what}`);
  }
  // Harder: steady tones that swell and fade just as the jet was predicted to. The timing is an
  // aircraft's, but nothing passing overhead holds one pitch: it is the same flight in a light
  // aircraft's voice, heard as if from one spot 300 m away.
  const voice = plane({ hex: 'hum', category: 'A1', track: 90, kt: 250, ft: 3000, over: 70 });
  const fixed = (tracks) => tracks.map((w) => ({ ...w, path: w.path.map((p) => ({ ...p, x: 0, y: 0, alt: 300, heardAt: p.t + 300 / 343, db: p.db + 12 })) }));
  const { seconds, observations } = named({ seconds: 150, feed: [swift(70)], sounding: [voice], sound: fixed });
  assert.deepEqual(aircraftNamed(seconds), [], 'a hum that swells like the jet is not named, to its last second');
  assert.ok(seconds['null/level'] > 50);
  assert.deepEqual(remember([], observations), [], 'and is not learned from');
  // A hum that was there from the first seconds is the usual level of its bins. When it stops as a jet
  // is due, those bins fall below usual: a dip is no tone, and must not cancel what the hum was.
  const stopped = named({ seconds: 120, feed: [swift(45)], sounding: [], synth: { hum: { hz: 400, db: 48, from: START + 8000, to: START + 34_000 } } });
  assert.deepEqual([aircraftNamed(stopped.seconds), remember([], stopped.observations)], [[], []], 'a hum that stops is not an aircraft arriving');
});

test('an aircraft is measured only while it is the loudest thing predicted', () => {
  const at = (over, kind) =>
    kind === 'prop' ? plane({ hex: 'a1b2c3', category: 'A1', track: 0, kt: 140, ft: 1000, over }) : plane({ hex: 'jet001', category: 'A3', track: 90, kt: 200, ft: 1000, over });
  // A light aircraft and a jet 12 dB louder, close enough that the jet's peak falls inside the light
  // aircraft's pass, in either order. Each is still alone at its own peak.
  for (const [first, second, gap] of [['prop', 'jet', 18], ['jet', 'prop', 25]]) {
    const { observations } = named({ seconds: 160, feed: [at(65, first), at(65 + gap, second)] });
    const pass = observations.find((o) => o.hex === 'a1b2c3');
    assert.equal(pass.how, 'doppler', `${first} first: known by its tones`);
    assert.ok(Math.abs(pass.floor - 40) < 2 && Math.abs(pass.peakErr) <= 2, `${first} first: floor ${pass.floor}, peak ${pass.peakErr} s out, from its own swell and not the jet's`);
    for (const o of remember([], observations)) assert.ok(Math.abs(o.floor - 40) < 2, `${first} first: ${o.hex} stored with floor ${o.floor}`);
  }
  // With the jet only 18 s ahead it is still within 10 dB as the light aircraft peaks. Its tones say who
  // it is, but how much of the rise was its own cannot be said, so it is left out of learning.
  const { observations } = named({ seconds: 160, feed: [at(65, 'jet'), at(83, 'prop')] });
  const pass = observations.find((o) => o.hex === 'a1b2c3');
  assert.deepEqual([pass.how, pass.heard, pass.floor, pass.peakErr], ['doppler', true, null, null]);
  assert.ok(pass.confidence < TRUSTED, 'a pass that could not be measured is never a trusted one');
  assert.deepEqual(remember([], observations).map((o) => o.hex), ['jet001'], 'the jet, alone at its own peak, is still learned from');
});

test('something with no track does not lend its peak to the aircraft that was expected', () => {
  const light = plane({ hex: 'a1b2c3', category: 'A1', track: 0, kt: 140, ft: 1000, over: 80 });
  const dark = (over) => plane({ hex: 'dark', category: 'A3', track: 90, kt: 200, ft: 1000, over });
  // Slow, low and to one side: it swells over half a minute, as a truck going by does.
  const truck = plane({ hex: 'truck', category: 'A2', track: 90, kt: 40, ft: 150, over: 80, north: 300 });
  // The light aircraft is the only one predicted, so nothing says it is not alone.
  for (const [what, other] of [['a jet 18 s after it', dark(98)], ['a jet 18 s before it', dark(62)], ['a slow swell at the same moment', truck]]) {
    const { observations } = named({ seconds: 135, feed: [light], sounding: [light, other] });
    const pass = observations.find((o) => o.hex === 'a1b2c3');
    assert.deepEqual([pass.how, pass.floor, pass.peakErr], ['doppler', null, null], `${what}: its tones say who it was, and no more`);
    assert.ok(pass.confidence < TRUSTED, `${what}: confidence ${pass.confidence}`);
    assert.deepEqual(remember([], observations), [], `${what}: nothing is learned`);
  }
  // Half a minute later the jet is clear of it, and it is measured as if it were alone.
  const clear = named({ seconds: 135, feed: [light], sounding: [light, dark(110)] }).observations.find((o) => o.hex === 'a1b2c3');
  assert.ok(clear.confidence >= 0.9 && Math.abs(clear.floor - 40) < 2 && Math.abs(clear.peakErr) <= 2, `floor ${clear.floor}`);
  // The same for an aircraft known only by its swell: a jet, with another 12 s behind it.
  const jet80 = plane({ hex: 'jet080', category: 'A3', track: 90, kt: 250, ft: 3000, over: 80 });
  const swell = named({ ...loud50, seconds: 130, feed: [jet80], sounding: [jet80, plane({ hex: 'dark', category: 'A3', track: 20, kt: 200, ft: 2000, over: 92 })] }).observations.find((o) => o.hex === 'jet080');
  assert.ok(swell.floor === null && swell.confidence < TRUSTED, `${swell.how}, floor ${swell.floor}, confidence ${swell.confidence}`);
});

test('what a silent microphone misses does not raise a floor it had learned', () => {
  // Four jets heard a minute apart, then two more that pass while the microphone gives nothing.
  let stored = [];
  let before = null;
  let dead = 0;
  listen({
    ...loud50,
    seconds: 420,
    feed: quietJets([60, 120, 180, 240, 300, 360]),
    synth: { background: 50, gain: { db: -Infinity, from: START + 285_000 } },
    each(status, s, ear) {
      stored = remember(stored, ear.observations());
      if (s === 285) before = tune(stored);
      dead += s > 290 && status.signal === false;
    },
  });
  assert.ok(before.heard === 4 && Math.abs(before.floor - 50) < 2, `learned ${before.floor} from ${before.heard} passes`);
  assert.deepEqual(tune(stored), before, 'the floor is where it was');
  assert.equal(dead, 130, 'and the status says there is no signal for as long as that lasts');
});

test('after the microphone is turned down, silence counts for nothing until an aircraft is heard again', () => {
  // Turned down 30 dB at 100 s. Of the jets predicted after that, only the one at 280 s makes a sound.
  const jets = quietJets([60, 160, 220, 280, 340]);
  const { observations } = named({ ...loud50, seconds: 400, feed: jets, sounding: [jets[0], jets[3]], synth: { background: 50, gain: { db: -30, from: START + 100_000 } } });
  const how = Object.fromEntries(observations.map((o) => [o.hex, `${o.how} ${o.confidence >= TRUSTED ? 'trusted' : 'doubted'}`]));
  assert.deepEqual(how, { jet60: 'envelope trusted', jet160: 'unheard doubted', jet220: 'unheard doubted', jet280: 'envelope trusted', jet340: 'unheard trusted' });
  const heard = observations.filter((o) => o.heard);
  assert.ok(heard.every((o) => Math.abs(o.floor - 50) < 2), `turning it down does not change what is audible: ${heard.map((o) => o.floor)}`);
});

test('noise that no expected aircraft explains is still recorded as unexplained', () => {
  // A jet with no transponder passes at 55 s. Another, predicted for 95 s, never makes a sound, but
  // becomes a candidate while the first is still dying away.
  const later = plane({ hex: 'jet095', category: 'A3', track: 0, kt: 250, ft: 3000, over: 95 });
  const { seconds, observations } = named({ ...loud50, seconds: 150, feed: [later], sounding: [jet] });
  assert.deepEqual(aircraftNamed(seconds), []);
  assert.deepEqual(observations.map((o) => o.how).sort(), ['unexplained', 'unheard']);
  const event = observations.find((o) => o.how === 'unexplained');
  assert.ok(event.hex === null && event.rise > 10 && event.seconds > 30, `${event.rise} dB for ${event.seconds} s`);
});

test('observations nobody collects stop at 200, whatever kind they are', () => {
  // 205 silent aircraft pass at once, then a jet with no transponder: one more record of another kind.
  const crowd = Array.from({ length: 205 }, (_, i) => plane({ hex: `mute${i}`, category: 'A3', track: (360 * i) / 205, kt: 250, ft: 3000, over: 50 }));
  const ear = listen({ ...loud50, seconds: 180, feed: crowd, sounding: [plane({ hex: 'dark', category: 'A3', track: 90, kt: 250, ft: 3000, over: 135 })] });
  const waiting = ear.observations();
  assert.equal(waiting.length, 200);
  assert.equal(waiting.at(-1).how, 'unexplained', 'the newest are the ones kept');
});

test('a trim in effect changes neither the peak that is stored nor the floor that is learned', () => {
  // The same jet, heard the same, while the page is trimming large jets up, not at all, and down.
  const passes = [6, 0, -6].map((db) => named({ ...loud50, seconds: 130, feed: [jet], trim: { A3: db } }).observations[0]);
  for (const pass of passes) {
    assert.equal(pass.how, 'envelope');
    assert.ok(Math.abs(pass.predPeak - passes[1].predPeak) <= 0.1, `peak stored as ${passes.map((o) => o.predPeak)}`);
    assert.ok(Math.abs(pass.floor - passes[1].floor) <= 0.5, `floor learned as ${passes.map((o) => o.floor)}`);
  }
  assert.ok(Math.abs(passes[1].floor - 50) < 2);
});
