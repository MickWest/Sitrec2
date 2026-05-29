# Starlink Flare Predictor

A standalone, mobile-friendly web app that predicts **Starlink "horizon flare"** visibility —
*when* the flares happen and *which way* to look in the sky — for either a **fixed location**
or **along a flight path**.

It reuses Sitrec's flare physics but runs completely standalone: pure browser ES modules plus a
Web Worker. No bundler, no build step, no frameworks, no TypeScript. The only external dependency
is the vendored `lib/satellite.es.js` (satellite.js v6, ESM).

## What it does

Starlink satellites carry a large flat phased-array antenna panel that points straight down (nadir).
When the Sun, the panel, and your eye line up just right, that panel acts like a mirror and you
briefly see a bright glint — a **flare**. Because the satellites are low and the panel faces down,
these glints typically appear **low on the horizon**, often clustered around twilight.

Given a place (and optionally a flight), a date/time, and a search window, the app propagates the
current Starlink constellation, finds every moment a flare is geometrically possible from your eye,
and reports the **time**, **sky direction** (azimuth / compass point), **elevation**, and relative
**intensity** of each predicted flare.

## The physics

This mirrors Sitrec's `CSatellite.detectFlare` / `CNodeDisplayNightSky` flare model exactly. For a
given satellite, observer, and instant:

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

Credit: this flare model is a direct port of Sitrec's `CSatellite` flare detection.

## How to run

The app uses ES modules, a module Web Worker, and `fetch`, **none of which work from `file://`** —
it must be served over **http(s)**.

- **Easiest (with Sitrec):** it lives under `tools/`, which `npm run build` copies verbatim into the
  deploy, so it is live at **https://local.metabunk.org/sitrec/tools/starlink/**.

  *Cache-busting:* the deploy server caches these stable-named `.js`/`.css` files for years, so to
  make updates appear without a hard refresh the build stamps a timestamp into `index.html`
  (`app.js?v=<timestamp>`). Each module reads that `?v=` off its own `import.meta.url` and appends it
  to everything it imports/fetches, so one build timestamp versions the whole graph. `index.html`
  itself is revalidated (ETag), so a normal reload always picks up the newest build. The stamping
  happens in `webpackCopyPatterns.js` (replacing the `__BUILD_V__` placeholder); served directly
  without the build, the placeholder is a harmless constant.
- **Any static server**, serving this folder:
  ```bash
  npx http-server tools/starlink    # then open the printed http://… URL
  # or, from inside this folder:
  python3 -m http.server            # open http://localhost:8000/
  ```

## What you get back

For a **fixed location** the app answers *"when will I next see a flare from here?"* — it searches
**forward** from the date/time you enter to the **next twilight session that actually produces a
flare** (skipping daytime and deep night, which can be days away) and lists that session's flares.
For a **flight** it lists the flares visible during that specific flight.

After you tap **Find Flares** the app switches to a **results screen** (with an **‹ Edit** button
top-left to change your inputs):

- a big **FLARES VISIBLE** / **No Flares** verdict;
- a one-sentence summary — *"Flares will be visible from 21:42 to 21:58 PDT (04:42–04:58 UTC) on …,
  starting in the **NW** and moving toward the **NNW**"* (local time first, then UTC; a second
  direction is shown only if the bearing shifts by more than a compass point);
- a **compass rose** with one or two yellow arrows for the start (and end) direction;
- a **horizon view** for the start time: a compass ribbon along the horizon, the brightest stars
  labelled (computed for your location/time), and the predicted flares as yellow markers with little
  arrows showing each one's direction of travel across the sky;
- a collapsible list of every individual flare (time, direction, elevation, brightness, satellite).

## Inputs

- **Origin** — an airport (IATA / ICAO / name) or any place name (geocoded). Required.
- **Destination** *(optional)* — turns the prediction into a **flight path**. Flares are evaluated
  along the great-circle route at cruise altitude.
- **Flight duration** *(optional)* — defaults to roughly **distance ÷ 875 km/h + 30 min**.
- **Cruise altitude** — default **37 000 ft**.
- **Date / time** — the moment to search *from* (fixed location) or the **departure** (flight).
  Defaults to **now**, interpreted in the **location's local time**.
- **Advanced:**
  - **Cone angle** — flare half-angle threshold (default **5°**).
  - **Minimum elevation** — ignore flares too low to see.
  - **Nadir model** — geocentric (default) or geodetic.
  - **Look ahead (days)** — for a fixed location, how far forward to search for the next flares
    before giving up (default **3**).

## Data sources

- **Starlink TLEs** — fetched at runtime. When deployed under Sitrec it uses the server-cached,
  CORS-free Sitrec proxy (`sitrecServer/proxy.php?request=CURRENT_STARLINK`), falling back to
  [Celestrak](https://celestrak.org/) directly, then to a `.tle` file you load by hand. The fetched
  set is cached in `sessionStorage` for the session.
- **Geocoding** — [OpenStreetMap Nominatim](https://nominatim.openstreetmap.org/).
- **Airports** — the [OpenFlights](https://openflights.org/data.html) dataset, bundled as
  `airports.json`. Regenerate it with `tools/build-airports.mjs` (see that file's header for the
  exact `npm pack airport-data` steps).

## Accuracy caveats

- **TLE freshness.** TLEs are most accurate within a few days of "now". Dates far in the past or
  future degrade as the orbits drift from the propagated elements.
- **Sun position** is accurate to ~arcminute — far finer than the flare cone.
- **Nadir model.** Geocentric vs geodetic nadir differ by **< 0.2°**; the default (geocentric)
  matches Sitrec.
- **Twilight clustering.** Flares need a sunlit satellite against a dark-enough sky, so predictions
  cluster around dawn/dusk twilight.

## How the scan works (performance)

Propagating ~7 000 Starlinks across a multi-hour window naively is millions of SGP4 calls — too slow
for a phone. The engine uses a **two-pass scan** instead:

1. **PASS A — coarse filter** (`filterStepSec`, default 30 s). At each step it only asks *which
   satellites are above the observer's horizon*, recording their pass intervals. It also **skips any
   step outside the productive twilight band** — Sun elevation below ≈ −40° (satellites in shadow) or
   above ≈ +6° (sky too bright) — so a mostly-daytime window costs almost nothing. `stats.productiveSteps`
   reports how many coarse steps fell inside the band.
2. **PASS B — fine refine** (`fineStepSec`, default 2 s) runs the full flare physics over *only* those
   candidate intervals, tracking each contiguous flaring run and emitting one event at its peak (min
   glint angle).

This runs comfortably in a Web Worker on a phone. One trade-off: a very short grazing horizon pass
(shorter than `filterStepSec`) can be missed by the coarse filter — reduce `filterStepSec` for maximum
completeness near the horizon at the cost of more PASS A work.

**Finding the next flares** (`engine.scanForward`, used for fixed locations). It probes Sun elevation
every 5 minutes to find the next *twilight band*, runs the two-pass `scan` over just that band, and
**stops at the first band that yields flares** — otherwise it advances to the next dawn/dusk, up to a
look-ahead limit. A query made at midday therefore skips ahead to the next dusk almost for free
(daytime costs only sun-elevation probes), then spends ~1–2 s finding the flares.

## File map

| File | Role |
| --- | --- |
| `geo.js` | ECEF/LLA math, vector ops, reflection, ellipsoid ray test, ENU/az-el, great-circle helpers. |
| `astro.js` | Sun direction (ECI), GMST, subsolar point, solar elevation, equatorial→alt/az (for stars). |
| `stars.js` | Catalogue of the ~30 brightest stars (J2000 RA/Dec + magnitude) for the horizon view. |
| `flareEngine.js` | Flare physics, the two-pass scan, and the `scanForward` next-session search. |
| `location.js` | Origin/destination resolution: airport lookup and Nominatim geocoding. |
| `skyview.js` | SVG builders for the compass rose and the horizon view. |
| `app.js` | Two-screen UI (form ↔ results), inputs, and result presentation; drives the worker. |
| `flareWorker.js` | Web Worker that propagates TLEs and runs the flare scan off the main thread. |
| `lib/satellite.es.js` | Vendored satellite.js v6 (SGP4 propagation, ECI→ECEF, GMST). |
| `airports.json` | Bundled OpenFlights airport list (regenerate via `tools/build-airports.mjs`). |
| `tools/test-*.mjs` | Node tests: foundation (geo/astro), engine, location, skyview; `verify-browser.mjs` is a headless end-to-end check. |

## Conventions

- ES modules; relative imports include the `.js` extension (browser-native, no bundler).
- Distances in **kilometres**; angles in **degrees** in public APIs.
- Vectors are `{x, y, z}` plain objects in **ECEF (km)**.
