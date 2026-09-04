/**
 * TraversePlatformMirror.js — does a candidate require the object to fly a
 * copy of the OBSERVING PLATFORM's own path?
 *
 * THE MECHANISM. Put a candidate at range R_c along the same sightlines as a
 * true object at range R_t. Since both lie on the ray from the platform
 * position P(t), the candidate track is an affine blend of the two:
 *
 *     X_c(t) = k * X_t(t) + (1 - k) * P(t),      k = R_c / R_t
 *
 * The coefficient on P is (1 - k). Assume the range wrong and the platform's
 * own motion is injected into the solved trajectory — scaled by how wrong, and
 * MIRRORED when the guess is too far. That is the "Coryat curve": a spurious
 * banking/turning path that is really the camera aircraft's manoeuvre wearing
 * the object's clothes. It is not a fitting failure — such a candidate follows
 * the sightlines as faithfully as any other, which is exactly why residual
 * alone can never expose it.
 *
 * WHY DETRENDING IS THE WHOLE POINT, not a cleanup step. Bearings-only
 * observability says a constant-velocity observer cannot resolve range against
 * a constant-velocity target: only the observer's MANOEUVRE carries range
 * information. Removing the uniform-motion (straight, constant-speed) part of
 * both paths therefore isolates precisely the informative component, and what
 * is left asks the one question worth asking — is this candidate explaining the
 * camera's manoeuvre as the object's own?
 *
 * WHY THIS IS NOT THE TERM THAT FAILED BEFORE. An earlier Coryat term,
 * `losAlignment`, scored the share of lateral acceleration lying along the
 * sightline. It was measured HARMFUL and switched off: an object genuinely
 * manoeuvring in the plane containing the sightline scores as high as an
 * artifact, so it charged 0.3 decades to a quadcopter fit 0.0004 deg from the
 * rays. That statistic never referenced the platform at all. This one regresses
 * against the platform's specific manoeuvre WAVEFORM, which an unrelated object
 * has no reason to reproduce. Measured on the Aguadilla ground-track sitch, the
 * separation is not a tail — it is a gulf:
 *
 *     Minimum Acceleration  share 1.000  beta 0.95   1125 m mirrored
 *     Constant Altitude     share 0.959  beta 0.23    270 m mirrored
 *     Constant Air Speed    share 0.815  beta 0.39    460 m mirrored
 *     Balloon (sitch wind)  share 0.007  beta 0.001     1 m mirrored
 *     Quadcopter            share 0.002  beta 0.00      0 m mirrored
 *
 * The physics check that says this is real rather than a coincidence: solve each
 * candidate's beta for the range at which the mirroring vanishes, R_c/(1 - beta).
 * The eleven candidates that publish one have own ranges differing by a factor
 * of 1.78 (1587 m to 2828 m) and predict ranges differing by a factor of only
 * 1.12 (2598 m to 2911 m) — the fixed-wing fit and the balloon fit, which share
 * nothing but the rays, land 22 m apart. It is a consistency check rather than
 * an error bar: these are eleven readings of the SAME sightlines, not
 * independent measurements.
 *
 * Absent from that list, deliberately: the most collapsed candidate, whose
 * 1 - beta is 0.048 and therefore under the guard in referenceRangeM below. An
 * earlier version of this comment quoted a metre value for it that the code
 * refuses to produce.
 *
 * WHAT A HIGH SCORE ASSERTS, and it is not "this is impossible". An object CAN
 * mirror the platform: a chase aircraft, a drone flown to pace the camera. That
 * reading is available and the tile says so. It is simply an extraordinary
 * thing for an object to do, and it must be priced as extraordinary rather than
 * — as it was — costing nothing at all.
 */

/**
 * Least-squares removal of uniform motion (a + b*t, per axis) from a packed
 * xyz track. Frames flagged invalid by `valid` are excluded from the fit and
 * returned as zero, so a held or clipped frame contributes nothing either way.
 */
export function detrendUniformMotion(A, n, valid = null) {
    const out = new Float64Array(n * 3);
    // Normalised time keeps the normal equations well conditioned regardless of
    // clip length; the fit is invariant to the scaling either way.
    let count = 0, st = 0, stt = 0;
    for (let f = 0; f < n; f++) {
        if (valid && !valid[f]) continue;
        const t = f / Math.max(1, n - 1);
        count++; st += t; stt += t * t;
    }
    const den = count * stt - st * st;
    if (!(count > 2) || !(Math.abs(den) > 0)) return out;
    for (let c = 0; c < 3; c++) {
        let sy = 0, sty = 0;
        for (let f = 0; f < n; f++) {
            if (valid && !valid[f]) continue;
            const y = A[f * 3 + c];
            if (!Number.isFinite(y)) return out;      // refuse rather than invent
            const t = f / Math.max(1, n - 1);
            sy += y; sty += t * y;
        }
        const b = (count * sty - st * sy) / den;
        const a = (sy - b * st) / count;
        for (let f = 0; f < n; f++) {
            if (valid && !valid[f]) continue;
            out[f * 3 + c] = A[f * 3 + c] - (a + b * (f / Math.max(1, n - 1)));
        }
    }
    return out;
}

// Share of the candidate's manoeuvre that the platform's manoeuvre explains,
// at or above which the candidate is reported as flying the platform's path.
export const MIRROR_FULL_SHARE = 0.85;
export const MIRROR_PARTIAL_SHARE = 0.5;

// The mirrored motion must exceed this multiple of the positional scale the
// candidate's own LOS residual can resolve. Without it the statistic fires on
// noise: a drone fit whose entire manoeuvre is an 11 m wander scored share 0.83
// against a 6 m resolving scale, which is not evidence of anything.
export const MIRROR_MIN_SNR = 3;

// Floor on the angle used to build that resolving scale. The exact-ray
// "Straight Line" candidate reaches 3e-7 deg by construction, which would make
// any mirrored metre infinitely significant.
const MIRROR_MIN_ANGLE_DEG = 0.01;

const DEG_TO_RAD = Math.PI / 180;

/**
 * Regress a candidate's manoeuvre onto the platform's.
 *
 * @param track     packed xyz candidate positions, same frame basis as platform
 * @param platform  packed xyz sensor/LOS-origin positions (dataset.S)
 * @param n         frame count
 * @param rangeM    mean slant range of the candidate (metres)
 * @param errDeg    the candidate's raw LOS residual (degrees)
 * @returns {{beta, share, rmsPlatform, rmsTrack, mirroredM, independentM, snr,
 *           referenceRangeM}} or null when the geometry cannot support the test
 *          — too few frames, or a platform that does not manoeuvre at all, in
 *          which case there is no parallax and nothing to regress against.
 */
export function platformMirrorStat(track, platform, n, {rangeM, errDeg} = {}) {
    if (!track || !platform || !(n >= 6)) return null;
    if (track.length < n * 3 || platform.length < n * 3) return null;
    const rP = detrendUniformMotion(platform, n);
    const rX = detrendUniformMotion(track, n);
    let pp = 0, xx = 0, xp = 0;
    for (let i = 0; i < n * 3; i++) {
        pp += rP[i] * rP[i];
        xx += rX[i] * rX[i];
        xp += rX[i] * rP[i];
    }
    if (!(pp > 0) || !Number.isFinite(xx)) return null;
    const rmsPlatform = Math.sqrt(pp / n);
    const rmsTrack = Math.sqrt(xx / n);
    // The positional scale below which the sightlines cannot resolve motion at
    // this range. Metres, floored so a degenerate residual cannot divide by ~0.
    const resolvingM = Math.max(1,
        (Number.isFinite(rangeM) ? rangeM : 0)
        * Math.max(Number.isFinite(errDeg) ? errDeg : 0, MIRROR_MIN_ANGLE_DEG) * DEG_TO_RAD);
    // NO MANOEUVRE, NO VERDICT. A platform on a straight constant-velocity path
    // detrends to floating-point dust, and a regression against dust returns a
    // confident-looking beta built from nothing — measured at beta 0.77, share
    // 0.78 and a fabricated 6.6 km reference range on a platform that never
    // turned. That is also the honest physics: a non-manoeuvring observer
    // recovers no range at all from bearings, so there is no mirroring to
    // detect and the test must decline rather than answer.
    if (!(rmsPlatform > resolvingM)) return null;
    const beta = xp / pp;
    // Share is the squared correlation: the fraction of the candidate's
    // manoeuvre VARIANCE that a scalar multiple of the platform's accounts for.
    // A candidate that does not manoeuvre at all (a stationary point, a
    // constant-velocity fit) has nothing to explain and scores zero, which is
    // correct — it is not mirroring anything.
    const share = xx > 0 ? (xp * xp) / (xx * pp) : 0;
    const mirroredM = Math.abs(beta) * rmsPlatform;
    // beta = 1 - R_c/R_ref, so R_ref = R_c / (1 - beta): the range at which this
    // candidate's motion would stop tracking the platform's. Undefined as beta
    // approaches 1 (the candidate has collapsed essentially onto the platform).
    const k = 1 - beta;
    const referenceRangeM = Number.isFinite(rangeM) && k > 0.05
        ? rangeM / k : null;
    return {
        beta, share, rmsPlatform, rmsTrack, mirroredM,
        independentM: Math.sqrt(Math.max(0, xx - beta * xp) / n),
        snr: mirroredM / resolvingM,
        referenceRangeM,
    };
}

/**
 * The ordinariness rank this statistic supports: 3 when the candidate's motion
 * is its own, 2 when the platform explains half of it, 1 when the platform
 * explains essentially all of it. Never 0 — a mirrored path is extraordinary,
 * not invalid, and the analysis does not exclude it.
 */
export function platformMirrorRank(stat) {
    if (!stat || !Number.isFinite(stat.share) || !(stat.snr >= MIRROR_MIN_SNR)) return 3;
    if (stat.share >= MIRROR_FULL_SHARE) return 1;
    if (stat.share >= MIRROR_PARTIAL_SHARE) return 2;
    return 3;
}

/** True when the mirrored component is large enough to report at all. */
export function platformMirrorSignificant(stat) {
    return !!stat && stat.snr >= MIRROR_MIN_SNR && stat.share >= MIRROR_PARTIAL_SHARE;
}

/**
 * One plain-text sentence for the tile and the rank basis. States the share,
 * the scale factor, the metres involved, and — because it is the actionable
 * part — the range at which the mirroring would disappear.
 */
export function platformMirrorSummary(stat) {
    if (!platformMirrorSignificant(stat)) return null;
    const pct = Math.round(stat.share * 100);
    const at = stat.referenceRangeM
        ? `; the mirroring vanishes at about ${stat.referenceRangeM >= 1000
            ? `${(stat.referenceRangeM / 1000).toFixed(1)} km`
            : `${Math.round(stat.referenceRangeM)} m`} range`
        : "";
    return `${pct}% of its manoeuvring is a ${Math.abs(stat.beta).toFixed(2)}× `
        + `${stat.beta < 0 ? "mirrored " : ""}copy of the platform's own path `
        + `(${Math.round(stat.mirroredM)} m of it, against `
        + `${Math.round(stat.independentM)} m of independent motion)${at}`;
}

/**
 * Grade a whole hypothesis set: attach the per-scene residual scale and the
 * platform-mirror record to every candidate that a track-based judgement
 * applies to.
 *
 * ONE FUNCTION, CALLED FROM EVERY PATH THAT BUILDS HYPOTHESES, and that is the
 * point rather than tidiness. These fields have to be on the hypotheses BEFORE
 * anything reads them, and there are two independent readers — the ranking the
 * gallery renders, and the executive assessment frozen alongside it. Attached
 * in a caller instead, the assessment was computed from ungraded hypotheses and
 * could declare a class viable while its own tile rejected it; and the
 * benchmark's verdict runner, which builds hypotheses without the battery, saw
 * no grading at all — so blind evaluation would have measured a different
 * ranking from the one it exists to measure.
 *
 * `fitKindOf` is injected rather than imported to keep this module free of the
 * ranking's dependency graph; callers pass hypothesisFitKind.
 *
 * @param hypotheses  the built set, mutated in place
 * @param dataset     needs S (sensor positions) and n (frame count)
 * @param fitKindOf   hypothesisFitKind, or any predicate-compatible equivalent
 */
export function gradeHypotheses(hypotheses, dataset, fitKindOf) {
    if (!hypotheses || !dataset) return hypotheses;
    // The scene residual scale: the generic reference residual carried by the
    // fitted hypotheses — a free constant-acceleration trajectory, no object
    // assumption, not tied to the rays. It measures how much of these
    // sightlines ordinary smooth motion cannot explain, so grading residuals as
    // multiples of it stops an absolute ladder from sorting noise on a scene
    // where every candidate already sits inside the reference. TraverseRanking
    // clamps it at both ends, and falls back to the absolute ladder when the
    // reference fit did not produce one.
    const sceneScaleDeg = hypotheses
        .map((h) => h.params?.errFloor)
        .find((v) => Number.isFinite(v) && v > 0);
    for (const h of hypotheses) {
        if (Number.isFinite(sceneScaleDeg)) h.fitScaleDeg = sceneScaleDeg;
        // Skip the hypotheses whose track is not a claim about where an object
        // was: a catalogue identification is judged on angle alone, and an
        // at-infinity check carries a helper track whose range — and so whose
        // whole platform-correlated component — is an arbitrary drawing
        // convenience.
        if (!h.track || h.atInfinity) continue;
        if (fitKindOf) {
            const kind = fitKindOf(h);
            if (kind === "identity" || kind === "directional-geometry") continue;
        }
        h.platformMirror = platformMirrorStat(h.track, dataset.S, dataset.n, {
            rangeM: h.metricsFull?.range?.mean,
            errDeg: h.errDeg,
        });
    }
    return hypotheses;
}
