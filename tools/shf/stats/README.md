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
To load results that a web server can reach, add `?data=<folder URL>/` to the address.

The controls choose visible or all flares, and show or hide each latitude. Each chart has
a table of its values under it.

## Definitions

- **Night of D** is from local mean solar noon on D to noon on D+1. Each dark period is
  counted once, and is not split at midnight.
- **Local solar hour** is local mean solar time: UTC + longitude / 15 hours. There are no
  time zones and no daylight saving time, so all latitudes share one clock.
- **Visible** flares are those whose glint at least doubles the satellite's base
  brightness. The predictor and Sitrec's night sky use this same test
  (`isFlareVisible` in `../flarePhysics.js`). **All** also counts faint glints at the edge
  of the 5° flare cone.
- A flare is counted in the hour of its **peak**.

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
