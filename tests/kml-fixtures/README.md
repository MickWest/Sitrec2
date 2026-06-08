# KML variant test fixtures

Fixtures for `tests/CTrackFileKML.variants.test.js`, a data-driven suite that exercises
**every structural variant** of KML/KMZ that Sitrec may need to import.

## How these were chosen

An exhaustive structural sweep of **1,527 real KML/KMZ files** under
`~/Dropbox/Sitrec Resources` (the `TEST KMLs` corpus plus `s3-backup` user uploads) was
fingerprinted and clustered into **37 distinct structural signatures**, grouped into 9
families. Each fixture here is the smallest faithful representative of one family, or a
hand-authored minimal reproduction of a variant that only exists in (privacy-sensitive)
user uploads or not at all in the corpus.

## Layout

- `real/` — small **copies** (never moves) of real exports. Same provenance as the
  flight-track KMLs already committed under `data/` (FlightAware / ADS-B Exchange / hand-made
  test files). Large multi-aircraft / FR24 / overlay samples are **not** copied here; the
  already-committed `data/test/` and `data/chilean/` files cover those families.
- `synthetic/` — clean, hand-authored minimal KMLs (~20–40 lines) that target the gaps the
  real corpus can't safely supply: `gx:MultiTrack`, `TimeSpan`, deep sub-folder nesting,
  two-data-sources-in-one-file, FR24 single-`Route`-folder, FlightAware-2-placemark, and the
  empty/truncated export. No licensing or privacy concerns.

## Provenance / privacy

The `s3-backup/` tree (real users' uploads) is **deliberately NOT committed**. It was used
only to *enumerate* variants and is intended as an **opt-in local validation pass** (run the
parser over the whole corpus on your machine before/after a refactor). Committing arbitrary
user uploads would be a privacy/licensing problem. If a variant matters, it is reproduced as a
clean `synthetic/` fixture instead.

## Variant → fixture map

| Cluster | Family | Fixture | Current parser |
|---|---|---|---|
| C02 | ADSBx multi-aircraft | `data/test/ADSBX - 3 tracks …kml` | ✅ track |
| C00 | ADSBx single, runway(0)+flight segments | `real/adsbx-single-runway-then-flight.kml` | ✅ track (segments concatenated) |
| C04 | FlightAware (markers + gx:Track) | `data/test/FlightAware_N494SA…kml` | ✅ track |
| C03 | FR24 Route+Trail (MultiGeometry) | `data/test/FR24 KML WN276…kml` | ✅ track |
| C17 | Document > N gx:Track placemarks | `data/chilean/Chile Chopper…kml` | ⚠️ works only because track is `Placemark[2]` |
| C24 | Single Document > Placemark > gx:Track | `data/chilean/LA330.kml` | ✅ track |
| C14 | Buildings/features only | `data/test/Rugeley (Buildings).kml` | ➖ not a track |
| C23 | Single LineString, no time | `real/no-time-single-linestring.kml` | ➖ not a track |
| C36 | Elevated LineString, no time | `real/no-time-elevated-linestring.kml` | ➖ not a track |
| C35 | Mixed shapes, no time | `real/no-time-mixed-shapes.kml` | ➖ not a track |
| C11 | Empty/truncated track export | `synthetic/empty-track-export.kml` | ➖ graceful no-track |
| C15 | FR24 single "Route" folder, no Trail | `synthetic/fr24-single-route-no-trail.kml` | ❌ **gap** |
| — | Two sources in one file | `synthetic/mixed-sources-one-file.kml` | ❌ **gap** |
| — | Track nested 3 folders deep | `synthetic/deep-nested-subfolder-track.kml` | ❌ **gap** |
| — | `gx:MultiTrack` segments | `synthetic/gx-multitrack.kml` | ❌ **gap** |
| — | `TimeSpan` timed track | `synthetic/timespan-track.kml` | ❌ **gap** |
| — | FlightAware 2 placemarks | `synthetic/flightaware-two-placemark-no-dest.kml` | ❌ **gap** |

The ❌ **gap** rows are marked `test.failing` in the suite: they pass today (because they fail),
and will flip to a real failure once the generic importer makes them work — the signal to
remove the `.failing` marker.

## Code-path / spec-conformance fixtures (added for coverage)

These exercise additional branches of `CTrackFileKML.js` and the Google KML `gx:Track`
reference. They raised unit coverage of the parser from 80.7% → **92.7% stmts / 80.3% branch**.

| Fixture | Exercises |
|---|---|
| `synthetic/sitrec-export-single-folder.kml` | F3 fallback branch (`Folder>Placemark>gx:Track`, Sitrec's own export shape) |
| `synthetic/doc-plain-name-single-gxtrack.kml` | B-DocSingle + `getShortName` final name fallback |
| `synthetic/gxtrack-angles-extendeddata.kml` | spec `gx:Track` with `gx:angles` + per-point `ExtendedData`/`gx:SimpleArrayData` (extras ignored) |
| `synthetic/fr24-duplicate-time.kml` | FR24 duplicate-consecutive-timestamp skip |
| `synthetic/ground-overlay.kml` | `GroundOverlay`/`LatLonBox` extraction via `Synth3DManager` |
| `real/doc-gxtrack-reconstructed.kml` | `Document > N gx:Track` "plus Reconstructed" (name resolves to `IBE6830`) |

## Local full-corpus validation

`tests/CTrackFileKML.corpus.local.test.js` runs the parser over an entire local corpus when
`CORPUS_DIR` is set (skipped otherwise — CI-safe, no committed paths). On the 2026-06-08
sweep of 1,493 real files it found exactly **one** outright failure (`vm2006…` FR24 single-Route)
and **zero** in `sitrec/data`. It detects THROW / NO-TRACK only — not "silently wrong" imports.

## Licensing note

The 5 files in `real/` are provider-attributed (FlightAware / ADS-B Exchange) — same provenance
as KMLs already shipped under `data/`. The generic-ingestion plan flags shipped provider KMLs as
a licensing exposure (none are in `DATA_FILES`); prefer **synthetic** fixtures for anything new.
