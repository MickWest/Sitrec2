# EUS/ECEF Follow-Up Plan (Post-Implementation Review)

## Scope
This plan covers only remaining gaps found after reviewing the implemented EUS/ECEF, sphere/ellipsoid, and EGM96 changes.

## Remaining Issues

### 1) OSD altitude conversion skips valid zero-MSL altitudes
**File:** `src/nodes/CNodeOSDDataSeriesTrack.js`  
Current code applies geoid offset only when `alt !== 0`.  
That incorrectly treats true `0 m MSL` values as if they were already HAE.

**Action**
1. Convert MSL->HAE when altitude data exists for the frame (`altArr[f] !== null`), not when `alt !== 0`.
2. Keep "missing altitude" behavior unchanged.

**Acceptance**
1. A frame with altitude exactly `0 m MSL` still gets geoid offset applied.
2. Frames with missing altitude do not get synthetic geoid offset added.

### 2) Add tests for new ellipsoid ENU helpers
**File:** `tests/LLA-ECEF-ENU.test.js`

**Action**
1. Add tests for `ECEF2ENU_radii` and `ENU2ECEF_radii` inverse behavior.
2. Add origin test at non-equatorial latitude in ellipsoid mode.
3. Add `justRotate` parity tests vs existing behavior.

**Acceptance**
1. Round-trip `ECEF -> ENU_radii -> ECEF` stays within tight tolerance.
2. Tests fail if helper origin math regresses back to spherical-only behavior.

### 3) Harden LOS export reverse-check indexing
**File:** `src/nodes/CNodeLOS.js`

**Action**
1. In `testReverseExport`, map CSV row index back to exported frame index (`Sit.aFrame` offset) before `getValueFrame`.
2. Remove unused local `mENU2ECEF_Origin` in `exportLOSCSV` setup (cleanup).

**Acceptance**
1. Reverse-check compares against the correct source frame range when `aFrame != 0`.

### 4) Add regression test coverage for LOS export in ellipsoid mode
**Files:** `tests/` (new test file or extension of existing LOS tests)

**Action**
1. Add a deterministic LOS fixture with known position+heading.
2. Validate export->reverse path under sphere and ellipsoid radii.

**Acceptance**
1. Position and heading errors stay within thresholds in both Earth modes.

### 5) Complete (or consciously defer) Earth-model-change rebuild contract
**Files:** node-level cache/reprojection surfaces (`CNodeArray`, `CNodeSplineEdit`, any other cached EUS producers)

**Action**
1. Decide whether to add explicit `earthModelChanged` event now.
2. If deferred, document current guarantees and known limits.

**Acceptance**
1. Clear documented contract exists for what does/does not reproject on Earth-model toggle.

## Recommended Order
1. Fix OSD zero-altitude conversion condition.
2. Add ENU_radii unit tests.
3. Fix LOS reverse-check frame indexing.
4. Add LOS export regression tests.
5. Finalize Earth-model-change contract decision.
