# Starlink Flare Predictor

A standalone, mobile-friendly web app that predicts **Starlink "horizon flare"** visibility —
*when* the flares happen and *which way* to look in the sky — for either a **fixed location**
or **along a flight path**.

It shares its flare physics with Sitrec but runs completely standalone: pure browser ES modules
plus a Web Worker. No bundler, no build step, no frameworks, no TypeScript. Its only code
dependencies are the vendored `lib/satellite.es.js` (satellite.js v6, ESM) and the shared
`tools/src/DeviceOrientationCompass.js`.

The sections up to *Install as an app* are for users of the predictor. The sections after that
are for people who work on the code.

## What it does

Starlink satellites carry a large flat phased-array antenna panel that points straight down (nadir).
When the Sun, the panel, and your eye line up just right, that panel acts like a mirror and you
briefly see a bright glint — a **flare**. Because the satellites are low and the panel faces down,
these glints appear **low on the horizon** (hence "horizon flares"). They are **not** a twilight
phenomenon: the mirror geometry needs the Sun far below your horizon, about 28° to 47° for nearly
all flares, so they start well after sunset. They stop when even the satellites near the sunward
limb (the edge of the Earth toward the Sun) fall into Earth's shadow. Depending on latitude and
season, flares can return before dawn, can come only near midnight, or can be absent all night.

Given a place (and optionally a flight) and a date/time, the app propagates the Starlink orbits
(see *Data sources*), finds the moments a flare is geometrically possible from your eye, and keeps
the flares bright enough to notice. It reports the **time window**, the busiest minute, and the
**sky direction** as compass points. A horizon view places each flare by **azimuth** (compass
bearing) and **elevation**, and draws it by relative **intensity** (0 to 1, not a magnitude). The
app does not estimate how bright a flare looks.

## How to run

Open **https://www.metabunk.org/sitrec/tools/shf/** in a browser, or choose
**Sitrec → Extra Tools → Starlink Flare Predictor**. You do not need to install anything. Type a
place in **Origin**, or leave it blank for your current location, and tap **Find Flares**.

## What you get back

For a **fixed location** the app answers *"when is the next predicted flare from here?"* — it searches
**forward** from the date/time you enter to the **next window that actually produces a flare**
(skipping daytime and the deep small-hours when even limb satellites are in shadow) and shows that
window's flares. To check an event, enter a time shortly before it and compare the window with the
event time. For a **flight** it shows the flares visible during that specific flight.

The search stops one day after the time you enter. If it finds no flare, the results show
**No Flares**. This happens where the Sun does not get far enough below the horizon that night: at
50°N on 21 June, for example, and at higher latitudes through the summer. Enter a later date to
search further.

After you tap **Find Flares** the app switches to a **results screen** (with an **‹ Edit** button
top-left to change your inputs). The screen fills in as the scan runs, with a progress bar at the top:

- a compact verdict: when flares are found, a three-line header — *"Flares 21:42–21:58 PDT · peak 21:50"*
  (the peak is the busiest minute), *"Look NW → NNW"*, and *"place · date · 04:42–04:58 UTC"* (local
  time first, then UTC; the second direction appears only if the start and end compass points differ
  and the bearing shifts by at least 12°). When none are found, a **No Flares** banner with a short
  explanation;
- a **compass rose** with one or two yellow arrows for the start (and end) direction, a tapering arc
  whose thickness and brightness show the flare density by direction, and a faint animated sprinkle
  of dots for effect. On a phone with orientation sensors the dial turns with the device, so the
  arrow points the way to look. The button beside the rose turns this on and off. On iOS, tap that
  button once to allow it;
- a **horizon view**: a compass ribbon along the horizon, the brightest stars and planets (and the
  Moon) labelled for your location/time, and the predicted flares. By default the flares play back
  at real speed over faint streaks, looping over the window and skipping long gaps. Drag the Sun
  under the horizon to scrub the time. The ★ button cycles dots (with arrows for each flare's
  direction of travel), streaks and replay, and the zoom button cycles 1×, 2× and 4×. **LIVE** ties
  playback to the clock when now is inside the window. Markers along the top show the Sun's
  direction by the hour (amber) and at sunset and sunrise (orange);
- **Open in Sitrec ↗**, which opens this place and time in Sitrec, also from the No Flares screen;
- a note that says which satellite data the search used. If the download failed, tap the note to
  load current data.

![The results screen. At the top: "Flares 22:42–03:21 EDT · peak 23:46", "Look NW → NE" and "JFK, New York · Sun, Aug 15 · 02:42–07:21 UTC". Below that is a compass rose with two yellow arrows, to the NW and the NE, and a yellow arc around the rim between them, thickest about halfway between each arrow and N, and thin at the arrows. At the bottom is the horizon view: faint streaks and two bright white wedges low over the horizon, white flare dots near the left wedge, the unlabelled star Dubhe above those dots, the stars Arcturus and Capella, the Sun below the horizon, and Sun markers along the top. Under it are the legend, the Open in Sitrec button and the synthetic satellites note.](screenshots/readme-results.jpg)

*The results screen for JFK on Aug 15, 2027, with the replay at the peak, 23:46. The faint streaks are
the paths of the flares in the window. Where many paths overlap, they add up to the two bright wedges.
The white dots near the left wedge are the flares at that moment. The lone dot above them is the star
Dubhe. The app labels only the brightest stars. The scale at the right of the horizon view is
elevation, and the clock at its top left is the replay time. The **i** button opens a page about the
flares. This date is outside the range of the current data at the time of this picture, so the note
says that the app used synthetic satellites, and these flares are not a prediction of real flares.*

## Inputs

- **Origin** — an airport (IATA / ICAO / name) or any place name (geocoded). Leave it blank to use
  your current location, or tap the locate button beside the field to fill it in first. Text that
  matches part of an airport name or city goes to that airport, not to the geocoder ("Bath" gives
  Bathurst, Australia), so check the place name on the results screen.
  Times are shown in the **origin's own zone**. Airport records mostly carry one; a geocoded
  place (and the 593 airport records that have no zone) gets the zone of the nearest airport
  that does — right ~98% of the time, so the zone chip's tooltip says when it was inferred.
  A current-location origin uses the device's zone.
- **Destination** *(optional)* — turns the prediction into a **flight path**. Flares are evaluated
  along the great-circle route at cruise altitude.
- **Flight duration** *(optional)* — defaults to roughly **distance ÷ 875 km/h + 30 min**.
- **Cruise altitude** — default **37 000 ft**.
- **Date / time** — the moment to search *from* (fixed location) or the **departure** (flight).
  Defaults to your device's date and time. The app reads the field in the **location's local time**,
  so for a place in another zone, set the time yourself. To enter the time in UTC, tap the zone chip
  beside Time; the chip keeps the same instant. The browser draws
  `<input type="time">` in its own hour cycle, which the page can neither read nor override, so
  the line under the field restates the entered time in **both** cycles (`17:02 · 5:02 pm`) —
  whichever half the widget leaves out is still on screen. The time ranges and the replay clock are
  24-hour. The Sun markers on the horizon view are 12-hour (`10pm`, `Sunset 7:42pm`).
- **Advanced** — satellite data source only. A TLE (two-line element set) is a short text record of
  a satellite's orbit.
  - **Fetch current TLE** — download the live Starlink elements again. The app already does this
    when the page opens, so use this button as a retry.
  - **…or load your own .tle file** — use an element set you supply, in either CCSDS OMM (orbit
    mean-elements message) CSV or legacy TLE format. The file picker lists only `.tle` and `.txt`
    files, so rename a `.csv` file to `.txt`. A search with a file also saves it as the current set
    for one day, so after a reload the results screen can call it current data. To replace it, tap
    **Fetch current TLE**.

  By default the app uses the current Starlink elements, or a **synthetic** Starlink-like
  constellation (see *Data sources*). The results screen says which data it used. The flare cone
  (5°), minimum elevation (0°), nadir model (geocentric), and look-ahead (1 day) are fixed
  internally — they are no longer exposed as inputs.

## Accuracy caveats

- **What a result means.** The app tests geometry only. It treats every satellite's panel as a flat
  mirror that points straight down. It does not know a satellite's real attitude, and it has no
  weather data. A flare on the results screen is a predicted alignment, not a promised sighting.
- **Which satellites.** The synthetic constellation reproduces the shells and planes of one measured
  element set (`starlinkShells.js` names its date), so near that date flare counts and their pattern
  in the sky are realistic. It keeps the same number of satellites on every date, so on an older date
  it has more satellites than were in orbit and the flare count is too high. Its satellites are not
  real ones, so the time of a flare from it is not a prediction of a real flare. A file you load is
  used for any date, and its accuracy falls as the date moves away from the epoch of its elements.
  For an older event, load elements from about that date, or recreate the event in Sitrec (see
  [Investigating Starlink Flares With Sitrec](https://github.com/MickWest/Sitrec2/blob/main/docs/Starlink.md)).
- **Sun position** is accurate to ~arcminute — far finer than the flare cone.

## Data sources

- **Starlink orbits** — the current set, downloaded when the page opens through the server-cached,
  CORS-free Sitrec proxy (`sitrecServer/proxy.php?request=CURRENT_STARLINK`), falling back to
  [Celestrak](https://celestrak.org/). A synthetic constellation generated in-browser (see
  `dummyTLE.js`) replaces it for a date more than 7 days from now, past or future, or when the
  download fails. You can also load your own file. Both sources are
  requested as **CCSDS OMM CSV** rather than the legacy TLE format: TLE cannot represent
  catalog numbers above 99999, a limit the catalog passed on 2026-07-11, so TLE feeds now
  silently omit the newest Starlinks — exactly the ones a current flare search cares about.
  Legacy TLE files still load. A fetched set is
  cached (~1 day) so small date/time tweaks don't re-fetch. (The engine also drops any satellite a
  stale TLE propagates outside a LEO sanity band, so old elements can't conjure phantom flares.)
- **Geocoding** — [OpenStreetMap Nominatim](https://nominatim.openstreetmap.org/), asked for
  English (`accept-language=en`) so the place name and the country — which selects the time
  zone — do not vary with the browser's language.
- **Airports** — the [OpenFlights](https://openflights.org/data.html) dataset, bundled as
  `airports.json`. Regenerate it with `tools/shf/tools/build-airports.mjs` (see that file's header for the
  exact `npm pack airport-data` steps).

## The flare rate page

The flare rate page (`rate/index.html`, linked from the footer of the predictor) shows which nights
are good at a latitude: the expected flares per night through the year and per hour through one
night, for a latitude and night chosen with sliders. Press and drag on the year chart to choose the
night.

![Two line charts. The upper chart, "Flares per night through the year" at 34°N, has blue and orange curves with two high peaks, in May and August, and a low dip around June, and a black vertical line marked 30 May. The lower chart, "Flares per hour through the night", has the same two colors, with one hump from about 22:00 to 02:00 and zero at all other hours.](screenshots/readme-rate.jpg)

*The two charts at 34°N. In the upper chart, each point on a curve is one night, and the black line
marks the chosen night, 30 May. The lower chart shows that night hour by hour. Blue counts the
visible flares (step 8 of "The physics"), and orange also counts the faint ones.*

It uses the flux-integral model (`rate/rateModel.js`; see "The flare-rate model" in
`stats/README.md`), not this engine: the year curve from the precomputed `rate/rateTable.json`
(fetched when the page opens, cached by the service worker), the chosen night computed live in a
worker (`rate/rateWorker.js`). `rate/formula.html` explains the model, where each part comes from,
its measured accuracy, and why the curve has peaks and gaps, with live charts.

The nights are real dates, so the page covers two calendar years (`rateModel.SPAN`), the year the
shell table was measured in and the next, one year at a time. The address holds the settings
(`?lat=35&date=2027-06-21`), so it is a link to the graph. Without a latitude in the link it uses the
user's position when the browser already has permission to give it (no prompt), else 45°N.

## Install as an app (PWA)

This is an installable Progressive Web App. Over https, your browser offers **Install**
(or *Add to Home Screen* on iOS); it then launches standalone, with its own icon and no
browser chrome.

Do not rely on it offline. The service worker caches files only as the app uses them, so one visit
is not enough. When the app does run offline, it uses the synthetic constellation (or a current set
saved in the last day), and a place that is not an airport cannot be geocoded.

- `manifest.webmanifest` — app metadata: name, icons (`icons/`, including maskable +
  an SVG), theme/background color, `display: standalone`, screenshots (`screenshots/`).
- `sw.js` — service worker: network-first for navigations (fresh when online, cached
  shell when offline), cache-first for the version-stamped assets, cross-origin
  (geocoding / TLE) never cached. Its cache name carries the build stamp, so each
  deploy cleans the previous build's cache. Regenerate icons/screenshots with
  `node tools/shf/tools/generate-icons.mjs` / `node tools/shf/tools/generate-screenshots.mjs`.

## Running from source

The app uses ES modules, a module Web Worker, and `fetch`, **none of which work from `file://`** —
it must be served over **http(s)**.

- **With Sitrec:** it lives under `tools/`, which `npm run build` copies verbatim into the
  deploy, so on a development machine it is live at **https://local.metabunk.org/sitrec/tools/shf/**.
- **Any static server**, serving this folder:
  ```bash
  npx http-server tools/shf    # then open the printed http://… URL
  # or, from inside this folder:
  python3 -m http.server            # open http://localhost:8000/
  ```
  Served from this folder alone, the live compass, the Sitrec TLE proxy and **Open in Sitrec** fail.

*Cache-busting:* the deploy server caches these stable-named `.js`/`.css` files for years, so the
build stamps a timestamp into `index.html` (`app.js?v=<timestamp>`, replacing the `__BUILD_V__`
placeholder; see `webpackCopyPatterns.js`). Each module reads that `?v=` off its own
`import.meta.url` and appends it to everything it imports/fetches, so one build timestamp versions
the whole graph. `index.html` itself is revalidated (ETag), so a normal reload always picks up the
newest build. Served directly without the build, the placeholder stays the literal string
`__BUILD_V__`. The **service worker** (`sw.js`) uses the same constant as its Cache Storage name
*and* as the `?v=` on cached assets, so an un-stamped install pins one cache name forever and can
keep serving stale JS/CSS until the cache is cleared (DevTools → Application → Clear storage). The
SW caches only assets under its own folder and the shared `tools/src/` folder; dynamic same-origin
URLs like the Sitrec TLE proxy are never cached.

## The physics

The flare geometry and the cone ramp are the same as in Sitrec's `CSatellite.detectFlare`, and Sitrec
imports the ramp and the penumbra fade from `flarePhysics.js`. Sitrec's default **Satellite Brightness
Model** (**Photometric estimate**) and **Satellite Sunlight** (**Finite Sun + atmosphere**) are not
used here: sunlight is a yes/no test, and the intensity is not a Sitrec brightness. For a given
satellite, observer, and instant:

1. **Panel normal (nadir).** The flat panel faces down. Its normal is the local nadir, computed as
   either the **geocentric** up (straight from Earth's centre — the default) or the **geodetic** up
   (the ellipsoid's surface normal). The two differ by **< 0.2°**.
2. **Line of sight.** `camToSat = satEcef − observerEcef`.
3. **Above the horizon.** The satellite must not be blocked by the Earth:
   the line of sight must *not* intersect the WGS84 ellipsoid (`rayHitsEllipsoid`).
4. **Mirror reflection.** Reflect the line of sight about the panel normal
   (`vreflect`, matching Three.js `Vector3.reflect`) and normalise it.
5. **Glint angle.** Measure the angle between the reflected ray and the unit vector toward the Sun.
   A flare occurs when this angle is inside the cone (`glintDeg < flareAngleDeg`, default **5°**).
   Intensity is **1** inside the inner core and falls off quadratically over the outer ramp
   (the outermost quarter of the cone) to 0 at the cone edge.
6. **Sunlit.** The satellite itself must be in sunlight, not in Earth's shadow:
   the ray from the satellite toward the Sun must *not* hit the Earth.
7. **Sun direction.** The unit ECEF direction to the Sun, from `astro.sunEciDirection` rotated into
   ECEF via `satellite.gstime` / `satellite.eciToEcf`. The Sun is ~1 AU away, so the geocentric Sun
   direction matches the observer's to better than 0.01°.
8. **Visible.** The results use only the flares that at least double the satellite's normal
   brightness (`flarePhysics.isFlareVisible`). In full sunlight this needs a peak glint angle below
   about 4.44°. If no flare passes, the app shows them all.

## How the scan works (performance)

Propagating ~11 000 Starlinks across a multi-hour window naively is millions of SGP4 calls — too slow
for a phone. The engine uses a **two-pass scan** instead:

1. **PASS A — coarse filter** (`filterStepSec`, default 30 s). At each step it only asks *which
   satellites are above the observer's horizon*, recording their pass intervals. It also **skips any
   step outside the productive band** — Sun elevation below ≈ −56° (satellites in shadow) or
   above ≈ +6° (daytime; this limit only saves work, because flares occur with the Sun far lower) —
   so a mostly-daytime window costs almost nothing.
2. **PASS B — fine refine** (`fineStepSec`, default 2 s) runs the full flare physics over *only* those
   candidate intervals, tracking each contiguous flaring run and emitting one event at its peak (min
   glint angle).

This runs comfortably in a Web Worker on a phone. One trade-off: a very short grazing horizon pass
(shorter than `filterStepSec`) can be missed by the coarse filter — reduce `filterStepSec` for maximum
completeness near the horizon at the cost of more PASS A work.

**Finding the next flares** (`flareWorker.js`, for fixed locations; `engine.scanForward` is the same
search in the engine, used by the tests). It probes Sun elevation every 5 minutes to find the next
*productive band*. It splits the band into chunks of about 4 minutes (60 at most) and runs the two-pass
`scan` on each, working outward from the moment the Sun is nearest 40° below the horizon, so flares
appear on screen as they are found. It **stops at the first band that yields flares** — otherwise it
moves to the next band, up to the 1-day look-ahead limit. A query made at midday therefore skips ahead
to the next band almost for free, then spends about 5 to 15 s on a desktop finding the flares,
depending on the length of the band.

## File map

| File | Role |
| --- | --- |
| `geo.js` | ECEF/LLA math, vector ops, reflection, ellipsoid ray test, ENU/az-el, great-circle helpers. |
| `astro.js` | Sun direction (ECI), GMST, subsolar point, solar elevation, planet and Moon positions, equatorial→alt/az (for stars). |
| `stars.js` | Catalogue of the ~30 brightest stars (J2000 RA/Dec + magnitude) for the horizon view. |
| `flareEngine.js` | The two-pass scan, the geometry of the flare test, and the `scanForward` next-session search. |
| `flarePhysics.js` | The shared flare brightness model: cone ramp, penumbra fade, visible test. Sitrec imports parts of it from here. |
| `solarIllumination.js`, `satellitePhotometry.js` | Satellite sunlight and brightness models. Sitrec imports them from here; this app does not use them. |
| `location.js` | Origin/destination resolution: airport lookup, Nominatim geocoding, and nearest-airport time-zone inference. |
| `skyview.js` | SVG builders for the compass rose and the horizon view. |
| `app.js` | Three-screen UI (form, results, info), inputs, and result presentation; drives the worker and shows flares as they arrive. |
| `flareWorker.js` | Web Worker that propagates TLEs and runs the flare scan off the main thread, streaming the flares it finds. |
| `lib/satellite.es.js` | Vendored satellite.js v6 (SGP4 propagation, ECI→ECEF, GMST). |
| `dummyTLE.js` | The synthetic Starlink constellation (the fallback data source): every measured shell in its measured orbital planes, moved to the date at the planes' precession rate, the polar planes at their fixed local mean solar times, even phases with the measured irregularity. Within 2% of the real set's visible flare count from 50°S to 60°N over the five nights tested (see `stats/README.md`, "Constellation"). |
| `starlinkShells.js` | The measured shell table that drives `dummyTLE.js` and the rate model: inclination, altitude, count and planes of every shell, from a CelesTrak element set (the file names its source and date). Generated; refresh it with `node tools/shf/tools/measure-shells.mjs <omm.csv>`. |
| `airports.json` | Bundled OpenFlights airport list (regenerate via `tools/shf/tools/build-airports.mjs`). |
| `manifest.webmanifest` | PWA manifest (installable app metadata). |
| `sw.js` | Service worker (offline + installability); cache name carries the build stamp. |
| `icons/`, `screenshots/` | App icons (incl. maskable + SVG), manifest screenshots, and the images on this page. |
| `tools/test-*.mjs` | Node tests: foundation (geo/astro), engine, location, skyview, the synthetic constellation (`test-dummytle.mjs`), OMM parsing (`test-omm.mjs`), statistics (`test-stats.mjs`), the rate model and its year table (`test-rate.mjs`, against the frozen engine-truth snapshots in `tools/fixtures/rate-truth.json` and `rate-year.json`); `verify-browser.mjs` is a headless end-to-end check (incl. PWA). Run them with `npm test` and `npm run test:browser` in `tools/shf`. |
| `tools/measure-shells.mjs` | Measures the constellation from a CelesTrak OMM CSV (standard group or supplemental) and writes `starlinkShells.js`. Usage in its header. Then rebuild the year table (next row). |
| `tools/build-rate-table.mjs` | Precomputes the rate page's year curve from the model into `rate/rateTable.json`: every night of the model's span (two calendar years, the year of the shell table's reference epoch and the next: 730 nights) at every half degree of latitude, both kinds; about 39 minutes on 12 worker threads (`--workers 12`). Run it after the shell table or the model changes; the page refuses a table built for another shell table or span. |
| `stats/` | Command-line tool: flares per night through a year and per hour, by latitude, as CSV and an Excel workbook with charts. It uses this engine. A page in the folder (`stats/index.html`) shows the charts in a browser. See `stats/README.md`. |
| `rate/` | The flare rate page and its model. See *The flare rate page*. |
| `lineChart.js`, `lineChart.css` | The SVG line chart with a crosshair tooltip, used by `stats/` and `rate/`. |

## Conventions

- ES modules; relative imports include the `.js` extension (browser-native, no bundler).
- Distances in **kilometres**; angles in **degrees** in public APIs.
- Vectors are `{x, y, z}` plain objects in **ECEF (km)**.
