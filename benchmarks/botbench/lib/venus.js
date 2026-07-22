// venus.js — direction-kind truth for the Venus target family.
//
// Kept out of targets.js so the astronomy-engine / Globals import chain only
// loads for scenarios that need it. Truth is a PER-FRAME unit direction in
// scenario ENU (Venus drifts ~0.25 deg/min of sidereal motion — comparable to
// a <1 deg FOV over a 120 s clip, and that drift is measured, not hidden).
// No pseudo-track is ever created (PLAN.md, adapter/metrics contract).
//
// getCelestialDirection(body, date, posECEF) returns an ECEF unit Vector3;
// we convert to ENU with the site tangent basis. The observer position is the
// platform's ECEF location (parallax on Venus is negligible but free).

import {Vector3} from "three";
import {getCelestialDirection} from "../../../src/CelestialMath";
import {LLAToECEF} from "../../../src/LLA-ECEF-ENU";
import {enuBasisAt} from "../../../src/TrackExportMath";

export const VENUS_EPOCH_ISO = "2025-02-01T02:00:00Z";

export function generateVenusTruth({site, n, times, platformPositionENU, epochISO = VENUS_EPOCH_ISO}) {
    const epochMs = Date.parse(epochISO);
    const originECEF = LLAToECEF(site.latDeg, site.lonDeg, site.groundElevationMSL);
    const {east, north, up} = enuBasisAt(site.latDeg, site.lonDeg);

    const dir = new Float64Array(n * 3);
    const valid = new Uint8Array(n).fill(1);
    const obs = new Vector3();

    for (let f = 0; f < n; f++) {
        const px = platformPositionENU[f * 3];
        const py = platformPositionENU[f * 3 + 1];
        const pz = platformPositionENU[f * 3 + 2];
        obs.set(
            originECEF.x + east.x * px + north.x * py + up.x * pz,
            originECEF.y + east.y * px + north.y * py + up.y * pz,
            originECEF.z + east.z * px + north.z * py + up.z * pz,
        );
        const d = getCelestialDirection("Venus", new Date(epochMs + times[f] * 1000), obs);
        if (!d) throw new Error("botbench: getCelestialDirection returned null for Venus");
        dir[f * 3] = d.x * east.x + d.y * east.y + d.z * east.z;
        dir[f * 3 + 1] = d.x * north.x + d.y * north.y + d.z * north.z;
        dir[f * 3 + 2] = d.x * up.x + d.y * up.y + d.z * up.z;
    }

    return {
        kind: "direction",
        family: "venus",
        body: "Venus",
        directionENU: dir,
        valid,
        epochMs,
    };
}
