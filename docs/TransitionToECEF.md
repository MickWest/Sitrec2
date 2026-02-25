# Transition to ECEF: Making EUS Identical to ECEF

## Overview

Experimental change to place the EUS origin at the center of the Earth, making EUS an identical frame to ECEF (Earth-Centered Earth-Fixed). Previously EUS was a local tangent plane (East-Up-South) centered on the Earth's surface at `Sit.lat/Sit.lon`, with a rotation matrix and translation offset separating it from ECEF.

## Why Rendering Still Looks Fine

Despite coordinates now being ~6,378 km from the origin, there is no visible jitter or z-fighting. This is because Three.js objects are rendered in **groups** which use double-precision (Float64) for their world position. The GPU only sees vertex positions relative to the group origin, which are small enough for float32 precision. The large ECEF coordinates are handled entirely in JavaScript (double precision) before being passed to the GPU as small offsets.

## Changes Made

### 1. Core Conversion Functions (`src/LLA-ECEF-ENU.js`)

All EUS<->ECEF conversion functions made into identity transforms:

- **`EUSToECEF_radii(posEUS)`** - returns `posEUS.clone()`
- **`ECEFToEUS_radii(posECEF)`** - returns `posECEF.clone()`
- **`ECEF2EUS(pos, lat1, lon1, radius, justRotate)`** - returns `pos.clone()`
- **`ECEFToEUS(posECEF, radius)`** - returns `posECEF.clone()`
- **`EUSToECEF(posEUS, radius)`** - returns `posEUS.clone()`
- **`LLAToEUSRadians(lat, lon, alt, radius)`** - now does LLA->ECEF only (no origin subtraction, no rotation). Still uses `_updateSitConstants()` for ellipsoid constants (`_llaeus_e2`, `_llaeus_ratio`).
- **`EUSToLLA(eus)`** - simplified: treats input directly as ECEF, calls `ECEFToLLA_radii()`.

All ~50 calling sites across the codebase are unchanged since the function signatures are preserved.

### 2. 3D Tiles Matrix (`src/nodes/CNodeBuildings3DTiles.js`)

- **`buildECEFToEUSMatrix4()`** - returns `new Matrix4()` (identity). Previously built a combined rotation+translation matrix from Sit lat/lon.

### 3. MISB Track Inlined Transform (`src/nodes/CNodeTrackFromMISB.js`)

- The inlined ECEF->EUS matrix (`mECEF2EUS`) replaced with `new Matrix4()` (identity). Previously built ECEF->ENU rotation, ENU->EUS swap, and origin translation, all composed into a single Matrix4 applied per-vertex.

### 4. Elevation Worker (`src/ElevationInterpolationWorker.js`)

- No changes needed. Its `LLAToEUS()` function already returned ECEF coordinates directly (LLA->ECEF with no rotation or origin offset). This was coincidentally already correct for the new system.

### 5. Camera Default Position Fix (`src/nodes/CNodeCamera.js`)

**Problem:** Cameras without an explicit start position defaulted to `(0,0,0)`. In the old EUS this was on Earth's surface at the origin. In ECEF, `(0,0,0)` is the center of the Earth. `getLocalUpVector(V3(0,0,0))` tries to compute the geodetic normal of the origin point, which is a zero vector, causing the camera matrix to degenerate. Result: completely black views.

**Fix:** Added fallback in `resetCamera()`: if neither `startPos` nor `startPosLLA` is set, position the camera at `LLAToEUS(Sit.lat, Sit.lon, 0)` (Earth's surface at the sitch origin). This is backward-compatible with the old system where `LLAToEUS(Sit.lat, Sit.lon, 0)` returned `(0,0,0)`.

Also added `Sit` and `LLAToEUS` to imports.

### 6. Main Camera Default Position Fix (`src/SituationSetup.js`)

**Problem:** The mainCamera fallback (used when no `startCameraPosition` or `startCameraPositionLLA` is specified) was hardcoded EUS coordinates `[0, 130000, 160000]` (130km up, 160km south). In ECEF these coordinates are ~200km from the origin — deep inside the Earth.

**Fix:** Changed to LLA-based default: `startCameraPositionLLA: [Sit.lat - 1, Sit.lon, 200000]` with target `startCameraTargetLLA: [Sit.lat, Sit.lon, 0]`. This gives a camera 200km up, 1 degree south of the origin, looking at the surface — equivalent intent to the old EUS default but works in ECEF.

## Ongoing Fixes

### 7. Grey Sphere Polar Axis Rotation (`src/nodes/CNodeTerrain.js`)

**Problem:** The grey sphere (covers poles/ocean under terrain) appeared skewed — showing through terrain in ~1/3 of the top and bottom hemispheres, not uniformly.

**Root cause:** The sphere is scaled non-uniformly (equatorial on X/Z, polar on Y), then rotated to align the polar axis with Earth's rotation axis. In old EUS, the needed rotation was latitude-dependent: `Sit.lat * π/180 - π/2` because the local tangent plane's Y-axis orientation relative to the polar axis varied with latitude. At lat=32° this gave a rotation of -58°.

In ECEF, the polar axis is always Z, regardless of `Sit.lat`. The rotation needed to map Y (sphere's polar axis after scaling) to +Z is always `+π/2`. The 32° discrepancy (from the latitude term) caused the sphere to be visibly tilted.

**Fix:** Changed rotation from `Sit.lat * Math.PI / 180 - Math.PI / 2` to `+Math.PI / 2` in both the constructor and `updateGreySphereVisibility()`. Position (`earthCenterEUS()` = origin) and scale were already correct. (Initially used `-π/2` which was corrected to `+π/2` in fix #10.)

**General principle:** Any geometry that was rotated to compensate for the EUS local frame's latitude-dependent orientation needs to be re-examined. In ECEF, the frame is global and fixed — latitude-dependent rotations become constant.

### 8. Celestial Sphere Rotation (`src/nodes/CNodeDisplayNightSky.js`)

**Problem:** The night sky (stars, constellations, equatorial grid) was incorrectly rotated.

**Root cause:** The celestial sphere's star data is in ECI (Earth-Centered Inertial) coordinates: X = vernal equinox (RA=0), Y = RA=6h, Z = north celestial pole. This is Z-up. The old EUS code applied three rotations to convert from this Z-up celestial frame to the Y-up, latitude/longitude-dependent local tangent plane:
1. 180° around Y (flip for EUS axis convention)
2. `(Sit.lon + GMST - 90)°` around Z (longitude + sidereal time)
3. `Sit.lat°` around X (tilt for latitude)

In ECEF, Z is also the north pole — the celestial sphere's Z-up orientation already matches ECEF. The only transformation needed is ECI→ECEF: rotate by -GMST around Z to account for Earth's rotation. No latitude, longitude, or axis-flip rotations are needed.

**Fix:** Replaced the three-rotation sequence with a single Z rotation by `-GMST`. Applied to both `celestialSphere` and `celestialDaySphere`. The `getCelestialDirectionFromRaDec()` function in `CelestialMath.js` uses `ECEF2EUS()` which is now identity, so celestial directions are already returned in ECEF — no changes needed there.

**Note:** The `celestialToECEF()` function in `CelestialMath.js` performs the same ECI→ECEF rotation (by -GST around Z) for individual celestial body directions. This is consistent with the new celestial sphere rotation.

### 9. Globe Rotation and Lighting (`src/Globe.js`)

**Problem:** The globe had no visible day/night shading — lighting appeared uniform.

**Root cause:** `addAlignedGlobe()` rotated the globe mesh using latitude/longitude-dependent rotations designed for the old EUS local tangent plane:
1. Around Y by `-(lon + 90°)`
2. Around X by `-(90° - lat)`

These rotations aligned the globe so the Sit origin appeared at Y-up in EUS. In ECEF, they produced an incorrectly oriented globe. Since the globe shader computes lighting via `dot(vNormal, sunDirection)`, the wrong normals (from wrong rotation) caused the lighting calculation to fail — the sun direction was correct (from `getCelestialDirection` → `celestialToECEF` → identity `ECEF2EUS`), but the normals didn't match.

**Fix:** Replaced the two lat/lon rotations with a single `+π/2` rotation about X. Same principle as the grey sphere fix (#7).

**Recurring pattern:** Three.js geometries default to Y-up (poles, normals, etc.). ECEF is Z-up. The fix is consistently: rotate **+90°** about X. This pattern applies to any geometry that has a "polar" or "up" axis along Y.

### 10. Rotation Sign Correction (`src/Globe.js`, `src/nodes/CNodeTerrain.js`)

**Problem:** After fixes #7 and #9, lighting/shadows appeared but the illuminated region was a small circle centered at ~(-90° lon, 0° lat) on the equator, shrinking and growing. The globe appeared flipped upside-down with east-west mirrored.

**Root cause:** The rotation sign was wrong. The rotation matrix about X by angle θ transforms coordinates as:
- θ = **-π/2**: (x,y,z) → (x, z, -y) — Y maps to **-Z** (south pole!), and Z maps to +Y. This flips the globe upside-down and mirrors east-west.
- θ = **+π/2**: (x,y,z) → (x, -z, y) — Y maps to **+Z** (north pole), and Z maps to -Y. This is the correct mapping.

Verification with +π/2:
- Texture u=0.5 (lon=0°) at local (+R,0,0) → (+R,0,0) = ECEF lon=0° ✓
- Texture u=0.75 (lon=90°) at local (0,0,-R) → (0,+R,0) = ECEF lon=90° ✓
- Texture v=0 (north pole) at local (0,+R,0) → (0,0,+R) = ECEF +Z = north pole ✓

**Fix:** Changed `-Math.PI / 2` to `+Math.PI / 2` in three locations:
1. `src/Globe.js` line 242: `sphere.rotateOnWorldAxis(worldAxisX, Math.PI / 2)`
2. `src/nodes/CNodeTerrain.js` constructor: `this.greySphere.rotation.x = Math.PI / 2`
3. `src/nodes/CNodeTerrain.js` `updateGreySphereVisibility()`: `this.greySphere.rotation.x = Math.PI / 2`

**Lesson:** When converting from Y-up to Z-up, the correct rotation about X is always **+π/2**, not -π/2. The sign determines whether Y maps to +Z (correct) or -Z (inverted).

### 11. Earth Center Uniform in Shader Materials (`TerrainDayNightMaterial.js`, `DayNightStandardMaterial.js`, `CNodeSynthClouds.js`)

**Problem:** Terrain tiles and 3D buildings overlaid on the globe had incorrect day/night shading — wrong terminator position and angle.

**Root cause:** Three shader materials had a hardcoded `earthCenter` uniform set to the old EUS value `new Vector3(0, -wgs84.RADIUS, 0)`. In EUS, the Earth's center was at `(0, -6371km, 0)` (below the surface origin along the Y-down axis). In ECEF, the Earth's center is at the origin `(0, 0, 0)`.

These shaders compute the radial "up" direction at each fragment as:
```glsl
vec3 globalNormal = normalize(vWorldPosition - earthCenter);
```

With the wrong `earthCenter`, the computed normals pointed in completely wrong directions. For example, a terrain point at lat=32°, lon=-118° in ECEF would compute a "global normal" offset by 6371km along Y — producing a vector roughly 45° from the true radial direction. This caused the day/night terminator on terrain tiles and buildings to be visibly misplaced relative to the globe underneath.

**Fix:** Changed `earthCenter` from `new Vector3(0, -wgs84.RADIUS, 0)` to `new Vector3(0, 0, 0)` in:
1. `src/js/map33/material/TerrainDayNightMaterial.js` — terrain tile day/night shading
2. `src/js/map33/material/DayNightStandardMaterial.js` — 3D buildings (Cesium OSM) day/night shading
3. `src/nodes/CNodeSynthClouds.js` — synthetic cloud shading

Removed now-unused `wgs84` imports from the two material files.

**Recurring pattern:** Any hardcoded reference to the old EUS Earth center `(0, -wgs84.RADIUS, 0)` needs to become `(0, 0, 0)` in ECEF. Search for `-wgs84.RADIUS` or `-Globals.equatorRadius` to find remaining instances.

### 12. Flare Band Globe Center (`src/nodes/CNodeDisplayGlobeCircle.js`)

**Problem:** The specular flare band circles (indicating where satellite glints are visible) were drawn around the wrong center.

**Root cause:** `globeCenter` was hardcoded to `V3(0, -Globals.equatorRadius, 0)` (old EUS Earth center).

**Fix:** Changed to `V3(0, 0, 0)`.

### 13. Satellite Collision Spheres — Flare and Visibility Checks

**Problem:** After fixing the Earth collision sphere centers to `(0, 0, 0)`, no satellite specular flares were detected. Satellites were correctly identified as sunlit, but the flare code path was never reached.

**Root cause:** The old EUS collision spheres used `center = (0, -R_equatorial, 0)` with `radius = R_polar`. Since `R_equatorial` exceeds `R_polar` by ~21 km, the camera at the surface origin was ~21 km **outside** the collision sphere. Rays from the camera to above-horizon satellites could miss the sphere, correctly returning "not occluded."

After changing the center to `(0, 0, 0)` with `radius = R_equatorial`, the camera on the Earth's surface sits at distance `R_equatorial` from the center — exactly **on** the sphere surface. The `intersectSphere2` function always finds a grazing intersection at `t ≈ 0`, returning `true` ("below horizon") for every satellite, so the specular reflection code is never executed.

**Fix (patch):** Changed the collision sphere radius back to `wgs84.POLAR_RADIUS` in three files, restoring the ~21 km margin that keeps surface cameras outside the sphere:
1. `src/nodes/CNodeDisplayNightSky.js` — flare detection and satellite sun/shadow checks
2. `src/nodes/CNodeViewEphemeris.js` — eclipse/shadow calculations
3. `src/nodes/CNodeDisplaySkyOverlay.js` — star and satellite name visibility checks

**Note:** This is a workaround, not a precise fix. Using `POLAR_RADIUS` means the collision sphere is smaller than the actual Earth at the equator, so satellites that are genuinely occluded by the equatorial bulge (up to ~21 km of terrain) may incorrectly pass the visibility check for cameras near the surface. **TODO:** Implement a more accurate occlusion test — e.g., nudge the ray origin slightly outward along the local radial before testing, or use an ellipsoidal intersection test, to correctly handle cameras at any latitude without a fixed radius mismatch.

### 14. Legacy EUS `initialPoints` Conversion (`src/LLA-ECEF-ENU.js`, `src/PointEditor.js`, `src/SplineEditor.js`, `src/nodes/CNodeSplineEdit.js`, `src/SituationSetup.js`)

**Problem:** Several sitches (e.g., SitAguadilla) define spline control points via `initialPoints` arrays containing hardcoded EUS coordinates. These coordinates were calculated relative to the old EUS local tangent plane at `Sit.lat/Sit.lon` on a spherical Earth (radius = `wgs84.RADIUS`). In ECEF, these coordinates are meaningless — they need to be converted.

**Root cause:** The old EUS frame was a rotated, translated local frame. A point like `[frame, x, y, z]` in old EUS represented a specific geographic location relative to the sitch origin. Loading these raw values as ECEF positions places them in completely wrong locations.

**Fix:** Added a `legacyEUS` flag that triggers conversion of old EUS points to ECEF via a 4-step chain:

1. **EUS → ENU**: Axis swap `(x, y, z) → (x, -z, y)` — EUS is East-Up-South, ENU is East-North-Up
2. **ENU → spherical ECEF**: Using `ENU2ECEF()` with `wgs84.RADIUS` (the spherical model the old points were defined on)
3. **Spherical ECEF → LLA**: Using `ECEFToLLA_Sphere()` to get geographic coordinates
4. **LLA → ellipsoidal ECEF**: Using `LLAToEUSRadians()` (which now produces ECEF) on the WGS84 ellipsoid

This chain is important because the old points were defined on a sphere, but the new ECEF system uses the WGS84 ellipsoid. Going through LLA ensures the points end up at the correct geographic locations on the ellipsoid.

New function `legacyEUSToECEF(eus, lat, lon)` in `LLA-ECEF-ENU.js` implements this chain.

**Threading the flag:**
- `SituationSetup.js` sets `legacyEUS: true` when a sitch provides `initialPoints` (not `initialPointsLLA`)
- `CNodeSplineEdit.js` passes `v.legacyEUS` to `SplineEditor`
- `SplineEditor.js` passes it through to `PointEditor`
- `PointEditor.js` constructor detects `legacyEUS` and converts all points before loading

### 15. Camera-at-Origin Crash Guard (`src/CelestialMath.js`)

**Problem:** SitAguadilla crashed with `astronomy.js VerifyNumber` error on startup.

**Root cause:** `getCelestialDirection()` receives a camera position to compute observer-dependent celestial directions. During startup, the camera position is `(0, 0, 0)` (center of Earth) before the spline track positions it. In old EUS, `(0, 0, 0)` was a valid surface position. In ECEF, `EUSToLLA(V3(0,0,0))` produces NaN (can't compute latitude/longitude of the origin), which crashes `astronomy-engine`'s input validation.

**Fix:** Added a guard: only use the provided position if `pos.lengthSq() > 1e12` (camera must be at least ~1000 km from origin, well above the surface). Otherwise fall back to `V3(Sit.lat, Sit.lon, 0)` — the sitch's nominal location. This is accurate enough for celestial directions (the Sun's direction varies by <0.01° across Earth's surface).

### 16. Gimbal Sitch Y-up Assumptions (multiple files)

**Problem:** SitGimbal crashed with NaN positions in `LOSHorizonDisplay` at frame 0 and had several hardcoded Y-up assumptions throughout the Gimbal-specific code path.

**Root cause and fixes:**

1. **`calcHorizonPoint` in `SphericalMath.js`**: Had `pos.y += earthRadius` to shift from old EUS (surface-origin) to Earth-center. In ECEF, positions are already Earth-centered. Adding earthRadius to the Y component of an ECEF position produced a point *inside* the Earth, making `altAboveSphere` negative and `sqrt(negative)` = NaN. **Fix:** Removed the `pos.y += earthRadius` line.

2. **`CNodeLOSTraverseConstantAltitude.js`**: Three instances of `V3(0, -earthRadius, 0)` as the Earth center (old EUS). **Fix:** Changed all to `V3(0, 0, 0)`.

3. **`CNodeLOSTraverseStraightLine.js`**: Two classes used `V3(0, 1, 0)` as global up and `V3(0, 0, -1)` as initial forward for heading calculations. **Fix:** Changed to use `getLocalUpVector(position)` and `getLocalNorthVector(position).negate()`.

4. **`CNodeTraverseAngularSpeed.js`**: Four instances of `.y = 0` to project onto horizontal plane. **Fix:** Replaced with `projectHorizontal()` helper that removes the component along `getLocalUpVector()`.

5. **`CNodeTrackSpeed` in `CNodeJetTrack.js`**: `move.y = 0` for horizontal speed. **Fix:** Replaced with removal of vertical component using `getLocalUpVector()`.

6. **`CNodeFleeter.js`**: Heading computed with `Math.atan2(gv.z, gv.x)`, offsets added to x/y/z directly, turn axis `V3(0,1,0)`. **Fix:** Heading computed by projecting velocity onto local east/north. Offsets applied via local tangent basis vectors. Turn axis set to `getLocalUpVector(pos)`.

7. **`JetStuff.js` LocalFrame rotation**: `V3(0, 1, 0)` as up axis. **Fix:** Changed to `getLocalUpVector(jet)`. Note: the orientation is subsequently corrected by an orthogonalization step that already uses `getLocalUpVector()`.

### 17. Auto-detect legacyEUS in CNodeSplineEdit (`src/nodes/CNodeSplineEdit.js`)

**Problem:** SitAguadilla spline points were loaded as raw ECEF (near the Earth's center) because `legacyEUS` was not being passed when sitches construct `CNodeSplineEditor` directly (outside `SituationSetup.js`).

**Fix:** `CNodeSplineEdit.js` now auto-detects: `legacyEUS = v.legacyEUS ?? (v.initialPoints !== undefined && v.initialPointsLLA === undefined)`. This covers both data-driven sitches (via SituationSetup) and code-driven sitches (like SitAguadilla) without requiring explicit `legacyEUS: true`.

## Concerns and Known Issues

- **Camera up vector:** Three.js cameras default to Y-up. In ECEF, "up" is the radial direction which varies by position. The code already computes `getLocalUpVector()` per-position, so this should be handled, but any code assuming Y=up will break.
- **Hardcoded EUS coordinates:** Any sitch or code using hardcoded EUS position values (like `startCameraPosition: [0, 130000, 160000]`) will be wrong in ECEF. These need to be converted to LLA-based equivalents.
- **`earthCenterEUS()`:** Now returns `V3(0,0,0)` instead of `V3(0, -radius, 0)`. Any code using this for geometry (e.g., raycasting spheres) should still work since the ECEF origin IS the Earth's center.
- **`ECEF2ENU` / `ENU2ECEF`:** These lower-level functions (with explicit lat/lon/radius params) were NOT changed. They're used in LOS calculations with specific reference points and are independent of the Sit origin. May need review if they interact with EUS-space results.

### 18. CNodeTurnRateFromClouds Internal Jet Simulation (`src/nodes/CNodeTurnRateFromClouds.js`)

This node runs an internal mini jet simulation to compute turn rates that match observed cloud angular speeds. The simulation was entirely in old EUS coordinates:

- **Jet position:** `V3(0, altitude, 0)` → `RLLAToECEF(Sit.lat, Sit.lon, altitude)` — old EUS put Y=altitude above surface at origin; in ECEF that's ~7620m from origin (inside the Earth), producing garbage from `getLocalUpVector()`.
- **Jet forward:** `V3(0, 0, -1)` → `getLocalNorthVector(jetPos)` — old EUS north direction, meaningless in ECEF.
- **Horizontal angle:** `atan2(from.z, from.x)` → project onto local tangent plane basis vectors (east, north) computed from `getLocalUpVector`/`getLocalNorthVector`/cross product for east. Old EUS horizontal plane angle (X=East, Z=South) is invalid in ECEF.

These initial fixes got the code running, but the cloud speed readback (green line) showed ~55% of the expected value (red line). See fix #31 for the full resolution.

### 19. calcHorizonPoint Equatorial Radius Mismatch (`src/SphericalMath.js`)

`calcHorizonPoint` used `Globals.equatorRadius` (6378 km) to compute the horizon sphere radius. In ECEF with WGS84 ellipsoidal positions, the geocentric distance at non-equatorial latitudes is less than equatorial radius (e.g. ~6373 km at lat 28.5°). This caused `altAboveSphere = A.length() - (equatorialRadius + cloudAlt)` to go negative, producing `sqrt(negative) = NaN`.

**Fix:** Use `ECEFToLLA()` to get the actual geodetic altitude of the observer position, then derive the local geocentric surface radius as `A.length() - geodeticAlt`. The horizon sphere radius is then `localSurfaceRadius + horizonAlt`, which is consistent regardless of latitude. This affects all callers of `calcHorizonPoint` including `CNodeLOSHorizonTrack` and `CNodeTurnRateFromClouds`.

### 20. CNodeDisplayLOS Sea Level Clipping (`src/nodes/CNodeDisplayLOS.js`)

The sea level clipping check used `fwd.y < 0` to detect if the LOS was pointing downward. In ECEF, the Y component has no relation to "down".

**Fix:** `fwd.dot(getLocalUpVector(A)) < 0` — project onto local geodetic up vector.

### 21. CNodeGimbalTriangulate Sea Level Clipping (`src/nodes/CNodeGimbalTriangulate.js`)

Same `fwd.y < 0` issue as CNodeDisplayLOS.

**Fix:** `fwd.dot(getLocalUpVector(start)) < 0`

### 22. LocalFrame Orientation (`src/JetStuff.js`)

LocalFrame quaternion was set by starting from identity (ECEF world axes) and rotating around the local up axis. But identity quaternion in ECEF means X/Y/Z align with ECEF axes, not the local tangent plane.

**Fix:** Build an explicit local tangent frame: East→X, Up→Y, (-North)→Z, then apply heading rotation around the Y (up) axis, and set quaternion from the resulting basis matrix.

### 23. CameraControls Drag Plane and Tilt Check (`src/js/CameraControls.js`)

Two Y-up assumptions:
- **Drag plane** (line ~1044): `new Plane(V3(0, -1, 0), target.y)` used a flat Y=0 world plane. In ECEF the surface is a sphere, not a flat plane.
- **Tilt check** (line ~1011): `yAxis.y <= 0.01` checked if the camera's Y-axis was nearly horizontal. In ECEF the Y component is meaningless.

**Fix:**
- Drag plane: use `getLocalUpVector(target)` as the plane normal, with distance `localUp.dot(target)`.
- Tilt check: use `yAxis.dot(getLocalUpVector(camera.position)) <= 0.01`.

### 24. Pod Camera Positioning (`src/JetStuff.js`)

Pod camera position used `LocalFrame.position.y` as an altitude component. In ECEF, `.y` is one axis of the Earth-centered coordinate system, not altitude.

**Fix:** Position the pod camera using local tangent vectors (east, up, north) offset from `LocalFrame.position`. Set `camera.up` to the local up vector.

### 25. Pod View Orbit Controls (`src/JetStuff.js`)

Orbit controls position and target used `new Vector3(10, LocalFrame.position.y, 0)` and `new Vector3(0, LocalFrame.position.y, 0)` — ECEF Y component as altitude.

**Fix:** Use `LocalFrame.position.clone()` as target and offset by local east vector for position.

### 26. updateLockTrack Y-Up Rotation Axis (`src/updateLockTrack.js`)

Camera lock-tracking rotated around `V3(0, 1, 0)` when following heading changes. In ECEF, Y is not up.

**Fix:** Use `getLocalUpVector(lockPos)` as the rotation axis.

### 27. trackHeading World-Axis Heading (`src/trackUtils.js`)

`trackHeading()` computed heading as `atan2(fwd.x, -fwd.z)` — using ECEF X and Z as east/south. In ECEF these axes have no relation to compass directions.

**Fix:** Project forward vector onto local tangent plane (remove component along `getLocalUpVector`), then compute heading from `atan2(fwdH.dot(localEast), fwdH.dot(localNorth))`.

### 28. Ground Grid Parenting (`src/JetStuff.js`)

The GridHelperWorld was added to `GlobalScene` (ECEF origin = Earth's center). Its vertices are computed in local flat-plane coordinates with Y=up and origin at the surface. In ECEF, these vertices end up near Earth's center.

**Fix:** Add the grid to `LocalFrame` instead of `GlobalScene`. LocalFrame is oriented with Y=local-up and positioned at the jet's ECEF location, matching the grid's local coordinate system.

### 29. Cloud Display Parenting (`src/Clouds.js`)

Same issue as the ground grid — `CNodeDisplayClouds` was added to `GlobalScene` by default. Cloud geometry is generated in local EUS-style coordinates with Y=altitude above surface.

**Fix:** Set `container: LocalFrame` so clouds are parented to the jet's local frame.

### 30. CNodeTraverseAngularSpeed Direction Sign (`src/nodes/CNodeTraverseAngularSpeed.js`)

`clockwiseZX()` used world Z and X components to determine angular direction sign — meaningless in ECEF.

**Fix:** Use cross product of the view direction and step vector, projected onto local up vector, to determine the sign.

### 31. Cloud Speed Round-Trip Mismatch (`src/nodes/CNodeTurnRateFromClouds.js`, `src/sitch/SitGimbal.js`)

**Problem:** After the initial ECEF fixes (#18, #30), the cloud speed readback (green line from `CNodeTraverseAngularSpeed`) showed ~55% of the expected value (red line from `cloudSpeedEditor`). The sign was correct but the magnitude was consistently wrong across all frames.

**Root cause:** `CNodeTurnRateFromClouds` (TRC) and `CNodeTraverseAngularSpeed` (TAS) used fundamentally different angle measurement methods:

- **TRC** used `atan2` of projected direction vectors from **two different observer positions** (frame f and f+1) to the same horizon point. This measured the parallax angle including the position-dependent viewing direction change.
- **TAS** used `asin(perpStep/offset)` from a **single observer position**, measuring the angular subtense of the horizon point's motion.

In the old flat-plane EUS system, both methods gave equivalent results because after projecting to Y=0, the 2D geometry was identical. In ECEF, the 3D geometry makes them diverge — `atan2` from different 3D positions gives a different angular change than `asin` from one position.

Additionally, TRC's internal jet simulation did not match `CNodeJetTrack`'s behavior:
- TRC started at heading 0° (north); the actual jet starts at 315°
- TRC had no wind; `CNodeJetTrack` includes 120-knot local wind
- TRC used `RLLAToECEF_radii(Sit.lat, Sit.lon, altitude)` as origin; `CNodeJetTrack` uses `jetOrigin`

**Fix — complete rewrite of CNodeTurnRateFromClouds:**

1. **Same measurement formula as TAS:** Replaced the `atan2` parallax method with the identical `asin(perpStep/offset)` formula that TAS uses. Both nodes now measure angular speed the same way, ensuring the round trip is mathematically closed.

2. **Matching internal simulation:** Added `wind`, `heading`, and `origin` inputs (same as CNodeJetTrack). The internal jet sim now uses the same starting position, heading, and wind as the actual jet track. Removed the unused `altitude` input.

3. **Cloud wind in step computation:** Added `cloudWind` input (same node TAS uses). TAS computes `step = horizon(f) - (horizon(f-1) + cloudWind)`, subtracting cloud drift from the horizon motion. TRC now does the same, ensuring both sides account for cloud wind identically.

4. **Multi-pass convergence:** Single-pass computation caused frame-to-frame oscillation because the turn rate at frame f immediately affects the geometry measured at frame f. The fix uses 10 full passes over the entire frame range: each pass simulates the complete trajectory with the current turn rate array, measures what TAS would read back, and adjusts each frame's turn rate by the error. This converges to a stable, smooth turn rate array.

5. **Node ordering in SitGimbal.js:** Moved `localWind`, `cloudWind`, and `initialHeading` creation before `CNodeTurnRateFromClouds` so the string-based input references resolve correctly (inputs are resolved eagerly during construction).

**Result:** Green/red ratio improved from ~0.554 to ~1.001 across all frames (~0.1% residual error).

### 32. Earth/Moon Shadow Earth-Center Assumptions (`src/nodes/CNodeDisplayEarthShadow.js`, `src/nodes/CNodeDisplayMoonShadow.js`)

**Problem:** Eclipse/shadow visuals still had old-frame assumptions mixed in. In old EUS, many calculations were written around an Earth center offset from the local origin. In ECEF, Earth center must always be `(0, 0, 0)`.

**Fix:**
- `CNodeDisplayEarthShadow` now explicitly builds shadow geometry from `globeCenter = V3(0, 0, 0)`.
- `CNodeDisplayMoonShadow` now treats Earth center as origin in its fallback sphere math, and uses Earth radii from globals for consistency with the current earth model.

This removed residual origin-offset behavior from both shadow display nodes.

### 33. Geocentric Sun/Moon Vectors for Eclipse Geometry (`src/CelestialMath.js`, `src/nodes/CNodeDisplayNightSky.js`)

**Problem:** The moon shadow path was offset (notably north/south) because eclipse geometry used observer-relative/topocentric celestial directions. That is fine for local sky viewing but wrong for global umbra placement on Earth.

**Fix:** Added geocentric body position helpers in `CelestialMath.js`:
- `getGeocentricBodyPositionEUS(body, date, aberration=true)`
- `getGeocentricBodyDirectionEUS(body, date, aberration=true)`

Implementation uses `Astronomy.GeoVector` (geocentric), rotates EQJ→EQD, applies sidereal rotation into Earth-fixed coordinates, then returns EUS/ECEF coordinates.

`CNodeDisplayNightSky` now stores eclipse inputs from these geocentric vectors:
- `Globals.sunPos`, `Globals.toSun`, `Globals.fromSun`
- `Globals.moonPos`, `Globals.toMoon`, `Globals.fromMoon`

This fixed the eclipse center position drift caused by topocentric parallax.

### 34. Moon Umbra Size Too Small (~50%) (`src/nodes/CNodeDisplayMoonShadow.js`)

**Problem:** After center-position fixes, the umbra footprint remained about half expected size.

**Root cause:** `sunMoonDistance` was derived from a fixed `1 AU` Sun proxy (`toSun * 149597870700`) instead of the actual Sun-Moon distance at the current frame. Near the umbra tip, even a small distance error strongly changes computed umbra diameter.

**Fix:**
- Use actual frame Sun position: `Globals.sunPos.distanceTo(moonCenter)` for `sunMoonDistance` (with fallback only if `sunPos` is unavailable).
- Use ellipsoid intersection for the shadow axis reference distance (`intersectEllipsoid`) and for footprint rays, keeping the cone/footprint tied to the active Earth model.

Result: umbra center remains correct and footprint size matches expected eclipse scale.
