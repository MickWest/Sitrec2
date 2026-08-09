# Fit Points API — driving "Fit Camera to Points" programmatically

Audience: AI agents (and scripts) driving Sitrec through the MCP bridge
(`sitrec_api_call` / `sitrec_api_list`), or calling `sitrecAPI.call(fn, args)` from
code. The tool itself is `CNodeFitCameraPoints` (`src/nodes/CNodeFitCameraPoints.js`);
the API entries live in `src/CSitrecAPI.js`.

The tool recovers an unknown camera from landmark pairs. Each **control point** pairs a
pixel on the video ("that pixel…") with a world position ("…is that place"). Three or
more well-spread pairs determine the camera position, pointing and FOV; the solver
writes the result into the ordinary camera nodes (`fixedCameraPosition`, `ptzAngles`,
`fovUI`).

## Functions

| Function | What it does |
|---|---|
| `fitPointsStatus` | Full tool state: settings, points, status/residual, current camera. Read-only. |
| `fitPointsConfigure` | Set `enabled`, `useTiles`, `autoFit`, `lockPosition`, `lockFOV`, `lockRoll`, `method` (`direct`/`homography`). |
| `fitPointsAdd` | Add a pair: video pixel (`vx`/`vy` or `fx`/`fy`) + optional world position (`lat`, `lon`, `alt`/`altMSL`). |
| `fitPointsMove` | Change either half of a pair by `id`. |
| `fitPointsRemove` | Delete a pair by `id`. |
| `fitPointsSolve` | Run the solve ("Fit Now") and report residual/observability/camera. |
| `pickWorldPoint` | Screen-to-world: what surface point a pixel of `mainView`/`lookView` shows. Read-only. |

## Coordinate conventions

- **Video pixels** (`vx`, `vy`) are in the ORIGINAL video frame; its size is
  `videoSize` in `fitPointsStatus`. `fx`/`fy` are fractions 0–1 of that frame
  (x right, y down), convenient when reading positions off a screenshot — measure
  within the video content, excluding any letterbox bars.
- **Altitudes** are metres. `alt`/`altHAE` is height above the ellipsoid (what
  `pickWorldPoint` returns and what the points store); `altMSL` is above sea level.
  Mixing the two datums is a silent ~25–40 m error — when feeding a result of
  `pickWorldPoint` back in, pass its `altHAE` as `alt`.
- **`pickWorldPoint` fractions** are of the view's *rendered* image (for `mainView`
  that is the whole pane, i.e. exactly a screenshot of that view; the letterboxed
  `lookView` renders inside its bars).

## The agent workflow

1. `fitPointsConfigure {enabled: true, useTiles: true}` — `useTiles` makes points land
   on the 3D building geometry (roofs, walls) instead of the elevation surface, which
   has no buildings on it. The Google 3D tiles must have streamed in first (~30 s after
   load, and only where a view is looking).
2. Screenshot the **video view**; identify recognisable features — building corners,
   roof tops. Convert each to `fx`/`fy` fractions of the video frame.
3. Find each feature's real position. Screenshot the **main view**, find the same
   building, and call `pickWorldPoint {fx, fy}` on it — or use known coordinates plus
   `getGroundAltitude`. Picking the exact roof/corner matters at short range.
   A pick exactly on a silhouette edge misses ("hit no surface" = the ray cleared the
   skyline), so **bracket**: step a pixel-fraction or two into the building and keep
   the highest hit. The look view faces the scene the way the video does, so matching
   a feature's left/right corners there is unambiguous; the result's `canvas` values
   let you cross-check your screenshot-to-fraction mapping.
4. `fitPointsAdd {fx, fy, lat, lon, alt}` per pair. With `autoFit` on, each add
   re-solves; set `autoFit: false` to place everything first.
5. `fitPointsSolve`, then screenshot the look view next to the video view and compare.
   Iterate with `fitPointsMove` on the worst pair.

## Gotchas learned in the field

- **Invisible-LOD ghosts.** `pickWorldPoint` raycasts the whole 3D-tile group, which can
  contain coarse parent-LOD meshes (fat tree blobs especially) that are not what is
  rendered at that pixel. A sightline that grazes a treed shoreline can return a "hit"
  from a ghost tree even though the pixel clearly shows a bridge behind it. Discriminate
  with structure: a thin structure (bridge, mast) shows water/background hits when you nudge
  the pick a few pixel-fractions above and below; a canopy stays solid. If a region is
  poisoned, pick the same feature from a different view/angle.
- **Near-field control points can collapse the solver.** With position free, a pair much
  closer than the others can pull the solved camera position onto the point itself
  (residual looks fine, camera is nonsense — check whether camera ≈ point position).
  Work around it by seeding the camera near the expected answer first (`gotoLLA` +
  `setCameraToEyeLevel`, which handles the AGL/MSL mode mess and works over water),
  then solving; or temporarily `lockPosition` and scan candidate positions, keeping the
  best residual.
- **A near point is also what fixes weak observability.** Distant landmarks alone leave
  range/FOV trading off ("east cannot be determined"). One correct near-field pair (a
  bridge, a shoreline structure) turns observability to "Good (position ±N m)".

## Reading the result

- `residual` is RMS reprojection error in original video pixels. Small residual means
  the camera *explains the points* — it does not by itself mean the camera is right;
  check `observability` for parameters the geometry cannot pin down.
- A solve that scores worse than the camera it started from is **rejected** and the
  camera left alone (`status` says so). Locks (`lockPosition` etc.) only apply to the
  `direct` method.
- Points belong to the frame they were placed on (`fitFrame` — adopted from the current
  frame by the first `fitPointsAdd`). Adding, moving, or solving from any other frame is
  refused, same as in the UI — `setFrame` back first. Removal is allowed from any frame.
- Every mutation is undoable in the UI (standard UndoManager entries), and the points
  serialize with the sitch, so a saved fit can be reopened and audited.
