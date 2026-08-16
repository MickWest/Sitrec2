/**
 * Empirical bearing-noise self-check (BOT-Tractability-Plan.md step 6).
 *
 * Every series here is built in the test rather than read from a stored record,
 * so the answer is exact and the assertions are about the ESTIMATOR rather than
 * about a scenario. Four properties:
 *
 *   - a known-sigma white series is recovered, in the same per-axis convention
 *     observation.js declares, and a misdeclared sigma is flagged;
 *   - the whiteness test runs against the detrend's OWN null (-0.49 for a
 *     7-sample quadratic), not against zero;
 *   - a correlated series declared white is caught, twice over;
 *   - a violently maneuvering target DEMONSTRATES the documented understatement
 *     instead of merely being warned about it: the same estimator returns the
 *     sensor jitter at a short window and 58x that at a window the maneuver
 *     outruns, and every declaration check passes at the short window, so the
 *     caveat is the only thing between a caller and a wrong number.
 */

import {generateObservation} from "../../benchmarks/botbench/lib/observation";
import {makeStream} from "../../benchmarks/botbench/lib/rng";
import {
    noiseSelfCheck, canonicalResidualFilter, DEFAULT_RATIO_BAND,
} from "../../benchmarks/botbench/lib/noiseSelfCheck";

const DEG = Math.PI / 180;

// Clean unit directions from an azimuth/elevation program. `maneuverAmpDeg`
// adds a sinusoidal azimuth swerve on top of the steady sweep.
function sweepDirections(n, fps, {azRateDegPerS = 0.5, elDeg = 10,
    maneuverAmpDeg = 0, maneuverHz = 0} = {}) {
    const out = new Float64Array(n * 3);
    for (let f = 0; f < n; f++) {
        const t = f / fps;
        const az = (azRateDegPerS * t
            + maneuverAmpDeg * Math.sin(2 * Math.PI * maneuverHz * t)) * DEG;
        const el = elDeg * DEG;
        const c = Math.cos(el);
        out[f * 3] = Math.sin(az) * c;
        out[f * 3 + 1] = Math.cos(az) * c;
        out[f * 3 + 2] = Math.sin(el);
    }
    return out;
}

// Rotate a clean direction by a (pan, tilt) tangent-plane offset in degrees.
// Mirrors observation.js applyOffset, which is not exported; the correlated
// case needs its own offset series, and going through the same rotation is what
// keeps the recovered sigma comparable with the generator's.
function applyOffset(out, b, dx, dy, dz, panDeg, tiltDeg) {
    const alpha = Math.hypot(panDeg, tiltDeg) * DEG;
    if (alpha < 1e-12) { out[b] = dx; out[b + 1] = dy; out[b + 2] = dz; return; }
    let t1x = -dy, t1y = dx, t1z = 0;
    let L = Math.hypot(t1x, t1y, t1z);
    if (L < 1e-6) { t1x = 1; t1y = 0; t1z = 0; L = 1; }
    t1x /= L; t1y /= L; t1z /= L;
    const t2x = dy * t1z - dz * t1y;
    const t2y = dz * t1x - dx * t1z;
    const t2z = dx * t1y - dy * t1x;
    const inv = 1 / Math.hypot(panDeg, tiltDeg);
    const ux = (t1x * panDeg + t2x * tiltDeg) * inv;
    const uy = (t1y * panDeg + t2y * tiltDeg) * inv;
    const uz = (t1z * panDeg + t2z * tiltDeg) * inv;
    const c = Math.cos(alpha), s = Math.sin(alpha);
    out[b] = dx * c + ux * s;
    out[b + 1] = dy * c + uy * s;
    out[b + 2] = dz * c + uz * s;
}

const N = 601;          // 20 s at 30 fps
const FPS = 30;
const SIGMA = 0.05;     // degrees, per tangent axis
const SEED = 4242;

// fovFullDeg 180 keeps every frame active: FOV masking is a separate concern
// and would truncate exactly the tails a robust scale estimate lives on.
const whiteSeries = (clean, sigmaDeg = SIGMA, seed = SEED) => generateObservation(
    {kind: "white", fovFullDeg: 180, gaussianSigmaDeg: sigmaDeg},
    clean, clean.length / 3, FPS, seed);

describe("bearing-noise self-check", () => {
    test("the whiteness null is the detrend's own, not zero", () => {
        // A 7-sample quadratic Savitzky-Golay smoother has weights
        // [-2, 3, 6, 7, 6, 3, -2]/21, so its residual maker is
        // [2, -3, -6, 14, -6, -3, 2]/21 and the residual series it produces
        // from WHITE input has lag-1 autocorrelation -144/294 = -0.4898.
        // Testing against zero would call every clean series correlated, so
        // this is the number the verdict actually leans on.
        const c = canonicalResidualFilter(7);
        const expected = [2, -3, -6, 14, -6, -3, 2].map((v) => v / 21);
        for (let i = 0; i < 7; i++) expect(c[i]).toBeCloseTo(expected[i], 12);

        const r = noiseSelfCheck(whiteSeries(sweepDirections(N, FPS)).observedDirectionENU,
            {fps: FPS});
        expect(r.lag1WhiteNullExpected).toBeCloseTo(-144 / 294, 12);
        // The realized series sits on that null (-0.521 here), not on zero.
        expect(Math.abs(r.lag1Autocorr - r.lag1WhiteNullExpected)).toBeLessThan(0.05);
        expect(Math.abs(r.lag1Z)).toBeLessThan(3);
        expect(r.whiteness).toBe("white-consistent");
    });

    test("recovers a known white sigma to within 10%", () => {
        const obs = whiteSeries(sweepDirections(N, FPS));
        const r = noiseSelfCheck(obs.observedDirectionENU, {
            fps: FPS, declaredSigmaDeg: SIGMA, declaredKind: "white",
        });

        expect(r.ok).toBe(true);
        // Tolerance rationale: a MAD scale estimate has 37% asymptotic
        // efficiency, so its relative standard error is about 1.17/sqrt(m) over
        // m = ~590 residuals per axis, i.e. ~3.3% after the two axes combine.
        // Measured over 40 noise seeds: mean ratio 1.001, sd 0.033, extremes
        // 0.923 and 1.078. 10% is therefore about 3 SE. This seed gives 0.958.
        expect(r.sigmaEmpiricalDeg).toBeGreaterThan(SIGMA * 0.90);
        expect(r.sigmaEmpiricalDeg).toBeLessThan(SIGMA * 1.10);
        // Isotropic input, so neither axis should be carrying the estimate.
        expect(r.sigmaAxisDeg[0] / r.sigmaAxisDeg[1]).toBeGreaterThan(0.85);
        expect(r.sigmaAxisDeg[0] / r.sigmaAxisDeg[1]).toBeLessThan(1.18);

        // Both conventions have to be right, because confusing them IS a
        // sqrt(2) misdeclaration: per-axis matches gaussianSigmaDeg, radial
        // matches the generator's own realized all-frames RMS (to 0.7% here).
        expect(r.sigmaBasis).toBe("per-tangent-axis");
        const radialRatio = r.sigmaEmpiricalRadialDeg / obs.realizedRmsDegAllFrames;
        expect(radialRatio).toBeGreaterThan(0.95);
        expect(radialRatio).toBeLessThan(1.05);

        expect(r.ratioToDeclared).toBeGreaterThan(DEFAULT_RATIO_BAND[0]);
        expect(r.ratioToDeclared).toBeLessThan(DEFAULT_RATIO_BAND[1]);
        expect(r.ratioFlag).toBe("in-band");
        expect(r.mismatch).toBe(false);
        // The curvature diagnostic is calibrated so that pure white noise
        // through a steadily sweeping LOS reads 1.0; measured 1.01.
        expect(r.curvatureExcess).toBeGreaterThan(0.7);
        expect(r.curvatureExcess).toBeLessThan(1.4);
        expect(r.trustworthy).toBe(true);
        expect(r.trustReasons).toEqual([]);
        expect(r.caution).toMatch(/understates|lower bound/i);
    });

    test("a misdeclared sigma leaves the band, and the band is a parameter", () => {
        const obs = whiteSeries(sweepDirections(N, FPS));

        // Declared 0.02 against a realized 0.05: a 2.4x sigma error, so a 6x
        // variance error in every CRLB quantity downstream.
        const under = noiseSelfCheck(obs.observedDirectionENU, {
            fps: FPS, declaredSigmaDeg: 0.02, declaredKind: "white",
        });
        expect(under.ratioFlag).toBe("empirical-above-band");
        expect(under.ratioMismatch).toBe(true);
        expect(under.mismatch).toBe(true);
        // The estimate itself is still sound; only the declaration is wrong.
        expect(under.trustworthy).toBe(true);

        // The same series declared in the radial convention is in band against
        // the generator's realized RMS, which is why the basis is stated rather
        // than guessed.
        const radial = noiseSelfCheck(obs.observedDirectionENU, {
            fps: FPS, declaredSigmaDeg: obs.realizedRmsDegAllFrames,
            declaredBasis: "radial", declaredKind: "white",
        });
        expect(radial.ratioFlag).toBe("in-band");
        // ... and reading that same radial number as a per-axis sigma is the
        // sqrt(2) misdeclaration itself, caught only because the band is
        // tighter than sqrt(2).
        const confused = noiseSelfCheck(obs.observedDirectionENU, {
            fps: FPS, declaredSigmaDeg: obs.realizedRmsDegAllFrames,
            declaredKind: "white", ratioBand: [1 / 1.3, 1.3],
        });
        expect(confused.ratioFlag).toBe("empirical-below-band");

        // A band tighter than the estimator's own sampling error will flag a
        // correct declaration. That stays the caller's choice, which is why it
        // is a parameter and why the default is far outside 3 SE.
        const tight = noiseSelfCheck(obs.observedDirectionENU, {
            fps: FPS, declaredSigmaDeg: SIGMA, ratioBand: [0.995, 1.005],
        });
        expect(tight.ratioMismatch).toBe(true);
    });

    test("a correlated series declared white is flagged non-white", () => {
        // AR(1) pointing error at phi = 0.9 (lag-1 0.9 at the frame rate),
        // scaled so its MARGINAL spread is the same SIGMA the white case uses:
        // the mismatch has to come from the correlation, not from the level.
        const phi = 0.9;
        const clean = sweepDirections(N, FPS);
        const observed = new Float64Array(N * 3);
        const stream = makeStream(97531);
        const drive = Math.sqrt(1 - phi * phi) * SIGMA;
        let ePan = SIGMA * stream.gaussian(), eTilt = SIGMA * stream.gaussian();
        for (let f = 0; f < N; f++) {
            const b = f * 3;
            applyOffset(observed, b, clean[b], clean[b + 1], clean[b + 2], ePan, eTilt);
            ePan = phi * ePan + drive * stream.gaussian();
            eTilt = phi * eTilt + drive * stream.gaussian();
        }

        const r = noiseSelfCheck(observed, {
            fps: FPS, declaredSigmaDeg: SIGMA, declaredKind: "white",
        });
        expect(r.ok).toBe(true);
        // Measured lag-1 -0.359 against the detrend null -0.490: nowhere near
        // the raw 0.9 of the input, because the detrend removes most of the
        // correlated power, but 8.2 null standard errors away all the same.
        // That is the whole reason the null is computed rather than assumed.
        expect(r.whiteness).toBe("correlated");
        expect(r.lag1Autocorr).toBeGreaterThan(r.lag1WhiteNullExpected);
        expect(r.lag1Z).toBeGreaterThan(3);
        expect(r.whitenessMismatch).toBe(true);
        expect(r.trustworthy).toBe(false);
        expect(r.trustReasons.join(" ")).toMatch(/correlated/);

        // The quieter half of the same failure: the detrend eats the
        // low-frequency part of a correlated error, so the per-frame sigma
        // lands at 0.0143 deg, 29% of the spread that actually perturbs the
        // bearings. Correlated error misdeclared as white is understated twice
        // over, and BOTH flags fire on it.
        expect(r.sigmaEmpiricalDeg).toBeLessThan(SIGMA * 0.5);
        expect(r.ratioFlag).toBe("empirical-below-band");
        expect(r.mismatch).toBe(true);
        expect(r.windowScaleRatio).toBeGreaterThan(1.1);
    });

    test("a violent maneuver understates the noise, as documented", () => {
        // 3 degrees of azimuth swerve at 1 Hz: 19 deg/s of angular rate and
        // 118 deg/s^2 of angular acceleration, over the same 0.05 deg white
        // jitter as the calm case.
        const obs = whiteSeries(sweepDirections(N, FPS, {maneuverAmpDeg: 3, maneuverHz: 1}));

        const short = noiseSelfCheck(obs.observedDirectionENU, {
            fps: FPS, declaredSigmaDeg: SIGMA, declaredKind: "white",
        });
        // A 7-sample window is 0.2 s and a 1 Hz swerve is very nearly a
        // quadratic over 0.2 s, so the detrend removes the maneuver whole. Note
        // what that means for the declaration checks: sigma comes out at 0.048
        // (ratio 0.961, IN BAND) and the residuals are white-consistent. Every
        // published check passes while the number describes only the sensor.
        expect(short.sigmaEmpiricalDeg).toBeGreaterThan(SIGMA * 0.90);
        expect(short.sigmaEmpiricalDeg).toBeLessThan(SIGMA * 1.10);
        expect(short.ratioFlag).toBe("in-band");
        expect(short.whiteness).toBe("white-consistent");

        // Only the curvature diagnostic sees it, and it says so in the object
        // rather than leaving it to the prose caveat.
        expect(short.curvatureExcess).toBeGreaterThan(3);       // measured 7.2
        expect(short.trustworthy).toBe(false);
        expect(short.trustReasons.join(" ")).toMatch(/angular acceleration/);
        expect(short.trustReasons.join(" ")).toMatch(/LOWER BOUND/);

        // The demonstration. The SAME estimator over a 61-sample (2 s) window,
        // which the swerve outruns, reports 2.78 deg — 58x the short window's
        // answer. There is no scale-free "noise" on this series, and the short
        // window's number is the smallest member of the family, not the truth.
        const long = noiseSelfCheck(obs.observedDirectionENU, {
            fps: FPS, windowSamples: 61, wideWindowSamples: 121,
            declaredSigmaDeg: SIGMA, declaredKind: "white",
        });
        expect(long.sigmaEmpiricalDeg / short.sigmaEmpiricalDeg).toBeGreaterThan(20);
        expect(long.trustworthy).toBe(false);
        // And the split across the two tangent axes shows what it is made of:
        // 3.93 deg on the swerving axis, 0.048 deg — the true jitter — on the
        // quiet one. This is why the two axes get separate scale estimates.
        expect(long.sigmaAxisDeg[0] / long.sigmaAxisDeg[1]).toBeGreaterThan(20);
        expect(long.sigmaAxisDeg[1]).toBeGreaterThan(SIGMA * 0.90);
        expect(long.sigmaAxisDeg[1]).toBeLessThan(SIGMA * 1.10);

        // The control: the same window pair on a series with no maneuver agrees
        // to 1%, so the spread above is the target's motion and not an artifact
        // of the window length.
        const calmObs = whiteSeries(sweepDirections(N, FPS));
        const calmShort = noiseSelfCheck(calmObs.observedDirectionENU, {fps: FPS});
        const calmLong = noiseSelfCheck(calmObs.observedDirectionENU,
            {fps: FPS, windowSamples: 61, wideWindowSamples: 121});
        expect(calmLong.sigmaEmpiricalDeg / calmShort.sigmaEmpiricalDeg)
            .toBeGreaterThan(0.9);
        expect(calmLong.sigmaEmpiricalDeg / calmShort.sigmaEmpiricalDeg)
            .toBeLessThan(1.1);
        expect(calmLong.trustworthy).toBe(true);
    });

    test("degenerate input returns a reason instead of a number", () => {
        const r = noiseSelfCheck(sweepDirections(8, FPS), {fps: FPS});
        expect(r.ok).toBe(false);
        expect(r.sigmaEmpiricalDeg).toBeNull();
        expect(r.trustworthy).toBe(false);
        expect(r.reason).toMatch(/active frames/);

        // A perfectly clean series has no scale to estimate, and reporting the
        // surviving floating-point dust would sail through any ratio band from
        // below instead of announcing that the check could not be made.
        const c = noiseSelfCheck(sweepDirections(N, FPS), {fps: FPS, declaredSigmaDeg: SIGMA});
        expect(c.ok).toBe(false);
        expect(c.reason).toMatch(/zero/);
        expect(c.mismatch).toBe(false);
    });
});
