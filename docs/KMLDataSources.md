# KML Data Sources

This page tells you where to get an aircraft track as a KML or KMZ file, and which export option to
choose. KML (Keyhole Markup Language) is one of the main formats for importing aircraft tracks into
Sitrec. A KML/KMZ file exported from a flight-tracking service contains a time-stamped series of
latitude / longitude / altitude points, which Sitrec converts into a track and renders in 3D.

Sitrec aims to import any KML that Google Earth can animate over time. A KML gives a track when each
position has a standard time: a `<gx:Track>`, a `<gx:MultiTrack>`, or a `<Point>` with a
`<TimeStamp>` or `<TimeSpan><begin>`. The folder depth and the provider do not matter.
[What is NOT (yet) supported](#what-is-not-yet-supported) lists the exceptions.

- [Recognised track sources (the common providers)](#recognised-track-sources-the-common-providers)
- [Where each file comes from](#where-each-file-comes-from)
- [What is NOT (yet) supported](#what-is-not-yet-supported)
- [For developers: how the parser works](#for-developers-how-the-parser-works)

---

## Recognised track sources (the common providers)

Three flight-tracking services produce most of the exported KML tracks that Sitrec has been
tested with. They are listed here because their *shapes* are worth knowing. Track extraction has no
special case for any of them: each is just a particular arrangement of the generic time+geometry
structure.

| Source | Provider | Typical layout | Multi-track? |
|--------|----------|----------------|--------------|
| **ADS-B Exchange** | adsbexchange.com | `<Folder><Folder>…<gx:Track>` (one inner folder per aircraft) | **Yes** — many aircraft per file |
| **FlightAware** | flightaware.com | `<Document>` with origin/destination `<Point>` markers + a `<gx:Track>` placemark | No — one flight per file |
| **FlightRadar24 (FR24)** | flightradar24.com | `<Document><Folder name="Route">` of timed `<Point>`s (+ a `Trail` folder) | No — one flight per file |

Other KML files (Google Earth shapes, ground overlays, point landmarks) are also accepted, but
they produce *scene features*, not tracks — see
[Non-track KML content](#non-track-kml-content-overlays-shapes-points).

> **Sitrec finds tracks from the XML structure, not from the provider's name or the file name.**
> Only two things depend on a provider's layout: the track's name, and the skip that stops an FR24
> flight from also being drawn as shapes.

---

## Where each file comes from

You obtain these files by exporting/downloading from the service's website. None of them are
fetched automatically by Sitrec — you export the KML and then drag-and-drop it (or use
**File → Import File**) into Sitrec. A `.kmz` is a zipped KML, and it works the same way. The
export options below are as they were at the time of writing; the providers can change them.

- **ADS-B Exchange** — From the globe replay view
  (`https://globe.adsbexchange.com/?replay=…`), select aircraft and download the track KML. Choose
  the *Geometric altitude (EGM96)* option: see [Altitude in the file](#altitude-in-the-file).
  A single export can contain **all aircraft in the area/time window**, which is why these
  files are multi-track.
- **FlightAware** — From a flight's tracklog page, use the "Download flight data (KML)"
  option. The file is named like `FlightAware_N494SA_KLAX_KIPL_20250602.kml` and contains the
  single flight plus origin/destination airport markers.
- **FlightRadar24** — From a flight's playback page, export the KML. The file contains a
  `Route` folder (the flown path as individual timed points) and usually a `Trail` folder (the
  connecting line segments, which have no `<TimeStamp>` element and are ignored for the track).

> Note: pasting a *live map URL* from `globe.adsbexchange.com` or `www.flightradar24.com` into
> Sitrec does **not** import a track. Sitrec reads only the **camera lat/lon/zoom** from those URLs
> to reposition the view. To get the track from these sites, export the KML file.

Sitrec can also fetch an aircraft's last ~24 hours of positions from adsb.lol, with no KML file. Use
**Contents → Import ADS-B Track...** and enter the aircraft's ICAO hex address, which most flight
trackers show. See [ADS-B Trace by Aircraft](Tracks.md#ads-b-trace-by-aircraft-adsblol).

### Altitude in the file

Sitrec reads an altitude on a KML track as height above
[mean sea level (MSL)](GIS.md#three-kinds-of-height), unless the track's `<altitudeMode>` is
`relativeToGround` or `clampToGround`. Then the altitude is height above the terrain, or the track
is on the terrain. See [KML Altitude Modes](GIS.md#kml-altitude-modes-ogc-standard). Sitrec cannot
detect an MSL altitude that is really something else. The track then sits at the wrong height, and
so does a camera that rides on it.

- **ADS-B Exchange** offers [three altitude options](GIS.md#adsbexchange-three-kml-export-options).
  *Geometric altitude (EGM96)* gives MSL. The file name often shows the option: `-EGM96` is
  geoid-referenced, and `-press_alt_uncorrected` is raw pressure altitude, the height that an
  altimeter set to 1013.25 hPa shows. The pressure error can reach a few thousand feet at cruise.
- **FlightRadar24** and **FlightAware** report
  [pressure altitude](GIS.md#summary-what-each-sources-altitude-actually-means), so the same error
  applies to their files.

**No setting reverses a pressure error after import.** The track's **Alt offset** control in
**Contents** adds one fixed amount to every point, and a pressure error changes along the flight. If
ADS-B Exchange has the flight, export it from there with *Geometric altitude (EGM96)*. For an
aircraft seen in the last ~24 hours, **Import ADS-B Track...** uses geometric altitude when most of
the trace carries it. If not, the whole track uses barometric altitude, with the same pressure error.
[How to tell you have a datum error](GIS.md#how-to-tell-you-have-a-datum-error) lists what each
altitude error looks like.

### Check what you loaded

A track adds a folder to both **Contents** and **Objects**. A file with no times gives only a static
shape: a line in the 3D view, by default with a gray wall down to the ground, and a **Contents**
folder whose name ends in `-display`, with nothing new in **Objects**. That line is not a track. Get
a file with timestamps from the provider.

![Two lines over Southern California. A gray wall stands under the upper line. The thin green line below it starts at the label N494SA. The Contents menu has a Route-display folder and an N494SA folder. The Objects menu has an N494SA folder, and nothing for Route.](docimages/kml-static-shape-and-track.jpg)

Both lines are one flight, from the FlightAware file named above. The green line is that file as
exported: a track, with the name N494SA at its start and a folder in both **Contents** and
**Objects**. The short white piece at its start is the camera's track, in the `cameraDisplayTrack`
folder. Sitrec put the camera on N494SA, and this piece covers the sitch's time range: 900 frames at
30 frames per second, which is 30 seconds of the flight. The gray wall is a copy of the same points
with the times removed, moved north so that the lines do not overlap. It has only the `Route-display`
folder in **Contents**. The KLAX Airport label and its red arrow come from a named point in the file.
The file's KIPL Airport point is outside this view. The other folders in the two menus are part of
the default sitch. The default line-of-sight, view frustum and measurement overlays are hidden here.

---

## What is NOT (yet) supported

Sitrec reads only standard time+geometry encodings. It will **not** currently turn these into
tracks:

- **`<NetworkLink>`** — external/remote references are not followed.
- **Time carried only in `<ExtendedData>` / `<SchemaData>` / `<gx:SimpleArrayData>`** numeric
  arrays (rather than `<when>`/`<TimeStamp>`/`<TimeSpan>`).
- **Time-less geometry** — a `<LineString>` or `<Point>` with no associated time is treated as a
  **static shape** (rendered, but not as an animated track). This is by design; importing such
  paths as zero-time tracks could be a future option.
- **Time on anything except a `<Point>`** — a `<LineString>`, `<Polygon>` or `<MultiGeometry>` with
  a `<TimeStamp>` or `<TimeSpan>` is also a static shape, and a `<Model>` is not read.
- **Per-vertex timing on a `<LineString>`** — KML has no standard for this; `<gx:Track>` is the
  standard timed-path encoding and is supported.
- **A single timed point** — a track needs at least two samples. A file with only one sample gives
  no track and no message.

---

## For developers: how the parser works

The rest of this page is for people who read or change the code.

All of the track-extraction logic lives in **`src/TrackFiles/CTrackFileKML.js`**. The thin wrapper
functions in `src/KMLUtils.js` (`KMLToMISB`, `doesKMLContainTrack`) just construct a
`CTrackFileKML` and delegate. The XML→object conversion is done by `parseXml()` (`src/parseXml.js`).

- [The track-data model](#the-track-data-model)
- [How the parser works: the generic tree-walk](#how-the-parser-works-the-generic-tree-walk)
- [Supported time + geometry encodings](#supported-time--geometry-encodings)
- [How samples are grouped into tracks](#how-samples-are-grouped-into-tracks)
- [How a KML becomes a track (pipeline)](#how-a-kml-becomes-a-track-pipeline)
- [Track naming](#track-naming)
- [Sitrec as a KML generator (round-trip)](#sitrec-as-a-kml-generator-round-trip)
- [Altitude, time, and unit conventions](#altitude-time-and-unit-conventions)
- [Non-track KML content](#non-track-kml-content-overlays-shapes-points)
- [KMZ archives](#kmz-archives)
- [Quirks and gotchas](#quirks-and-gotchas)
- [Extending the parser](#extending-the-parser)

---

### The track-data model

A "track" is a list of `(timestamp, longitude, latitude, altitude)` samples, in file order. The
parser's whole job is to find every such sample in a KML file and group them into tracks. It does
**not** care which website produced the file — it keys on the **fundamental structure** (a time
primitive attached to a geometry), so a file from a tool nobody has seen before works as long as
it expresses position-over-time in a standard KML way.

Internally each extracted track is a `TrackGroup`:

```js
{ samples: [ {t, lat, lon, alt}, … ],   // t = epoch milliseconds
  placemarkName, folderName, documentName }   // naming context only
```

`extractTrackGroups()` returns the ordered list of these; everything else
(`toMISB`, `getTrackCount`, `doesContainTrack`, `getShortName`) is a thin view over it.

---

### How the parser works: the generic tree-walk

#### Stage 1 — "Is this a KML at all?"

`CTrackFileKML.canHandle(filename, data)` checks only that the parsed
object has a top-level `kml` property:

```js
static canHandle(filename, data) {
    if (!data || typeof data !== 'object') return false;
    try { return !!data.kml; } catch (e) { return false; }
}
```

`detectTrackFile()` (`CFileManagerParse.js`) asserts that *at most one* `CTrackFile` subclass
claims a file (and returns `null` when none does), so `CTrackFileKML` is the sole owner of
anything with a `kml` root.

#### Stage 2 — Recursive descent (`extractTrackGroups`)

This is the heart of the importer. It walks the parsed tree depth-first and collects timed samples:

1. **Descend** through `Document` and `Folder` to **any depth** (so a track buried three folders
   deep is found), transparently descending `<gx:MultiTrack>` to treat its child `<gx:Track>`s as
   ordered segments.
2. **At each `<Placemark>`**, classify the geometry into timed samples:
   - **`<gx:Track>` / `<gx:MultiTrack>`** → pair each `<when>` with each `<gx:coord>` by index
     (`samplesFromGxTrack`).
   - **A direct `<TimeStamp><when>` or `<TimeSpan><begin>` plus a `<Point>`** → one sample
     (`sampleFromTimedPlacemark`). This is the FR24 route-point case.
   - **Geometry with no time** → not a track. Separately, `extractKMLObjectsInternal` renders
     shapes and named points whether or not they are timed (see
     [Non-track KML content](#non-track-kml-content-overlays-shapes-points)).
3. **Group** the samples into tracks by **enclosing-container identity** (see
   [How samples are grouped](#how-samples-are-grouped-into-tracks)).
4. **Memoize.** The result is cached on the instance (`this._trackGroups`) because `this.data` is
   immutable, so repeated `toMISB`/`getTrackCount`/`getShortName` calls re-use one walk.

Helper utilities make the walk tolerant of `parseXml`'s object-vs-array ambiguity:
`asArray(x)` treats a single object and a one-element array identically, and
`textOf(node, key)` reads `node[key]["#text"]` whether `node[key]` is an object or an
array. This is why a `<gx:Track>` with a **single** `<when>`/`<gx:coord>` still gives a one-sample
group. `TrackManager` builds no track from fewer than two samples.

> **Probe vs. extract.** `getKMLTrackWhenCoord(kml, trackIndex, when, coord, info)` is the
> public face: with the output arrays omitted (`when === undefined`) it is a cheap *probe* (does a
> track exist at this index?) backing `doesContainTrack()`; with them present it copies the group's
> samples out. Both just index into `extractTrackGroups()`.

#### Camera-time trap

A time primitive counts **only as a direct child of the feature/geometry**. `<TimeStamp>` /
`<gx:TimeSpan>` nested inside a `<LookAt>` or `<Camera>` (a camera fly-to animation, common in
Google-Earth-authored files) is **ignored** — `sampleFromTimedPlacemark` reads only `pm.TimeStamp`
/ `pm.TimeSpan` directly, never a nested one. Timestamps embedded in `<description>` CDATA (as
FR24 writes in its `Trail` folder) are likewise never mined. Both rules prevent a static-shape or
camera file from being misread as a track.

---

### Supported time + geometry encodings

The parser fills each track's `samples` from whichever of these encodings it finds.

#### `gx:Track` (ADS-B Exchange, FlightAware, and most "absolute" exports)

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

#### `gx:MultiTrack` (multi-segment tracks)

A `<Placemark>` whose geometry is `<gx:MultiTrack>` containing several `<gx:Track>` children is
treated as **one track whose segments are concatenated in document order**. This is the Google
extension's way to express, e.g., a runway segment followed by an in-flight segment. ADS-B Exchange
gets the same result another way: two same-named `<gx:Track>` placemarks, a ground segment at
altitude 0 followed by the airborne segment, which the walk concatenates by folder identity.

#### `TimeStamp`/`TimeSpan` + `Point` (FR24 and timed-placemark tracks)

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

#### Encoding comparison at a glance

| Feature | `gx:Track` / `gx:MultiTrack` | `TimeStamp`/`TimeSpan` + `Point` |
|---|---|---|
| Time tag | `<when>` array (or per-segment) | `<TimeStamp><when>` / `<TimeSpan><begin>` |
| Coord tag | `<gx:coord>` | `<Point><coordinates>` |
| Coord separator | space | comma |
| Coord order | lon lat alt | lon,lat,alt |
| Points per placemark | many | one |
| Altitude units | metres | metres |

---

### How samples are grouped into tracks

After collecting samples, the walk groups them into distinct tracks by **enclosing-container
identity** — the immediate `<Folder>` (or `<Document>`/root) a placemark sits in:

- **`gx:Track`/`gx:MultiTrack` placemarks in one folder** → one track (segments concatenated in
  document order). This is what stitches ADS-B Exchange's ground+airborne placemarks into a single
  aircraft track. The rule uses only the folder, so different aircraft in one folder also become
  one track, which jumps between them. Each aircraft needs its own folder.
- **A run of timed `<Point>` placemarks in one folder** → one track (the FR24 `Route`).
- **Distinct sibling folders, each with track geometry** → distinct tracks. This is how a
  multi-aircraft ADS-B Exchange file yields N tracks, **and** how a single file containing **two
  different data sources** (e.g. a `gx:Track` aircraft in one folder and an FR24-style route in
  another) yields two tracks.

Track **order** is the order of the walk: a container's own placemarks, then its folders, then its
documents. For sibling folders this is document order, matching the legacy
`getValidIndexedTrackInFolder()`, so a saved sitch's `trackIndex` still points at the same aircraft.
`getTrackCount()` and `hasMoreTracks()` are simply `extractTrackGroups().length` and an index
comparison.

#### Duplicate-time handling

Consecutive samples with an identical `<when>` string are dropped: **within** each `<gx:Track>` segment for the gx path, and **across** the placemark
sequence for the timed-point path. This avoids zero-duration steps that would break interpolation.

---

### How a KML becomes a track (pipeline)

1. **Parse XML** — `parseXml()` (`src/parseXml.js`) parses the text with `DOMParser`, and
   `xmlToObject()` (`tools/xml-wind/xmlObject.js`) walks the DOM into a nested JS object. Text is under a `#text` key; repeated sibling tags become arrays (a single occurrence stays an
   object — hence the `asArray`/`textOf` helpers).
2. **Detect type** — `CTrackFileKML` claims anything with a `kml` root.
3. **Count tracks** — `getTrackCount()` returns the number of groups the walk found. For
   files with 3 or more tracks the UI shows a selection dialog (2-track files load all tracks directly).
   In a new sitch, a file with two or more tracks also asks whether its first two tracks are the
   camera and the target (`TrackManager.shouldAskLoadOrderPairing`): a checkbox in the selection
   dialog, or a separate question for a 2-track file.
4. **Convert to MISB** — for each selected track index, `toMISB(trackIndex)` calls
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

### Track naming

Naming depends on the source, and it is deliberately conservative to avoid breaking saved sitches
(which key node IDs on `Track_<shortName>`).

- **`getShortName()`** runs a regex ladder over the file structure — `/([A-Z0-9]+) track/` on an
  ADS-B Exchange folder name (`/([A-Z0-9\-]+) track/` when the sitch sets
  `allowDashInFlightNumber`), then `/FlightAware ✈ ([A-Z0-9]+) /` and `/([A-Z0-9]+)\/[A-Z0-9]+/`
  (the X/Y callsign-or-ICAO form) on a `<Document>` name. If neither matches, it uses the whole
  `<Document>` name. All tracks in a file with a named `<Document>` therefore start from one name:
  their folder and placemark names are not used, and `TrackManager` adds `_1`, `_2` to keep them
  unique.
- **`legacyTrackName()`** supplies a seed value, which is used only when the file has no `<Document>`
  name. It returns one value for each file shape, including quirks like `folder.name.split(' ')[0]`
  and `Document.name.split(' ')[2]`, and it stays fixed so that track names do not change.

Any *improvement* to naming (e.g. using a placemark's own name for callsigns the folder regex
mangles) is deferred to a future, `exportTagNumber`-version-gated step so it can never silently
change the track ID of an already-saved sitch.

---

### Sitrec as a KML generator (round-trip)

Sitrec doesn't only *read* KML — it also **writes** it, and those exports re-import cleanly.

| Generator | Output shape | Re-import behaviour |
|---|---|---|
| `CNodeArray.exportTrackKML` (`CNodeArray.js`; overridden in `CNodeSplineEdit.js` and `CNodeSwitch.js`) | `<Document><Placemark><gx:Track>` — single document, single placemark, `altitudeMode=absolute`, `extrude=1` | imports as a 1-track group, keeping its name (a `<Folder>` root would re-import as "Unnamed Track") |
| `CNodeMISBData.exportTrackKML` | Same `<Document>…<gx:Track>` shape | imports as a 1-track group |
| `CNode3DObject.exportToKML` — **Objects → *object name* → Export to KMZ with Track** | `<Document>` holding a `<Placemark><Model><Link href=…dae>` for the object and, when it rides a track, a `<Placemark><gx:Track>` sampled once per second (`<gx:MultiTrack>` with `<gx:interpolate>0` where the track has gaps); the track half is written by `ExportObjectKMZ.js` | The `<gx:Track>` imports as a 1-track group at 1 Hz; the model Placemark is ignored: Sitrec reads no `<Model>` element and does not load the `.dae` |
| `CustomManagerMenus` "Sitrec Pin" (`googleEarthHere`, `CustomManagerMenus.js`) | `<Document><Placemark><Point>` (no time) | A point landmark feature, not a track |

The track exporters emit **MSL** altitude (KML `absolute` is the EGM96 geoid datum) and
convert from height above the WGS84 ellipsoid (HAE) on the way out —

```js
// CNodeArray.js — KML absolute altitude is MSL (EGM96) per OGC KML 2.2/2.3.
if (altReference === "HAE") alt -= meanSeaLevelOffset(lat, lon);
```

— mirroring the import side (KML absolute imported as MSL), so an exported track
re-imports with identical geometry and opens at the correct height in Google Earth.

---

### Altitude, time, and unit conventions

#### Altitude — HAE vs MSL

- **KML `absolute` altitude is metres, MSL** — measured from the EGM96 geoid, per OGC KML 2.2/2.3
  (Google Earth reads `absolute` as height above sea level). It is **not** HAE.
- **MISB `SensorTrueAltitude` is conventionally MSL** (orthometric, relative to the geoid) —
  the same datum, which is why `toMISB()` can copy the KML number **verbatim**.
- MSL→HAE conversion (adds `meanSeaLevelOffset(lat, lon)`) happens once, on the way to ECEF when
  the track positions are computed. Exports mirror this: `CNodeArray.exportTrackKML` and `CNodeTrack.exportMISBCompliantCSV`
  convert HAE-referenced frames back to MSL before writing.

> **Known limitation (datum):** an `absolute` altitude on a KML **track** is treated as **MSL**, and
> the geoid undulation is added on the way to HAE. That is the right assumption for a genuinely
> orthometric export and the wrong one for a **barometric** one: a pressure-altitude KML gets a
> geoid correction applied to a number that was never sea-level referenced at all, and the
> pressure error is untouched. See [Altitude in the file](#altitude-in-the-file).
>
> **Ground-relative tracks:** when every part of a track has a ground-relative `<altitudeMode>`
> (`relativeToGround`, `clampToGround`, or the `gx:` sea-floor modes), `toMISB()` writes the
> altitude to the MISB `AltitudeAGL` column and leaves `SensorTrueAltitude` empty. `clampToGround`
> writes 0. `CNodeMISBDataTrack` then reads the track as height above the terrain. A track with no
> `<altitudeMode>`, or with parts in different modes, stays MSL, because the track node reads one
> altitude column for the whole track. So an ADS-B Exchange ground segment at `alt=0`, which has
> no `<altitudeMode>`, is still read as a literal zero MSL.
>
> The mode is not read for a sitch saved by 2.190.0 or earlier (`exportTagNumber` ≤ 2190000), so
> the geometry of an existing save does not change. The decision is made when the file is read
> (`CTrackFileKML` constructor), because `toMISB()` can run again after the restore has finished.
> Shapes read the mode too: a `<LineString>` or `<Polygon>` reads its own `<altitudeMode>`.
> See [GIS Concepts in Sitrec](GIS.md).

#### Time

`timeStrToEpoch()` (`src/DateTimeUtils.js`) accepts ISO-8601 strings (e.g.
`2023-01-07T00:13:00.900Z`) and numeric epoch seconds/milliseconds. The stored value is
**milliseconds since the Unix epoch**.

#### Units

KML altitudes are always **metres**. (Feet conversion lives in the *CSV* importers, e.g.
DJI/Airdata logs, not here.)

---

### Non-track KML content (overlays, shapes, points)

A KML need not contain a track at all. `extractObjects()` → `extractKMLObjectsInternal()`
recursively walks the tree and turns shapes, overlays and named points into scene
features. It does **not** check for time: a named `<Point>` placemark becomes a landmark whether it
is timed or not. This path is independent of the track walk:

| KML element | Becomes | Handler |
|---|---|---|
| `<LineString>` | A displayed track/path line | `extractKMLLineString` |
| `<Polygon>` (`outerBoundaryIs.LinearRing`) | A filled/capped area | `extractKMLPolygon` |
| `<GroundOverlay>` (with `<LatLonBox>` + `<Icon>`) | A georeferenced image draped on terrain | `extractKMLGroundOverlay` |
| `<Placemark>` with `<Point>` + `<name>` | A labelled landmark feature | inline |
| `<MultiGeometry>` | Each part as its own shape, named after its Placemark (`Zone`, `Zone 2`) | `extractKMLObjectsInternal` |

Styling (`LineStyle`/`PolyStyle` colors) is resolved via `getKMLStyle()`. It reads a `<Style>` or
`<StyleMap>` directly under the root `<Document>` that a `styleUrl` names, and a `StyleMap` uses its
`normal` pair. A `<Style>` inside a `<Placemark>` is ignored, so that shape uses the default colors.
Shape coordinate lists are parsed by `extractCoordinates()`, which splits on **any whitespace** (`/\s+/`) to tolerate pretty-printed KML.

The FR24 `Route`/`Trail` folder pair is explicitly skipped here so an FR24 flight is
not also drawn as a generic line shape. Only that exact two-folder pair is skipped: an FR24 file
without a `Trail` folder also gets a landmark for each named route point.

---

### KMZ archives

A `.kmz` is a ZIP containing one or more KMLs plus referenced images. KMZ handling
(`parseAsset()`, `CFileManagerParse.js`) is richer than "unzip then parse":

- **Detection is by content, not just extension.** A file is treated as a zip if its name ends in
  `.kmz`/`.zip` **or** if its first four bytes are the ZIP magic number `50 4B 03 04`
  (`PK\x03\x04`). So a mislabeled `.kml` that is actually zipped, or a `.zip` of KMLs, still works.
- **Multiple inner KMLs are supported.** All `.kml` entries are collected; each non-image entry is
  recursively run back through `parseAsset()`, so each inner KML produces its own track(s)/features.
- **Image references are extracted as overlay textures.** When the file name ends in `.kmz`,
  each inner KML is scanned for `<href>…png|jpg|jpeg|gif|webp|jp2|j2k|jpx</href>`; an `<href>` that is
  a bare file name, with a matching archive entry, is stored as a
  `dataType: "kmzImage"` blob URL in `kmzImageMap`, which `extractKMLGroundOverlay()` consults so
  a `<GroundOverlay>`'s icon resolves to a local image instead of a (possibly dead) network URL.
  A `.zip`, or a zip found only by its magic number, gets no image scan.
- **`__MACOSX`/`._` junk entries are filtered out** so macOS-zipped archives don't inject phantoms.

Apart from these unwrap steps, a KMZ's inner KML is parsed by exactly the same generic extractor as
a plain `.kml`.

---

### Quirks and gotchas

- **Coordinate order is lon, lat, alt** (KML native), the *opposite* of how positions are often
  written conversationally. The parser reads `cs[0]=lon, cs[1]=lat, cs[2]=alt`.
- **Names are frozen for back-compat.** Older saved sitches reference tracks only by
  `Track_<shortName>`, so changing a name would orphan them; improvements are deferred behind an
  `exportTagNumber` gate.
- **`isSupplementaryTrack()` is always `false`** for KML: every KML track is a distinct
  aircraft, never a FrameCenter-style supplementary.
- **Geometry is taken verbatim.** The parser does no outlier rejection or smoothing — bad-data
  filtering and the g-force check live downstream in `TrackManager`/`CNodeMISBData`.

---

### Extending the parser

With the generic walk, **most new sources need no code at all** — if a file expresses positions
over time with `gx:Track`, `gx:MultiTrack`, or `TimeStamp`/`TimeSpan` + `Point`, it imports
automatically, at any nesting depth, mixed with other sources in one file if each source has its
own folder.

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
