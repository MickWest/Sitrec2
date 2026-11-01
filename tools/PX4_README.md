# PX4 ULog Viewer

PX4 is open-source autopilot software for drones. It records each flight in a ULog file (`.ulg`). This viewer shows the flight path from a ULog file in 3D and exports the data as CSV. It reads only ULog files, so logs from other autopilots do not work. It is a simple JavaScript implementation, inspired by [PX4 Flight Review](https://github.com/PX4/flight_review).

## Files

- **px4lib.js** - ULog parser library
- **px4-viewer.html** - Web-based 3D visualization tool

## Features

### Parser Library (px4lib.js)

The `ULogParser` class provides:

- **Binary ULog parsing** - Reads ULog format files
- **Message extraction** - Reads the message types listed under [ULog Format Support](#ulog-format-support)
- **Track data extraction** - Collects position data from all of these topics into one list:
  - `vehicle_global_position` (GPS lat/lon/alt)
  - `vehicle_local_position` (local North-East-Down (NED) coordinates)
  - `vehicle_gps_position` (raw GPS data)
  - `sensor_gps` (raw GPS data)
- **CSV export** - Two export modes:
  - Track-only CSV (one row for each position message)
  - All data CSV (up to 10,000 data records)

### Viewer (px4-viewer.html)

Interactive 3D visualization with:

- **3D track rendering** - Flight path displayed in 3D space
- **Coordinate conversion** - GPS coordinates converted to local East-North-Up (ENU) frame
- **Start/end markers** - Green sphere (start), red sphere (end). The spheres have a fixed 2 m radius, so zoom in to see them on a long track
- **Velocity vectors** - Optional blue arrows at sampled track points. Arrow length is 5 m for each m/s. Only points with `vx`, `vy` and `vz` fields get an arrow, such as `vehicle_local_position` points
- **Ground plane** - Reference grid with transparent surface, 1 km square with 50 m cells. It sits at the altitude of the first GPS point, not at terrain height
- **Axes** - At the origin, 100 m long. For GPS points, red is east, green is up and blue is north. A separate 50 m red arrow points south
- **Camera controls** - Orbit, pan, zoom with auto-fit
- **Info panel** - Track Points, Total Messages, Duration, Start Time, Position Range and Altitude Range. Altitude Range is relative to the first GPS point. Start Time is the time since boot shown as a 1970 date, not the date of the flight
- **Export buttons** - Download the track, or up to 10,000 data records, as CSV

## Usage

### Opening the Viewer

1. In Sitrec, open **Sitrec → Extra Tools → PX4 ULog Viewer**. The viewer opens in a new tab. You can also open it from the [Tools page](https://www.metabunk.org/sitrec/tools/).
2. Under **Load ULog File (.ulg):**, select a `.ulg` file
3. The track will be automatically parsed and displayed

To run the viewer from a checkout, serve the `tools/` folder over HTTP, then open `http://localhost:8000/px4-viewer.html`:

```bash
python3 -m http.server 8000 --directory tools
```

The viewer does not work if you open the file directly from disk, because browsers block ES modules on `file://` pages.

### Controls

- **Left-click + drag** - Orbit camera around track
- **Right-click + drag** - Pan camera
- **Scroll wheel** - Zoom in/out
- **Reset Camera** - Auto-fit view to track bounds

### Display Options

- **Ground Plane** - Toggle reference grid and ground surface
- **Velocity Vectors** - Show the velocity arrows

### Export Options

- **Export Track CSV** - Saves `px4_track.csv`, with one row for each position message. `timestamp` is seconds since boot. GPS rows fill `alt`, `lat` and `lon`. Local rows fill `vx`, `vy`, `vz`, `x`, `y` and `z`, in NED.
- **Export All Data CSV** - Saves the first 10,000 data records, with one column for each field name. A longer log shows a warning first. Parameters, info messages and logged strings are not included.

### Using the Track in Sitrec

Drag `px4_track.csv` onto a custom sitch. Sitrec reads the rows that have `lat` and `lon`, and skips the local rows.

`timestamp` is seconds since boot, so the sitch Start Time moves to January 1, 1970. If you then change Start Time to the real date, the track stays at its last point. To import the track at its real time, first replace the `timestamp` values with UTC date-times, such as `2025-06-01T12:00:20.000Z`.

## Implementation Details

### ULog Format Support

The parser implements the ULog format specification:

- Header: the seven bytes `55 4C 6F 67 01 12 35` (`ULog` then `01 12 35`), a version byte and a 64-bit timestamp
- Message types:
  - `F` (0x46) - Format definitions
  - `I` (0x49) - Info messages
  - `M` (0x4D) - Multi info
  - `P` (0x50) - Parameters
  - `A` (0x41) - Add logged message
  - `D` (0x44) - Data messages
  - `B` (0x42) - Flag bits
  - `L`, `R`, `S`, `O`, `C`, `Q` - Accepted and skipped

### Supported Data Types

- `int8_t`, `uint8_t`
- `int16_t`, `uint16_t`
- `int32_t`, `uint32_t`
- `int64_t`, `uint64_t`
- `float`, `double`
- `bool`, `char`
- Arrays (e.g., `float[3]`)

Nested message types are not supported. In a record with a nested type, the nested field is empty and the fields after it are wrong.

### Coordinate System

- **Input**: GPS coordinates (lat/lon in degrees, alt in meters) or local NED positions in meters
- **Output**: GPS points become local ENU coordinates in meters. Local NED points are not converted
- **Reference**: First point with lat/lon used as origin. GPS fix quality is not checked
- **Visualization**: Y-up coordinate system (Three.js convention). For GPS points, east is +X, up is +Y and north is +Z

## Limitations

This is a simplified implementation compared to the full Python Flight Review:

- No time-series plots - only 3D visualization
- Track data covers position and velocity only
- No analysis features - only visualization and export
- No parameter tuning - read-only viewer

The 3D view also has these limits:

- All position topics share one line, in log order. A log with both GPS and `vehicle_local_position` data draws a line that jumps between the two frames at each message. Track Points, Position Range and Altitude Range include both kinds of point
- Local points and velocity arrows are drawn in NED, not ENU. North and east are swapped, and a climb draws downward
- For GPS points, the view is a mirror image of a map, so a right turn shows as a left turn

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

Each script has its own copy of the parser, so neither one tests `px4lib.js`. `test-px4-parser.js` does not read `sensor_gps`, and it can report success with 0 track points.

## Browser Compatibility

Requires modern browser with:
- ES modules, import maps and top-level await
- WebGL (Three.js)
- File API
- ArrayBuffer, DataView and BigInt

## License

Part of Sitrec. See the [Sitrec License](https://github.com/MickWest/Sitrec2/blob/main/LICENSE).
