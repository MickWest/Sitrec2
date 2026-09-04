# PX4 ULog Viewer

A simple JavaScript implementation for parsing and visualizing PX4 ULog files, inspired by [PX4 Flight Review](https://github.com/PX4/flight_review).

## Files

- **px4lib.js** - ULog parser library
- **px4-viewer.html** - Web-based 3D visualization tool

## Features

### Parser Library (px4lib.js)

The `ULogParser` class provides:

- **Binary ULog parsing** - Reads ULogV1 format files
- **Message extraction** - Extracts all message types (Format, Info, Parameter, Data, etc.)
- **Track data extraction** - Automatically extracts position data from:
  - `vehicle_global_position` (GPS lat/lon/alt)
  - `vehicle_local_position` (local NED coordinates)
  - `vehicle_gps_position` (raw GPS data)
- **CSV export** - Two export modes:
  - Track-only CSV (lat/lon/alt/velocity)
  - All data CSV (complete message dump)

### Viewer (px4-viewer.html)

Interactive 3D visualization with:

- **3D track rendering** - Flight path displayed in 3D space
- **Coordinate conversion** - GPS coordinates converted to local ENU frame
- **Start/end markers** - Green sphere (start), red sphere (end)
- **Velocity vectors** - Optional display of velocity arrows (blue)
- **Ground plane** - Reference grid with transparent surface
- **Camera controls** - Orbit, pan, zoom with auto-fit
- **Export buttons** - Download track or complete data as CSV

## Usage

### Opening the Viewer

1. Open `px4-viewer.html` in a modern web browser
2. Click "Load ULog File" and select a `.ulg` file
3. The track will be automatically parsed and displayed

### Controls

- **Left-click + drag** - Orbit camera around track
- **Right-click + drag** - Pan camera
- **Scroll wheel** - Zoom in/out
- **Reset Camera** - Auto-fit view to track bounds

### Display Options

- **Ground Plane** - Toggle reference grid and ground surface
- **Velocity Vectors** - Show velocity direction/magnitude as arrows

### Export Options

- **Export Track CSV** - Position and velocity data only
- **Export All Data CSV** - Complete message dump from ULog

## Implementation Details

### ULog Format Support

The parser implements ULogV1 format specification:

- Magic bytes: `ULogV1\0`
- Message types:
  - `F` (0x46) - Format definitions
  - `I` (0x49) - Info messages
  - `M` (0x4D) - Multi info
  - `P` (0x50) - Parameters
  - `A` (0x41) - Add logged message
  - `D` (0x44) - Data messages
  
### Supported Data Types

- `int8_t`, `uint8_t`
- `int16_t`, `uint16_t`
- `int32_t`, `uint32_t`
- `int64_t`, `uint64_t`
- `float`, `double`
- `bool`, `char`
- Arrays (e.g., `float[3]`)

### Coordinate System

- **Input**: GPS coordinates (lat/lon in degrees, alt in meters) or local NED
- **Output**: Local ENU coordinates (East-North-Up)
- **Reference**: First valid GPS position used as origin
- **Visualization**: Y-up coordinate system (Three.js convention)

## Limitations

This is a simplified implementation compared to the full Python Flight Review:

- No bokeh plots - only 3D visualization
- Limited message type support - focuses on position/velocity
- No analysis features - only visualization and export
- No parameter tuning - read-only viewer

## Testing

To test with real data:

1. Download sample ULog files from [PX4 Flight Review](https://review.px4.io)
2. Or use your own flight logs from PX4 autopilot
3. Load in px4-viewer.html

The repository also includes command-line diagnostics. Both require an explicit log path:

```bash
node tools/px4-debug.js path/to/flight-log.ulg
node tools/test-px4-parser.js path/to/flight-log.ulg
```

## Browser Compatibility

Requires modern browser with:
- ES6 modules support
- WebGL (Three.js)
- File API
- ArrayBuffer/DataView

Use a current browser that provides those APIs.

## License

Created as part of the Sitrec project.
