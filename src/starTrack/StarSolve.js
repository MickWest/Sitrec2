// Stage 3 of Star Track: a global star map, and the classification that rests on it.
//
// Stage 2 produces the camera transform for each frame by chaining frame-to-frame fits. That is a
// good INITIALISATION and a poor answer: every step carries a small error and the chain integrates
// them. Measured on the target clip, the residual common-mode drift is 0.232 px/frame - about
// 41 px accumulated over the 179-frame window - which leaves each star's position in the reference
// frame scattered by ~6 px when it should be sub-pixel.
//
// That drift is not merely untidy, it is disqualifying for the actual question. A star is supposed
// to be the thing that does NOT move against the sky, so a drifting reference frame makes every
// star look like it is moving, and the only way to see a genuine mover through it is to subtract a
// common mode - which quietly assumes the very thing being tested.
//
// The fix is to stop chaining. Solve every frame's transform and every star's position TOGETHER,
// against one shared map, so each frame is tied to the map rather than to its predecessor and
// there is no error to accumulate.
//
// Pure: plain arrays in, plain objects out. No DOM, no THREE, no Sitrec globals.

import {
    IDENTITY,
    STAR_MATCH_DEFAULTS,
    applyTransform,
    composeTransform,
    fitSimilarity,
    invertTransform,
} from "./StarMatch";

export const STAR_SOLVE_DEFAULTS = {
    // Tracklet association, in REFERENCE-frame pixels.
    trackRadius: 6,
    trackMaxGap: 10,            // frames a tracklet may survive without a detection
    minObservations: 8,         // below this a tracklet is too short to classify
    // Centre the association gate on a constant-velocity prediction of each track rather than on
    // its last seen position. For a star the two are identical; for a mover the difference is
    // whether one missed detection fragments its track (see the comment in buildTracklets).
    predictiveAssociation: true,

    // Global refinement.
    refineIterations: 40,
    refineTolerance: 1e-4,      // stop when the RMS residual improves by less than this (px)
    refineTrimSigma: 4.0,       // outlier gate during refinement, in sigmas of the MEASURED noise
    // Temporal smoothness of the per-frame ROTATION, as a multiple of the median per-frame
    // evidence weight; 0 disables it.
    //
    // Fitting every frame's transform independently leaves sparse frames BISTABLE: with half a
    // dozen inliers the trimmed fit can lock onto either of two correspondence subsets, and on the
    // target clip it flip-flopped between rotations 1.2 deg apart on alternating frames - a swing
    // no camera performs - which duplicated every star in the map (each regime got its own copy)
    // and cut the moving object's track at each transition. The camera's rotation is continuous,
    // so the frames are solved JOINTLY with a penalty on the SECOND difference of the angle.
    // Second, not first: a first-difference penalty pulls toward a stationary camera and biases a
    // steady pan, while a second-difference penalty is zero on any constant-rate pan and only
    // resists acceleration - so it suppresses single-frame flips (enormous second difference)
    // while rounding a genuine rate change over a frame or two.
    //
    // Each frame's data weight is the exact curvature of its least-squares cost with respect to
    // rotation (the inlier spread about the centroid), so a well-observed frame follows its own
    // evidence and a sparse frame follows its neighbours. At this setting a 1.2 deg single-frame
    // flip costs ~1000 px^2 against a data preference of tens, and a plausible real rate change
    // (0.05 deg/frame^2) costs under 1 px^2 - four orders of magnitude of separation.
    refineSmoothness: 1.0,

    // Classification. Thresholds are in SIGMAS of the measured astrometric noise, not in pixels,
    // so they mean the same thing on a clean clip and a noisy one.
    driftSignificance: 5.0,     // t-statistic on the fitted drift before a track is called moving
    scatterSigma: 4.0,          // residual scatter above this many sigma is incoherent, not a source
    // Detected in at least this share of the frames its own span covers. A track appearing in a
    // tenth of its own frames is more likely a string of unrelated blips than a steady source.
    minVisibleFraction: 0.4,
    // Significance alone is not enough to call something a mover. With a hundred observations a
    // statistically certain drift can still be a fraction of a pixel - which is what a tracklet
    // that strayed between two neighbouring stars looks like. A mover must also have moved a
    // distance worth reporting.
    //
    // Expressed in SIGMAS, not pixels, because the two datasets differ tenfold. Synthetic stars
    // centroid to 0.15 px; the real clip's are bloomed saturated disks measuring 1.49 px, and its
    // confirmed stars accumulate up to 8 px of residual drift purely from that noise - which a
    // 2 px floor calls motion. At 12 sigma the same constant is 1.8 px on the clean data and
    // 18 px on the noisy, and separates the genuine object (72-153 px) from the star population
    // (max 8 px) on both.
    driftMinSigmas: 12,
    // Camera-fixed: moves less than this fraction as far in the frame as it does on the sky, over
    // a sky excursion of at least this fraction of the camera's OWN measured motion. Both are
    // ratios, so neither needs the noise estimate - which matters, because the noise estimate
    // needs this answer first.
    cameraFixedRatio: 0.25,
    cameraFixedMinSkyFraction: 0.35,
    // ...AND its total excursion in the frame must stay within this many pixels, ABSOLUTELY.
    //
    // This is the condition that separates an artifact from a TRACKED TARGET, which no ratio can:
    // an operator following an object keeps it nearly stationary in frame while it sweeps across
    // the sky, which is geometrically the identical signature. What differs is not a proportion
    // but a scale. A sensor artifact sits on one photosite, so its apparent excursion is just
    // centroid noise - a pixel or two, and it does NOT grow as the clip gets longer. Hand-tracking
    // drift does grow with clip length, and reaches tens of pixels within seconds.
    //
    // A fraction of the field's motion was tried and is wrong for exactly that reason: it scales
    // with the pan, so a longer or faster pan raises the bar until a poorly-tracked target slips
    // under it. Measured on the synthetic clip, artifacts span 0.2-6.1 px however far the camera
    // travels, while a tracked target spans 50-95 px and a real one on the target footage spans
    // 261 px.
    cameraFixedMaxRawSpan: 8,
    // Merging split star tracks. A star can drop below the detection threshold for longer than
    // trackMaxGap, or hand its detections to a second track for a few frames during a blend, and
    // association - which is sequential and gap-limited by design - cannot rejoin the pieces. The
    // pieces are the same star, so the map must not count them twice.
    //
    // The discriminator rests on a physical fact: a star yields ONE detection per frame, so two
    // tracks of the same star can only "coexist" through a blend's transient double-detection -
    // an ABSOLUTE few frames, never a fraction of track length. An earlier fractional allowance
    // (a quarter of the shorter track) scaled with length until two 40-observation stationary
    // stars sharing ten frames merged, and the chimera - one position for thirty frames, the
    // other for thirty - carried a statistically immaculate 3 px drift: a manufactured mover.
    // Genuinely distinct close stars coexist in nearly every frame both are visible and never
    // fit under a constant.
    starMergeRadius: 4,
    starMergeMaxSharedFrames: 3,

    // Quantile of the per-track scatter distribution taken as the noise. Low on purpose: the
    // well-measured sources are the low tail, so reading there estimates them even when
    // poorly-behaved tracks outnumber them.
    noiseQuantile: 0.25,
    // Floor on the estimated astrometric noise. Every threshold is in sigmas, so a sigma driven to
    // near zero by an unusually clean fit would make the classifier hair-trigger.
    noiseFloor: 0.15,
};

/**
 * Group per-frame detections into tracklets, using Stage 2's transforms to work in a common frame.
 *
 * Association happens in REFERENCE coordinates rather than raw pixels, because there a star barely
 * moves however fast the camera pans - so the gate can be tight without losing anything, which is
 * what keeps neighbouring stars from being confused during a fast pan.
 *
 * @param {Array<Array>} perFrame - detections per frame, each {x, y, ...}
 * @param {Array} cumulative - per-frame transform mapping reference coordinates into that frame
 * @returns {Array} tracklets, each {obs: [{f, x, y, rx, ry, src}], first, last}
 */
export function buildTracklets(perFrame, cumulative, opts = {}) {
    const O = {...STAR_SOLVE_DEFAULTS, ...opts};
    const tracks = [];
    const r2 = O.trackRadius * O.trackRadius;

    for (let f = 0; f < perFrame.length; f++) {
        const C = cumulative[f];
        if (!C) continue;
        const inv = invertTransform(C);
        if (!inv) continue;

        const mapped = perFrame[f].map((d) => {
            const [rx, ry] = applyTransform(inv, d.x, d.y);
            return {d, rx, ry};
        });

        // Where each live track EXPECTS to be this frame. The gate is centred on a
        // constant-velocity prediction rather than on the last seen position, because a
        // zero-velocity assumption under-predicts a mover by its speed times the gap: on the
        // target clip the object crosses the sky at ~2.6 px/frame against a 6 px gate, so one
        // missed detection put it at the gate edge and two cut its track - the object arrived
        // fragmented for no better reason than which frames its detections dropped out on. A
        // star's fitted velocity is zero within noise, so for stars this predicts the same place
        // the last position did and nothing about their association changes.
        const predicted = tracks.map((t) => (O.predictiveAssociation
            ? trackPrediction(t, f)
            : [t.lx, t.ly]));

        // Candidate pairings for this frame, each detection's options ordered by distance.
        const options = mapped.map(() => []);
        for (let m = 0; m < mapped.length; m++) {
            for (let t = 0; t < tracks.length; t++) {
                // A gap of `trackMaxGap` MISSING frames is the documented allowance, and the count
                // of missing frames between `last` and `f` is (f - last - 1), not (f - last).
                if (f - tracks[t].last - 1 > O.trackMaxGap) continue;
                const dd = (predicted[t][0] - mapped[m].rx) ** 2 + (predicted[t][1] - mapped[m].ry) ** 2;
                if (dd <= r2) options[m].push([dd, t]);
            }
            options[m].sort((a, b) => a[0] - b[0]);
        }

        // The per-frame pairing is solved as an EXACT minimum-cost assignment, not with local
        // moves. Three properties fall out of exactness at once:
        //
        //   EXCLUSIVITY - a star has one position per frame, so each detection takes at most
        //   one track and vice versa; that is what an assignment is.
        //
        //   MAXIMUM CARDINALITY - leaving a detection unmatched costs more than any gated
        //   pairing (the dummy penalty below), so the solver continues every track it can; an
        //   unmatched track is a fragmented star.
        //
        //   RIGHT IDENTITIES - the costs are squared distances, so the minimum-cost assignment
        //   is the maximum-likelihood one under Gaussian noise. Every cheaper scheme tried here
        //   failed on some reachable case: greedy steals by array order; greedy + augmenting
        //   keeps cardinality but not identity; adding pair swaps and unary transfers still
        //   cannot follow an alternating path THROUGH an unmatched detection (tracks at 12/15
        //   with detections 9/11/20 stick at cost 26 when 25 exists), and each such failure
        //   surfaced as a manufactured mover.
        //
        // Sizes are tiny - tens of detections against the handful of tracks they gate onto - so
        // the O(n^2 m) Hungarian solve is nothing per frame.
        const cand = [];
        {
            const seen = new Set();
            for (const opts of options) {
                for (const [, t] of opts) {
                    if (!seen.has(t)) { seen.add(t); cand.push(t); }
                }
            }
        }
        const trackOwner = new Array(tracks.length).fill(-1);
        const matchedDet = new Set();
        if (cand.length) {
            const nDet = mapped.length;
            const tCol = new Map(cand.map((t, k) => [t, k]));
            const nCol = cand.length + nDet;
            // Any real pairing (cost <= r2) must beat leaving a detection to its dummy, even
            // when taking it forces other detections onto worse gated pairings.
            const DUMMY = (nDet + 1) * r2 + 1;
            const FORBID = 1e15;
            const rows = [];
            for (let m = 0; m < nDet; m++) {
                const row = new Float64Array(nCol).fill(FORBID);
                for (const [dd, t] of options[m]) row[tCol.get(t)] = dd;
                row[cand.length + m] = DUMMY;      // this detection's own "unmatched" column
                rows.push(row);
            }
            const rowCol = assignMinCost(rows, nCol);
            for (let m = 0; m < nDet; m++) {
                const c = rowCol[m];
                if (c >= 0 && c < cand.length) {
                    trackOwner[cand[c]] = m;
                    matchedDet.add(m);
                }
            }
        }

        for (let t = 0; t < trackOwner.length; t++) {
            const m = trackOwner[t];
            if (m === -1) continue;
            const {d, rx, ry} = mapped[m];
            const tr = tracks[t];
            tr.obs.push({f, x: d.x, y: d.y, rx, ry, src: d});
            tr.lx = rx; tr.ly = ry; tr.last = f;
        }
        for (let m = 0; m < mapped.length; m++) {
            if (matchedDet.has(m)) continue;
            const {d, rx, ry} = mapped[m];
            tracks.push({
                obs: [{f, x: d.x, y: d.y, rx, ry, src: d}],
                lx: rx, ly: ry, first: f, last: f,
            });
        }
    }
    for (const t of tracks) t.last = t.obs[t.obs.length - 1].f;
    return tracks;
}

/**
 * Exact minimum-cost assignment of rows to columns (the Hungarian algorithm, shortest-augmenting
 * -path form with potentials). `rows` is an array of n cost rows over `nCol` columns, n <= nCol;
 * returns for each row the column it was assigned. Every row is assigned - callers model
 * "unmatched" as an explicit dummy column, which keeps maximum-cardinality-then-minimum-cost a
 * single objective instead of two passes that can disagree.
 */
function assignMinCost(rows, nCol) {
    const n = rows.length;
    const INF = Number.MAX_VALUE / 4;
    const u = new Float64Array(n + 1);
    const v = new Float64Array(nCol + 1);
    const p = new Int32Array(nCol + 1);
    const way = new Int32Array(nCol + 1);
    for (let i = 1; i <= n; i++) {
        p[0] = i;
        let j0 = 0;
        const minv = new Float64Array(nCol + 1).fill(INF);
        const used = new Uint8Array(nCol + 1);
        do {
            used[j0] = 1;
            const i0 = p[j0];
            let delta = INF, j1 = 0;
            for (let j = 1; j <= nCol; j++) {
                if (used[j]) continue;
                const cur = rows[i0 - 1][j - 1] - u[i0] - v[j];
                if (cur < minv[j]) { minv[j] = cur; way[j] = j0; }
                if (minv[j] < delta) { delta = minv[j]; j1 = j; }
            }
            for (let j = 0; j <= nCol; j++) {
                if (used[j]) { u[p[j]] += delta; v[j] -= delta; }
                else minv[j] -= delta;
            }
            j0 = j1;
        } while (p[j0] !== 0);
        do {
            const j1 = way[j0];
            p[j0] = p[j1];
            j0 = j1;
        } while (j0);
    }
    const rowCol = new Int32Array(n).fill(-1);
    for (let j = 1; j <= nCol; j++) {
        if (p[j] > 0) rowCol[p[j] - 1] = j - 1;
    }
    return rowCol;
}

/**
 * Where a track should be at frame f, from a constant-velocity fit over its recent observations.
 *
 * The velocity comes from a least-squares line over the last few reference positions, and is only
 * trusted once there are enough of them spread over enough frames - below that the "velocity" is
 * two noise samples divided by a small number, and a stationary star would be predicted marching
 * off its own position. Until then the prediction is simply the last seen position, which is the
 * exact behaviour association always had.
 */
function trackPrediction(t, f) {
    const tail = t.obs.slice(-8);
    if (tail.length < 4) return [t.lx, t.ly];
    const span = tail[tail.length - 1].f - tail[0].f;
    if (span < 3) return [t.lx, t.ly];
    let sf = 0, sx = 0, sy = 0;
    for (const o of tail) { sf += o.f; sx += o.rx; sy += o.ry; }
    const mf = sf / tail.length, mx = sx / tail.length, my = sy / tail.length;
    let sff = 0, sfx = 0, sfy = 0;
    for (const o of tail) {
        const df = o.f - mf;
        sff += df * df; sfx += df * (o.rx - mx); sfy += df * (o.ry - my);
    }
    if (sff < 1e-9) return [t.lx, t.ly];
    const vx = sfx / sff, vy = sfy / sff;
    return [mx + vx * (f - mf), my + vy * (f - mf)];
}

/** How far the camera moved over the clip, as the largest corner displacement of any transform. */
function cameraMotionExtent(transforms) {
    let W = 1, H = 1;
    for (const T of transforms) {
        if (!T) continue;
        W = Math.max(W, Math.abs(T.B[0]) * 2);
        H = Math.max(H, Math.abs(T.B[1]) * 2);
    }
    let worst = 0;
    for (const T of transforms) {
        if (!T) continue;
        for (const [x, y] of [[0, 0], [W, 0], [0, H], [W, H]]) {
            const p = applyTransform(T, x, y);
            worst = Math.max(worst, Math.hypot(p[0] - x, p[1] - y));
        }
    }
    return worst;
}

/**
 * Tracks that are fixed in the FRAME rather than on the sky - hot pixels, dust, a reticle, an
 * internal reflection.
 *
 * Deliberately decided WITHOUT the noise estimate, because the noise estimate needs this answer.
 * Under a steady pan a camera-fixed artifact traces a near-perfect straight line in reference
 * coordinates - the pan is smooth, so the artifact's apparent sky motion is smooth too - which
 * makes its scatter about a linear fit essentially zero. That is precisely what the low-tail noise
 * estimator looks for, so eight artifacts among twenty genuinely noisy stars pulled sigma to the
 * floor and every real star was then judged incoherent against it.
 *
 * The test needs no sigma: it is the RATIO of how far a source moves in the frame against how far
 * it moves on the sky, gated on the sky excursion being a real fraction of the camera's own
 * measured motion. Both quantities come straight from the geometry.
 */
function findCameraFixedTracks(tracks, transforms, stars, O) {
    const motion = cameraMotionExtent(transforms);
    const fixed = new Set();
    if (motion < 1e-6) return fixed;      // a still camera cannot distinguish these at all
    const measured = [];

    for (let i = 0; i < tracks.length; i++) {
        if (!stars[i]) continue;
        const t = tracks[i];
        if (t.obs.length < O.minObservations) continue;

        const rxs = [], rys = [];
        for (const o of t.obs) {
            const T = transforms[o.f];
            if (!T) continue;
            const inv = invertTransform(T);
            if (!inv) continue;
            const [rx, ry] = applyTransform(inv, o.x, o.y);
            rxs.push(rx); rys.push(ry);
        }
        if (!rxs.length) continue;
        const rawSpan = span(t.obs.map((o) => o.x)) + span(t.obs.map((o) => o.y));
        const refSpan = span(rxs) + span(rys);
        measured.push({i, rawSpan, refSpan});
    }

    for (const m of measured) {
        if (m.refSpan > O.cameraFixedMinSkyFraction * motion
            && m.rawSpan < O.cameraFixedRatio * m.refSpan
            && m.rawSpan < O.cameraFixedMaxRawSpan) {
            fixed.add(m.i);
        }
    }
    return fixed;
}

/** Robust (median) centre of a track's back-projected positions under the current transforms. */
function starPosition(track, transforms) {
    const xs = [], ys = [];
    for (const o of track.obs) {
        const T = transforms[o.f];
        if (!T) continue;
        const inv = invertTransform(T);
        if (!inv) continue;
        const [rx, ry] = applyTransform(inv, o.x, o.y);
        xs.push(rx); ys.push(ry);
    }
    if (!xs.length) return null;
    xs.sort((a, b) => a - b); ys.sort((a, b) => a - b);
    return [xs[xs.length >> 1], ys[ys.length >> 1]];
}

/**
 * Solve every frame's transform and every star's position against one shared map.
 *
 * Alternating least squares, because both halves have exact closed forms:
 *   - with the star positions held, each frame's transform is the rigid fit between the map and
 *     that frame's observations - the same solve Stage 2 already uses - except that the ROTATIONS
 *     of all frames are then solved jointly under a temporal smoothness penalty and the
 *     translations re-estimated at the smoothed rotations (see applySmoothedTransforms; sparse
 *     frames are bistable on their own, and a camera's rotation is continuous);
 *   - with the transforms held, each star's position is the centre of its back-projected
 *     observations.
 * No gradients or step sizes are involved; convergence is judged on the data RMS reaching a
 * fixed value, and the smoothness term - being a penalty, not a constraint - leaves any
 * well-evidenced motion where the data puts it.
 *
 * GAUGE. The solution is only defined up to a global rigid motion: rotating the whole star map and
 * counter-rotating every frame changes nothing observable. Left free, that null direction wanders
 * and the iteration never settles. It is fixed by re-anchoring frame 0 to the identity after every
 * round, which makes the map's coordinates simply "frame 0 pixels".
 *
 * @param {Array} tracks - tracklets from {@link buildTracklets}
 * @param {Array} initialTransforms - Stage 2's chained transforms, used only as a starting point
 * @returns {{transforms: Array, stars: Array, rms: number, iterations: number, converged: boolean}}
 */
export function refineGlobal(tracks, initialTransforms, opts = {}) {
    const O = {...STAR_SOLVE_DEFAULTS, ...opts};
    const nFrames = initialTransforms.length;
    let transforms = initialTransforms.slice();

    // Seed the map from the chained solution.
    let stars = tracks.map((t) => starPosition(t, transforms));

    let rms = Infinity;
    let iterations = 0;
    let converged = false;

    // Outlier rejection inside the refinement is scaled to the MEASURED noise rather than left at
    // StarMatch's default gate. That default is 1.2 px, which suits clean synthetic astrometry and
    // is narrower than the real clip's 1.35 px scatter - so on real footage a fixed gate discards
    // a large share of perfectly good observations and the map is fitted to whichever ones
    // happened to fall inside it.
    let trim = O.refineTrimSigma * Math.max(O.noiseFloor, 1.0);

    for (let iter = 0; iter < O.refineIterations; iter++) {
        iterations = iter + 1;

        // --- transforms, given the map ---
        const frameFits = new Array(nFrames).fill(null);
        for (let f = 0; f < nFrames; f++) {
            const P = [], Q = [];
            for (let i = 0; i < tracks.length; i++) {
                if (!stars[i]) continue;
                const o = tracks[i].obs.find((ob) => ob.f === f);
                if (!o) continue;
                P.push(stars[i]);
                Q.push([o.x, o.y]);
            }
            const fit = fitSimilarity(P, Q, {...O, inlierThreshold: trim});
            if (fit) frameFits[f] = {fit, P, Q};
        }
        // Frames whose fit failed keep their held transform; only fitted frames are written.
        applySmoothedTransforms(frameFits, transforms, trim, O);

        // --- gauge: pin frame 0 to the identity ---
        const T0 = transforms.find((t) => t);
        if (T0) {
            const inv0 = invertTransform(T0);
            if (inv0) {
                stars = stars.map((s) => (s ? applyTransform(T0, s[0], s[1]) : null));
                transforms = transforms.map((t) => (t ? composeTransform(t, inv0) : t));
            }
        }

        // --- map, given the transforms ---
        stars = tracks.map((t) => starPosition(t, transforms));

        // --- cost ---
        let sse = 0, count = 0;
        for (let i = 0; i < tracks.length; i++) {
            if (!stars[i]) continue;
            for (const o of tracks[i].obs) {
                const T = transforms[o.f];
                if (!T) continue;
                const [px, py] = applyTransform(T, stars[i][0], stars[i][1]);
                sse += (px - o.x) ** 2 + (py - o.y) ** 2;
                count++;
            }
        }
        // Re-scale the trimming gate to the noise this solution actually shows, so later rounds
        // reject on evidence rather than on a constant chosen before anything was measured.
        trim = O.refineTrimSigma * estimateNoise(tracks, transforms, stars, O);

        const next = count ? Math.sqrt(sse / count) : Infinity;
        if (Math.abs(rms - next) < O.refineTolerance) { rms = next; converged = true; break; }
        rms = next;
    }

    return {transforms, stars, rms, iterations, converged};
}

/**
 * Write the per-frame fits back into `transforms`, with the rotations solved JOINTLY under a
 * second-difference smoothness penalty rather than each frame keeping its own independent answer.
 *
 * See refineSmoothness in STAR_SOLVE_DEFAULTS for why. The mechanics:
 *
 *   minimise  sum_f w_f (theta_f - thetaHat_f)^2  +  lambda sum_f (theta_{f-1} - 2 theta_f + theta_{f+1})^2
 *
 * where thetaHat_f is the frame's independently fitted rotation and w_f is the curvature of that
 * frame's least-squares cost with respect to rotation - which, with the translation eliminated, is
 * exactly the inlier spread about the inlier centroid, sum |p - pbar|^2. So the units agree: both
 * terms are px^2 per rad^2, and lambda expressed as a multiple of the median w compares like with
 * like. The system is pentadiagonal and positive definite, solved directly.
 *
 * Frames whose fit failed take part in the chain with zero data weight, so their angle is
 * interpolated and their neighbours connect through the gap rather than around it. For such a
 * frame BETWEEN two fitted frames the interpolated transform is also WRITTEN, because the
 * alternative is measurably worse: the held transform is a stale copy from the chained
 * initialisation, and on the target clip the one dropout frame's held copy sat 2 deg off the
 * smoothed trend - a single-frame spike that broke track association straight through it. The
 * translation interpolates between the fitted neighbours by rotation fraction, which is
 * first-order exact for rotation about any fixed centre (B(theta) = c - R(theta) c is smooth in
 * theta). Frames outside the fitted range still hold, since extrapolation has no second anchor.
 *
 * The translation is then RE-ESTIMATED at the pinned rotation rather than kept from the fit. The
 * two are not separable: B is the mean of (q - A p) over inliers, so a fit that locked onto the
 * wrong rotation regime carries a translation consistent with that wrong rotation - the observed
 * 15-53 px translation jumps were 1.2 deg rotation flips seen through a ~700 px lever arm. The
 * re-estimate is median-seeded and annealed, the same consensus mechanism fitSimilarity uses, so
 * on a frame holding two regimes the majority sets B rather than whichever subset the fit found.
 */
function applySmoothedTransforms(frameFits, transforms, trim, O) {
    const n = frameFits.length;
    const withFit = [];
    for (let f = 0; f < n; f++) if (frameFits[f]) withFit.push(f);
    const raw = () => {
        for (const f of withFit) {
            const {fit} = frameFits[f];
            transforms[f] = {A: fit.A, B: fit.B};
        }
    };
    // Smoothing a SCALED transform's angle alone would silently discard the scale, so it only
    // runs on the unit-scale (rotation only) model - which is the default, and the right model
    // for stars at infinity.
    if (!(O.refineSmoothness > 0) || O.allowScale || withFit.length < 3) { raw(); return; }

    const thetaHat = new Float64Array(n);
    const w = new Float64Array(n);
    let prev = 0;
    for (const f of withFit) {
        const {fit, P} = frameFits[f];
        // Unwrap against the previous fitted frame, so the smoothness penalty never sees a 2*pi
        // seam as a physical swing.
        let th = Math.atan2(fit.A[1], fit.A[0]);
        while (th - prev > Math.PI) th -= 2 * Math.PI;
        while (th - prev < -Math.PI) th += 2 * Math.PI;
        thetaHat[f] = th;
        prev = th;

        let sx = 0, sy = 0, m = 0;
        for (let i = 0; i < P.length; i++) {
            if (!fit.inlierMask[i]) continue;
            sx += P[i][0]; sy += P[i][1]; m++;
        }
        if (m) { sx /= m; sy /= m; }
        let dd = 0;
        for (let i = 0; i < P.length; i++) {
            if (!fit.inlierMask[i]) continue;
            dd += (P[i][0] - sx) ** 2 + (P[i][1] - sy) ** 2;
        }
        w[f] = dd;
    }
    const lambda = O.refineSmoothness * (medianOf(withFit.map((f) => w[f])) ?? 0);
    if (!(lambda > 0)) { raw(); return; }

    // Normal matrix diag(w) + lambda * D^T D, with D the second-difference operator. Bandwidth 2.
    const d0 = new Float64Array(n), d1 = new Float64Array(n), d2 = new Float64Array(n);
    const rhs = new Float64Array(n);
    for (let f = 0; f < n; f++) { d0[f] = w[f]; rhs[f] = w[f] * thetaHat[f]; }
    for (let j = 1; j + 1 < n; j++) {
        // Row theta_{j-1} - 2 theta_j + theta_{j+1}: coefficients [1, -2, 1].
        d0[j - 1] += lambda; d0[j] += 4 * lambda; d0[j + 1] += lambda;
        d1[j - 1] += -2 * lambda; d1[j] += -2 * lambda;
        d2[j - 1] += lambda;
    }
    const theta = solveBanded2(d0, d1, d2, rhs);
    if (!theta) { raw(); return; }

    for (const f of withFit) {
        const {fit, P, Q} = frameFits[f];
        const A = [Math.cos(theta[f]), Math.sin(theta[f])];
        const B = robustTranslationAtRotation(P, Q, A, trim);
        transforms[f] = B ? {A, B} : {A: fit.A, B: fit.B};
    }

    // Interior gaps: write the interpolated transform rather than leaving the stale held copy.
    const firstFit = withFit[0], lastFit = withFit[withFit.length - 1];
    let left = firstFit;
    for (let f = firstFit + 1; f < lastFit; f++) {
        if (frameFits[f]) { left = f; continue; }
        let right = f + 1;
        while (!frameFits[right]) right++;
        const Tl = transforms[left], Tr = transforms[right];
        if (!Tl || !Tr) continue;
        const thL = theta[left], thR = theta[right];
        // Fraction along the rotation, falling back to frame position when the two ends carry
        // essentially the same angle.
        // Clamped, because the spline's angle at a free node can overshoot its anchors slightly.
        const t = Math.min(1, Math.max(0, Math.abs(thR - thL) > 1e-9
            ? (theta[f] - thL) / (thR - thL)
            : (f - left) / (right - left)));
        transforms[f] = {
            A: [Math.cos(theta[f]), Math.sin(theta[f])],
            B: [Tl.B[0] + (Tr.B[0] - Tl.B[0]) * t, Tl.B[1] + (Tr.B[1] - Tl.B[1]) * t],
        };
    }
}

/**
 * Symmetric positive-definite banded solve, bandwidth 2, by LDL^T. `d1[k]` holds M[k][k+1] and
 * `d2[k]` holds M[k][k+2]. Returns null if the factorisation encounters a non-positive pivot,
 * which for this matrix means the input was degenerate rather than merely ill-conditioned.
 */
function solveBanded2(d0, d1, d2, b) {
    const n = d0.length;
    const D = new Float64Array(n), e1 = new Float64Array(n), e2 = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        let l2 = 0, l1 = 0;
        if (i >= 2) l2 = d2[i - 2] / D[i - 2];
        if (i >= 1) {
            let a = d1[i - 1];
            if (i >= 2) a -= l2 * D[i - 2] * e1[i - 1];
            l1 = a / D[i - 1];
        }
        let di = d0[i];
        if (i >= 1) di -= l1 * l1 * D[i - 1];
        if (i >= 2) di -= l2 * l2 * D[i - 2];
        if (!(di > 1e-12)) return null;
        D[i] = di; e1[i] = l1; e2[i] = l2;
    }
    const y = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        let v = b[i];
        if (i >= 1) v -= e1[i] * y[i - 1];
        if (i >= 2) v -= e2[i] * y[i - 2];
        y[i] = v;
    }
    const x = new Float64Array(n);
    for (let i = n - 1; i >= 0; i--) {
        let v = y[i] / D[i];
        if (i + 1 < n) v -= e1[i + 1] * x[i + 1];
        if (i + 2 < n) v -= e2[i + 2] * x[i + 2];
        x[i] = v;
    }
    return x;
}

/**
 * Least-squares translation at a FIXED rotation, robustly: seed from the component-wise median of
 * the per-pair displacements q - A p, then anneal a mean toward the trimming gate. The median
 * tolerates almost half the pairs disagreeing, which is the situation on a frame straddling two
 * rotation regimes - the pairs from the wrong regime scatter, the right ones agree exactly.
 */
function robustTranslationAtRotation(P, Q, A, gate) {
    const n = P.length;
    if (!n) return null;
    const dx = new Array(n), dy = new Array(n);
    for (let i = 0; i < n; i++) {
        dx[i] = Q[i][0] - (A[0] * P[i][0] - A[1] * P[i][1]);
        dy[i] = Q[i][1] - (A[1] * P[i][0] + A[0] * P[i][1]);
    }
    let mx = medianOf(dx), my = medianOf(dy);
    if (mx === null || my === null) return null;
    const start = STAR_MATCH_DEFAULTS.startThresholdFactor;
    const rounds = 4;
    for (let r = 0; r < rounds; r++) {
        const t = gate * (start + (1 - start) * (r / (rounds - 1)));
        let sx = 0, sy = 0, m = 0;
        for (let i = 0; i < n; i++) {
            if (Math.hypot(dx[i] - mx, dy[i] - my) < t) { sx += dx[i]; sy += dy[i]; m++; }
        }
        // An empty gate means the consensus so far is the best available; hold it rather than
        // tighten onto nothing.
        if (!m) break;
        mx = sx / m; my = sy / m;
    }
    return [mx, my];
}

/**
 * Robust estimate of the per-observation astrometric noise, in pixels.
 *
 * Taken as the median over tracks of each track's own residual scatter. Using the median twice
 * keeps genuine movers - whose residuals are large by definition - from inflating the very number
 * their significance is measured against.
 */
export function estimateNoise(tracks, transforms, stars, opts = {}) {
    const O = {...STAR_SOLVE_DEFAULTS, ...opts};
    // Pooled over every observation, via the median absolute residual.
    //
    // Taking each track's own median first and then the median of those is tempting and wrong: a
    // star's residual comes from a fit DRIVEN BY THAT STAR, so it is biased low by overfitting.
    // On a synthetic clip that route reported 0.05 px where the astrometry is really ~0.3 px, and
    // since every classification threshold is expressed in sigmas, a six-fold underestimate makes
    // a drift of 0.02 px/frame look "8.9 sigma significant". Pooling, and flooring the result,
    // keeps sigma an estimate of measurement noise rather than of how well the fit closed.
    // Scatter measured about each track's OWN LINEAR TREND, one value per track, then a LOW
    // QUANTILE across tracks - not a median, and not a classify-then-re-estimate loop.
    //
    // Measuring against the track's fixed map position instead would conflate motion with noise:
    // a mover's residual is dominated by the fact that it moved, so the object contributes a huge
    // value to the very estimate its significance is judged against - it hides behind its own
    // noise contribution. Residual about a fitted line is the measurement scatter whether the line
    // is flat (a star) or steep (a mover), so this decouples the noise estimate from the
    // classification it feeds.
    //
    // Short tracks are excluded: a track's position is derived from its own observations, so with
    // very few of them the residual is small by construction rather than by measurement, and real
    // footage produces those in bulk (417 of 475 tracklets on the target clip).
    //
    // Tracks are weighted EQUALLY - one value each, not one per observation - so a single long
    // track cannot outvote many short ones. The across-track statistic is then a LOW QUANTILE
    // rather than a median, so poorly-behaved tracks cannot set the noise level even in numbers.
    // Camera-fixed artifacts are excluded before anything is measured. Under a steady pan they
    // trace near-perfect lines in reference coordinates, so their scatter about a linear fit is
    // near zero - exactly what the low tail selects for, and they would set the noise level for
    // the whole field.
    const artifacts = findCameraFixedTracks(tracks, transforms, stars, O);

    const perTrack = [];
    for (let i = 0; i < tracks.length; i++) {
        if (!stars[i]) continue;
        if (artifacts.has(i)) continue;
        if (tracks[i].obs.length < O.minObservations) continue;

        const pts = [];
        for (const o of tracks[i].obs) {
            const T = transforms[o.f];
            if (!T) continue;
            const inv = invertTransform(T);
            if (!inv) continue;
            const [rx, ry] = applyTransform(inv, o.x, o.y);
            pts.push([o.f, rx, ry]);
        }
        if (pts.length < 3) continue;

        let sf = 0, sx = 0, sy = 0;
        for (const [f, x, y] of pts) { sf += f; sx += x; sy += y; }
        const mf = sf / pts.length, mx = sx / pts.length, my = sy / pts.length;
        let sxx = 0, sfx = 0, sfy = 0;
        for (const [f, x, y] of pts) {
            const df = f - mf;
            sxx += df * df; sfx += df * (x - mx); sfy += df * (y - my);
        }
        const bx = sxx > 1e-9 ? sfx / sxx : 0;
        const by = sxx > 1e-9 ? sfy / sxx : 0;
        const r = pts.map(([f, x, y]) =>
            Math.hypot(x - (mx + bx * (f - mf)), y - (my + by * (f - mf))));
        r.sort((a, b) => a - b);
        perTrack.push(r[r.length >> 1]);
    }
    if (!perTrack.length) return O.noiseFloor;
    const res = perTrack;
    res.sort((a, b) => a - b);

    // A LOW QUANTILE, not the median.
    //
    // What is wanted is the noise of well-measured sources, and the well-measured ones are by
    // definition the low tail - so reading the distribution near its bottom estimates them even
    // when they are outnumbered. The median does not: a population of poorly-behaved tracks
    // (blends, random-walking noise chains, anything that scraped past minObservations) each
    // contributes a large scatter, and once they are a sizeable minority the median follows them.
    // Twenty-five random-walking tracks held sigma at 6.06 px, and a mover has to clear a multiple
    // of sigma, so a 39.5 px mover then reads as a star.
    //
    // Classifying first and re-estimating from the survivors does NOT escape this, however many
    // passes it runs: with sigma already inflated, the scatter cut that would have marked those
    // tracks incoherent is inflated in exactly the same proportion, so they are admitted as stars
    // and hold sigma up. The circularity is in asking the classification to identify the junk, and
    // the fix is an estimator that does not need it to.
    //
    // These residuals are 2D DISTANCES, so with per-axis Gaussian error they follow a Rayleigh
    // distribution, whose median is sigma * sqrt(2 ln 2) = 1.1774 sigma. Treating them as a
    // one-dimensional spread and applying the usual 1.4826 MAD factor would overstate the per-axis
    // sigma by 1.75x. The quantile is corrected to the equivalent Rayleigh sigma the same way.
    // The quantile selects WHICH TRACK's scatter to trust; the 1.1774 converts that track's own
    // median residual into a sigma. The two corrections operate at different levels and must not
    // be conflated - applying a Rayleigh quantile factor to the across-track quantile treats
    // per-track medians as if they were raw Rayleigh samples, and overestimates sigma by ~1.5x.
    const q = Math.min(0.99, Math.max(0.01, O.noiseQuantile));
    const idx = Math.min(res.length - 1, Math.floor(q * res.length));
    return Math.max(O.noiseFloor, res[idx] / 1.1774);
}

/**
 * Classify each tracklet against the refined star map.
 *
 * Because the refinement removed the chain drift, a track's residual against the map IS its motion
 * relative to the sky - no common-mode subtraction, and therefore no assumption smuggled in about
 * what the common mode ought to be.
 *
 * Every threshold is expressed in sigmas of the measured astrometric noise rather than in pixels,
 * so the same settings behave the same way on a clean clip and a noisy one.
 *
 * Classes:
 *   star          - fixed on the sky within the noise
 *   moving        - a statistically significant, coherent drift against the sky
 *   cameraFixed   - fixed in the FRAME while the sky moves past (hot pixel, dust, reticle, flare)
 *   incoherent    - detected repeatedly but scattered; noise, or a blend that never settled
 *   short         - too few detections to say anything
 */
export function classifyTracks(tracks, transforms, stars, opts = {}) {
    const O = {...STAR_SOLVE_DEFAULTS, ...opts};

    // A single pass. estimateNoise reads the low tail of the scatter distribution, so it does not
    // need the classification to tell it which tracks are real sources - which is what made an
    // earlier classify-then-re-estimate loop circular rather than convergent.
    const sigma = estimateNoise(tracks, transforms, stars, O);
    return classifyAtNoise(tracks, transforms, stars, O, sigma);
}

function classifyAtNoise(tracks, transforms, stars, O, sigma) {
    const artifacts = findCameraFixedTracks(tracks, transforms, stars, O);
    const out = [];

    for (let i = 0; i < tracks.length; i++) {
        const t = tracks[i];
        const n = t.obs.length;
        const rec = {
            index: i, n, first: t.first, last: t.last,
            position: stars[i], sigma,
        };

        if (n < O.minObservations || !stars[i]) {
            out.push({...rec, klass: "short"});
            continue;
        }

        // Residuals against the map, in REFERENCE coordinates, so a drift is measured on the sky
        // rather than in the frame.
        const rs = [];
        for (const o of t.obs) {
            const T = transforms[o.f];
            if (!T) continue;
            const inv = invertTransform(T);
            if (!inv) continue;
            const [rx, ry] = applyTransform(inv, o.x, o.y);
            rs.push([o.f, rx - stars[i][0], ry - stars[i][1]]);
        }
        if (rs.length < O.minObservations) {
            out.push({...rec, klass: "short"});
            continue;
        }

        // Least-squares drift, and its significance against the NOISE - not against this track's
        // own residual, which a genuine mover would inflate until its motion looked ordinary.
        let sf = 0, sxx = 0, sfx = 0, sfy = 0, sx = 0, sy = 0;
        for (const [f, dx, dy] of rs) { sf += f; sx += dx; sy += dy; }
        const mf = sf / rs.length, mx = sx / rs.length, my = sy / rs.length;
        for (const [f, dx, dy] of rs) {
            const df = f - mf;
            sxx += df * df;
            sfx += df * (dx - mx);
            sfy += df * (dy - my);
        }
        const bx = sxx > 1e-9 ? sfx / sxx : 0;
        const by = sxx > 1e-9 ? sfy / sxx : 0;
        // Standard error of a slope is sigma / sqrt(sum of squared deviations in the abscissa).
        const se = sxx > 1e-9 ? sigma / Math.sqrt(sxx) : Infinity;
        const drift = Math.hypot(bx, by);
        const significance = se > 0 && isFinite(se) ? drift / se : 0;

        // Scatter about the track's own mean position.
        let sse = 0;
        for (const [, dx, dy] of rs) sse += (dx - mx) ** 2 + (dy - my) ** 2;
        const scatter = Math.sqrt(sse / rs.length);

        // Fixed in the FRAME rather than on the sky. Stated as a RATIO of how far the source moves
        // in the frame against how far it moves on the sky, which is scale-free: a hot pixel holds
        // its pixel position while the sky sweeps past, so the ratio is tiny; a star does the
        // reverse; a genuine mover does neither. An absolute "raw span below a few sigma" test
        // fails here because ordinary detection jitter already exceeds a sigma that small.
        const rawSpan = span(t.obs.map((o) => o.x)) + span(t.obs.map((o) => o.y));
        const refSpan = span(rs.map((r) => r[1])) + span(rs.map((r) => r[2]));
        const cameraFixed = artifacts.has(i);

        // Total displacement over the life of the track, which is the quantity a reader actually
        // cares about - "it moved 40 px against the stars" - as opposed to a slope.
        const frameSpan = rs[rs.length - 1][0] - rs[0][0];
        const totalDrift = drift * frameSpan;

        // How reliably the source was actually detected over the span it covers. A track that
        // appears in a tenth of its own frames is not a steady point of light being occasionally
        // missed - it is more likely a series of unrelated blips that association strung together,
        // and neither "star" nor "moving" is a claim worth making about it.
        //
        // A MERGED track is judged over the UNION of its pieces' spans, not first-to-last: the
        // merge exists precisely because the star spent the frames between its pieces below the
        // detection threshold, so counting that gap as "frames it should have been seen in"
        // makes every long-gap merge read as a blip chain - and the verifier then refutes
        // exactly the merges the mechanism was built for. A genuine interval union, not a sum
        // of lengths: pieces whose spans overlap (sparse pieces interleaved by association)
        // would have the overlap double-counted by a sum, deflating the fraction below the bar
        // for tracks the union clears comfortably.
        const spanFrames = t.mergedFrom
            ? unionSpanLength(t.mergedFrom)
            : (t.last - t.first + 1);
        const visible = rs.length / Math.max(1, spanFrames);

        let klass;
        if (cameraFixed) klass = "cameraFixed";
        else if (visible < O.minVisibleFraction) klass = "incoherent";
        else if (significance > O.driftSignificance && totalDrift > O.driftMinSigmas * sigma) klass = "moving";
        else if (scatter > O.scatterSigma * sigma) klass = "incoherent";
        else klass = "star";

        out.push({
            ...rec, klass,
            drift, driftPerFrame: drift, significance, scatter, visible,
            rawSpan, refSpan, totalDrift,
            ...instrumentalMagnitude(t),
        });
    }
    return out;
}

function span(a) {
    if (!a.length) return 0;
    return Math.max(...a) - Math.min(...a);
}

/** Total frames covered by the union of the pieces' [first, last] intervals. */
function unionSpanLength(pieces) {
    const iv = pieces.map((p) => [p.first, p.last]).sort((a, b) => a[0] - b[0]);
    let total = 0;
    let [curA, curB] = iv[0];
    for (let k = 1; k < iv.length; k++) {
        const [a, b] = iv[k];
        if (a > curB + 1) {
            total += curB - curA + 1;
            curA = a; curB = b;
        } else {
            curB = Math.max(curB, b);
        }
    }
    return total + (curB - curA + 1);
}

function medianOf(a) {
    if (!a.length) return null;
    const s = a.slice().sort((x, y) => x - y);
    return s[s.length >> 1];
}

/**
 * Instrumental magnitude of a track, on the usual -2.5*log10(flux) scale.
 *
 * Computed here from what StarDetect actually measures rather than read from a `mag` field, which
 * the detector does not produce - reading one silently returned null for every real
 * detector-backed result while photometry sat unused in the same object.
 *
 * Aperture flux is preferred because it is the unbiased measure; isophotal flux stands in when the
 * aperture was incomplete or contaminated, since a biased magnitude beats none at all. Uncontested
 * apertures are used in preference to contested ones, and the median across the track resists the
 * odd frame where the source was clipped by the laser or the frame edge.
 */
function instrumentalMagnitude(track) {
    // Three tiers, in order of how trustworthy the measurement is.
    //
    // A CONTAMINATED aperture ranks BELOW isophotal flux, not above it. Both are wrong, but they
    // are wrong in different ways: isophotal flux carries a known, uniform scale error (a slope of
    // ~1.55 against true magnitude), so a field measured that way stays internally consistent and
    // is off by a stretch. A contaminated aperture has swallowed an arbitrary amount of some
    // neighbour's light, so its error depends on which neighbour and how close - it corrupts the
    // ORDERING, which is the one property a magnitude has to preserve.
    const clean = [], isophotal = [], contaminated = [];
    for (const o of track.obs) {
        const s = o.src;
        if (!s) continue;
        const ap = s.apertureFlux;
        if (ap > 0 && s.apertureComplete && !s.apertureContaminated) clean.push(ap);
        else if (s.flux > 0) isophotal.push(s.flux);
        else if (ap > 0) contaminated.push(ap);
    }
    let use = null, source = null;
    if (clean.length) { use = clean; source = "aperture"; }
    else if (isophotal.length) { use = isophotal; source = "isophotal"; }
    else if (contaminated.length) { use = contaminated; source = "contaminated"; }
    if (!use) return {magnitude: null, magnitudeSource: null};
    return {magnitude: -2.5 * Math.log10(medianOf(use)), magnitudeSource: source};
}

/**
 * Merge tracks that are pieces of the same star. See starMergeRadius in STAR_SOLVE_DEFAULTS for
 * the discriminator; this is deliberately done on CLASSIFIED stars only, because position is only
 * an identity for something that holds one.
 *
 * Merging is not just bookkeeping. A merged track ties every frame it touches to ONE map entry,
 * so a star seen early and late in the clip becomes a single constraint spanning both ends - the
 * strongest global stiffening the refinement can get, and precisely what dissolves a residual
 * offset between two stretches of the clip that were solved against duplicate entries.
 *
 * On frames where two member tracks both hold an observation - the handover overlap - the one
 * nearer the group's position is kept, preserving the one-position-per-instant property the
 * association enforced.
 *
 * @returns {Array|null} the new track list, or null if nothing merged
 */
function mergeSplitStarTracks(tracks, classified, transforms, O, forbidden = []) {
    if (!(O.starMergeRadius > 0)) return null;      // 0 disables merging entirely
    const stars = classified.filter((c) => c.klass === "star" && c.position);
    if (stars.length < 2) return null;

    const position = new Map(stars.map((c) => [c.index, c.position]));
    const frameSets = new Map(stars.map((c) =>
        [c.index, new Set(tracks[c.index].obs.map((o) => o.f))]));

    // Whether these two tracks could be pieces of ONE star: close AND temporally complementary.
    const r2 = O.starMergeRadius * O.starMergeRadius;
    const sameStar = (i, j) => {
        const p = position.get(i), q = position.get(j);
        const dd = (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2;
        if (dd > r2) return false;
        const fa = frameSets.get(i), fb = frameSets.get(j);
        let shared = 0;
        for (const f of fb) if (fa.has(f)) shared++;
        return shared <= O.starMergeMaxSharedFrames;
    };

    // COMPLETE linkage, not pairwise chaining. Following pairwise links transitively lets a
    // short fragment sitting between two genuinely distinct stars - which is exactly what a
    // blend's leftover detections produce - act as a bridge: the fragment is complementary to
    // each star separately, so single linkage fuses all three, and the chimera track alternates
    // between two positions, reading as a mover manufactured out of stationary stars. Requiring
    // EVERY cross-pair of the final group to satisfy the same-star conditions makes that
    // impossible, because the two real stars coexist and can never share a group. Pairs are
    // taken nearest-first so the fragment joins whichever star it actually belongs to.
    const pairs = [];
    for (let a = 0; a < stars.length; a++) {
        for (let b = a + 1; b < stars.length; b++) {
            const ia = stars[a].index, ib = stars[b].index;
            if (!sameStar(ia, ib)) continue;
            const p = position.get(ia), q = position.get(ib);
            pairs.push([(p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2, ia, ib]);
        }
    }
    if (!pairs.length) return null;
    pairs.sort((p, q) => p[0] - q[0]);

    const groupOf = new Map(stars.map((c) => [c.index, [c.index]]));
    let any = false;
    for (const [, a, b] of pairs) {
        const ga = groupOf.get(a), gb = groupOf.get(b);
        if (ga === gb) continue;
        let compatible = true;
        for (const i of ga) {
            for (const j of gb) {
                if (!sameStar(i, j)) { compatible = false; break; }
            }
            if (!compatible) break;
        }
        if (!compatible) continue;
        // A combination the verifier has refuted must not be rebuilt. Supersets are refused
        // too: adding a fourth piece to a falsified trio does not rehabilitate the trio.
        const union = new Set([...ga, ...gb].map((i) => tracks[i]));
        if (forbidden.some((set) => set.every((t) => union.has(t)))) continue;
        for (const j of gb) {
            ga.push(j);
            groupOf.set(j, ga);
        }
        any = true;
    }
    if (!any) return null;

    const groups = new Map();
    for (const c of stars) {
        const g = groupOf.get(c.index);
        if (!groups.has(g)) groups.set(g, g);
    }
    const drop = new Set();
    const merged = [];
    for (const members of groups.values()) {
        if (members.length < 2) continue;
        for (const i of members) drop.add(i);
        const cx = members.reduce((s, i) => s + position.get(i)[0], 0) / members.length;
        const cy = members.reduce((s, i) => s + position.get(i)[1], 0) / members.length;
        const refDist = (o) => {
            const T = transforms[o.f];
            const inv = T && invertTransform(T);
            if (!inv) return Infinity;
            const [rx, ry] = applyTransform(inv, o.x, o.y);
            return Math.hypot(rx - cx, ry - cy);
        };
        const byFrame = new Map();
        for (const i of members) {
            for (const o of tracks[i].obs) {
                const prev = byFrame.get(o.f);
                if (!prev || refDist(o) < refDist(prev)) byFrame.set(o.f, o);
            }
        }
        const obs = [...byFrame.values()].sort((p, q) => p.f - q.f);
        // The original pieces ride along, because the merge is a HYPOTHESIS - see
        // mergeAndVerify, which takes a merged track apart again if its behaviour falsifies it.
        merged.push({
            obs, first: obs[0].f, last: obs[obs.length - 1].f,
            mergedFrom: members.map((i) => tracks[i]),
        });
    }
    return tracks.filter((_, i) => !drop.has(i)).concat(merged);
}

/**
 * Merge split star tracks, then hold the merges to what they claim.
 *
 * A merge asserts its pieces are ONE STATIONARY star. No threshold can make that assertion safe
 * by itself: whatever the radius and overlap allowance, two distinct stars whose visibilities
 * hand over inside those gates produce a chimera - stepping between positions as a fake mover,
 * or scattering as fake incoherence. But the assertion is CHECKABLE after the fact: the merged
 * track must still classify as a STAR, and anything else refutes it. "Moving" alone is not the
 * test - an A-B-A handover chimera classifies incoherent, which would quietly replace two real
 * stars with one rejected track.
 *
 * A refuted merge is not simply reverted, because part of it may be right: in that A-B-A case,
 * A's own two pieces really are one star. The refuted COMBINATION is forbidden and the merge
 * re-runs from the original tracks, so the good sub-merges survive while the chimera cannot
 * re-form. And the verification repeats after every rebuild: reclassification re-measures the
 * noise, so a merge that passed in one round can fail in the next, and a single-pass check
 * would ship it. Each round forbids at least one combination, so the loop terminates; the cap
 * is a backstop, and exhausting it abandons merging entirely rather than shipping unverified
 * merges. A genuine mover is never touched by any of this - only star-classified tracks are
 * merged in the first place.
 *
 * @returns {{tracks: Array, stars: Array, classified: Array}|null} null when nothing merged
 */
function mergeAndVerify(tracks, classified, transforms, O) {
    const forbidden = [];
    let merged = mergeSplitStarTracks(tracks, classified, transforms, O, forbidden);
    if (!merged) return null;

    for (let round = 0; round < 20; round++) {
        const stars = merged.map((t) => starPosition(t, transforms));
        const cls = classifyTracks(merged, transforms, stars, O);
        const refuted = cls.filter((c) => c.klass !== "star" && merged[c.index].mergedFrom);
        if (!refuted.length) return {tracks: merged, stars, classified: cls};

        for (const c of refuted) forbidden.push(merged[c.index].mergedFrom);
        merged = mergeSplitStarTracks(tracks, classified, transforms, O, forbidden);
        if (!merged) return null;      // nothing mergeable remains outside the refuted sets
    }
    return null;
}

/**
 * The whole of Stage 3: tracklets, a globally refined map, classification, and a second refinement
 * using only the confirmed stars.
 *
 * The second pass matters. The first refinement necessarily includes everything - the mover and any
 * artifacts among them - and those pull on the very transforms used to judge them. Re-solving on
 * the confirmed stars alone gives a map built from things that actually belong to the sky, and the
 * classification is then repeated against it.
 */
export function solveStarField(perFrame, cumulative, opts = {}) {
    const O = {...STAR_SOLVE_DEFAULTS, ...opts};
    let tracks = buildTracklets(perFrame, cumulative, O);
    if (!tracks.length) {
        // Same shape as every other return, so callers need one code path rather than two.
        return {
            tracks: [], classified: [], transforms: cumulative, stars: [],
            rms: Infinity, iterations: 0, converged: false,
        };
    }

    // Only well-observed tracks may shape the map.
    //
    // On real footage most detections are transient - faint sources flickering across the
    // threshold - so the median tracklet lives ~15 frames out of 179 while a handful of real stars
    // span the whole clip. Refining over everything lets several hundred three-observation
    // fragments outvote the stars, and the residual against the resulting "map" came to 31 px.
    // A track seen a handful of times carries no information about a global map anyway: its
    // position is fitted almost exactly by construction, so it constrains nothing and only adds
    // noise. Everything is still CLASSIFIED against the finished map; this restricts what is
    // allowed to build it.
    const anchors = (list) => list.filter((t) => t.obs.length >= O.minObservations);

    let solveSet = anchors(tracks);
    if (solveSet.length < 3) solveSet = tracks;
    const first = refineGlobal(solveSet, cumulative, O);

    // Rebuild the tracklets against the refined transforms before believing any of them.
    //
    // The first association ran on the CHAINED transforms, which drift - by about as much as the
    // association radius over a couple of dozen frames. A track can therefore stray from one star
    // onto its neighbour partway through, and such a track shows a small, extremely significant
    // drift: it really did move against the map, just not because anything in the sky did.
    // Re-associating in a drift-free frame removes the cause rather than trying to filter the
    // symptom.
    tracks = buildTracklets(perFrame, first.transforms, O);
    let solveSet2 = anchors(tracks);
    if (solveSet2.length < 3) solveSet2 = tracks;
    let refined = refineGlobal(solveSet2, first.transforms, O);
    // Place every track - including the short ones - in the map the anchors define.
    let allStars = tracks.map((t) => starPosition(t, refined.transforms));
    let classified = classifyTracks(tracks, refined.transforms, allStars, O);

    // Rejoin the pieces of any star that association could not keep whole - a dropout longer
    // than trackMaxGap, or a blend handover - BEFORE the star-only refinement, so a rejoined
    // star constrains that refinement across its full span rather than as two half-weight
    // fragments. Classification is redone on the merged list, and any merge falsified by its
    // own result is undone (see mergeAndVerify).
    const firstMerge = mergeAndVerify(tracks, classified, refined.transforms, O);
    if (firstMerge) {
        tracks = firstMerge.tracks;
        allStars = firstMerge.stars;
        classified = firstMerge.classified;
    }

    // Re-solve using only what belongs to the sky. The first solve necessarily includes the mover
    // and any artifacts, and those pull on the very transforms used to judge them.
    const starTracks = classified
        .filter((c) => c.klass === "star" && tracks[c.index].obs.length >= O.minObservations)
        .map((c) => tracks[c.index]);
    if (starTracks.length >= 3) {
        refined = refineGlobal(starTracks, refined.transforms, O);
    }

    // One FINAL association against the settled transforms, and a final merge and classification
    // on what it produces.
    //
    // Association quality is bounded by the transforms it runs under, and every association so
    // far ran under a solution that still contained the seams later stages repair - the merge and
    // the star-only refinement smooth the very stretch where a track had been cut, which is how
    // the object's two halves ended up 2.6 px apart at a seam and still in different tracks. The
    // transforms are settled now, so this costs one tracklet build and no further refinement.
    tracks = buildTracklets(perFrame, refined.transforms, O);
    allStars = tracks.map((t) => starPosition(t, refined.transforms));
    classified = classifyTracks(tracks, refined.transforms, allStars, O);
    const finalMerge = mergeAndVerify(tracks, classified, refined.transforms, O);
    if (finalMerge) {
        tracks = finalMerge.tracks;
        allStars = finalMerge.stars;
        classified = finalMerge.classified;
    }
    refined = {...refined, stars: allStars};

    return {
        tracks,
        classified,
        transforms: refined.transforms,
        stars: refined.stars,
        rms: refined.rms,
        iterations: refined.iterations,
        converged: refined.converged,
    };
}
