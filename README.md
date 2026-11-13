<img src="assets/icon.svg" width="64" height="64" alt="">

# hold-for-sound

A web page that warns a film-set sound mixer before an aircraft is audible at the set, for how long, and when it is clear again. It is a personal experiment, not a commercial service, and everything it shows is an estimate.

## Run it

Needs Node 22 or newer. Nothing to install.

```sh
npm start   # http://127.0.0.1:8787
npm test
```

It also listens on this machine's Tailscale address when Tailscale is running, never on the local network. Enter the set's address or coordinates, and whether the microphone is outdoors, indoors, in a warehouse or on a purpose-built soundstage.

## Try it without live data

```sh
REPLAY=test/fixtures/lax.jsonl npm start
```

Then enter `33.938, -118.440`. This plays about six and a half minutes of recorded traffic beside LAX on a loop.

## Settings

All optional, as environment variables:

- `PORT`: the port to listen on.
- `PASSWORD`: the page and its data need this password; the notices page does not.
- `LOG_DIR`: a folder for sessions that visitors choose to share; without it, sharing is not offered.
- `ADSB_LOL_KEY`: an adsb.lol API key, sent to adsb.lol only.
- `ADSB_LOL_DAY`: how many adsb.lol requests the server makes in a day before it pauses.
- `ADSB_LOL_WEEK`: the same, over 7 days.
- `ADSB_LOL_MONTH`: the same, over 30 days.
- `CONTACT_URL`: where the contact form's messages are posted, as JSON; without it, there is no contact form.
- `CONTACT_TOKEN`: sent with each message to `CONTACT_URL` as `Authorization: Bearer`.
- `CONTACT_SITEKEY`: a Cloudflare Turnstile site key. The contact form then shows Turnstile's check, loaded when the form is first opened, and each message adds `token` (its response) and `ip` (the sender's address) to the JSON for `CONTACT_URL` to verify; a 400 from there tells the sender to complete the check again.
- `RECEIVER`: the URL of an ADS-B receiver's `aircraft.json`, whose aircraft are added to the feed.
- `PUBLIC_HOST`: public mode: the host name to answer to, behind a proxy such as Cloudflare, listening on loopback only and with tighter limits.
- `OWNER_PORT`: in public mode, a loopback port that serves the traffic counters.

## How it predicts

Every 5 seconds the page asks for the aircraft within 30 nautical miles and steps each one's path forward 8 minutes, estimating the loudness at the set from the aircraft's type, flight phase, direction, distance, height and the building's insulation. An aircraft is listed when that estimate rises above the warning level.

The microphone choices keep separate learned observations: Outdoors, Indoors (windows shut), Warehouse (a converted or lightweight stage), and Soundstage (purpose-built). Existing saved choices keep their meanings.

`shortcut:` building losses and default warning floors are uncalibrated guesses, to replace with measured levels at the microphone. Loss / floor in dB / dBA: outdoors 0 / 45, indoors 25 / 35, warehouse 25 / 30, soundstage 45 / 25. The warehouse loss is below the roughly 30 dB lightweight-roof estimate, to avoid assuming too much protection; its floor sits between a room and a quiet stage. Indoor 25 follows the closed-window aircraft reductions (24–28 dB). Stage 45 stays below the purpose-built roof STC range (48–55), but STC is not an aircraft-noise reduction measurement and does not guarantee low-frequency protection. Open or tilted windows belong under Outdoors for a conservative warning.

`shortcut:` helicopters retain 80% of each building loss for rotor thump; the factor needs measured low-frequency data. Jets keep the full loss because the indoor basis already measures aircraft noise; no frequency-specific evidence supports a separate jet factor yet. Roof leakage and low-frequency rumble remain uncertainties.

- On a runway, or on its centreline up to 200 m before its end: it accelerates, lifts off and climbs straight out. At 10 knots or more and speeding up, it is taken to be rolling.
- Stopped at a holding point beside a runway end: treated like a taxiing aircraft, which may take off.
- On final approach: it follows the centreline down, touches down and rolls out, quieter as it slows.
- After landing, still fast on the runway: the rest of its rollout.
- A helicopter: judged by its last minute of flight, with a widening spread of headings.
- Anything else: it keeps its speed, heading and climb.
- An aircraft the feed loses is carried on from its last position for up to 2 minutes, shown as an estimate. One lost while lined up on a runway, whether the feed drops it or goes on listing an old position, can go at any moment: for those 2 minutes the page says it cannot tell, never Clear.

In public mode the server asks the flight feed for a place every 10 seconds while an aircraft may matter soon (one that could come within about 10 km, or that is moving on the ground nearby), and once a minute while the sky is quiet, or every 30 seconds within 5 km of a runway; the page cannot ask faster. A quiet answer is trusted for 80 seconds (40 beside a runway), and Clear then says **Checked every 1:00** (or **0:30**): a takeoff the feed did not see on the ground can show up to that much later.

Source levels use a small table of conservative type offsets, with engine and size fallbacks. Takeoff power falls to a guessed cutback level after climbing 450 m above the runway; other climbs, descents, approaches and rollout have separate levels. Jets gain an aft lobe strongest around 130° from the nose, propellers a broadside lobe, and helicopters a descent increment. Unknown direction uses the loudest lobe. Learned per-category microphone corrections still add to these levels.

Propagation uses spherical spreading from the rounded 305 m source reference, frequency-dependent air absorption at 15 °C and 70% relative humidity (ISO 9613-1), and the lateral-distance and elevation-angle attenuation in [ECAC Doc 29 Volume 2, sections 4.5.3–4.5.5](https://www.ecac-ceac.org/images/documents/ECAC-Doc_29_4th_edition_Dec_2016_Volume_2.pdf), adapted from SAE AIR5662. Absorption is applied only beyond the reference distance. Jets use a mid/high-frequency spectrum; propellers, pistons and helicopters share a lower-frequency spectrum. Unknown engine types use the latter, because less absorption gives the safer warning. The representative A-weighted octave spectra are uncalibrated guesses, not standard aircraft spectra. The coefficients are [ISO 9613-1 equations](https://acoustic-toolbox.readthedocs.io/en/latest/standards/iso_9613_1_1993/); a precomputed table keeps prediction cheap.

The lateral-distance factor vanishes directly beneath the aircraft. Each time sample is treated as a short segment, using its horizontal source-to-set distance and elevation as the nearest-point geometry in Doc 29 section 4.5.5, rather than integrating a whole noise event. Ground type, bank and engine mounting are unknown: shielding is capped at an uncalibrated 3 dB and the previous horizon allowance, and installation uses the loudest of the standard wing, fuselage and unshielded corrections. These are conservative, uncalibrated approximations (`shortcut:`), including for takeoff rolls; the soft-ground standard alone can remove about 10.9 dB at zero elevation. Buildings and terrain are not mapped.

The loudness numbers are guesses, not measurements. Turns away from a runway are not foreseen, and aircraft that do not broadcast their position never appear.

## Listening

**Listen with the microphone** compares what the set hears with the predictions. It learns the background, matches aircraft by their Doppler pitch or by when the noise rose, reports noise no tracked aircraft explains, and can tune the warning level after several aircraft. Every threshold is a guess. **Try it with demo sound** runs the same steps on made-up sound.

## Privacy

The sound is analysed in the browser and is never recorded, stored or sent. Settings stay in the browser. The location is asked for only when **Use my location** is pressed. The server holds addresses looked up, and IP addresses, in memory for up to a day, never on disk. Nothing else about a session is kept unless the visitor switches on **Share data with the developer**, which is offered only when `LOG_DIR` is set. [`public/about.html`](public/about.html) lists what is sent where.

## Data and credits

- Flight data: [adsb.lol](https://adsb.lol), under the [Open Database License 1.0](https://opendatacommons.org/licenses/odbl/1-0/); [adsb.fi](https://adsb.fi), for non-commercial use only.
- Address lookup and map: [OpenStreetMap](https://www.openstreetmap.org/copyright) (Nominatim and standard tiles), data under the Open Database License; use follows the [Nominatim](https://operations.osmfoundation.org/policies/nominatim/) and [tile](https://operations.osmfoundation.org/policies/tiles/) usage policies.
- Elevation: [Open-Meteo](https://open-meteo.com/), under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). "Copernicus WorldDEM-90 © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA".
- Aircraft source offsets: [EASA certification noise levels](https://www.easa.europa.eu/en/domains/environment/easa-certification-noise-levels), jet workbook `MAdB_JETS_20261112_`, © European Union Aviation Safety Agency. [Reproduction is authorised with source acknowledgement unless otherwise stated](https://www.easa.europa.eu/copyright-disclaimer). The small derived table uses rounded nonnegative differences between maximum lateral/approach certification levels and the ERJ 170 family reference; EPNdB differences are only rough relative proxies, not measured dBA or a conversion to LAmax. Power and directional terms are independent uncalibrated guesses. ANP curves are not included: their terms require registered access and restrict use and redistribution.
- Runways: [OurAirports](https://ourairports.com/data/), public domain.
- The recording in `test/fixtures/` contains information from adsb.lol, under the Open Database License 1.0.

## Licence

[PolyForm Noncommercial 1.0.0](LICENSE). The typeface in `public/fonts/` (Barlow Semi Condensed) is under the SIL Open Font License (`public/fonts/OFL.txt`).

Questions and problems: open an issue on this repository.
