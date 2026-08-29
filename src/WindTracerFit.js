// Wind Tracer — a global LOS fit for a passively drifting, slowly descending
// object (sky lantern, balloon, debris), designed for sightlines that come from
// a hand-slewed camera BORESIGHT rather than from a measured bearing.
//
// Two ideas, neither of which is in the existing method catalogue.
//
// ---------------------------------------------------------------------------
// 1. DRIFT-ANCHORED TRIANGULATION (the anchor is eliminated, not searched)
// ---------------------------------------------------------------------------
// A wind tracer's path is an unknown ANCHOR plus a displacement SHAPE that
// depends only on a few physical parameters:
//
//     P(t) = P0 + D(t; theta),      D(0; theta) = 0
//
// P0 enters the sightline residual LINEARLY, so for any candidate theta the
// best P0 is a 3x3 normal-equation solve over every frame at once. That is
// variable projection (separable least squares): the outer search never sees
// the anchor, and there is NO "initial range" parameter — the range is
// triangulated by the whole clip rather than guessed at frame 0 and refined.
//
// The practical consequences are large. The existing physics fit searches
// initialRange inside a 12-parameter differential evolution, where range and
// wind trade against each other; here the anchor is optimal for every candidate
// wind by construction. A full global seed (a wind rose over speed and bearing)
// plus four Nelder-Mead restarts costs well under a second on 2000 frames,
// because the inner solve is closed form.
//
// ---------------------------------------------------------------------------
// 2. A BAND-LIMITED OPERATOR-MOTION MODEL (what makes it work on a boresight)
// ---------------------------------------------------------------------------
// A boresight is not a bearing to the object. The operator hand-slews the
// turret and the object wanders around inside the frame, so the sightline
// carries an unknown, strongly autocorrelated pointing error bounded roughly by
// the frame half-width. Every other fit treats that error as if it were the
// object moving.
//
// It cannot simply be estimated away. A world-frame displacement of the target
// projects into the image as a signal at the AZIMUTH SWEEP frequency — the rate
// at which the sensor's bearing to the object rotates. Any nuisance model whose
// basis contains that frequency will happily absorb the trajectory instead, and
// a magnitude prior only decides how the shared signal gets split. Measured on
// the Aguadilla clip: a cubic spline with 10-25 s knots, or a Fourier basis
// starting at 1 cycle per clip, moves the fitted wind and altitude while
// "improving" the residual. A constant image-plane offset is worse still,
// because an incomplete sweep leaves it partly degenerate with the anchor.
//
// So the nuisance basis here is deliberately HIGH-PASS: Fourier modes from
// nMin to nMax cycles per clip, with nMin set safely above the sweep's own
// cycle count. That column space provably cannot represent the slow
// trajectory signature, so the operator's fast wobble is absorbed and the
// physics is left alone. Measured across nMin = 2..4 and nMax = 8..60 the
// fitted wind moved by under 1 m/s and the altitudes by under 5 m while the
// residual fell from 0.26 to 0.05 degrees.
//
// This does NOT correct the operator's slow drift. Nothing can, from a
// boresight alone: a pointing error whose correlation time approaches the clip
// length is absorbed into the fitted trajectory as a bias in range, heading and
// altitude, and leaves no residual behind. The honest claim is narrower — the
// fit declines to let fast operator wobble bias the physics, and reports the
// slow part as an unremovable ambiguity.
//
// ---------------------------------------------------------------------------
// 3. THE VERTICAL PROFILE IS THERMODYNAMICS, NOT A CURVE SHAPE
// ---------------------------------------------------------------------------
// A lantern's vertical response time (envelope + entrained air + added mass,
// over drag) is under a second, so drag balances net buoyancy algebraically:
//
//     w = sign(B-1) * vTerm * sqrt(|B-1|),   vTerm = sqrt(2 m g / (rho cD A))
//
// with B the buoyancy ratio (lift over weight). B moves for two reasons:
// climbing into thinner air reduces lift — a restoring force with an effective
// scale height H_EFF, which is why a lit lantern settles toward a neutral level
// instead of climbing away — and, after flame-out, the interior superheat
// decays with a lumped time constant tau = m_in c_p / (U A_env).
//
//     b(t, dz) = B(t) - 1 - dz / H_EFF
//     B(t)     = beta0                        t <= tOut
//              = beta0 * exp(-(t - tOut)/tau) t >  tOut
//
// Everything depends on the altitude CHANGE dz, never the absolute altitude, so
// the profile stays anchor-free and the closed-form anchor solve survives.
//
// Why bother, when a rise/decay/sink curve fits just as well? Because the
// parameters then mean something and can be bounded by measurement. Static
// force-balance tests on 38 real sky lanterns give envelope volumes of
// 0.10-0.24 m^3 and masses of 54-114 g, hence a cold terminal fall speed of
// 1.6-3.2 m/s, and burn times of 100-330 s. A phenomenological fit is free to
// return a lantern that went out minutes ago and is still sinking at 0.3 m/s —
// a cold paper bag falling at a tenth of its terminal velocity, which is not a
// worse fit, it is an impossible object. Bounding vTerm is what makes the model
// able to say so.
//
// ---------------------------------------------------------------------------
// WHAT THIS ESTABLISHES, AND WHAT IT DOES NOT
// ---------------------------------------------------------------------------
// Assumes: the object is a passive wind tracer; the wind is horizontally
// uniform over the drift; the vertical motion is buoyancy-versus-drag; and the
// operator's pointing error has no power at the azimuth-sweep frequency.
//
// Does NOT establish that the object was a lantern. A low residual means the
// sightlines are COMPATIBLE with a wind tracer, which is a statement about the
// sightlines, not about the object. It does not establish the range when the
// slow pointing error is doing the work, and it does not establish the wind
// SPEED nearly as well as the wind DIRECTION — see windRoseMap, which measures
// exactly that and is the honest thing to publish alongside the path.

const DEG = 180 / Math.PI;

// Wind shear multiplier clamp: the wind may vary with height but must never
// reverse or blow up. Same convention as SkyLanternModel.
const MULT_MIN = 0.25;
const MULT_MAX = 3.0;

// Effective scale height for the buoyancy restoring force: the air-density
// scale height corrected for the ambient lapse rate. 13 km for a tropical
// lapse, 7 km under a nocturnal inversion; 10 km is the middle and the fit is
// insensitive to it at these altitude excursions.
const H_EFF = 10000;

// Physical bounds on the fractional wind-speed change per metre of height.
// For a power-law profile d(ln S)/dh = p/h, and p is 0.10-0.14 over open sea,
// so at a few hundred metres the physical value is around 5e-4 per metre.
// A looser box lets the fit buy residual with a wind profile that does not
// exist; see the pinned-bound reporting below.
export const SHEAR_BOUNDS_PHYSICAL = [-0.0005, 0.0012];
export const SHEAR_BOUNDS_LOOSE = [-0.004, 0.008];

// Parameter order. There is deliberately no range parameter.
export const WIND_TRACER_PARAMS = [
    // Wind is a SEARCH RANGE, not a physical envelope — the same deliberate
    // choice SkyLanternModel documents. A component box cuts the corner off the
    // circle, so a bound of b is reachable from every bearing only at speed b.
    {name: "windE", min: -40, max: 40, scale: 2},
    {name: "windN", min: -40, max: 40, scale: 2},
    {name: "shearPerM", min: SHEAR_BOUNDS_PHYSICAL[0], max: SHEAR_BOUNDS_PHYSICAL[1], scale: 0.0003},
    // Buoyancy ratio at clip start. 1.0 is exactly neutral; below 1 sinks.
    {name: "beta0", min: 0.90, max: 1.60, scale: 0.05},
    // Cold terminal fall speed, from measured lantern masses and volumes.
    {name: "vTerm", min: 1.6, max: 3.2, scale: 0.3},
    // Flame-out time relative to clip start. Past the clip end means the flame
    // never went out while we were watching, which for a source that stays hot
    // in an IR video is the expected answer.
    {name: "tOut", min: -300, max: 600, scale: 60},
    // Interior cooling time constant, m_in c_p / (U A_env).
    {name: "tauCool", min: 5, max: 40, scale: 8},
    // Fractional change in each wind component across the whole clip. This is
    // the wind CHANGING (a gust front, a land breeze) as opposed to the shear
    // above, which is the wind varying with HEIGHT. On a steadily descending
    // object the two are nearly degenerate and only their bounds separate them.
    {name: "windChangeE", min: -0.95, max: 3, scale: 0.2},
    {name: "windChangeN", min: -0.95, max: 3, scale: 0.2},
];

export function defaultWindTracerParams() {
    return [0, 0, 0.0005, 1.0, 2.4, 600, 15, 0, 0];
}

export function clampWindTracerParams(theta, defs = WIND_TRACER_PARAMS) {
    return theta.map((v, i) => {
        if (!Number.isFinite(v)) return defaultWindTracerParams()[i];
        return Math.max(defs[i].min, Math.min(defs[i].max, v));
    });
}

// ---------------------------------------------------------------------------
// Displacement shape
// ---------------------------------------------------------------------------

/**
 * The trajectory's displacement from its (unknown) anchor, in local ENU metres.
 * Returns a Float64Array of 3*times.length. D(0) is exactly [0,0,0], which is
 * what keeps the anchor separable.
 */
export function windTracerDisplacement(theta, times) {
    const [wE, wN, shear, beta0, vTerm, tOut, tau, chE = 0, chN = 0] = theta;
    const n = times.length;
    const out = new Float64Array(n * 3);
    if (!n) return out;
    const T = (times[n - 1] - times[0]) || 1;

    const bOf = (t) => (t <= tOut ? beta0 : beta0 * Math.exp(-(t - tOut) / tau));
    const wOf = (t, dz) => {
        const b = bOf(t) - 1 - dz / H_EFF;
        return (b >= 0 ? 1 : -1) * vTerm * Math.sqrt(Math.abs(b));
    };

    let dz = 0, accE = 0, accN = 0, prevE = 0, prevN = 0;
    for (let i = 0; i < n; i++) {
        if (i) {
            // RK4 on the single vertical state. The dynamics are smooth and
            // non-stiff (that is the whole point of working in dz rather than
            // in a force balance that cancels to one part in fifty), so one
            // step per sample is ample.
            const t0 = times[i - 1], h = times[i] - t0;
            const k1 = wOf(t0, dz);
            const k2 = wOf(t0 + h / 2, dz + h * k1 / 2);
            const k3 = wOf(t0 + h / 2, dz + h * k2 / 2);
            const k4 = wOf(t0 + h, dz + h * k3);
            dz += h * (k1 + 2 * k2 + 2 * k3 + k4) / 6;
        }
        let mult = 1 + shear * dz;
        if (mult < MULT_MIN) mult = MULT_MIN;
        if (mult > MULT_MAX) mult = MULT_MAX;
        const s = (times[i] - times[0]) / T;
        const vE = mult * (1 + chE * s), vN = mult * (1 + chN * s);
        if (i) {
            const dt = times[i] - times[i - 1];
            accE += 0.5 * (vE + prevE) * dt;
            accN += 0.5 * (vN + prevN) * dt;
        }
        prevE = vE; prevN = vN;
        out[i * 3] = wE * accE;
        out[i * 3 + 1] = wN * accN;
        out[i * 3 + 2] = dz;
    }
    return out;
}

// ---------------------------------------------------------------------------
// The band-limited operator-motion basis
// ---------------------------------------------------------------------------

/**
 * Total azimuth sweep of the sightlines, in CYCLES over the clip. This is the
 * frequency at which a world-frame target displacement shows up in the image,
 * and therefore the frequency the operator-motion basis must stay above.
 */
export function azimuthSweepCycles(dataset) {
    const {losDir, count} = dataset;
    let sweep = 0;
    let prev = Math.atan2(losDir[0], losDir[1]);
    for (let i = 1; i < count; i++) {
        const az = Math.atan2(losDir[i * 3], losDir[i * 3 + 1]);
        let d = az - prev;
        if (d > Math.PI) d -= 2 * Math.PI;
        if (d < -Math.PI) d += 2 * Math.PI;
        sweep += Math.abs(d);
        prev = az;
    }
    return sweep / (2 * Math.PI);
}

/**
 * Fourier modes from nMin to nMax cycles per clip, one cos/sin pair each.
 * nMin defaults to a safe margin above the measured azimuth sweep.
 */
export function makeOperatorBasis(dataset, opts = {}) {
    const {count, times} = dataset;
    const T = (times[count - 1] - times[0]) || 1;
    const cycles = azimuthSweepCycles(dataset);
    // The low cutoff, and it is the single most important number in the method.
    //
    // Twice the azimuth sweep plus one keeps the basis clear of the frequency at
    // which the trajectory shows up in the image; the floor of 3 says the
    // nuisance may only represent structure that repeats at least three times
    // across the clip, which a world-frame drift over an incomplete sweep never
    // does.
    //
    // Both halves are load-bearing. MEASURED on a synthetic descending tracer
    // with known truth, 0.44 cycles of sweep and 0.30 deg of injected
    // operator-colored pointing error: with nMin = 2 the fit absorbed 1.43 deg
    // of "pointing" — five times what was there — and its separation from truth
    // went from 29 m (model off) to 46 m. With nMin = 3 it absorbed 0.41 deg and
    // the separation fell to 11 m. Tightening the magnitude prior did NOT
    // rescue nMin = 2 (sigma 0.4 -> 0.05 left it at 38 m), which is the direct
    // evidence that the BAND is the operative constraint and the magnitude
    // prior is not.
    const nMin = opts.nMin ?? Math.max(3, Math.ceil(2 * cycles + 1));
    const nMax = opts.nMax ?? Math.max(nMin, nMin + 12);
    const modes = [];
    for (let n = nMin; n <= nMax; n++) modes.push(n);
    const m = 2 * modes.length;
    return {
        m, nMin, nMax, cycles, modes, T,
        sample(t, out) {
            for (let k = 0; k < modes.length; k++) {
                const w = 2 * Math.PI * modes[k] * t / T;
                out[2 * k] = Math.cos(w);
                out[2 * k + 1] = Math.sin(w);
            }
        },
    };
}

// ---------------------------------------------------------------------------
// Small dense linear algebra
// ---------------------------------------------------------------------------

function cholesky(A) {
    const n = A.length;
    const L = Array.from({length: n}, () => new Float64Array(n));
    for (let i = 0; i < n; i++) {
        for (let j = 0; j <= i; j++) {
            let s = A[i][j];
            for (let k = 0; k < j; k++) s -= L[i][k] * L[j][k];
            if (i === j) {
                if (!(s > 0)) return null;
                L[i][i] = Math.sqrt(s);
            } else {
                L[i][j] = s / L[j][j];
            }
        }
    }
    return L;
}

function cholSolve(L, b, out) {
    const n = L.length;
    const y = out ?? new Float64Array(n);
    for (let i = 0; i < n; i++) {
        let s = b[i];
        for (let k = 0; k < i; k++) s -= L[i][k] * y[k];
        y[i] = s / L[i][i];
    }
    for (let i = n - 1; i >= 0; i--) {
        let s = y[i];
        for (let k = i + 1; k < n; k++) s -= L[k][i] * y[k];
        y[i] = s / L[i][i];
    }
    return y;
}

function solve3(A, b) {
    const M = [[A[0][0], A[0][1], A[0][2], b[0]],
               [A[1][0], A[1][1], A[1][2], b[1]],
               [A[2][0], A[2][1], A[2][2], b[2]]];
    for (let c = 0; c < 3; c++) {
        let p = c;
        for (let r = c + 1; r < 3; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
        if (Math.abs(M[p][c]) < 1e-13) return null;
        if (p !== c) { const t = M[p]; M[p] = M[c]; M[c] = t; }
        for (let r = 0; r < 3; r++) {
            if (r === c) continue;
            const f = M[r][c] / M[c][c];
            for (let k = c; k <= 3; k++) M[r][k] -= f * M[c][k];
        }
    }
    return [M[0][3] / M[0][0], M[1][3] / M[1][1], M[2][3] / M[2][2]];
}

// ---------------------------------------------------------------------------
// The inner closed-form solve
// ---------------------------------------------------------------------------

/**
 * Precompute everything that does not depend on the shape parameters: the
 * basis samples, the frozen per-frame ranges (which turn the metric residual
 * into an angular one) and the factored nuisance Gram matrix.
 *
 * The residual at frame i, for image axis e (cross-boresight or vertical), is
 *
 *     res = e . (P0 + D_i - S_i) / r_i  -  phi(t_i) . c
 *
 * with r_i FROZEN from a previous pass. So the nuisance coefficients c are in
 * radians — an angular pointing offset, which is what an operator error is —
 * and the Gram matrix Phi^T Phi + lambda I depends on neither the shape
 * parameters nor the range. Build it once, factor it once, and every cost
 * evaluation is then O(N * 3M) rather than O(N * (3+2M)^2).
 */
export function makeWindTracerContext(dataset, opts = {}, rangeGuess = null) {
    const {count, times} = dataset;
    const sigmaPointDeg = opts.sigmaPointDeg ?? 0.4;
    const sigmaMeasDeg = opts.sigmaMeasDeg ?? 0.05;
    const basis = opts.operatorModel === false
        ? {m: 0, nMin: 0, nMax: 0, cycles: azimuthSweepCycles(dataset)}
        : makeOperatorBasis(dataset, opts);
    const M = basis.m;
    const rFix = new Float64Array(count);
    for (let i = 0; i < count; i++) {
        const r = rangeGuess ? rangeGuess[i] : 0;
        rFix[i] = Number.isFinite(r) && r > 1 ? r : 5000;
    }
    let PHI = null, L = null;
    if (M) {
        PHI = new Float64Array(count * M);
        const G = Array.from({length: M}, () => new Float64Array(M));
        const row = new Float64Array(M);
        for (let i = 0; i < count; i++) {
            basis.sample(times[i] - times[0], row);
            for (let k = 0; k < M; k++) PHI[i * M + k] = row[k];
            for (let k = 0; k < M; k++) for (let l = 0; l <= k; l++) G[k][l] += row[k] * row[l];
        }
        for (let k = 0; k < M; k++) for (let l = 0; l < k; l++) G[l][k] = G[k][l];
        // The magnitude prior, and the scaling it needs to mean anything.
        //
        // A textbook ridge is (sigma_meas / sigma_point)^2 — correct when the
        // residuals are INDEPENDENT. They are not: the pointing error this
        // basis exists to absorb is autocorrelated over tens of seconds, so the
        // count of independent samples informing each coefficient is nothing
        // like `count`. Left unscaled, the prior is worth ~0.02 observations
        // against a data block whose diagonal is count/2, and the slider does
        // nothing at all — measured, a hundredfold change in sigmaPointDeg left
        // the Aguadilla fit identical to four decimal places.
        //
        // Scaling by the per-coefficient data weight makes sigmaPointDeg a real
        // shrinkage control: at sigma_point == sigma_meas the coefficients are
        // halved, and a large sigma_point leaves the basis free. It is a
        // SECONDARY control — the band, not the magnitude, is what stops the
        // nuisance eating the trajectory (measured: tightening this prior 8x
        // did not rescue a low cutoff) — but a knob that does nothing is worse
        // than no knob.
        let dataWeight = 0;
        for (let k = 0; k < M; k++) dataWeight += G[k][k];
        dataWeight = M ? dataWeight / M : 1;
        const lam = dataWeight * (sigmaMeasDeg / sigmaPointDeg) ** 2;
        for (let k = 0; k < M; k++) G[k][k] += lam;
        L = cholesky(G);
        if (!L) return null;
    }
    return {basis, M, PHI, L, rFix, count, sigmaPointDeg, sigmaMeasDeg};
}

/**
 * Solve for the anchor and the operator-motion coefficients, given a
 * displacement shape. Returns {P0, cA, cB, r, resid, residRaw, rmsDeg,
 * rmsRawDeg, pointingDeg} or null.
 *
 * Block structure is what makes this cheap: the cross-boresight rows involve
 * the anchor and cA only, the vertical rows the anchor and cB only, so the
 * shared Gram matrix is block-diagonal in the two axes and the anchor drops out
 * of a 3x3 Schur complement.
 */
export function solveWindTracerAnchor(dataset, displacement, ctx) {
    const {sensorPos: S, camUp: U, camRight: R, count: N} = dataset;
    const {M, PHI, L, rFix} = ctx;
    const App = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    const bp = [0, 0, 0];
    const Ua = M ? [new Float64Array(M), new Float64Array(M), new Float64Array(M)] : null;
    const Ub = M ? [new Float64Array(M), new Float64Array(M), new Float64Array(M)] : null;
    const va = M ? new Float64Array(M) : null;
    const vb = M ? new Float64Array(M) : null;

    for (let i = 0; i < N; i++) {
        const bi = i * 3, ri = rFix[i];
        for (let which = 0; which < 2; which++) {
            const E = which === 0 ? R : U;
            const j0 = E[bi] / ri, j1 = E[bi + 1] / ri, j2 = E[bi + 2] / ri;
            const rhs = j0 * (S[bi] - displacement[bi])
                      + j1 * (S[bi + 1] - displacement[bi + 1])
                      + j2 * (S[bi + 2] - displacement[bi + 2]);
            App[0][0] += j0 * j0; App[0][1] += j0 * j1; App[0][2] += j0 * j2;
            App[1][0] += j1 * j0; App[1][1] += j1 * j1; App[1][2] += j1 * j2;
            App[2][0] += j2 * j0; App[2][1] += j2 * j1; App[2][2] += j2 * j2;
            bp[0] += j0 * rhs; bp[1] += j1 * rhs; bp[2] += j2 * rhs;
            if (M) {
                const X = which === 0 ? Ua : Ub, v = which === 0 ? va : vb;
                const base = i * M;
                for (let k = 0; k < M; k++) {
                    const ph = PHI[base + k];
                    X[0][k] += ph * j0; X[1][k] += ph * j1; X[2][k] += ph * j2;
                    v[k] += ph * rhs;
                }
            }
        }
    }

    const A = [App[0].slice(), App[1].slice(), App[2].slice()];
    const b = bp.slice();
    let ga = null, gb = null, gUa = null, gUb = null;
    if (M) {
        ga = cholSolve(L, va); gb = cholSolve(L, vb);
        gUa = [0, 1, 2].map(p => cholSolve(L, Ua[p]));
        gUb = [0, 1, 2].map(p => cholSolve(L, Ub[p]));
        for (let p = 0; p < 3; p++) {
            for (let q = 0; q < 3; q++) {
                let sa = 0, sb = 0;
                for (let k = 0; k < M; k++) { sa += Ua[p][k] * gUa[q][k]; sb += Ub[p][k] * gUb[q][k]; }
                A[p][q] -= sa + sb;
            }
            let sa = 0, sb = 0;
            for (let k = 0; k < M; k++) { sa += Ua[p][k] * ga[k]; sb += Ub[p][k] * gb[k]; }
            b[p] -= sa + sb;
        }
    }
    const P0 = solve3(A, b);
    if (!P0) return null;

    let cA = null, cB = null;
    if (M) {
        const ta = new Float64Array(M), tb = new Float64Array(M);
        for (let k = 0; k < M; k++) {
            ta[k] = Ua[0][k] * P0[0] + Ua[1][k] * P0[1] + Ua[2][k] * P0[2] - va[k];
            tb[k] = Ub[0][k] * P0[0] + Ub[1][k] * P0[1] + Ub[2][k] * P0[2] - vb[k];
        }
        cA = cholSolve(L, ta); cB = cholSolve(L, tb);
    }

    // Residuals, ranges and the modelled pointing offset.
    const r = new Float64Array(N);
    const resid = new Float64Array(N * 2);
    const residRaw = new Float64Array(N * 2);
    const pointing = M ? new Float64Array(N * 2) : null;
    let sse = 0, sseRaw = 0, maxPoint = 0;
    for (let i = 0; i < N; i++) {
        const bi = i * 3;
        const px = P0[0] + displacement[bi] - S[bi];
        const py = P0[1] + displacement[bi + 1] - S[bi + 1];
        const pz = P0[2] + displacement[bi + 2] - S[bi + 2];
        const ri = Math.hypot(px, py, pz) || 1;
        r[i] = ri;
        let pa = 0, pb = 0;
        for (let which = 0; which < 2; which++) {
            const E = which === 0 ? R : U;
            const a = (E[bi] * px + E[bi + 1] * py + E[bi + 2] * pz) / ri;
            residRaw[i * 2 + which] = a;
            sseRaw += a * a;
            let c = a;
            if (M) {
                const coef = which === 0 ? cA : cB;
                let s = 0;
                const base = i * M;
                for (let k = 0; k < M; k++) s += PHI[base + k] * coef[k];
                pointing[i * 2 + which] = s;
                if (which === 0) pa = s; else pb = s;
                c -= s;
            }
            resid[i * 2 + which] = c;
            sse += c * c;
        }
        if (M) maxPoint = Math.max(maxPoint, Math.hypot(pa, pb));
    }
    return {
        P0, cA, cB, r, resid, residRaw, pointing,
        rmsDeg: Math.sqrt(sse / N) * DEG,
        rmsRawDeg: Math.sqrt(sseRaw / N) * DEG,
        maxPointingDeg: maxPoint * DEG,
    };
}

// ---------------------------------------------------------------------------
// Cost and outer search
// ---------------------------------------------------------------------------

/** Soft physical priors. The hard bounds carry the real physics; these nudge. */
function windTracerPriors(theta, opts) {
    const [wE, wN, shear, , , , , chE, chN] = theta;
    let c = 0;
    if (opts.windPrior) {
        const dE = wE - opts.windPrior[0], dN = wN - opts.windPrior[1];
        c += (dE * dE + dN * dN) / ((opts.windPriorSigma ?? 7.7) ** 2);
    } else {
        // No measured wind: prefer lighter winds, since a lantern launch implies
        // calm-ish surface conditions. This PREFERS, it does not exclude.
        c += 0.5 * (Math.hypot(wE, wN) / 10) ** 2;
    }
    if (shear < 0) c += 0.5 * (shear / 0.0005) ** 2;   // wind slower aloft is less common
    // A wind that changes a lot over four minutes is possible but unusual.
    c += ((chE * chE) + (chN * chN)) / (0.5 * 0.5);
    return c;
}

export function windTracerCost(dataset, theta, ctx, opts = {}) {
    const displacement = windTracerDisplacement(theta, dataset.times);
    const inner = solveWindTracerAnchor(dataset, displacement, ctx);
    if (!inner || !Number.isFinite(inner.rmsDeg)) return {cost: Infinity, inner: null};
    // Bayesian scaling, and it matters. The data term is a SUM over frames of
    // standardized squared residuals, so it grows with N; the nuisance term is a
    // sum over coefficients; the physical priors are O(1) per clip. Writing the
    // data term as a per-frame MEAN instead makes the priors N times stronger
    // than they should be — measured on Aguadilla, that pulled the fitted wind
    // from 21 kt down to 7 kt purely on the light-wind preference.
    const sigMeas = opts.sigmaMeasDeg ?? 0.05;
    let cost = dataset.count * (inner.rmsDeg / sigMeas) ** 2;
    if (inner.cA) {
        const sig = (opts.sigmaPointDeg ?? 0.4) / DEG;
        let pen = 0;
        for (let k = 0; k < inner.cA.length; k++) {
            pen += (inner.cA[k] / sig) ** 2 + (inner.cB[k] / sig) ** 2;
        }
        cost += pen;
    }
    cost += windTracerPriors(theta, opts);
    return {cost: cost / dataset.count, inner, displacement};
}

/** Nelder-Mead. Deterministic; no random restarts. */
function nelderMead(f, x0, scale, maxIter = 1200, tol = 1e-10) {
    const n = x0.length;
    let simplex = [x0.slice()];
    for (let i = 0; i < n; i++) {
        const p = x0.slice();
        p[i] += scale[i];
        simplex.push(p);
    }
    let vals = simplex.map(f);
    for (let iter = 0; iter < maxIter; iter++) {
        const order = vals.map((v, i) => i).sort((a, b) => vals[a] - vals[b]);
        simplex = order.map(i => simplex[i]);
        vals = order.map(i => vals[i]);
        if (Math.abs(vals[n] - vals[0]) < tol * (Math.abs(vals[0]) + tol)) break;
        const cen = new Array(n).fill(0);
        for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) cen[j] += simplex[i][j] / n;
        const move = (k) => cen.map((c, j) => c + k * (c - simplex[n][j]));
        const xr = move(1), fr = f(xr);
        if (fr < vals[0]) {
            const xe = move(2), fe = f(xe);
            if (fe < fr) { simplex[n] = xe; vals[n] = fe; } else { simplex[n] = xr; vals[n] = fr; }
        } else if (fr < vals[n - 1]) {
            simplex[n] = xr; vals[n] = fr;
        } else {
            const xc = move(-0.5), fc = f(xc);
            if (fc < vals[n]) { simplex[n] = xc; vals[n] = fc; }
            else for (let i = 1; i <= n; i++) {
                simplex[i] = simplex[i].map((v, j) => simplex[0][j] + 0.5 * (v - simplex[0][j]));
                vals[i] = f(simplex[i]);
            }
        }
    }
    let best = 0;
    for (let i = 1; i <= n; i++) if (vals[i] < vals[best]) best = i;
    return {x: simplex[best], f: vals[best]};
}

/**
 * Fit a wind tracer to a LOS dataset.
 *
 * The global seed is a WIND ROSE — a grid over wind speed and bearing with the
 * anchor solved in closed form at every node. That is affordable precisely
 * because the anchor is not being searched, and it removes the need for a
 * stochastic global optimizer: the result is deterministic.
 *
 * options:
 *   sigmaPointDeg   plausible operator pointing error, degrees (default 0.4)
 *   sigmaMeasDeg    irreducible angular noise, degrees (default 0.05)
 *   operatorModel   false to disable the operator-motion basis entirely
 *   nMin, nMax      operator basis band, cycles per clip (default: derived)
 *   looseShear      true to widen the shear bound past its physical value
 *   windPrior       [E, N] measured wind in m/s to pin the drift loosely to
 *   paramOverrides  {name: value} initial-guess overrides
 *   paramLocks      {name: value} hold fixed and search only the rest
 *
 * Returns {positions, residuals, params, activeCount} in the shape the other
 * LOSFitting fits return, plus a `report` block of derived physical quantities.
 */
/**
 * A strided view of a dataset, for the search only. The closed-form anchor
 * solve is O(N * M) per evaluation and the wind rose alone is ~2000 of them,
 * so a 30 fps clip is resampled to a few Hz for the search; the reported
 * trajectory and residuals are always computed at full resolution afterwards.
 * The displacement shape is analytic, so nothing is lost but time.
 */
function strideDataset(dataset, stride) {
    if (stride <= 1) return dataset;
    const n = Math.floor((dataset.count - 1) / stride) + 1;
    const out = {count: n, maxRange: dataset.maxRange};
    for (const key of ["sensorPos", "losDir", "camUp", "camRight"]) {
        const src = dataset[key];
        const dst = new Float64Array(n * 3);
        for (let i = 0; i < n; i++) {
            const j = i * stride;
            dst[i * 3] = src[j * 3]; dst[i * 3 + 1] = src[j * 3 + 1]; dst[i * 3 + 2] = src[j * 3 + 2];
        }
        out[key] = dst;
    }
    const t = new Float64Array(n);
    for (let i = 0; i < n; i++) t[i] = dataset.times[i * stride];
    out.times = t;
    return out;
}

export function fitWindTracer(dataset, options = {}) {
    const {count: N, times} = dataset;
    if (N < 8) return null;
    // Aim for roughly this many samples in the search. Below a few hundred the
    // wind rose starts to alias the operator wobble into the physics.
    const targetSamples = options.searchSamples ?? 1500;
    const stride = Math.max(1, Math.floor(N / targetSamples));
    const searchDS = strideDataset(dataset, stride);

    const defs = WIND_TRACER_PARAMS.map((p, i) => (i === 2 && options.looseShear)
        ? {...p, min: SHEAR_BOUNDS_LOOSE[0], max: SHEAR_BOUNDS_LOOSE[1]}
        : p);
    const clamp = (th) => th.map((v, i) => Math.max(defs[i].min, Math.min(defs[i].max, v)));

    let theta = defaultWindTracerParams();
    if (options.paramOverrides) {
        defs.forEach((p, i) => {
            const v = options.paramOverrides[p.name];
            if (v !== undefined) theta[i] = v;
        });
    }
    const locks = options.paramLocks || null;
    const freeIdx = [];
    defs.forEach((p, i) => {
        const v = locks ? locks[p.name] : undefined;
        if (v === undefined) freeIdx.push(i);
        else theta[i] = v;
    });

    let ctx = makeWindTracerContext(searchDS, options, null);
    if (!ctx) return null;
    const costOf = (th) => windTracerCost(searchDS, clamp(th), ctx, options).cost;

    // --- global seed: the wind rose ---
    if (!locks || (locks.windE === undefined && locks.windN === undefined)) {
        let best = null;
        for (let spd = 1; spd <= 26; spd += 1.5) {
            for (let dir = 0; dir < 360; dir += 10) {
                const th = theta.slice();
                th[0] = -spd * Math.sin(dir * Math.PI / 180);
                th[1] = -spd * Math.cos(dir * Math.PI / 180);
                for (const beta of [0.94, 0.99, 1.05]) {
                    th[3] = beta;
                    const c = costOf(th);
                    if (!best || c < best.c) best = {c, th: th.slice()};
                }
            }
        }
        if (best) theta = clamp(best.th);
    }

    // --- refine, re-freezing the ranges between passes (outer IRLS) ---
    let inner = null;
    for (let pass = 0; pass < 3; pass++) {
        const sub = freeIdx.map(i => theta[i]);
        const scale = freeIdx.map(i => defs[i].scale / (pass + 1));
        const res = nelderMead((v) => {
            const th = theta.slice();
            freeIdx.forEach((i, k) => th[i] = v[k]);
            return costOf(th);
        }, sub, scale, options.maxIter ?? 1200);
        freeIdx.forEach((i, k) => theta[i] = res.x[k]);
        theta = clamp(theta);
        const out = windTracerCost(searchDS, theta, ctx, options);
        inner = out.inner;
        if (!inner) return null;
        const next = makeWindTracerContext(searchDS, options, inner.r);
        if (next) ctx = next;
    }

    // Final pass at full resolution: same shape parameters, but the anchor and
    // the operator-motion coefficients are re-solved against every frame.
    const searchCtx = ctx;
    const searchTheta = theta.slice();
    const displacement = windTracerDisplacement(theta, times);
    const rangeSeed = new Float64Array(N);
    for (let i = 0; i < N; i++) rangeSeed[i] = inner.r[Math.min(inner.r.length - 1, Math.floor(i / stride))];
    const fullCtx = makeWindTracerContext(dataset, options, rangeSeed) ?? ctx;
    inner = solveWindTracerAnchor(dataset, displacement, fullCtx);
    if (!inner) return null;
    ctx = fullCtx;

    // --- emit in the standard fit shape ---
    const positions = new Float64Array(N * 3);
    const residuals = new Float32Array(N);
    for (let i = 0; i < N; i++) {
        positions[i * 3] = inner.P0[0] + displacement[i * 3];
        positions[i * 3 + 1] = inner.P0[1] + displacement[i * 3 + 1];
        positions[i * 3 + 2] = inner.P0[2] + displacement[i * 3 + 2];
        // Angular residual in radians, matching the physics/Monte Carlo fits.
        residuals[i] = Math.hypot(inner.resid[i * 2], inner.resid[i * 2 + 1]);
    }

    // Which pinned bounds are real constraints and which are FLAT DIRECTIONS?
    // A parameter sitting on its bound looks like "the search wanted more", but
    // it can equally be a direction the cost barely feels once the others are
    // allowed to compensate. While a lantern is lit its sink rate is
    // vTerm * sqrt(1 - beta0), so only the PRODUCT is observable and vTerm alone
    // drifts onto whichever bound it started nearest; beta0 then slides to keep
    // the sink rate. Reporting that as "search incomplete" cries wolf.
    //
    // The test must therefore be a PROFILE step, not a coordinate step: move the
    // pinned parameter 10% of its range inwards, RE-OPTIMISE everything else,
    // and see what the cost does. A coordinate step alone calls every profile
    // direction a constraint. Pins are few, so the extra Nelder-Mead passes are
    // affordable.
    const pinInfo = [];
    const baseCost = windTracerCost(searchDS, searchTheta, searchCtx, options).cost;
    for (const idx of freeIdx) {
        const p = defs[idx];
        const span = p.max - p.min;
        const atMin = theta[idx] <= p.min + span * 1e-3;
        const atMax = theta[idx] >= p.max - span * 1e-3;
        if (!atMin && !atMax) continue;
        const held = searchTheta.slice();
        held[idx] += (atMin ? 1 : -1) * span * 0.1;
        const others = freeIdx.filter(j => j !== idx);
        const res = nelderMead((v) => {
            const th = held.slice();
            others.forEach((j, k) => th[j] = v[k]);
            th[idx] = held[idx];
            return windTracerCost(searchDS, clamp(th), searchCtx, options).cost;
        }, others.map(j => held[j]), others.map(j => defs[j].scale), 300);
        others.forEach((j, k) => held[j] = res.x[k]);
        const moved = windTracerCost(searchDS, clamp(held), searchCtx, options).cost;
        const rel = baseCost > 0 ? (moved - baseCost) / baseCost : 0;
        pinInfo.push({name: p.name, at: atMin ? "min" : "max",
                      relCostOfBackingOff: rel, flat: rel < 0.02});
    }

    return {
        positions, residuals, activeCount: N,
        params: buildReport(dataset, theta, inner, ctx, defs, pinInfo),
    };
}

/** Derived physical quantities, and the honest caveats that go with them. */
function buildReport(dataset, theta, inner, ctx, defs, pinInfo = []) {
    const {times, count: N} = dataset;
    const [wE, wN, shear, beta0, vTerm, tOut, tau, chE, chN] = theta;
    const T = times[N - 1] - times[0];
    const speed = Math.hypot(wE, wN);
    const from = (Math.atan2(-wE, -wN) * DEG + 360) % 360;

    const groundSpeedAt = (i) => {
        const j = Math.min(N - 1, i + 10), k = Math.max(0, i - 10);
        const dt = times[j] - times[k];
        if (!(dt > 0)) return 0;
        const d = windTracerDisplacement(theta, times);
        return Math.hypot(d[j * 3] - d[k * 3], d[j * 3 + 1] - d[k * 3 + 1]) / dt;
    };
    const disp = windTracerDisplacement(theta, times);

    // Which bounds are pinned, and which of those pins actually mean anything?
    // A pin the cost barely feels is a flat direction, not a constraint, and
    // reporting it as "search incomplete" is a false alarm.
    const pinned = pinInfo.filter(q => !q.flat).map(q => `${q.name} (${q.at})`);
    const pinnedFlat = pinInfo.filter(q => q.flat).map(q => `${q.name} (${q.at})`);

    // Frame admissibility: on how many frames would this solution have put the
    // object outside the camera frame? The one hard fact available about a
    // hand-slewed boresight is that the operator kept the object in view, and
    // no other fit in Sitrec checks it. Frames without a known FOV are not
    // counted either way.
    //
    // ONLY THE VERTICAL COMPONENT IS TESTED, and deliberately. The dataset
    // carries the vertical field of view; the horizontal one is vFOV times the
    // view's aspect ratio, which is not available here and must not be guessed
    // — assuming a square frame would fail targets that were comfortably inside
    // a widescreen one, which is the opposite of a conservative error. Comparing
    // the vertical MISS with the vertical half-height is exact whatever the
    // aspect, and one-sided: a frame it flags was genuinely outside the frame,
    // while a frame it clears may still have been outside horizontally. Read the
    // number as a floor on how often the solution is inadmissible, never a
    // ceiling.
    let framesWithFOV = 0, framesOutside = 0, worstRatio = 0;
    if (dataset.vFOV) {
        for (let i = 0; i < N; i++) {
            const fov = dataset.vFOV[i];
            if (!Number.isFinite(fov) || !(fov > 0)) continue;
            framesWithFOV++;
            // residRaw is [cross-boresight, vertical] per frame; index 1 is the
            // component the vertical half-height actually bounds.
            const missV = Math.abs(inner.residRaw[i * 2 + 1]) * DEG;
            const ratio = missV / (fov / 2);
            if (ratio > 1) framesOutside++;
            if (ratio > worstRatio) worstRatio = ratio;
        }
    }

    return {
        theta,
        model: "Wind Tracer",
        windSpeed: speed,
        windFrom: from,
        windChangePercent: [chE * 100, chN * 100],
        shearPerM: shear,
        beta0, vTerm, tOut, tauCool: tau,
        flameOutInClip: tOut > 0 && tOut < T,
        descentM: -(disp[(N - 1) * 3 + 2]),
        descentRateEnd: (disp[(N - 1) * 3 + 2] - disp[(N - 11) * 3 + 2])
                        / (times[N - 1] - times[N - 11] || 1),
        groundSpeedStart: groundSpeedAt(0),
        groundSpeedEnd: groundSpeedAt(N - 1),
        rangeStart: inner.r[0],
        rangeEnd: inner.r[N - 1],
        errDeg: inner.rmsDeg,
        errRawDeg: inner.rmsRawDeg,
        maxPointingDeg: inner.maxPointingDeg,
        operatorBand: ctx.M ? [ctx.basis.nMin, ctx.basis.nMax] : null,
        azimuthSweepCycles: ctx.basis.cycles,
        boundPinned: pinned,
        boundPinnedFlat: pinnedFlat,
        // Vertical-only, and a FLOOR rather than a count — see above.
        frameCheck: framesWithFOV ? {
            framesWithFOV,
            fractionOutsideFrameVertically: framesOutside / framesWithFOV,
            worstVerticalMissInHalfHeights: worstRatio,
        } : null,
        solved: true,
    };
}

/**
 * Wind-rose admissibility map: for each (speed, bearing) node, refit everything
 * else and report the residual. Cheap because the anchor solve is closed form.
 *
 * This is the honest uncertainty statement for a bearings-only wind-tracer fit.
 * On the Aguadilla clip it shows the wind DIRECTION pinned within a few degrees
 * while the SPEED is only bracketed to roughly a factor of two — a distinction
 * no single best-fit number can convey.
 */
export function windRoseMap(dataset, options = {}) {
    const speeds = options.speeds ?? [2, 4, 6, 8, 10, 12, 14, 16, 20, 25];
    const dirStep = options.dirStep ?? 15;
    const ctx = makeWindTracerContext(dataset, options, options.rangeGuess ?? null);
    if (!ctx) return null;
    const defs = WIND_TRACER_PARAMS;
    const clamp = (th) => th.map((v, i) => Math.max(defs[i].min, Math.min(defs[i].max, v)));
    const rows = [];
    let best = Infinity;
    for (const spd of speeds) {
        const row = [];
        for (let dir = 0; dir < 360; dir += dirStep) {
            const th = defaultWindTracerParams();
            th[0] = -spd * Math.sin(dir * Math.PI / 180);
            th[1] = -spd * Math.cos(dir * Math.PI / 180);
            // refit only the vertical profile and the wind variation
            const free = [2, 3, 4, 5, 6, 7, 8];
            const res = nelderMead((v) => {
                const t2 = th.slice();
                free.forEach((i, k) => t2[i] = v[k]);
                return windTracerCost(dataset, clamp(t2), ctx, options).cost;
            }, free.map(i => th[i]), free.map(i => defs[i].scale), 400);
            free.forEach((i, k) => th[i] = res.x[k]);
            const out = windTracerCost(dataset, clamp(th), ctx, options);
            const e = out.inner ? out.inner.rmsDeg : NaN;
            if (e < best) best = e;
            row.push(e);
        }
        rows.push(row);
    }
    return {speeds, dirStep, rows, best};
}
