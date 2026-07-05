/**
 * TraverseAnalysis.js — physically-motivated analysis of LOS traversals.
 *
 * Given a set of lines of sight (a moving sensor looking at an unknown object),
 * these tools search for and score *physically plausible* trajectories that are
 * consistent with the LOS data. Fit criteria are deliberately soft "targets"
 * (a preferred speed, roughly level flight, low maneuvering g) rather than
 * exact constraints — LOS-only data never uniquely determines a trajectory,
 * so the interesting output is the FAMILY of plausible solutions and how
 * implausible everything else is.
 *
 * Analyzers:
 *   sweepConstAirSpeed  — grid search over (start distance, speed) for the
 *                         constant-air-speed traverse, scored by smoothness.
 *   traversePlausible   — for a given start range, the smoothest LOS-riding
 *                         trajectory with a soft speed target (spline QP + IRLS).
 *   rangeProfile        — traversePlausible swept over range: how much
 *                         maneuvering does each assumed distance REQUIRE?
 *   fitAircraft         — parametric fixed-wing fit (constant TAS, slowly
 *                         varying turn rate, constant climb, wind advection)
 *                         via differential evolution + pattern-search polish.
 *   trackMetrics        — per-track physical metrics (speeds, g-load, turn
 *                         rate, altitude, range) used for all scoring.
 *
 * Pure math on flat arrays — no three.js, no DOM, no node graph. The caller
 * builds the dataset (see TraverseAnalysisData.js) in a local ENU frame:
 *
 *   dataset = {
 *     n,   // frame count
 *     fps, // frames per second
 *     S,   // Float64Array(n*3) sensor positions, ENU meters [E,N,U]
 *     D,   // Float64Array(n*3) LOS unit directions, ENU
 *     W,   // Float64Array(n*3) wind displacement per FRAME, ENU meters
 *   }
 *
 * All returned tracks are Float64Array(n*3) of ENU positions.
 */

import {differentialEvolution, patternSearchPolish} from "./DifferentialEvolution";

export const KNOTS_TO_MS = 0.514444;
export const METERS_PER_NM = 1852;
const G_ACCEL = 9.81;

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

/**
 * Physical metrics for a candidate track.
 * Velocities are estimated with a central difference over ~smoothFrames so the
 * g-load numbers reflect real maneuvering, not frame-to-frame solver noise.
 * "Air" quantities subtract the cumulative wind drift (i.e. motion through the
 * air mass); heading/turn rate are computed on the air track.
 */
export function trackMetrics(dataset, track, options = {}) {
    const {n, fps, W, S} = dataset;
    const smoothFrames = options.smoothFrames ?? 15;

    const air = new Float64Array(n * 3);
    let cwx = 0, cwy = 0, cwz = 0;
    for (let f = 0; f < n; f++) {
        air[f * 3] = track[f * 3] - cwx;
        air[f * 3 + 1] = track[f * 3 + 1] - cwy;
        air[f * 3 + 2] = track[f * 3 + 2] - cwz;
        cwx += W[f * 3]; cwy += W[f * 3 + 1]; cwz += W[f * 3 + 2];
    }

    const h = Math.max(1, Math.floor(smoothFrames / 2));
    const vel = (arr, f) => {
        const f0 = Math.max(0, f - h), f1 = Math.min(n - 1, f + h);
        const dt = (f1 - f0) / fps;
        return [
            (arr[f1 * 3] - arr[f0 * 3]) / dt,
            (arr[f1 * 3 + 1] - arr[f0 * 3 + 1]) / dt,
            (arr[f1 * 3 + 2] - arr[f0 * 3 + 2]) / dt,
        ];
    };

    const groundSpeed = new Float64Array(n), airSpeed = new Float64Array(n);
    const heading = new Float64Array(n), verticalSpeed = new Float64Array(n);
    const altitude = new Float64Array(n), range = new Float64Array(n);
    for (let f = 0; f < n; f++) {
        const vg = vel(track, f), va = vel(air, f);
        groundSpeed[f] = Math.hypot(vg[0], vg[1], vg[2]);
        airSpeed[f] = Math.hypot(va[0], va[1], va[2]);
        heading[f] = Math.atan2(va[0], va[1]) * 180 / Math.PI;
        verticalSpeed[f] = vg[2];
        altitude[f] = track[f * 3 + 2];
        range[f] = Math.hypot(
            track[f * 3] - S[f * 3],
            track[f * 3 + 1] - S[f * 3 + 1],
            track[f * 3 + 2] - S[f * 3 + 2]);
    }

    // maneuvering g from the change in smoothed air velocity
    const gLoad = new Float64Array(n);
    for (let f = 0; f < n; f++) {
        const f0 = Math.max(0, f - h), f1 = Math.min(n - 1, f + h);
        const dt = (f1 - f0) / fps;
        const v0 = vel(air, f0), v1 = vel(air, f1);
        gLoad[f] = Math.hypot(v1[0] - v0[0], v1[1] - v0[1], v1[2] - v0[2]) / dt / G_ACCEL;
    }

    const turnRate = new Float64Array(n);
    for (let f = 1; f < n; f++) {
        let dh = heading[f] - heading[f - 1];
        while (dh > 180) dh -= 360;
        while (dh < -180) dh += 360;
        turnRate[f] = dh * fps;
    }
    turnRate[0] = turnRate[1];

    const stat = (arr, lo, hi) => {
        let mn = Infinity, mx = -Infinity, sum = 0, sum2 = 0, c = 0;
        for (let f = lo; f < hi; f++) {
            const v = arr[f];
            if (!isFinite(v)) continue;
            if (v < mn) mn = v;
            if (v > mx) mx = v;
            sum += v; sum2 += v * v; c++;
        }
        if (c === 0) return {min: 0, max: 0, mean: 0, rms: 0, std: 0};
        const mean = sum / c;
        return {
            min: mn, max: mx, mean,
            rms: Math.sqrt(sum2 / c),
            std: Math.sqrt(Math.max(0, sum2 / c - mean * mean)),
        };
    };
    // trim the smoothing windows at the ends
    const lo = Math.min(h + 2, n >> 1), hi = Math.max(n - h - 2, n >> 1);
    return {
        groundSpeed: stat(groundSpeed, lo, hi),
        airSpeed: stat(airSpeed, lo, hi),
        verticalSpeed: stat(verticalSpeed, lo, hi),
        gLoad: stat(gLoad, lo, hi),
        turnRate: stat(turnRate, lo, hi),
        altitude: stat(altitude, lo, hi),
        range: stat(range, lo, hi),
        series: {groundSpeed, airSpeed, heading, verticalSpeed, gLoad, turnRate, altitude, range},
    };
}

/** Mean angular error (radians) between a track and the LOS rays. */
export function meanAngularError(dataset, track) {
    const {n, S, D} = dataset;
    let sum = 0;
    for (let f = 0; f < n; f++) {
        const b = f * 3;
        let rx = track[b] - S[b], ry = track[b + 1] - S[b + 1], rz = track[b + 2] - S[b + 2];
        const rl = Math.hypot(rx, ry, rz);
        if (rl < 1e-9) { sum += Math.PI; continue; }
        rx /= rl; ry /= rl; rz /= rl;
        const dot = Math.min(1, Math.max(-1, rx * D[b] + ry * D[b + 1] + rz * D[b + 2]));
        sum += Math.acos(dot);
    }
    return sum / n;
}

// ---------------------------------------------------------------------------
// Constant-speed traverse (mirrors CNodeLOSTraverseConstantSpeed)
// ---------------------------------------------------------------------------

/**
 * Constant air- (or ground-) speed traverse: walk the LOS rays keeping the
 * per-frame step (minus wind, for air speed) equal to speed/fps.
 * speedMs > 0 starts moving away from the sensor.
 * Returns {track, badFrames} — badFrames counts frames where constant speed
 * could not be maintained (no ray-sphere intersection).
 */
export function traverseConstSpeed(dataset, startDist, speedMs, options = {}) {
    const {n, fps, S, D, W} = dataset;
    const airSpeed = options.airSpeed ?? true;
    const track = new Float64Array(n * 3);
    const perFrameMotion = Math.abs(speedMs) / fps;
    const movingAway = speedMs > 0;
    let badFrames = 0;
    let px = S[0] + D[0] * startDist,
        py = S[1] + D[1] * startDist,
        pz = S[2] + D[2] * startDist;
    track[0] = px; track[1] = py; track[2] = pz;
    for (let f = 1; f < n; f++) {
        const b = f * 3;
        const ox = S[b], oy = S[b + 1], oz = S[b + 2];
        const dx = D[b], dy = D[b + 1], dz = D[b + 2];
        const wx = W[b], wy = W[b + 1], wz = W[b + 2];
        const lx = px, ly = py, lz = pz;
        let t = (lx - ox) * dx + (ly - oy) * dy + (lz - oz) * dz;
        if (t < 0) t = 0;
        const cx = ox + dx * t, cy = oy + dy * t, cz = oz + dz * t;
        // binary search the step length (same scheme as the traverse node)
        let A = perFrameMotion / 8, B = perFrameMotion * 8 + 1;
        let bad = false;
        let qx = cx, qy = cy, qz = cz;
        while (Math.abs(A - B) > 0.00001) {
            const mid = (A + B) / 2;
            const mx = ox - lx, my = oy - ly, mz = oz - lz;
            const bq = mx * dx + my * dy + mz * dz;
            const cq = mx * mx + my * my + mz * mz - mid * mid;
            const disc = bq * bq - cq;
            if (disc >= 0) {
                const sq = Math.sqrt(disc);
                const s = movingAway ? (-bq + sq) : (-bq - sq);
                qx = ox + dx * s; qy = oy + dy * s; qz = oz + dz * s;
                bad = false;
            } else {
                qx = cx; qy = cy; qz = cz;
                bad = true;
            }
            let vx = qx - lx, vy = qy - ly, vz = qz - lz;
            if (airSpeed) { vx -= wx; vy -= wy; vz -= wz; }
            if (Math.hypot(vx, vy, vz) < perFrameMotion) A = mid; else B = mid;
        }
        if (bad) badFrames++;
        px = qx; py = qy; pz = qz;
        track[b] = px; track[b + 1] = py; track[b + 2] = pz;
    }
    return {track, badFrames};
}

/**
 * Constant-altitude traverse: the object stays at a fixed height (ENU up = z),
 * so each frame's position is where that LOS ray crosses the plane z = altZ.
 * (Over these local ranges the tangent-plane z is a good stand-in for geodetic
 * altitude — curvature drop is metres.) badFrames counts near-horizontal rays
 * that don't reach the plane at a positive range.
 */
export function traverseConstAltitude(dataset, altZ) {
    const {n, S, D} = dataset;
    const track = new Float64Array(n * 3);
    let badFrames = 0;
    let lastT = null;
    for (let f = 0; f < n; f++) {
        const b = f * 3;
        const dz = D[b + 2];
        let t;
        if (Math.abs(dz) < 1e-6) { t = lastT ?? 0; badFrames++; }
        else {
            t = (altZ - S[b + 2]) / dz;
            if (t <= 0) { t = lastT ?? 0; badFrames++; }
        }
        lastT = t;
        track[b] = S[b] + D[b] * t;
        track[b + 1] = S[b + 1] + D[b + 1] * t;
        track[b + 2] = S[b + 2] + D[b + 2] * t;
    }
    return {track, badFrames};
}

/**
 * Find the constant altitude whose LOS-riding track requires the least
 * horizontal maneuvering. Sweeps the altitude band spanned by the plausible
 * range window (at the mid frame), then bisection-refines.
 *
 * Scoring rides a lightly SMOOTHED copy of the exact-ray track (the
 * traverseMinSpeed recipe): the exact-ray track inherits LOS pointing jitter
 * as range- and fps^2-amplified fake g-load, which used to poison the score
 * at the CORRECT altitude and hand the win to a smoother wrong-altitude
 * corkscrew. A residual-LOS term ((errDeg/sigmaLOSDeg)^2) keeps the smoothed
 * copy honest — a smooth-but-off-ray path can't win either.
 *
 * options: {rangeMin (m), rangeMax (m), samples, sigmaLOSDeg}
 * Returns {altZ, startDist (m), track (smoothed), trackExact (on-ray twin),
 *          errDeg, score, badFrames, failed, metrics}. `failed` is the
 *          degenerate-geometry guard: near-horizontal sightlines never cross
 *          a constant-altitude plane, so the hypothesis is meaningless.
 *          startDist is measured on the EXACT-ray track so applyHypothesis's
 *          startDistance -> live-node altitude round-trip stays exact.
 */
export function fitConstAltitude(dataset, options = {}) {
    const {n, fps, S, D} = dataset;
    const rangeMin = options.rangeMin ?? 0.5 * METERS_PER_NM;
    const rangeMax = options.rangeMax ?? 60 * METERS_PER_NM;
    const samples = options.samples ?? 24;
    const sigmaLOSDeg = options.sigmaLOSDeg ?? 0.05;
    const mid = Math.floor(n / 2);
    // altitude reached at the mid-frame for the range-band endpoints
    const altAt = (R) => S[mid * 3 + 2] + D[mid * 3 + 2] * R;
    let zA = altAt(rangeMin), zB = altAt(rangeMax);
    if (zA > zB) { const t = zA; zA = zB; zB = t; }

    const smoothK = Math.max(6, Math.min(34, Math.round(n / (6 * fps)) + 4));
    const curvature = 0.02 * n / smoothK;
    const evalZ = (z) => {
        const {track, badFrames} = traverseConstAltitude(dataset, z);
        const smooth = smoothTrackBspline(track, n, smoothK, curvature);
        const errDeg = meanAngularError(dataset, smooth) * 180 / Math.PI;
        const score = straightFlightScore(trackMetrics(dataset, smooth), badFrames)
            + (errDeg / sigmaLOSDeg) ** 2;
        return {z, track, smooth, badFrames, errDeg, score};
    };
    let best = null;
    for (let i = 0; i < samples; i++) {
        const z = zA + (zB - zA) * i / (samples - 1);
        const r = evalZ(z);
        if (!best || r.score < best.score) best = r;
    }
    // bisection descent around the best grid sample (a parabolic refine
    // stalls thousands of meters short on sharp score valleys)
    const step = (zB - zA) / (samples - 1);
    for (let pass = 1; pass <= 8; pass++) {
        const h = step / 2 ** pass;
        if (h <= 0) break;
        const a = evalZ(best.z - h), c = evalZ(best.z + h);
        if (a.score < best.score) best = a;
        if (c.score < best.score) best = c;
    }
    // start range along the FIRST RAY of the exact-ray track (see JSDoc)
    const startDist = Math.hypot(best.track[0] - S[0], best.track[1] - S[1], best.track[2] - S[2]);
    const failed = best.badFrames > 0.2 * n;
    return {
        altZ: best.z, startDist, track: best.smooth, trackExact: best.track,
        errDeg: best.errDeg, score: best.score, badFrames: best.badFrames, failed,
        metrics: summarizeMetrics(trackMetrics(dataset, best.smooth)),
    };
}

// ---------------------------------------------------------------------------
// Fixed-object hypotheses (stationary point, ground light, fixed direction)
// ---------------------------------------------------------------------------

/**
 * Best-fit constant LOS DIRECTION (an object at infinity — a star/planet has a
 * parallax-free, essentially fixed direction over a short clip). Returns the
 * direction that the sightlines cluster around and the mean angular error to
 * it. A large errDeg means the sightline sweeps too much to be a fixed
 * astronomical direction.
 *
 * Direction = dominant eigenvector of sum(D_f D_f^T) (power iteration).
 * Returns {dir:[ex,ey,ez] ENU unit, errDeg}.
 */
export function fitFixedDirection(dataset) {
    const {n, D} = dataset;
    // covariance-like matrix C = sum D D^T
    const C = [0, 0, 0, 0, 0, 0, 0, 0, 0];
    let mx = 0, my = 0, mz = 0;
    for (let f = 0; f < n; f++) {
        const x = D[f * 3], y = D[f * 3 + 1], z = D[f * 3 + 2];
        C[0] += x * x; C[1] += x * y; C[2] += x * z;
        C[4] += y * y; C[5] += y * z; C[8] += z * z;
        mx += x; my += y; mz += z;
    }
    C[3] = C[1]; C[6] = C[2]; C[7] = C[5];
    // power iteration seeded at the mean direction
    let ux = mx, uy = my, uz = mz;
    let ul = Math.hypot(ux, uy, uz) || 1; ux /= ul; uy /= ul; uz /= ul;
    for (let it = 0; it < 40; it++) {
        const vx = C[0] * ux + C[1] * uy + C[2] * uz;
        const vy = C[3] * ux + C[4] * uy + C[5] * uz;
        const vz = C[6] * ux + C[7] * uy + C[8] * uz;
        const vl = Math.hypot(vx, vy, vz) || 1;
        ux = vx / vl; uy = vy / vl; uz = vz / vl;
    }
    // orient toward the mean direction
    if (ux * mx + uy * my + uz * mz < 0) { ux = -ux; uy = -uy; uz = -uz; }
    let sum = 0;
    for (let f = 0; f < n; f++) {
        const dot = Math.min(1, Math.max(-1, ux * D[f * 3] + uy * D[f * 3 + 1] + uz * D[f * 3 + 2]));
        sum += Math.acos(dot);
    }
    return {dir: [ux, uy, uz], errDeg: (sum / n) * 180 / Math.PI};
}

/**
 * Best-fit single STATIONARY 3D point that the sightlines pass closest to
 * (least squares of perpendicular distance). options.z, when given, pins the
 * point's ENU up-coordinate (a light on the ground / at a known altitude).
 *
 * (sum M_f) P = sum M_f S_f, with M_f = I - D_f D_f^T. For a pinned z the
 * system reduces to 2x2 in (x,y). A near-parallel sightline bundle (narrow
 * baseline) makes the unconstrained range weakly determined — that's expected
 * and reflected in the reported distance.
 *
 * Returns {point:[x,y,z] ENU, errDeg (mean angular residual), distance (mean
 * range from sensor), badFrames} plus a stationary track (same point each frame).
 */
export function fitFixedPoint(dataset, options = {}) {
    const {n, S, D} = dataset;
    const zPin = options.z ?? null;
    // accumulate A = sum M_f, b = sum M_f S_f  (M_f = I - d d^T)
    const A = [0, 0, 0, 0, 0, 0, 0, 0, 0];
    const b = [0, 0, 0];
    for (let f = 0; f < n; f++) {
        const dx = D[f * 3], dy = D[f * 3 + 1], dz = D[f * 3 + 2];
        const m00 = 1 - dx * dx, m01 = -dx * dy, m02 = -dx * dz;
        const m11 = 1 - dy * dy, m12 = -dy * dz, m22 = 1 - dz * dz;
        A[0] += m00; A[1] += m01; A[2] += m02;
        A[4] += m11; A[5] += m12; A[8] += m22;
        const sx = S[f * 3], sy = S[f * 3 + 1], sz = S[f * 3 + 2];
        b[0] += m00 * sx + m01 * sy + m02 * sz;
        b[1] += m01 * sx + m11 * sy + m12 * sz;
        b[2] += m02 * sx + m12 * sy + m22 * sz;
    }
    A[3] = A[1]; A[6] = A[2]; A[7] = A[5];

    let px, py, pz;
    if (zPin !== null) {
        // solve 2x2 for (x,y) with z = zPin: [A00 A01; A10 A11][x;y] = b012 - A..z*zPin
        const b0 = b[0] - A[2] * zPin;
        const b1 = b[1] - A[5] * zPin;
        const det = A[0] * A[4] - A[1] * A[3];
        if (Math.abs(det) < 1e-9) { px = S[0] + D[0] * 20000; py = S[1] + D[1] * 20000; }
        else { px = (b0 * A[4] - b1 * A[1]) / det; py = (A[0] * b1 - A[3] * b0) / det; }
        pz = zPin;
    } else {
        const sol = solve3(A, b);
        if (sol) { px = sol[0]; py = sol[1]; pz = sol[2]; }
        else { px = S[0] + D[0] * 20000; py = S[1] + D[1] * 20000; pz = S[2] + D[2] * 20000; }
    }

    const track = new Float64Array(n * 3);
    let sumAng = 0, sumDist = 0;
    for (let f = 0; f < n; f++) {
        track[f * 3] = px; track[f * 3 + 1] = py; track[f * 3 + 2] = pz;
        let rx = px - S[f * 3], ry = py - S[f * 3 + 1], rz = pz - S[f * 3 + 2];
        const rl = Math.hypot(rx, ry, rz) || 1;
        sumDist += rl;
        const dot = Math.min(1, Math.max(-1, (rx * D[f * 3] + ry * D[f * 3 + 1] + rz * D[f * 3 + 2]) / rl));
        sumAng += Math.acos(dot);
    }
    return {
        point: [px, py, pz], track,
        errDeg: (sumAng / n) * 180 / Math.PI,
        distance: sumDist / n, badFrames: 0,
    };
}

// 3x3 solve (row-major), returns null if singular
function solve3(A, b) {
    const m = [A[0], A[1], A[2], A[3], A[4], A[5], A[6], A[7], A[8]];
    const v = [b[0], b[1], b[2]];
    for (let col = 0; col < 3; col++) {
        let piv = col, mx = Math.abs(m[col * 3 + col]);
        for (let r = col + 1; r < 3; r++) {
            const a = Math.abs(m[r * 3 + col]);
            if (a > mx) { mx = a; piv = r; }
        }
        if (mx < 1e-12) return null;
        if (piv !== col) {
            for (let k = 0; k < 3; k++) { const t = m[col * 3 + k]; m[col * 3 + k] = m[piv * 3 + k]; m[piv * 3 + k] = t; }
            const t = v[col]; v[col] = v[piv]; v[piv] = t;
        }
        for (let r = col + 1; r < 3; r++) {
            const fct = m[r * 3 + col] / m[col * 3 + col];
            for (let k = col; k < 3; k++) m[r * 3 + k] -= fct * m[col * 3 + k];
            v[r] -= fct * v[col];
        }
    }
    const x = [0, 0, 0];
    for (let i = 2; i >= 0; i--) {
        let s = v[i];
        for (let k = i + 1; k < 3; k++) s -= m[i * 3 + k] * x[k];
        x[i] = s / m[i * 3 + i];
    }
    return x;
}

/**
 * Smoothness/plausibility score for an essentially-straight-flying object.
 * Lower is better. Weights chosen so ~0.1g of sustained maneuvering ≈ 0.4.
 */
export function straightFlightScore(metrics, badFrames = 0) {
    return (
        4 * metrics.gLoad.rms +
        1 * metrics.gLoad.max +
        0.05 * Math.abs(metrics.turnRate.std) +
        0.02 * Math.max(0, Math.abs(metrics.verticalSpeed.mean) - 5) +
        badFrames * 0.1
    );
}

/**
 * Stride-downsample a dataset to ~targetN frames for cheaper per-combo solves.
 * W (per-FRAME wind displacement) is SUMMED over each stride window so the
 * total wind drift is preserved; fps scales by the stride.
 */
export function downsampleDataset(ds, targetN = 2500) {
    const {n, fps, S, D, W} = ds;
    const stride = Math.max(1, Math.round(n / targetN));
    if (stride === 1) return {ds: {...ds}, stride};
    const n2 = Math.floor((n - 1) / stride) + 1;
    const S2 = new Float64Array(n2 * 3), D2 = new Float64Array(n2 * 3), W2 = new Float64Array(n2 * 3);
    for (let f2 = 0; f2 < n2; f2++) {
        const f = f2 * stride, b = f * 3, b2 = f2 * 3;
        S2[b2] = S[b]; S2[b2 + 1] = S[b + 1]; S2[b2 + 2] = S[b + 2];
        D2[b2] = D[b]; D2[b2 + 1] = D[b + 1]; D2[b2 + 2] = D[b + 2];
        if (f2 < n2 - 1) {
            let wx = 0, wy = 0, wz = 0;
            for (let g = f; g < Math.min(n, f + stride); g++) { wx += W[g * 3]; wy += W[g * 3 + 1]; wz += W[g * 3 + 2]; }
            W2[b2] = wx; W2[b2 + 1] = wy; W2[b2 + 2] = wz;
        }
    }
    return {ds: {n: n2, fps: fps / stride, S: S2, D: D2, W: W2}, stride};
}

/**
 * Grid search over (start distance, air speed) for the constant-air-speed
 * traverse. Returns every combo scored, sorted best-first, plus the grid
 * dimensions for heatmap rendering.
 *
 * Each combo is solved as a spline QP (traversePlausible with a TIGHT speed
 * sigma) on a downsampled dataset, then lightly smoothed before scoring. The
 * old per-frame ray-walk was a shooting method: on scenes where the sensor
 * maneuvers it exploded into corkscrews at the correct combo (jitter + branch
 * flapping), so the truth could LOSE the sweep. The QP finds the smoothest
 * path that holds the requested speed; a speed-fidelity term marks down
 * combos whose "constant speed" the QP could not actually hold (this replaces
 * badFrames as the infeasibility signal — badFrames is kept as 0 in the
 * result shape for compatibility).
 *
 * The smoothness score valley is typically sharp in range but very flat in
 * speed, so with smoothness alone the "best" lands arbitrarily at a grid
 * edge. options.speedTarget (m/s) adds a mild soft-target term
 * 0.2*((v-target)/250kt)^2 that picks the middle of the plausible band
 * without changing which ranges score well.
 *
 * options: {ranges: number[] (m), speeds: number[] (m/s),
 *           speedTarget (m/s|null), targetN, spdFidSigma (m/s), progress}
 * progress(frac) is awaited if provided (once per range row).
 */
export async function sweepConstAirSpeed(dataset, options = {}) {
    const ranges = options.ranges ?? defaultRangeList(dataset);
    const speeds = options.speeds ?? defaultSpeedList();
    const speedTarget = options.speedTarget ?? null;
    const vSigma = options.vSigma ?? 3 * KNOTS_TO_MS;
    const spdFidSigma = options.spdFidSigma ?? 10 * KNOTS_TO_MS;
    const speedSigma = 250 * KNOTS_TO_MS;
    const {ds} = downsampleDataset(dataset, options.targetN ?? 2500);
    const smoothK = Math.max(6, Math.min(34, Math.round(ds.n / (6 * ds.fps)) + 4));
    const curvature = 0.02 * ds.n / smoothK;
    const results = [];
    for (let ri = 0; ri < ranges.length; ri++) {
        for (const speedMs of speeds) {
            const {track} = traversePlausible(ds, ranges[ri], {vTarget: speedMs, vSigma, iters: 3, K: 25});
            const sm = smoothTrackBspline(track, ds.n, smoothK, curvature);
            const m = trackMetrics(ds, sm);
            let score = straightFlightScore(m, 0);
            if (speedTarget !== null) {
                score += 0.2 * ((speedMs - speedTarget) / speedSigma) ** 2;
            }
            const spdErr = Math.hypot(m.airSpeed.mean - speedMs, m.airSpeed.std);
            score += (spdErr / spdFidSigma) ** 2;
            results.push({
                startDist: ranges[ri],
                speed: speedMs,
                score,
                badFrames: 0,
                spdErr,
                metrics: summarizeMetrics(m),
            });
        }
        if (options.progress) await options.progress((ri + 1) / ranges.length);
    }
    const sorted = results.slice().sort((a, b) => a.score - b.score);
    return {ranges, speeds, results, best: sorted[0], sorted};
}

/**
 * Full-resolution display/apply track for a sweep combo: solve the QP on the
 * downsample, linearly upsample its range profile (lambda) onto the full-res
 * rays, then smooth. (Re-solving the QP at full n/fps re-amplifies the
 * per-frame jitter terms and skews the held speed — measured 45.8±9.7 kt vs
 * 43.5±0.4 kt on a 43.4 kt truth — so upsampling lambda is the right way.)
 */
export function constAirSpeedTrack(dataset, startDist, speedMs, options = {}) {
    const {ds: d2, stride} = downsampleDataset(dataset, options.targetN ?? 2500);
    const vSigma = options.vSigma ?? 3 * KNOTS_TO_MS;
    const {lam} = traversePlausible(d2, startDist, {vTarget: speedMs, vSigma, iters: 3, K: 25});
    const {n, fps, S, D} = dataset;
    const raw = new Float64Array(n * 3);
    for (let f = 0; f < n; f++) {
        const u = Math.min(f / stride, d2.n - 1);
        const i = Math.min(Math.floor(u), d2.n - 2);
        const t = u - i;
        const L = lam[i] * (1 - t) + lam[i + 1] * t;
        raw[f * 3] = S[f * 3] + D[f * 3] * L;
        raw[f * 3 + 1] = S[f * 3 + 1] + D[f * 3 + 1] * L;
        raw[f * 3 + 2] = S[f * 3 + 2] + D[f * 3 + 2] * L;
    }
    const smoothK = Math.max(6, Math.min(34, Math.round(n / (6 * fps)) + 4));
    const track = smoothTrackBspline(raw, n, smoothK, 0.02 * n / smoothK);
    return {track, badFrames: 0};
}

function defaultRangeList(dataset) {
    // 2..45 NM in 1 NM steps — reasonable envelope for air encounters
    const out = [];
    for (let nm = 2; nm <= 45; nm += 1) out.push(nm * METERS_PER_NM);
    return out;
}

function defaultSpeedList() {
    // Log-spaced 15..650 kt: proportional resolution everywhere, so slow
    // objects (a 43 kt drifter) are representable, not just the jet band —
    // the old linear 100..650 kt grid could not express slow truths at all.
    const out = [];
    const lo = 15, hi = 650, count = 32;
    for (let i = 0; i < count; i++) {
        out.push(lo * Math.pow(hi / lo, i / (count - 1)) * KNOTS_TO_MS);
    }
    return out;
}

/** Compact copy of metrics without the per-frame series (for result tables). */
export function summarizeMetrics(m) {
    const pick = (s) => ({min: s.min, max: s.max, mean: s.mean, rms: s.rms, std: s.std});
    return {
        groundSpeed: pick(m.groundSpeed),
        airSpeed: pick(m.airSpeed),
        verticalSpeed: pick(m.verticalSpeed),
        gLoad: pick(m.gLoad),
        turnRate: pick(m.turnRate),
        altitude: pick(m.altitude),
        range: pick(m.range),
    };
}

// ---------------------------------------------------------------------------
// Plausible traverse: spline QP with soft speed target (IRLS)
// ---------------------------------------------------------------------------

/** Uniform cubic B-spline basis over n frames with K control points. */
export function bsplineBasis(n, K) {
    const B = [];
    const nSeg = K - 3;
    for (let f = 0; f < n; f++) {
        const u = (f / (n - 1)) * nSeg;
        const seg = Math.min(nSeg - 1, Math.floor(u));
        const t = u - seg;
        B.push([seg, [
            (1 - t) ** 3 / 6,
            (3 * t ** 3 - 6 * t ** 2 + 4) / 6,
            (-3 * t ** 3 + 3 * t ** 2 + 3 * t + 1) / 6,
            t ** 3 / 6,
        ]]);
    }
    return B;
}

/**
 * The smoothest LOS-riding trajectory that starts at range startDist.
 *
 * Range along each ray is a smooth B-spline lambda(f); minimizes
 *     sum (|accel| in g)^2
 *   + wSpd  * sum ((airSpeed - vTarget)/vSigma)^2     [if vTarget given, IRLS]
 *   + wClimb* sum (verticalSpeed/vSigma)^2            [if wClimb > 0]
 * with a soft anchor lambda(0) = startDist (meters-scale slop).
 *
 * The speed term is the "loose target" that resolves the fundamental LOS
 * ambiguity: without it the least-maneuvering solution family is nearly
 * degenerate in range rate — for NARROW-BASELINE sightlines. When the sensor
 * itself maneuvers (an orbit), geometry alone pins the range and the speed
 * target should be dropped (see fitPlausibleBestRange). vTarget=null uses a
 * tiny |v|^2 ridge instead.
 *
 * Three option-gated behaviors, all DEFAULT OFF (existing callers byte-identical):
 *   accelStride h — the acceleration rows use a strided second difference
 *     [r-h, r, r+h]/h^2. The per-frame stencil is dominated by frame-scale LOS
 *     jitter (amplified by range and fps^2): on noisy rays the exact truth
 *     path can cost MORE than a close-in whirling one, so the QP dives toward
 *     the sensor. Striding measures acceleration over ~h frames and restores
 *     the real signal.
 *   rangeFloor (+minDist=120) — soft range floor, same pattern as
 *     traverseMinSpeed; without it the QP can drive lambda NEGATIVE (object
 *     behind the sensor) at close anchor ranges.
 *   smoothOutput (+smoothSpacingSec=2, smoothK, smoothCurvature) — post-smooth
 *     the returned track (control point every ~spacing seconds) so the track
 *     and anything scored from it shed exact-ray jitter; loop-scale motion
 *     (tens of seconds) stays visible.
 *
 * options: {K=25, vTarget (m/s|null), vSigma (m/s), wSpd=1, wClimb=0,
 *           iters=6, anchorFrame=0, accelStride=1, rangeFloor=false,
 *           minDist=120, smoothOutput=false, smoothSpacingSec=2}
 * Returns {track, lam}.
 */
export function traversePlausible(dataset, startDist, options = {}) {
    const {n, fps, S, D, W} = dataset;
    const K = options.K ?? 25;
    const vTarget = options.vTarget ?? null;
    const vSigma = options.vSigma ?? 50 * KNOTS_TO_MS;
    const wSpd = options.wSpd ?? 1;
    const wClimb = options.wClimb ?? 0;
    const iters = options.iters ?? 6;
    const anchorFrame = Math.max(0, Math.min(n - 1, Math.round(options.anchorFrame ?? 0)));
    const hA = Math.max(1, Math.min(Math.round(options.accelStride ?? 1), Math.floor((n - 1) / 2)));
    const minDist = options.minDist ?? 120;
    const useFloor = options.rangeFloor ?? false;
    const floorW = new Float64Array(n);

    const B = bsplineBasis(n, K);
    const accelScale = fps * fps / G_ACCEL / (hA * hA);
    const lam = new Float64Array(n).fill(startDist);
    let c = null;

    const maxIters = useFloor ? iters + 5 : iters;
    for (let iter = 0; iter < maxIters; iter++) {
        const A = [];
        for (let k = 0; k < K; k++) A.push(new Float64Array(K));
        const rhs = new Float64Array(K);
        const addRow = (cols, weights, constTerm, w2 = 1) => {
            for (let i = 0; i < cols.length; i++) {
                rhs[cols[i]] -= w2 * weights[i] * constTerm;
                for (let j = 0; j < cols.length; j++) {
                    A[cols[i]][cols[j]] += w2 * weights[i] * weights[j];
                }
            }
        };
        // one least-squares row per (frame stencil, xyz component)
        const stencil = (frames, cs, scale, compW) => {
            for (let comp = 0; comp < 3; comp++) {
                if (compW && compW[comp] === 0) continue;
                let constTerm = 0;
                const colW = new Map();
                for (let i = 0; i < frames.length; i++) {
                    const fr = frames[i];
                    constTerm += cs[i] * S[fr * 3 + comp];
                    const [seg, w] = B[fr];
                    const dcomp = D[fr * 3 + comp];
                    for (let q = 0; q < 4; q++) {
                        const k = seg + q;
                        colW.set(k, (colW.get(k) || 0) + cs[i] * w[q] * dcomp);
                    }
                }
                const sc = scale * (compW ? compW[comp] : 1);
                addRow([...colW.keys()], [...colW.values()].map(v => v * sc), constTerm * sc);
            }
        };

        // acceleration rows, in g (strided second difference when accelStride > 1)
        for (let r = hA; r <= n - 1 - hA; r++) stencil([r - hA, r, r + hA], [1, -2, 1], accelScale);

        // soft anchor lambda(anchorFrame) = startDist (weight 10 => centimeter-to-meter
        // slop; a hard/huge weight wrecks the conditioning of the dense solve)
        {
            const [seg, w] = B[anchorFrame];
            addRow([seg, seg + 1, seg + 2, seg + 3], w, -startDist, 10);
        }

        if (vTarget !== null) {
            // IRLS speed target: linearize |v_air| about the current estimate's
            // direction u: residual = u . v_air - vTarget/fps
            const wv = Math.sqrt(wSpd) * fps / vSigma;
            for (let f = 0; f < n - 1; f++) {
                const a0 = S[(f + 1) * 3] + lam[f + 1] * D[(f + 1) * 3] - (S[f * 3] + lam[f] * D[f * 3]) - W[f * 3];
                const a1 = S[(f + 1) * 3 + 1] + lam[f + 1] * D[(f + 1) * 3 + 1] - (S[f * 3 + 1] + lam[f] * D[f * 3 + 1]) - W[f * 3 + 1];
                const a2 = S[(f + 1) * 3 + 2] + lam[f + 1] * D[(f + 1) * 3 + 2] - (S[f * 3 + 2] + lam[f] * D[f * 3 + 2]) - W[f * 3 + 2];
                const al = Math.hypot(a0, a1, a2) || 1;
                const u = [a0 / al, a1 / al, a2 / al];
                let constTerm = -(u[0] * W[f * 3] + u[1] * W[f * 3 + 1] + u[2] * W[f * 3 + 2]) - vTarget / fps;
                const colW = new Map();
                const frames = [f, f + 1], cs = [-1, 1];
                for (let i = 0; i < 2; i++) {
                    const fr = frames[i];
                    for (let comp = 0; comp < 3; comp++) {
                        constTerm += cs[i] * S[fr * 3 + comp] * u[comp];
                    }
                    const [seg, w] = B[fr];
                    const dDotU = D[fr * 3] * u[0] + D[fr * 3 + 1] * u[1] + D[fr * 3 + 2] * u[2];
                    for (let q = 0; q < 4; q++) {
                        const k = seg + q;
                        colW.set(k, (colW.get(k) || 0) + cs[i] * w[q] * dDotU);
                    }
                }
                addRow([...colW.keys()], [...colW.values()].map(v => v * wv), constTerm * wv);
            }
        } else {
            // tiny velocity ridge to regularize the near-degenerate smooth modes
            const wv = 0.002 * fps / (350 * KNOTS_TO_MS);
            for (let f = 0; f < n - 1; f++) stencil([f, f + 1], [-1, 1], wv);
        }

        if (wClimb > 0) {
            const wc = Math.sqrt(wClimb) * fps / vSigma;
            for (let f = 0; f < n - 1; f++) stencil([f, f + 1], [-1, 1], wc, [0, 0, 1]);
        }

        // soft floor rows where lambda dipped below minDist on a prior iterate
        if (useFloor) {
            for (let f = 0; f < n; f++) {
                if (floorW[f] > 0) {
                    const [seg, w] = B[f];
                    addRow([seg, seg + 1, seg + 2, seg + 3], w, -minDist, floorW[f]);
                }
            }
        }

        for (let k = 0; k < K; k++) A[k][k] += 1e-10 * (A[k][k] || 1);
        c = solveDense(A, rhs);
        for (let f = 0; f < n; f++) {
            const [seg, w] = B[f];
            lam[f] = c[seg] * w[0] + c[seg + 1] * w[1] + c[seg + 2] * w[2] + c[seg + 3] * w[3];
        }
        let viol = false;
        if (useFloor) {
            for (let f = 0; f < n; f++) if (lam[f] < minDist) { floorW[f] = (floorW[f] || 1) * 8; viol = true; }
        }
        if (vTarget === null && !viol) break;
        if (vTarget !== null && iter >= iters - 1 && !viol) break;
    }

    let track = new Float64Array(n * 3);
    for (let f = 0; f < n; f++) {
        track[f * 3] = S[f * 3] + D[f * 3] * lam[f];
        track[f * 3 + 1] = S[f * 3 + 1] + D[f * 3 + 1] * lam[f];
        track[f * 3 + 2] = S[f * 3 + 2] + D[f * 3 + 2] * lam[f];
    }
    // Optional post-smoothing: LIGHT (control point every smoothSpacingSec
    // seconds) — sheds frame-scale LOS jitter, keeps real loops visible.
    if (options.smoothOutput) {
        const spacing = options.smoothSpacingSec ?? 2;
        const smoothK = Math.max(6, Math.min(400, options.smoothK ?? (Math.round(n / (fps * spacing)) + 4)));
        const curvature = options.smoothCurvature ?? (0.02 * n / smoothK);
        track = smoothTrackBspline(track, n, smoothK, curvature);
        for (let f = 0; f < n; f++) {
            lam[f] = Math.hypot(track[f * 3] - S[f * 3], track[f * 3 + 1] - S[f * 3 + 1], track[f * 3 + 2] - S[f * 3 + 2]);
        }
    }
    return {track, lam};
}

// Smoothing-spline fit: a low-order uniform cubic B-spline fit to a track
// (independent least squares per axis) with a second-difference curvature
// penalty on the control points. Used to shed sensor jitter from a min-speed
// path: fewer control points and a curvature penalty => smoother => lower
// spurious g-load. The curvature penalty also tames the classic B-spline
// boundary overshoot (the endpoint control points are otherwise data-starved
// and can spike the g-load in the first/last fraction of a second).
function smoothTrackBspline(pts, n, K, curvature = 0) {
    K = Math.max(4, Math.min(K, n));
    const B = bsplineBasis(n, K);
    const out = new Float64Array(n * 3);
    for (let a = 0; a < 3; a++) {
        const A = [];
        for (let k = 0; k < K; k++) A.push(new Float64Array(K));
        const rhs = new Float64Array(K);
        for (let f = 0; f < n; f++) {
            const [seg, w] = B[f];
            const p = pts[f * 3 + a];
            for (let i = 0; i < 4; i++) {
                rhs[seg + i] += w[i] * p;
                for (let j = 0; j < 4; j++) A[seg + i][seg + j] += w[i] * w[j];
            }
        }
        // curvature penalty: mu * sum (c[k-1] - 2 c[k] + c[k+1])^2 (target 0)
        if (curvature > 0) {
            for (let k = 1; k < K - 1; k++) {
                const cols = [k - 1, k, k + 1], cs = [1, -2, 1];
                for (let i = 0; i < 3; i++) {
                    for (let j = 0; j < 3; j++) A[cols[i]][cols[j]] += curvature * cs[i] * cs[j];
                }
            }
        }
        for (let k = 0; k < K; k++) A[k][k] += 1e-9 * (A[k][k] || 1);
        const c = solveDense(A, rhs);
        for (let f = 0; f < n; f++) {
            const [seg, w] = B[f];
            out[f * 3 + a] = c[seg] * w[0] + c[seg + 1] * w[1] + c[seg + 2] * w[2] + c[seg + 3] * w[3];
        }
    }
    return out;
}

/**
 * The SLOWEST LOS-riding trajectory — the minimum-(air-)speed object consistent
 * with the sightlines. Range along each ray is a smooth B-spline lambda(f)
 * chosen to minimize the summed squared per-frame AIR displacement
 *     sum | X(f+1) - X(f) - W(f) |^2 ,   X(f) = S(f) + lambda(f) D(f)
 * (W = per-frame wind drift, so with wind on this is minimum AIR speed: a
 * balloon or lantern moving with the air reads ~0). A soft floor keeps
 * lambda >= minDist so the object can't fall behind the camera, and a light
 * curvature ridge conditions the near-parallel-ray null modes.
 *
 * Riding the rays EXACTLY, though, inherits the jet-track and FLIR pointing
 * jitter as spurious speed/g spikes (tens of kt, several g) even where lambda is
 * smooth — so the final path is smoothed with a low-order B-spline that keeps
 * the slow range profile but sits a few hundredths of a degree off the noisy
 * rays, exactly as a real drifting object (or an analyst's hand-drawn spline)
 * does. That drops the g-load to a fraction of a g at ~0.03 deg LOS residual.
 *
 * Where traversePlausible minimizes MANEUVERING (and lands fast and smooth),
 * this minimizes SPEED. For a sensor orbiting a slow, close object the apparent
 * motion is mostly the sensor's own parallax, so the slowest consistent object
 * is a near-static drifter — the Aguadilla / GoFast lantern answer.
 *
 * options: {K=30, minDist=120, floorIters=5, accelReg=0.15, smoothK}
 * Returns {track, lam} (lam = the smoothed track's slant range along each ray).
 */
export function traverseMinSpeed(dataset, options = {}) {
    const {n, fps, S, D, W} = dataset;
    const K = Math.max(4, Math.min(options.K ?? 30, n));
    const minDist = options.minDist ?? 120;
    const floorIters = Math.max(1, options.floorIters ?? 5);
    const accelReg = options.accelReg ?? 0.15;   // tiny curvature ridge, position units
    // End-level pull: after the floor converges, a few IRLS iterations add
    // speed-level rows over the first/last levelEndsFrac of frames, pulling
    // the air speed there toward the interior median of the FIRST converged
    // iterate (vRef, frozen — recomputing it each iteration ratchets the
    // target). The B-spline endpoints are data-starved, so the raw solution
    // over/undershoots speed at the clip ends (a constant-speed truth read
    // 35-45 kt); the level rows fix the boundary without touching the
    // interior objective.
    const levelW = options.levelW ?? 0.2;
    const levelIters = Math.max(0, options.levelIters ?? 3);
    const levelEndsFrac = options.levelEndsFrac ?? 0.15;

    const B = bsplineBasis(n, K);
    const lam = new Float64Array(n).fill(1000);
    const floorW = new Float64Array(n);   // per-frame soft-floor weight (0 until violated)
    let c = null;

    // current iterate positions + unit air velocities (IRLS linearization)
    const pos = new Float64Array(n * 3);
    const updatePos = () => {
        for (let f = 0; f < n; f++) {
            pos[f * 3] = S[f * 3] + D[f * 3] * lam[f];
            pos[f * 3 + 1] = S[f * 3 + 1] + D[f * 3 + 1] * lam[f];
            pos[f * 3 + 2] = S[f * 3 + 2] + D[f * 3 + 2] * lam[f];
        }
    };
    const u = new Float64Array((n - 1) * 3);
    let vRef = 0, vRefFrozen = false;
    const updateU = () => {
        const spds = [];
        for (let f = 0; f < n - 1; f++) {
            const b = f * 3, d = (f + 1) * 3;
            const vx = pos[d] - pos[b] - W[b], vy = pos[d + 1] - pos[b + 1] - W[b + 1], vz = pos[d + 2] - pos[b + 2] - W[b + 2];
            const vl = Math.hypot(vx, vy, vz) || 1;
            u[b] = vx / vl; u[b + 1] = vy / vl; u[b + 2] = vz / vl;
            spds.push(vl * fps);
        }
        if (vRefFrozen) return;
        const trim = Math.min(Math.floor(spds.length / 4), Math.round(10 * fps));
        const inner = spds.slice(trim, spds.length - trim).sort((a, b2) => a - b2);
        vRef = inner[Math.floor(inner.length / 2)];
        vRefFrozen = true;
    };

    const useLevel = levelW > 0 && levelIters > 0;
    const totalIters = floorIters + (useLevel ? levelIters : 0);
    let irlsOn = false;

    for (let iter = 0; iter < totalIters; iter++) {
        const A = [];
        for (let k = 0; k < K; k++) A.push(new Float64Array(K));
        const rhs = new Float64Array(K);
        const addRow = (cols, weights, constTerm, w2 = 1) => {
            for (let i = 0; i < cols.length; i++) {
                rhs[cols[i]] -= w2 * weights[i] * constTerm;
                for (let j = 0; j < cols.length; j++) A[cols[i]][cols[j]] += w2 * weights[i] * weights[j];
            }
        };
        // add a least-squares row: sum_i cs[i] * X(frames[i])[comp], per component
        const stencilRow = (frames, cs, sBase, w2) => {
            for (let comp = 0; comp < 3; comp++) {
                let constTerm = 0;
                const colW = new Map();
                for (let i = 0; i < frames.length; i++) {
                    const fr = frames[i];
                    constTerm += cs[i] * S[fr * 3 + comp];
                    const bf = B[fr], dc = D[fr * 3 + comp];
                    for (let q = 0; q < 4; q++) {
                        const k = bf[0] + q;
                        colW.set(k, (colW.get(k) || 0) + cs[i] * bf[1][q] * dc);
                    }
                }
                constTerm += sBase[comp];   // extra constant (e.g. -wind) per component
                addRow([...colW.keys()], [...colW.values()], constTerm, w2);
            }
        };

        // minimum-air-speed rows: X(f+1) - X(f) - W(f)
        for (let f = 0; f < n - 1; f++) {
            stencilRow([f, f + 1], [-1, 1], [-W[f * 3], -W[f * 3 + 1], -W[f * 3 + 2]], 1);
        }
        // light trajectory-curvature ridge (conditions null modes; too small to bias speed)
        if (accelReg > 0) {
            const w2 = accelReg * accelReg;
            for (let r = 1; r <= n - 2; r++) stencilRow([r - 1, r, r + 1], [1, -2, 1], [0, 0, 0], w2);
        }
        // soft range floor: pull lambda(f) toward minDist only where it dipped below
        for (let f = 0; f < n; f++) {
            if (floorW[f] > 0) {
                const bf = B[f];
                addRow([bf[0], bf[0] + 1, bf[0] + 2, bf[0] + 3], bf[1], -minDist, floorW[f]);
            }
        }

        // end-level rows: (u_f . v_air(f)) = vRef over the boundary windows,
        // linearized about the previous iterate's unit air velocity u_f
        if (irlsOn) {
            const w = levelW * fps;
            const endF = Math.round(levelEndsFrac * n);
            for (let f = 0; f < n - 1; f++) {
                if (f >= endF && f < n - 1 - endF) continue;
                const b = f * 3;
                const uf0 = u[b], uf1 = u[b + 1], uf2 = u[b + 2];
                let constTerm = -(uf0 * W[b] + uf1 * W[b + 1] + uf2 * W[b + 2]) - vRef / fps;
                const colW = new Map();
                const frames = [f, f + 1], cs = [-1, 1];
                for (let i = 0; i < 2; i++) {
                    const fr = frames[i];
                    constTerm += cs[i] * (uf0 * S[fr * 3] + uf1 * S[fr * 3 + 1] + uf2 * S[fr * 3 + 2]);
                    const bf = B[fr];
                    const dDotU = D[fr * 3] * uf0 + D[fr * 3 + 1] * uf1 + D[fr * 3 + 2] * uf2;
                    for (let q = 0; q < 4; q++) {
                        const k = bf[0] + q;
                        colW.set(k, (colW.get(k) || 0) + cs[i] * bf[1][q] * dDotU);
                    }
                }
                addRow([...colW.keys()], [...colW.values()].map(v => v * w), constTerm * w);
            }
        }

        for (let k = 0; k < K; k++) A[k][k] += 1e-9 * (A[k][k] || 1);
        c = solveDense(A, rhs);
        for (let f = 0; f < n; f++) {
            const bf = B[f];
            lam[f] = c[bf[0]] * bf[1][0] + c[bf[0] + 1] * bf[1][1] + c[bf[0] + 2] * bf[1][2] + c[bf[0] + 3] * bf[1][3];
        }
        let viol = false;
        for (let f = 0; f < n; f++) if (lam[f] < minDist) { floorW[f] = (floorW[f] || 1) * 8; viol = true; }
        updatePos();
        if (!viol && !irlsOn && useLevel) {
            irlsOn = true;      // floor pass converged; switch on the level rows
            updateU();
            continue;
        }
        if (irlsOn) updateU();
        if (!viol && !irlsOn) break;
    }

    // exact-ray min-speed track (smooth range, but rides the jittery rays)
    const raw = Float64Array.from(pos);
    // Smooth off the sensor jitter with ~6 s control-point spacing plus a light
    // curvature penalty (scaled by data-per-knot so the smoothness is consistent
    // across clip lengths). Kept loose enough to still track the sightlines to a
    // few hundredths of a degree, but smooth enough that the peak g-load sits
    // near a real drifting object's (a few tenths of a g, mostly residual sensor
    // jitter) rather than the tens-of-kt / several-g an exactly-on-ray path shows.
    const smoothK = Math.max(6, Math.min(34, options.smoothK ?? (Math.round(n / (6 * fps)) + 4)));
    const curvature = options.smoothCurvature ?? (0.02 * n / smoothK);
    const track = smoothTrackBspline(raw, n, smoothK, curvature);
    // report the smoothed track's actual slant range along each sightline
    for (let f = 0; f < n; f++) {
        lam[f] = Math.hypot(track[f * 3] - S[f * 3], track[f * 3 + 1] - S[f * 3 + 1], track[f * 3 + 2] - S[f * 3 + 2]);
    }
    return {track, lam};
}

/**
 * Sweep traversePlausible over a list of start ranges: the "how much
 * maneuvering does each distance require" profile.
 * options: {ranges (m), vTarget, vSigma, wClimb, K, progress}
 * Returns [{startDist, metrics, score, track?}] (tracks omitted unless keepTracks).
 */
export async function rangeProfile(dataset, options = {}) {
    const ranges = options.ranges ?? defaultRangeList(dataset);
    const vTarget = options.vTarget ?? null;
    const vSigma = options.vSigma ?? 50 * KNOTS_TO_MS;
    const scoreSpeedWeight = options.scoreSpeedWeight ?? 0;
    const out = [];
    for (let i = 0; i < ranges.length; i++) {
        const {track, lam} = traversePlausible(dataset, ranges[i], options);
        const m = trackMetrics(dataset, track);
        let score = straightFlightScore(m);
        if (vTarget !== null && scoreSpeedWeight > 0) {
            score += scoreSpeedWeight * ((m.airSpeed.mean - vTarget) / vSigma) ** 2;
        }
        const row = {
            startDist: ranges[i],
            endDist: lam[dataset.n - 1],
            minDist: Math.min(...lam),
            score,
            metrics: summarizeMetrics(m),
        };
        if (options.keepTracks) row.track = track;
        out.push(row);
        if (options.progress) await options.progress((i + 1) / ranges.length);
    }
    return out;
}

/**
 * Autonomous plausible fit: find the START RANGE whose smoothest LOS-riding
 * trajectory is the least implausible, then return the full-quality solution
 * there.
 *
 * Two-stage search:
 *   Stage 1 scores a PURE-smoothness (vTarget:null) coarse log sweep — when
 *   the sensor itself maneuvers (an orbit, a hard turn), geometry alone pins
 *   the range and this valley is DECISIVE (measured: median-best score margin
 *   ~2.4-2.8 on orbit/Aguadilla-like scenes vs 0.000 on a straight-flying
 *   sensor). The speed prior would only poison it (a 320 kt target drags the
 *   QP off a 43 kt truth into 2+ g loops).
 *   Stage 2, only when the pure valley is flat (narrow-baseline scenes like
 *   Gimbal, where range is unobservable from geometry): fall back to the
 *   speed-target-driven sweep — there it is the SPEED TARGET that makes the
 *   plausibility-vs-range curve have a real minimum.
 *
 * All solves run with the noise-robust traversePlausible options (strided
 * acceleration stencil, soft range floor, light output smoothing) — without
 * them frame-scale LOS jitter dominates the objective and the QP dives toward
 * the sensor (and can even push lambda negative: a track BEHIND the camera).
 *
 * options: {vTarget (m/s), vSigma, rangeMin (m), rangeMax (m), coarse (count),
 *           searchK, searchIters, finalK, finalIters, decisiveMargin=0.5}
 * Returns {track, lam, startDist (m), score, profile: [{startDist, score}],
 *          usedSpeedTarget, decisiveness}.
 */
export function fitPlausibleBestRange(dataset, options = {}) {
    const vTarget = options.vTarget ?? 300 * KNOTS_TO_MS;
    const vSigma = options.vSigma ?? 60 * KNOTS_TO_MS;
    const rangeMin = options.rangeMin ?? 0.5 * METERS_PER_NM;
    const rangeMax = options.rangeMax ?? 55 * METERS_PER_NM;
    const coarse = options.coarse ?? 18;
    const decisiveMargin = options.decisiveMargin ?? 0.5;
    const common = {
        accelStride: Math.max(1, Math.round(dataset.fps / 2)),
        smoothOutput: true,
        smoothSpacingSec: 4,
        rangeFloor: true,
    };
    const mk = (vt, K, iters) => ({...common, vTarget: vt, vSigma, K, iters});
    const searchK = options.searchK ?? 15, searchIters = options.searchIters ?? 3;
    const finalK = options.finalK ?? 25, finalIters = options.finalIters ?? 6;

    const scoreAt = (R, o) => {
        const {track} = traversePlausible(dataset, R, o);
        return {R, score: straightFlightScore(trackMetrics(dataset, track)), track};
    };

    const coarseSweep = (o) => {
        const logLo = Math.log(rangeMin), logHi = Math.log(rangeMax);
        const profile = [];
        let best = null;
        for (let i = 0; i < coarse; i++) {
            const R = Math.exp(logLo + (logHi - logLo) * i / (coarse - 1));
            const s = scoreAt(R, o);
            profile.push({startDist: R, score: s.score});
            if (!best || s.score < best.score) best = s;
        }
        return {profile, best};
    };

    // Stage 1: pure smoothness — let the geometry speak
    const pureSweep = coarseSweep(mk(null, searchK, searchIters));
    const scoresSorted = pureSweep.profile.map(p => p.score).sort((a, b) => a - b);
    const med = scoresSorted[Math.floor(scoresSorted.length / 2)];
    const decisiveness = med - pureSweep.best.score;
    const usedSpeedTarget = !(decisiveness > decisiveMargin);

    const vt = usedSpeedTarget ? vTarget : null;
    const searchOpts = mk(vt, searchK, searchIters);
    const finalOpts = mk(vt, finalK, finalIters);

    let {profile, best} = usedSpeedTarget ? coarseSweep(searchOpts) : pureSweep;

    // parabolic refine in log-range around the coarse minimum (2 passes)
    let loR = Math.max(rangeMin, best.R / 1.5);
    let hiR = Math.min(rangeMax, best.R * 1.5);
    for (let pass = 0; pass < 2; pass++) {
        const a = scoreAt(loR, searchOpts), b = best, c = scoreAt(hiR, searchOpts);
        const xa = Math.log(a.R), xb = Math.log(b.R), xc = Math.log(c.R);
        const fa = a.score, fb = b.score, fc = c.score;
        const denom = (xa - xb) * (fa - fc) - (xa - xc) * (fa - fb);
        let xv;
        if (Math.abs(denom) < 1e-12) break;
        xv = xb - 0.5 * ((xa - xb) * (xa - xb) * (fb - fc) - (xa - xc) * (xa - xc) * (fb - fa)) /
            ((xa - xb) * (fb - fc) - (xa - xc) * (fb - fa));
        if (!isFinite(xv)) break;
        const Rv = Math.min(rangeMax, Math.max(rangeMin, Math.exp(xv)));
        const v = scoreAt(Rv, searchOpts);
        if (v.score < best.score) best = v;
        loR = Math.max(rangeMin, best.R / 1.2);
        hiR = Math.min(rangeMax, best.R * 1.2);
    }

    // full-quality solve at the winning range
    const finalSolve = traversePlausible(dataset, best.R, finalOpts);
    return {
        track: finalSolve.track,
        lam: finalSolve.lam,
        startDist: best.R,
        score: straightFlightScore(trackMetrics(dataset, finalSolve.track)),
        profile: profile.slice().sort((a, b) => a.startDist - b.startDist),
        usedSpeedTarget,
        decisiveness,
    };
}

// Gaussian elimination with partial pivoting (small dense systems, K ~ 25)
function solveDense(A, b) {
    const nn = b.length;
    const M = A.map(row => Float64Array.from(row));
    const x = Float64Array.from(b);
    for (let col = 0; col < nn; col++) {
        let maxV = Math.abs(M[col][col]), maxR = col;
        for (let r = col + 1; r < nn; r++) {
            if (Math.abs(M[r][col]) > maxV) { maxV = Math.abs(M[r][col]); maxR = r; }
        }
        [M[col], M[maxR]] = [M[maxR], M[col]];
        const t = x[col]; x[col] = x[maxR]; x[maxR] = t;
        for (let r = col + 1; r < nn; r++) {
            const f = M[r][col] / M[col][col];
            if (f === 0) continue;
            for (let k = col; k < nn; k++) M[r][k] -= f * M[col][k];
            x[r] -= f * x[col];
        }
    }
    for (let i = nn - 1; i >= 0; i--) {
        let s = x[i];
        for (let k = i + 1; k < nn; k++) s -= M[i][k] * x[k];
        x[i] = s / M[i][i];
    }
    return x;
}

// ---------------------------------------------------------------------------
// Parametric fixed-wing aircraft fit
// ---------------------------------------------------------------------------

/**
 * Integrate the simple flight model.
 * params: [R0 (m along first ray), heading0 (deg true), TAS (m/s),
 *          turnRate0 (deg/s), turnAccel (deg/s^2), climb (m/s)]
 * Constant TAS through the air mass, heading integrates the (linearly varying)
 * turn rate, constant climb, position advected by the per-frame wind.
 * Returns Float64Array(n*3).
 */
export function simulateAircraft(dataset, params) {
    const {n, fps, S, D, W} = dataset;
    const [R0, h0, V, w0, wd, climb] = params;
    const track = new Float64Array(n * 3);
    let px = S[0] + D[0] * R0, py = S[1] + D[1] * R0, pz = S[2] + D[2] * R0;
    let psi = h0 * Math.PI / 180;
    const dt = 1 / fps;
    track[0] = px; track[1] = py; track[2] = pz;
    for (let f = 1; f < n; f++) {
        const t = f * dt;
        psi += (w0 + wd * t) * Math.PI / 180 * dt;
        px += V * Math.sin(psi) * dt + W[(f - 1) * 3];
        py += V * Math.cos(psi) * dt + W[(f - 1) * 3 + 1];
        pz += climb * dt + W[(f - 1) * 3 + 2];
        track[f * 3] = px; track[f * 3 + 1] = py; track[f * 3 + 2] = pz;
    }
    return track;
}

// Full-resolution mean angular error (degrees) of the aircraft model vs the
// LOS rays — per-frame forward integration. Used once for the final reported
// fit quality. For the optimizer inner loop use aircraftCostErrDeg (strided,
// O(n/stride)) instead.
function aircraftAngErrDeg(dataset, params, stride) {
    const {n, S, D, fps, W} = dataset;
    const [R0, h0, V, w0, wd, climb] = params;
    let px = S[0] + D[0] * R0, py = S[1] + D[1] * R0, pz = S[2] + D[2] * R0;
    let psi = h0 * Math.PI / 180;
    const dt = 1 / fps;
    let sum = 0, count = 1; // frame 0 has zero error by construction
    for (let f = 1; f < n; f++) {
        const t = f * dt;
        psi += (w0 + wd * t) * Math.PI / 180 * dt;
        px += V * Math.sin(psi) * dt + W[(f - 1) * 3];
        py += V * Math.cos(psi) * dt + W[(f - 1) * 3 + 1];
        pz += climb * dt + W[(f - 1) * 3 + 2];
        if (f % stride !== 0 && f !== n - 1) continue;
        const b = f * 3;
        let rx = px - S[b], ry = py - S[b + 1], rz = pz - S[b + 2];
        const rl = Math.hypot(rx, ry, rz);
        if (rl < 1) return 1e9;
        rx /= rl; ry /= rl; rz /= rl;
        const dot = Math.min(1, Math.max(-1, rx * D[b] + ry * D[b + 1] + rz * D[b + 2]));
        sum += Math.acos(dot);
        count++;
    }
    return sum / count * 180 / Math.PI;
}

// Cumulative per-frame wind displacement: cumW[f*3+c] = sum of W[0..f-1].
// Lets the strided cost advance the wind term over a whole block in O(1).
function cumulativeWind(dataset) {
    const {n, W} = dataset;
    const cumW = new Float64Array(n * 3);
    for (let f = 1; f < n; f++) {
        cumW[f * 3] = cumW[(f - 1) * 3] + W[(f - 1) * 3];
        cumW[f * 3 + 1] = cumW[(f - 1) * 3 + 1] + W[(f - 1) * 3 + 1];
        cumW[f * 3 + 2] = cumW[(f - 1) * 3 + 2] + W[(f - 1) * 3 + 2];
    }
    return cumW;
}

// Fast optimizer cost: integrate the model block-by-block over `costFrames`
// (midpoint heading per block — 2nd order, more accurate than the full-res
// forward Euler, and O(costFrames) instead of O(n)). cumW is cumulativeWind().
function aircraftCostErrDeg(dataset, params, costFrames, cumW) {
    const {S, D, fps} = dataset;
    const [R0, h0, V, w0, wd, climb] = params;
    let px = S[0] + D[0] * R0, py = S[1] + D[1] * R0, pz = S[2] + D[2] * R0;
    let psi = h0 * Math.PI / 180;
    const dtF = 1 / fps;
    let prevF = 0;
    let sum = 0, count = 1; // frame 0 exact by construction
    for (let ci = 1; ci < costFrames.length; ci++) {
        const f = costFrames[ci];
        const ta = prevF * dtF, tb = f * dtF;
        // heading change over the block: integral of (w0 + wd*t) dt (deg->rad)
        const dPsi = (w0 * (tb - ta) + 0.5 * wd * (tb * tb - ta * ta)) * Math.PI / 180;
        const psiMid = psi + 0.5 * dPsi;
        const dtB = tb - ta;
        px += V * Math.sin(psiMid) * dtB + (cumW[f * 3] - cumW[prevF * 3]);
        py += V * Math.cos(psiMid) * dtB + (cumW[f * 3 + 1] - cumW[prevF * 3 + 1]);
        pz += climb * dtB + (cumW[f * 3 + 2] - cumW[prevF * 3 + 2]);
        psi += dPsi;
        prevF = f;
        const b = f * 3;
        let rx = px - S[b], ry = py - S[b + 1], rz = pz - S[b + 2];
        const rl = Math.hypot(rx, ry, rz);
        if (rl < 1) return 1e9;
        rx /= rl; ry /= rl; rz /= rl;
        const dot = Math.min(1, Math.max(-1, rx * D[b] + ry * D[b + 1] + rz * D[b + 2]));
        sum += Math.acos(dot);
        count++;
    }
    return sum / count * 180 / Math.PI;
}

/**
 * Fit the fixed-wing model to the LOS data with soft plausibility targets.
 *
 * The cost is LOS angular error PLUS loose penalties expressing the
 * hypothesis ("a conventional aircraft in roughly straight, roughly level
 * cruise") — without them the pure-error fit is wildly ambiguous: nearly
 * perfect fits exist across a huge family of turning solutions.
 *
 * options:
 *   tasTarget/tasSigma   preferred speed (default 380 +- 150 kt)
 *   turnSigma            straightness looseness (default 0.5 deg/s)
 *   climbSigma           level-flight looseness (default 8 m/s)
 *   errSigma             LOS fit weight (default 0.02 deg per unit cost)
 *   rangeMin/rangeMax    search bounds for R0 (default 1..45 NM)
 *   runs, pop, gens      DE effort (defaults 3, 60, 150)
 *   progress(frac)       awaited between runs/generations
 *
 * Returns {params: {startDist, heading, tas, turnRate, turnAccel, climb},
 *          cost, errDeg, track, metrics, runs: [per-run summaries]}
 */
export async function fitAircraft(dataset, options = {}) {
    const tasTarget = options.tasTarget ?? 380 * KNOTS_TO_MS;
    const tasSigma = options.tasSigma ?? 150 * KNOTS_TO_MS;
    const turnSigma = options.turnSigma ?? 0.5;
    const climbSigma = options.climbSigma ?? 8;
    const errSigma = options.errSigma ?? 0.02;
    const rangeMin = options.rangeMin ?? 1 * METERS_PER_NM;
    const rangeMax = options.rangeMax ?? 45 * METERS_PER_NM;
    const nRuns = options.runs ?? 3;
    const pop = options.pop ?? 60;
    const gens = options.gens ?? 150;
    const T = dataset.n / dataset.fps;

    // Strided cost integration (block midpoint) keeps the many DE/polish
    // evaluations O(n/costStride) instead of O(n) — dominant cost at long clips.
    const costStride = Math.max(1, Math.floor(options.costStride ?? 5));
    const cumW = cumulativeWind(dataset);
    const costFrames = [];
    for (let f = 0; f < dataset.n; f += costStride) costFrames.push(f);
    if (costFrames[costFrames.length - 1] !== dataset.n - 1) costFrames.push(dataset.n - 1);

    const cost = (p) => {
        const e = aircraftCostErrDeg(dataset, p, costFrames, cumW);
        if (e > 1e8) return e;
        const wEnd = p[3] + p[4] * T;
        return (
            e / errSigma +
            (p[3] / turnSigma) ** 2 + (wEnd / turnSigma) ** 2 +
            (p[5] / climbSigma) ** 2 +
            ((p[2] - tasTarget) / tasSigma) ** 2
        );
    };

    // TAS floor 25 kt: FAR Part 103 caps ultralight power-off stall at 24 kt
    // CAS, so 25 kt is the slowest sustained flight of any legal fixed-wing.
    // (A 50 kt floor silently pinned slow scenes — e.g. a 43 kt target — at
    // the bound and forced multi-degree LOS errors.) TAS solved exactly AT
    // this floor is itself an implausibility signal.
    const lo = [rangeMin, 0, 25 * KNOTS_TO_MS, -4, -0.3, -40];
    const hi = [rangeMax, 360, 700 * KNOTS_TO_MS, 4, 0.3, 40];
    const runs = [];
    for (let r = 0; r < nRuns; r++) {
        const de = await differentialEvolution(cost, lo, hi, {
            pop, gens,
            // Report/yield only every 8th generation — hundreds of per-generation
            // setTimeout yields stall badly if the tab is backgrounded (Chrome
            // clamps hidden-tab timers), and add round-trip overhead even in the
            // foreground.
            onGeneration: options.progress
                ? async (g) => {
                    if (g % 8 === 0) await options.progress((r + g / gens) / nRuns);
                    return true;
                }
                : undefined,
        });
        // polish on the same strided cost (still 2nd-order accurate)
        const pol = patternSearchPolish(
            cost, de.params, [200, 0.5, 2, 0.02, 0.002, 0.5], {lo, hi});
        runs.push(pol);
    }
    runs.sort((a, b) => a.cost - b.cost);
    const best = runs[0];
    const track = simulateAircraft(dataset, best.params);
    const metrics = trackMetrics(dataset, track);
    const [R0, h0, V, w0, wd, climb] = best.params;
    return {
        params: {
            startDist: R0,
            heading: ((h0 % 360) + 360) % 360,
            tas: V,
            turnRate: w0,
            turnAccel: wd,
            climb,
        },
        cost: best.cost,
        errDeg: aircraftAngErrDeg(dataset, best.params, 1),
        track,
        metrics: summarizeMetrics(metrics),
        series: metrics.series,
        runs: runs.map(r => ({
            cost: r.cost,
            startDist: r.params[0], heading: ((r.params[1] % 360) + 360) % 360,
            tas: r.params[2], turnRate: r.params[3], turnAccel: r.params[4], climb: r.params[5],
        })),
    };
}
