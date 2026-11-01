# Fit Points API — driving "Fit Camera to Points" programmatically

The tool recovers an unknown camera from landmark pairs. Each **control point** pairs a
pixel on the video ("that pixel…") with a world position ("…is that place"). The tool
works only in a custom sitch with a video loaded.

This page is for AI agents and scripts that use the [MCP Bridge](MCPBridge.md)
(`sitrec_api_call` / `sitrec_api_list`) or `sitrecAPI.call(fn, args)`. For the menus, see
[The Camera and Target Menus](CameraAndTarget.md). Both calls return `{success, fn, result}`
(`call` as a promise), and the fields named on this page are inside `result`.

Each pair gives two measurements (x and y), and the `direct` method needs one for each
free value. By default six are free: camera position (three), heading, elevation and field
of view ([FOV](Glossary.md)). Roll is held at its current value (`lockRoll: true`), so the
minimum is three well-spread pairs. Three leave no spare measurements, so a small residual
then shows nothing: use more. With `lockRoll: false`, for a video with a visibly tilted
horizon, `direct` needs four pairs. The `homography` method always needs four.

The solver writes the result into the ordinary camera nodes (`fixedCameraPosition`,
`ptzAngles`, `fovUI`) and makes them the camera's sources: position from the fixed camera
in above mean sea level ([MSL](GIS.md#three-kinds-of-height)) mode (unless `lockPosition`),
FOV from the manual value (unless `lockFOV`), and heading from Manual. A camera that
followed a track stops following it. A fit also turns on `syncLookCamera`.

## Functions

| Function | What it does |
|---|---|
| `fitPointsStatus` | Tool state: settings, points, status/residual, current camera. The solver appears as `fitMethod`. Read-only. |
| `fitPointsConfigure` | Set `enabled`, `useTiles`, `useObjects`, `autoFit`, `syncLookCamera`, `lockPosition`, `lockFOV`, `lockRoll`, `method` (`direct`/`homography`). |
| `fitPointsAdd` | Add a pair: video pixel (`vx`/`vy` or `fx`/`fy`) + world position (`lat`, `lon`, `alt`/`altMSL`). Without `lat`/`lon` the world half is a guess under the current camera's ray. It carries no information, but the solve still counts it, so set the real position with `fitPointsMove` before you solve. |
| `fitPointsMove` | Change either half of a pair by `id`: `vx`/`vy` in original video pixels, and/or `lat` + `lon` (both are needed) with optional `alt`/`altMSL`. `fx`/`fy` are not accepted here: they are ignored and the call still returns success. Convert with `vx = fx * videoSize[0]`, `vy = fy * videoSize[1]`. |
| `fitPointsRemove` | Delete a pair by `id`. |
| `fitPointsSolve` | Run the solve ("Fit Now") and report residual/observability/camera. |
| `pickWorldPoint` | Screen-to-world: what surface point a pixel of `mainView`/`lookView` shows — buildings and 3D objects included. It has its own `useTiles` and `useObjects` arguments (default true). Read-only. |

## Coordinate conventions

- **Video pixels** (`vx`, `vy`) are in the ORIGINAL video frame; its size is
  `videoSize` in `fitPointsStatus`. `fx`/`fy` are fractions 0–1 of that frame
  (x right, y down), convenient when reading positions off a screenshot — measure
  within the video content, excluding any letterbox bars.
- **Altitudes** are metres. On input, `alt` is height above the WGS84 ellipsoid
  ([HAE](GIS.md#three-kinds-of-height)) and `altMSL` is height above mean sea level (MSL).
  On output, the same two values appear as `altHAE` and `altMSL`, and the points store
  HAE. An input named `altHAE` is ignored, so pass `altHAE` from `pickWorldPoint` as `alt`.
  Mixing the two heights is a silent error equal to the local
  [geoid undulation](Glossary.md), about −107 m to +85 m worldwide. `getGroundAltitude`
  returns it as `geoidOffset`. Other places in Sitrec that take an altitude can use a
  different unit or reference surface: see [Coordinate formats](GIS.md#coordinate-formats).
- **`pickWorldPoint` fractions** are of the view's *rendered* image (for `mainView`
  that is the whole pane, i.e. exactly a screenshot of that view; the letterboxed
  `lookView` renders inside its bars).

## The agent workflow

1. `fitPointsConfigure {enabled: true}`. For landmarks on buildings, also turn on
   **Terrain → 3D Buildings** with `setMenuValue {menu: 'terrain', path: '3D Buildings',
   value: true}`. It is off by default, and it appears only for users with 3D building
   access or their own Google or Cesium key. Tiles stream only where a view is looking,
   and `setMenuValue` returns before they arrive, so pick only after a screenshot of that
   view shows them. Where there are no tiles, `pickWorldPoint` falls back to the elevation
   surface, which has no buildings on it, and no error says so. Pass `useTiles: false` to
   `pickWorldPoint` to force that fallback — the right choice when every landmark *is*
   the ground (a river bend, a shoreline, a track). The tool's own `useTiles` and
   `useObjects` settings do not change `pickWorldPoint`, or a point added with `lat`/`lon`.
2. Get the frame with `sitrec_get_video_frame` (it has no letterbox bars), or screenshot
   the **video view**; identify recognisable features — building corners, roof tops.
   Convert each to `fx`/`fy` fractions of the video frame.
3. Find each feature's real position. Screenshot the **main view**, find the same
   building, and call `pickWorldPoint {fx, fy}` on it — or use known coordinates plus
   `getGroundAltitude`. Picking the exact roof/corner matters at short range.
   A pick exactly on a silhouette edge can miss the building. Against the sky it fails
   with "hit no surface"; against land or water it succeeds and returns the ground behind.
   So **bracket**: move `fx`/`fy` by one or two pixels (1/width, 1/height of the
   screenshot) into the building and keep the highest hit. The look view faces the scene
   the way the video does, so matching a feature's left/right corners there is unambiguous;
   the result's `canvas` values let you cross-check your screenshot-to-fraction mapping.
4. `fitPointsAdd {fx, fy, lat, lon, alt}` per pair. `autoFit` is off by default, so
   place the whole set first and solve once; set `autoFit: true` if you want every add
   and move to re-solve as it happens.
5. `fitPointsSolve`, read `status`, then screenshot the look view next to the video view
   and compare. The API reports only the overall residual. After a solve, each marker in
   the video view shows its place in the `points` list (from 1, not its `id`) and its own
   residual in pixels. Take the `id` from that list and fix the worst with `fitPointsMove`.

## Gotchas learned in the field

- **Coarse tiles.** `pickWorldPoint` hits only the tiles the view is drawing, at that
  view's current level of detail. A coarse tile can cover a thin structure, so a sightline
  that grazes a treed shoreline can hit the trees although the video shows a bridge behind
  them. Discriminate with structure: a thin structure (bridge, mast) shows water/background
  hits when you nudge the pick a few pixels above and below; a canopy stays solid. If that
  does not settle it, pick the same feature from a different view/angle.
- **Near-field control points can collapse the solver.** With position free, a pair much
  closer than the others can pull the solved camera position onto the point itself
  (residual looks fine, camera is nonsense — check whether camera ≈ point position).
  Work around it by seeding the camera near the expected answer first (`gotoLLA` +
  `setCameraToEyeLevel`, which handles the above ground level ([AGL](Glossary.md)) and MSL
  modes and works over water), then solving; or temporarily `lockPosition` and scan
  candidate positions, keeping the best residual. `gotoLLA` also moves the main view to 2,300 km above the point and
  recentres the terrain, so pick in `lookView` afterwards, or move the main view back.
- **A near point is also what fixes weak observability.** Distant landmarks alone leave
  range/FOV trading off ("east cannot be determined"). One correct near-field pair (a
  bridge, a shoreline structure) can turn observability to `Good (position +/-N m)`.

## Reading the result

- `residual` is the root-mean-square average distance, in original video pixels, between
  each control point's pixel and the place where the solved camera draws its world
  position. It is a string such as `12.34 px`, so parse it before you compare values.
  Small residual means the camera *explains the points* — it does not by itself mean the
  camera is right; check `observability` for parameters the geometry cannot pin down.
  `Weak: X cannot be determined…` means the points do not fix X. A different starting
  camera can give a very different X with the same residual. X can also move away from
  its start, although the message ends `held near its previous value`.
- `fitPointsSolve` returns `success: true` even when no fit was applied. Always read
  `status`: only a value that starts with `Fitted` means the camera changed. Wrong frame,
  too few points, a rejected solve and Free Look all leave the camera alone and say so in
  `status`. Switch Free Look off with
  `setMenuValue {menu: 'camera', path: 'Camera Tweaks/Free Look Camera', value: false}`.
- With `direct`, a solve that scores worse than the camera it started from is **rejected**
  and the camera left alone. With `homography`, the limit is 4 × the starting residual +
  20 px, so an applied solve can raise the residual. Locks apply only to `direct`.
- Points belong to the frame they were placed on (`fitFrame` — adopted from the current
  frame by the first `fitPointsAdd`). Adding, moving, or solving from any other frame is
  refused, same as in the UI — `setFrame` back first. Removal is allowed from any frame.
- `fitPointsAdd`, `fitPointsMove` and `fitPointsRemove` add undo entries in the UI;
  `fitPointsSolve` and `fitPointsConfigure` do not. The points serialize with the sitch,
  so a saved fit can be reopened and audited.

Source: `src/nodes/CNodeFitCameraPoints.js` (the tool) and `src/CSitrecAPI.js` (the API).
