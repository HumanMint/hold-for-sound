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

Every 5 seconds the page asks for the aircraft within 30 nautical miles and steps each one's path forward 8 minutes, estimating the loudness at the set from the aircraft's size, distance, height and the building's insulation. An aircraft is listed when that estimate rises above the warning level.

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

The loudness numbers are guesses, not measurements. Turns away from a runway are not foreseen, and aircraft that do not broadcast their position never appear.

## Listening

**Listen with the microphone** compares what the set hears with the predictions. It learns the background, matches aircraft by their Doppler pitch or by when the noise rose, reports noise no tracked aircraft explains, and can tune the warning level after several aircraft. Every threshold is a guess. **Try it with demo sound** runs the same steps on made-up sound.

## Privacy

The sound is analysed in the browser and is never recorded, stored or sent. Settings stay in the browser. The location is asked for only when **Use my location** is pressed. The server holds addresses looked up, and IP addresses, in memory for up to a day, never on disk. Nothing else about a session is kept unless the visitor switches on **Share data with the developer**, which is offered only when `LOG_DIR` is set. [`public/about.html`](public/about.html) lists what is sent where.

## Data and credits

- Flight data: [adsb.lol](https://adsb.lol), under the [Open Database License 1.0](https://opendatacommons.org/licenses/odbl/1-0/); [adsb.fi](https://adsb.fi), for non-commercial use only.
- Address lookup and map: [OpenStreetMap](https://www.openstreetmap.org/copyright) (Nominatim and standard tiles), data under the Open Database License; use follows the [Nominatim](https://operations.osmfoundation.org/policies/nominatim/) and [tile](https://operations.osmfoundation.org/policies/tiles/) usage policies.
- Elevation: [Open-Meteo](https://open-meteo.com/), under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). "Copernicus WorldDEM-90 © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA".
- Runways: [OurAirports](https://ourairports.com/data/), public domain.
- The recording in `test/fixtures/` contains information from adsb.lol, under the Open Database License 1.0.

## Licence

[PolyForm Noncommercial 1.0.0](LICENSE). The typeface in `public/fonts/` (Barlow Semi Condensed) is under the SIL Open Font License (`public/fonts/OFL.txt`).

Questions and problems: open an issue on this repository.
