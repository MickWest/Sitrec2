// Stage 2 of Star Track: frame-to-frame association and camera-motion recovery.
//
// Takes the per-frame point sources from StarDetect and works out how the camera moved between
// every consecutive pair, producing a cumulative transform that maps each frame into a common
// reference frame. Stage 3 uses those to decide which points are fixed stars.
//
// Pure: plain arrays in, plain objects out. No DOM, no THREE, no Sitrec globals.
//
// Transforms are complex similarities, q = A*p + B with A = (ax, ay) carrying rotation AND scale
// together. That form composes and inverts with two multiplies, which matters because the whole
// stage is built on chaining and un-chaining them. (Sitrec's CameraMotionFromVideo.js has an
// equivalent robust fit, but it is bound to THREE/Globals/par and exposes a {dx,dy,theta,scale}
// shape that neither composes nor inverts, so it cannot be reused here.)
//
// Three measurements on the real target clip shaped this design:
//
//  1. Matching MUST predict the motion first. Nearest-neighbour on raw positions biases every
//     match toward zero displacement, because a star's own previous position is a candidate for
//     its new one. Over 179 frames that under-estimated the pan by ~125 px - a systematic bias,
//     not a random walk, which at the observed per-fit precision would have given only ~5 px.
//
//  2. Stars move up to ~19 px between frames while being 20-30 px across, so a gate wide enough
//     to catch the motion is also wide enough to catch the wrong star. Prediction is what keeps
//     the gate tight.
//
//  3. Chaining accumulates error: over the 179-frame window the cumulative scale drifted to
//     1.033 on a fixed-zoom camera. Checked against geometry - a 400 px pan at that zoom is
//     ~2.5 deg off-axis, where a gnomonic projection gives sec^2 = 1.002 - so 3.3% is estimation
//     drift, not projection. The chain is an INITIALISATION; Stage 3 must refine it globally
//     against a shared star map.

export const STAR_MATCH_DEFAULTS = {
    // Robust fit: residual (px) beyond which a pair is treated as an outlier.
    inlierThreshold: 1.2,
    trimIterations: 8,
    minPairs: 3,
    // The first trimming pass uses this multiple of inlierThreshold, annealing down to 1.0. See
    // fitSimilarity for why a fixed threshold cannot separate a coherent stationary contaminant
    // from a small true motion.
    startThresholdFactor: 4.0,
    // Refit/re-mask passes after annealing, to settle the transform against its own inlier set.
    // Convergence is normally immediate. Set generously because a fixed point is what makes the
    // reported inlier set both unbiased and honest; cycling is caught explicitly, so this is a
    // backstop rather than the mechanism that stops the loop.
    finalRefits: 40,
    // Allow a scale degree of freedom. OFF by default: stars are at infinity, so only camera
    // ROTATION moves them, and a fixed-zoom camera's frame-to-frame mapping has no scale term.
    // Enabling it lets camera-fixed artifacts be absorbed rather than rejected.
    allowScale: false,

    // Predicted matching. The first round gates generously because the prediction may be stale
    // (a velocity change, or the first pair where there is no prediction at all); later rounds
    // tighten onto the fitted transform.
    gateInitial: 12,
    gateRefined: 5,
    matchRounds: 3,

    // Below these a frame's fit is not trusted and re-acquisition is attempted.
    minInliers: 6,
    minInlierFraction: 0.4,

    // Triangle-invariant re-acquisition.
    triangleBrightest: 14,      // how many of the brightest sources take part
    triangleNeighbours: 5,      // nearest neighbours each source forms triangles with
    triangleTolerance: 0.03,    // side-ratio agreement required between two triangles
    triangleMinVotes: 2,        // vertex correspondences needed before a pair is believed
    // Corroboration required before an invariant-only fit is believed. Unrelated fields produce
    // a dozen coincidental triangle matches, and fitting those invents large camera motion.
    invariantMinInliers: 5,
    invariantMinInlierFraction: 0.5,

    // Translation-consensus re-acquisition (offset voting): the bridge of last resort when both
    // prediction and triangles fail. Bin width trades peak sharpness against vote splitting;
    // the offset cap bounds the hypothesis space to displacements a bridged gap could plausibly
    // contain; the vote gates mirror the invariant path's "corroborated, not merely produced"
    // standard at the histogram stage.
    offsetVoteBin: 6,
    offsetVoteMinVotes: 5,
    offsetVoteMinFraction: 0.25,
    offsetVoteMaxOffset: 150,
    // The vote is quadratic in source count and runs on every frame pair, so it votes on the
    // brightest K per side - consensus needs the anchor stars, not the full population, and an
    // uncapped dense frame (thousands of detections) would stall the synchronous solve. The
    // seeded REFIT still runs against the full populations, so the returned inlier count stays
    // comparable with the other matchers'.
    offsetVoteMaxSources: 60,

    // Bridging tries the most recent trusted frames, newest first, not only the very last one.
    // The frame at the edge of an outage is often itself degraded - it is the tail end of the
    // blur that CAUSED the outage - and anchoring every retry to it walls off a recovery that
    // any other recent frame would provide.
    bridgeAnchorPool: 8,
    bridgeAnchorTries: 4,

    // Camera-fixed artifact removal (hot pixels, dust, reticle).
    excludeCameraFixed: true,
    fixedRadius: 2.0,           // px: how close across frames counts as the same fixed position
    fixedMinFraction: 0.6,      // present in at least this share of frames
    // Above this share of ALL detections being fixed, refuse to strip them: whatever the cause,
    // removing nearly everything cannot be right. This is only a backstop - solveFrameChain
    // decides whether the camera moves at all before it asks what is camera-fixed, because with a
    // still camera no fraction of detections can distinguish a star from a hot pixel.
    fixedMaxFraction: 0.85,
    // Corner motion (px) over the clip below which the camera is treated as stationary, and no
    // artifact removal is attempted.
    staticMotionThreshold: 6.0,
};

/** Identity transform. */
export const IDENTITY = {A: [1, 0], B: [0, 0]};

/** q = A*p + B. */
export function applyTransform(T, x, y) {
    return [T.A[0] * x - T.A[1] * y + T.B[0], T.A[1] * x + T.A[0] * y + T.B[1]];
}

/** p = (q - B) / A. */
export function invertTransform(T) {
    const [ax, ay] = T.A;
    const d = ax * ax + ay * ay;
    if (d < 1e-12) return null;
    const iA = [ax / d, -ay / d];
    // -(iA * B)
    const bx = iA[0] * T.B[0] - iA[1] * T.B[1];
    const by = iA[1] * T.B[0] + iA[0] * T.B[1];
    return {A: iA, B: [-bx, -by]};
}

/** The transform equivalent to applying C first, then S. */
export function composeTransform(S, C) {
    const ax = S.A[0] * C.A[0] - S.A[1] * C.A[1];
    const ay = S.A[0] * C.A[1] + S.A[1] * C.A[0];
    const bx = S.A[0] * C.B[0] - S.A[1] * C.B[1] + S.B[0];
    const by = S.A[1] * C.B[0] + S.A[0] * C.B[1] + S.B[1];
    return {A: [ax, ay], B: [bx, by]};
}

/** Human-readable parameters: rotation in radians, uniform scale, and the translation. */
export function transformParams(T) {
    return {
        rotation: Math.atan2(T.A[1], T.A[0]),
        scale: Math.hypot(T.A[0], T.A[1]),
        tx: T.B[0],
        ty: T.B[1],
    };
}

/**
 * One weighted complex least-squares solution of q = A*p + B.
 *
 * With `unitScale` the modulus of A is constrained to 1, giving a rotation and translation only.
 *
 * The justification, stated carefully because the exact statement matters:
 *
 * Stars are at infinity, so moving the camera through space produces no parallax whatsoever -
 * only ROTATING it moves them in the image. A camera with fixed intrinsics K rotating by R maps
 * one frame to the next by the HOMOGRAPHY H = K R K^-1. That is not a rigid 2D transform in
 * general: under a gnomonic projection, swinging the boresight changes the local scale across the
 * field. A rotation + translation is the SMALL-ANGLE, NARROW-FIELD approximation to it.
 *
 * That approximation is a good one for the footage this is built for, and the size of the error is
 * measurable rather than assumed: on the target clip a 400 px excursion is ~2.5 deg off-axis,
 * where the gnomonic scale factor sec^2 comes to 1.002 - two parts in a thousand. The cumulative
 * scale actually observed over that window was 1.033, sixteen times larger, so what a free scale
 * parameter was absorbing there was overwhelmingly estimation error rather than real projection.
 *
 * And a free scale is not merely redundant, it is a loophole. With stars moving and camera-fixed
 * artifacts (hot pixels, sensor dust, a reticle) standing still, a scaling about some centre
 * partially reconciles the two contradictory populations, so the artifacts get absorbed instead of
 * rejected. Measured on a synthetic clip with six hot pixels, the free-scale fit recovered 22.5 px
 * of a commanded 38 px motion and inflated scale to 1.068; constrained, the same scene solves.
 *
 * Under the |A| = 1 constraint the least-squares optimum is exactly the unit complex number
 * aligned with the cross-correlation sum - the constrained solve itself is exact, whatever the
 * modelling approximation above.
 *
 * For wide fields or large excursions this model IS biased, and `allowScale` does not repair it -
 * a homography needs eight parameters, not four. The proper treatment is Stage 3's global solve
 * over per-frame camera orientation and a shared focal length, which drops the 2D chain entirely.
 */
function weightedSimilarity(P, Q, w, unitScale) {
    let sw = 0, pbx = 0, pby = 0, qbx = 0, qby = 0;
    for (let i = 0; i < P.length; i++) {
        const wi = w[i];
        if (wi <= 0) continue;
        sw += wi;
        pbx += wi * P[i][0]; pby += wi * P[i][1];
        qbx += wi * Q[i][0]; qby += wi * Q[i][1];
    }
    if (sw < 1e-9) return null;
    pbx /= sw; pby /= sw; qbx /= sw; qby /= sw;

    let nre = 0, nim = 0, dd = 0;
    for (let i = 0; i < P.length; i++) {
        const wi = w[i];
        if (wi <= 0) continue;
        const px = P[i][0] - pbx, py = P[i][1] - pby;
        const qx = Q[i][0] - qbx, qy = Q[i][1] - qby;
        nre += wi * (qx * px + qy * py);
        nim += wi * (qy * px - qx * py);
        dd += wi * (px * px + py * py);
    }
    if (dd < 1e-9) return null;
    let ax, ay;
    if (unitScale) {
        const m = Math.hypot(nre, nim);
        if (m < 1e-12) return null;
        ax = nre / m; ay = nim / m;
    } else {
        ax = nre / dd; ay = nim / dd;
    }
    return {A: [ax, ay], B: [qbx - (ax * pbx - ay * pby), qby - (ay * pbx + ax * pby)]};
}

/**
 * Robust similarity fit by trimmed least squares.
 *
 * Deterministic by design. RANSAC would give run-to-run variance for no benefit here: the star
 * field is overwhelmingly inliers once matching is predicted, so a few reweighting passes reject
 * the handful of bad pairs without any sampling.
 *
 * @returns {{A:number[], B:number[], inliers:number, n:number, rms:number,
 *   converged:boolean, inlierMask:number[]}|null}
 *   `inlierMask` is 1 for each of the `n` input pairs within `inlierThreshold` of the returned
 *   transform, and `inliers` is its sum. `converged` is true when the trimming reached a fixed
 *   point, in which case that mask is also exactly the set the transform was fitted to.
 */
export function fitSimilarity(P, Q, opts = {}) {
    const O = {...STAR_MATCH_DEFAULTS, ...opts};
    const n = P.length;
    if (n < O.minPairs) return null;

    const thr2 = O.inlierThreshold * O.inlierThreshold;

    // Seed the weights from a MEDIAN-TRANSLATION consensus rather than starting from "everything
    // counts". Trimmed least squares is only robust once it is near the right answer: an
    // unweighted first pass over 33% gross outliers lands several pixels off, and the first
    // rejection round then throws away the good pairs along with the bad, leaving the loop stuck
    // on the wrong model with no inliers at all. The median of the per-pair displacements
    // tolerates almost 50% outliers and costs one sort, so the trimming starts somewhere sane.
    //
    // Translation-only is enough as a seed: frame-to-frame rotation is small, and where it is not
    // (invariant re-acquisition) the pairs arriving here are already clean.
    let w = new Array(n).fill(1);
    {
        const dxs = new Array(n), dys = new Array(n);
        for (let i = 0; i < n; i++) { dxs[i] = Q[i][0] - P[i][0]; dys[i] = Q[i][1] - P[i][1]; }
        const sx = dxs.slice().sort((a, b) => a - b);
        const sy = dys.slice().sort((a, b) => a - b);
        const mx = sx[n >> 1], my = sy[n >> 1];
        const seedThr = O.inlierThreshold * O.startThresholdFactor;
        let kept = 0;
        for (let i = 0; i < n; i++) {
            const keep = Math.hypot(dxs[i] - mx, dys[i] - my) < seedThr ? 1 : 0;
            w[i] = keep;
            kept += keep;
        }
        // If the seed is unusable (a genuinely large rotation makes translations disagree),
        // fall back to weighting everything and let the trimming sort it out.
        if (kept < O.minPairs) w = new Array(n).fill(1);
    }

    let res = null;
    for (let it = 0; it < O.trimIterations; it++) {
        const next = weightedSimilarity(P, Q, w, !O.allowScale);
        if (!next) break;
        res = next;
        // The rejection threshold starts wide and tightens toward inlierThreshold.
        //
        // A fixed threshold cannot separate a COHERENT contaminant from signal when the true
        // motion is small. Camera-fixed artifacts sit at zero displacement, so if the frame moved
        // only 2.5 px the first unweighted fit lands near 2.0 px - putting the artifacts right on
        // the boundary, half in and half out, and the result oscillates. Annealing lets the fit
        // find the dominant consensus first and then squeeze the stragglers out of it.
        const f = it / Math.max(1, O.trimIterations - 1);
        const scale = O.startThresholdFactor + (1 - O.startThresholdFactor) * f;
        const t2 = thr2 * scale * scale;
        let inl = 0;
        for (let i = 0; i < n; i++) {
            const e = applyTransform(res, P[i][0], P[i][1]);
            const ex = e[0] - Q[i][0], ey = e[1] - Q[i][1];
            const keep = (ex * ex + ey * ey) < t2 ? 1 : 0;
            w[i] = keep;
            if (keep) inl++;
        }
        if (inl < O.minPairs) break;
    }
    if (!res) return null;

    // Settle the fit and its own inlier set against each other before returning.
    //
    // The annealing loop fits, then updates the weights from that fit, so the last mask it
    // computes is never used - the transform would be fitted with one-iteration-old weights and
    // still carry the pull of pairs already rejected. But a single corrective refit is not enough
    // either: refitting moves the model, which can change which pairs fall inside the threshold,
    // and counting that new mask without refitting again leaves the same inconsistency one step
    // further on. On reachable data that costs about half a pixel between the returned transform
    // and the true optimum for the inliers it reports.
    //
    // Iterating to a fixed point makes the guarantee exact: what comes back is the least-squares
    // fit of precisely the pairs it reports as inliers. Small enough to matter only in aggregate -
    // which is the point, since these compose across hundreds of frames.
    // Iterate fit -> re-threshold to a FIXED POINT, where both properties hold at once:
    //   (a) the transform is the least-squares fit of the pairs reported as inliers, so rejected
    //       pairs contribute no bias - the thing that shows up as chain drift; and
    //   (b) every pair reported as an inlier really is within inlierThreshold of the transform,
    //       so `inliers` means what its consumers assume. Downstream strength and corroboration
    //       checks gate on that count, and an inflated one overstates how well a frame is
    //       supported - which is a safety problem, not a cosmetic one.
    //
    // Neither a fixed cap nor "fit the reported mask and stop" delivers both: a cap cannot promise
    // a fixed point (a 37-pair sample needs eight passes where six were allowed), and closing on
    // an un-rethresholded mask buys (a) by breaking (b).
    //
    // Termination is guaranteed by cycle detection rather than by a low cap: the mask is a finite
    // object, so a non-converging iteration must eventually repeat one. On a cycle - or the
    // generous cap - the returned transform is still fitted to a mask, and the mask is then
    // re-thresholded so (b) holds regardless; only (a) degrades, and `converged: false` says so.
    let converged = false;
    const seen = new Set();
    for (let k = 0; k < O.finalRefits; k++) {
        const refit = weightedSimilarity(P, Q, w, !O.allowScale);
        if (!refit) break;
        res = refit;
        const next = new Array(n);
        let changed = false, inl = 0;
        for (let i = 0; i < n; i++) {
            const e = applyTransform(res, P[i][0], P[i][1]);
            const ex = e[0] - Q[i][0], ey = e[1] - Q[i][1];
            const keep = (ex * ex + ey * ey) < thr2 ? 1 : 0;
            next[i] = keep;
            if (keep !== w[i]) changed = true;
            inl += keep;
        }
        if (inl < O.minPairs) break;      // keep the previous mask; nothing to refit onto
        if (!changed) { w = next; converged = true; break; }
        const sig = next.join("");
        if (seen.has(sig)) { w = next; break; }   // cycling: stop rather than spin
        seen.add(sig);
        w = next;
    }

    // Report the threshold set of the transform actually returned, so `inliers` never overstates
    // agreement. At a fixed point this is exactly the mask that was fitted.
    let inliers = 0, sse = 0;
    const mask = new Array(n);
    for (let i = 0; i < n; i++) {
        const e = applyTransform(res, P[i][0], P[i][1]);
        const ex = e[0] - Q[i][0], ey = e[1] - Q[i][1];
        const r2 = ex * ex + ey * ey;
        const keep = r2 < thr2 ? 1 : 0;
        mask[i] = keep;
        if (keep) { inliers++; sse += r2; }
    }
    w = mask;

    // A model that ends up explaining fewer than minPairs of its own correspondences has not
    // found a consensus, it has found a coincidence. Three mismatched pairs can be fitted exactly
    // in the least-squares sense and then agree with nothing, reporting zero inliers and an
    // infinite residual - which, returned, gets accumulated as camera motion.
    if (inliers < O.minPairs) return null;

    return {
        A: res.A, B: res.B,
        inliers, n, converged,
        inlierMask: w,
        rms: Math.sqrt(sse / inliers),
    };
}

/**
 * Greedy mutually-exclusive nearest-neighbour pairing within a gate.
 *
 * Assigning each source its own nearest counterpart independently lets several sources claim the
 * same partner, which quietly injects wrong pairs into the fit. Sorting every candidate pair by
 * distance and consuming greedily gives each source at most one partner.
 */
function pairWithinGate(from, to, gate) {
    const g2 = gate * gate;

    // Gate-sized spatial hash of the target points: each source point examines only the 3x3
    // cell neighbourhood, which contains every point within the gate by construction. This is
    // what keeps the WHOLE chain's pairing near-linear - the prediction matcher runs on every
    // frame pair, and a dense frame under brute-force O(nA*nB) pairing stalls the synchronous
    // solve. The d2 filter below is exact, so a hash-key collision (merged cells) only costs a
    // distance check, never a wrong pair. The cell uses |gate| to stay consistent with g2,
    // which is sign-blind - a (nonsense) negative gate keeps behaving as its absolute radius
    // rather than silently matching nothing.
    const cell = Math.max(Math.abs(gate), 1e-6);
    const grid = new Map();
    for (let j = 0; j < to.length; j++) {
        const key = (Math.floor(to[j][0] / cell) + 50000) * 100000
            + (Math.floor(to[j][1] / cell) + 50000);
        let bucket = grid.get(key);
        if (!bucket) grid.set(key, bucket = []);
        bucket.push(j);
    }

    const cands = [];
    for (let i = 0; i < from.length; i++) {
        const cx = Math.floor(from[i][0] / cell), cy = Math.floor(from[i][1] / cell);
        for (let ox = -1; ox <= 1; ox++) {
            for (let oy = -1; oy <= 1; oy++) {
                const bucket = grid.get((cx + ox + 50000) * 100000 + (cy + oy + 50000));
                if (!bucket) continue;
                for (const j of bucket) {
                    const dx = from[i][0] - to[j][0], dy = from[i][1] - to[j][1];
                    const d2 = dx * dx + dy * dy;
                    if (d2 <= g2) cands.push([d2, i, j]);
                }
            }
        }
    }

    // Ties broken by index, so the greedy assignment is a function of the POINTS, not of the
    // order the grid happened to surface candidates in.
    cands.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
    const usedI = new Set(), usedJ = new Set();
    const pairs = [];
    for (const [, i, j] of cands) {
        if (usedI.has(i) || usedJ.has(j)) continue;
        usedI.add(i); usedJ.add(j);
        pairs.push([i, j]);
    }
    return pairs;
}

/**
 * Match two frames' sources given a predicted transform, then refine.
 *
 * Each round maps the previous frame's sources through the current transform estimate, pairs them
 * against the new frame inside a gate, and refits. The gate tightens after the first round: it
 * starts wide enough to tolerate a stale prediction and closes onto the fitted solution.
 *
 * @param {Array} prev - sources in the earlier frame, each {x, y}
 * @param {Array} cur - sources in the later frame
 * @param {object|null} predicted - starting transform estimate, or null for identity
 * @returns {{transform:object, fit:object, pairs:Array}|null}
 */
export function matchByPrediction(prev, cur, predicted, opts = {}) {
    const O = {...STAR_MATCH_DEFAULTS, ...opts};
    if (prev.length < O.minPairs || cur.length < O.minPairs) return null;

    let T = predicted || IDENTITY;
    let best = null;
    for (let round = 0; round < O.matchRounds; round++) {
        const moved = prev.map((s) => applyTransform(T, s.x, s.y));
        const target = cur.map((s) => [s.x, s.y]);
        const gate = round === 0 ? O.gateInitial : O.gateRefined;
        const pairs = pairWithinGate(moved, target, gate);
        if (pairs.length < O.minPairs) break;

        // Fit maps the ORIGINAL previous positions to the new ones, not the already-moved ones.
        const P = pairs.map(([i]) => [prev[i].x, prev[i].y]);
        const Q = pairs.map(([, j]) => [cur[j].x, cur[j].y]);
        const fit = fitSimilarity(P, Q, O);
        if (!fit) break;
        T = {A: fit.A, B: fit.B};
        best = {transform: T, fit, pairs};
    }
    return best;
}

/**
 * Triangle side-ratio descriptors for a set of points.
 *
 * The two shorter/longest side ratios of a triangle are unchanged by translation, rotation and
 * uniform scale, which is exactly the transform family the camera applies. Matching on them
 * therefore needs no prior estimate of the motion at all - which is what makes this usable to
 * bootstrap the first frame pair, and to re-acquire after the laser sweeps a star field away.
 * (This is the classical astrometric pattern match, as in Groth 1986 and Valdes 1995.)
 */
function buildTriangles(pts, O) {
    const tris = [];
    const n = pts.length;
    for (let i = 0; i < n; i++) {
        // Nearest neighbours of i, so triangles stay local and survive a partial field of view.
        const order = [];
        for (let j = 0; j < n; j++) {
            if (j === i) continue;
            const dx = pts[i][0] - pts[j][0], dy = pts[i][1] - pts[j][1];
            order.push([dx * dx + dy * dy, j]);
        }
        order.sort((a, b) => a[0] - b[0]);
        const near = order.slice(0, O.triangleNeighbours).map((o) => o[1]);
        for (let a = 0; a < near.length; a++) {
            for (let b = a + 1; b < near.length; b++) {
                const idx = [i, near[a], near[b]];
                const d = [
                    Math.hypot(pts[idx[1]][0] - pts[idx[2]][0], pts[idx[1]][1] - pts[idx[2]][1]),
                    Math.hypot(pts[idx[0]][0] - pts[idx[2]][0], pts[idx[0]][1] - pts[idx[2]][1]),
                    Math.hypot(pts[idx[0]][0] - pts[idx[1]][0], pts[idx[0]][1] - pts[idx[1]][1]),
                ];
                // Order the vertices by the length of the side OPPOSITE them. That ordering is
                // itself invariant, so two matching triangles line up vertex-for-vertex without
                // needing to try all six permutations.
                const ord = [0, 1, 2].sort((p, q) => d[p] - d[q]);
                const s = ord.map((k) => d[k]);
                if (s[2] < 1e-6) continue;
                // Degenerate (near-collinear) triangles carry no reliable orientation.
                if (s[0] / s[2] < 0.05) continue;
                tris.push({
                    v: ord.map((k) => idx[k]),
                    r1: s[0] / s[2],
                    r2: s[1] / s[2],
                });
            }
        }
    }
    return tris;
}

/**
 * Correspondences between two source lists using triangle invariants alone.
 *
 * @returns {Array<[number,number]>} index pairs into `a` and `b`
 */
export function triangleMatch(a, b, opts = {}) {
    const O = {...STAR_MATCH_DEFAULTS, ...opts};
    // Brightest first: faint detections are the least reliable and would swamp the vote.
    const pick = (list) => list
        .map((s, i) => ({i, f: s.flux ?? s.area ?? 0}))
        .sort((p, q) => q.f - p.f)
        .slice(0, O.triangleBrightest)
        .map((p) => p.i);
    const ia = pick(a), ib = pick(b);
    if (ia.length < 3 || ib.length < 3) return [];

    const pa = ia.map((i) => [a[i].x, a[i].y]);
    const pb = ib.map((i) => [b[i].x, b[i].y]);
    const ta = buildTriangles(pa, O);
    const tb = buildTriangles(pb, O);

    // Vote for vertex correspondences over every pair of triangles whose invariants agree.
    const votes = new Map();
    const tol = O.triangleTolerance;
    for (const A of ta) {
        for (const B of tb) {
            if (Math.abs(A.r1 - B.r1) > tol || Math.abs(A.r2 - B.r2) > tol) continue;
            for (let k = 0; k < 3; k++) {
                const key = A.v[k] * 100000 + B.v[k];
                votes.set(key, (votes.get(key) || 0) + 1);
            }
        }
    }

    // Keep the best-supported, mutually exclusive correspondences.
    const ranked = [...votes.entries()]
        .map(([key, v]) => [v, Math.floor(key / 100000), key % 100000])
        .filter(([v]) => v >= O.triangleMinVotes)
        .sort((p, q) => q[0] - p[0]);
    const usedA = new Set(), usedB = new Set();
    const pairs = [];
    for (const [, ai, bi] of ranked) {
        if (usedA.has(ai) || usedB.has(bi)) continue;
        usedA.add(ai); usedB.add(bi);
        pairs.push([ia[ai], ib[bi]]);
    }
    return pairs;
}

/**
 * Re-acquire a frame pair with no usable prediction, via triangle invariants.
 *
 * The returned fit must be CORROBORATED, not merely produced. Two unrelated star fields still
 * yield a dozen triangle correspondences by coincidence - the descriptors are only two numbers, so
 * chance agreement is common - and fitting those gives a confident-looking transform describing a
 * large camera motion that never happened. Left unchecked that turns a scene cut or a dropout into
 * invented motion, which is far worse than admitting defeat. So a fit is only accepted when enough
 * of its own correspondences actually agree with it.
 */
export function matchByInvariants(prev, cur, opts = {}) {
    const O = {...STAR_MATCH_DEFAULTS, ...opts};
    const pairs = triangleMatch(prev, cur, O);
    if (pairs.length < O.minPairs) return null;
    const P = pairs.map(([i]) => [prev[i].x, prev[i].y]);
    const Q = pairs.map(([, j]) => [cur[j].x, cur[j].y]);
    const fit = fitSimilarity(P, Q, O);
    if (!fit) return null;
    // Corroboration must come from a settled fit. An unconverged one is fitted to a neighbouring
    // mask, so its inlier count is not evidence that the correspondences genuinely agree - and
    // this is the path that turns coincidental triangle matches into invented camera motion.
    if (!fit.converged) return null;
    if (fit.inliers < O.invariantMinInliers) return null;
    if (fit.inliers < O.invariantMinInlierFraction * fit.n) return null;
    return {transform: {A: fit.A, B: fit.B}, fit, pairs};
}

/**
 * Re-acquire a frame pair by TRANSLATION CONSENSUS when triangles cannot.
 *
 * Triangle invariants pick their vertices from the brightest sources, so they die precisely in
 * the situation that creates long re-acquisition gaps in real footage: a motion-blurred stretch
 * scrambles the brightness ranking (bright stars smear and fragment, faint ones vanish), and the
 * two frames' "brightest fourteen" barely intersect even though most of the FIELD is shared.
 * Position consensus does not care about ranking. Every cross-frame source pair votes for the
 * offset it implies; when the frames genuinely share a star field displaced by a roughly
 * constant translation, the true offset collects a vote from every shared star while unrelated
 * pairs scatter theirs. (Rotation over the few-frame gaps this bridges is far below the bin
 * width at the arm lengths involved, so a pure-translation histogram still concentrates.)
 *
 * The voted offset is only a HYPOTHESIS. It seeds the standard predicted match-and-refine, and
 * the resulting fit must clear the same corroboration gates as an invariant re-acquisition -
 * "corroborated, not merely produced" applies to a histogram peak exactly as it does to
 * coincidental triangle votes, and an uncorroborated peak (a periodic field's alias, two
 * unrelated dense fields) is refused rather than composed into the chain.
 */
export function matchByOffsetVote(prev, cur, opts = {}) {
    const O = {...STAR_MATCH_DEFAULTS, ...opts};
    if (prev.length < O.minPairs || cur.length < O.minPairs) return null;

    // Bound the quadratic voting stage to the brightest sources per side.
    const cap = (list) => (list.length <= O.offsetVoteMaxSources ? list
        : [...list]
            .sort((a, b) => (b.flux ?? b.area ?? 0) - (a.flux ?? a.area ?? 0))
            .slice(0, O.offsetVoteMaxSources));
    const pv = cap(prev), cv = cap(cur);

    // Each pair votes into its bin AND the next one up in each axis, so a cluster of true
    // offsets straddling a bin edge still lands together in at least one bin.
    const bin = O.offsetVoteBin;
    const votes = new Map();
    for (const p of pv) {
        for (const q of cv) {
            const dx = q.x - p.x, dy = q.y - p.y;
            if (Math.abs(dx) > O.offsetVoteMaxOffset || Math.abs(dy) > O.offsetVoteMaxOffset) continue;
            // +500 keeps both bin indices positive (offsets are capped well inside +/-500 bins),
            // so the packed key cannot collide across axes for negative offsets.
            const kx = Math.floor(dx / bin) + 500, ky = Math.floor(dy / bin) + 500;
            for (let ox = 0; ox <= 1; ox++) {
                for (let oy = 0; oy <= 1; oy++) {
                    const key = (kx + ox) * 100000 + (ky + oy);
                    votes.set(key, (votes.get(key) || 0) + 1);
                }
            }
        }
    }
    if (votes.size === 0) return null;

    let bestKey = null, bestVotes = 0;
    for (const [key, v] of votes) {
        if (v > bestVotes) { bestVotes = v; bestKey = key; }
    }
    const needed = Math.max(O.offsetVoteMinVotes,
        Math.ceil(O.offsetVoteMinFraction * Math.min(pv.length, cv.length)));
    if (bestVotes < needed) return null;

    // The winning bin covers floor(d/bin) in {k-1, k}; gather the offsets that voted for it and
    // take their MEDIAN as the seed - robust to the unrelated pairs that happened to land there.
    const kx = Math.floor(bestKey / 100000) - 500, ky = (bestKey % 100000) - 500;
    const dxs = [], dys = [];
    for (const p of pv) {
        for (const q of cv) {
            const dx = q.x - p.x, dy = q.y - p.y;
            const fx = Math.floor(dx / bin), fy = Math.floor(dy / bin);
            if ((fx === kx || fx === kx - 1) && (fy === ky || fy === ky - 1)) {
                dxs.push(dx); dys.push(dy);
            }
        }
    }
    if (dxs.length < O.minPairs) return null;
    const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
    const seed = {A: [1, 0], B: [med(dxs), med(dys)]};

    const m = matchByPrediction(prev, cur, seed, O);
    if (!m) return null;
    if (!m.fit.converged) return null;
    if (m.fit.inliers < O.invariantMinInliers) return null;
    if (m.fit.inliers < O.invariantMinInlierFraction * m.fit.n) return null;
    return m;
}

/** Largest corner displacement a transform produces over a frame of the given size. */
function motionMagnitude(T, W, H) {
    let worst = 0;
    for (const [x, y] of [[0, 0], [W, 0], [0, H], [W, H]]) {
        const p = applyTransform(T, x, y);
        worst = Math.max(worst, Math.hypot(p[0] - x, p[1] - y));
    }
    return worst;
}

/**
 * Find sources that are fixed in CAMERA coordinates rather than on the sky.
 *
 * Hot pixels, sensor dust, a lens smudge, a burnt-in reticle: all sit at the same pixel position
 * in every frame while the star field slides past. That makes them trivially identifiable - and
 * removing them matters more than it first appears, because they are not random noise. They form
 * a large, perfectly COHERENT cluster at zero displacement, which is exactly the contaminant
 * robust fitting handles worst: trimming assumes outliers disagree with each other, and these
 * agree emphatically. Measured on a synthetic clip, six hot pixels among sixteen detections cost
 * 16-23% of the recovered motion even with a unit-scale constraint and annealed trimming.
 *
 * The obvious trap is a camera that is not moving, where every star also holds its pixel position
 * and the test would strip the entire field. Guarded by requiring that the supposedly-fixed set
 * stays a minority: if most sources look fixed, the camera is simply still and none are removed.
 *
 * @returns {{fixed: Array<Set<number>>, clusters: Array, applied: boolean}}
 *   `fixed[f]` holds the indices of camera-fixed sources in frame f.
 */
export function findCameraFixed(perFrame, opts = {}) {
    const O = {...STAR_MATCH_DEFAULTS, ...opts};
    const nFrames = perFrame.length;
    const fixed = perFrame.map(() => new Set());
    if (nFrames < 3) return {fixed, clusters: [], applied: false};

    // Greedy clustering on RAW pixel position, across the whole clip.
    const clusters = [];
    const r2 = O.fixedRadius * O.fixedRadius;
    for (let f = 0; f < nFrames; f++) {
        for (let i = 0; i < perFrame[f].length; i++) {
            const s = perFrame[f][i];
            let best = null, bd = r2;
            for (const c of clusters) {
                const d2 = (c.x - s.x) * (c.x - s.x) + (c.y - s.y) * (c.y - s.y);
                if (d2 < bd) { bd = d2; best = c; }
            }
            if (best) {
                best.members.push([f, i]);
                best.frames.add(f);
                // Running mean keeps the cluster centred as members accumulate.
                best.x += (s.x - best.x) / best.members.length;
                best.y += (s.y - best.y) / best.members.length;
            } else {
                clusters.push({x: s.x, y: s.y, members: [[f, i]], frames: new Set([f])});
            }
        }
    }

    const candidates = clusters.filter((c) => c.frames.size >= O.fixedMinFraction * nFrames);
    const inCandidates = candidates.reduce((a, c) => a + c.members.length, 0);
    const total = perFrame.reduce((a, d) => a + d.length, 0);

    // Distinguish "the camera is not moving" from "artifacts happen to outnumber the stars".
    //
    // A static camera holds ESSENTIALLY EVERY source at a fixed position, so the giveaway is that
    // near-100% of detections fall in persistent clusters - not merely a majority. A blunt
    // "more than half look fixed" rule misfires badly on a sparse field: six hot pixels among ten
    // detections is 60%, which is artifact domination rather than a still camera, and refusing to
    // strip them there let the chain drift 40 px over twenty frames.
    //
    // The second condition is the practical one: whatever the ratio, enough sources must survive
    // to fit a transform at all.
    // Judged on the TYPICAL frame, not the worst one. A single blank or unusually sparse frame -
    // an undecoded frame, or one the laser swept across - would otherwise drive the minimum to
    // zero and switch artifact removal off for the entire clip, leaving hot pixels to corrupt
    // every other frame because one frame was empty.
    const remaining = perFrame
        .map((d, f) => d.length - candidates
            .reduce((a, c) => a + c.members.filter(([mf]) => mf === f).length, 0))
        .sort((a, b) => a - b);
    const medianRemaining = remaining.length ? remaining[remaining.length >> 1] : 0;
    const applied = total > 0
        && inCandidates <= O.fixedMaxFraction * total
        && medianRemaining >= O.minPairs;
    if (applied) {
        for (const c of candidates) {
            for (const [f, i] of c.members) fixed[f].add(i);
        }
    }
    return {fixed, clusters: candidates, applied};
}

/**
 * Solve the whole clip: per-pair transforms, and the cumulative transform from frame 0 to each.
 *
 * Prediction carries forward the previous pair's transform, which is what removes the
 * zero-displacement bias. When a pair's fit is too weak to trust - the laser sweeping through, a
 * dropout, an abrupt jerk - it falls back to triangle invariants, which need no prediction at all.
 *
 * @param {Array<Array>} perFrame - detections per frame, each entry an array of {x, y, flux}
 * @returns {{steps:Array, cumulative:Array, reacquired:number[], failed:number[]}}
 *   `cumulative[f]` maps frame-0 coordinates into frame f.
 */
function solveChainOnce(usable, O) {
    const n = usable.length;
    const steps = new Array(n).fill(null);
    const cumulative = new Array(n).fill(null);
    const reacquired = [];
    const failed = [];
    const weakFrames = [];
    if (n === 0) return {steps, cumulative, reacquired, failed, weakFrames};

    cumulative[0] = IDENTITY;
    let prediction = null;
    // The most recent frame whose position in the reference frame we actually trust. Bridging back
    // to it is what stops a dropout from permanently losing the motion across the gap.
    let lastGood = 0;
    // Recent STRONGLY-fitted frames, oldest first: the alternative bridge anchors. lastGood alone
    // is not enough - a weakly-accepted frame at the edge of an outage (the tail of the blur that
    // caused it) can become lastGood and then fail every bridge attempt, walling off a recovery
    // that any well-detected frame a few steps earlier would provide. Measured on the real clip
    // this converts a 197-frame permanent outage into a 2-frame gap.
    const anchorPool = [0];

    // A fit that never reached a fixed point is NOT trusted, however many inliers it reports.
    //
    // Outside a fixed point only the honesty of the inlier set is preserved; the transform is the
    // least-squares fit of a neighbouring mask rather than of the one reported, so pairs the
    // trimming had decided to reject still pull on it. Counting inliers alone cannot see that -
    // an unconverged fit can look strongly supported and still be biased, and composing it into
    // the chain accumulates exactly the drift the trimming exists to remove. Treating it as weak
    // sends it to invariant re-acquisition first, and failing that leaves it recorded in
    // `weakFrames` rather than passing as sound.
    const strong = (fit, a, b) => fit
        && fit.converged
        && fit.inliers >= O.minInliers
        && fit.inliers >= O.minInlierFraction * Math.min(a.length, b.length);

    // Every matcher is consulted EVERY time, and the corroborated fit explaining the most
    // sources wins (ties keep the earlier, prediction-refined one). "Fall back only when the
    // prediction match is weak" has a reachable hole with no threshold fix: a coherent cluster
    // of stationary artifacts is itself a strong-looking lock - six decoys among fourteen
    // detections clears the strength gates while the real field sits shifted beyond the
    // prediction gate - and it registers the frame WRONG with no failure and no weak flag,
    // which is worse than failing. Inlier count is the honest arbiter between corroborated
    // interpretations: the fit that explains eight sources beats the one that explains six.
    const best = (m, alt) => (alt && (!m || alt.fit.inliers > m.fit.inliers) ? alt : m);

    // Extent for measuring how far two candidate transforms disagree, in pixels at the frame
    // corners. Used to tell a genuine CONTEST (two interpretations of the motion) from a
    // same-interpretation refinement that merely picked up an extra inlier.
    const extent = frameExtent(usable);

    for (let f = 1; f < n; f++) {
        const prev = usable[f - 1], cur = usable[f];
        let base = f - 1;
        const predicted = matchByPrediction(prev, cur, prediction, O);
        const challenger = best(best(null, matchByInvariants(prev, cur, O)),
            matchByOffsetVote(prev, cur, O));
        let step = best(predicted, challenger);

        // Only recorded once the step it describes actually survives - a re-acquisition that is
        // later discarded for resting on a stale anchor must not leave the frame listed as both
        // failed and reacquired.
        let usedInvariants = step !== null && step !== predicted;

        // Two corroborated interpretations DISAGREED about this frame: a challenger matching or
        // beating a strong prediction fit's support, with a materially different transform.
        // Whichever way the arbitration goes - most inliers wins, ties keep the continuity of
        // the prediction - it is an arbitration, not a certainty, and the frame is reported
        // weak so the contested registration is visible downstream instead of passing as
        // uncontested. (A challenger proposing essentially the SAME transform is agreement,
        // not contest, however the inlier counts compare.)
        const contested = predicted !== null && challenger !== null
            && strong(predicted.fit, prev, cur)
            && challenger.fit.inliers >= predicted.fit.inliers
            && motionMagnitude(composeTransform(challenger.transform,
                invertTransform(predicted.transform) || IDENTITY), extent.W, extent.H)
                > 2 * O.inlierThreshold;

        // When the preceding frame was itself a failure, its cumulative transform is a HELD copy
        // of an older one - it asserts the camera did not move during the gap. Anything composed
        // onto it inherits that error permanently.
        //
        // So this is not a question of which fit is better supported. A step measured against an
        // untrusted base is INVALID no matter how many inliers it has: a well-fitting step onto a
        // stale anchor still produces a wrong absolute position, and every later frame inherits
        // it. Preferring the bridge "unless the adjacent match has more inliers" leaves exactly
        // that hole open, and so does silently keeping the adjacent match when no bridge is
        // available. The only valid anchors are the last frame we trust, or nothing.
        if (lastGood !== f - 1) {
            // Anchor candidates: lastGood first (the cheapest, most recent registration), then
            // recent strong frames, newest first. Every candidate is a TRUSTED frame, so any of
            // them is an equally honest base - the choice is about detection quality, not truth.
            const candidates = [lastGood];
            for (let k = anchorPool.length - 1;
                 k >= 0 && candidates.length < O.bridgeAnchorTries; k--) {
                if (anchorPool[k] !== lastGood) candidates.push(anchorPool[k]);
            }
            // Every candidate anchor is evaluated - no early exit on the first "strong" fit,
            // because strength is relative to the anchor's OWN size: a 6-of-6 lock on a sparse
            // degraded anchor clears its local gates while a 24-inlier recovery waits one
            // anchor further down the list. Across anchors the comparison is absolute: a
            // strong fit beats any weak one, and among fits of equal standing the one
            // explaining the most sources wins.
            let bridged = null, bridgeBase = lastGood, bridgedStrong = false;
            for (const a of candidates) {
                if (usable[a].length < O.minPairs) continue;
                // Same alternatives rule as the adjacent path: all matchers, most inliers wins.
                // Neither weakness nor strength of the prediction match is grounds to skip the
                // re-acquisition matchers - a decoy cluster can hand it either.
                let m = matchByPrediction(usable[a], cur, null, O);
                m = best(m, matchByInvariants(usable[a], cur, O));
                m = best(m, matchByOffsetVote(usable[a], cur, O));
                if (!m) continue;
                const s = strong(m.fit, usable[a], cur);
                if (!bridged || (s && !bridgedStrong)
                    || (s === bridgedStrong && m.fit.inliers > bridged.fit.inliers)) {
                    bridged = m;
                    bridgeBase = a;
                    bridgedStrong = s;
                }
            }
            if (bridged) {
                step = bridged;
                base = bridgeBase;
                usedInvariants = true;
            } else {
                // Discard the adjacent match rather than anchor it to a stale transform. Failing
                // honestly leaves the gap visible in `failed`; composing would hide it.
                step = null;
                usedInvariants = false;
            }
        }

        if (!step) {
            // Nothing worked at all. Hold the last trusted transform rather than inventing motion,
            // and record the frame so callers know this stretch is unsupported.
            failed.push(f);
            steps[f] = null;
            cumulative[f] = cumulative[lastGood];
            prediction = null;
            continue;
        }

        // A fit can be accepted while still being weak - re-acquisition may be unavailable or no
        // better. Accumulating it beats holding still, but it must be reported rather than
        // silently blended into a chain that looks uniformly trustworthy.
        if (!strong(step.fit, usable[base], cur) || (contested && base === f - 1)) {
            weakFrames.push(f);
        }

        if (usedInvariants) reacquired.push(f);

        // Record which frame this step was measured against, so callers (and tests) can tell a
        // normal adjacent step from one bridged across a gap.
        step.base = base;
        steps[f] = step;
        cumulative[f] = composeTransform(step.transform, cumulative[base]);
        prediction = base === f - 1 ? step.transform : null;
        lastGood = f;

        // Only strongly-fitted frames join the bridge-anchor pool: a weak frame may be trusted
        // enough to continue FROM, but it makes a poor pattern to re-acquire AGAINST.
        if (strong(step.fit, usable[base], cur)) {
            anchorPool.push(f);
            if (anchorPool.length > O.bridgeAnchorPool) anchorPool.shift();
        }
    }

    return {steps, cumulative, reacquired, failed, weakFrames};
}

export function solveFrameChain(perFrame, opts = {}) {
    const O = {...STAR_MATCH_DEFAULTS, ...opts};
    const empty = {
        steps: [], cumulative: [], reacquired: [], failed: [], weakFrames: [],
        cameraFixed: {fixed: [], clusters: [], applied: false},
    };
    if (!perFrame || perFrame.length === 0) return empty;

    let cameraFixed = {fixed: perFrame.map(() => new Set()), clusters: [], applied: false};

    if (O.excludeCameraFixed && perFrame.length >= 3) {
        // Decide whether the camera moves BEFORE deciding what is camera-fixed.
        //
        // With a still camera the two are indistinguishable by position alone - every star also
        // holds its pixel coordinates - so any fraction-of-detections heuristic gets it wrong in
        // one direction or the other. Eight persistent stars among eleven detections is 73%, low
        // enough to slip under a "nearly everything is fixed, so the camera must be still" rule,
        // and the real field would be deleted.
        //
        // A first pass without any exclusion answers the question directly. It is biased by the
        // artifacts it has not removed yet, but bias is irrelevant here: the only question is
        // whether the frame moved at all, and the artifacts can only bias the estimate DOWNWARD,
        // toward the stationary answer. So if this pass still sees motion, there is motion.
        const probe = solveChainOnce(perFrame, O);
        const extent = frameExtent(perFrame);
        let moved = 0;
        for (const T of probe.cumulative) {
            if (T) moved = Math.max(moved, motionMagnitude(T, extent.W, extent.H));
        }
        if (moved > O.staticMotionThreshold) cameraFixed = findCameraFixed(perFrame, O);
    }

    const usable = perFrame.map((d, f) => d.filter((_, i) => !cameraFixed.fixed[f].has(i)));
    return {...solveChainOnce(usable, O), cameraFixed};
}

/** Approximate frame size from the detections themselves, for motion measurement. */
function frameExtent(perFrame) {
    let W = 1, H = 1;
    for (const d of perFrame) {
        for (const s of d) { if (s.x > W) W = s.x; if (s.y > H) H = s.y; }
    }
    return {W, H};
}
