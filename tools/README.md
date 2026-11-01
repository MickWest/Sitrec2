# Sitrec Tools

This directory contains standalone tools for working with Sitrec data. To open a public tool,
use **Sitrec → Extra Tools** or the [Tools page](https://www.metabunk.org/sitrec/tools/).

| Tool | What it does | More information |
|---|---|---|
| LOS CSV Viewer | Shows line of sight (LOS) CSV data exported from Sitrec in 3D | [On this page](#los-csv-viewer) |
| FlowGen | Makes synthetic videos with a known motion, to test optical flow and motion tracking | Its card on the Tools page |
| PX4 ULog Viewer | Shows PX4 flight logs (ULog files) in 3D, and exports them to CSV | [PX4_README.md](PX4_README.md) |
| IR Balloon | Simulates how a mylar balloon looks to a mid-wave infrared (MWIR) thermal camera | Its card on the Tools page |
| Compass & Elevation | Measures compass heading and elevation angle with the orientation sensors of a phone | Its card on the Tools page |
| Starlink Flare Predictor | Predicts the times and sky directions of Starlink horizon flares, for a place or along a flight | [shf/README.md](shf/README.md) |
| Diffraction PSF Studio | Makes the diffraction point spread function (PSF) of a camera aperture, and exports it for Sitrec's camera glare | [psf/README.md](psf/README.md) |
| Vehicle Designer | Builds cars, trucks, aircraft, drones, balloons and sky lanterns, and exports GLB models | [vehicles/README.md](vehicles/README.md) |
| XML Wind Profile Analyzer | Finds the position and the vertical wind profile in an XML weather file, and gives the settings that make Sitrec read it | [xml-wind/README.md](xml-wind/README.md) |

This page also covers the tile download scripts. The last section tells how to add a public tool.

## Tile Download Scripts

### ESRI World Imagery Downloader

**File:** `download_texture_tiles.js`

Downloads ESRI World Imagery satellite tiles for offline/local caching.

```bash
node tools/download_texture_tiles.js
```

### Elevation Tile Downloader

**File:** `download_elevation_tiles.js`

Downloads AWS Terrarium elevation tiles for offline terrain data.

```bash
node tools/download_elevation_tiles.js
```

Both scripts:
- Support resume capability (re-run to download only missing tiles)
- Include progress tracking and error handling
- Save tiles in a `sitrec-terrain/` directory beside the repository, so Git does not track them: `sitrec-terrain/imagery/esri/<z>/<y>/<x>.jpg` and `sitrec-terrain/elevation/<z>/<x>/<y>.png`
- Stop at the `MAX_ZOOM` constant near the top of the script: zoom 4 for imagery (341 tiles) and zoom 6 for elevation (5,461 tiles). There is no command-line option

Sitrec's Local map source reads imagery up to zoom 8. To match it, set `MAX_ZOOM = 8` in `download_texture_tiles.js`: 87,381 tiles, about 530 MB.

To use the tiles, select **Local** in **Terrain → Map Type** and **Terrain → Elevation Type**. The server must serve `sitrec-terrain/` beside the application directory.

## LOS CSV Viewer

**File:** `los-viewer.html`

A standalone web application for visualizing Line of Sight (LOS) CSV data exported from Sitrec.

### Features

- **Ground Grids**: After a file loads, two white grids with 10km squares (50km x 50km total area). One lies on a solid green plane at the base altitude, and the other is at z=0. The background beyond the plane is grey
- **North Indicator**: Large red arrow at origin pointing north with "N" label
- **Track Visualization**: Red line showing the sensor path with spheres at each point
- **Ground Lines**: 1px blue lines from each track point down to the z=0 plane
- **LOS Vectors**: Every 30th LOS vector displayed as green arrows extending to maxRange
- **Interactive Controls**: 
  - Left-click and drag to orbit around the track
  - Right-click and drag to pan
  - Scroll wheel to zoom in/out
  - Reset camera button to recenter view
  - **Base Altitude Plane** and **MSL Plane (z=0)** checkboxes show or hide each plane. At the origin, the z=0 plane is 0 m [above the WGS84 ellipsoid (HAE)](https://github.com/MickWest/Sitrec2/blob/main/docs/GIS.md#three-kinds-of-height), not at mean sea level, although its label says MSL. The base plane is opaque, so clear it to see anything below it

### Usage

1. In Sitrec, open **File → Export → Lines of Sight** and click **Lines of Sight CSV**. The file covers the In/Out range. Another line of sight has its own folder under **Export**
2. Open **Sitrec → Extra Tools → LOS CSV Viewer**, or open `los-viewer.html` from a web server. Opening the file directly from disk does not work: Chrome blocks its module imports, and no 3D view appears
3. Click "Choose File" and select your exported CSV file, or drop the file on the page
4. The visualization will automatically load and center on your track data

**Quick Test:** A sample CSV file (`sample-los.csv`) is included for testing the viewer.

### CSV Format

The viewer expects CSV files with the following format:
```
Time, SensorPositionX, SensorPositionY, SensorPositionZ, LOSUnitVectorX, LOSUnitVectorY, LOSUnitVectorZ, maxRange, LOSUncertaintyVertical, LOSUncertaintyHorizontal, OriginLat, OriginLon, BaseAltitude
```

The first line is a header, and the viewer skips it. The last three columns are optional: without them, the viewer uses 0.

Where:
- **Time**: Timestamp in milliseconds since epoch
- **SensorPosition**: X, Y, Z coordinates in ENU (East, North, Up) coordinate system (meters). The origin is 0 m [above the WGS84 ellipsoid (HAE)](https://github.com/MickWest/Sitrec2/blob/main/docs/GIS.md#three-kinds-of-height), directly below the sensor at frame 0
- **LOSUnitVector**: X, Y, Z components of the unit vector pointing along the line of sight
- **maxRange**: Distance along the LOS to the z=0 plane of the ENU frame (meters). This plane is not the terrain or the base altitude. Special value `-1` means that the LOS does not reach the plane, or that the sensor is not above it. The viewer displays this as 100km
- **LOSUncertainty**: Half of the vertical and half of the horizontal field of view (degrees). The viewer does not use these columns
- **OriginLat, OriginLon**: The ENU origin (degrees)
- **BaseAltitude**: Ground elevation at the origin (meters, HAE). The viewer draws the Base Altitude plane at this height

### Coordinate System

The viewer uses Three.js coordinate system:
- X-axis: East (red)
- Y-axis: Up (green)
- Z-axis: South (blue, opposite of North)

The CSV data is in ENU format and is automatically converted for proper visualization.

### Browser Compatibility

This tool uses modern web standards including:
- ES6 modules
- Import maps
- Three.js r180 (local copy)

Use a current browser with ES modules, import maps, WebGL, and the File API.

### Development

The viewer is a standalone HTML file that webpack does not bundle. It uses a local copy of Three.js r180 located in the `three.js/` directory.

To modify the visualization:
1. Edit `los-viewer.html`
2. Run `npm run copy`. The site serves a copy of the file from the build output, and this command updates that copy
3. Refresh your browser to see changes

### Three.js Library

The `three.js/` directory contains the Three.js core modules and the OrbitControls addon, downloaded from the CDN. This removes any runtime CDN dependency.

## PX4 ULog Viewer

**Files:** `px4-viewer.html`, `px4lib.js`

PX4 is open-source autopilot software for drones. It records each flight in a ULog file (`.ulg`). This viewer shows the flight path from a ULog file in 3D, and exports the data as CSV.

See [PX4 ULog Viewer](PX4_README.md) for how to open and use it.

## Adding or Removing a Public Tool

A public tool is one with a card on the Tools index page, `tools/index.html`. Each public
tool also has a link in the **Sitrec → Extra Tools** menu, which opens it in a new tab.
When you add, rename or remove a public tool, change all three of these together:

1. **`tools/index.html`**: the tool's card. Its main link is a plain `<a href="...">` with
   no other attributes. Give any secondary link on the card a `class`.
2. **`src/extraTools.js`**: one entry with a `key` and a `path` relative to `tools/`. Name
   the page itself (`mytool/index.html`), not a bare directory. Set `perBuild: true` only
   if the release packaging copies the tool into every frontend build (see
   `docs/dev/ReleaseChannels.md`).
3. **`src/i18n/en.js`**: a `label` and a `tooltip` under
   `menus.main.extraTools.tools.<key>`.

A `perBuild` tool is served from its build's own directory (`/builds/<build-id>/tools/...`)
by a server that serves files only and has no directory index. Every link between the pages
of such a tool must name the page: `rate/index.html` and `../index.html`, never `rate/` or
`../`. A bare directory link works on the main site and is a 404 in a build directory.

`tests/extraTools.test.js` fails if these disagree, or if a `perBuild` tool has a link to
a bare directory. Development and test pages (for
example `px4-test.html`) get no card and no menu entry.
