# Recorded fireballs

Open **File → Recorded fireballs…** in a custom sitch. Download a GMN daily or monthly trajectory summary using the links in the dialog. Supply its exact source URL and import the `.txt` file. Search starts at the sitch's current UTC and origin latitude/longitude. Adjust the time window, radius and faintest absolute magnitude, then select **Load observed path**. The default magnitude cutoff is −3; there is no arbitrary −9 bright cutoff. Unknown brightness is retained and labeled.

Use **Contents → Fireball [ID] → Jump to observed start / Jump to estimated peak**. An in-range jump moves to the nearest frame and keeps the timeline start. An out-of-range jump moves frame zero and the timeline start to that UTC. This is explicit in the control tooltip. The ordinary import can synchronize timeline start/duration if the sitch has not already been established, following existing track-import behavior. Start/peak controls and source information are restored when the original JSON asset is reloaded with a sitch.

The path uses the normal MISB track pipeline, displays in 3D/look views, and interpolates straight ECEF segments between supplied samples without smoothing. Outside the observed interval, its marker holds the first/last endpoint; that does not represent continued flight. The reference path and marker are geometric aids, not a simulated light curve, visibility prediction or apparent brightness prediction. A look view only shows an event if the camera points toward it; existing track framing controls can help.

## Source and conventions

[Global Meteor Network data](https://globalmeteornetwork.org/data/) are released under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Credit Global Meteor Network and cite its linked methodology papers in scientific work. [Official column definitions](https://globalmeteornetwork.org/data/media/GMN_orbit_data_columns.pdf) and [official parser](https://github.com/wmpg/WesternMeteorPyLib/blob/master/wmpl/Formats/WmplTrajectorySummary.py) describe semicolon summaries with repeated uncertainty columns.

Summaries supply a UTC beginning, observed duration, geodetic endpoints, endpoint sigma values, peak absolute magnitude normalized to 100 km, and peak height. Heights are kilometres above the **WGS84 ellipsoid**, converted to metres without an MSL geoid correction. Source rows, generation timestamp, original fractional UTC text, station IDs/count, convergence angle, median fit error and FOV flags are retained in the imported asset and exposed under **Fireball source & limits**. The exact source URL is user-supplied provenance for local files; Sitrec cannot authenticate a downloaded file or a claimed timestamp.

GMN summary peak times are **estimated**, using `(beginHeight − peakHeight) / (beginHeight − endHeight) × duration`. This assumes constant speed and a linear height progression; height along the rendered ECEF chord is not exactly linear. No peak UTC is recorded in a summary. Missing, equal-height or outside-range peak heights disable the estimated jump. Millisecond rendering and frame quantization do not establish measurement accuracy; fractional digits in source UTC are preserved but are not an uncertainty bound.

## Coverage limits

The primary monthly archive inspected on 2026-10-01 spans December 2018 through September 2026, with partial October data also present. This is not an all-meteor catalogue. Search covers **only the currently imported file**, whose actual UTC and sample geographic extent appear in the dialog. Daily filenames use solar-longitude bins and can contain observations from another UTC date. Use the rows' UTC fields. File imports are limited to 100 MB and results to 100 displayed matches; narrow filters or choose a smaller period. Nothing is fetched automatically and no giant archive is bundled.

Station geography, nighttime, weather, multi-station detection and quality selection constrain coverage. Bright-event saturation affects photometry. A sample bounding box is not a surveyed network coverage boundary; a radius is distance to the nearest supplied sample, not a visibility test or distance to the entire path. No match does not rule out a meteor. UfoAtHome's December 2018–September 2026 and magnitude −3…−9 limits describe its own filtered snapshot, not GMN completeness. No UfoAtHome code or data is copied here.

## Measured samples JSON

Import or drop `.fireball.json` with this explicit format. Replace the illustrative values with real source measurements and valid source/license attribution:

```json
{
  "kind": "sitrec-fireball-v1",
  "id": "source-event-id",
  "source": {"network": "Source network", "url": "https://example.org/original-report", "license": "Source license"},
  "altitudeReference": "WGS84 ellipsoid",
  "pathMethod": "measured time-tagged samples",
  "samples": [
    {"time": "2025-01-01T00:00:00.000Z", "lat": 35, "lon": -107, "altitude": 100000, "absoluteMagnitude": -4},
    {"time": "2025-01-01T00:00:01.000Z", "lat": 34.9, "lon": -107.1, "altitude": 70000, "absoluteMagnitude": -5}
  ]
}
```

Samples must have increasing UTC times ending in `Z`, latitude/longitude in degrees and ellipsoidal altitude in metres. Optional `recordedPeakUTC` must be within the samples' interval and must come from the cited source. Otherwise the lowest supplied `absoluteMagnitude` identifies the brightest measured sample, explicitly labeled sampling limited. No source brightness means no peak action and unknown brightness in search. The format declaration records the importer's claim; it is not independent source verification.

The bundled test extract consists of two real rows from GMN's 2018 yearly file, attributed to Global Meteor Network under CC BY 4.0. It is a test fixture, not an archive. Example IDs: `20181231103455_6R0hP` and `20181231114855_x32yo`.
