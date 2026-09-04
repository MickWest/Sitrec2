# EUS/ECEF Follow-Up Status

**Status: completed.** This file is retained as the disposition record for the
post-implementation review. The coordinate-system design and user-facing Earth-model
contract live in [GIS Concepts in Sitrec](docs/GIS.md); this is not an active plan.

## Resolved findings

1. **A valid zero-metre MSL OSD altitude was treated as missing.**
   `CNodeOSDDataSeriesTrack` now tests whether an altitude sample exists, independently of
   its numeric value, before applying the EGM96 MSL-to-HAE offset. Focused tests cover zero
   MSL, missing altitude, and an already-HAE value.
2. **The ellipsoid-aware ENU helpers lacked direct inverse coverage.**
   `tests/LLA-ECEF-ENU.test.js` now checks a non-equatorial origin, a tight
   ECEF→ENU→ECEF round trip, and reversible `justRotate` behavior with the ellipsoid active.
3. **The LOS CSV reverse check compared rows with frames starting at zero.**
   Export now records the exact source frame for each emitted row. The reverse check uses
   that list, so a nonzero `Sit.aFrame` and skipped incomplete frames cannot shift the
   comparison.
4. **LOS export needed coverage under both Earth models.**
   `tests/CNodeLOSExport.test.js` exercises position and heading reconstruction in sphere
   and ellipsoid modes, including a non-contiguous exported frame list.
5. **The runtime Earth-model rebuild contract was unclear.**
   `updateEarthRadii()` recalculates the node graph and refreshes terrain. Editable splines
   sourced from LLA or legacy local coordinates retain LLA control points for reprojection;
   raw ECEF values remain Cartesian. The same contract is now documented in `docs/GIS.md`.

## Focused verification

```bash
npx jest tests/LLA-ECEF-ENU.test.js tests/CNodeOSDDataSeriesTrack.test.js tests/CNodeLOSExport.test.js --runInBand
```
