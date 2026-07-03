/**
 * TraverseAnalysisData.js — build TraverseAnalysis datasets from sitrec nodes.
 *
 * Node-graph glue for the pure-math TraverseAnalysis.js: packs an LOS node
 * (and optionally a wind node) into flat ENU arrays, and unpacks result
 * tracks back to ECEF {position} arrays for display nodes.
 *
 * Kept separate from TraverseAnalysis.js so the math core stays dependency-
 * free and unit-testable without the node graph or three.js.
 */

import {Vector3} from "three";
import {ECEF2ENU_radii, ECEFToLLA_radii, ENU2ECEF_radii} from "./LLA-ECEF-ENU";
import {Sit} from "./Globals";

/**
 * Pack an LOS node into a TraverseAnalysis dataset (local ENU frame at the
 * mean sensor position).
 *
 * @param losNode  node returning {position (ECEF m), heading (unit ECEF)} per frame
 * @param windNode optional CNodeWind; sampled per frame with its position
 *                 anchored along the LOS at anchorDist so the meteorological
 *                 "from" rotation happens around a real local-up
 * @param anchorDist meters along each ray for the wind anchor (default 20 NM)
 * @returns {dataset, originLat, originLon} — dataset per TraverseAnalysis.js,
 *          origin in radians for unpackTrackToECEF
 */
export function buildAnalysisDataset(losNode, windNode = null, anchorDist = 37040, options = {}) {
    const frame0 = Math.max(0, Math.min(losNode.frames - 1, Math.round(options.frame0 ?? 0)));
    const frame1 = Math.max(frame0, Math.min(losNode.frames - 1, Math.round(options.frame1 ?? (losNode.frames - 1))));
    const n = frame1 - frame0 + 1;
    const fps = Sit.fps;

    let meanX = 0, meanY = 0, meanZ = 0;
    for (let f = frame0; f <= frame1; f++) {
        const los = losNode.v(f);
        meanX += los.position.x;
        meanY += los.position.y;
        meanZ += los.position.z;
    }
    meanX /= n; meanY /= n; meanZ /= n;

    const originLLA = ECEFToLLA_radii(meanX, meanY, meanZ);
    const originLat = originLLA[0];
    const originLon = originLLA[1];

    const S = new Float64Array(n * 3);
    const D = new Float64Array(n * 3);
    const W = new Float64Array(n * 3);
    const anchor = new Vector3();

    for (let f = 0; f < n; f++) {
        const sourceFrame = frame0 + f;
        const los = losNode.v(sourceFrame);
        const posENU = ECEF2ENU_radii(los.position, originLat, originLon);
        S[f * 3] = posENU.x; S[f * 3 + 1] = posENU.y; S[f * 3 + 2] = posENU.z;

        const heading = los.heading;
        const hLen = Math.hypot(heading.x, heading.y, heading.z) || 1;
        const dirENU = ECEF2ENU_radii(los.heading, originLat, originLon, true);
        D[f * 3] = dirENU.x / hLen; D[f * 3 + 1] = dirENU.y / hLen; D[f * 3 + 2] = dirENU.z / hLen;

        if (windNode) {
            anchor.set(
                los.position.x + heading.x / hLen * anchorDist,
                los.position.y + heading.y / hLen * anchorDist,
                los.position.z + heading.z / hLen * anchorDist,
            );
            windNode.setPosition(anchor);
            const w = windNode.v(sourceFrame);   // per-frame displacement, ECEF meters
            const wENU = ECEF2ENU_radii(w, originLat, originLon, true);
            W[f * 3] = wENU.x; W[f * 3 + 1] = wENU.y; W[f * 3 + 2] = wENU.z;
        }
    }

    return {
        dataset: {n, fps, S, D, W, frame0, frame1},
        originLat,
        originLon,
    };
}

/**
 * Unpack a Float64Array(n*3) ENU track into an array of {position: Vector3}
 * in ECEF, suitable for a CNodeTrack-style array.
 */
export function unpackTrackToECEF(track, n, originLat, originLon) {
    const result = [];
    const enu = new Vector3();
    for (let f = 0; f < n; f++) {
        enu.set(track[f * 3], track[f * 3 + 1], track[f * 3 + 2]);
        result.push({position: ENU2ECEF_radii(enu, originLat, originLon)});
    }
    return result;
}
