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
The model version is a hash of the engine, physics, constellation (the generator and its
shell table) and `satellite.js` source files and the worker that runs them. After any change
to them, the tool scans every night again and does not mix old results with new ones.

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
  only from a small area on the ground, about 100–200 km across. The hours are local
  solar time, but the longitude still matters: the night at longitude L starts L / 360 of
  a day earlier in UTC, and in that time the orbital planes of the 43°, 53° and 70° shells
  drift against the Sun by a good part of their spacing, so the night meets a different
  pattern of planes (three longitudes 120° apart differ by about 5% of the count on a
  typical night, and by up to 47%).
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

## The flare-rate model

The flare rate page (`../rate/`) gives the expected number of flares for any latitude and
night without a scan. It uses a model of the flare geometry (`../rate/rateModel.js`) that
reproduces what this tool counts: at each moment the model builds the region of each
satellite shell where a satellite flares for the observer (the reflected ray within the
glint limit, the satellite sunlit and above the horizon), and counts the satellites that
move into that region, as the integral along the region's edge of the satellite density
times the inward speed relative to the moving edge. Each entry is one flare, less the
chance that the 2-second sampling of the scan misses a short run. There is no fitted
constant. The satellite density is weighted by where the shell's orbital planes are at
that moment: every shell's measured planes (below), moved to the night at the shell's
precession rate by the same rule as the synthetic constellation, and the Sun-synchronous
planes at their fixed local times. A night's count therefore belongs to its date, and the
page covers the year that starts in the month the constellation was measured (365 nights;
the year moves when the table is refreshed). The page has no longitude, so each plane is
spread over its day of drift against the Sun and the count is the mean over the observer's
longitude (`expectedNight` takes `lon` for one longitude's night). The page
`../rate/formula.html` explains it, with the measured numbers.

Measured against this engine on eleven single-shell test constellations (8,000 satellites
each; 14 latitudes from 60°S to 70°N, 9 nights, 4 longitudes; five of the sets held back
until the model was finished): the model's total over a set is within 1.3% of the scan for
the six sets used while it was built and within 0.9% for the five held-out sets, for both
kinds of flare; per latitude most ratios are within 2% and all within 7% (the scatter is
mostly the test sets' own: each is one random draw of 8,000 orbit planes); the hour-by-hour
shape differs from the scan by 5% of the night's count, which is the scan's own counting
noise. Scans with 80,000 satellites at single cells agree to 0.5% (53°/470 km) and 0.7%
(70°/580 km). Against the synthetic constellation scanned through a year (12 latitudes from
45°S to 65°N, 24 nights at 15-day intervals, 3 longitudes): with the planes placed for the
scan's longitude (`lon` in `expectedNight`), a typical night is within 1.0–1.3% of the scan
at that longitude (the median over the nights with 30 or more flares), nine nights in ten
within 2.7–4.5%, the worst 31%. The pages give the mean over longitude (each plane spread
over its day of drift); against the scan's 3-longitude mean that is 0.998 in total, a
typical night within 1.7% (1.8% for all flares; the 3-longitude mean itself is 1.7%
uncertain, because the three nights differ by 5.6% on a typical night), nine nights in ten
within 6.3%, the worst 17%, and every latitude's year within 0.990–1.006. With the planes
spread evenly instead of dated, a typical night was off by 3.6% and the worst by 87%: a
shell of a few planes (the 70° shells) has no average layout on a given night.
`../tools/test-rate.mjs` holds frozen snapshots of these scans and checks the model
against them.

History: until version 2.173 the page used a closed formula with one fitted constant. It
matched this tool's yearly curves with R² 0.91–0.97 at most latitudes but 0.50 at 55°N,
where it gave twice the simulated count in December, and the synthetic constellation it was
fitted to was 19–65% low against the real one north of 45°. Both were replaced in the next
version by the model above and the measured constellation below.

## Constellation

By default the tool uses the synthetic constellation (`../dummyTLE.js`): the measured
structure of the real one, with the epoch set to each night. It gives the statistics of
the real constellation, not the positions of real satellites. This is the correct model
for a whole year, because a real element set is only accurate for a few days either side
of its epoch.

The structure comes from a measurement of a CelesTrak element set, stored in
`../starlinkShells.js` (the file names its source and date; 11,154 satellites on
2026-09-30):

- **Shells.** Satellites are grouped by inclination (43.0°, 53.2°, 70.0° and 97.3°) and by
  10 km altitude band: 44 shells from 240 to 580 km. The eight largest hold 92% of the
  constellation (53°/470 km 31%, 43°/490 km 29%, 97.3°/473 km 12%, 53°/478 km 9%, …); the
  rest are raising and decaying groups.
- **Planes.** Every shell keeps its measured orbital planes (the right ascension of each
  plane at the reference epoch, and its satellite count). The generator moves them to the
  night's date at the shell's precession rate (−4.7°/day at 53°/470 km, −5.6°/day at
  43°/490 km, −2.5°/day at 70°/579 km), so the real pattern of planes is kept on any date.
  This matters for the 70° shells, which are 2–20 planes each and made 30–55% of the
  flares poleward of 45° in the measurement nights around 1 October 2026 (12–38% over the
  year at 45°N–65°N): a shell of so few planes has no average layout on a given night.
  The rate model dates the planes by the same rule (`nodalRate` in `../dummyTLE.js` is
  the one function both use).
- **The Sun-synchronous group.** The 97.3° planes precess eastward at the Sun's own rate
  (0.99°/day), so each keeps a fixed local mean solar time of its ascending node. The table
  stores those local times (two bands, 6.0–10.5 h and 17.3–22.5 h, and a smaller set near
  1–3 h and 13–15 h), and the generator places the planes at them on any date. This group
  made 68% of the visible flares at 55°N in the measurement nights around 1 October 2026
  (57% over the year).
- **Phases.** Within a plane the satellites are evenly spaced with the measured
  irregularity (1–4° for the regular planes, about 10° for the 70° planes), and the phases
  move continuously from night to night at the shell's mean motion.

Measured against the real element set over five nights (29 September to 3 October 2026;
14 latitudes from 60°S to 70°N, 6 longitudes): the synthetic count of visible flares is
1.002 of the real one in all (1.001 for all flares), and within 2% at every latitude from
50°S to 60°N (worst 1.016 ± 0.006 at 10°S and 0.981 ± 0.016 at 60°N; the others within
1%); by inclination group 43° 1.002, 53° 1.003, 70° 1.008, 97.3° 0.999. The reduced
chi-squared of the per-latitude ratios is 1.9. At 60°S and 70°N the real set gives only
3.5 and 1.4 flares a night at that season (from a few low, decaying satellites) and the
synthetic set 0.5 and 0.0: too few to measure a ratio, so those latitudes are not checked.

**Refreshing the table.** The constellation changes with every launch, so refresh the
table when it is a few months old: download a fresh CelesTrak CSV (the supplemental set is
preferred; the standard group also works) and run the measurement tool, then rebuild the
rate page's year table (its year starts on the 1st of the month of the new table's
reference epoch, so the rate page's dates move with it; about 18 minutes on 12 worker
threads), then the tests:

```bash
curl -o starlink.csv 'https://celestrak.org/NORAD/elements/supplemental/sup-gp.php?FILE=starlink&FORMAT=csv'
node tools/shf/tools/measure-shells.mjs starlink.csv
node tools/shf/tools/build-rate-table.mjs --workers 12
(cd tools/shf && npm test)
```

The rate page refuses a year table built for another shell table or year, so the two must
be refreshed together. `test-rate.mjs` compares the model with frozen scans of the
constellation of 2026-09-30; after a refresh its simulated-year checks measure the new
table against the old scans, so a difference there is the constellation's change, not a
fault, and the fixtures (`../tools/fixtures/`) are rebuilt from a new scan when the
difference matters.

`--tle FILE` propagates one real element set to every night. Use it for date ranges within
a few weeks of the file's epoch.

## Files

- `flare-stats.mjs` — command line, worker pool, cache and CSV tables
- `statsWorker.mjs` — worker thread; scans one night at a time
- `statsCore.mjs` — one night's scan and the time helpers, used by both
- `make-xlsx.py` — builds the Excel workbook from the CSV files
- `index.html`, `viewer.js`, `viewer.css` — the browser viewer
- `../lineChart.js`, `../lineChart.css` — the SVG line chart with a crosshair tooltip that the
  viewer uses (shared with the flare rate page, `../rate/`)
- `../tools/test-stats.mjs` — test for the time helpers (part of `npm test` in `tools/shf/`)
