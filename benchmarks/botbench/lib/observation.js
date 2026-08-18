// observation.js — clean sightlines, pointing error (white / wobble), FOV
// masking, and realized-noise statistics (PLAN.md "observation" schema).
//
// Pointing error is applied in the clean LOS's local pan/tilt tangent basis —
// matching the wobble controller's semantics — via an exact small-rotation:
// rotate the clean direction by angle alpha = hypot(pan, tilt) toward the
// in-plane offset direction. White noise is an isotropic tangent-plane
// Gaussian (Box-Muller over the observation stream), NOT the balloon test's
// component-perturbation construction (rejected in review as non-isotropic).
//
// matched-white pairing: the wobble member's realized RMS is measured after
// generation; the paired white member receives that value in its spec
// (matchedRealizedRmsDeg) and rescales its own unit draw by ONE scalar so its
// realized all-frames RMS matches exactly (PLAN.md, MATCHED-NOISE).

import {generateWobbleOffsets} from "../../../src/TrackingWobbleMath";
import {makeStream} from "./rng";

const DEG = Math.PI / 180;

// Build clean unit directions platform->target (track truth) or copy the
// truth directions (direction truth).
export function cleanDirections(platformPositionENU, target, n) {
    const out = new Float64Array(n * 3);
    if (target.kind === "direction") {
        out.set(target.directionENU);
        return out;
    }
    for (let f = 0; f < n; f++) {
        const b = f * 3;
        const dx = target.positionENU[b] - platformPositionENU[b];
        const dy = target.positionENU[b + 1] - platformPositionENU[b + 1];
        const dz = target.positionENU[b + 2] - platformPositionENU[b + 2];
        const L = Math.hypot(dx, dy, dz) || 1;
        out[b] = dx / L;
        out[b + 1] = dy / L;
        out[b + 2] = dz / L;
    }
    return out;
}

// Local pan/tilt tangent basis for a unit direction d: pan axis t1 is
// horizontal-ish (perp to world-up and d), tilt axis t2 completes the triad.
function tangentBasis(dx, dy, dz) {
    let t1x = -dy, t1y = dx, t1z = 0;                  // up x d, up = [0,0,1]
    let L = Math.hypot(t1x, t1y, t1z);
    if (L < 1e-6) { t1x = 1; t1y = 0; t1z = 0; L = 1; } // looking straight up/down
    t1x /= L; t1y /= L; t1z /= L;
    const t2x = dy * t1z - dz * t1y;
    const t2y = dz * t1x - dx * t1z;
    const t2z = dx * t1y - dy * t1x;
    return [t1x, t1y, t1z, t2x, t2y, t2z];
}

// Rotate clean direction d by the (pan, tilt) offset in degrees; exact
// rotation toward the tangent-plane offset direction.
function applyOffset(out, b, dx, dy, dz, panDeg, tiltDeg) {
    const alpha = Math.hypot(panDeg, tiltDeg) * DEG;
    if (alpha < 1e-12) {
        out[b] = dx; out[b + 1] = dy; out[b + 2] = dz;
        return;
    }
    const [t1x, t1y, t1z, t2x, t2y, t2z] = tangentBasis(dx, dy, dz);
    const inv = 1 / Math.hypot(panDeg, tiltDeg);
    const ux = (t1x * panDeg + t2x * tiltDeg) * inv;
    const uy = (t1y * panDeg + t2y * tiltDeg) * inv;
    const uz = (t1z * panDeg + t2z * tiltDeg) * inv;
    const c = Math.cos(alpha), s = Math.sin(alpha);
    out[b] = dx * c + ux * s;
    out[b + 1] = dy * c + uy * s;
    out[b + 2] = dz * c + uz * s;
}

// Generate the pan/tilt offset series (degrees) for an observation spec.
export function offsetSeries(obsSpec, n, fps, observationSeed) {
    const pan = new Float64Array(n);
    const tilt = new Float64Array(n);
    if (obsSpec.kind === "clean") return {pan, tilt};

    if (obsSpec.kind === "wobble") {
        const w = generateWobbleOffsets({seed: observationSeed, ...obsSpec.wobble}, n, fps);
        for (let f = 0; f < n; f++) {
            pan[f] = w[f].pan;
            tilt[f] = w[f].tilt;
        }
        return {pan, tilt};
    }

    // OPERATOR DRIFT: the tracker slides off the target and never comes back.
    // Distinct from "wobble", which is a seeded random walk that recentres, and
    // from "white", which is zero-mean: this is a SYSTEMATIC, monotone error,
    // the signature of an operator lagging a moving target or a mis-trimmed
    // auto-tracker. It is the error a bearings-only fit is least able to
    // absorb, because it is indistinguishable from the target genuinely
    // drifting — so a set that only ever tested zero-mean noise was not
    // testing the case that matters most.
    //
    // Deterministic by construction: a ramp has no realization to seed, so a
    // drift level is exactly reproducible and the whole ladder shares one truth.
    if (obsSpec.kind === "drift") {
        const total = obsSpec.driftDeg ?? 0;
        // The bearing the slide happens along, in the pan/tilt tangent plane.
        // Fixed rather than random, so two drift levels differ only in size.
        const bearing = (obsSpec.driftBearingDeg ?? 45) * DEG;
        const dPan = Math.cos(bearing), dTilt = Math.sin(bearing);
        for (let f = 0; f < n; f++) {
            // pan/tilt are combined by applyOffset into a rotation of
            // hypot(pan, tilt) degrees, so this ramps the TRUE on-sky angle
            // from 0 to driftDeg — the number in the folder name is the number
            // the analysis sees.
            const reached = n > 1 ? total * (f / (n - 1)) : 0;
            pan[f] = reached * dPan;
            tilt[f] = reached * dTilt;
        }
        return {pan, tilt};
    }

    if (obsSpec.kind === "white") {
        const stream = makeStream(observationSeed);
        // Unit-sigma isotropic draw, then one scalar: either the requested
        // sigma, or (matched mode) the scalar making realized RMS exact.
        let sumSq = 0;
        for (let f = 0; f < n; f++) {
            pan[f] = stream.gaussian();
            tilt[f] = stream.gaussian();
            sumSq += pan[f] * pan[f] + tilt[f] * tilt[f];
        }
        let scale;
        if (obsSpec.matchedRealizedRmsDeg != null) {
            const unitRms = Math.sqrt(sumSq / n);
            scale = unitRms > 0 ? obsSpec.matchedRealizedRmsDeg / unitRms : 0;
        } else {
            scale = obsSpec.gaussianSigmaDeg;
        }
        for (let f = 0; f < n; f++) {
            pan[f] *= scale;
            tilt[f] *= scale;
        }
        return {pan, tilt};
    }

    throw new Error(`botbench: unknown observation kind "${obsSpec.kind}"`);
}

// Assemble the full observation object per the BotScenario schema.
export function generateObservation(obsSpec, cleanDir, n, fps, observationSeed) {
    const {pan, tilt} = offsetSeries(obsSpec, n, fps, observationSeed);
    const observed = new Float64Array(n * 3);
    const tangentErrorDeg = new Float64Array(n * 2);
    const angularErrorDeg = new Float64Array(n);
    const inFov = new Uint8Array(n);
    const excluded = new Set();
    const halfFov = obsSpec.fovFullDeg / 2;

    let sumSqAll = 0, sumAll = 0, maxAll = 0, sumSqActive = 0, activeCount = 0;
    for (let f = 0; f < n; f++) {
        const b = f * 3;
        applyOffset(observed, b, cleanDir[b], cleanDir[b + 1], cleanDir[b + 2], pan[f], tilt[f]);
        tangentErrorDeg[f * 2] = pan[f];
        tangentErrorDeg[f * 2 + 1] = tilt[f];
        const err = Math.hypot(pan[f], tilt[f]);
        angularErrorDeg[f] = err;
        sumSqAll += err * err;
        sumAll += err;
        if (err > maxAll) maxAll = err;
        if (err <= halfFov) {
            inFov[f] = 1;
            sumSqActive += err * err;
            activeCount++;
        } else {
            excluded.add(f);
        }
    }

    return {
        cleanDirectionENU: cleanDir,
        observedDirectionENU: observed,
        tangentErrorDeg,
        angularErrorDeg,
        inFov,
        excluded,
        fovFullDeg: obsSpec.fovFullDeg,
        outOfFrameCount: excluded.size,
        outOfFrameFraction: excluded.size / n,
        realizedRmsDegAllFrames: Math.sqrt(sumSqAll / n),
        realizedRmsDegActiveFrames: activeCount ? Math.sqrt(sumSqActive / activeCount) : 0,
        realizedMeanDeg: sumAll / n,
        realizedMaxDeg: maxAll,
    };
}
