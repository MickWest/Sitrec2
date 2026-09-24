# URL Parameters

You can control how Sitrec starts by adding query parameters to its address. A parameter
can open a specific sitch, load a file, place the camera at a location, set the start time,
or open a tool.

Parameters go after a `?`, and are separated by `&`:

```
https://www.metabunk.org/sitrec/?action=new&latlon=36.1,-115.2&datetime=2024-06-01T04:30:00Z
```

Parameter names are case-sensitive: `mapType` works, `maptype` does not. Values that contain
`&`, `=`, `#` or `?` must be percent-encoded (for example, `&` is `%26`).

---

## Loading a sitch

| Parameter | Values | Effect | Example |
|---|---|---|---|
| `sitch` | The name of a built-in sitch. Not case-sensitive | Opens that sitch | `?sitch=custom` |
| `custom` | A saved-sitch reference or a URL (see below) | Loads a saved sitch | `?custom=99999999/My%20Sitch/20250701_215755.js` |
| `mod` | Same as `custom` | Loads a saved modification of a built-in sitch. Works the same as `custom` | `?mod=…` |
| `drop` | The URL of a file | Loads that file after the sitch is set up, as if you pasted the URL onto Sitrec | `?action=new&drop=https://example.com/clip.mp4` |
| `sit` | Same as `sitch` | Old name for `sitch`. If both are given, `sitch` wins | `?sit=gimbal` |

### sitch

`sitch=custom` opens the standard empty scene that you drag files onto. Other values open
the built-in sitches by name; these names are the ones Sitrec writes into the address bar
when you select a sitch from the menus.

### custom and mod

`custom` accepts these forms:

- **A saved-sitch key**, `<user number>/<path>`, which is what a server save writes into the
  address bar. Sitrec finds the file on its own storage, so the link does not depend on the
  storage host.
- **A `sitrec://` reference** to the same kind of key.
- **An older storage URL** that contains such a key.
- **Any other URL** of a sitch file. Sitrec fetches it directly, so the server that holds it
  must allow cross-origin requests.

If both `custom` and `mod` are present, `mod` is used. If the sitch cannot be loaded, Sitrec
shows an error that includes the likely cause, and then starts as if the parameter was not
there.

A sitch loaded from `custom` or `mod` is "established": its saved camera, terrain and time
are restored, and the New Sitch Startup preferences in the Settings menu are not applied.

### drop

`drop` loads one file from a URL after the sitch is set up. It is the same as pasting the URL
onto Sitrec, so it accepts the file types that a pasted URL accepts: videos, tracks, and
so on. The file must be reachable from your browser.

Use `drop` with `action=new` (or `sitch=custom`) to open a video or track in a new scene:

```
https://www.metabunk.org/sitrec/?action=new&drop=https://example.com/clip.mp4
```

---

## Position and terrain

These parameters change the sitch before it is set up. They have an effect only in a sitch
that has terrain and cameras, which in practice means the custom sitch.

| Parameter | Values | Effect | Example |
|---|---|---|---|
| `latlon` | A coordinate, with an optional altitude in **feet** | Centers the terrain and cameras on that location | `?action=new&latlon=37.2431,-115.7930` |
| `mapType` | The internal name of a map source | Selects the map imagery | `?action=new&mapType=FlatShading` |
| `elevationType` | The internal name of an elevation source | Selects the terrain elevation data | `?action=new&elevationType=Flat` |

### latlon

`latlon` takes `latitude,longitude` or `latitude,longitude,altitude`. It uses the same
coordinate parser as the Go To (`G`) prompt, so degrees-minutes-seconds, hemisphere letters,
MGRS and an ECEF `x,y,z` triple also work (see [Coordinate formats](GIS.md#coordinate-formats)).
Decimal degrees are the simplest to put in a URL.

What it changes:

- **Terrain**: the terrain is centered on the location, at zoom level 15.
- **Main view**: the main camera starts high above the location, to the south of it, and
  looks at it.
- **Look camera**: the fixed camera is placed at the location. The third value is its height
  **above the ground in feet**. With no third value, the height is 1.5 m (about 5 ft), a
  typical hand-held camera. An ECEF triple is in meters, and its altitude is used in meters.

`latlon` is applied after the New Sitch Startup preferences, so the URL wins over a saved
start location. After `latlon` is applied, a track that you load does not move the view to
itself or change the sitch time, as it would in a new empty sitch.

If Sitrec cannot read the value, it shows "Invalid lat/lon format" and continues.

### mapType and elevationType

The value is the internal name of a source, not the name shown in the menu. It is
case-sensitive. If the name is not known on this installation, Sitrec uses the default
source.

Map sources that are always present:

| `mapType` | Menu name |
|---|---|
| `NoClouds` | Blue Marble (No Clouds) |
| `wireframe` | Wireframe |
| `FlatShading` | Flat Shading |
| `OceanSurface` | Ocean Surface |
| `ElevationColor` | Elevation Pseudo-Color |

Elevation sources that are always present:

| `elevationType` | Menu name |
|---|---|
| `Flat` | Flat |
| `Local` | Local |

Other sources come from the installation's configuration. In the standard configuration
these include map sources such as `osm`, `mapbox`, `ESRI` and `USGS_Imagery`, and the
elevation source `AWS_Terrarium`.

---

## Time

| Parameter | Values | Effect | Example |
|---|---|---|---|
| `datetime` | A date and time. Use ISO 8601 with a `Z` for UTC | Sets the start time of the sitch | `?action=new&datetime=2023-01-15T03:22:00Z` |
| `frame` | A whole number, from 0 | Shows that frame, paused, and keeps it there | `?sitch=custom&frame=120` |

### datetime

The value is read by the browser's standard date parser. Use the full ISO 8601 form
`YYYY-MM-DDThh:mm:ssZ`; without the `Z` the browser may read the time as local time.

`datetime` **overrides the start time of a saved sitch**. When you load a sitch with `custom`
and also give `datetime`, the saved start time is not restored; everything else is. After
`datetime` is applied, a track that you load does not change the sitch time.

### frame

`frame` pins the display to one frame. Sitrec pauses on that frame and returns to it on every
update, so you cannot play or step away from it until you reload the page without the
parameter. It is intended for screenshots and repeatable comparisons, not for normal viewing.

---

## Startup actions

| Parameter | Values | Effect | Example |
|---|---|---|---|
| `action` | `new` | Starts a new custom sitch | `?action=new` |
| | `trackbrowser` | Starts a new custom sitch and opens the Track Browser | `?action=trackbrowser` |
| | `botbench` | Starts a new custom sitch and opens the BOT Bench dialog | `?action=botbench` |

The value is not case-sensitive. Unknown values are ignored.

**Why `action=new` matters.** On an installation that saves sitches to a server, such as
www.metabunk.org, an address with no `sitch`, `custom`, `mod` or `action` parameter opens
the sitch browser over an empty scene. The empty scene has no terrain or cameras, so
`latlon`, `mapType` and `elevationType` do nothing there. Add `action=new` (or
`sitch=custom`) when you use those parameters.

The **New Sitch** command, and the **New Sitch** button in the sitch browser, reload Sitrec
with `?action=new`.

---

## Other parameters

| Parameter | Values | Effect |
|---|---|---|
| `ignoreunload` | Any value, or none (`?ignoreunload`) | Turns off the "Leave site?" warning when you close or reload the page |
| `channel` | `beta` or `shipped` | On installations that offer a Beta build, opens that build for this visit. If there is no Beta build, `beta` opens the normal build and says so |
| `handoff` | A key | Loads files that another Sitrec window passed to this one. Sitrec makes these links itself, for example when the Track Browser opens a file in a new tab. The files are kept for one hour |
| `fromapp` | `1`, with other values | Builds a sitch from a prediction sent by the standalone Starlink Horizon Flares app. That app makes these links |

---

## Developer and diagnostic parameters

These are for testing and debugging Sitrec. They are not needed for normal use, and some work
only on a local development server.

| Parameter | Purpose |
|---|---|
| `regression=1` | Regression-test mode. Disables the sitch browser and some startup behavior |
| `regressionLocalTerrain=1` | With `regression=1`, forces the `Local` map source |
| `test` | A comma-separated list of sitch names to load one after another |
| `testAll=1`, `testAll=2` | Loads every sitch in turn. `2` also uses a fast debug terrain |
| `tileBoundsMode`, `tileBoundsModeMain`, `tileBoundsModeLook` | Terrain tile culling mode: `legacy`, `metrics`, `sphere` or `obb` |
| `enableReachCull` | `0` or `1`: turns a terrain tile culling test off or on |
| `localComputePort`, `lcPort` | The port of a local compute helper |
| `iwer=1` | Local development only: WebXR emulation |

---

## Which parameters Sitrec writes into the address bar

Sitrec updates the address bar as you work, so you can copy the address to share what you
are looking at:

| When you… | The address becomes |
|---|---|
| Select a built-in sitch from the menus | `?sitch=<name>` |
| Save a sitch to the server | `?custom=<key>` (`?mod=<key>` for a modified built-in sitch) |
| Open a saved sitch from the server | `?custom=<key>` |
| Open a sitch from a local file | `?sitch=custom`, because a local file cannot be shared by URL |
| Drop or paste the URL of a video | `drop=<url>` is added |

Sitrec does not write `latlon`, `datetime`, `frame`, `mapType` or `elevationType` into the
address. A saved sitch already holds its location, time and terrain, so a `?custom=` link is
the complete way to share one. See [Saving and Loading Sitches](SavingAndLoading.md).

---

## Examples

Open a new scene at a location, 6 ft above the ground, at a given time:

```
https://www.metabunk.org/sitrec/?action=new&latlon=36.0544,-112.1401,6&datetime=2024-08-12T09:15:00Z
```

Open a new scene with flat terrain and plain gray imagery:

```
https://www.metabunk.org/sitrec/?action=new&mapType=FlatShading&elevationType=Flat
```

Open a video from a URL in a new scene:

```
https://www.metabunk.org/sitrec/?action=new&drop=https://example.com/clip.mp4
```

Open the Track Browser directly:

```
https://www.metabunk.org/sitrec/?action=trackbrowser
```
