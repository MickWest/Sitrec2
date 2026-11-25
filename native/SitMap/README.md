# SitMap

Native macOS MapKit companion for Sitrec. Requires macOS 14 or newer and the
Swift toolchain (Xcode or Command Line Tools). No third-party native dependencies.
Apple supplies imagery, terrain and building detail; coverage varies by location.

## Build and run

From the Sitrec repository root:

```sh
bash native/SitMap/build.sh
open native/SitMap/build/SitMap.app
```

The script makes an ad-hoc signed development app. If SwiftPM cannot create its
child build sandbox inside an existing restricted runner, use
`bash native/SitMap/build.sh --disable-sandbox`. This disables only SwiftPM's
child build sandbox. It does not change macOS security settings. Run the app from
Finder or a normal Terminal if the runner cannot register GUI applications.

Reopen the app after rebuilding. `swift test --package-path native/SitMap` checks
camera math, framing, validation and HTTP parsing.

The build packages `Assets/AppIcon.png` at all standard macOS icon sizes and
includes the result in the signed app. Generated icon sets and bundles remain
under the ignored `build/` directory.

## Experimental renderer controls

The optional local experiment exposes VectorKit's private renderer settings:

```sh
bash native/SitMap/build-experimental.sh
open native/SitMap/build/SitMap.app
```

This requires Python 3 in addition to the normal build tools. It builds a separate
Swift package under the ignored `build/Experimental/` directory and replaces the
development app at the usual path. Run the normal `build.sh` to restore the public
MapKit implementation. Neither build changes the other build's source files.

The **Renderer** sidebar provides search, categories, typed editors, a changed-only
filter, and individual or full resets. On the tested system it lists 472 properties:
468 writable and four read-only. The list comes from the installed framework and
can differ between macOS versions. Booleans use checkboxes; numeric values, text,
and aggregate values use fields. Aggregate values are JSON arrays in runtime field
order because field names are not exposed. Changes last for the app session.

**Relax Tilt Limits** was confirmed to relax the live map's pitch restriction.
Other settings may apply only to particular map styles or rendering paths. The
wireframe switches accept changes but did not produce wireframe imagery in the
tested live or snapshot views; that experiment remains unfinished. No geometry is
exported. The experimental build initially enables those two wireframe settings;
use **Reset All Experimental Changes** to return to launch defaults.

`GET /v1/experiment` reports the settings. `POST /v1/experiment` accepts a JSON
object mapping property names to typed values, or `{"reset":true}`. It uses the
same local API protections as camera requests. The executable's
`--probe-renderer` option checks property access, representative value round trips,
validation and resets without opening a window. These private APIs are for local
experiments and are not a supported distribution interface.

## Controls

| Input | Action |
| --- | --- |
| Left drag | Move the ground with the mouse |
| Middle drag / Shift-left drag | Orbit around the clicked ground point at a fixed radius |
| Right drag / Command-left drag | Look around from the estimated eye position |
| Wheel / trackpad scroll | Dolly |
| Shift-wheel | Change vertical FOV |
| Pinch | Dolly |

These use Sitrec's gesture assignments. Pan and orbit capture a camera and
ground-plane pivot at mouse-down, then compute each move from that immutable
state. Pan holds the grabbed point under the cursor; orbit preserves its radius
and screen position. A fresh distance-based camera is applied on each move;
unexpected native range/target changes are rejected. The pivot uses a local
ground plane because MapKit does not expose a 3D terrain hit. Camera fields,
place presets and imagery/hybrid/standard styles are in
the fixed sidebar. Changing status text does not resize or reposition controls.
The sidebar has internal padding and sliders for altitude, heading, elevation
and FOV. Sliders apply immediately; numeric fields accept precise values.
Altitude above the supplied ground and FOV use logarithmic sliders to retain
useful control over their large ranges. Heading and elevation use linear sliders.
The standard sidebar button at the top right hides or restores the inspector;
the map expands into the freed space. **View → Hide/Show Sidebar** and
**Control-Command-S** do the same. The choice persists across app launches.

## Sitrec integration

Build the Sitrec frontend (`npm run build`) and reload the updated SitrecBridge
extension and local Sitrec page. The extension can be loaded from
`tools/SitrecBridge/extension`; a distributable is made with
`npm --prefix tools/SitrecBridge run build`. Restart the MCP client connection
after updating its server to expose the new tools.

With SitMap open, choose **Camera → Send Look Camera to SitMap** or enable
**Camera → Live Sync to SitMap** in Sitrec. Live sync follows every changed
rendered look-camera pose, including paused camera edits. It includes displayed
camera offsets, FOV, roll, aspect and the ground estimate available to Sitrec.
It also raycasts the center of the displayed look camera and sends the visible
terrain/3D-tile target, its MSL elevation and its measured eye-to-target range.
When MapKit restricts pitch, Sitrec also supplies the surface hit along the
accepted source angle, so sloping terrain is accounted for in the correction.
Disable live sync before navigating SitMap independently.

The page API is also available:

```js
await window.sitMap.sendView();
await window.sitMap.sync({view: "lookView"});
window.sitMap.syncStatus();
await window.sitMap.sync({enabled: false});
await window.sitMap.status();
await window.sitMap.snapshot({width: 3840, height: 2160});
```

Bridge MCP tools: `sitmap_status`, `sitmap_set_view`, `sitmap_snapshot`,
`sitrec_send_to_sitmap`, `sitrec_sync_sitmap`. The first three access the native
app directly; the last two target a Sitrec tab and default to `lookView`.

The page posts changes to the extension; a persistent WebSocket carries them to
SitMap. The extension allows two poses in flight and one replaceable latest
pose, so the next camera change need not wait for the previous render tick.
SitMap applies its latest pending pose on a 60 Hz main-run-loop timer with MapKit
animation disabled. Acknowledgements report application time, not completed GPU
rendering or tile download. There is no per-frame MCP request. It reconnects after
an app restart and resends the current pose. Only one tab follows at a time.
Actual cadence is bounded by Sitrec's frame rate, browser visibility scheduling,
and MapKit/GPU work; intermediate poses can be coalesced to avoid growing latency.

## Local API

HTTP listens only on `127.0.0.1:9876`. WebSocket uses `127.0.0.1:9877` with
subprotocol `sitmap-v1`. The HTTP API rejects ordinary web origins. Browser
requests go through the trusted SitrecBridge extension; native clients may omit
Origin. These ports are a local companion interface, not a remote service.

```sh
curl http://127.0.0.1:9876/v1/status
curl -X POST http://127.0.0.1:9876/v1/view \
  -H 'Content-Type: application/json' \
  -H 'X-SitMap-Client: SitrecBridge-v1' \
  -d '{"latitude":37.795,"longitude":-122.405,"altitudeMSL":900,"groundAltitudeMSL":0,"heading":210,"elevation":-35,"verticalFov":30,"roll":0,"aspect":1.7777778}'
```

`GET /v1/view` reads the same camera state. `POST /v1/snapshot` accepts
`{"width":3840,"height":2160}` and returns a base64 PNG in `imageData` with
projection metadata. Limits: 4096 pixels on either axis and 8,388,608 total output
pixels. It uses `MKMapSnapshotter`; it is not a capture of the live Metal surface.

`POST /v1/gesture` drives the same navigation controller as the native mouse:
send `{"phase":"begin","mode":"orbit","x":0.5,"y":0.5}`, then one or
more `{"phase":"move","x":0.51,"y":0.49}`, followed by `{"phase":"end"}`.
Modes are `pan`, `orbit`, and `look`. Coordinates are normalized to the rendered
viewport, with (0,0) at its top left. Stop live sync for an independent gesture.
The returned `navigation` metadata includes pivot radii and native pose errors.

`POST /v1/layout` accepts `{"sidebarHidden":true}` (or `false`) and uses the
same layout path as the toolbar button. Source geometry is resized synchronously
before testing native camera limits, including when already inside AppKit layout.
`projection.expectedSourceWidth/Height` and `sourceWidth/Height` expose any mismatch.

Camera coordinates are degrees, altitudes meters MSL, heading clockwise from
north, elevation positive above the horizon, roll degrees, vertical FOV degrees,
and aspect width/height. Ground MSL defaults to zero if omitted. Sitrec converts
its ellipsoid heights to MSL with its geoid model. Camera latitude is limited to
±85°, height above supplied ground to 1–2,000,000 m, FOV to 0.1–120°, aspect to
0.1–10. `style` is `imagery`, `hybrid`, or `standard`.

For sloping terrain, supply `groundTarget` with `latitude`, `longitude`,
`altitudeMSL`, and `distance` (the 3D eye-to-target range in meters). Sitrec sends
this automatically when its center ray hits a loaded surface. The target's
elevation is distinct from `groundAltitudeMSL` beneath the camera. MapKit uses
the target coordinate and range. When pitch is clamped, `sourceGroundTarget`
supplies the same fields plus `pitch`, measured along the accepted native angle
from the same eye. Sitrec computes this after the native acknowledgement and
resends the pose, including while paused. Without that refinement, SitMap uses
a plane at the original target elevation to estimate its source camera.

A live client waits for `{"type":"ready","apiVersion":1}`, then sends
`{"type":"pose","sequence":1,"sentAt":<Unix milliseconds>,"camera":{...}}`.
The server replies `applied` with `sequence`, `sentAt`, `appliedAt`, and
`nativePitch`, or sends `error`.

## Projection limits and research

Public [MKMapCamera](https://developer.apple.com/documentation/mapkit/mkmapcamera)
exposes heading, pitch, center and distance, with no FOV or roll setter.
[Pitch](https://developer.apple.com/documentation/mapkit/mkmapcamera/pitch)
can be clamped by MapKit, with the maximum depending on altitude. The eye-coordinate initializer's
[altitude is above ground](https://developer.apple.com/documentation/mapkit/mkmapcamera/init(lookingatcenter:fromeyecoordinate:eyealtitude:)),
not absolute MSL. Apple's terrain heights are not available to the caller.

SitMap uses the target and distance measured against Sitrec's visible terrain
when supplied. Otherwise it derives a target and distance from the requested eye
using the supplied ground height and a local ground-plane approximation. It requests a ground-facing
pitch and reports MapKit's actual readback. SitMap first adjusts the source
render dimensions to find a size that accepts that pitch without moving the
camera. When a clamp remains, SitMap rebuilds its ground target and range to preserve the estimated eye, then
reprojects the image to the requested viewing direction. This cannot guarantee
the original eye position over different terrain, near the horizon or at long
distances. Looking upward is unsupported. `requireExact:true` is rejected rather
than silently approximated.

FOV is measured by forward-projecting a short geographic baseline perpendicular
to the heading, using the accepted camera distance. Live views and snapshots
use the same method. The baseline length is measured with MapKit's own
`MKMapPoint.distance(to:)`; assuming the nominal spherical offset introduces a
latitude-dependent scale error. Inverse screen-to-ground lookup is not used for lens
calibration because realistic terrain can make that measurement unstable.
The measured FOV is used for a
center crop, with scale `tan(nativeFOV/2) / tan(requestedFOV/2)`. This changes
framing without dollying the eye. Roll rotates that image. The live map uses
adaptive source dimensions and Retina backing resolution. Telephoto views eventually
upsample; a requested FOV wider than the native source, or rotated uncovered
corners, shows dark borders. The API reports `requested`, `applied`, `fidelity`,
coverage, source-pixel ratio and pitch error. Calibration can be unavailable,
especially at globe scale. Native FOV is measured, not assumed to be a constant.

Pitch compensation is a perspective camera-rotation homography applied to the
live map layer and to snapshots. It aligns rays from the same estimated eye;
it does not invent pixels outside the source. A fixed source at 35° pitch with
30° vertical FOV cannot fill a requested 48° pitch / 20° FOV. However, increasing
the source dimensions can let MapKit accept the requested pitch and capture
those missing rays. In a measured macOS case, changing the surface from
1614 × 730.5 to 2017.5 × 913.1 points (1.25×) restored the full 47.76° pitch
at the same 2867.46 m range, with no target displacement or black area.
If resizing cannot provide coverage within the resource budget, remaining
uncaptured pixels stay dark. Read
`fidelity.pitchCompensationDegrees` and `fidelity.fullyCovered`. Projection
diagnostics also report the requested target's location in the reprojected
output and residual errors of the source camera after pitch compensation.

MapKit can also move the target and increase range at its maximum zoom. An
enlarged live render surface makes that limit easier to reach. In a measured
macOS test, a 2× surface changed a 218.46 m camera request to 271.28 m and moved
the target by 39.14 m. At native size, range and target matched to numerical
precision. SitMap therefore chooses the render size automatically: it enlarges
the source for a pitch clamp, reduces it for a displaced source camera, and
retains the last working size across sync updates. Automatic sizes run from
0.5× to 4×, bounded by 4096 points per axis and 8,388,608 square points, before
Retina backing. A supplied `renderScale` (0.5–2) overrides adaptation for
diagnostics. `projection.renderScaleMode`, `renderScale`, and `fitAttempts`
report the choice. There is no private API or hardcoded altitude-to-pitch table.
For a cropped lens, automatic fitting can also make the source narrower than
the output, allocating the same pixel budget to a taller render surface. It
preserves the horizontal rays needed by the requested FOV, pitch and roll.
`projection.sourceAspect` reports the shape; output aspect remains unchanged.
Shape changes use discrete steps and hysteresis so small camera rotations do
not continually resize MapKit's render surface. An unchanged size does not
reset the layer layout. `projection.surfaceResizeCount` and
`projection.applyMilliseconds` report resizing and camera-update cost; the
timing excludes asynchronous GPU rendering and tile loading.
Snapshots retain this source shape and project to the requested output aspect.
Check
`projection.sourceCenterErrorMeters` and `projection.sourceRangeErrorMeters`
to detect source displacement. `requestedTargetOutputX/Y` give the original
target's projected output location (normally 0.5, 0.5); coordinate conversion
uses MapKit's map plane, so this diagnostic also depends on terrain height.
Readback agreement still cannot guarantee identical Apple/Google terrain heights.

For alignment diagnostics, `POST /v1/projection` accepts up to 256
`points: [{x: 0.5, y: 0.5}]` in normalized viewport coordinates, measured from
the top left. It returns map coordinates and forward-projection round trips.
These are map-plane samples, not elevations of the visible terrain or buildings.

At a hard pitch cutoff, the requested projection can miss the source image
entirely. If less than 1% of the requested frame has source coverage, SitMap shows
the nearest fully covered angle (or the native angle when the lens itself is too
wide) and displays an angle-limit notice. This keeps the map visible without
claiming matching orientation. `fidelity.angleLimited`, `applied.displayedPitch`,
and `fidelity.requestedCoverageFraction/displayedCoverageFraction` distinguish
the requested and displayed views. The original request and native pitch remain
available; returning to a supported view automatically restores mirroring.

Snapshotter can hit that limit too. SitMap checks that the requested target
projects to the source image center and retries at half the source dimensions
when it does not. Small output images retain at least the live source's render
height (within the snapshot budget), then downsample; this avoids reintroducing
a pitch clamp just because the exported image is small. Retries stop at that
minimum or after three attempts and report an error rather than a shifted
image. Snapshot metadata reports the final source dimensions, center error,
`resolutionReduced` and `sourcePixelsPerOutputPixel`. The output can remain 4K
while its source detail is lower; this preserves framing without claiming more
map detail than MapKit supplies.

Relevant implementations inspected:

- [FlyoverKit](https://github.com/SvenTiigi/FlyoverKit) animates supported MapKit
  cameras; it does not provide an unrestricted camera projection.
- [Munim Maps camera source](https://github.com/munimtechnologies/munim-maps/blob/main/packages/munim-maps/ios/Engines/MapKit/MapKitCameraSource.swift)
  estimates focal length from coordinate projections and accounts for viewport
  offsets. This supports measuring projection rather than hardcoding a lens.
- [Apple Frameworks for TouchDesigner: MapKit](https://github.com/sygnalinc/Apple-Frameworks-for-TouchDesigner/tree/main/MapKit)
  keeps a live MKMapView and captures its window with ScreenCaptureKit. Its author
  reports much higher live capture cadence than snapshot rendering and blank
  output from ordinary bitmap/layer capture of the Metal surface. SitMap embeds
  the live view directly; snapshot calls are a separate, slower API.
- [Rotation homography](https://docs.opencv.org/4.0.0/d9/dab/tutorial_homography.html)
  supplies the geometry for reprojecting different camera orientations from the
  same eye. SitMap implements this for pitch, FOV and roll. It cannot reveal
  missing source pixels or correct a displaced eye. The normal build uses no private MapKit APIs.

3D detail depends on Apple coverage and streaming. A 4K output does not imply
4K source detail at arbitrary magnification. Snapshots can differ from the live
3D view; metadata identifies the renderer and preserves Apple Maps attribution.
