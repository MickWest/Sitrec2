// noiseSelfCheck.js — does a bearing series actually carry the pointing error
// its scenario DECLARES? (BOT-Tractability-Plan.md step 6.)
//
// Every FIM/CRLB quantity downstream scales as sigma^2, so a 2x misdeclared
// sigma is a 4x variance error that silently corrupts triage ordering, band
// coverage, and every residual threshold in the class screen. Nothing checked
// the declaration against the data before this: the real-GPS arm inherits
// GPS-artifact noise rather than the declared value, the shared-noise anomaly
// pairs assume the noise model is right, and the escalation pilot's analysts
// discounted screening results outright after noticing series whose lag-1
// autocorrelation was near 0.9 while the dossier called them white.
//
// Method, per LOS set — no truth, no fitting, no thresholds at generation time:
//
//  1. slide a short window over the observed directions. Inside each window
//     project every sample into the tangent plane of the window's CENTER
//     direction, using the same pan/tilt basis observation.js applies the
//     pointing error in, which gives two small angle series in degrees. The
//     projection is relative to a NOISY reference, but that only shifts the
//     whole window by one constant, and a constant is absorbed exactly by the
//     fit's intercept, so the residual is unaffected to first order. Adjacent
//     windows do NOT share a basis, though: theirs are rotated by one LOS step,
//     which attenuates the pooled lag-1 statistic by its cosine. Negligible for
//     an ordinary sweep, but a near-vertical sightline swings the pan axis
//     arbitrarily fast and the whiteness verdict weakens there.
//  2. fit a quadratic in time to each component and keep the residual at the
//     center sample, divided by sqrt(1 - h) where h is that sample's leverage
//     in its own window fit. The correction is not cosmetic: a 7-sample
//     quadratic puts h = 1/3 on its center point, so an uncorrected MAD
//     reports 82% of the true sigma — itself a mismatch big enough to trip the
//     band this file exists to police.
//  3. sigma = 1.4826 * MAD per tangent axis, the two combined in quadrature.
//     Per AXIS, not over the merged set: a target swerving in azimuth alone
//     leaves one residual series huge and the other at the noise floor, and a
//     merged median then lands on the boundary and reports neither.
//  4. lag-1 autocorrelation of the same residuals, compared against the
//     white-noise null OF THE ACTUAL DETREND FILTER. The detrend correlates
//     its own residuals — a 7-sample quadratic returns rho1 = -0.49 on pure
//     white input — so a test against zero calls every clean series
//     correlated, which is worse than not testing.
//
// THE CAUTION (returned in the result as `caution`, not only written here).
// A short-window local polynomial measures HIGH-FREQUENCY pointing jitter. It
// removes smooth target dynamics, which is the point, but it equally removes
// genuine target motion that happens to be smooth across the window: a 7-frame
// window at 30 fps absorbs a 1 Hz, 3-degree angular swerve essentially whole.
// On a violently maneuvering target the returned sigma is therefore the sensor
// jitter alone and UNDERSTATES the residual budget any smooth trajectory model
// has to absorb, which is the number the class screen and the CRLB actually
// want. Understated noise means over-tight residual gates and over-optimistic
// predicted precision — the "found, then refused" failure the tractability
// study records as its top yield thief. `trustworthy` is true only when the
// series looks white, the estimate is stable against window length, and the
// window fit is not tracking real angular acceleration; when it is false the
// number is a LOWER BOUND on the noise, and `trustReasons` says which test
// failed.

const RAD2DEG = 180 / Math.PI;

// Ratio band for sigmaEmpirical / sigmaDeclared. Default +/-50%, chosen from
// both ends: a 1.5x sigma error is a 2.25x variance error, half-way (in logs)
// to the 2x/4x misdeclaration the program calls corrupting, and it sits far
// outside sampling noise — a MAD scale estimate has 37% asymptotic efficiency,
// so its relative standard error is about 1.17/sqrt(m) over m residual
// components, i.e. under 5% for a 300-frame clip. The band is a parameter
// because a hand-declared real-GPS segment deserves a looser one than a
// generated scenario whose sigma is known exactly.
export const DEFAULT_RATIO_BAND = [1 / 1.5, 1.5];

// Local pan/tilt tangent basis for a unit direction — same construction (and
// same straight-up degeneracy fallback) as observation.js, so the recovered
// angle pair is the pan/tilt pair the generator perturbed.
function tangentBasis(dx, dy, dz) {
    let t1x = -dy, t1y = dx, t1z = 0;                  // up x d, up = [0,0,1]
    let L = Math.hypot(t1x, t1y, t1z);
    if (L < 1e-6) { t1x = 1; t1y = 0; t1z = 0; L = 1; }
    t1x /= L; t1y /= L; t1z /= L;
    return [t1x, t1y, t1z,
        dy * t1z - dz * t1y, dz * t1x - dx * t1z, dx * t1y - dy * t1x];
}

function median(values) {
    if (values.length === 0) return NaN;
    const a = Float64Array.from(values);
    a.sort();                                          // numeric on a typed array
    const m = a.length >> 1;
    return a.length % 2 ? a[m] : 0.5 * (a[m - 1] + a[m]);
}

// Inverse of a symmetric 3x3 (flat row-major) by the adjugate; null when the
// window's time basis has collapsed (duplicate timestamps).
function inverse3(M) {
    const [a, b, c, d, e, f, g, h, i] = M;
    const A = e * i - f * h, B = f * g - d * i, C = d * h - e * g;
    const det = a * A + b * B + c * C;
    if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
    const s = 1 / det;
    return [
        A * s, (c * h - b * i) * s, (b * f - c * e) * s,
        B * s, (a * i - c * g) * s, (c * d - a * f) * s,
        C * s, (b * g - a * h) * s, (a * e - b * d) * s,
    ];
}

// The equivalent residual-maker row for the CANONICAL interior window: w
// uniformly spaced samples, quadratic fit, residual read at the center sample.
// c_j = delta(j, center) - x_c' (X'X)^-1 x_j, so the residual series is the
// input convolved with c. Exported because the white null below is only as
// trustworthy as this row, and the test pins it.
export function canonicalResidualFilter(w) {
    const half = (w - 1) / 2;
    const M = new Float64Array(9);
    for (let j = 0; j < w; j++) {
        const u = (j - half) / half;
        const row = [1, u, u * u];
        for (let r = 0; r < 3; r++)
            for (let s = 0; s < 3; s++) M[r * 3 + s] += row[r] * row[s];
    }
    const Mi = inverse3(M);
    const c = new Float64Array(w);
    if (!Mi) return c;
    for (let j = 0; j < w; j++) {
        const u = (j - half) / half;
        c[j] = (j === half ? 1 : 0) - (Mi[0] + Mi[1] * u + Mi[2] * u * u);
    }
    return c;
}

// Autocorrelation of the residual process under white input: rho_k =
// sum_j c_j c_{j+k} / sum_j c_j^2. Interior windows are shifted copies of one
// another, so this really is the stationary autocorrelation of the residual
// series and not just of one window.
function filterAutocorrelation(c) {
    const w = c.length;
    const rho = new Float64Array(w);
    let g0 = 0;
    for (let j = 0; j < w; j++) g0 += c[j] * c[j];
    if (!(g0 > 0)) return rho;
    for (let k = 0; k < w; k++) {
        let s = 0;
        for (let j = 0; j + k < w; j++) s += c[j] * c[j + k];
        rho[k] = s / g0;
    }
    return rho;
}

// Bartlett's formula for the standard error of the lag-1 sample
// autocorrelation of a stationary process with known rho. Reduces to
// 1/sqrt(m) for white input, which is the sanity check the test pins.
function bartlettLag1StdErr(rho, m) {
    if (!(m > 0)) return null;
    const K = rho.length - 1;
    const at = (v) => (Math.abs(v) <= K ? rho[Math.abs(v)] : 0);
    const r1 = at(1);
    let s = 0;
    for (let v = -K - 1; v <= K + 1; v++) {
        s += at(v) * at(v) + at(v + 1) * at(v - 1)
            - 4 * r1 * at(v) * at(v - 1) + 2 * r1 * r1 * at(v) * at(v);
    }
    return Math.sqrt(Math.max(s, 0) / m);
}

// One detrend pass at a given window width. Only INTERIOR frames get a
// residual — an edge window is not a shifted copy of the canonical one, so its
// residuals carry a different leverage and a different null, and mixing them in
// would bias both the scale and the whiteness test for the sake of a handful of
// samples. Returns residual components in degrees, already leverage-corrected,
// plus each window's quadratic coefficient standardized by its own white-noise
// spread (the raw material for the curvature diagnostic).
function detrendPass(dirENU, times, active, w, maxSpanSeconds) {
    const half = (w - 1) / 2;
    const L = active.length;
    const usedPos = [];
    const r1s = [], r2s = [];                          // one residual series per tangent axis
    const stdCurvature = [];
    for (let p = half; p < L - half; p++) {
        const f0 = active[p - half], fw = active[p + half];
        const span = times[fw] - times[f0];
        // A window straddling a telemetry gap is fitting an extrapolation, not
        // a local trend; drop it rather than let the gap dominate the scale.
        if (!(span > 0) || span > maxSpanSeconds) continue;
        const tMid = 0.5 * (times[f0] + times[fw]);
        const hspan = 0.5 * span;

        const cb = active[p] * 3;
        const dcx = dirENU[cb], dcy = dirENU[cb + 1], dcz = dirENU[cb + 2];
        const [t1x, t1y, t1z, t2x, t2y, t2z] = tangentBasis(dcx, dcy, dcz);

        const M = new Float64Array(9);
        const b1 = [0, 0, 0], b2 = [0, 0, 0];
        let yc1 = 0, yc2 = 0, uc = 0;
        for (let j = 0; j < w; j++) {
            const f = active[p - half + j];
            const bb = f * 3;
            const dx = dirENU[bb], dy = dirENU[bb + 1], dz = dirENU[bb + 2];
            const along = dx * dcx + dy * dcy + dz * dcz;
            const y1 = Math.atan2(dx * t1x + dy * t1y + dz * t1z, along) * RAD2DEG;
            const y2 = Math.atan2(dx * t2x + dy * t2y + dz * t2z, along) * RAD2DEG;
            const u = (times[f] - tMid) / hspan;
            const row = [1, u, u * u];
            for (let r = 0; r < 3; r++) {
                for (let s = 0; s < 3; s++) M[r * 3 + s] += row[r] * row[s];
                b1[r] += row[r] * y1;
                b2[r] += row[r] * y2;
            }
            // The center sample's own angles are zero by construction (it IS
            // the projection reference); kept explicit because the residual
            // algebra below is the same either way.
            if (j === half) { yc1 = y1; yc2 = y2; uc = u; }
        }

        const Mi = inverse3(M);
        if (!Mi) continue;
        const xc = [1, uc, uc * uc];
        let h = 0;
        for (let r = 0; r < 3; r++)
            for (let s = 0; s < 3; s++) h += xc[r] * Mi[r * 3 + s] * xc[s];
        if (!(h < 1 - 1e-6)) continue;
        const k = 1 / Math.sqrt(1 - h);

        const a1 = [0, 0, 0], a2 = [0, 0, 0];
        for (let r = 0; r < 3; r++)
            for (let s = 0; s < 3; s++) {
                a1[r] += Mi[r * 3 + s] * b1[s];
                a2[r] += Mi[r * 3 + s] * b2[s];
            }
        const fit1 = xc[0] * a1[0] + xc[1] * a1[1] + xc[2] * a1[2];
        const fit2 = xc[0] * a2[0] + xc[1] * a2[1] + xc[2] * a2[2];

        usedPos.push(p);
        r1s.push((yc1 - fit1) * k);
        r2s.push((yc2 - fit2) * k);
        // (M^-1)_22 is the variance factor of the quadratic coefficient under
        // unit noise, so dividing by its square root puts the coefficient on
        // the sigma scale and makes the curvature diagnostic window-agnostic.
        // Taken as the MAGNITUDE over the two axes, not per axis: a real
        // swerve is usually confined to one axis, and pooling the two axes as
        // separate samples would let the quiet axis hold the median down.
        const sd = Math.sqrt(Math.max(Mi[8], 0));
        if (sd > 0) stdCurvature.push(Math.hypot(a1[2], a2[2]) / sd);
    }
    return {usedPos, r1: r1s, r2: r2s, stdCurvature};
}

// 1.4826 * MAD — the Gaussian-consistent robust scale. Robust matters here
// because a real segment's outliers (a bridged datum step, a tracker reacquire)
// are exactly the frames that must NOT set the noise floor.
function madSigma(resid) {
    if (resid.length < 4) return null;
    const med = median(resid);
    const dev = new Float64Array(resid.length);
    for (let i = 0; i < resid.length; i++) dev[i] = Math.abs(resid[i] - med);
    return 1.4826 * median(dev);
}

// One scale per tangent axis, combined in quadrature. The two axes are NOT
// pooled into a single MAD: a target swerving in azimuth alone leaves one
// residual series huge and the other at the noise floor, and the median of the
// merged set then lands on the boundary between them and reports neither (a
// 200x error, measured, on the maneuver case in the test). Per-axis MADs
// combined as a quadratic mean survive that, keep the isotropic case exact,
// and make an anisotropic sensor visible in sigmaAxisDeg instead of silently
// averaged away.
function axisSigmas(pass) {
    const s1 = madSigma(pass.r1), s2 = madSigma(pass.r2);
    if (!(s1 >= 0) || !(s2 >= 0)) return {sigma: null, axis: [s1, s2]};
    return {sigma: Math.sqrt(0.5 * (s1 * s1 + s2 * s2)), axis: [s1, s2]};
}

export const CAUTION =
    "sigmaEmpiricalDeg is the HIGH-FREQUENCY pointing jitter left after a short-window "
    + "local-quadratic detrend. The detrend removes smooth target dynamics AND genuine "
    + "target motion that is smooth across the window, so on a violently maneuvering "
    + "target it understates the residual budget a smooth trajectory model must absorb; "
    + "treat it as a lower bound whenever trustworthy is false. It is trustworthy as a "
    + "white per-frame sigma only when the residuals pass the whiteness test against the "
    + "detrend's own null, the wide-window estimate agrees, and the window fit is not "
    + "tracking real angular acceleration (curvatureExcess near 1).";

function emptyResult(reason, extra = {}) {
    return {
        ok: false,
        reason,
        sigmaEmpiricalDeg: null,
        sigmaAxisDeg: null,
        sigmaEmpiricalRadialDeg: null,
        sigmaWideWindowDeg: null,
        windowScaleRatio: null,
        lag1Autocorr: null,
        lag1WhiteNullExpected: null,
        lag1NullStdErr: null,
        lag1Z: null,
        whiteness: "insufficient-data",
        curvatureExcess: null,
        sigmaBasis: "per-tangent-axis",
        declaredSigmaDeg: null,
        declaredBasis: null,
        declaredKind: null,
        ratioToDeclared: null,
        ratioBand: null,
        ratioFlag: "no-declaration",
        ratioMismatch: false,
        whitenessMismatch: false,
        mismatch: false,
        trustworthy: false,
        trustReasons: [reason],
        caution: CAUTION,
        ...extra,
    };
}

/**
 * Empirical bearing-noise self-check for one LOS set.
 *
 * @param observedDirectionENU Float64Array(3n) of unit sightline directions.
 * @param options.times        seconds per frame (Float64Array or array). If
 *                             omitted, derived from fps.
 * @param options.fps          frames per second; needed when times is omitted,
 *                             and used only for reporting otherwise.
 * @param options.activeFrames frame indices to use (post-FOV-exclusion);
 *                             defaults to every frame.
 * @param options.declaredSigmaDeg  the scenario's declared pointing sigma, or
 *                             null to skip the comparison.
 * @param options.declaredBasis "per-axis" (default; matches observation.js
 *                             gaussianSigmaDeg) or "radial" (matches
 *                             realizedRmsDegAllFrames, larger by sqrt(2)).
 *                             Getting this wrong IS a sqrt(2) misdeclaration,
 *                             so it is stated rather than guessed.
 * @param options.declaredKind "white" | "wobble" | "clean" | null — enables the
 *                             whiteness half of the mismatch flag.
 */
export function noiseSelfCheck(observedDirectionENU, options = {}) {
    const {
        times: timesIn = null,
        fps = null,
        activeFrames = null,
        declaredSigmaDeg = null,
        declaredBasis = "per-axis",
        declaredKind = null,
        windowSamples = 7,
        wideWindowSamples = 13,
        ratioBand = DEFAULT_RATIO_BAND,
        // The three trust thresholds. whitenessZ 3 is a two-sided 0.3% null
        // rate against the detrend's own null; measured over 40 white noise
        // seeds the realized |z| never exceeded 1.8, so it costs nothing on
        // clean data. maxWindowScaleRatio 1.25 is comfortably above the few
        // percent two honest windows differ by and below the 2x-plus a
        // structured error produces. maxCurvatureExcess 3 is in units where
        // pure white noise reads 1.0 by construction, so it means "the window
        // fit is tracking three times the curvature noise alone would explain".
        whitenessZ = 3,
        maxWindowScaleRatio = 1.25,
        maxCurvatureExcess = 3,
        minFramesUsed = 30,
        maxWindowSpanFactor = 1.5,
        // Below this the series carries no measurable scale at all — a clean
        // generator arm, or bearings quantized so coarsely that most windows
        // fit exactly. Reporting the surviving floating-point dust as a sigma
        // would sail through any ratio band from below, so it is refused. The
        // floor is far under any real pointing error and far over the ~1e-13
        // degree resolution of a unit vector in float64.
        minSigmaDeg = 1e-9,
    } = options;

    const n = Math.floor(observedDirectionENU.length / 3);
    let times = timesIn;
    if (!times) {
        if (!(fps > 0)) return emptyResult("neither times nor fps supplied");
        times = new Float64Array(n);
        for (let f = 0; f < n; f++) times[f] = f / fps;
    }
    const w = windowSamples;
    if (!(w >= 5) || w % 2 !== 1) return emptyResult("windowSamples must be an odd integer >= 5");

    const active = (activeFrames ? Array.from(activeFrames) : Array.from({length: n}, (_, i) => i))
        .filter((f) => f >= 0 && f < n)
        .sort((a, b) => a - b);
    if (active.length < w + 2) {
        return emptyResult(`only ${active.length} active frames for a ${w}-sample window`);
    }

    // Median sample interval sets both the gap guard and the lag-1 adjacency
    // test, so an irregular real-GPS segment cannot smuggle a long interval in
    // as if it were one frame.
    const gaps = [];
    for (let i = 1; i < active.length; i++) gaps.push(times[active[i]] - times[active[i - 1]]);
    const medianDt = median(gaps);
    if (!(medianDt > 0)) return emptyResult("non-increasing or degenerate timestamps");

    const narrow = detrendPass(observedDirectionENU, times, active, w,
        maxWindowSpanFactor * (w - 1) * medianDt);
    const {sigma, axis: sigmaAxis} = axisSigmas(narrow);
    if (!(sigma > minSigmaDeg)) {
        return emptyResult(narrow.usedPos.length < 4
            ? "too few usable windows after the gap guard"
            : "residual scale is zero (clean or quantized series)",
        {framesUsed: narrow.usedPos.length});
    }

    // Wide-window control: same estimator over a longer span. Equal estimates
    // mean the noise has no structure between the two scales; a materially
    // larger wide-window sigma means there IS power at the longer scale, from
    // correlated pointing error or from dynamics the wide quadratic cannot
    // follow. Either way the narrow number is jitter, not the full budget.
    let sigmaWide = null, windowScaleRatio = null;
    const wWide = wideWindowSamples % 2 === 1 ? wideWindowSamples : wideWindowSamples + 1;
    if (wWide > w && active.length >= wWide + 2) {
        const wide = detrendPass(observedDirectionENU, times, active, wWide,
            maxWindowSpanFactor * (wWide - 1) * medianDt);
        sigmaWide = axisSigmas(wide).sigma;
        if (sigmaWide > 0) windowScaleRatio = sigmaWide / sigma;
    }

    // --- whiteness -------------------------------------------------------
    // Pooled over both tangent components, each first standardized by its OWN
    // scale: the generator's pointing error is isotropic, so the standardized
    // axes are exchangeable unit-variance series and pooling doubles the
    // effective sample against the same null. Without the standardization a
    // single loud axis would decide the verdict on its own. Only pairs of
    // adjacent interior windows at the nominal sample interval contribute.
    const inv1 = sigmaAxis[0] > 0 ? 1 / sigmaAxis[0] : 0;
    const inv2 = sigmaAxis[1] > 0 ? 1 / sigmaAxis[1] : 0;
    let num = 0, den = 0, pairs = 0;
    for (let i = 0; i < narrow.usedPos.length; i++) {
        const a = narrow.r1[i] * inv1, b = narrow.r2[i] * inv2;
        den += a * a + b * b;
        if (i === 0) continue;
        if (narrow.usedPos[i] !== narrow.usedPos[i - 1] + 1) continue;
        const dt = times[active[narrow.usedPos[i]]] - times[active[narrow.usedPos[i - 1]]];
        if (dt > maxWindowSpanFactor * medianDt) continue;
        num += a * narrow.r1[i - 1] * inv1 + b * narrow.r2[i - 1] * inv2;
        pairs++;
    }
    const lag1 = den > 0 && pairs > 0 ? num / den : null;
    const nullRho = filterAutocorrelation(canonicalResidualFilter(w));
    const lag1Null = nullRho[1];
    const lag1Se = bartlettLag1StdErr(nullRho, 2 * pairs);
    const lag1Z = lag1 !== null && lag1Se > 0 ? (lag1 - lag1Null) / lag1Se : null;

    let whiteness;
    if (lag1Z === null || pairs < 10) whiteness = "insufficient-data";
    else if (lag1Z > whitenessZ) whiteness = "correlated";
    else if (lag1Z < -whitenessZ) whiteness = "anti-correlated";
    else whiteness = "white-consistent";

    // --- how much genuine curvature the detrend swallowed ------------------
    // The quadratic coefficient magnitude is standardized by its own
    // white-noise spread. Two independent axes make it Rayleigh, whose median
    // is sqrt(2 ln 2) sigma, so this ratio is 1.0 on a pure white series by
    // construction and grows with real angular acceleration at window scale.
    // It does not invalidate sigma as a jitter estimate; it invalidates using
    // sigma as a fit-residual budget.
    const RAYLEIGH_MEDIAN = Math.sqrt(2 * Math.LN2);
    const curvatureExcess = narrow.stdCurvature.length
        ? median(narrow.stdCurvature) / (RAYLEIGH_MEDIAN * sigma) : null;

    // --- against the declaration -------------------------------------------
    const sigmaRadial = sigma * Math.SQRT2;             // hypot of two axes
    const comparable = declaredBasis === "radial" ? sigmaRadial : sigma;
    let ratio = null, ratioFlag = "no-declaration";
    if (declaredSigmaDeg > 0) {
        ratio = comparable / declaredSigmaDeg;
        if (ratio < ratioBand[0]) ratioFlag = "empirical-below-band";
        else if (ratio > ratioBand[1]) ratioFlag = "empirical-above-band";
        else ratioFlag = "in-band";
    }
    const ratioMismatch = ratioFlag === "empirical-below-band" || ratioFlag === "empirical-above-band";
    // A declared-clean series that reached this line has a measurable residual
    // scale, so the declaration is already contradicted — the noiseless arm
    // exits above with "residual scale is zero".
    const whitenessMismatch =
        (declaredKind === "white" && (whiteness === "correlated" || whiteness === "anti-correlated"))
        || (declaredKind === "wobble" && whiteness === "white-consistent")
        || declaredKind === "clean";

    const trustReasons = [];
    if (whiteness === "correlated") {
        trustReasons.push(`residuals are correlated (lag-1 ${lag1.toFixed(3)} against a `
            + `detrend null of ${lag1Null.toFixed(3)}, z = ${lag1Z.toFixed(1)}): the series `
            + "carries structured pointing error, and a single white sigma does not describe it");
    } else if (whiteness === "anti-correlated") {
        trustReasons.push(`residuals are anti-correlated beyond the detrend null (z = `
            + `${lag1Z.toFixed(1)}), which usually means smoothing or interpolation upstream`);
    } else if (whiteness === "insufficient-data") {
        trustReasons.push(`only ${pairs} adjacent interior windows: too few for a whiteness test`);
    }
    if (windowScaleRatio !== null && windowScaleRatio > maxWindowScaleRatio) {
        trustReasons.push(`the ${wWide}-sample window reports `
            + `${windowScaleRatio.toFixed(2)}x the ${w}-sample estimate, so the noise has `
            + "power at the longer scale and no single per-frame sigma is scale-free");
    }
    if (curvatureExcess !== null && curvatureExcess > maxCurvatureExcess) {
        trustReasons.push(`the window fit is tracking real angular acceleration `
            + `(curvatureExcess ${curvatureExcess.toFixed(1)}x the white-noise level): the `
            + "detrend absorbed target dynamics, so this sigma is sensor jitter and a LOWER "
            + "BOUND on the residual budget a smooth trajectory model must absorb");
    }
    if (narrow.usedPos.length < minFramesUsed) {
        trustReasons.push(`only ${narrow.usedPos.length} usable windows `
            + `(want ${minFramesUsed}); the scale estimate is sampling-noise dominated`);
    }

    return {
        ok: true,
        reason: null,
        n,
        framesUsed: narrow.usedPos.length,
        residualCount: 2 * narrow.usedPos.length,
        lag1Pairs: pairs,
        windowSamples: w,
        wideWindowSamples: wWide,
        windowSeconds: (w - 1) * medianDt,
        medianDtSeconds: medianDt,
        // Per tangent AXIS, directly comparable to observation.js's
        // gaussianSigmaDeg. The radial form is the magnitude of the two-axis
        // error and is what realizedRmsDegAllFrames reports.
        sigmaBasis: "per-tangent-axis",
        sigmaEmpiricalDeg: sigma,
        sigmaAxisDeg: sigmaAxis,
        sigmaEmpiricalRadialDeg: sigmaRadial,
        sigmaWideWindowDeg: sigmaWide,
        windowScaleRatio,
        lag1Autocorr: lag1,
        lag1WhiteNullExpected: lag1Null,
        lag1NullStdErr: lag1Se,
        lag1Z,
        whiteness,
        curvatureExcess,
        declaredSigmaDeg: declaredSigmaDeg ?? null,
        declaredBasis,
        declaredKind: declaredKind ?? null,
        ratioToDeclared: ratio,
        ratioBand: [ratioBand[0], ratioBand[1]],
        ratioFlag,
        ratioMismatch,
        whitenessMismatch,
        mismatch: ratioMismatch || whitenessMismatch,
        trustworthy: trustReasons.length === 0,
        trustReasons,
        caution: CAUTION,
    };
}
