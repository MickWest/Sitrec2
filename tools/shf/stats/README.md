# Starlink Flare Statistics

A command-line tool that counts Starlink horizon flares for every night of a year, at a
set of latitudes, and writes the results as CSV tables and an Excel workbook with charts:

- **flares per night through the year**, one line per latitude;
- **flares per local solar hour**, one line per latitude, for the whole year and for
  each month.

It uses the flare predictor's own engine (`../flareEngine.js`), synthetic constellation
(`../dummyTLE.js`) and `satellite.js`. It has no copy of the physics, so its counts are the
flares the predictor would show for the same place and night.

## Run it

From the repository root (Node 18 or later):

```bash
node tools/shf/stats/flare-stats.mjs --year 2026
```

A full year at the 7 default latitudes is 2,555 night scans. That takes about 50 minutes
on 13 worker threads. For a quick look first, scan every 7th night:

```bash
node tools/shf/stats/flare-stats.mjs --year 2026 --step-days 7
```

The output goes to `./flare-stats-out/`. Git and the Sitrec build both ignore that name.

| Option | Default | Meaning |
|---|---|---|
| `--year YYYY` | this year | scan every night of this year |
| `--from` / `--to YYYY-MM-DD` | 1 Jan / 31 Dec | a custom range of nights |
| `--step-days N` | 1 | scan every Nth night |
| `--lats LIST` | `0,20,35,45,55,65,-35` | latitudes, south negative |
| `--lon DEG` | 0 | observer longitude |
| `--alt-km KM` | 0 | observer altitude (11.3 km is a 37,000 ft cruise) |
| `--min-el DEG` | 0 | ignore flares below this elevation |
| `--tle FILE` | synthetic | a real TLE or OMM CSV file (see below) |
| `--workers N` | CPUs − 1 | worker threads |
| `--out DIR` | `flare-stats-out` | output directory |
| `--aggregate-only` | | rebuild the tables from the cache, no scanning |
| `--no-xlsx` | | CSV only |

### Resuming and extending

Each night is appended to `<out>/nights.jsonl` as soon as it is scanned. Run the same
command again after an interruption and it continues. A later run with more latitudes, or
with `--step-days 1` after a weekly preview, scans only the nights that are not in the
cache yet. The cache key includes the longitude, altitude, minimum elevation,
constellation and model version, so different settings can share one output directory.
The model version is a hash of the engine, physics, constellation and `satellite.js`
source files and the worker that runs them. After any change to them, the tool scans every night again and does not mix
old results with new ones.

Each run deletes the old `FlareStats.xlsx` before it writes new tables. A workbook in the
output directory therefore always matches the CSV files next to it.

## Output

| File | Contents |
|---|---|
| `flares_per_night_visible.csv` | one row per night, one column per latitude |
| `flares_per_hour_year_visible.csv` | mean flares per night in each local solar hour, over all nights |
| `flares_per_hour_by_month_visible.csv` | the same, for each month (24-row blocks) |
| `…_all.csv` | the same three tables, including faint flares |
| `summary.csv` | per latitude: total, mean per night, busiest night, nights with none |
| `FlareStats.xlsx` | all of the above, with a line chart on each sheet |
| `run.json` | the settings of the run |
| `nights.jsonl` | the per-night cache |

The workbook needs Python 3 with `openpyxl` (`pip3 install openpyxl`). Without it the tool
writes the CSV files only. To rebuild the workbook from existing CSV files:

```bash
python3 tools/shf/stats/make-xlsx.py flare-stats-out
```

## View the charts in a browser

`index.html` in this folder draws the same charts as the workbook, with a tooltip that
gives every latitude's value at the pointer. Open it from a Sitrec build at
`https://local.metabunk.org/sitrec/tools/shf/stats/`, then choose the output folder or
drop its files on the page. The browser reads the files locally and uploads nothing.
To load results from a folder on the same site, add `?data=<folder path>/` to the address.
The viewer refuses a folder on another host, so a link cannot make it send requests
elsewhere.

The controls choose visible or all flares, and show or hide each latitude. Each chart has
a table of its values under it.

## Definitions

- **Each count is for one observer at one place**, at the given latitude, longitude
  (`--lon`) and altitude (`--alt-km`). It is the number of flares that observer can see
  in the whole sky above their horizon. It is not a worldwide total: one glint is seen
  only from a small area on the ground, about 100–200 km across. The constellation is
  spread evenly in longitude, and the hours are local solar time, so the longitude
  changes the counts very little.
- **Night of D** is from local mean solar noon on D to noon on D+1. Each dark period is
  counted once, and is not split at midnight.
- **Local solar hour** is local mean solar time: UTC + longitude / 15 hours. There are no
  time zones and no daylight saving time, so all latitudes share one clock.
- **All** flares are all glints inside the 5° flare cone: the reflected sunlight comes
  within 5° of the observer.
- **Visible** flares are the glints that at least double the satellite's base
  brightness. The predictor and Sitrec's night sky use this same test
  (`isFlareVisible` in `../flarePhysics.js`). The glint is at full brightness within 3.75°
  of exact alignment and fades to zero at 5°, so a fully sunlit satellite passes the test
  when its glint angle is less than about 4.44°. A satellite that is partly in the Earth's
  shadow needs a smaller angle.
- The brightness is Sitrec's own scale, not an astronomical magnitude. Neither count
  includes the sky conditions: twilight, haze near the horizon, the Moon, or light
  pollution.
- A flare is counted in the hour of its **peak**.

## Approximate formula

A formula derived from the flare geometry gives the smooth curve that the nightly counts
scatter about. The day-to-day scatter of the counts is about the same size as counting
noise (the square root of the count), so the smooth curve is the expected number.

The panel faces straight down, so it reflects only sunlight that comes from below the
satellite's horizontal. The reflected ray therefore always passes just above the Earth's
edge, and a flare needs the Sun a certain distance below the observer's horizon: about
28° to 47°, depending on the satellite's altitude. Flares are low in the sky (below about
15°) and toward the Sun's direction below the horizon.

Angles are in degrees, and P = 3.14159.

Inputs: L = observer latitude (north positive); N = day of year (1 January = 0);
T = local solar time in hours; R = 6371 km; G = glint limit (5 for all flares, 4.44 for
visible flares); K = 0.01049 (visible) or 0.01173 (all).

Sun at the observer:

- S = −23.44 × cos(360 × (N + 10) / 365.25) (solar declination)
- H = 15 × (T − 12) (hour angle)
- D = −asin(sin L × sin S + cos L × cos S × cos H) (Sun depression)
- A = atan2(−sin H × cos S, cos L × sin S − sin L × cos S × cos H) (Sun azimuth)

For each orbital shell k, with inclination Ik, altitude Hk (km) and Nk satellites (the
shells are the `groups` in `../dummyTLE.js`):

- E = acos(R / (R + Hk)) (the dip of the Earth's edge, seen from the satellite)
- M = asin(tan E / sqrt(3))
- U = 2 × E (upper edge of the window: the satellite enters the Earth's shadow)
- B = 180 − M − 2 × asin(cos E × cos M) − G (lower edge of the window)
- X = (D − B) / (U − B), and W = sqrt(sin(180 × X)) if 0 < X < 1, otherwise W = 0
- C = 86 − asin(cos E × cos 4) (distance to the flaring satellites)
- Z = asin(sin L × cos C + cos L × sin C × cos A) (latitude of the flaring satellites)
- F(Y) = 0.5 + asin(sin Y / sin Ik) / 180, with sin Y / sin Ik limited to −1 to +1
  (the fraction of the shell south of latitude Y)
- Q = (F(Z + 3) − F(Z − 3)) / (2 × P × (sin(Z + 3) − sin(Z − 3))) (shell density there)

Flares per hour at time T = K × (Q × W × Nk, added over all shells). Flares per night is
the rate added from noon to the next noon in small steps (for example rate × 2/60 every
2 minutes); flares in one hour is the same, over that hour.

### How accurate it is

The formula was fitted (only K) to a 2026 run of this tool: synthetic constellation, sea
level, minimum elevation 0°, visible flares.

R² is the fraction of the variation in the simulated counts that the formula explains:
1 is a perfect match, and 0 is no better than a flat line at the average.

- Per latitude, over the nights of the year, R² is 0.97 at 20°N, 0.91 at 35°N, 0.95 at
  45°N, 0.97 at 65°N and 0.91 at 35°S. At 55°N it is 0.50 (see below). The curve at 0° is
  almost flat, so R² does not apply there; its error (17 flares per night) is the same as
  its counting noise.
- For the per-hour shape, R² is 0.97 to 1.00 at every latitude except 55°N (0.59).
- All 7 latitudes together give R² 0.95. This is higher than most single latitudes,
  because it also counts the large differences between latitudes, which are easy to get
  right.
- At 5 latitudes that were not used in the fit (10°N, 28°N, 50°N, 60°N, 20°S), R² is 0.93
  to 0.98, except 10°N (0.67). The 10°N curve is almost flat, and its error (24 flares
  per night) is near its counting noise (17).
- The mean per night is usually within about 5%, mostly slightly low.
- It is least accurate near a shell's turning latitude, where the shell's satellites are
  most dense. At 55°N, R² is 0.50, and in December the formula gives about twice the
  simulated count.
- It reproduces this tool's simulation, not the real sky. Compared with a real element
  set over three weeks, the synthetic constellation was within about 10% up to 35°
  latitude, but gave fewer flares at 45°N (−19%), 55°N (−37%) and 65°N (−65%).
- It does not include the observer's altitude.

## Constellation

By default the tool uses the synthetic constellation: about 10,500 satellites laid out in
the measured Starlink shells, with the epoch set to each night. It gives the statistics of
the real constellation, not the positions of real satellites. This is the correct model
for a whole year, because a real element set is only accurate for a few days either side
of its epoch.

`--tle FILE` propagates one real element set to every night. Use it for date ranges within
a few weeks of the file's epoch.

## Files

- `flare-stats.mjs` — command line, worker pool, cache and CSV tables
- `statsWorker.mjs` — worker thread; scans one night at a time
- `statsCore.mjs` — one night's scan and the time helpers, used by both
- `make-xlsx.py` — builds the Excel workbook from the CSV files
- `index.html`, `viewer.js`, `viewer.css` — the browser viewer
- `lineChart.js` — the SVG line chart with a crosshair tooltip that the viewer uses
- `../tools/test-stats.mjs` — test for the time helpers (part of `npm test` in `tools/shf/`)
