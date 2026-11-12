# URL Parameters

You can control how Sitrec starts by adding query parameters to its address. A parameter
can open a specific [sitch](Glossary.md), load a file, place the camera at a location, set
the start time, or open a tool.

Parameters go after a `?`, and are separated by `&`:

```
https://www.metabunk.org/sitrec/?action=new&latlon=36.1,-115.2&datetime=2024-06-01T04:30:00Z
```

Parameter names are case-sensitive: `mapType` works, `maptype` does not. Values that contain
`&`, `#`, `+` or `%` must be percent-encoded (for example, `&` is `%26` and `+` is `%2B`).
A plain `+` is read as a space.

---

## Loading a sitch

| Parameter | Values | Effect | Example |
|---|---|---|---|
| `sitch` | The name of a built-in sitch. Not case-sensitive | Opens that sitch | `?sitch=custom` |
| `custom` | A saved-sitch reference or a URL (see below) | Loads a saved sitch | `?custom=99999999/My%20Sitch/20250701_215755.js` |
| `mod` | Same as `custom` | Loads a saved modification of a built-in sitch. Works the same as `custom` | `?mod=…` |
| `template` | The name of a [template](SavingAndLoading.md#templates) | Opens a new sitch from that template | `?template=Star%20Tracker` |
| `drop` | The URL of a file | Loads that file after the sitch is set up, as if you pasted the URL onto Sitrec | `?action=new&drop=https://example.com/clip.mp4` |
| `sit` | Same as `sitch` | Old name for `sitch`. If both are given, `sitch` wins | `?sit=gimbal` |

### sitch

`sitch=custom` opens a new custom sitch, ready for you to drag files onto. Other values open
the built-in sitches by name; these names are the ones Sitrec writes into the address bar
when you select a sitch from the menus.

If this build of Sitrec has no sitch with that name (for example, a typo or an old link to
a sitch that was renamed), Sitrec shows an error and opens the custom sitch instead.

### custom and mod

`custom` accepts these forms:

- **A saved-sitch key**, `<user number>/<path>`, which is what a server save writes into the
  address bar. Sitrec finds the file on its own storage, so the link does not depend on the
  storage host.
- **A `sitrec://` reference** to the same kind of key.
- **An older storage URL** that contains such a key.
- **Any other URL** of a sitch file. Sitrec fetches it directly, so the server that holds it
  must allow cross-origin requests: that is, it must let a page on one site read a file from
  another site. A link that opens in a browser tab can still fail this test. If it fails,
  save the file and drag it onto Sitrec.

If both `custom` and `mod` are present, `mod` is used. If the sitch cannot be loaded, Sitrec
shows an error, with the likely cause when it can tell. It then opens the sitch named by
`sitch` or `sit`, or a new custom sitch if neither is given.

A sitch loaded from `custom` or `mod` restores its saved camera, terrain and time. The
preferences in **Sitrec → Settings → New Sitch Startup** are not applied.

### template

`template` opens a new sitch from the [template](SavingAndLoading.md#templates) with that
name. The address has the name only, so it always opens the latest version of the template.
The new sitch has no name, and your work in it does not change the template.

Sitrec writes this address into the address bar when you open a template. A link to it opens
the same template for another user, if it is a global template.

- The name must be exact, with the same capital letters. Write a space as `%20`.
- Sitrec looks for a global template with that name first. If there is none and you are
  logged in, it looks in your own local templates.
- If there is no template with that name, Sitrec shows an error and then the start screen.
- `template` works only on an installation that saves sitches to a server. With a `sitch`,
  `custom` or `mod` parameter, or with `action=new`, that parameter is used and `template`
  is not.

### drop

`drop` loads one file from a URL after the sitch is set up. It is the same as pasting the URL
onto Sitrec, so it accepts the file types that a pasted URL accepts: videos, tracks, and
so on. As for `custom`, the server that holds the file must allow cross-origin requests. If
it does not, Sitrec shows "Cannot Read That URL". Save the file and drag it onto Sitrec instead.

Use `drop` with `action=new` (or `sitch=custom`) to open a video or track in a new custom sitch:

```
https://www.metabunk.org/sitrec/?action=new&drop=https://example.com/clip.mp4
```

---

## Position and terrain

These parameters change the sitch before it is set up. They have an effect only in a sitch
that has terrain and cameras, which in practice means the custom sitch. On www.metabunk.org,
an address with no `custom` or `mod` needs `action=new` or `sitch=custom`, or these parameters
do nothing (see [Startup actions](#startup-actions)).

With a saved sitch (`custom` or `mod`), `mapType` and `elevationType` replace the saved
sources. Use `latlon` only with a new sitch: with a saved sitch it moves the terrain, but the
saved cameras stay where they were.

| Parameter | Values | Effect | Example |
|---|---|---|---|
| `latlon` | A coordinate, with an optional height [above ground level (AGL)](GIS.md#three-kinds-of-height) in **feet** | Centers the terrain and cameras on that location | `?action=new&latlon=37.2431,-115.7930` |
| `mapType` | The internal name of a map source | Selects the map imagery | `?action=new&mapType=FlatShading` |
| `elevationType` | The internal name of an elevation source | Selects the terrain elevation data | `?action=new&elevationType=Flat` |

### latlon

`latlon` takes `latitude,longitude` or `latitude,longitude,height`. Decimal degrees are the
simplest form: copy the numbers from Google Maps as they are. It uses the same coordinate
parser as the Go To (`G`) prompt, so the other forms in
[Coordinate formats](GIS.md#coordinate-formats) also work.

What it changes:

- **Terrain**: the terrain is centered on the location, at zoom level 15.
- **Main view**: the main camera starts high above the location, to the south of it, and
  looks at it.
- **Look camera**: the camera that draws the [look view](Glossary.md) is placed at the
  location. The third value is its height **above ground level in feet**. With no third value,
  the height is 1.5 m (about 5 ft), a typical hand-held camera. An [ECEF](Glossary.md)
  `x,y,z` triple is in meters, and its altitude is used in meters.

`latlon` is applied after the New Sitch Startup preferences, so the URL wins over a saved
start location. After `latlon` is applied, a track that you load does not move the view to
itself or change the sitch time, and a video's embedded location and date are not used.

If Sitrec cannot read the value, it shows "Invalid lat/lon format" and continues.

### mapType and elevationType

The value is the internal name of a source, not the name shown in the menu. It is
case-sensitive. If the name is not known on this installation, Sitrec uses the default
source.

Map sources built into Sitrec:

| `mapType` | Menu name |
|---|---|
| `NoClouds` | Blue Marble (No Clouds) |
| `wireframe` | Wireframe |
| `FlatShading` | Flat Shading |
| `OceanSurface` | Ocean Surface |
| `ElevationColor` | Elevation Pseudo-Color |

An installation can turn off the default map sources. `NoClouds`, `wireframe` and
`ElevationColor` are then not available.

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
| `datetime` | A date and time. Use ISO 8601 with a `Z` for UTC | Sets the start time of a new sitch | `?action=new&datetime=2023-01-15T03:22:00Z` |
| `frame` | A whole number, from 0 | Shows that frame, paused, and keeps it there | `?sitch=custom&frame=120` |

### datetime

The value is read by the browser's standard date parser. Use the full ISO 8601 form
`YYYY-MM-DDThh:mm:ssZ`; without the `Z` the browser may read the time as local time.
If the browser cannot read the value as a date, Sitrec shows an error and ignores the
parameter: the sitch keeps its own start time.

After `datetime` is applied, a track or video that you load does not change the sitch time.

### frame

`frame` pins the display to one frame. Sitrec pauses on that frame and returns to it on every
update, so you cannot play or step away from it until you reload the page without the
parameter. It is intended for screenshots and repeatable comparisons, not for normal viewing.

---

## Startup actions

| Parameter | Values | Effect | Example |
|---|---|---|---|
| `action` | `new` | Starts a new custom sitch | `?action=new` |
| | `browse` | Opens the sitch browser as the start screen | `?action=browse` |
| | `trackbrowser` | Starts a new custom sitch and opens the Track Browser | `?action=trackbrowser` |
| | `botbench` | Starts a new custom sitch and opens the BOTBench window | `?action=botbench` |

The value is not case-sensitive. Unknown values are ignored.

**Why `action=new` matters.** On an installation that saves sitches to a server, such as
www.metabunk.org, an address with no `sitch`, `custom`, `mod`, `template` or `action` parameter opens
the start screen (the [templates](SavingAndLoading.md#templates), or the sitch browser when
there are none) over a blank page that has no terrain or cameras, so `latlon`, `mapType`
and `elevationType` do nothing there. Add `action=new` (or
`sitch=custom`) when you use those parameters.

**File → New Sitch (Empty)**, and the **New Sitch** button on the start screen and in the
sitch browser, reload Sitrec with `?action=new`.

**`action=browse`.** The address with no parameter opens the start screen with the
templates. `action=browse` opens the same start screen with the sitch browser, over the
same blank page. Use it alone: with a `sitch`, `custom` or `mod` parameter, that sitch opens
and the sitch browser does not. It does nothing on an installation that does not save
sitches to a server.

**Browse Sitches** on the start screen and **File → Server → Open** show the sitch browser
and set the address to `?action=browse`. Sitrec does not reload, so a sitch that you have
open stays open behind the sitch browser. When you close the sitch browser, or go back to
the templates, the address goes back to what it was. If you reload while the address is
`?action=browse`, Sitrec opens the sitch browser and the sitch that was open is not
loaded.

---

## Other parameters

| Parameter | Values | Effect |
|---|---|---|
| `ignoreunload` | Any value, or none (`?ignoreunload`) | Turns off the "Leave site?" warning when you close or reload the page |
| `channel` | `beta` or `shipped` | On installations that offer a Beta build, opens that build for this visit. If there is no Beta build, or the Beta is older than the Shipped build and so is retired, `beta` opens the normal build and says so |
| `handoff` | A key | Loads files that another Sitrec window passed to this one. Sitrec makes these links itself, for example when the Track Browser opens a file in a new tab. The files are kept for one hour |
| `video` | A preset video name or an http(s) URL | With `sitch=video`, opens that video in the Video Viewer. Sitrec writes this parameter when you choose a **Preset Video** there |
| `fromapp` | `1`, with other values | Builds a sitch from a prediction sent by the standalone Starlink Horizon Flares app. That app makes these links |

---

## Developer and diagnostic parameters

These are for testing and debugging Sitrec. They are not needed for normal use, and some work
only on a local development server.

| Parameter | Purpose |
|---|---|
| `regression=1` | Regression-test mode. Disables the sitch browser and some startup behavior |
| `regressionLocalTerrain=1` | With `regression=1`, forces the `Local` map and elevation sources |
| `test` | A comma-separated list of sitch names to load one after another |
| `testAll=1`, `testAll=2` | Loads every sitch in turn. `2` also uses a fast debug terrain |
| `tileBoundsMode`, `tileBoundsModeMain`, `tileBoundsModeLook` | Terrain tile culling mode: `legacy`, `metrics`, `sphere` or `obb` |
| `enableReachCull` | `0` or `1`: turns a terrain tile culling test off or on |
| `localComputePort`, `lcPort` | The port of a local compute helper |
| `iwer=1` | Local development only: WebXR emulation |

---

## Which parameters Sitrec writes into the address bar

Sitrec updates the address bar for the actions in the table below. Changes such as a camera
move or a loaded track are not in the address.

To share your work, log in and save the sitch to the server, then copy the address. A link is
not private: anyone who can reach this Sitrec site and has the link can open the sitch and the
files saved with it, and they do not need an account. See
[Share a saved sitch](SavingAndLoading.md#share-a-saved-sitch).

| When you… | The address becomes |
|---|---|
| Select a built-in sitch from the menus | `?sitch=<name>` |
| Save a sitch to the server | `?custom=<key>` (`?mod=<key>` for a modified built-in sitch) |
| Open a saved sitch from the server | `?custom=<key>` |
| Open a sitch from a local file | `?sitch=custom`, because a local file cannot be shared by URL |
| Drop or paste the URL of a video | `drop=<url>` is added |

Sitrec does not write `latlon`, `datetime`, `frame`, `mapType` or `elevationType` into the
address. A saved sitch already holds its location, time and terrain, so a `?custom=` link is
the complete way to share one.

---

## Examples

Open a new custom sitch at a location, 6 ft above ground level, at a given time:

```
https://www.metabunk.org/sitrec/?action=new&latlon=36.0544,-112.1401,6&datetime=2024-08-12T09:15:00Z
```

Open a new custom sitch with flat terrain and plain gray imagery:

```
https://www.metabunk.org/sitrec/?action=new&mapType=FlatShading&elevationType=Flat
```

Open a video from a URL in a new custom sitch:

```
https://www.metabunk.org/sitrec/?action=new&drop=https://example.com/clip.mp4
```

Open the Track Browser directly:

```
https://www.metabunk.org/sitrec/?action=trackbrowser
```
