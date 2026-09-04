# Sitrec Tools

This directory contains standalone tools for working with Sitrec data.

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
- Save tiles to `sitrec-terrain/imagery/` and `sitrec-terrain/elevation/` respectively
- Use `__dirname` to automatically find the correct output paths
- Output directory is in `.gitignore` to avoid committing large tile caches

## LOS CSV Viewer

**File:** `los-viewer.html`

A standalone web application for visualizing Line of Sight (LOS) CSV data exported from Sitrec.

### Features

- **Ground Grid**: 1km grid (50km x 50km total area) with white lines on grey background
- **North Indicator**: Large red arrow at origin pointing north with "N" label
- **Track Visualization**: 3px thick red line showing the sensor path with spheres at each point
- **Ground Lines**: 1px blue lines connecting each track point to the ground
- **LOS Vectors**: Every 30th LOS vector displayed as green arrows extending to maxRange
- **Interactive Controls**: 
  - Left-click and drag to orbit around the track
  - Right-click and drag to pan
  - Scroll wheel to zoom in/out
  - Reset camera button to recenter view

### Usage

1. Export LOS data from Sitrec using the "CSV" button on a LOS node
2. Open `los-viewer.html` in a web browser
3. Click "Choose File" and select your exported CSV file
4. The visualization will automatically load and center on your track data

**Quick Test:** A sample CSV file (`sample-los.csv`) is included for testing the viewer.

### CSV Format

The viewer expects CSV files with the following format:
```
Time, SensorPositionX, SensorPositionY, SensorPositionZ, LOSUnitVectorX, LOSUnitVectorY, LOSUnitVectorZ, maxRange, LOSUncertaintyVertical, LOSUncertaintyHorizontal
```

Where:
- **Time**: Timestamp in milliseconds since epoch
- **SensorPosition**: X, Y, Z coordinates in ENU (East, North, Up) coordinate system (meters)
- **LOSUnitVector**: X, Y, Z components of the unit vector pointing along the line of sight
- **maxRange**: Maximum range for LOS visualization (meters). Special value `-1` indicates infinity (LOS doesn't intersect ground), which is displayed as 100km in the viewer
- **LOSUncertainty**: Vertical and horizontal uncertainty values

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

The viewer is a standalone HTML file with no build process required. It uses a local copy of Three.js r180 located in the `three.js/` directory.

To modify the visualization:
1. Edit `los-viewer.html`
2. Refresh your browser to see changes
3. No webpack rebuild needed (the file is copied as-is)

### Three.js Library

The `three.js/` directory contains just the essential Three.js files (core module + OrbitControls addon) downloaded from the CDN. This provides the simplicity of a single-file install while eliminating runtime CDN dependencies.

## PX4 ULog Viewer

**Files:** `px4-viewer.html`, `px4lib.js`

A simple JavaScript implementation for parsing and visualizing PX4 ULog files, inspired by [PX4 Flight Review](https://github.com/PX4/flight_review).

### Features

- **ULog Parser** (`px4lib.js`): Binary parser for ULogV1 format files
  - Extracts position data from `vehicle_global_position`, `vehicle_local_position`, and `vehicle_gps_position`
  - Supports all standard ULog message types (Format, Info, Parameter, Data, etc.)
  - Two CSV export modes: track-only or complete message dump
  
- **3D Viewer** (`px4-viewer.html`): Interactive web-based visualization
  - Flight path rendered in 3D space
  - GPS coordinates automatically converted to local ENU frame
  - Start (green) and end (red) markers
  - Optional velocity vector display
  - Ground reference plane with grid
  - Auto-fit camera with orbit/pan/zoom controls
  - Export track or all data as CSV

### Usage

1. Open `px4-viewer.html` in a web browser
2. Click "Load ULog File" and select a `.ulg` file
3. The track will be parsed and displayed automatically
4. Use export buttons to save data as CSV

**Note:** Sample ULog files can be downloaded from [PX4 Flight Review](https://review.px4.io) for testing.

### Controls

- **Left-click + drag**: Orbit camera
- **Right-click + drag**: Pan camera
- **Scroll wheel**: Zoom
- **Reset Camera**: Auto-fit view to track

See [PX4_README.md](PX4_README.md) for detailed documentation.
