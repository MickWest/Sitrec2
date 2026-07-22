// diagnostics.js — the observable regime diagnostics (PLAN.md "Conditioning
// diagnostic"). The headline feature is cvDesignRcond: the reciprocal
// condition number of the COLUMN-EQUILIBRATED constant-velocity design matrix
// over the active frames, computed as sqrt(lambdaMin/lambdaMax) of
// C = D^-1/2 G D^-1/2 with G = sum B_i^T B_i, B_i = P_i [I, tau_i I],
// P_i = I - d_i d_i^T, and tau centered/normalized time. Dimensionless,
// invariant to units and time origin, comparable across 5-120 s clips, and —
// unlike sensorMotionStats — it DOES see the straight-CV sensor degeneracy.
// Never thresholded at generation time; kept continuous for the classifier.

// Eigenvalues of a symmetric m x m matrix (flat row-major) by cyclic Jacobi.
export function symmetricEigenvalues(A, m) {
    const a = A.slice();
    for (let sweep = 0; sweep < 64; sweep++) {
        let off = 0;
        for (let p = 0; p < m - 1; p++)
            for (let q = p + 1; q < m; q++) off += a[p * m + q] * a[p * m + q];
        if (off < 1e-24) break;
        for (let p = 0; p < m - 1; p++) {
            for (let q = p + 1; q < m; q++) {
                const apq = a[p * m + q];
                if (Math.abs(apq) < 1e-30) continue;
                const app = a[p * m + p], aqq = a[q * m + q];
                const theta = (aqq - app) / (2 * apq);
                const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
                const c = 1 / Math.sqrt(t * t + 1);
                const s = t * c;
                for (let k = 0; k < m; k++) {
                    const akp = a[k * m + p], akq = a[k * m + q];
                    a[k * m + p] = c * akp - s * akq;
                    a[k * m + q] = s * akp + c * akq;
                }
                for (let k = 0; k < m; k++) {
                    const apk = a[p * m + k], aqk = a[q * m + k];
                    a[p * m + k] = c * apk - s * aqk;
                    a[q * m + k] = s * apk + c * aqk;
                }
            }
        }
    }
    const ev = [];
    for (let i = 0; i < m; i++) ev.push(a[i * m + i]);
    ev.sort((x, y) => x - y);
    return ev;
}

// dirENU: Float64Array(3n) unit directions; times: seconds; active: frame
// index iterable (post-FOV-exclusion for the observed variant).
export function cvDesignConditioning(dirENU, times, activeFrames) {
    const active = Array.from(activeFrames);
    if (active.length < 2) {
        return {rcond: null, log10Rcond: null, effectiveRank: null, lambdaMinOverTrace: null};
    }
    let tMin = Infinity, tMax = -Infinity;
    for (const f of active) {
        if (times[f] < tMin) tMin = times[f];
        if (times[f] > tMax) tMax = times[f];
    }
    const mid = (tMin + tMax) / 2;
    const halfSpan = (tMax - tMin) / 2 || 1;

    // G blocks: G00 = sum P, G01 = sum tau P, G11 = sum tau^2 P (P symmetric).
    const G = new Float64Array(36);
    for (const f of active) {
        const b = f * 3;
        const dx = dirENU[b], dy = dirENU[b + 1], dz = dirENU[b + 2];
        const tau = (times[f] - mid) / halfSpan;
        const P = [
            1 - dx * dx, -dx * dy, -dx * dz,
            -dy * dx, 1 - dy * dy, -dy * dz,
            -dz * dx, -dz * dy, 1 - dz * dz,
        ];
        for (let i = 0; i < 3; i++) {
            for (let j = 0; j < 3; j++) {
                const p = P[i * 3 + j];
                G[i * 6 + j] += p;
                G[i * 6 + (j + 3)] += tau * p;
                G[(i + 3) * 6 + j] += tau * p;
                G[(i + 3) * 6 + (j + 3)] += tau * tau * p;
            }
        }
    }

    // Un-equilibrated secondary: lambdaMin(G)/trace(G).
    const evG = symmetricEigenvalues(G, 6);
    let trace = 0;
    for (let i = 0; i < 6; i++) trace += G[i * 6 + i];
    const lambdaMinOverTrace = trace > 0 ? Math.max(0, evG[0]) / trace : null;

    // Equilibrate: C = D^-1/2 G D^-1/2.
    const dinv = new Float64Array(6);
    for (let i = 0; i < 6; i++) {
        const dii = G[i * 6 + i];
        dinv[i] = dii > 0 ? 1 / Math.sqrt(dii) : 0;
    }
    const C = new Float64Array(36);
    for (let i = 0; i < 6; i++)
        for (let j = 0; j < 6; j++) C[i * 6 + j] = G[i * 6 + j] * dinv[i] * dinv[j];

    const ev = symmetricEigenvalues(C, 6);
    const lambdaMax = ev[5];
    if (!(lambdaMax > 0)) {
        return {rcond: 0, log10Rcond: Math.log10(Number.MIN_VALUE), effectiveRank: 0, lambdaMinOverTrace};
    }
    const lambdaMin = Math.max(0, ev[0]);
    const rcond = Math.sqrt(lambdaMin / lambdaMax);
    const effectiveRank = ev.filter((e) => e > 1e-10 * lambdaMax).length;
    return {
        rcond,
        log10Rcond: Math.log10(Math.max(rcond, Number.MIN_VALUE)),
        effectiveRank,
        lambdaMinOverTrace,
    };
}

// Observable LOS-series features (classifier inputs — computed from the
// OBSERVED sightlines over active frames only; no truth anywhere):
//  - losSweepDeg: total angle between first and last active direction
//  - losMeanRateDegPerS: mean per-step angular rate
//  - losLag1Autocorr: lag-1 Pearson autocorrelation of the step magnitudes —
//    white pointing error decorrelates steps; operator wobble correlates them.
export function losSeriesFeatures(dirENU, times, activeFrames) {
    const active = Array.from(activeFrames);
    if (active.length < 3) {
        return {losSweepDeg: null, losMeanRateDegPerS: null, losLag1Autocorr: null};
    }
    const RAD2DEG = 180 / Math.PI;
    const ang = (a, b) => {
        const dot = Math.max(-1, Math.min(1,
            dirENU[a * 3] * dirENU[b * 3]
            + dirENU[a * 3 + 1] * dirENU[b * 3 + 1]
            + dirENU[a * 3 + 2] * dirENU[b * 3 + 2]));
        return Math.acos(dot) * RAD2DEG;
    };
    const steps = [];
    for (let i = 1; i < active.length; i++) {
        const dt = times[active[i]] - times[active[i - 1]];
        if (dt > 0) steps.push(ang(active[i - 1], active[i]) / dt);
    }
    let lag1 = null;
    if (steps.length >= 3) {
        const m = steps.reduce((a, b) => a + b, 0) / steps.length;
        let num = 0, den = 0;
        for (let i = 0; i < steps.length; i++) {
            den += (steps[i] - m) ** 2;
            if (i > 0) num += (steps[i] - m) * (steps[i - 1] - m);
        }
        lag1 = den > 1e-20 ? num / den : null;
    }
    return {
        losSweepDeg: ang(active[0], active[active.length - 1]),
        losMeanRateDegPerS: steps.length
            ? steps.reduce((a, b) => a + b, 0) / steps.length : null,
        losLag1Autocorr: lag1,
    };
}

export function sensorPathStats(positionENU, n) {
    let len = 0;
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let f = 0; f < n; f++) {
        const b = f * 3;
        const x = positionENU[b], y = positionENU[b + 1], z = positionENU[b + 2];
        if (f > 0) {
            len += Math.hypot(x - positionENU[b - 3], y - positionENU[b - 2], z - positionENU[b - 1]);
        }
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
        if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
    return {
        sensorPathLengthM: len,
        sensorSpanM: Math.hypot(maxX - minX, maxY - minY, maxZ - minZ),
    };
}
