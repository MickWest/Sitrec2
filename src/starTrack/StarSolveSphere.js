// Stage 3 of Star Track, on the sphere: a shared star map of unit DIRECTIONS, per-frame camera
// ORIENTATIONS, and the classification built on them.
//
// Mirrors StarSolve.js rather than replacing it. The 2D path remains the default until this one
// is verified against both regression windows; nothing here is wired into the pipeline yet.
//
// THE SPLIT, which is deliberate and is the whole migration strategy:
//
//   the existing 2D similarity machinery is a PROPOSAL / BOOTSTRAP layer - it generates
//   correspondences and an initial guess, which is what it is good at -
//   but every ACCEPTED state and the final map are rotations, verified by pixel reprojection.
//
// Keeping the tuned matching (triangle re-acquisition, the offset-vote bridge, the anchor-pool
// arbitration in solveChainOnce) while replacing the physical model is the point. Those
// mechanisms were each built to fix a measured failure on real footage; the model they feed was
// the thing that was wrong.
//
// UNITS. Every residual, gate and threshold in here is in DETECTOR PIXELS, exactly as in the 2D
// path, so the tuned sigma thresholds keep their meaning. Nothing is expressed in radians at an
// interface. That is not incidental: a radial lens has an anisotropic 2x2 Jacobian - radial and
// tangential pixels-per-radian differ by cos(theta) on an orthographic lens, 0.6 at the corner of
// the measured clip - so there is no single "plate scale" that could convert an angular residual
// to pixels without silently recalibrating the thresholds as a function of where a star sits.

import {lensToRay} from "../CameraLens";
import {
    Q_IDENTITY, qMul, qConj, qNormalize, qRotate, qAngle, qBetween, qAlign, qSlerp,
    makeFrameState, frameToRef, refToFrame, fitRotationRobust, fitRotationWahba,
    refineRotationPixels,
} from "./StarSphere";
import {assignMinCost} from "./StarSolve";
import {applyTransform} from "./StarMatch";

/**
 * Convert a whole 2D chain into spherical states - the bootstrap entry point.
 *
 * This is the designed flow, and it is not optional. Starting the alternating solve from the
 * identity does not work on a real clip and the failure is instructive: with 3.28 deg of rotation
 * across 40 frames the later frames sit ~50 px from where an identity orientation predicts, which
 * is far outside the 6 px association gate, so every frame starts fresh tracks and the refinement
 * is handed fragments instead of tracks. The 2D chain is wrong at the edges by ~10 px, which is
 * wrong enough to matter for classification and quite good enough to associate with.
 */
export function statesFromChain2D(cumulative, lens, size, opts = {}) {
    return cumulative.map((T) => (T ? stateFromTransform2D(T, lens, size, opts) : null));
}

export const STAR_SPHERE_DEFAULTS = {
    trackRadius: 6,             // px, association gate in the OBSERVING frame
    trackMaxGap: 10,
    minObservations: 8,
    refineIterations: 12,
    // Most tracks that may shape the per-frame orientations (see refineGlobalSpherical). Three
    // degrees of freedom per frame; a few hundred well-observed stars pin them well below the
    // noise, and every extra one is paid for in every iteration of every frame.
    maxAnchors: 400,
    refineTolerance: 1e-4,
    refineTrimSigma: 3.0,
    refineTrimPx: 2.0,          // px, base gate for the robust per-frame orientation fit
    noiseFloor: 0.15,
    driftSignificance: 5.0,     // now a 2-dof quantity - see classifyTracksSpherical
    driftMinSigmas: 12,
    scatterSigma: 4.0,
    minVisibleFraction: 0.4,
};

// ---------------------------------------------------------------------------------------------
// Tangent frames
// ---------------------------------------------------------------------------------------------

/**
 * An orthonormal basis of the tangent plane at unit direction `d`.
 *
 * A track's motion is parameterised in ONE such basis, fixed for the whole track. It has to be
 * fixed: velocities at different directions live in different tangent spaces, so comparing or
 * fitting them in a per-observation basis is comparing numbers that do not share a meaning.
 */
export function tangentBasis(d) {
    // Pick the world axis least aligned with d, so the cross product is well conditioned.
    const ax = Math.abs(d[0]), ay = Math.abs(d[1]), az = Math.abs(d[2]);
    const seed = (ax < ay && ax < az) ? [1, 0, 0] : (ay < az ? [0, 1, 0] : [0, 0, 1]);
    let e1 = [
        seed[1] * d[2] - seed[2] * d[1],
        seed[2] * d[0] - seed[0] * d[2],
        seed[0] * d[1] - seed[1] * d[0],
    ];
    const n1 = Math.hypot(e1[0], e1[1], e1[2]);
    e1 = [e1[0] / n1, e1[1] / n1, e1[2] / n1];
    const e2 = [
        d[1] * e1[2] - d[2] * e1[1],
        d[2] * e1[0] - d[0] * e1[2],
        d[0] * e1[1] - d[1] * e1[0],
    ];
    return {e1, e2};
}

/** Direction at tangent offset (a, b) from `d`, renormalised back onto the sphere. */
export function tangentTo(d, basis, a, b) {
    const v = [
        d[0] + basis.e1[0] * a + basis.e2[0] * b,
        d[1] + basis.e1[1] * a + basis.e2[1] * b,
        d[2] + basis.e1[2] * a + basis.e2[2] * b,
    ];
    const n = Math.hypot(v[0], v[1], v[2]);
    return [v[0] / n, v[1] / n, v[2] / n];
}

/** Robust mean direction of a set of unit vectors. */
export function meanDirection(rays) {
    if (!rays.length) return null;
    let x = 0, y = 0, z = 0;
    for (const r of rays) { x += r[0]; y += r[1]; z += r[2]; }
    const n = Math.hypot(x, y, z);
    if (!(n > 1e-12)) return null;
    return [x / n, y / n, z / n];
}

/** Median-of-components direction, then renormalised - the analogue of starPosition's median. */
export function medianDirection(rays) {
    if (!rays.length) return null;
    const pick = (k) => {
        const c = rays.map((r) => r[k]).sort((a, b) => a - b);
        return c[c.length >> 1];
    };
    const v = [pick(0), pick(1), pick(2)];
    const n = Math.hypot(v[0], v[1], v[2]);
    if (!(n > 1e-12)) return meanDirection(rays);
    return [v[0] / n, v[1] / n, v[2] / n];
}

// ---------------------------------------------------------------------------------------------
// Bootstrap: 2D transforms -> spherical states
// ---------------------------------------------------------------------------------------------

/**
 * The rotation that best reproduces what a fitted 2D similarity does to the image.
 *
 * Samples a grid of pixels, pushes them through the 2D transform, and fits the rotation that maps
 * the corresponding rays. This is how the existing chain's answer is carried into the spherical
 * solve without re-running any matching - the 2D transform IS a summary of the correspondences it
 * was fitted to.
 *
 * It is an INITIALISER and nothing more. The 2D model cannot represent the true mapping on a wide
 * lens - that is the entire reason this module exists - so the residual of this conversion is
 * expected to be large at the frame edges, and refineGlobalSpherical is what removes it.
 */
export function stateFromTransform2D(T, lens, size, opts = {}) {
    const [w, h] = size;
    const src = [], dst = [];
    const n = 6;
    for (let i = 0; i <= n; i++) {
        for (let j = 0; j <= n; j++) {
            const x = w * i / n, y = h * j / n;
            const p = applyTransform(T, x, y);
            const a = lensToRay(lens, x, y, size);
            const b = lensToRay(lens, p[0], p[1], size);
            if (!a || !b) continue;
            src.push(a); dst.push(b);
        }
    }
    if (src.length < 3) return makeFrameState(opts);
    const q = fitRotationWahba(src, dst);
    return makeFrameState({...opts, q: q ?? Q_IDENTITY});
}

// ---------------------------------------------------------------------------------------------
// Association, in the observing frame
// ---------------------------------------------------------------------------------------------

/**
 * Build tracklets by associating in EACH OBSERVING FRAME's pixels, storing reference rays.
 *
 * The 2D version associates in a global reference-pixel chart, which a spherical map simply does
 * not have: there is no single plane the whole sky lives in, and a star that first appears while
 * the camera is pointed elsewhere may have no image in frame 0's footprint at all. Predicting and
 * gating in the observing frame also keeps the gate in the units it was tuned in.
 *
 * The assignment is the same exact minimum-cost solve the 2D path uses - imported rather than
 * reimplemented, because its exactness is load-bearing (greedy variants manufacture movers) and a
 * second copy would drift from the original.
 */
/**
 * Give tracks built by the 2D path the ray data the spherical solve needs.
 *
 * This is what lets the existing, well-tested association be reused wholesale: the 2D tracklet
 * builder decides WHICH detections belong together, which it does correctly - the measured bug is
 * in the geometry used to judge the result, not in the grouping - and this attaches the spherical
 * view of the same observations.
 */
export function attachRays(tracks, states, lens, size) {
    for (const t of tracks) {
        const rays = [], frames = [];
        for (const o of t.obs) {
            const st = states[o.f];
            if (!st) continue;
            const r = frameToRef(st, lens, o.x, o.y, size);
            if (!r) continue;
            rays.push(r); frames.push(o.f);
        }
        t.rays = rays;
        t.rayFrames = frames;
        t.ref = rays.length ? medianDirection(rays) : null;
    }
    return tracks;
}

/**
 * Where a track is expected to point at frame `f`, extrapolating its recent tangent velocity.
 *
 * A CONSTANT-VELOCITY prediction, not the track's average direction, and not even its last one.
 * The 2D path learned this the hard way and records the measurement: the real object crosses at
 * ~2.6 px/frame against a 6 px gate, so a zero-velocity assumption puts it at the gate edge after
 * one missed detection and outside after two - the mover arrives fragmented purely because of
 * which frames it dropped out on. Predicting from the median direction, which is what a first
 * implementation naturally does, is worse still: the prediction sits in the MIDDLE of the
 * mover's path and is half the total drift away by the end of the clip.
 *
 * For a star the fitted velocity is zero within noise, so this predicts the same place the last
 * position would and nothing about star association changes.
 */
export function predictDirection(track, f, window = 6) {
    const rays = track.rays, fs = track.rayFrames;
    if (!rays || !rays.length) return track.ref;
    const last = rays[rays.length - 1], lastF = fs[fs.length - 1];
    const n = Math.min(window, rays.length);
    if (n < 2) return last;
    const basis = tangentBasis(last);
    // Tangent coordinates of the recent history, relative to the last direction.
    const pts = [];
    for (let k = rays.length - n; k < rays.length; k++) {
        const d = rays[k];
        const a = d[0] * basis.e1[0] + d[1] * basis.e1[1] + d[2] * basis.e1[2];
        const b = d[0] * basis.e2[0] + d[1] * basis.e2[1] + d[2] * basis.e2[2];
        pts.push([fs[k], a, b]);
    }
    let sf = 0, sa = 0, sb = 0;
    for (const p of pts) { sf += p[0]; sa += p[1]; sb += p[2]; }
    const mf = sf / pts.length, ma = sa / pts.length, mb = sb / pts.length;
    let sff = 0, sfa = 0, sfb = 0;
    for (const p of pts) {
        const df = p[0] - mf;
        sff += df * df; sfa += df * (p[1] - ma); sfb += df * (p[2] - mb);
    }
    if (!(sff > 1e-12)) return last;
    const va = sfa / sff, vb = sfb / sff;
    return tangentTo(last, basis, va * (f - lastF), vb * (f - lastF));
}

export function buildTrackletsSpherical(perFrame, states, lens, size, opts = {}) {
    const O = {...STAR_SPHERE_DEFAULTS, ...opts};
    const tracks = [];
    const r2 = O.trackRadius * O.trackRadius;

    for (let f = 0; f < perFrame.length; f++) {
        const st = states[f];
        if (!st) continue;
        const dets = perFrame[f];

        // Where each live track expects to be IN THIS FRAME's pixels, extrapolating its own
        // tangent velocity rather than assuming it holds still.
        const predicted = tracks.map((t) => {
            const d = predictDirection(t, f);
            return d ? refToFrame(st, lens, d, size) : null;
        });

        const options = dets.map(() => []);
        for (let m = 0; m < dets.length; m++) {
            for (let t = 0; t < tracks.length; t++) {
                if (f - tracks[t].last - 1 > O.trackMaxGap) continue;
                const p = predicted[t];
                if (!p) continue;                 // no image this frame: cannot be matched here
                const dd = (p[0] - dets[m].x) ** 2 + (p[1] - dets[m].y) ** 2;
                if (dd <= r2) options[m].push([dd, t]);
            }
            options[m].sort((a, b) => a[0] - b[0]);
        }

        // Rows are detections, columns are tracks plus one dummy per detection. The dummy cost
        // exceeds any gated pairing, so every track that CAN be continued is.
        const nCol = tracks.length + dets.length;
        const DUMMY = r2 * 4 + 1;
        const rows = dets.map((_, m) => {
            const row = new Array(nCol).fill(DUMMY * 4);
            for (const [dd, t] of options[m]) row[t] = dd;
            row[tracks.length + m] = DUMMY;
            return row;
        });
        const rowCol = dets.length ? assignMinCost(rows, nCol) : [];

        for (let m = 0; m < dets.length; m++) {
            const col = rowCol[m];
            const d = dets[m];
            const ray = frameToRef(st, lens, d.x, d.y, size);
            if (col !== undefined && col < tracks.length && rows[m][col] <= r2) {
                const t = tracks[col];
                t.obs.push({f, x: d.x, y: d.y, src: d});
                t.last = f;
                if (ray) { t.rays.push(ray); t.rayFrames.push(f); }
                // `ref` stays a ROBUST CENTRAL direction: it seeds the map, where a median is
                // right. Prediction uses predictDirection instead, which extrapolates. The two
                // want different things and conflating them is what breaks mover tracking.
                t.ref = ray ? medianDirection(t.rays) : t.ref;
            } else {
                if (!ray) continue;               // an unmatched, unprojectable detection is noise
                tracks.push({
                    obs: [{f, x: d.x, y: d.y, src: d}],
                    rays: [ray], rayFrames: [f], ref: ray, first: f, last: f,
                });
            }
        }
    }
    return tracks;
}

/**
 * A flat, warp-free GNOMONIC chart of the star map, in pixel-like units.
 *
 * Star identification hashes quads of stars with a code that is invariant under a planar
 * SIMILARITY, and verifies against a gnomonic field. That is a correct set of assumptions about
 * the SKY - a gnomonic projection maps great circles to straight lines - but the 2D solver's
 * reference chart is not gnomonic, it is a chain of similarity transforms, and on a wide lens it
 * carries the same edge warp that made the classification wrong. Feeding those positions to a
 * matcher that assumes otherwise is what caps its match fraction.
 *
 * Once the map is a set of directions this is trivial to fix properly: project them about their
 * own centre. Great circles come out straight, quad codes mean what they claim, and the chart has
 * no warp to lose consensus to.
 *
 * @returns {{positions: Array<number[]|null>, centre: number[], focalPx: number}}
 */
export function gnomonicChart(directions, focalPx) {
    const valid = directions.filter(Boolean);
    const centre = meanDirection(valid);
    if (!centre) return {positions: directions.map(() => null), centre: [0, 0, 1], focalPx};
    const {e1, e2} = tangentBasis(centre);
    const positions = directions.map((d) => {
        if (!d) return null;
        const z = d[0] * centre[0] + d[1] * centre[1] + d[2] * centre[2];
        // At or behind the horizon of the tangent plane the projection diverges; those stars
        // simply have no place on this chart and must be dropped, not clamped.
        if (!(z > 0.05)) return null;
        const a = d[0] * e1[0] + d[1] * e1[1] + d[2] * e1[2];
        const b = d[0] * e2[0] + d[1] * e2[1] + d[2] * e2[2];
        return [focalPx * a / z, focalPx * b / z];
    });
    return {positions, centre, focalPx};
}

// ---------------------------------------------------------------------------------------------
// Global refinement
// ---------------------------------------------------------------------------------------------

/**
 * Solve every frame's ORIENTATION and every star's DIRECTION against one shared map.
 *
 * Alternating, exactly as refineGlobal does, because both halves still have closed forms:
 *   - with directions held, each frame's rotation is Wahba plus a pixel-domain refinement;
 *   - with rotations held, each star's direction is the mean of its back-rotated rays.
 *
 * GAUGE. The solution is defined only up to a global rotation - turning the whole map and
 * counter-turning every frame changes nothing observable - so frame 0 is re-pinned to the
 * identity after every round, which makes the map's coordinates "frame 0's camera frame". This
 * is the same null direction refineGlobal fixes, expressed on SO(3).
 */
export function refineGlobalSpherical(tracks, initialStates, lens, size, opts = {}) {
    const O = {...STAR_SPHERE_DEFAULTS, ...opts};
    // Tracks the caller knows do not belong to the sky - camera-fixed artifacts, and on a second
    // pass the movers - must not shape the orientations used to judge them. The 2D solver makes
    // the same move for the same measured reason: a hot pixel holds its PIXEL position while the
    // sky sweeps past, so it is a large, perfectly coherent contaminant at exactly the place
    // robust fitting copes with worst, since trimming assumes outliers disagree with each other
    // and these agree emphatically.
    const exclude = opts.exclude instanceof Set ? opts.exclude : new Set();
    let states = initialStates.map((s) => (s ? {...s} : null));
    let map = tracks.map((t, i) => (!exclude.has(i) && t.rays && t.rays.length ? medianDirection(t.rays) : null));

    // Which tracks may SHAPE the orientations, and their observations indexed by frame.
    //
    // Two costs live in the loop below, and on a dense field both are severe. It ran 206 SECONDS
    // on a Milky Way timelapse with 2429 tracks - the browser offered to kill the page repeatedly.
    //
    // 1. `obs.find()` inside a frames x tracks double loop is O(frames x tracks x obs) per
    //    iteration. The observations never change here, so they are indexed once.
    // 2. A frame's orientation has three degrees of freedom. A few hundred well-observed stars
    //    determine it far below the measurement noise; the rest cost time in every one of
    //    refineIterations x frames fits and buy nothing. Anchors are therefore capped, longest-
    //    observed first - the best-determined directions, and the least likely to be a transient.
    //
    // Both restrict only what BUILDS the orientations. Every track still has its direction
    // updated against them below, and classifyTracksSpherical still judges all of them, so no
    // track is dropped from the result.
    let anchorIdx = [];
    for (let i = 0; i < tracks.length; i++) if (map[i]) anchorIdx.push(i);
    if (O.maxAnchors > 0 && anchorIdx.length > O.maxAnchors) {
        anchorIdx = anchorIdx
            .map((i) => [tracks[i].obs.length, i])
            .sort((a, b) => (b[0] - a[0]) || (a[1] - b[1]))
            .slice(0, O.maxAnchors)
            .map((e) => e[1]);
        anchorIdx.sort((a, b) => a - b);       // keep the original order the fit saw
    }
    const anchorByFrame = Array.from({length: states.length}, () => []);
    for (const i of anchorIdx) {
        const seen = new Set();
        for (const o of tracks[i].obs) {
            if (o.f < 0 || o.f >= states.length || seen.has(o.f)) continue;
            seen.add(o.f);
            anchorByFrame[o.f].push([i, o.x, o.y]);
        }
    }

    let rms = Infinity, iterations = 0, converged = false;

    for (let iter = 0; iter < O.refineIterations; iter++) {
        iterations = iter + 1;

        // --- orientations, given the map ---
        for (let f = 0; f < states.length; f++) {
            if (!states[f]) continue;
            const rays = [], px = [];
            for (const [i, ox, oy] of anchorByFrame[f]) {
                if (!map[i]) continue;
                rays.push(map[i]); px.push([ox, oy]);
            }
            if (rays.length < 3) continue;
            const obsRays = px.map((p, k) => lensToRay(lens, p[0], p[1], size, states[f].s) ?? rays[k]);

            // ROBUST, not plain least squares. Fitting every track equally lets a mover or an
            // artifact pull the orientation that is then used to decide whether it moved - which
            // is circular, and is why the 2D path re-solves on stars alone. Trimming here is the
            // first line of that defence; `exclude` is the second.
            let w = new Array(rays.length).fill(1);
            let q = states[f].q;
            let kept = rays.length;
            for (let round = 0; round < 3; round++) {
                const seed = fitRotationWahba(rays, obsRays, w);
                if (seed) q = qAlign(seed, q);
                q = refineRotationPixels(q, lens, rays, px, size, {s: states[f].s, weights: w});
                const st = {q, s: states[f].s};
                const err = rays.map((r, k) => {
                    const p = refToFrame(st, lens, r, size);
                    return p ? Math.hypot(p[0] - px[k][0], p[1] - px[k][1]) : Infinity;
                });
                // Anneal from generous to tight, as fitSimilarity does.
                const gate = O.refineTrimPx * (round === 0 ? 4 : round === 1 ? 2 : 1);
                const nw = err.map((e) => (e < gate ? 1 : 0));
                const count = nw.reduce((a, b) => a + b, 0);
                if (count < 3) break;                 // keep the previous consensus
                const same = nw.every((v, k) => v === w[k]);
                w = nw; kept = count;
                if (same) break;
            }
            states[f] = {...states[f], q, inliers: kept};
        }

        // --- gauge: pin the first solved frame to the identity ---
        const first = states.find((s) => s);
        if (first) {
            const inv = qConj(first.q);
            map = map.map((d) => (d ? qRotate(first.q, d) : null));
            states = states.map((s) => (s ? {...s, q: qMul(s.q, inv)} : null));
        }

        // --- map, given the orientations ---
        // Excluded tracks stay out of the map for the whole solve, not just its first round;
        // recomputing them here would quietly readmit them to the next iteration's fit.
        map = tracks.map((t, ti) => {
            if (exclude.has(ti)) return null;
            const rays = [];
            for (const o of t.obs) {
                const st = states[o.f];
                if (!st) continue;
                const r = frameToRef(st, lens, o.x, o.y, size);
                if (r) rays.push(r);
            }
            return rays.length ? meanDirection(rays) : null;
        });

        // --- cost, in detector pixels ---
        let sse = 0, count = 0;
        for (let i = 0; i < tracks.length; i++) {
            if (!map[i]) continue;
            for (const o of tracks[i].obs) {
                const st = states[o.f];
                if (!st) continue;
                const p = refToFrame(st, lens, map[i], size);
                if (!p) continue;
                sse += (p[0] - o.x) ** 2 + (p[1] - o.y) ** 2;
                count++;
            }
        }
        const next = count ? Math.sqrt(sse / count) : Infinity;
        if (Math.abs(rms - next) < O.refineTolerance) { rms = next; converged = true; break; }
        rms = next;
    }

    // Attach the settled reference direction to each track. Excluded tracks still need one -
    // they are classified like everything else, they just did not get a vote on the orientations
    // - so theirs is computed from the settled states without having influenced them.
    for (let i = 0; i < tracks.length; i++) {
        if (map[i]) { tracks[i].ref = map[i]; continue; }
        const rays = [];
        for (const o of tracks[i].obs) {
            const st = states[o.f];
            if (!st) continue;
            const r = frameToRef(st, lens, o.x, o.y, size);
            if (r) rays.push(r);
        }
        tracks[i].ref = rays.length ? medianDirection(rays) : null;
    }
    return {states, map, rms, iterations, converged};
}

// ---------------------------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------------------------

/** Per-observation pixel residuals of a track against a fixed direction. */
function residualsPx(track, states, lens, size, dir) {
    const out = [];
    for (const o of track.obs) {
        const st = states[o.f];
        if (!st) continue;
        const p = refToFrame(st, lens, dir, size);
        if (!p) continue;
        out.push(Math.hypot(p[0] - o.x, p[1] - o.y));
    }
    return out;
}

/**
 * Robust pooled astrometric noise, in pixels, from residuals against the settled map.
 *
 * Pooled over every observation via the median absolute residual, and floored - the same
 * construction estimateNoise uses, so sigma means the same thing it does in the 2D path.
 */
export function estimateNoiseSpherical(tracks, states, lens, size, opts = {}) {
    const O = {...STAR_SPHERE_DEFAULTS, ...opts};
    // Known non-sky tracks are excluded outright. A mover's residuals against a FIXED direction
    // are large by construction, so leaving it in inflates the very sigma its own significance is
    // measured against - it would help hide itself. The median below resists a few; the exclusion
    // is what handles "a few" turning into "enough to matter".
    const exclude = opts.exclude instanceof Set ? opts.exclude : new Set();
    const all = [];
    for (let i = 0; i < tracks.length; i++) {
        const t = tracks[i];
        if (exclude.has(i)) continue;
        if (!t.ref || t.obs.length < O.minObservations) continue;
        for (const e of residualsPx(t, states, lens, size, t.ref)) all.push(e);
    }
    if (!all.length) return O.noiseFloor;
    all.sort((a, b) => a - b);
    const mad = all[Math.floor(all.length * 0.5)];
    // Residuals are 2D distances, so the median of a 2D Gaussian's magnitude is sigma*1.1774.
    return Math.max(O.noiseFloor, mad / 1.1774);
}

/**
 * Classify each track as star / moving / short, fitting motion in ONE reference tangent plane and
 * scoring it in DETECTOR PIXELS.
 *
 * This is the resolution of the design question the 2D path leaves implicit. Two wrong options
 * were considered and rejected:
 *
 *   - fitting the drift on the observing-frame residual components is wrong, because camera
 *     rotation turns that basis between frames and the lens Jacobian rescales it differently at
 *     every observation, so a genuinely constant sky drift can partially cancel or read as curved;
 *   - fitting in a tangent plane and converting with a single scalar "plate scale at this
 *     direction" is wrong, because the Jacobian is an anisotropic 2x2 and one number cannot stand
 *     in for it.
 *
 * So: parameterise in the tangent plane, forward-project through each frame's orientation and the
 * lens, and minimise in that observation's pixels.
 *
 * SIGNIFICANCE IS A 2-DOF QUANTITY HERE, and that is a real change from the 2D path. The old
 * statistic divided the MAGNITUDE of a two-component slope by the standard error of a SINGLE
 * component, and the tuned threshold of 5.0 carries that construction inside it. This one is
 * sqrt(v^T Cov(v)^-1 v) with Cov(v) = sigma^2 (J^T J)^-1, which is properly 2-dof. The threshold
 * must therefore be re-derived rather than inherited - see tests/StarSolveDriftStatistic.test.js,
 * which pins the old meaning precisely so this conversion is deliberate.
 */
export function classifyTracksSpherical(tracks, states, lens, size, opts = {}) {
    const O = {...STAR_SPHERE_DEFAULTS, ...opts};
    // NOTE FOR CALLERS: this does NOT test for camera-fixed artifacts. A hot pixel holds its
    // pixel position while the sky rotates, so on the sphere it sweeps and would be reported as
    // a fast mover. Whoever owns the pipeline must keep the 2D pass's `cameraFixed` verdicts and
    // pass those tracks in `exclude`; overwriting them with a verdict from here turns the single
    // most damaging contaminant into a confident detection.
    const sigma = opts.sigma ?? estimateNoiseSpherical(tracks, states, lens, size, O);
    const out = [];

    for (let i = 0; i < tracks.length; i++) {
        const t = tracks[i];
        const rec = {index: i, n: t.obs.length, first: t.first, last: t.last, sigma, direction: t.ref};

        if (t.obs.length < O.minObservations || !t.ref) {
            out.push({...rec, klass: "short"});
            continue;
        }

        const basis = tangentBasis(t.ref);
        const fs = t.obs.map((o) => o.f);
        const fMean = fs.reduce((a, b) => a + b, 0) / fs.length;

        // Parameters: tangent offset (a0, b0) and tangent velocity (va, vb) per frame.
        let p = [0, 0, 0, 0];
        const predict = (pp, f) => tangentTo(
            t.ref, basis,
            pp[0] + pp[2] * (f - fMean),
            pp[1] + pp[3] * (f - fMean),
        );
        const costOf = (pp) => {
            let sse = 0;
            for (const o of t.obs) {
                const st = states[o.f];
                if (!st) continue;
                const q = refToFrame(st, lens, predict(pp, o.f), size);
                if (!q) continue;
                sse += (q[0] - o.x) ** 2 + (q[1] - o.y) ** 2;
            }
            return sse;
        };

        // Gauss-Newton with a numeric Jacobian: four parameters, so this is cheap, and an
        // analytic derivative would buy little against the risk of a convention error.
        let AtA = null;
        for (let iter = 0; iter < 10; iter++) {
            const h = 1e-7;
            const M = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
            const b = [0, 0, 0, 0];
            for (const o of t.obs) {
                const st = states[o.f];
                if (!st) continue;
                const base = refToFrame(st, lens, predict(p, o.f), size);
                if (!base) continue;
                const J = [];
                let ok = true;
                for (let k = 0; k < 4; k++) {
                    const pp = p.slice(); pp[k] += h;
                    const q = refToFrame(st, lens, predict(pp, o.f), size);
                    if (!q) { ok = false; break; }
                    J.push([(q[0] - base[0]) / h, (q[1] - base[1]) / h]);
                }
                if (!ok) continue;
                const rx = o.x - base[0], ry = o.y - base[1];
                for (let a = 0; a < 4; a++) {
                    for (let c = 0; c < 4; c++) M[a][c] += J[a][0] * J[c][0] + J[a][1] * J[c][1];
                    b[a] += J[a][0] * rx + J[a][1] * ry;
                }
            }
            AtA = M;
            const d = solveN(M, b, 4);
            if (!d) break;
            const pn = p.map((v, k) => v + d[k]);
            if (!(costOf(pn) < costOf(p))) break;
            p = pn;
            if (Math.hypot(d[0], d[1], d[2], d[3]) < 1e-14) break;
        }

        // Velocity in pixels per frame, taken at the track's own mean direction so it is reported
        // in the units a reader expects rather than in radians of arc.
        const dirFirst = predict(p, fs[0]);
        const dirLast = predict(p, fs[fs.length - 1]);
        const spanPx = [];
        for (const o of t.obs) {
            const st = states[o.f];
            if (!st) continue;
            const a = refToFrame(st, lens, dirFirst, size);
            const b = refToFrame(st, lens, dirLast, size);
            if (a && b) spanPx.push(Math.hypot(b[0] - a[0], b[1] - a[1]));
        }
        spanPx.sort((a, b) => a - b);
        const totalDrift = spanPx.length ? spanPx[spanPx.length >> 1] : 0;

        // 2-dof significance from the velocity block of the covariance.
        const cov = invertN(AtA, 4);
        let significance = 0;
        if (cov) {
            const c = [[cov[2][2], cov[2][3]], [cov[3][2], cov[3][3]]].map((r) => r.map((v) => v * sigma * sigma));
            const det = c[0][0] * c[1][1] - c[0][1] * c[1][0];
            if (Math.abs(det) > 1e-30) {
                const inv = [[c[1][1] / det, -c[0][1] / det], [-c[1][0] / det, c[0][0] / det]];
                const v = [p[2], p[3]];
                const q = v[0] * (inv[0][0] * v[0] + inv[0][1] * v[1])
                    + v[1] * (inv[1][0] * v[0] + inv[1][1] * v[1]);
                significance = q > 0 ? Math.sqrt(q) : 0;
            }
        }

        const resid = residualsPx(t, states, lens, size, t.ref);
        const scatter = resid.length
            ? Math.sqrt(resid.reduce((a, e) => a + e * e, 0) / resid.length)
            : 0;
        const spanFrames = t.last - t.first + 1;
        const visible = t.obs.length / Math.max(1, spanFrames);

        let klass;
        if (visible < O.minVisibleFraction) klass = "incoherent";
        else if (significance > O.driftSignificance && totalDrift > O.driftMinSigmas * sigma) klass = "moving";
        else if (scatter > O.scatterSigma * sigma) klass = "incoherent";
        else klass = "star";

        out.push({...rec, klass, significance, totalDrift, scatter, visible,
            velocity: [p[2], p[3]]});
    }
    return out;
}

function solveN(A, b, n) {
    const M = A.map((r, i) => [...r, b[i]]);
    for (let c = 0; c < n; c++) {
        let piv = c;
        for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
        [M[c], M[piv]] = [M[piv], M[c]];
        if (Math.abs(M[c][c]) < 1e-14) return null;
        for (let r = 0; r < n; r++) {
            if (r === c) continue;
            const f = M[r][c] / M[c][c];
            for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
        }
    }
    const out = M.map((r, i) => r[n] / r[i]);
    return out.every((v) => isFinite(v)) ? out : null;
}

function invertN(A, n) {
    if (!A) return null;
    const M = A.map((r, i) => [...r, ...Array.from({length: n}, (_, k) => (k === i ? 1 : 0))]);
    for (let c = 0; c < n; c++) {
        let piv = c;
        for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
        [M[c], M[piv]] = [M[piv], M[c]];
        if (Math.abs(M[c][c]) < 1e-14) return null;
        const d = M[c][c];
        for (let k = c; k < 2 * n; k++) M[c][k] /= d;
        for (let r = 0; r < n; r++) {
            if (r === c) continue;
            const f = M[r][c];
            for (let k = c; k < 2 * n; k++) M[r][k] -= f * M[c][k];
        }
    }
    return M.map((r) => r.slice(n));
}
