# KML Data Sources

KML (Keyhole Markup Language) is the most common way to import aircraft tracks into Sitrec. A
KML/KMZ file exported from a flight-tracking service contains a time-stamped series of
latitude / longitude / altitude points, which Sitrec converts into a track and renders in 3D.

As of the 2026-06 generic-ingestion refactor, Sitrec's guiding rule is:

> **If Google Earth can load it and animate it over time, Sitrec should import it.** Any KML that
> pairs **positions with timestamps** — at any folder depth, from any provider — yields a track.
> Only *name extraction* remains source-specific.

This document explains:

- [The track-data model](#the-track-data-model)
- [Recognised track sources (the common providers)](#recognised-track-sources-the-common-providers)
- [Where each file comes from](#where-each-file-comes-from)
- [How the parser works: the generic tree-walk](#how-the-parser-works-the-generic-tree-walk)
- [Supported time + geometry encodings](#supported-time--geometry-encodings)
- [How samples are grouped into tracks](#how-samples-are-grouped-into-tracks)
- [How a KML becomes a track (pipeline)](#how-a-kml-becomes-a-track-pipeline)
- [Track naming](#track-naming)
- [Sitrec as a KML generator (round-trip)](#sitrec-as-a-kml-generator-round-trip)
- [Altitude, time, and unit conventions](#altitude-time-and-unit-conventions)
- [Non-track KML content](#non-track-kml-content-overlays-shapes-points)
- [KMZ archives](#kmz-archives)
- [What is NOT (yet) supported](#what-is-not-yet-supported)
- [Quirks and gotchas](#quirks-and-gotchas)
- [Extending the parser](#extending-the-parser)

All of the track-extraction logic lives in **`src/TrackFiles/CTrackFileKML.js`**. The thin wrapper
functions in `src/KMLUtils.js` (`KMLToMISB`, `doesKMLContainTrack`) just construct a
`CTrackFileKML` and delegate. The XML→object conversion is done by `src/parseXml.js`.

---

## The track-data model

A "track" is a time-ordered list of `(timestamp, longitude, latitude, altitude)` samples. The
parser's whole job is to find every such sample in a KML file and group them into tracks. It does
**not** care which website produced the file — it keys on the **fundamental structure** (a time
primitive attached to a geometry), so a file from a tool nobody has seen before works as long as
it expresses position-over-time in a standard KML way.

Internally each extracted track is a `TrackGroup`:

```js
{ samples: [ {t, lat, lon, alt}, … ],   // t = epoch milliseconds
  placemarkName, folderName, documentName }   // naming context only
```

`extractTrackGroups()` (`CTrackFileKML.js:187`) returns the ordered list of these; everything else
(`toMISB`, `getTrackCount`, `doesContainTrack`, `getShortName`) is a thin view over it.

---

## Recognised track sources (the common providers)

In practice almost every track dropped onto Sitrec comes from one of three flight-tracking
services. They are listed here because their *shapes* are worth knowing — but they are no longer
special-cased: each is just a particular arrangement of the generic time+geometry structure.

| Source | Provider | Typical layout | Multi-track? |
|--------|----------|----------------|--------------|
| **ADS-B Exchange** | adsbexchange.com | `<Folder><Folder>…<gx:Track>` (one inner folder per aircraft) | **Yes** — many aircraft per file |
| **FlightAware** | flightaware.com | `<Document>` with origin/destination `<Point>` markers + a `<gx:Track>` placemark | No — one flight per file |
| **FlightRadar24 (FR24)** | flightradar24.com | `<Document><Folder name="Route">` of timed `<Point>`s (+ a `Trail` folder) | No — one flight per file |

Other KML files (Google Earth shapes, ground overlays, point landmarks) are also accepted, but
they produce *scene features*, not tracks — see
[Non-track KML content](#non-track-kml-content-overlays-shapes-points).

> **Sitrec never branches on the provider's name or the file name.** It walks the XML structure.
> Any KML expressing positions over time imports, whoever produced it — including hand-made files,
> deeply-nested archives, and Sitrec's own exports.

---

## Where each file comes from

You obtain these files by exporting/downloading from the service's website. None of them are
fetched automatically by Sitrec — you export the KML and then drag-and-drop it (or use
**File → Import File**) into Sitrec.

- **ADS-B Exchange** — From the globe replay view
  (`https://globe.adsbexchange.com/?replay=…`), select aircraft and download the track KML.
  A single export can contain **all aircraft in the area/time window**, which is why these
  files are multi-track.
- **FlightAware** — From a flight's tracklog page, use the "Download flight data (KML)"
  option. The file is named like `FlightAware_N494SA_KLAX_KIPL_20250602.kml` and contains the
  single flight plus origin/destination airport markers.
- **FlightRadar24** — From a flight's playback page, export the KML. The file contains a
  `Route` folder (the flown path as individual timed points) and usually a `Trail` folder (the
  connecting line segments, which carry no timestamps and are ignored for the track).

> Note: pasting a *live map URL* from `globe.adsbexchange.com` or `www.flightradar24.com` into
> Sitrec does **not** import a track. The URL handler in `DragDropHandler.js` (≈ lines 982–1016)
> only extracts the **camera lat/lon/zoom** from those URLs to reposition the view. To get the
> track itself you must export the KML file.

---

## How the parser works: the generic tree-walk

### Stage 1 — "Is this a KML at all?"

`CTrackFileKML.canHandle(filename, data)` (`CTrackFileKML.js:11`) checks only that the parsed
object has a top-level `kml` property:

```js
static canHandle(filename, data) {
    if (!data || typeof data !== 'object') return false;
    try { return !!data.kml; } catch (e) { return false; }
}
```

`detectTrackFile()` (`CFileManagerParse.js:1632`) asserts that *exactly one* `CTrackFile` subclass
claims a file, so `CTrackFileKML` is the sole owner of anything with a `kml` root.

### Stage 2 — Recursive descent (`extractTrackGroups`, `:187`)

This is the heart of the importer, and replaces the old hard-coded "which of six provider shapes
is this?" branch ladder. It walks the parsed tree depth-first and collects timed samples:

1. **Descend** through `Document` and `Folder` to **any depth** (so a track buried three folders
   deep is found), transparently descending `<gx:MultiTrack>` to treat its child `<gx:Track>`s as
   ordered segments.
2. **At each `<Placemark>`**, classify the geometry into timed samples:
   - **`<gx:Track>` / `<gx:MultiTrack>`** → pair each `<when>` with each `<gx:coord>` by index
     (`samplesFromGxTrack`, `:156`).
   - **A direct `<TimeStamp><when>` or `<TimeSpan><begin>` plus a `<Point>`** → one sample
     (`sampleFromTimedPlacemark`, `:176`). This is the FR24 route-point case.
   - **Geometry with no time** → not a track; left for `extractKMLObjectsInternal` to render as a
     static shape.
3. **Group** the samples into tracks by **enclosing-container identity** (see
   [How samples are grouped](#how-samples-are-grouped-into-tracks)).
4. **Memoize.** The result is cached on the instance (`this._trackGroups`) because `this.data` is
   immutable, so repeated `toMISB`/`getTrackCount`/`getShortName` calls re-use one walk.

Helper utilities make the walk tolerant of `parseXml`'s object-vs-array ambiguity:
`asArray(x)` (`:141`) treats a single object and a one-element array identically, and
`textOf(node, key)` (`:145`) reads `node[key]["#text"]` whether `node[key]` is an object or an
array. This is why a `<gx:Track>` with a **single** `<when>`/`<gx:coord>` now imports as a 1-point
track instead of silently empty (an old edge-case bug).

> **Probe vs. extract.** `getKMLTrackWhenCoord(kml, trackIndex, when, coord, info)` (`:246`) is the
> public face: with the output arrays omitted (`when === undefined`) it is a cheap *probe* (does a
> track exist at this index?) backing `doesContainTrack()`; with them present it copies the group's
> samples out. Both just index into `extractTrackGroups()`.

### Camera-time trap

A time primitive counts **only as a direct child of the feature/geometry**. `<TimeStamp>` /
`<gx:TimeSpan>` nested inside a `<LookAt>` or `<Camera>` (a camera fly-to animation, common in
Google-Earth-authored files) is **ignored** — `sampleFromTimedPlacemark` reads only `pm.TimeStamp`
/ `pm.TimeSpan` directly, never a nested one. Timestamps embedded in `<description>` CDATA (as
FR24 writes in its `Trail` folder) are likewise never mined. Both rules prevent a static-shape or
camera file from being misread as a track.

---

## Supported time + geometry encodings

The parser fills each track's `samples` from whichever of these encodings it finds.

### `gx:Track` (ADS-B Exchange, FlightAware, and most "absolute" exports)

The Google extension `<gx:Track>` stores timestamps and coordinates in **parallel arrays** of
equal length:

```xml
<Placemark>
  <gx:Track>
    <altitudeMode>absolute</altitudeMode>
    <when>2023-01-07T00:13:00.900Z</when>
    <when>2023-01-07T00:13:01.900Z</when>
    …
    <gx:coord>-97.749591 31.003977 732</gx:coord>
    <gx:coord>-97.749580 31.004100 735</gx:coord>
    …
  </gx:Track>
</Placemark>
```

| Element | Meaning |
|---------|---------|
| `gx:Track.when[]` | ISO-8601 timestamps, one per point |
| `gx:Track.gx:coord[]` | `"lon lat alt"` — **space-separated**, altitude in **metres** |

Coordinate order is **lon, lat, alt** (KML native) and the arrays line up index-for-index. Any
extra `<gx:angles>` (heading/tilt/roll) or per-point `<ExtendedData>`/`<gx:SimpleArrayData>` is
ignored — only position is read.

### `gx:MultiTrack` (multi-segment tracks)

A `<Placemark>` whose geometry is `<gx:MultiTrack>` containing several `<gx:Track>` children is
treated as **one track whose segments are concatenated in document order**. This is the
OGC-standard way to express, e.g., a runway segment followed by an in-flight segment — and it is
exactly how ADS-B Exchange encodes single aircraft (two same-named `<gx:Track>` placemarks: a
ground segment at altitude 0 followed by the airborne segment), which the walk also concatenates
by folder identity.

### `TimeStamp`/`TimeSpan` + `Point` (FR24 and timed-placemark tracks)

Here each track point is its **own `<Placemark>`** carrying a direct time primitive and a classic
KML `<Point>`:

```xml
<Folder>
  <name>Route</name>
  <Placemark>
    <TimeStamp><when>2024-05-01T12:34:56Z</when></TimeStamp>
    <Point><coordinates>-86.666672,36.118729,0</coordinates></Point>
  </Placemark>
  …
</Folder>
```

| Element | Meaning |
|---------|---------|
| `Placemark.TimeStamp.when` (or `Placemark.TimeSpan.begin`) | ISO-8601 timestamp for that point |
| `Placemark.Point.coordinates` | `"lon,lat,alt"` — **comma-separated**, altitude in **metres** |

Two differences from `gx:Track`: **per-point** placemarks (not parallel arrays), and
**comma-separated** coordinates (not space-separated). `<TimeSpan>` tracks use the `<begin>` time.

### Encoding comparison at a glance

| Feature | `gx:Track` / `gx:MultiTrack` | `TimeStamp`/`TimeSpan` + `Point` |
|---|---|---|
| Time tag | `<when>` array (or per-segment) | `<TimeStamp><when>` / `<TimeSpan><begin>` |
| Coord tag | `<gx:coord>` | `<Point><coordinates>` |
| Coord separator | space | comma |
| Coord order | lon lat alt | lon,lat,alt |
| Points per placemark | many | one |
| Altitude units | metres | metres |

---

## How samples are grouped into tracks

After collecting samples, the walk groups them into distinct tracks by **enclosing-container
identity** — the immediate `<Folder>` (or `<Document>`/root) a placemark sits in:

- **`gx:Track`/`gx:MultiTrack` placemarks in one folder** → one track (segments concatenated in
  document order). This is what stitches ADS-B Exchange's ground+airborne placemarks into a single
  aircraft track.
- **A run of timed `<Point>` placemarks in one folder** → one track (the FR24 `Route`).
- **Distinct sibling folders, each with track geometry** → distinct tracks. This is how a
  multi-aircraft ADS-B Exchange file yields N tracks, **and** how a single file containing **two
  different data sources** (e.g. a `gx:Track` aircraft in one folder and an FR24-style route in
  another) yields two tracks.

Track **order** is document order of the containers, matching the legacy
`getValidIndexedTrackInFolder()` (`:293`) so a saved sitch's `trackIndex` still points at the same
aircraft. `getTrackCount()` (`:119`) and `hasMoreTracks()` (`:115`) are simply
`extractTrackGroups().length` and an index comparison.

### Duplicate-time handling

Consecutive samples with an identical `<when>` string are dropped, preserving the historical
behaviour: **within** each `<gx:Track>` segment for the gx path, and **across** the placemark
sequence for the timed-point path. This avoids zero-duration steps that would break interpolation.

---

## How a KML becomes a track (pipeline)

1. **Parse XML** — `parseXml()` (`src/parseXml.js`) walks the DOM into a nested JS object. Text
   is under a `#text` key; repeated sibling tags become arrays (a single occurrence stays an
   object — hence the `asArray`/`textOf` helpers).
2. **Detect type** — `CTrackFileKML` claims anything with a `kml` root.
3. **Count tracks** — `getTrackCount()` returns the number of groups the walk found. For
   files with 3 or more tracks the UI shows a selection dialog (2-track files load all tracks directly).
4. **Convert to MISB** — for each selected track index, `toMISB(trackIndex)` (`:27`) calls
   `getKMLTrackWhenCoord()` and copies the group's samples into a MISB row array:

   ```js
   misb[i][MISB.UnixTimeStamp]      = _times[i];   // ms since epoch
   misb[i][MISB.SensorLatitude]     = _coord[i].lat;
   misb[i][MISB.SensorLongitude]    = _coord[i].lon;
   misb[i][MISB.SensorTrueAltitude] = _coord[i].alt;
   ```

5. **Build nodes** — `TrackManager` wraps the MISB array in a `CNodeMISBDataTrack` (raw data) and
   a `CNodeTrackFromMISB` (the resampled, frame-indexed track used for display and computation).

> **Why go through MISB instead of straight to a track?** It collapses every track format onto one
> schema. Smoothing, altitude reconciliation, bad-data filtering, export, and the track display
> node are all written once against MISB rows — KML, CSV, SRT, and STANAG all reuse them.

---

## Track naming

Naming is the **only** source-specific part of import, and it is deliberately conservative to
avoid breaking saved sitches (which key node IDs on `Track_<shortName>`).

- **`getShortName()`** (`:49`) is unchanged: it runs a regex ladder over the file structure —
  `/([A-Z0-9]+) track/` on an ADS-B Exchange folder name, `/FlightAware ✈ ([A-Z0-9]+) /` and
  `/([A-Z0-9]+)\/[A-Z0-9]+/` (the X/Y callsign-or-ICAO form) on a `<Document>` name — and uses a seed value as the fallback.
- **`legacyTrackName()`** (`:268`) supplies that seed, faithfully reproducing the *exact* value the
  old branch ladder produced for each shape (including quirks like `folder.name.split(' ')[0]` and
  `Document.name.split(' ')[2]`). This is what keeps names **byte-identical** across the refactor
  — a full-corpus before/after diff over ~1,400 real tracks showed zero name changes.

Any *improvement* to naming (e.g. using a placemark's own name for callsigns the folder regex
mangles) is deferred to a future, `exportTagNumber`-version-gated step so it can never silently
change the track ID of an already-saved sitch. See `docs/plans/KMLGenericIngestionPlan.md`.

---

## Sitrec as a KML generator (round-trip)

Sitrec doesn't only *read* KML — it also **writes** it, and those exports re-import cleanly.

| Generator | Output shape | Re-import behaviour |
|---|---|---|
| `CNodeTrack.exportTrackKML` (`CNodeTrack.js:158`) | `<Folder><Placemark><gx:Track>` — single folder, single placemark, `altitudeMode=absolute`, `extrude=1` | imports as a 1-track group |
| `CNodeMISBData` track export (`CNodeMISBData.js:1810`) | Same `<Folder>…<gx:Track>` shape | imports as a 1-track group |
| `CNode3DObject` (`CNode3DObject.js:443`) | `<Document><Placemark><Model><Link href=…dae>` | No time+geometry → a scene object, not a track |
| `CustomManagerMenus` "Sitrec Pin" (`CustomManagerMenus.js:538`) | `<Document><Placemark><Point>` (no time) | A point landmark feature, not a track |

The track exporters emit **MSL** altitude (KML `absolute` is the EGM96 geoid datum) and
convert from HAE on the way out —

```js
// CNodeTrack.js — KML absolute altitude is MSL (EGM96) per OGC KML 2.2/2.3.
if (altReference === "HAE") alt -= meanSeaLevelOffset(lat, lon);
```

— mirroring the import side (KML absolute imported as MSL), so an exported track
re-imports with identical geometry and opens at the correct height in Google Earth.

> **Historical note:** before the generic refactor, the single-`Folder>Placemark>gx:Track` export
> shape hit a dev-only `assert(0, "Unknown KML format")` fallback (it still worked in production
> because Terser strips asserts). The tree-walk handles it directly now — the assert is gone.

---

## Altitude, time, and unit conventions

### Altitude — HAE vs MSL

This is the single most important thing to get right.

- **KML `absolute` altitude is metres, MSL** — measured from the EGM96 geoid, per OGC KML 2.2/2.3
  (Google Earth reads `absolute` as height above sea level). It is **not** HAE.
- **MISB `SensorTrueAltitude` is conventionally MSL** (orthometric, relative to the geoid) —
  the same datum, which is why `toMISB()` can copy the KML number **verbatim**.
- MSL→HAE conversion (adds `meanSeaLevelOffset(lat, lon)`) happens once, on the way to ECEF at
  render time. Exports mirror this: `CNodeTrack.exportTrackKML` and `exportMISBCompliantCSV`
  convert HAE-referenced frames back to MSL before writing.

> **Known limitation (datum):** every KML altitude is treated as **MSL**, and the geoid
> undulation is added on the way to HAE — regardless of what the file's `<altitudeMode>` says,
> because the track path does not yet read it per segment. That is the right assumption for a
> genuinely orthometric export and the wrong one for a **barometric** one.
>
> The true datum is often encoded only in the filename: `-EGM96` is geoid-referenced (correct),
> while `-press_alt_uncorrected` is raw pressure altitude at 1013.25 hPa. A pressure-altitude
> KML therefore gets a geoid correction applied to a number that was never sea-level referenced
> at all — and the underlying pressure error (up to a few thousand feet at cruise) is untouched.
> **Sitrec cannot detect this; no setting will fix it after import.** Re-export from ADS-B
> Exchange using the *Geometric altitude (EGM96)* option instead.
>
> An ADS-B Exchange ground segment at `alt=0` (`clampToGround`) is likewise read as a literal
> zero. Honouring `<altitudeMode>` properly would move existing tracks vertically, so it is
> **deferred to a version-gated step** that will not change the geometry of an existing save.
> See [GIS, Geodesy and Altitude](GIS.md).

### Time

`timeStrToEpoch()` (`src/DateTimeUtils.js`) accepts ISO-8601 strings (e.g.
`2023-01-07T00:13:00.900Z`) and numeric epoch seconds/milliseconds. The stored value is
**milliseconds since the Unix epoch**.

### Units

KML altitudes are always **metres**. (Feet conversion lives in the *CSV* importers, e.g.
DJI/Airdata logs, not here.)

---

## Non-track KML content (overlays, shapes, points)

A KML need not contain a track at all. `extractObjects()` → `extractKMLObjectsInternal()`
(`:128`/`:309`) recursively walks the tree and turns **time-less** elements into scene features.
This path is independent of the track walk and was unchanged by the refactor:

| KML element | Becomes | Handler |
|---|---|---|
| `<LineString>` | A displayed track/path line | `extractKMLLineString` (`:444`) |
| `<Polygon>` (`outerBoundaryIs.LinearRing`) | A filled/capped area | `extractKMLPolygon` (`:492`) |
| `<GroundOverlay>` (with `<LatLonBox>` + `<Icon>`) | A georeferenced image draped on terrain | `extractKMLGroundOverlay` (`:498`) |
| `<Placemark>` with `<Point>` + `<name>` | A labelled landmark feature | inline (`:347-368`) |

Styling (`LineStyle`/`PolyStyle` colours, `StyleMap` normal/highlight pairs) is resolved via
`getKMLStyle()` (`:379`). Shape coordinate lists are parsed by `extractCoordinates()` (`:422`),
which splits on **any whitespace** (`/\s+/`) to tolerate pretty-printed KML.

The FR24 `Route`/`Trail` folder pair is explicitly skipped here (`:331-334`) so an FR24 flight is
not also drawn as a generic line shape.

---

## KMZ archives

A `.kmz` is a ZIP containing one or more KMLs plus referenced images. KMZ handling
(`CFileManagerParse.js:1099-1190`) is richer than "unzip then parse":

- **Detection is by content, not just extension.** A file is treated as a zip if its name ends in
  `.kmz`/`.zip` **or** if its first four bytes are the ZIP magic number `50 4B 03 04`
  (`PK\x03\x04`). So a mislabeled `.kml` that is actually zipped, or a `.zip` of KMLs, still works.
- **Multiple inner KMLs are supported.** All `.kml` entries are collected; each non-image entry is
  recursively run back through `parseAsset()`, so each inner KML produces its own track(s)/features.
- **Image references are extracted as overlay textures.** Each inner KML is scanned for
  `<href>…png|jpg|jpeg|gif|webp|…</href>`; matching archive entries are stored as
  `dataType: "kmzImage"` blob URLs in `kmzImageMap`, which `extractKMLGroundOverlay()` consults so
  a `<GroundOverlay>`'s icon resolves to a local image instead of a (possibly dead) network URL.
- **`__MACOSX`/`._` junk entries are filtered out** so macOS-zipped archives don't inject phantoms.

Apart from these unwrap steps, a KMZ's inner KML is parsed by exactly the same generic extractor as
a plain `.kml`.

---

## What is NOT (yet) supported

The walk only understands standard time+geometry encodings. It will **not** currently turn these
into tracks:

- **`<NetworkLink>`** — external/remote references are not followed.
- **Time carried only in `<ExtendedData>` / `<SchemaData>` / `<gx:SimpleArrayData>`** numeric
  arrays (rather than `<when>`/`<TimeStamp>`/`<TimeSpan>`).
- **Time-less geometry** — a `<LineString>` or `<Point>` with no associated time is treated as a
  **static shape** (rendered, but not as an animated track). This is by design; importing such
  paths as zero-time tracks could be a future option.
- **Per-vertex timing on a `<LineString>`** — KML has no standard for this; `<gx:Track>` is the
  standard timed-path encoding and is supported.

Also note the **altitude datum** limitation described above: novel files import with correct
horizontal geometry, and their altitudes are treated as MSL and geoid-corrected — which is wrong
for a barometric export, and cannot be detected automatically.

---

## Quirks and gotchas

- **Coordinate order is lon, lat, alt** (KML native), the *opposite* of how positions are often
  written conversationally. The parser reads `cs[0]=lon, cs[1]=lat, cs[2]=alt`.
- **Separator differs by encoding**: `<gx:coord>` is space-separated; `<Point><coordinates>` is
  comma-separated. The walk applies the right splitter per encoding.
- **Duplicate consecutive timestamps are dropped** (within a `gx:Track` segment; across a
  timed-placemark sequence) to avoid zero-duration steps.
- **Single-sample tracks now work.** A `<gx:Track>` with exactly one `<when>`/`<gx:coord>` used to
  import as silently empty (the single element parsed to an object, not a length-1 array); the
  `asArray` helper fixes this.
- **Names are frozen for back-compat.** `getShortName()` output is preserved byte-for-byte across
  the refactor via `legacyTrackName()`. Saved sitches reference tracks by `Track_<shortName>`, so
  changing a name would orphan them; improvements are deferred behind an `exportTagNumber` gate.
- **`isSupplementaryTrack()` is always `false`** for KML (`:124-126`): every KML track is a distinct
  aircraft, never a FrameCenter-style supplementary.
- **Geometry is taken verbatim.** The parser does no outlier rejection or smoothing — bad-data
  filtering and the g-force check live downstream in `TrackManager`/`CNodeMISBData`.

---

## Extending the parser

With the generic walk, **most new sources need no code at all** — if a file expresses positions
over time with `gx:Track`, `gx:MultiTrack`, or `TimeStamp`/`TimeSpan` + `Point`, it imports
automatically, at any nesting depth, mixed with other sources in one file.

You only need to touch code for:

1. **A genuinely new time or geometry encoding** (e.g. `<NetworkLink>`, or time in
   `<gx:SimpleArrayData>`). Add a case to `sampleFromTimedPlacemark`/`samplesFromGxTrack` (or the
   descent in `extractTrackGroups`) that emits `{t, lat, lon, alt}` samples. Everything downstream
   (grouping, MISB conversion, display) is reused unchanged.
2. **A new name rule** — extend `getShortName()`'s ladder (and, if it must stay back-compatible for
   existing saves, the `legacyTrackName()` seed). Prefer gating any output change behind
   `Globals.exportTagNumber` so old saves keep their existing track IDs.

When adding a fixture for a new variant, follow `tests/kml-fixtures/` and add it to the data-driven
`tests/CTrackFileKML.variants.test.js`; run the opt-in full-corpus parity check
(`CORPUS_DIR=… npx jest tests/CTrackFileKML.corpus.local.test.js`) before and after to prove no
existing track's geometry, count, or name changed.
