# KML Data Sources

KML (Keyhole Markup Language) is the most common way to import aircraft tracks into Sitrec. A
KML file exported from a flight-tracking service contains a time-stamped series of
latitude / longitude / altitude points, which Sitrec converts into a track and renders in 3D.

This document explains:

- [The three recognised KML track sources](#the-three-recognised-kml-track-sources)
- [Where each file comes from](#where-each-file-comes-from)
- [How Sitrec detects the source](#how-sitrec-detects-the-source)
- [Required data structure, source by source](#required-data-structure-source-by-source)
- [How a KML becomes a track](#how-a-kml-becomes-a-track)
- [Sitrec as a KML generator (round-trip)](#sitrec-as-a-kml-generator-round-trip)
- [Altitude, time, and unit conventions](#altitude-time-and-unit-conventions)
- [Non-track KML content](#non-track-kml-content-overlays-shapes-points)
- [KMZ archives](#kmz-archives)
- [Quirks and gotchas](#quirks-and-gotchas)

All of the parsing logic lives in **`src/TrackFiles/CTrackFileKML.js`**. The thin wrapper
functions in `src/KMLUtils.js` (`KMLToMISB`, `doesKMLContainTrack`) just construct a
`CTrackFileKML` and delegate. The XML→object conversion is done by `src/parseXml.js`.

---

## The three recognised KML track sources

Sitrec reads tracks from three flight-tracking services, each with a distinct file layout:

| Source | Provider | Layout family | Multi-track? |
|--------|----------|---------------|--------------|
| **ADS-B Exchange** | adsbexchange.com | `<Folder><Folder>…<gx:Track>` | **Yes** — many aircraft per file |
| **FlightAware** | flightaware.com | `<Document><Placemark>[2]<gx:Track>` | No — one flight per file |
| **FlightRadar24 (FR24)** | flightradar24.com | `<Document><Folder name="Route">` of `<Point>`s | No — one flight per file |

These three cover the practical universe of "drag a flight track onto Sitrec." Each, however,
has **structural sub-variants** the parser must distinguish — single-track vs. multi-track,
with-airport-markers vs. without, plus a legacy/fallback shape and Sitrec's own exports. The full
branch table is in [How Sitrec detects the source](#how-sitrec-detects-the-source).

Other KML files (Google Earth shapes, ground overlays, point landmarks) are also accepted, but
they produce *scene features*, not tracks — see
[Non-track KML content](#non-track-kml-content-overlays-shapes-points).

> **Important:** Sitrec does **not** branch on the provider's *name* or the file name. It
> branches on the *XML shape* of the file (see below). Any KML whose structure matches one of
> the three families will be parsed as that family, whoever produced it.

---

## Where each file comes from

You obtain these files by exporting/downloading from the service's website. None of them are
fetched automatically by Sitrec — you export the KML and then drag-and-drop it (or use
**File → Import**) into Sitrec.

- **ADS-B Exchange** — From the globe replay view
  (`https://globe.adsbexchange.com/?replay=…`), select aircraft and download the track KML.
  A single export can contain **all aircraft in the area/time window**, which is why these
  files are multi-track.
- **FlightAware** — From a flight's tracklog page, use the "Download flight data (KML)"
  option. The file is named like `FlightAware_N494SA_KLAX_KIPL_20250602.kml` and contains the
  single flight plus origin/destination airport markers.
- **FlightRadar24** — From a flight's playback page, export the KML. The file contains a
  `Route` folder (the flown path as individual points) and usually a `Trail` folder (which
  Sitrec ignores).

> Note: pasting a *live map URL* from `globe.adsbexchange.com` or `www.flightradar24.com` into
> Sitrec does **not** import a track. The URL handler in `DragDropHandler.js` (≈ lines 927–957)
> only extracts the **camera lat/lon/zoom** from those URLs to reposition the view. To get the
> track itself you must export the KML file.

---

## How Sitrec detects the source

Detection happens in two stages, and the second stage has **more branches than the three
headline sources** — there are legacy, single-track, and Sitrec-generated variants in the same
decision tree.

### Stage 1 — "Is this a KML at all?"

`CTrackFileKML.canHandle(filename, data)` (`CTrackFileKML.js:12`) simply checks that the parsed
object has a top-level `kml` property:

```js
static canHandle(filename, data) {
    if (!data || typeof data !== 'object') return false;
    try { return !!data.kml; } catch (e) { return false; }
}
```

Every KML passes this — it is only a coarse gate. `detectTrackFile()`
(`CFileManagerParse.js:1619`) asserts that *exactly one* `CTrackFile` subclass claims a file, so
`CTrackFileKML` is the sole owner of anything with a `kml` root.

### Stage 2 — "Which layout is it?" (the full variant tree)

The real discrimination is **structural**, inside `getKMLTrackWhenCoord()`
(`CTrackFileKML.js:153`). A crucial enabling detail: `parseXml()` is called **without an
`arrayTags` argument** (`CFileManagerParse.js:1442`), so a tag becomes a JS **array only when the
source emitted two or more siblings**. A single `<Placemark>` parses to an *object*; three
`<Placemark>`s parse to an *array*. The parser therefore uses `Array.isArray(...)` as its main
format discriminator, and that is what separates the variants below.

The branches, in the order they are tested:

| # | Match condition | Variant | Track location | Name source |
|---|---|---|---|---|
| **D1** | `Document.Folder` is array **and** `Folder[0].name === "Route"` | **FR24** | each `Route` `<Placemark>` (one point each) | `Document.name` |
| **D2** | `Document.Placemark` is **array** | **FlightAware** | `Placemark[2]` (airports are `[0]`,`[1]`) | `Document.name` token `[2]` |
| **D3** | `Document.Placemark` is a **single object** | **generic single-track Document** | the lone `Placemark` (`gx:Track`) | `Placemark.name` |
| **F1** | `Folder.Folder` is **array** | **ADS-B Exchange, multi-track** | Nth valid inner folder's `Placemark` | folder `name` token `[0]`, regex `… track` |
| **F2** | `Folder.Folder` is a **single object** | **ADS-B Exchange, single-track** (one aircraft) | `Folder.Folder.Placemark` | folder name |
| **F3** | `Folder` with **no inner `Folder`** | **fallback / Sitrec-generated export** | `Folder.Placemark` | — (asserts in dev) |
| **N1** | neither `Document` nor `Folder` | **not a track** | — | returns `false` → object extraction |

Notes that make the tree behave the way it does:

- **D2 vs D3** is purely "did the file have ≥2 placemarks?" A FlightAware export carries three
  (origin marker, destination marker, the track), so it lands in D2 and the track is hard-indexed
  at `Placemark[2]`. A KML carrying only the track placemark falls through to D3 and is named from
  the placemark itself. The D2 name `Document.name["#text"].split(" ")[2]` grabs the third
  space-delimited token of the document title — fragile, source-specific (`CTrackFileKML.js:197`).
- **F1 vs F2** is "did the outer `<Folder>` contain ≥2 inner `<Folder>`s?" ADS-B Exchange wraps
  every aircraft in its own inner folder; many aircraft → array (F1, indexed by `trackIndex` via
  `getValidIndexedTrackInFolder()`), one aircraft → object (F2).
- **F3 is the round-trip / legacy branch.** It begins with `assert(0, "Unknown KML format - no
  Document or Folder.Folder")` and *then* sets `tracks = kml.kml.Folder.Placemark`
  (`CTrackFileKML.js:228-231`). Because production builds strip `assert()`, this branch silently
  works in production but **fires the debugger in dev builds**. It is reachable by Sitrec's own
  exported track KML (see [Sitrec as a KML generator](#sitrec-as-a-kml-generator-round-trip)) and
  by any simple "single folder, single placemark" KML.
- **N1** (no `Document` and no `Folder`) returns `false`; the file may still contain overlays,
  shapes, or point landmarks, which are handled by a separate walk — see
  [Non-track KML content](#non-track-kml-content-overlays-shapes-points).

### Probe mode vs extract mode

`getKMLTrackWhenCoord()` does double duty. When called **without** the output arrays (`when ===
undefined`) it runs in *probe* mode: it detects the layout and returns `true`/`false` for "does
this contain a track?" without parsing every point. FR24 returns early at `CTrackFileKML.js:164`;
the `gx:Track` variants confirm `tracks[0]["gx:Track"]` exists and return at `:256`. This backs
`doesContainTrack()` (`:23`) and `getTrackCount()` (`:127`), which the importer calls *before*
committing to a full parse and before showing the multi-track selection dialog. When called
**with** the arrays, it runs in *extract* mode and fills `when[]`/`coord[]`.

---

## Required data structure, source by source

The parser's job is to fill two parallel arrays: `when[]` (epoch timestamps) and `coord[]`
(`{lat, lon, alt}`). Each source encodes these differently.

### ADS-B Exchange (and FlightAware) — `gx:Track`

Both use the Google extension `<gx:Track>`, where timestamps and coordinates are in
**parallel arrays** of equal length (`CTrackFileKML.js:259-288`):

```xml
<Placemark>
  <gx:Track>
    <when>2023-01-07T00:13:00.900Z</when>
    <when>2023-01-07T00:13:01.900Z</when>
    ...
    <gx:coord>-97.749591 31.003977 732</gx:coord>
    <gx:coord>-97.749580 31.004100 735</gx:coord>
    ...
  </gx:Track>
</Placemark>
```

Required elements (each asserted in `CTrackFileKML.js:260-263`):

| Element | Meaning |
|---------|---------|
| `gx:Track.when[]` | ISO-8601 timestamps, one per point |
| `gx:Track.gx:coord[]` | `"lon lat alt"` — **space-separated**, altitude in **metres** |

Note the coordinate order is **lon, lat, alt** (KML's native order), and the arrays must line
up index-for-index.

**ADS-B Exchange multi-track wrapping** — multiple aircraft are stored as an array of
`<Folder>` elements under `kml.Folder.Folder`. `getTrackCount()` (`CTrackFileKML.js:127`) counts
the folders that contain a `Placemark`; `getValidIndexedTrackInFolder()` maps a `trackIndex` to
the Nth valid folder. The track's callsign is parsed from the folder name via
`/([A-Z0-9]+) track/` (`CTrackFileKML.js:79-84`).

**FlightAware single-track** — the flight is `Document.Placemark[2]`. The tail number is parsed
from the document name via `/FlightAware ✈ ([A-Z0-9]+) /` (`CTrackFileKML.js:96`).

### FlightRadar24 — `Point` + `TimeStamp`

FR24 does **not** use `gx:Track`. Instead, the `Route` folder holds **one `<Placemark>` per
track point**, each with its own timestamp and a classic KML `<Point>` (`CTrackFileKML.js:167-184`):

```xml
<Document>
  <Folder>
    <name>Route</name>
    <Placemark>
      <TimeStamp><when>2024-05-01T12:34:56Z</when></TimeStamp>
      <Point><coordinates>-86.666672,36.118729,0</coordinates></Point>
    </Placemark>
    ...
  </Folder>
  <Folder><name>Trail</name>…</Folder>   <!-- ignored -->
</Document>
```

Required elements:

| Element | Meaning |
|---------|---------|
| `Placemark.TimeStamp.when` | ISO-8601 timestamp for that single point |
| `Placemark.Point.coordinates` | `"lon,lat,alt"` — **comma-separated**, altitude in **metres** |

The two key differences from `gx:Track` are: **per-point** placemarks (not parallel arrays), and
**comma-separated** coordinates (not space-separated).

### Source comparison at a glance

| Feature | ADS-B Exchange | FlightAware | FR24 |
|---|---|---|---|
| Container | `Folder.Folder[]` | `Document.Placemark[2]` | `Document.Folder[0]` (`name="Route"`) |
| Point encoding | `gx:Track` parallel arrays | `gx:Track` parallel arrays | one `Placemark` per point |
| Time tag | `<when>` (array) | `<when>` (array) | `<TimeStamp><when>` |
| Coord tag | `<gx:coord>` | `<gx:coord>` | `<Point><coordinates>` |
| Coord separator | space | space | comma |
| Coord order | lon lat alt | lon lat alt | lon,lat,alt |
| Altitude units | metres | metres | metres |
| Multiple tracks | **yes** | no | no |
| Name source | folder name `… track` | doc name `FlightAware ✈ …` | document name |

---

## How a KML becomes a track

The end-to-end pipeline:

1. **Parse XML** — `parseXml()` (`src/parseXml.js`) walks the DOM and builds a nested JS object.
   Text content is stored under a `#text` key; repeated sibling tags are promoted to arrays.
   This is why the parser everywhere reads `node.name["#text"]` and indexes arrays like
   `Folder.Folder[i]`.
2. **Detect type** — the file manager tries each `CTrackFile` subclass's `canHandle()`;
   `CTrackFileKML` claims anything with a `kml` root.
3. **Count tracks** — `getTrackCount()` returns 1 for FlightAware/FR24, or N for a multi-track
   ADS-B Exchange file. For multi-track files the UI shows a selection dialog.
4. **Convert to MISB** — for each selected track index, `toMISB(trackIndex)`
   (`CTrackFileKML.js:28`) calls `getKMLTrackWhenCoord()` and copies the results into a MISB
   row array:

   ```js
   misb[i][MISB.UnixTimeStamp]      = _times[i];   // ms since epoch
   misb[i][MISB.SensorLatitude]     = _coord[i].lat;
   misb[i][MISB.SensorLongitude]    = _coord[i].lon;
   misb[i][MISB.SensorTrueAltitude] = _coord[i].alt;
   ```

   MISB is Sitrec's universal internal track representation, so once a KML is in MISB form it
   flows through the same path as MISB/CSV/SRT tracks.
5. **Build nodes** — `TrackManager` wraps the MISB array in a `CNodeMISBDataTrack` (the raw
   data) and a `CNodeTrackFromMISB` (the resampled, frame-indexed track used for display and
   computation).

> **Why go through MISB instead of straight to a track?** It collapses every track format onto
> one schema. Smoothing, altitude reconciliation, bad-data filtering, export, and the track
> display node are all written once against MISB rows — KML, CSV, SRT, and STANAG all reuse
> them.

---

## Sitrec as a KML generator (round-trip)

Sitrec doesn't only *read* KML — it also **writes** it, and those exports are themselves a
variant the importer has to accept. There are three distinct generators, producing three
different shapes:

| Generator | Output shape | Re-import behaviour |
|---|---|---|
| `CNodeTrack.exportTrackKML` (`CNodeTrack.js:158`) | `<Folder><Placemark><gx:Track>` — single folder, single placemark, `altitudeMode=absolute`, `extrude=1` | Variant **F3** (fallback branch) — works in prod, asserts in dev |
| `CNodeMISBData` track export (`CNodeMISBData.js:1813`) | Same `<Folder>…<gx:Track>` shape as above | Variant **F3** |
| `CNode3DObject` (`CNode3DObject.js:443`) | `<Document><Placemark><Model><Link href=…dae>` — a COLLADA model placemark, **not a track** | No `gx:Track` → treated as a scene object, not a track |
| `CustomManagerMenus` "Sitrec Pin" (`CustomManagerMenus.js:538`) | `<Document><Placemark><Point>` — a single point + pushpin style | Becomes a **point landmark feature**, not a track |

The most important round-trip detail is in the track exporters: they emit **HAE** altitude and
explicitly convert from MSL on the way out —

```js
// CNodeTrack.js:199
// KML absolute altitude is ellipsoid height (HAE).
if (altReference === "MSL") {
    alt += meanSeaLevelOffset(lat, lon);
}
```

— which is the mirror image of the import-side reconciliation. A track exported from Sitrec and
re-imported therefore preserves its geometry, even though it travels through the asserts-stripped
F3 fallback branch on the way back in.

> **One asymmetry to know:** the `gx:Track` *extract* path does **not** read the
> `<altitudeMode>` element — it assumes the altitude is HAE regardless. So Sitrec's exports set
> `altitudeMode=absolute` for correctness in Google Earth, but a third-party `gx:Track` authored
> with `relativeToGround` would be mis-read as HAE on import. Only the *shape* paths
> (`extractKMLLineString`/`extractKMLPolygon`, `:444`/`:492`) actually honour `altitudeMode`.

## Altitude, time, and unit conventions

### Altitude — HAE vs MSL

This is the single most important thing to get right.

- **KML altitude is metres, HAE (height above the WGS84 ellipsoid)** when `altitudeMode` is
  `absolute`. This is the OGC KML 2.3 spec behaviour (§9.1.3.8), noted in the code at
  `CTrackFileKML.js:454`.
- **MISB `SensorTrueAltitude` is conventionally MSL** (orthometric, relative to the geoid).
- `toMISB()` copies the KML number **verbatim** into the MSL field — it does **not** convert.
  The HAE↔MSL reconciliation is deferred to display time in `CNodeTrack`, which adds the geoid
  offset (`meanSeaLevelOffset(lat, lon)`) only when the track's altitude reference is set to
  MSL. The geoid–ellipsoid separation is tens of metres, so getting this wrong shifts a track
  vertically by that amount.

See `docs/GIS.md` for the full treatment of reference surfaces and vertical datums.

### Time

Timestamps are parsed by `timeStrToEpoch()` (`src/DateTimeUtils.js`), which accepts:

- ISO-8601 strings such as `2023-01-07T00:13:00.900Z` (the normal KML case), and
- numeric epoch values in seconds or milliseconds (auto-ranged).

The result stored in MISB is **milliseconds since the Unix epoch**.

### Units

KML altitudes are always **metres** in all three sources — there is no feet/metres branching in
the KML path. (Feet conversion lives in the *CSV* importers, e.g. DJI/Airdata logs, not here.)

---

## Non-track KML content (overlays, shapes, points)

A KML need not contain a track at all. `extractKMLObjectsInternal()` (`CTrackFileKML.js:309`)
recursively walks the tree and turns non-track elements into scene features:

| KML element | Becomes | Handler |
|---|---|---|
| `<LineString>` | A displayed track/path line | `extractKMLLineString` (`:444`) |
| `<Polygon>` (`outerBoundaryIs.LinearRing`) | A filled/capped area | `extractKMLPolygon` (`:492`) |
| `<GroundOverlay>` (with `<LatLonBox>` + `<Icon>`) | A georeferenced image draped on terrain | `extractKMLGroundOverlay` (`:498`) |
| `<Placemark>` with `<Point>` + `<name>` | A labelled landmark feature | inline (`:347-368`) |

Styling (`LineStyle`/`PolyStyle` colours, `StyleMap` normal/highlight pairs) is resolved via
`getKMLStyle()` (`:379`). Coordinate lists for these shapes are parsed by `extractCoordinates()`
(`:422`), which — unlike the track path — splits on **any whitespace** (`/\s+/`) so it tolerates
pretty-printed KML with one coordinate tuple per line.

The FR24 `Route`/`Trail` folder pair is explicitly skipped here (`:331-334`) so that an FR24
flight isn't also drawn as a generic line shape.

---

## KMZ archives

A `.kmz` is a ZIP containing one or more KMLs plus referenced images. KMZ handling
(`CFileManagerParse.js:1099-1190`) is richer than "unzip then parse," and has a few variants of
its own:

- **Detection is by content, not just extension.** A file is treated as a zip if its name ends
  in `.kmz`/`.zip` **or** if its first four bytes are the ZIP magic number
  `50 4B 03 04` (`PK\x03\x04`) (`CFileManagerParse.js:1103`). So a mislabeled `.kml` that is
  actually zipped, or a `.zip` of KMLs, still works.
- **Multiple inner KMLs are supported.** All `.kml` entries are collected
  (`kmlFiles = allFiles.filter(... .kml)`, `:1116`); each non-image entry is recursively run back
  through `parseAsset()` with a prefixed filename (`:1178-1184`), so each inner KML produces its
  own track(s)/features independently.
- **Image references are extracted as overlay textures.** Each inner KML is scanned for
  `<href>…png|jpg|jpeg|gif|webp|jp2|j2k|jpx</href>` (`:1124-1131`); matching archive entries are
  stored as `dataType: "kmzImage"` blob URLs and indexed in `kmzImageMap` (`:1157-1168`). This is
  what lets a `<GroundOverlay>`'s `<Icon><href>` resolve to a local image instead of a (possibly
  dead) network URL — see `extractKMLGroundOverlay()` (`CTrackFileKML.js:498`), which consults
  `FileManager.kmzImageMap` before falling back to the raw href.
- **`__MACOSX`/`._` junk entries are filtered out** (`:1113`) so macOS-zipped archives don't
  inject phantom files.

Apart from these unwrap steps, a KMZ's inner KML is parsed by exactly the same variant tree as a
plain `.kml`.

---

## Quirks and gotchas

- **Coordinate order is lon, lat, alt** (KML native), the *opposite* of how positions are often
  written conversationally. The parser reads `cs[0]=lon, cs[1]=lat, cs[2]=alt` for every source.
- **Separator differs by source**: `gx:coord` is space-separated (ADS-B Exchange, FlightAware);
  FR24 `<coordinates>` is comma-separated. The shape-detection branch picks the right splitter.
- **Duplicate consecutive timestamps are dropped.** ADS-B Exchange duplicates are skipped
  silently (`:273`); FR24 duplicates are skipped with a `console.warn` (`:171`). This prevents
  zero-duration segments that would break interpolation.
- **FlightAware's flight is hard-indexed at `Placemark[2]`.** If FlightAware ever changes the
  ordering of the airport markers, this index would need updating.
- **Track names can change between releases.** `getShortName()` now extracts the callsign/tail
  number from inside the file (folder/document name) rather than always falling back to a
  `track_<id>` name. Older saved sitches that referenced the old ID-based names may therefore
  resolve to different names (noted in the code comment at `CTrackFileKML.js:56-60`).
- **`isSupplementaryTrack()` is always `false`** for KML (`:144-146`): every KML track is treated
  as a distinct aircraft, never a FrameCenter-style supplementary track.
- **The number of siblings changes the parse path.** Because `parseXml` has no `arrayTags`, a tag
  with a single occurrence is an object and with multiple occurrences an array. This is leveraged
  deliberately (FlightAware vs. single-track Document; multi- vs. single-aircraft ADS-B Exchange),
  but it also means a degenerate file — e.g. a `gx:Track` with a *single* `<when>`/`<gx:coord>` —
  parses those to objects rather than length-1 arrays, so the point-extraction loop (which reads
  `whenArray.length`) sees no points. Real tracks always have many samples, so this only bites
  hand-crafted edge cases.
- **Sitrec's own exports take the assert-guarded fallback (F3) on re-import.** Harmless in
  production (asserts stripped) but it will trip the debugger in a dev build — see
  [Sitrec as a KML generator](#sitrec-as-a-kml-generator-round-trip).

---

## Adding support for a new KML source

If you need to support a fourth provider, the work is localised:

1. Add a structural detection branch near the top of `getKMLTrackWhenCoord()`
   (`CTrackFileKML.js:153`), matching on a tag/name that uniquely identifies the layout.
2. Populate the `when[]` and `coord[]` arrays (epoch ms; `{lat, lon, alt}` in metres/HAE).
3. If the file can hold multiple tracks, also handle `getTrackCount()`, `hasMoreTracks()`, and
   `getShortName()` for per-track indexing and naming.
4. Everything downstream (MISB conversion, display, smoothing, export) is reused unchanged.
