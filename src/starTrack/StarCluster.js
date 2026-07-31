// Stage 4 of Star Track: grouping the lights that belong to one moving OBJECT.
//
// An aircraft is not a point of light. It is several lights in rigid formation - and some of them
// FLASH, so each contributes short, gap-riddled tracks that individually classify as "short" or
// "incoherent" and would be discarded. What identifies the ensemble is not any track's own
// quality but the AGREEMENT of their motion: every light on the airframe crosses the sky with the
// same velocity, holding formation, while unrelated transients agree with nothing.
//
// So grouping happens on motion models, not on positions. Each candidate track gets a linear fit
// in reference coordinates; tracks whose velocities agree within their joint uncertainty AND
// whose predicted positions at a common epoch sit within one formation radius are clustered.
// Lights seen too briefly to carry a velocity of their own - a strobe's individual flashes - are
// then ATTACHED to a cluster if their observations lie on its predicted path at their own frames.
//
// The ensemble must finally pass the same gates a single mover does: a statistically significant
// drift of a distance worth reporting. That last gate is what stops a pair of coincidentally
// slow-moving noise tracks from being promoted to an "object" - their joint drift is as
// insignificant as their separate ones.
//
// Pure: plain arrays in, plain objects out. No DOM, no THREE, no Sitrec globals.

import {applyTransform, invertTransform} from "./StarMatch";
import {STAR_SOLVE_DEFAULTS} from "./StarSolve";

// The pixel radii and px-per-frame speeds below are stated at the REFERENCE footage's scale
// (its plate scale, 30 fps). The app layer rescales them from the measured calibration and the
// clip's frame rate before calling in - see StarTrackerUI's calCluster.
export const STAR_CLUSTER_DEFAULTS = {
    // A track needs at least this many observations for its own velocity to mean anything;
    // below it, the track can still join a cluster by attachment.
    clusterMinTrackObs: 5,
    // Velocity agreement gate: this many sigmas of the two tracks' joint slope uncertainty,
    // plus a floor for the systematic part (association wobble, formation geometry changing
    // slowly with perspective) that the statistical term cannot see.
    clusterVelocitySigmas: 3,
    clusterVelocityFloor: 0.15,     // px/frame
    // How far apart two lights may sit and still be one object, in reference-frame pixels.
    // This is the FORMATION extent - wingtip to wingtip as projected - not a match tolerance.
    clusterRadius: 60,
    // Attachment: a velocity-less track joins if the median distance of its observations from
    // the cluster's predicted path is inside this. Tighter than clusterRadius, because
    // attachment has no velocity agreement backing it up - proximity is the only evidence.
    clusterAttachRadius: 30,
    clusterMinMembers: 2,
    // An ensemble must MOVE like an object, in absolute terms, not merely significantly.
    //
    // The sigma-scaled drift gates that suffice for a single mover are too weak for an ensemble:
    // pooling a hundred observations shrinks the slope's standard error until even residual SOLVE
    // drift - the whole star field creeping at 0.05 px/frame because the camera solution is
    // imperfect over a long clip - measures as significant and accumulates tens of pixels.
    // Measured on a 341-frame run, that exact failure promoted three groups of star fragments to
    // "objects" at 0.05-0.34 px/frame, while the genuine aircraft and the tracked object cross at
    // 2.1-2.7. Solve drift is common-mode and slow; things worth calling objects are not.
    clusterMinSpeed: 0.5,       // px/frame
};

/** Reference-frame positions of a track's observations under the given transforms. */
function refPoints(track, transforms) {
    const pts = [];
    for (const o of track.obs) {
        const T = transforms[o.f];
        if (!T) continue;
        const inv = invertTransform(T);
        if (!inv) continue;
        const [rx, ry] = applyTransform(inv, o.x, o.y);
        pts.push([o.f, rx, ry]);
    }
    return pts;
}

/**
 * Linear motion model of a track: position and velocity by least squares, with the slope's
 * standard error measured from the track's own residuals - the honest per-track uncertainty,
 * which is what the velocity agreement gate needs.
 */
function motionModel(pts) {
    const n = pts.length;
    if (n < 3) return null;
    let sf = 0, sx = 0, sy = 0;
    for (const [f, x, y] of pts) { sf += f; sx += x; sy += y; }
    const mf = sf / n, mx = sx / n, my = sy / n;
    let sff = 0, sfx = 0, sfy = 0;
    for (const [f, x, y] of pts) {
        const df = f - mf;
        sff += df * df; sfx += df * (x - mx); sfy += df * (y - my);
    }
    if (sff < 1e-9) return null;
    const vx = sfx / sff, vy = sfy / sff;
    let sse = 0;
    for (const [f, x, y] of pts) {
        sse += (x - (mx + vx * (f - mf))) ** 2 + (y - (my + vy * (f - mf))) ** 2;
    }
    // Residual variance per axis (2 axes, 4 fitted parameters), then the slope's standard error.
    const s2 = sse / Math.max(1, 2 * n - 4);
    return {
        mf, mx, my, vx, vy,
        se: Math.sqrt(s2 / sff),
        first: pts[0][0], last: pts[n - 1][0], n,
        at: (f) => [mx + vx * (f - mf), my + vy * (f - mf)],
    };
}

/**
 * The ensemble's motion: ONE path shared by every member, each member keeping its own
 * intercept - its place in the formation.
 *
 * Fitting a single line through the pooled observations is subtly wrong: each light sits at a
 * constant offset from the body, and when a light's visibility correlates with time (a strobe
 * seen only early, a beacon only late) its offset leaks into the slope - measured at ~4% speed
 * error on a three-light test formation. Demeaning within each member first removes the offsets
 * exactly, leaving the path estimated purely from how the lights MOVE. This is the standard
 * fixed-effects estimator, and it is why the residuals here measure scatter about the formation
 * rather than the formation's own geometry.
 *
 * The shared path carries a CURVATURE term when the data DEMANDS one. A real aircraft flies a
 * gentle arc, and against a straight model the arc's ends sit offset one way and its middle
 * the other - so a single light seen in three bursts reads as two or three "lights". Curvature
 * is identified from the velocity DIFFERENCES between the members' epochs (early bursts moving
 * slower than late ones), which a formation of straight-moving lights does not produce. Three
 * disciplines keep the term honest:
 *
 *   - Time is CENTRED before anything is squared. Raw f^2 at large frame numbers puts
 *     ~1e12-scale values through sums whose cancellation destroys the fit, making curvature
 *     depend on where the recording's frame numbering happens to start.
 *   - The quadratic must EARN its place by an F-test against the straight fit, not merely be
 *     identifiable: fitted to every dataset, its two extra parameters chase centroid noise and
 *     redraw the formation that the light counting then reads.
 *   - Its velocity uncertainty uses the quadratic design's own leverage, Var(v) = s^2*Sww/det.
 *     The straight-line formula s^2/Suu understates it whenever the regressors correlate,
 *     overstating significance and promoting marginal ensembles.
 */
function sharedMotionModel(memberPts) {
    // First pass: the global centre of time, so tau = f - mfAll is what gets squared.
    let gf = 0, n = 0;
    let first = Infinity, last = -Infinity;
    for (const pts of memberPts) {
        for (const [f] of pts) {
            gf += f; n++;
            if (f < first) first = f;
            if (f > last) last = f;
        }
    }
    if (n < 3) return null;
    const mfAll = gf / n;

    // Within-member demeaned regressors over centred time: u = tau, w = tau^2.
    let Suu = 0, Suw = 0, Sww = 0, Sux = 0, Suy = 0, Swx = 0, Swy = 0;
    let gt2 = 0, gx = 0, gy = 0;
    const stats = [];
    for (const pts of memberPts) {
        if (!pts.length) continue;
        let st = 0, st2 = 0, sx = 0, sy = 0;
        for (const [f, x, y] of pts) {
            const tau = f - mfAll;
            st += tau; st2 += tau * tau; sx += x; sy += y;
        }
        const m = pts.length;
        const mt = st / m, mt2 = st2 / m, mx = sx / m, my = sy / m;
        stats.push({pts, mt, mt2, mx, my});
        for (const [f, x, y] of pts) {
            const tau = f - mfAll;
            const uu = tau - mt, ww = tau * tau - mt2;
            Suu += uu * uu; Suw += uu * ww; Sww += ww * ww;
            Sux += uu * (x - mx); Suy += uu * (y - my);
            Swx += ww * (x - mx); Swy += ww * (y - my);
            gt2 += tau * tau; gx += x; gy += y;
        }
    }
    if (Suu < 1e-9) return null;

    const sseFor = (vx, vy, ax, ay) => {
        let sse = 0;
        for (const {pts, mt, mt2, mx, my} of stats) {
            for (const [f, x, y] of pts) {
                const tau = f - mfAll;
                const uu = tau - mt, ww = tau * tau - mt2;
                sse += (x - (mx + vx * uu + ax * ww)) ** 2
                     + (y - (my + vy * uu + ay * ww)) ** 2;
            }
        }
        return sse;
    };

    // The straight fit always exists.
    let vx = Sux / Suu, vy = Suy / Suu, ax = 0, ay = 0;
    let sse = sseFor(vx, vy, 0, 0);
    let quadratic = false;

    const det = Suu * Sww - Suw * Suw;
    if (n >= 8 && det > 1e-9 * Suu * Sww && Sww > 1e-9) {
        const qvx = (Sww * Sux - Suw * Swx) / det;
        const qax = (Suu * Swx - Suw * Sux) / det;
        const qvy = (Sww * Suy - Suw * Swy) / det;
        const qay = (Suu * Swy - Suw * Suy) / det;
        const sseQ = sseFor(qvx, qvy, qax, qay);
        const dofQ = Math.max(1, 2 * n - 2 * stats.length - 4);
        // F-test with the two curvature parameters in the numerator. The threshold is set
        // high on purpose: adopting a phantom bend redraws the path the light counting and
        // the formation-width gate both read, so weak evidence keeps the straight line.
        const F = ((sse - sseQ) / 2) / Math.max(sseQ / dofQ, 1e-12);
        if (F > 10) {
            vx = qvx; vy = qvy; ax = qax; ay = qay;
            sse = sseQ;
            quadratic = true;
        }
    }

    // Two axes; two intercepts per member plus the shared path parameters.
    const dof = Math.max(1, 2 * n - 2 * stats.length - (quadratic ? 4 : 2));
    const s2 = sse / dof;
    // The velocity coefficient's own leverage: for the quadratic design the inverse normal
    // matrix gives Var(v) = s^2 * Sww / det, which is never smaller than the straight-line
    // s^2 / Suu.
    const leverage = quadratic ? det / Sww : Suu;
    const mt2All = gt2 / n, mxAll = gx / n, myAll = gy / n;
    return {
        // Velocity at the ensemble's centre epoch (tau = 0), which is what the speed gates
        // should judge.
        vx, vy,
        se: Math.sqrt(s2 / leverage), sff: leverage,
        first, last, n, mf: mfAll,
        // The drawn centre: the observation-weighted middle of the formation, riding the
        // shared path.
        at: (f) => {
            const tau = f - mfAll;
            return [
                mxAll + vx * tau + ax * (tau * tau - mt2All),
                myAll + vy * tau + ay * (tau * tau - mt2All),
            ];
        },
    };
}

/**
 * Group the non-star tracks into moving clusters.
 *
 * @param {Array} tracks - the final track list from solveStarField
 * @param {Array} classified - classification records aligned with `tracks`
 * @param {Array} transforms - per-frame reference transforms
 * @param {number} sigma - measured astrometric noise, px
 * @returns {Array} cluster records {members, n, first, last, velocity, speed, totalDrift,
 *   significance, extent, position, magnitude, at(f)}
 */
export function groupMovingClusters(tracks, classified, transforms, sigma, opts = {}) {
    const O = {...STAR_SOLVE_DEFAULTS, ...STAR_CLUSTER_DEFAULTS, ...opts};

    // Stars and camera-fixed artifacts cannot be part of a moving object; everything else -
    // including tracks dismissed as short or incoherent, which is precisely what a flashing
    // light produces - is a candidate.
    const candidate = classified.filter((c) =>
        c.klass === "moving" || c.klass === "incoherent" || c.klass === "short");

    // Motion models for the tracks long enough to carry one.
    const models = new Map();
    for (const c of candidate) {
        const t = tracks[c.index];
        if (t.obs.length < O.clusterMinTrackObs) continue;
        const m = motionModel(refPoints(t, transforms));
        if (m) models.set(c.index, m);
    }

    // Union-find over pairs that move together.
    const parent = new Map();
    for (const i of models.keys()) parent.set(i, i);
    const find = (i) => {
        while (parent.get(i) !== i) {
            parent.set(i, parent.get(parent.get(i)));
            i = parent.get(i);
        }
        return i;
    };
    const idx = [...models.keys()];
    for (let a = 0; a < idx.length; a++) {
        for (let b = a + 1; b < idx.length; b++) {
            const A = models.get(idx[a]), B = models.get(idx[b]);
            const dv = Math.hypot(A.vx - B.vx, A.vy - B.vy);
            const gate = O.clusterVelocitySigmas * Math.hypot(A.se, B.se) + O.clusterVelocityFloor;
            if (dv > gate) continue;
            // Formation distance, evaluated midway between the two tracks' centres so neither
            // model extrapolates further than the other.
            const tm = (A.mf + B.mf) / 2;
            const [ax, ay] = A.at(tm), [bx, by] = B.at(tm);
            if (Math.hypot(ax - bx, ay - by) > O.clusterRadius) continue;
            const ra = find(idx[a]), rb = find(idx[b]);
            if (ra !== rb) parent.set(ra, rb);
        }
    }

    const groups = new Map();
    for (const i of models.keys()) {
        const root = find(i);
        if (!groups.has(root)) groups.set(root, []);
        groups.get(root).push(i);
    }

    const clusters = [];
    for (const members of groups.values()) {
        if (members.length < O.clusterMinMembers) continue;

        // The ensemble model: the velocity the members share, each light keeping its place in
        // the formation. Everything downstream is judged against it.
        let M = sharedMotionModel(members.map((i) => refPoints(tracks[i], transforms)));
        if (!M) continue;

        // Attachment: velocity-less fragments that sit on the ensemble's predicted path at their
        // own frames. This is how a strobe's individual flashes - too brief to fit - join the
        // object their light belongs to.
        const memberSet = new Set(members);
        for (const c of candidate) {
            if (memberSet.has(c.index) || models.has(c.index)) continue;
            const pts = refPoints(tracks[c.index], transforms);
            if (!pts.length) continue;
            const ds = pts.map(([f, x, y]) => {
                const [px, py] = M.at(f);
                return Math.hypot(x - px, y - py);
            }).sort((p, q) => p - q);
            if (ds[ds.length >> 1] > O.clusterAttachRadius) continue;
            memberSet.add(c.index);
            members.push(c.index);
        }

        // Refit with attachments included.
        M = sharedMotionModel(members.map((i) => refPoints(tracks[i], transforms)));
        if (!M) continue;

        // The ensemble must clear the same bar a single mover does. Slow-drifting noise tracks
        // can agree with each other by chance; their combined drift is still not motion.
        //
        // The slope error is floored at what the astrometric noise allows: a formation of
        // perfectly consistent observations has zero within-member scatter, and dividing by a
        // zero standard error would manufacture infinite significance from finite evidence.
        const speed = Math.hypot(M.vx, M.vy);
        // Drift is the distance between the path's endpoints - with a curved path, centre speed
        // times span would misstate it.
        const [dx0, dy0] = M.at(M.first);
        const [dx1, dy1] = M.at(M.last);
        const totalDrift = Math.hypot(dx1 - dx0, dy1 - dy0);
        const seEff = Math.max(M.se, Math.max(sigma, 1e-6) / Math.sqrt(M.sff));
        const significance = speed / seEff;
        if (significance <= O.driftSignificance) continue;
        if (totalDrift <= O.driftMinSigmas * Math.max(sigma, 1e-6)) continue;
        if (speed < O.clusterMinSpeed) continue;

        // Each member's place in the formation: its mean offset from the ensemble path.
        const offsets = new Map();
        for (const i of members) {
            const pts = refPoints(tracks[i], transforms);
            if (!pts.length) continue;
            let ox = 0, oy = 0;
            for (const [f, x, y] of pts) {
                const [px, py] = M.at(f);
                ox += x - px; oy += y - py;
            }
            offsets.set(i, [ox / pts.length, oy / pts.length]);
        }
        const offIdx = [...offsets.keys()];

        // Members are TRACKLETS, and a tracklet is not a light: one flashing light broken by a
        // gap longer than trackMaxGap arrives as two members with one velocity and one path.
        // What distinguishes the same light seen twice from two lights is the same physical
        // fact the star merge rests on - one light yields one detection per frame - so members
        // are one light only when they hold the SAME formation position within the measurement
        // noise AND barely coexist. Both conditions are needed and both are tight: the position
        // gate is a few sigma, because a real light's bursts land within the noise of one place
        // while lights merely NEAR each other (5 px is many sigma) are distinct; and more than a
        // couple of shared frames is positive evidence of two lights, since one light cannot be
        // detected twice in a frame. Complete linkage again, so a drifting chain cannot glue
        // distinct lights either.
        const memberFrames = new Map(offIdx.map((i) =>
            [i, new Set(tracks[i].obs.map((o) => o.f))]));
        const memberEpoch = new Map(offIdx.map((i) => {
            let sf = 0, n = 0;
            for (const o of tracks[i].obs) { sf += o.f; n++; }
            return [i, sf / n];
        }));
        // The position gate is the statistical uncertainty of the two offset MEANS: each is an
        // average over its burst's observations (noise shrinking as sqrt(n)), PLUS the shared
        // velocity's own error projected over the time between the bursts' epochs - two bursts
        // of one light far apart in time sit at offsets that differ by the velocity error times
        // that separation, and ignoring the term counts them as two lights and promotes a lone
        // flasher to a cluster. A 1 px floor covers the systematics neither term sees. A gate
        // proportional to raw sigma is wrong in both directions: needlessly loose on clean
        // footage, and growing without bound on noisy footage until genuinely separate lights
        // (5 px apart at sigma 1.7) read as one. The trackRadius cap stands as a last resort.
        const sameLight = (i, j) => {
            const p = offsets.get(i), q = offsets.get(j);
            const na = memberFrames.get(i).size, nb = memberFrames.get(j).size;
            const dEpoch = Math.abs(memberEpoch.get(i) - memberEpoch.get(j));
            const gate = Math.min(O.trackRadius, Math.max(1,
                3 * Math.sqrt(sigma * sigma * (1 / na + 1 / nb) + (M.se * dEpoch) ** 2)));
            if (Math.hypot(p[0] - q[0], p[1] - q[1]) > gate) return false;
            const fa = memberFrames.get(i);
            let shared = 0;
            for (const f of memberFrames.get(j)) if (fa.has(f)) shared++;
            return shared <= 2;
        };
        // Only members observed at least three times can ESTABLISH a light: a one- or two-frame
        // blip's offset is a couple of noise samples, and on a real clip five such blips along
        // the path inflated one faint object into "8 lights". Blips still attach - their
        // observations strengthen the ensemble - they just cannot found lights of their own.
        const lightGroups = [];
        for (const i of offIdx) {
            if (memberFrames.get(i).size < 3) continue;
            const g = lightGroups.find((grp) => grp.every((j) => sameLight(i, j)));
            if (g) g.push(i);
            else lightGroups.push([i]);
        }
        const lights = lightGroups.length;
        if (!lights) continue;
        // A group that resolves to ONE light is a fragmented faint mover, not a formation - too
        // broken for track-level classification, still an object worth reporting, and reported
        // AS one light (the caller labels it accordingly). It needs the same total evidence a
        // classifiable track would: enough observations across its fragments.
        if (lights < O.clusterMinMembers && M.n < O.minObservations) continue;

        // The formation limit is stated as how far apart two LIGHTS may sit, so it is enforced
        // on the widest pair of light positions - after fragments are recognised as one light,
        // or a burst's offset error inflates the width, and not centre-relative, because three
        // lights at 0 and +/-58 sit 116 px apart at the ends yet only 58 from the centre. Union
        // chaining builds exactly such lines: on a degraded solve, fragments of half the star
        // field (spread over 115 px) posed as one object that way.
        const lightPos = lightGroups.map((grp) => {
            let x = 0, y = 0, n = 0;
            for (const i of grp) {
                const [ox, oy] = offsets.get(i);
                const w = memberFrames.get(i).size;
                x += ox * w; y += oy * w; n += w;
            }
            return [x / n, y / n];
        });
        let maxPair = 0;
        for (let a = 0; a < lightPos.length; a++) {
            for (let b = a + 1; b < lightPos.length; b++) {
                maxPair = Math.max(maxPair, Math.hypot(
                    lightPos[a][0] - lightPos[b][0], lightPos[a][1] - lightPos[b][1]));
            }
        }
        if (maxPair > O.clusterRadius) continue;

        // Formation extent for DRAWING: how far members sit from the ensemble path, at the high
        // quantile so one attachment outlier does not set the ring's radius.
        const pooled = members.flatMap((i) => refPoints(tracks[i], transforms));
        const spread = pooled.map(([f, x, y]) => {
            const [px, py] = M.at(f);
            return Math.hypot(x - px, y - py);
        }).sort((p, q) => p - q);
        const extent = spread.length ? spread[Math.floor(0.9 * (spread.length - 1))] : 0;

        // The brightest member speaks for the ensemble's magnitude - an aircraft's lights differ
        // and the bright one is what an observer reports seeing.
        let magnitude = null;
        for (const i of members) {
            const c = classified[i];
            if (Number.isFinite(c?.magnitude) && (magnitude === null || c.magnitude < magnitude)) {
                magnitude = c.magnitude;
            }
        }

        clusters.push({
            members: members.slice().sort((p, q) => p - q),
            lights,
            n: pooled.length,
            first: M.first,
            last: M.last,
            velocity: [M.vx, M.vy],
            speed,
            totalDrift,
            significance,
            extent,
            position: M.at(M.mf),
            magnitude,
            at: M.at,
        });
    }

    // Largest first: if several clusters exist, the best-supported one is the story.
    clusters.sort((p, q) => q.n - p.n);
    return clusters;
}
