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
    // Effective frames per REAL second: at simSpeed 10 each video frame spans
    // 10/fps seconds of physical time, so speeds/accelerations derived from
    // per-frame deltas must use fps/simSpeed. (Previously simSpeed was ignored
    // and a 10x-speed sitch reported 10x the true speeds.)
    const simSpeed = Sit.simSpeed ?? 1;
    const fps = Sit.fps / simSpeed;

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
            // Historical physical per-frame wind where available (track-driven winds):
            // windVectorAt is a pure sampler; the legacy path (setPosition +
            // v(f)) ignores the frame and repeats the playhead wind. CNodeWind
            // returns physical displacement for one simulation frame, already
            // scaled by simSpeed/fps.
            let w;
            if (typeof windNode.windVectorAt === "function") {
                w = windNode.windVectorAt(sourceFrame, anchor);
            } else {
                windNode.setPosition(anchor);
                w = windNode.v(sourceFrame);   // per-frame displacement, ECEF meters
            }
            const wENU = ECEF2ENU_radii(w, originLat, originLon, true);
            W[f * 3] = wENU.x;
            W[f * 3 + 1] = wENU.y;
            W[f * 3 + 2] = wENU.z;
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

/**
 * The In/Out (A-B) frame window, clamped to [0, totalFrames-1]. Single
 * authority shared by the traverse-analysis gallery and every live LOS fit
 * method, so a fit applied from the gallery reproduces the same window.
 * Unset/invalid In/Out points fall back to the full clip.
 */
export function abFrameRange(totalFrames, minCount = 8) {
    const maxFrame = Math.max(0, (totalFrames ?? 1) - 1);
    const hasA = Number.isFinite(Sit.aFrame);
    const hasB = Number.isFinite(Sit.bFrame);
    let frame0 = hasA ? Math.round(Sit.aFrame) : 0;
    let frame1 = hasB ? Math.round(Sit.bFrame) : maxFrame;
    frame0 = Math.max(0, Math.min(maxFrame, frame0));
    frame1 = Math.max(0, Math.min(maxFrame, frame1));
    if (frame1 < frame0) {
        const t = frame0;
        frame0 = frame1;
        frame1 = t;
    }
    // A degenerate window (a frame or two — e.g. In/Out set at the same frame)
    // can't support any fit: least-squares matrices go singular and tracks
    // collapse. Fall back to the full clip rather than producing garbage.
    // (Callers that want to handle short windows themselves pass minCount 1 —
    // the analysis shows its own "not enough frames" error.)
    if (frame1 - frame0 + 1 < minCount && totalFrames >= minCount) {
        return {frame0: 0, frame1: maxFrame, count: maxFrame + 1};
    }
    return {frame0, frame1, count: frame1 - frame0 + 1};
}

// A millimetre. Below this the sensor has not moved between two frames, in any
// units any source reports a position in.
const HELD_POS_EPS_M = 1e-3;

/**
 * Trim leading and trailing frames where the SENSOR DOES NOT MOVE, from a
 * window in which it otherwise does.
 *
 * WHY. A track node holds its last sample for every frame past the end of its
 * data, so importing a 20-second clip into a 30-second sitch leaves 10 seconds
 * of a sensor parked at its final position. Nothing rejects those frames and
 * they are not neutral: a third of the residual budget then describes an
 * aircraft that stopped dead in mid-air, and every fit is pulled between the
 * real motion and that fiction. Measured on a synthetic 20 s balloon clip in a
 * 30 s sitch: the held tail moved the balloon fit from 120 m off truth to 888 m
 * and its angular residual from 0.002 degrees to 0.43, with no warning anywhere
 * and an "Unresolved" verdict at the end of it.
 *
 * POSITION ONLY, DELIBERATELY. The obvious rule — "neither the position nor the
 * sightline changes" — does not fire, because the camera-centre LOS keeps
 * rotating through the held tail (measured at 0.015 degrees a frame while the
 * position was frozen to the millimetre). What identifies the tail is the
 * SENSOR standing still, and only that.
 *
 * A FIXED CAMERA IS NOT A HELD TAIL. Its position never changes for the whole
 * clip, and every frame of it is real data. That is why the rule is not "drop
 * motionless frames" but "drop motionless frames at the ENDS of a window that
 * moves somewhere" — if the sensor never moves at all, nothing is trimmed.
 *
 * ONLY THE TRAILING END, and this is a deliberate narrowing. A frozen run means
 * one of two things and position alone cannot tell them apart: frames past the
 * end of the track's data, or a sensor that genuinely stood still. The first is
 * an artefact and the second is data — a vehicle camera parked for the first
 * half of a clip and then driving is real observation, and trimming it would
 * silently drop half the bearings from every fit and every report.
 *
 * What separates them is WHERE they can occur. A track holds its last sample
 * past the END of its data, by construction, so the artefact is always a tail.
 * A genuine stationary period can be anywhere. Trimming only the tail therefore
 * removes the artefact and leaves a parked start alone; a parked FINISH is the
 * one case still lost, and it costs bearings taken from a fixed point, which is
 * the geometry that contributes least to a range solution in the first place.
 *
 * An interior hold is never touched: cutting one out would splice two moments
 * together and put a false jump in every velocity.
 *
 * @param losNode  node returning {position, heading} per frame
 * @param range    {frame0, frame1} to trim
 * @param minCount refuse to trim below this many frames
 * @returns {frame0, frame1, count, trimmedStart, trimmedEnd, refusedTrim}
 */
export function trimHeldFrames(losNode, {frame0, frame1}, minCount = 10) {
    const untouched = {frame0, frame1, count: frame1 - frame0 + 1,
        trimmedStart: 0, trimmedEnd: 0, refusedTrim: false};
    // COPY THE NUMBERS OUT. Several LOS nodes return the same cached object on
    // every call, so holding two of them and diffing compares an object with
    // itself — every pair reads as held and the trim eats the clip from the
    // front. (It did: a 900-frame window came back as frames 890-899.)
    const posOf = (f) => {
        const v = losNode.v(f);
        return v?.position ? [v.position.x, v.position.y, v.position.z] : null;
    };
    const still = (a, b) => {
        const pa = posOf(a), pb = posOf(b);
        if (!pa || !pb) return false;
        return Math.hypot(pa[0] - pb[0], pa[1] - pb[1], pa[2] - pb[2]) <= HELD_POS_EPS_M;
    };

    const lo = frame0;
    let hi = frame1;
    // A backstop, not a policy: a window that is mostly motionless is a scene
    // problem, and cutting it down to a sliver would answer a question nobody
    // asked. Hand it over whole and let the analysis report what it found.
    const maxTrim = Math.floor((frame1 - frame0 + 1) / 2);
    while (hi - lo + 1 > minCount && frame1 - hi < maxTrim && still(hi - 1, hi)) hi--;

    const trimmed = frame1 - hi;
    if (!trimmed) return untouched;
    if (trimmed >= maxTrim) return {...untouched, refusedTrim: true};
    return {frame0: lo, frame1: hi, count: hi - lo + 1,
        trimmedStart: 0, trimmedEnd: trimmed, refusedTrim: false};
}

/**
 * Expand a window-fitted {position} array to cover the whole clip: frames
 * before the window hold the window's first position, frames after hold its
 * last (outside the analyzed In/Out range we claim no knowledge of motion).
 * Held positions are clones so no Vector3 is shared across frames.
 */
export function expandWindowedTrack(win, totalFrames, frame0) {
    if (frame0 === 0 && win.length >= totalFrames) return win;
    const result = new Array(totalFrames);
    const first = win[0].position, last = win[win.length - 1].position;
    for (let f = 0; f < totalFrames; f++) {
        if (f < frame0) result[f] = {position: first.clone()};
        else if (f >= frame0 + win.length) result[f] = {position: last.clone()};
        else result[f] = win[f - frame0];
    }
    return result;
}
