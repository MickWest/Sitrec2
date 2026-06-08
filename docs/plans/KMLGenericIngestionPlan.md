# KML/KMZ Generic Ingestion Plan

> **Provenance.** Synthesized by a multi-agent workflow that characterized the full local
> KML/KMZ corpus, then validated empirically by running the real parser over every file.
> Generated 2026-06-08.

## Empirical validation (measured, not estimated)

- **Corpus sweep:** 1,527 real `.kml`/`.kmz` under `~/Dropbox/Sitrec Resources` + `sitrec/data`
  → fingerprinted into **37 structural signatures / 9 families**.
- **Real import failures:** running the actual `CTrackFileKML` over **1,493** files
  (`tests/CTrackFileKML.corpus.local.test.js`, `CORPUS_DIR` opt-in) found **exactly ONE**
  outright failure: `s3-backup/15857/vm2006withlater times4…kml` — an FR24 export with a lone
  `Route` folder (so `Document.Folder` isn't an array and the FR24 branch misses it). 1,380
  imported as tracks; 112 were legitimate non-tracks.
- **Shipped data is safe:** all 34 KML/KMZ in `sitrec/data` import (0 failures) — older
  built-in-sitch formats keep working.
- **Caveat:** that scan catches THROW / NO-TRACK only, **not** "silently wrong" imports
  (the alt=0 ground-segment-as-HAE bug, EGM96/press_alt datum, wrong-placemark). Those are the
  real risk and are covered by the gap fixtures + invariants below, not by the no-throw scan.
- **Unit coverage of `CTrackFileKML.js`:** raised from 80.7%/67.9% to **92.7% stmts / 80.3%
  branches** via `tests/CTrackFileKML.variants.test.js` (72 tests). Remaining gaps are
  peripheral overlay/style edge branches.

---

# KML/KMZ Generic Ingestion Plan

## 1. Executive Summary

**Mick's goal, in his terms:** *"If Google Earth can load it and animate it over time, Sitrec should import it."* Any KML/KMZ that carries **positions + per-feature timestamps** should yield a track. Only **name extraction** should remain source-specific.

**Current state:** `src/TrackFiles/CTrackFileKML.js` dispatches on a hard-coded ladder of six shape-specific branches (`getKMLTrackWhenCoord`, line 153) keyed on literal structure (`Document.Folder[0].name==="Route"`, `Document.Placemark[2]`, `Folder.Folder`, etc.). It parses the seven real provider shapes in our corpus, but several outcomes are **silently wrong** (ADSBx ground/airborne `gx:Track` segments concatenated with `alt=0` ground points read as HAE; press_alt/EGM96 altitudes taken verbatim as HAE), **fragile** (FlightAware `Placemark[2]` + `name.split(' ')[2]` populating an `info.name` that display never uses), or hit a **dev-only `assert(0)`** on Sitrec's own exported single-`Folder>Placemark>gx:Track`.

**A critical change since the draft was written:** the test scaffolding the draft proposed to *build* **already exists, staged in git**. `tests/CTrackFileKML.variants.test.js` plus 12 fixtures under `tests/kml-fixtures/` (5 real + 7 synthetic, with a `README.md`) are staged (git status `A`). The variants suite is data-driven over a `MANIFEST`, categorizes each fixture as `track` / `not-track` / `gap`, and uses `test.failing` for the six generic-ingestion targets (gx:MultiTrack, TimeSpan, deep-nested, mixed-sources, FR24-single-Route, FlightAware-2-placemark) so they stay green today and flip to a real failure the moment the generic importer makes them work. **This plan therefore builds ON that scaffolding rather than re-creating it** — Section 8 is rewritten accordingly.

---

## 2. What Is Hooked Up Today vs The External Corpus

**Tested today (unit-level, render-free, mocked app deps):**
- `tests/CTrackFileKML.test.js` — primary legacy suite. Loads **4 git-committed fixtures** from `data/test/` via `fs.readFileSync`, runs the **real** `parseXml` + **real** `CTrackFileKML`, asserts on pure outputs (`canHandle`, `doesContainTrack`, `toMISB`, `getTrackCount`, `getShortName`, `extractObjects`). App deps (`CNodeTrack`, `CNodeDisplayTrack`, `LayerMasks`, `Globals`, `CFeatureManager`) are `jest.mock`'d. Fixtures: ADSBX 3-track (56 KB), FR24 WN276 (1.12 MB), FlightAware N494SA (15 KB), Rugeley Buildings (7 KB). **Crucially, the ADSBX 3-track fixture already embodies the G1 alt=0 ground-concatenation bug** (verified below), and the existing test only asserts `toMISB(1).length>0` — so the bug is currently **unpinned**.
- **`tests/CTrackFileKML.variants.test.js` (STAGED, not yet committed)** — the new data-driven suite described above. Reuses the same mock block. Asserts: `canHandle`, `doesContainTrack`, valid-MISB invariants (finite lat/lon/alt, lat∈[-90,90], lon∈[-180,180], time non-decreasing across first 15 samples), `getTrackCount`, and `getShortName` *contains* the expected tail. Gap cases are `test.failing`.
- `tests/CFileManager.test.js` — uses a **hand-rolled copy** of `detectTrackFile`, NOT the real `CFileManagerParse.detectTrackFile` (`src/CFileManagerParse.js:1619`).
- Supporting: `tests/trackSourceUtils.test.js`, `tests/jszip.test.js` (generic JSZip round-trip — **not** a real `.kmz`).

**The external corpus is unreferenced by any test.** The ~50 provider files across `TEST KMLs/`, `TEST STANAG 4676/`, `TEST Zip (Compression)/`, `TEST Overlays and GeoTIFF/`, `TEST Spurious Points Filter/`, `Comparison DAL 792 2026-02-28/`, etc., under `/Users/mick/Dropbox/Sitrec Resources/` are used only to **enumerate variants** (the fixtures' README documents an exhaustive 1,527-file sweep clustered into 37 signatures) and are deliberately **not committed** for privacy/licensing reasons.

**Confirmed coverage holes (still open even with the staged suite):** no KMZ test (no `.kmz` fixture, and the synthetic set has none); no end-to-end test (`parseAsset` → `detectTrackFile` → `toMISB` → `makeMISBDataTrack` untested at any level); no altitude-datum / `altitudeMode` semantic assertions (the staged suite checks finiteness/ordering, **not** that a ground segment isn't at HAE=0); no de-dup / concatenation-correctness assertion; the **B-Fallback `assert(0)` path is not detectably tested** because jest runs prod-stripped asserts (see G5 / §8).

---

## 3. Variant Catalog

Every distinct encoding observed across the corpus, the current parser's branch + outcome, and a representative file. (`silently-wrong` = imports without error but produces a wrong track/altitude/name; `asserts-dev` = `assert(0)` fires `debugger` in dev, stripped in prod so it "works".)

| Variant | Encoding | Current branch | Outcome | Representative file |
|---|---|---|---|---|
| FlightAware classic | `Document>Placemark[3]` (origin Point, dest Point, `gx:Track`) | B-FA (:194) | **ok** geometry; name via `getShortName` Document-regex (not B-FA's `info.name`) | `data/test/FlightAware_N494SA…kml` |
| FlightAware "plus Reconstructed" | same, `[0]/[1]` empty stubs, Doc name lacks `✈` | B-FA | name = `IBE6830` via Doc `CALLSIGN/ICAO` regex (NOT "plus"; see G4) | `data/chilean/IBE6830 FlightAware plus Reconstructed.kml` |
| FR24 Route/Trail | `Document>Folder[Route,Trail]`, Route = `TimeStamp`+`Point/coordinates` (comma) | B-FR24 (:159) | **ok** (Route only; Trail ignored) | `data/test/FR24 KML WN276-3d7b69c5.kml` |
| FR24 free-tier (alt=0) | FR24 Route, every alt = 0 | B-FR24 | **ok** (ground track; data limitation) | `TEST Oregon UFO Lights/UA1596-…kml` |
| FR24 mislocated in ADSBx dir | FR24 Route/Trail, Doc name `AS3337/SKW3337`, no `gx:Track` | B-FR24 | **ok** geometry; **name decision** (whole `AS3337/SKW3337` vs `AS3337`) | `TEST KMLs/ADSBx/AS3337-3725d0ec.kml` |
| ADSBx single, 1 `gx:Track` | `Folder>Folder[single]>Placemark>gx:Track` | B-ADSBxSingle (:204) | **ok** (datum aside) | `TEST STANAG 4676/KML 1 - N410WN…kml` |
| ADSBx single, 2 `gx:Track` (ground+air) | `Folder>Folder[single]>Placemark[2]` (both same name) | B-ADSBxSingle | **silently-wrong** (122 ground pts at alt=0 read as HAE) | `tests/kml-fixtures/real/adsbx-single-runway-then-flight.kml` |
| ADSBx multi-aircraft | `Folder>Folder[N]`, each `<TAIL> track` | B-ADSBxMulti (:209) | **ok** / **silently-wrong** per ground seg | `data/test/ADSBX - 3 tracks …kml` |
| ADSBx 6-aircraft, mixed segment counts | 1 outer + 6 inner Folders, 13 `gx:Track`, only 7 `altitudeMode` (6 ground segs none); dup first `<when>`; `C-GNJZ` hyphen reg | B-ADSBxMulti | **silently-wrong** (6 ground legs at HAE=0); strongest G1 evidence | `TEST STANAG 4676/AE313D-C-GNJZ-N109UW-N709PS-N765US-N941NN-…kml` |
| ADSBx EGM96 / EGM96_avg datum | same `gx:Track` shape, altitude on geoid | B-ADSBxSingle/Multi | **silently-wrong** (datum: ~421 m too high at cruise) | `Comparison DAL 792…/…-EGM96.kml` |
| ADSBx name with hyphen | `02-3633 track` / `93-0621` / `C-GNJZ` | B-ADSBxMulti | **partial** (`/([A-Z0-9]+) track/` drops `02-`/`C-`) unless `Sit.allowDashInFlightNumber` | `TEST CSVs/02-3633-…kml` |
| Sitrec/Metabunk single `gx:Track` | `Document>Placemark>gx:Track` (single object) | B-DocSingle (:199) | **ok** | `data/chilean/LA330.kml` |
| Sitrec own export (`Folder>Placemark>gx:Track`, no inner Folder) | `Folder>Placemark>gx:Track` | **B-Fallback (:228)** | **asserts-dev** then works in prod | Sitrec's own exported track KML |
| Document > N gx:Track (hand-padded) | `Document>Placemark[3]`: 2 empty pads + `gx:Track` | B-FA | **ok** geometry; name = `Chopper` (via Placemark[2].name once registry lands; "Track" today) | `data/chilean/Chile Chopper…GPSTime.kml` |
| Spurious-point variants (FA-format) | `Document>Placemark[3]`, 1 `gx:Track`, 1 coord replaced with a ~6° outlier at fixed time/alt | B-FA | **ok** import (parser does no outlier rejection); outlier is a *vertical/horizontal* problem for the downstream filter | `TEST Spurious Points Filter/ITY621 One Bad.kml` |
| Static shapes, no time | `Document>Folder>Placemark` LineString/Polygon/Point | else (:232) → false | **not-a-track** (correct; shapes via `extractKMLObjectsInternal`) | `data/test/Rugeley (Buildings).kml` |
| `gx:TimeSpan` inside `LookAt` (camera time trap) | static shapes + camera `gx:TimeSpan` | else → false | **not-a-track** (correct — must stay so) | `Local Sitches/Rugeley.kml`; also `s3-backup/5177/SAS59Z` (only other corpus `TimeSpan`, also a `LookAt`) |
| STANAG-derived elevated LineString, no `<when>` | `Document>Folder>Folder>LineString` (absolute alt) | else → false | **not-a-track** | `TEST STANAG 4676/elevated_track.kml` |
| KMZ GroundOverlay imagery | `Document>Folder>GroundOverlay` (Icon href + LatLonBox) | overlay path | **ok** (overlay textures) | `TEST Overlays…/snapshot-…kmz` |
| `.zip`-wrapped KML (+`__MACOSX/._`) | plain `.zip` containing one byte-identical KML | KMZ/zip path | **ok** (junk skipped) | `TEST Zip…/One KML .kml.zip` |
| `.zip` no KML (image / GeoTIFF) | zip-magic opens, no `.kml` inside | KMZ/zip path | **not-a-track** (must not crash) | `TEST Zip…/One.jpg.zip` |
| `gx:MultiTrack` (synthetic only) | one Placemark, multiple `gx:Track` children | — | **would mis-handle** (reads only `track['gx:Track']`) | `tests/kml-fixtures/synthetic/gx-multitrack.kml` |
| `TimeSpan`-on-feature track (synthetic only) | timed track via `<TimeSpan><begin>` per Placemark | else → false | **no path today** (design target) | `tests/kml-fixtures/synthetic/timespan-track.kml` |

**Confirmed by full-tree scan:** NO corpus file uses `NetworkLink`, `ExtendedData`, `SchemaData`, or real `gx:MultiTrack`; the only `TimeSpan` instances anywhere are the `LookAt`/`Camera` camera-time trap (Rugeley + one Sitrec-exported `SAS59Z`). So `gx:MultiTrack` and `TimeSpan`-on-feature are **defensive/synthetic-only** cases — correctly deferred (Open Q7), with synthetic fixtures already staged.

---

## 4. Gap Analysis (Specific Defects)

**G1 — ADSBx multi-`gx:Track` concatenation reads ground `alt=0` as HAE (CONFIRMED, and embedded in a committed fixture).** The committed `data/test/ADSBX - 3 tracks …kml` N410WN folder (line 248) has **2 Placemarks, both named `N410WN`**: the first `gx:Track` (line ~258) has `<extrude>0</extrude>` and **no** `altitudeMode` — 122 ground samples, every alt literally a small constant/`0`; the second (`<altitudeMode>absolute</altitudeMode>`) climbs to real altitude. `tracks.forEach` (line 259) pushes **both** into one `when[]/coord[]`. The file contains **122 `… 0</gx:coord>` ground samples**. `altitudeMode` is **never read** for `gx:Track`, so the parser cannot distinguish the segments. The `tests/kml-fixtures/real/adsbx-single-runway-then-flight.kml` is the same shape in isolation; the `TEST STANAG 4676/AE313D-…` 6-aircraft file is the **strongest** case (13 `gx:Track`, only 7 `altitudeMode`, so 6 ground legs default to HAE=0, plus a duplicated first `<when>`). **Fixing G1 will change the output of the committed `data/test` ADSBX fixture** — not merely the external corpus.

**G2 — Altitude datum treated as HAE verbatim across all track formats.** The `Comparison DAL 792` set imports the same physical flight at **three vertical positions**: FlightAware/FR24/press_alt all barometric (~10058 m at FL330) vs ADSBx EGM96/EGM96_avg geometric (~10479 m, ~421 m higher). `altitudeMode=absolute` is **misleading** — the true datum is encoded only in the **filename** (`-press_alt_uncorrected`, `-EGM96`, `-EGM96_avg`). `toMISB` (:45) maps `alt`→`SensorTrueAltitude` with no datum awareness.

**G3 — `clampToGround` / `relativeToGround` mishandled.** FR24 free-tier and ADSBx ground segments carry `alt=0` meaning "on terrain", not "HAE=0". `relativeToGround` means "meters above terrain". The track path ignores `altitudeMode` entirely.

**G4 — FlightAware naming is fragile AND lives in TWO independent code paths (clarified vs draft).** `getKMLTrackWhenCoord`'s B-FA sets `info.name = Document.name.split(' ')[2]` (:197) — but this `info.name` is **largely unused for display**. The name that actually pins `N494SA` in tests comes from **`getShortName`'s own separate regex ladder** (`/FlightAware ✈ ([A-Z0-9]+) /` and `/([A-Z0-9]+)\/[A-Z0-9]+/` on `Document.name`, lines 96–101), which never consults `info.name`. For `N494SA`, `Document.name`-regex and `Placemark[2].name` both yield `N494SA` — but the code paths differ. `IBE6830 FlightAware plus Reconstructed.kml` → `Document.name` lacks `✈`, so the `CALLSIGN/ICAO` regex yields `IBE6830` (the draft's claim that this becomes "plus" is true only of the *unused* `info.name`). Chile Chopper exploits B-FA's `[2]` index with two empty pad placemarks; `getShortName` returns "Track" today, `Chopper` once the registry uses `Placemark.name`.

**G5 — B-Fallback `assert(0)` on Sitrec's own export.** A single `Folder>Placemark>gx:Track` (no inner `Folder.Folder`) hits line 228–230 `assert(0, "Unknown KML format")` — `debugger` freeze in dev, stripped by Terser in prod where it silently falls through to `tracks = kml.kml.Folder.Placemark`. A real dev-vs-prod divergence on Sitrec's **own** export. **Note:** a normal jest run uses the prod-stripped assert form, so this path is currently **untestable** without forcing asserts active (see §8).

**G6 — Single-element arrays mis-read (scoped).** `parseXml` (`src/parseXml.js:4`) promotes a tag to an array only when ≥2 siblings exist. The track *arrays* are already partly guarded (`if (!Array.isArray(tracks)) tracks=[tracks]` at :246–248; `Array.isArray` at :195,209). The **unguarded** bite is `when`/`gx:coord`: a `gx:Track` with exactly ONE `<when>` makes `whenArray` an object, so `whenArray.length` at :270 is `undefined`, the loop never runs, and the track imports **silently empty** (probe-mode `doesContainTrack` still returns true → `toMISB` returns `[]`). No corpus file has a single-sample `gx:Track`; `synthetic/empty-track-export.kml` is the staged regression for the graceful-empty case.

**G7 — Multi-encoding files unsupported.** The branch ladder picks exactly one shape. `synthetic/mixed-sources-one-file.kml` (gx:Track + FR24 points) is the staged target.

**G8 — `gx:coord` split fragility.** The track loop splits on a single `' '` (line 279). The committed ADSBX fixture writes `<gx:coord >` with a trailing space; pretty-printed KML uses tabs/newlines. `extractCoordinates` (:430) already uses the tolerant `/\s+/` split — the `gx:Track` path does not.

**G9 — No de-duplication across files.** Byte-identical `Duplicates - Same File Differnt Naem/` imports as colliding aircraft. **Out of scope** for this parser plan (import-orchestration concern; flagged, not solved).

**G10 — `gx:MultiTrack` and `TimeSpan`-on-feature have no path.** Defensive/synthetic cases (no real corpus samples); staged fixtures cover the synthetic side.

**G11 — Spurious points are not a parser concern, but couple to G1.** `ITY621 One Bad.kml` injects one ~6° outlier at a fixed timestamp/altitude. The parser must **import it without crashing or dropping** (it does no outlier rejection — filtering lives downstream: `TrackManager.js:784` "Enable Bad Data Filter?" + the g-force filter in `CNodeMISBData.js`). **Critically, G1's alt=0→cruise vertical jump is *invisible* to a horizontal g-force filter** — so the segment fix is the only guard against the ground-leg-at-HAE-0 artifact; the bad-data filter will not catch it.

---

## 5. Proposed Generic Ingestion Design

Replace the brittle branch ladder in `getKMLTrackWhenCoord` with a **recursive tree-walk extractor** that collects `(epochTime, lon, lat, alt, altitudeMode)` samples from **any** time+geometry pairing, groups them into tracks, and dedups. The three existing providers fall out as the generic case.

### Contract
- `canHandle(filename, data)` — unchanged: `!!data.kml`.
- `extractTracks(data) → TrackGroup[]` — new core. Each `TrackGroup = { samples: [{t, lon, lat, alt, altitudeMode}], altitudeModeDominant, datumHint, nameContext }`. Pure, render-free, deterministic.
- `doesContainTrack()` = `extractTracks().length > 0`.
- `getTrackCount()` = `extractTracks().length`.
- `toMISB(i)` = MISB rows from `extractTracks()[i].samples` (back-compat shape: `UnixTimeStamp`, `SensorLatitude`, `SensorLongitude`, `SensorTrueAltitude`).
- `getShortName(i)` = name resolver (§6) applied to `extractTracks()[i].nameContext`.

### Algorithm

**Step 0 — Normalize parse, on a SEPARATE tree.** Re-parse (or clone+normalize) **only for the track extractor** with `arrayTags = ['Document','Folder','Placemark','gx:Track','when','gx:coord','coordinates']`, leaving the tree that feeds `extractKMLObjectsInternal` **byte-unchanged** (see G-major below). Internally guard with `asArray(x) = x===undefined ? [] : Array.isArray(x) ? x : [x]`. This kills the G6 single-element class for the track path and lets `getTrackCount`/`toMISB` share one path. **The single shared parse at `CFileManagerParse.js:1442` feeds BOTH the track path and `extractKMLObjectsInternal`; the arrayTags normalization must NOT mutate the object that `extractKMLObjectsInternal` walks**, or the static-shape path (Rugeley etc.) would silently change while the plan says it's "untouched." Use a normalized clone for tracks only, OR `asArray`-harden `extractKMLObjectsInternal` in the same phase (it cannot be both "untouched" and sharing a re-arrayed tree).

**Step 1 — Recursive descent collecting candidate features.** Walk from `kml.kml` depth-first through `Document`, `Folder` (any nesting — covers `deep-nested-subfolder-track.kml`), `Placemark`, transparently descending `gx:MultiTrack` (treat child `gx:Track` list as ordered segments). Maintain ancestry `(kind, name, id)` so each sample knows its enclosing Placemark and Folder identity.

**Step 2 — At each geometry leaf, classify into timed samples** (in order):
- **(a) `gx:Track` / `gx:MultiTrack`** — pair `asArray(when)[i]` with `asArray(gx:coord)[i]` **by index**. Split `gx:coord` on `/\s+/` (reuse `extractCoordinates`' tolerant split — fixes G8). Truncate to `min(when.length, coord.length)`; skip empty-text `when`. Read `altitudeMode` or `gx:altitudeMode` off the `gx:Track` node, default `clampToGround`. Emit N samples.
- **(b) Placemark with a DIRECT `TimeStamp/when` AND a single geometry** (`Point`, or first vertex) — emit ONE sample (FR24 Route case).
- **(c) Placemark with `TimeSpan(begin,end)` + geometry** — emit one sample at `begin` (`timespan-track.kml`); prefer `gx:Track` samples if both present.
- **(d) Geometry with NO time** → route to `extractKMLObjectsInternal` as a static shape; **never** a track.
- **CRITICAL:** a time primitive counts only as a **direct** time child of the feature/geometry. **Ignore** `gx:TimeSpan`/`TimeStamp` nested inside `<LookAt>`/`<Camera>` (Rugeley + SAS59Z camera-time trap). **Never mine `<description>` CDATA for time** — the FR24 Trail folder carries timestamps only in CDATA, and treating them as samples would turn one 430-point Route track into 859 mixed features (see §8 FR24 guard).

**Step 3 — Group samples into tracks by ENCLOSING FOLDER IDENTITY (back-compat-critical).**
- `gx:Track`/`gx:MultiTrack` directly under a single Placemark → that Placemark is one track (segments concatenated, document order).
- A run of type-(b) timed Placemarks sharing the **same immediate parent Folder** with monotonic times → that Folder is one track (FR24 Route).
- Distinct sibling Folders each containing `gx:Track`(s) → distinct tracks (ADSBx multi).
- **Multiple Placemarks in ONE inner Folder (ADSBx N410WN ground+air): concatenate ALL of them, keyed strictly on FOLDER identity — NOT on `Placemark.name`.** Today's `getValidIndexedTrackInFolder` (:293–307) and `getTrackCount` (:127–142) count **inner Folders with ≥1 Placemark**, so "one inner Folder = one track" is the invariant. Keying grouping on placemark-name risks splitting a folder whose segments are mislabeled, increasing track **count** and shifting every downstream `trackIndex`. *(In the corpus every multi-placemark folder happens to share one name — N410WN/N410WN, N1809U/N1809U, etc. — so folder-keying and name-keying coincide; folder-keying is the safe choice that preserves count.)* This makes `trackIndex` an index into the ordered grouped-track list and lets one file mix heterogeneous track types (fixes G7).

**Step 4 — Per track:** dedup **consecutive** duplicate-time samples in **document order** (compare time string; matches today's :273 behavior). **Do NOT sort-then-dedup by default** — the corpus segments are already time-ordered (N410WN seg1 ends `00:23:15.840`, seg2 starts `00:23:15.980`), and a sort-before-dedup would (a) change consecutive-only semantics into global-equal-time-drop (potentially losing legal non-consecutive equal-time samples) and (b) risk a non-stable sort swapping which of two equal-time samples survives. **If** out-of-order segments are ever detected, apply an **explicitly stable** sort, and document that as an intentional, parity-gated behavior change. Convert to MISB. Carry `altitudeMode`+`datumHint` per track (§7). Ensure `timeStrToEpoch` handles `Z`, fractional `.250Z`, and `+00:00` forms.

**Step 5 — Name:** pluggable resolver — the only source-specific code left (§6).

### How it subsumes the existing branches
| Old branch | Generic equivalent |
|---|---|
| B-FR24 (:159) | Step 2(b) + Step 3 Folder-grouping (no `name==="Route"` gate); Trail folder → static shapes |
| B-FA (:194) | Step 2(a) finds the Placemark that **has** a `gx:Track` (no `[2]` index) |
| B-DocSingle (:199) | Step 2(a) on the single Placemark |
| B-ADSBxSingle/Multi (:204) | Step 2(a) per inner Folder + Step 3 folder-keyed grouping |
| B-Fallback (:228) `assert(0)` | Step 1 walks `Folder>Placemark>gx:Track` directly — **assert gone** (fixes G5) |
| else (:232) false | `extractTracks()` returns `[]` |

### Back-compat (explicit)
- **Track ordering** must match `getValidIndexedTrackInFolder` (document order of folders-with-placemarks). Pin index→name for multi-track fixtures **before** flipping the flag. `getTrackCount()===3` for the committed ADSBX fixture and per-folder counts for the 6-aircraft STANAG file are parity assertions.
- **Names** must match today's `getShortName` output for the 5 standard FlightAware + ADSBx files. Where the new resolver is *better* (`Chopper` not "Track"), gate behind review — see Open Questions.
- Keep `extractKMLObjectsInternal` (shape path) and the KMZ/overlay path **untouched** in Phase 1 — enforced by the separate-tree rule in Step 0.

---

## 6. Bespoke Name Extraction (Pluggable Registry)

**First, enumerate ALL THREE existing naming paths** so the registry's scope is unambiguous (this was conflated in the draft):
1. **`getShortName`'s own regex ladder** (`CTrackFileKML.js:50–113`): runs `/([A-Z0-9]+) track/` (or `-` variant under `Sit.allowDashInFlightNumber`) on `Folder.Folder` name, then `/FlightAware ✈ …/` and `/CALLSIGN\/ICAO/` on `Document.name`. **This is the path that actually feeds display names.**
2. **`getKMLTrackWhenCoord`'s `info.name`** (e.g. B-FA `split(' ')[2]`): largely unused for display; sets `getShortName`'s *initial* `shortName` only as a fallback before the regex ladder overwrites it.
3. **`TrackManager.js:1456–1473` filename fallback** (`/FlightAware_([A-Z0-9]+)_/`, `/([A-Z0-9]+)-track-/`, `/([A-Z0-9]+)-[0-9a-f]+\.kml/`), fired only when `getShortName` returns falsy, and **`configuredShortNames` override** (:1430) which prefers serialized names to protect saved mods.

The registry **replaces path 1's regex ladder** (operating on the new `nameContext`) and **subsumes path 2** (drop the dead `info.name` split). It must **coexist with path 3** (filename fallback stays as the last resort) and **honor `configuredShortNames`** (saved names always win). Given `nameContext = { placemarkName, folderName, documentName, fileName, trackIndex }`, try in order, stop at first match:

1. **Enclosing `Placemark.name`** — the robust universal source. FlightAware (`Placemark[2].name`=callsign, fixing G4), chilean `LA330`/`IBE6830`/`Chopper`, ADSBx per-placemark name (`C-GNJZ`, not the mangled `GNJZ`). **MUST win over the folder regex** so ICAO-registration tails (`C-GNJZ`) survive. *Fixes IBE6830 and Chile Chopper.*
2. **ADSBx/Sitrec folder rule** — `/([A-Z0-9\-]+) track/` on `folderName` (the `-` class handles `02-3633`, `93-0621`, `C-GNJZ`; matches `Sit.allowDashInFlightNumber`). Keep the no-dash variant as default-off fallback for current behavior.
3. **FlightAware Document rule** — `/FlightAware ✈ ([A-Z0-9]+) /` then `/([A-Z0-9]+)\/[A-Z0-9]+/` (existing regexes :96–101). Drop brittle `split(' ')[2]`.
4. **FR24 Document rule** — `CALLSIGN/ICAO` (e.g. `AS3337/SKW3337`, `DL792/DAL792`) → **decision flagged (Open Q3):** take `CALLSIGN` token or keep whole. Recommend taking the token before `/`.
5. **Fallback** — `fileName + "_" + trackIndex` (matches `getShortName`'s and TrackManager's existing fallback shape).

Each rule is `{ test(ctx) → bool, name(ctx) → string }` — data, not control flow. **Pin the existing `getShortName` outputs for all in-repo fixtures (`N494SA`, `N2983Z`/`N410WN`/`N414WN`, FR24) as parity baselines FIRST**, then verify rule #1's `Placemark.name` equals the old regex output before assuming back-compat (for N494SA both = `N494SA`; verified).

---

## 7. Altitude Datum Handling

Store **`(altitudeRaw, altitudeMode, datumHint)` per track**, resolve to HAE explicitly. Per OGC KML 2.3:

- **`absolute`** → height above WGS84 ellipsoid = **HAE**. Correct for FlightAware/chilean. **TRAP:** ADSBx `-EGM96`/`-press_alt` files also write `absolute` but the numbers are geoid/pressure — `altitudeMode` alone is NOT a reliable HAE signal.
- **`clampToGround`** (KML default when absent) → altitude **ignored**, feature on terrain. For a track = "no usable altitude"; clamp to Sitrec terrain. Do **not** store `0` as real HAE (fixes FR24 free-tier + ADSBx ground segments, G3).
- **`relativeToGround`** → meters above terrain; add terrain elevation per lon/lat via the elevation service.
- **`relativeToSeaFloor` / `clampToSeaFloor`** (`gx:altitudeMode`) → no corpus samples; treat like `clampToGround` until bathymetry exists.
- Walker reads **either** `<altitudeMode>` **or** `<gx:altitudeMode>`, default `clampToGround`.

**`datumHint`** (out-of-band — no in-file signal): parse the **filename** for `EGM96`, `EGM96_avg`, `press_alt`/`press_alt_uncorrected`.
- `EGM96`/`EGM96_avg` → apply EGM96 geoid undulation (`EGM96Geoid.js` exists) → HAE.
- `press_alt*` → barometric; at minimum **flag** so it isn't silently trusted as HAE.
- Otherwise → `absolute = HAE` (today's behavior).

**Regression-safety (highest-risk area):**
1. **Phase 1 changes NOTHING numerically** — only *record* `altitudeMode`/`datumHint` alongside the existing verbatim altitude. `toMISB` byte-identical.
2. `clampToGround→ignore` and EGM96/pressure corrections ship **behind a flag**, validated on the `Comparison DAL 792` goldmine (EGM96 vs press_alt should converge to within geoid undulation post-correction) before default-on.
3. **The G1/G3 fix changes the committed `data/test/ADSBX - 3 tracks …kml` output** (its N410WN track currently has 122 ground samples at HAE=0). Update that fixture's expected output **in the same commit** as the behavior change, with an explicit assertion that the ground leg is NOT at literal HAE=0 — never a silent diff.

---

## 8. Test Framework Plan (Build ON the Staged Suite)

**The scaffolding the draft proposed is already staged** (`tests/CTrackFileKML.variants.test.js` + 12 fixtures + README). This section *extends* it; it does not re-create it.

### Architecture: committed fixtures are the gate; the Dropbox corpus is an opt-in local sweep
The env-gated `SITREC_KML_CORPUS` runner from the draft is **demoted**: a `describe.skip`-when-unset suite reports **green-when-broken** everywhere except Mick's machine (the exact anti-pattern to avoid). Instead:

- **Tier A — committed variant suite (the CI gate).** `tests/CTrackFileKML.variants.test.js` already does this, render-free, in CI on every push. **Extend its MANIFEST**, not replace it. The 12 staged fixtures + 4 legacy `data/test` files ARE the regression contract. Add the missing assertions below.
- **Tier A KMZ.** Test KMZ unzip **in jest** (cheapest): `tests/jszip.test.js` proves JSZip loads under jest, so `JSZip.loadAsync(fixtureBuffer)` → pull inner `.kml` text → feed the real `CTrackFileKML` (same mocked-deps pattern). Add a **tiny synthetic `.kmz`** (few-KB inner KML + 1×1 PNG GroundOverlay) under `tests/kml-fixtures/`, plus a synthetic `.zip`-wrapped KML **with** an `__MACOSX/._` junk entry to assert junk-skip. This covers the unzip→inner-KML→track contract without the 33-import `parseAsset` graph.
- **Tier B — real `detectTrackFile` routing.** Replace `CFileManager.test.js`'s hand-rolled copy with the real `CFileManagerParse.detectTrackFile` (:1619). **Spike first** whether it imports under the existing mocks; `CFileManagerParse.js` pulls 33 imports including the node graph, so if too heavy, factor the pure extension→parser-class dispatch into a separately-importable function and test that. Budget for it — it's not free.
- **Tier C — end-to-end / `parseAsset`.** **The scenario harness has NO file-import primitive** (`run-scenarios.mjs` steps are `apiCall`/`capture`/`eval` only, and line ~102 bars external data). So true `parseAsset` e2e requires **new infrastructure**: add a `loadAsset`/`importFile` API to `window.sitrecAPI` + a `loadFile` scenario step, then import a bundled tiny fixture. **Scope that as its own task** — do not assume it exists. Until then, Tier A KMZ (jszip) carries the unzip contract.

### Optional local corpus sweep (NOT a CI gate)
Keep the full ~50-file Dropbox sweep as a **separate opt-in script** (`npm run test-kml-corpus`), explicitly an exploratory local tool, NOT part of `npm test`/CI. Its absence prints "corpus not found, skipping local sweep" to **stderr** (loud), never a silent passing test. It reads its root from an env var but is **documented** in a runner README. Flag duplicate basenames (the corpus has `6 -` vs `6XXX -` near-duplicates and the `Duplicates - Same File Differnt Naem/` pair) so collisions surface instead of silently overwriting an expectation.

### Assertions to ADD to Tier A (beyond what the staged suite checks)
The staged suite asserts finiteness, lat/lon bounds, non-decreasing time, `trackCount`, and `getShortName`-contains. **Add:**
- **Altitude semantics (NEW):** for `clampToGround`/`alt=0` files (the N410WN ground segment), assert the ground leg is treated as unknown/terrain, **not** literal HAE=0. For the `Comparison DAL 792` set (corpus-only / curated synthetic stand-in), assert EGM96 vs press_alt differ pre-correction and converge post-correction.
- **Concatenation correctness:** ADSBX 3-track `toMISB(1)` (N410WN) → one continuous track with the ground segment **not** at HAE=0; duplicate-first-`when` collapsed. Pin `getTrackCount()===3` and per-folder counts for the 6-aircraft STANAG fixture (must stay **6**, not split per segment).
- **FR24 load-bearing guard:** FR24 fixture yields **exactly ONE track (~430 pts, Route only)**; the Trail folder produces static LineString features or nothing, **never** timed samples; the walker **ignores `<description>` CDATA timestamps**. This is the single highest-value FR24 regression guard.
- **Name parity + improvements:** pin existing `getShortName` for `N494SA`, ADSBX tails, FR24; pin the *improved* names (`IBE6830`, `Chopper`, `02-3633`, `C-GNJZ`) behind the review gate (Open Q2).
- **Camera-time-trap lock:** Rugeley AND a `LookAt gx:TimeSpan` fixture (SAS59Z-style) → `doesContainTrack()===false`.
- **Empty/single-sample:** a 1-sample `gx:Track` yields a 1-row (not 0-row) MISB; `doesContainTrack()` agrees with `toMISB().length>0` (reference `synthetic/empty-track-export.kml`).
- **Spurious-point import (NEW):** an `ITY621 One Bad`-style fixture still imports (parser must not crash/drop on a single outlier). Note in §7/Risks that G1's alt=0→cruise jump is invisible to the horizontal g-force filter — the segment fix is the only guard.
- **Round-trip (promote to first-class):** export a track → KML → re-import → assert point count + first/last `(t,lon,lat,alt)` + `trackCount` stable. **This is the strongest, most self-contained test** — input is Sitrec's own deterministic export, no corpus / manifest / provider data, fully CI-safe, AND it is the B-Fallback (G5) fixture. Commit the export (Sitrec's own output, no licensing question) and run it in CI unconditionally.

### Parity gating (refined — NOT blanket byte-parity)
Blanket "byte-parity with Phase-0 baselines" is self-contradictory: several variants are **known-wrong today** (G1 alt-0, G4 dead `info.name`, G5 dev-assert), so requiring the generic path to reproduce them, then breaking parity to fix them, baselines bugs as golden values. Instead:
- **Parity on INVARIANTS + KNOWN-CORRECT variants** (time monotonic, finite/bounded coords, `trackCount`, ordering, names for the standard files, geometry first/last coord for FA files).
- **Explicit divergence-with-rationale** on the known-wrong ones, tracked by a small allowlist of intentional behavior changes (the bug fixes), so the gate distinguishes "expected fix" from "accidental regression."
- **Never snapshot a known-corrupt value as golden.** For bug-sensitive altitudes, either omit altitude from the baseline until Phase 5 and assert it separately, OR write an explicit assertion encoding the CORRECT physics ("the N410WN track must NOT have a ~17-min run at altitude exactly 0 followed by a jump to cruise") that fails until Phase 3 fixes it. Mirrors the harness's existing "never write a baseline from a failing run" poison-guard.
- **Make G5 detectable:** the variant suite must run with asserts ACTIVE (import the dev assert or wrap-to-throw) so the Sitrec-own-export fixture genuinely catches `assert(0)` before Phase 1 removes it — otherwise it passes vacuously under jest's prod-stripped assert.

### Fixture size / licensing / locality (audit constraints — corrected reasoning)
- **The 4 existing `data/test/*.kml` ARE shipped** — `webpackCopyPatterns.js:30` copies the whole `data` tree into every build, and they carry `flightaware`/`flightradar` provider-attribution strings, yet appear in NO `DATA_FILES` entry of `generateThirdPartyNotices.js`. This is an **existing exposure to RESOLVE, not a precedent to extend**: either confirm the (factual ADS-B) position data is OK to redistribute and add proper attribution to `DATA_FILES`, or move them out of the build-copied path. Flag for Mick.
- **New committed fixtures should be SYNTHETIC** (hand-authored, as the staged `synthetic/` set already is) — zero provider data, zero licensing question, precise variant control. Where a real-provider quirk must be reproduced (the `✈` glyph, trailing-space `<gx:coord >`, EGM96 filename convention), reproduce the **quirk** in a synthetic file rather than committing a provider's actual flight. The staged `real/` copies are small and share provenance with existing `data/` files; keep new additions synthetic.
- **Keep all real-provider corpus files local/uncommitted** (the README already does this; the `s3-backup/` user-upload tree is deliberately excluded for privacy).
- **Pixel baselines stay local-only.** Only value-baseline JSON is committed. The fast-regression `.gitignore` (`tests_regression/fast-regression/.gitignore`) ignores `baseline/` and intentionally keeps `value-baseline/`; the **root** `.gitignore` only lists `/tests_regression/snapshots-baseline/` — different path, so state the exact gitignore path when wiring any harness outputs to avoid confusion.

---

## 9. Phased Implementation Roadmap (tests-first, each step ships independently)

**Phase 0 — Pin current behavior on the STAGED suite (no parser change).** Extend `tests/CTrackFileKML.variants.test.js`'s MANIFEST with the missing fixtures (6-aircraft STANAG, AS3337-FR24, spurious-point, camera-time-trap SAS59Z) and add the **invariant** assertions (ordering, `trackCount`, name parity) — but **do NOT baseline the known-wrong altitudes as golden** (write the correct-physics assertion as a pending/explicit check instead). Establish that the committed ADSBX fixture's N410WN ground leg is at HAE=0 *today* via a documented assertion that will be inverted in Phase 3/5. *All sitches unaffected.*

**Phase 1 — `arrayTags` normalization (separate tree) + kill B-Fallback assert.** Normalize a track-only tree with `arrayTags` + `asArray()`; leave `extractKMLObjectsInternal`'s input unchanged (or `asArray`-harden it in the same phase). Replace `assert(0)` (:228) with the generic `Folder>Placemark>gx:Track` walk. Output numerically identical for all 7 provider shapes; only behavior change = Sitrec's own export no longer asserts in dev (G5) and single-sample `gx:Track` no longer imports empty (G6). Pin with the round-trip test (run with asserts active) and a Rugeley shape-extraction parity test (proving the static path is unchanged).

**Phase 2 — Generic tree-walk extractor (behind a flag), parity-gated.** Implement `extractTracks()` (Steps 1–4) and route `toMISB`/`getTrackCount`/`doesContainTrack` through it when the flag is on. **Gate merge on parity-of-invariants + known-correct variants** (not blanket byte-parity), with an explicit allowlist for the intended fixes. Side-effect fixes (all parity-checked): G7 (multi-source), G10 (`gx:MultiTrack`/`TimeSpan` synthetics flip from `test.failing` to passing), G8 (`gx:coord` split).

**Phase 3 — Folder-keyed segment grouping + flip the flag.** Replace lucky `tracks.forEach` with **folder-identity-keyed** grouping (NOT name-keyed — preserves `trackIndex` count), concatenating all placemarks within an inner folder in document order, consecutive-dedup only (no speculative sort). The ADSBx ground/airborne split becomes one track with the ground leg **not** at HAE=0. **Update the committed ADSBX fixture's expected output in this commit.** Make the generic extractor default; delete the old branch ladder. Re-run full corpus sweep + all existing sitch regressions. Pin `getTrackCount()===3` (ADSBX) and `===6` (STANAG 6-aircraft).

**Phase 4 — Name registry.** Implement the pluggable resolver (§6), replacing path-1's regex ladder and dead path-2 `info.name`, coexisting with path-3 filename fallback + `configuredShortNames`. Preserve exact current names for standard files; surface improved names (`IBE6830`, `Chopper`, `02-3633`, `C-GNJZ`) **behind a review gate** (Open Q2). Resolve Open Q3 (FR24 `CALLSIGN/ICAO` token vs whole).

**Phase 5 — Altitude datum (record-only → correct-behind-flag).** Record `altitudeMode`/`datumHint` (no numeric change). Add `clampToGround→ignore`, EGM96 (via `EGM96Geoid.js`), press_alt handling **behind a flag**, validated on `Comparison DAL 792`. Default-on only after Mick signs off (Open Q1). This is where the committed ADSBX ground-leg altitude assertion inverts to "not HAE=0."

**Phase 6 — KMZ (Tier A jszip) + e2e infra.** Add the synthetic `.kmz`/`.zip`+`__MACOSX` fixtures through the jszip-in-jest path. If true `parseAsset` e2e is wanted, scope+add the `sitrecAPI.loadAsset` + scenario `loadFile` step as its own task, then add a scenario-harness KML-import entry with a committed value baseline. Add the real `detectTrackFile` routing test (Tier B).

---

## 10. Risks, Back-Compat Hazards, Open Questions

**Risks / hazards**
- **The G1/G3 altitude/de-concat fix changes a COMMITTED fixture, not just the corpus.** `data/test/ADSBX - 3 tracks …kml` `toMISB(1)` currently has 122 ground samples at HAE=0; the existing test only asserts `length>0`, so the bug is unpinned. Mitigation: Phase 0 documents it, Phase 3/5 updates the fixture's expected output in the same commit with an explicit ground-leg assertion. **Biggest single regression risk.**
- **Three independent naming paths must be reconciled, not conflated.** `getShortName`'s regex ladder (the real display path), the dead `info.name` split, and TrackManager's filename fallback + `configuredShortNames` override. The registry replaces the first two and coexists with the third; `configuredShortNames` (serialized names) must always win to protect saved mods.
- **Name changes can break serialized sitches.** `getShortName`'s own comment (:56–60) warns file-derived names "could break older sitches or serialized data." `TrackManager.js:1427–1429` warns parser-derived names become node IDs and changing them "orphans saved mods." The built-in chilean sitch (`SitChilean.js:14–16`) wires by **fixed id+path**, so it is insulated — but **the chilean built-in files (`IBE6830`, `Chile Chopper`) are exactly the ones whose names improve**, and any *user-saved* drag-drop import keyed on the old "plus"/"Track" id could orphan. `configuredShortNames` protects post-mechanism saves.
- **Track ordering/count must stay stable.** Folder-identity grouping (not name-keying) preserves the "one inner Folder = one track" invariant; pin counts before flipping the flag.
- **Shared parse tree.** The `arrayTags` normalization must not mutate the tree `extractKMLObjectsInternal` walks; use a track-only normalized clone or harden the shape path in the same phase.
- **Sort hazard.** Do NOT sort-then-dedup by default; corpus segments are already time-ordered. Any future sort must be explicitly stable and parity-gated.
- **Parity must distinguish "expected fix" from "accidental regression"** via an allowlist; never baseline a known-wrong value as golden; run the variant suite with asserts active so G5 is detectable.
- **Existing `data/test` KMLs ship unaudited** (provider-attributed, not in `DATA_FILES`). Resolve, don't extend.
- **De-dup across files (G9)** out of scope (import-orchestration, not parser).
- **Scenario harness lacks a file-import primitive** — Tier C e2e needs new infra; don't assume it exists.

**Open questions for Mick**
1. **Altitude datum default:** once EGM96/press_alt correction is validated, **default-on** (changing rendered altitude of existing ADSBx-sourced sitches and the committed ADSBX fixture) or opt-in per import / per-sitch flag?
2. **Name back-compat:** OK to ship the *corrected* names (`IBE6830` not "plus", `Chopper` not "Track", `02-3633`, `C-GNJZ`) even though they differ from what current saves may have stored? The chilean built-in files are by-id so safe; the risk is user-saved drag-drop imports. Preserve old names for already-saved sitches and only fix new imports, or change both?
3. **FR24 name:** keep the whole `CALLSIGN/ICAO` (e.g. `AS3337/SKW3337`, `DL792/DAL792`) or take just the leading `CALLSIGN` token? (Recommend the token; B-FA tokenizes, B-FR24 doesn't — inconsistent today.)
4. **press_alt reconciliation depth:** is flagging press_alt as "barometric, not HAE" enough for now, or do you want full QNH/terrain reconciliation in this pass?
5. **`relativeToGround` tracks:** add terrain elevation per-point via the elevation service (heavier, async), or treat as unknown/clamp for now? (No corpus *track* uses it — only Rugeley shapes — so likely deferrable.)
6. **Existing `data/test` KML licensing:** confirm the 4 shipped, provider-attributed KMLs are OK to redistribute (and add to `DATA_FILES`), or move them out of the build-copied path?
7. **`gx:MultiTrack` / `TimeSpan`-on-feature:** implement now (synthetic fixtures already staged, no real corpus samples) for "Google-Earth-animates-it" completeness, or defer until a real file appears?
8. **Tier C e2e infra:** worth adding `sitrecAPI.loadAsset` + a scenario `loadFile` step now (for true `parseAsset`/KMZ e2e), or is Tier-A jszip-in-jest coverage of the unzip contract sufficient for this pass?

---

## Back-compat hardening (review 2026-06-08 — "don't break existing saves")

A focused audit against one test — *does any change alter the result of re-importing a file that a save depends on?* Saves re-run `addTracks` on load (not baked nodes), so they depend on **four** re-import observables: **(1) track node IDs** (`Track_<shortName>`), **(2) geometry** (the MISB time/lat/lon/alt — saved cameras, targets, LOS, measurements, and frame/time-sync all key off exact values), **(3) track count + `trackIndex` mapping** (`selectedTracks`, per-index `Track_<name>`), **(4) track-vs-shape classification**. Changing any of these for a **currently-importing** file orphans or visually breaks saves. (Making files that currently *fail* import is always safe — a non-importing file has no saves.)

**The general rule (supersedes the per-issue notes above): for every file that imports today, the refactor must reproduce ALL FOUR observables byte-for-byte on the default path. Every behavior "fix" ships gated.**

**Use the existing per-save version gate, not a global flag.** `findShortName` already gates a name change with `(!Globals.deserializing || Globals.exportTagNumber >= 2009003)` (TrackManager.js:1479) — old saves keep old behavior, new imports get the fix. There are **9 such `exportTagNumber` gates** in the codebase; this is the proven mechanism. A *global* flag (as §7/Phase 5 proposes for datum) is the wrong tool: if it ever defaults on, **every** existing save's track geometry shifts at once. **Gate the datum correction (and any name/grouping change) on `exportTagNumber` per-save**, so a pre-vX save re-imports with its original verbatim altitude/name/grouping and only fresh-or-new-enough saves get the improvement.

**Specific siblings of the name issue found in the plan:**
- **Altitude/datum (G1/G2/G3) is the biggest — it's the geometry analogue of the name orphan.** Correcting alt=0-ground / EGM96 / press_alt *moves the track in 3D*; a save's camera/LOS/target tuned to today's (wrong) altitude breaks silently. → version-gate per save; never retroactively re-altitude an existing save.
- **The name registry (Phase 4) changes names even without the explicit "corrections":** making `Placemark.name` win over the folder regex changes ADSBx outputs where they differ (`C-GNJZ` vs `GNJZ`). The registry's *default* output must equal today's `getShortName` for all importing files; the frozen-names test gates the whole registry, not just the corrections.
- **Track count / folder grouping (Phase 3)** and **FR24 Trail handling** must not change `getTrackCount()` or `trackIndex→track` for any importing file. Pinning two fixtures is insufficient.

**Verification gap + fix.** The plan's parity gates on "invariants + first/last coord + 2 pinned counts" — that cannot catch a mid-track geometry change, a count change on an unpinned file, or a frame-range shift. **Mitigation (implemented):** `tests/CTrackFileKML.corpus.local.test.js` now writes a **full parity baseline** — per importing file: `count`, and per track `name`, point-count `n`, time range `t0/t1`, first/last `(lat,lon,alt)`, and an FNV hash over **every** sample. Run it before the refactor, save `kml_parity_baseline.txt`, run after, and `diff` MUST be empty for the default (non-version-gated) path. This mechanically proves none of the four observables changed across all ~1,380 importing files — not just the committed fixtures. The frozen-names test (`CTrackFileKML.variants.test.js`) is the committed CI subset of the same guarantee.

---

## Changes from review

The adversarial pass changed the plan substantially:

- **Discovered the test scaffolding already exists** (staged in git): `tests/CTrackFileKML.variants.test.js` + 12 fixtures (`tests/kml-fixtures/{real,synthetic}/`) + README, with a MANIFEST and `test.failing` gap-targets. Section 8 was rewritten to **build ON** this rather than re-create it; the draft's "no KMZ/MultiTrack fixture exists" claims were corrected.
- **Corrected the G4 naming diagnosis:** `getShortName` has its OWN regex ladder (the real display path); B-FA's `info.name = split(' ')[2]` is largely dead. Enumerated all **three** naming paths (getShortName ladder, info.name, TrackManager filename fallback + `configuredShortNames`) and scoped the registry precisely. IBE6830 → `IBE6830` (not "plus", which is only the dead info.name).
- **Surfaced that the G1 fix changes a COMMITTED fixture** (`data/test/ADSBX - 3 tracks …kml`, 122 ground samples at HAE=0, currently unpinned). Added explicit fixture-update-in-same-commit gating (§7, Phase 3/5).
- **Changed segment grouping from name-keyed to FOLDER-identity-keyed** to preserve the "one inner Folder = one track" `trackIndex` invariant (corpus folders happen to share names, so behavior coincides, but folder-keying is the safe choice).
- **Removed the speculative sort-then-dedup**; corpus segments are already time-ordered, and sort-before-dedup changes consecutive-only semantics and risks unstable-sort sample swaps. Sort only on detected out-of-order, explicitly stable, parity-gated.
- **Fixed the shared-parse-tree hazard:** `arrayTags` normalization runs on a track-only tree so `extractKMLObjectsInternal` stays genuinely untouched in Phase 1.
- **Demoted the `SITREC_KML_CORPUS` env-gated runner** from primary mechanism (green-when-broken anti-pattern) to an opt-in local sweep with loud-stderr absence; committed synthetic fixtures are the CI gate.
- **Rejected "baseline the known-wrong behavior":** parity now gates on invariants + known-correct variants with an explicit fix-allowlist; bug-sensitive altitudes are asserted by correct-physics, never snapshotted as golden. Made G5's `assert(0)` detectable by running the suite with asserts active.
- **Re-routed KMZ testing** to Tier-A jszip-in-jest (the scenario harness has no file-import primitive); scoped true `parseAsset` e2e as separate infra (new Open Q8).
- **Corrected the licensing reasoning:** the 4 shipped `data/test` KMLs are an exposure to resolve (new Open Q6), not a precedent; new fixtures should be synthetic.
- **Added missing corpus variants:** the 6-aircraft STANAG file (strongest G1 evidence, 13 gx:Track / 7 altitudeMode, `C-GNJZ` hyphen, dup first when), the FR24-structured `AS3337` mis-filed in the ADSBx dir (forces Open Q3), the Spurious Points group (new G11 — G1's vertical jump is invisible to the horizontal g-force filter), and the SAS59Z `LookAt gx:TimeSpan` camera-time-trap lock. Confirmed via full-tree scan that NetworkLink/ExtendedData/SchemaData/real-gx:MultiTrack are absent (defensive-only).
- **Promoted the round-trip test** to a first-class, CI-unconditional Tier-A anchor (self-contained, no corpus, and is the G5 fixture).
- Kept the cheap nit: documented the exact gitignore path drift (root `snapshots-baseline/` vs fast-regression `baseline/`).