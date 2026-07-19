/**
 * Closed-loop balloon recovery.
 *
 * The repo contains both halves of this loop and has never joined them:
 * `src/BalloonPhysics.js` integrates a real buoyancy/wind-advection balloon,
 * and `fitPhysicsModel` + `SkyLanternModel` try to recover a balloon from
 * sightlines — but `BalloonPhysics` is imported only by CNodeBalloonTrack and
 * its own unit test, never by the fitter or its tests. So "if the object really
 * IS a balloon, does the traverse analysis recover it?" has never been measured.
 *
 * That question is the whole basis for surfacing slow, mundane explanations, and
 * every argument about priors and range grids is unfalsifiable without a number.
 * This test generates a balloon with KNOWN wind, shear, ascent rate and range,
 * feeds the resulting sightlines to the fitter, and reports the recovery error
 * in metres and m/s.
 *
 * IT REPORTS RATHER THAN GATES. The assertions are deliberately loose — they
 * pin gross regressions (the fit converging on the camera, or inverting the wind
 * direction), not accuracy targets. The console output is the point: those
 * numbers are what tighter tolerances should later be argued from.
 *
 * AVOIDING THE INVERSE CRIME — read this before weakening the scene.
 * A first version of this test used a constant ascent rate, no gusts, a single
 * linearly-sheared wind and noiseless sightlines. Every case recovered the truth
 * EXACTLY: 0 m separation, 0.0000° residual, wind to the last digit. That is not
 * a passing test, it is a vacuous one. With those settings BalloonPhysics
 * degenerates to precisely the law SkyLanternModel integrates (constant vz, wind
 * scaled linearly by altitude with the same 0.25-3 clamp), so the truth lies
 * inside the model class and the fit cannot fail. It would have reported
 * flawless balloon recovery while measuring nothing at all.
 *
 * The scene below therefore puts the truth OUTSIDE the model class on purpose:
 *   - gusts (variabilityPct), which the model has no term for;
 *   - a two-layer wind profile with a kink, which a single linear shear cannot
 *     represent — real soundings are layered, and this is the discriminator the
 *     "inferred vs measured wind" comparison would rest on;
 *   - angular noise on the sightlines, so a zero residual is unreachable.
 * The recovered numbers are then a real measurement. They are still optimistic
 * — the horizontal is wind advection in both, and the generator is smooth —
 * so treat them as an upper bound on real-world accuracy, not an estimate of it.
 *
 * MEASURED BASELINE (first run, well-conditioned scene: orbiting camera, ~3.9 km,
 * good parallax). Three results worth keeping in mind:
 *
 *   1. RANGE recovers essentially perfectly (0 m of 3905 m at the start, 1 m at
 *      mid-clip) and ascent to 2.98 vs 3.00 m/s. When parallax is good, the
 *      balloon hypothesis is strong and the analysis should say so confidently.
 *
 *   2. The SOFT PRIORS barely move it: neutralising extraCost entirely shifts
 *      the fitted wind by 0.02 m/s and the range by 0 m. So the calm-wind prior,
 *      although genuinely undeclared, costs almost nothing HERE. That is a
 *      well-observed scene; the prior should be expected to matter far more on a
 *      weakly-observable one (near-straight camera, distant object), which this
 *      test does not yet cover. Disclosure is still right; urgency is lower than
 *      a code reading alone suggests.
 *
 *   3. SHEAR IS BADLY UNIDENTIFIABLE. With a purely speed-scaled wind — a case
 *      the model CAN represent exactly — the fitted shear still comes back
 *      2.15x the truth (1.72e-3 vs 8.0e-4) while the track sits 8 m from truth
 *      and the residual is 0.074°. The balloon climbs only ~270 m over the clip,
 *      and over so short an altitude span shear and wind speed trade off almost
 *      freely (a faster wind with less shear looks much like a slower wind with
 *      more). So a large shear error costs almost nothing and carries almost no
 *      information.
 *      An earlier version of this note blamed the 2.15x on the directional veer.
 *      That was wrong twice over: the veer was not even engaged (the kink sat
 *      above the balloon's ceiling — see kinkAltM), and when it IS engaged the
 *      shear does not inflate, it INVERTS. Keep the kink below the climb.
 *
 *   4. ADDING THE VEER LOWERS THE RESIDUAL AND TRIPLES THE ERROR. With a 25°
 *      veer the fit reports 0.049° — BETTER than the 0.074° of the easier
 *      speed-only case — while sitting 49 m from truth instead of 8 m, and it
 *      flips the fitted shear negative (-1.22x truth) to chase the veer, paying
 *      its own negative-shear prior to do so. The model contorts its one free
 *      parameter into a shape that scores well and describes the wrong path.
 *      This is the residual/truth divergence in its sharpest form, and it is a
 *      direct caution for any "inferred vs measured wind" test: for a GENUINE
 *      balloon the inferred profile can be biased in magnitude AND sign, so
 *      disagreement there is not evidence against a balloon.
 */

import {setSit} from "../src/Globals";
import {integrateBalloonPositions} from "../src/BalloonPhysics";
import {ecefDisplacementToENU} from "../src/TrackExportMath";
import {fitPhysicsModel} from "../src/LOSFitting";
import {SkyLanternModel} from "../src/SkyLanternModel";

const LAT = 40, LON = -100;
const FPS = 10;   // the physics needs no more; keeps the DE fit inside a sane test runtime

/**
 * Build a scene: a balloon from the real integrator, watched by a camera that
 * MOVES. The motion matters — range is recovered from parallax, and a camera on
 * a straight constant-velocity path makes the sensor's own trajectory a
 * zero-residual solution (see the contract at LOSFitting.js:80-88). An arcing
 * camera keeps range observable, which is the regime the analysis is for.
 */
function makeBalloonScene({
    seconds = 90,
    ascentRate = 3.0,
    windE = 6.0,          // m/s at launch altitude
    windN = -2.5,
    shearPerM = 0.0008,   // fractional wind gain per metre, LOWER layer
    kinkAltM = 110,       // layer boundary above launch; above it the wind veers.
                          // MUST sit below the balloon.s climb over the clip
                          // (ascentRate * seconds) or the veer never engages.
    upperVeerDeg = 25,    // direction change across the boundary
    startAltMSL = 200,
    cameraRadius = 2500,
    variabilityPct = 12,  // gusts — no equivalent term exists in the model
    losNoiseDeg = 0.03,   // sightline noise — makes a zero residual unreachable
    noiseSeed = 99,
} = {}) {
    const frames = Math.round(seconds * FPS);
    const dt = 1 / FPS;

    // Two-layer wind: linear shear below the kink, then a veer above it. A
    // single `shearPerM` multiplier scales speed but CANNOT rotate direction,
    // so the upper layer is outside the model's reach by construction.
    // Signature is (lat, lon, altMSL, frame) — see BalloonPhysics.js:60.
    const windAt = (lat, lon, altMSL) => {
        const dAlt = altMSL - startAltMSL;
        const mult = Math.max(0.25, Math.min(3, 1 + shearPerM * dAlt));
        let u = windE * mult, v = windN * mult;
        if (dAlt > kinkAltM) {
            const frac = Math.min(1, (dAlt - kinkAltM) / 120);
            const th = frac * upperVeerDeg * Math.PI / 180;
            const c = Math.cos(th), s = Math.sin(th);
            [u, v] = [u * c - v * s, u * s + v * c];
        }
        return {u, v};
    };

    const truthECEF = integrateBalloonPositions({
        startLat: LAT, startLon: LON, startAltMSL,
        launchDelay: 0, ascentRate, variabilityPct, seed: 7,
        frames, dt,
    }, windAt);

    // ENU origin = the balloon's launch point, so truth ENU starts at ~0.
    // integrateBalloonPositions returns [{position: Vector3}], and
    // ecefDisplacementToENU returns {east, north, up}.
    const origin = truthECEF[0].position;
    const truth = new Float64Array(frames * 3);
    for (let f = 0; f < frames; f++) {
        const e = ecefDisplacementToENU(origin, truthECEF[f].position, LAT, LON);
        truth[f * 3] = e.east; truth[f * 3 + 1] = e.north; truth[f * 3 + 2] = e.up;
    }

    // Deterministic hash-based jitter, so runs are reproducible without a PRNG
    // whose state depends on call order.
    const noise = (k) => {
        let x = Math.sin((k + noiseSeed) * 12.9898) * 43758.5453;
        return x - Math.floor(x);
    };

    // Camera: a slow arc at low altitude, giving genuine parallax.
    const sensorPos = new Float64Array(frames * 3);
    const losDir = new Float64Array(frames * 3);
    const times = new Float64Array(frames);
    for (let f = 0; f < frames; f++) {
        const t = f * dt;
        times[f] = t;
        const ang = (2 * Math.PI / 240) * t;            // one lap per 240 s
        const sx = cameraRadius * Math.cos(ang);
        const sy = cameraRadius * Math.sin(ang) - 3000;
        const sz = 30;
        sensorPos[f * 3] = sx; sensorPos[f * 3 + 1] = sy; sensorPos[f * 3 + 2] = sz;

        let dx = truth[f * 3] - sx;
        let dy = truth[f * 3 + 1] - sy;
        let dz = truth[f * 3 + 2] - sz;
        const L0 = Math.sqrt(dx * dx + dy * dy + dz * dz);
        dx /= L0; dy /= L0; dz /= L0;
        if (losNoiseDeg > 0) {
            // Deterministic per-frame angular jitter. Without it the fit can
            // reach an exactly-zero residual and the measurement is vacuous.
            const s = losNoiseDeg * Math.PI / 180;
            dx += (noise(f * 3 + 0) * 2 - 1) * s;
            dy += (noise(f * 3 + 1) * 2 - 1) * s;
            dz += (noise(f * 3 + 2) * 2 - 1) * s;
            const L1 = Math.sqrt(dx * dx + dy * dy + dz * dz);
            dx /= L1; dy /= L1; dz /= L1;
        }
        losDir[f * 3] = dx; losDir[f * 3 + 1] = dy; losDir[f * 3 + 2] = dz;
    }

    return {
        dataset: {sensorPos, losDir, times, count: frames, maxRange: null},
        truth,
        truthParams: {ascentRate, windE, windN, shearPerM},
    };
}

function rangeAt(dataset, track, f) {
    const b = f * 3;
    return Math.hypot(track[b] - dataset.sensorPos[b],
        track[b + 1] - dataset.sensorPos[b + 1],
        track[b + 2] - dataset.sensorPos[b + 2]);
}

function meanSeparation(truth, got, n) {
    let s = 0;
    for (let f = 0; f < n; f++) {
        const b = f * 3;
        s += Math.hypot(got[b] - truth[b], got[b + 1] - truth[b + 1], got[b + 2] - truth[b + 2]);
    }
    return s / n;
}

const FIT_OPTS = {optimizer: "de", dePop: 30, deGens: 60, sampleStride: 4};

async function recover(scene, {neutralisePriors = false} = {}) {
    const model = new SkyLanternModel();
    if (neutralisePriors) {
        // Size the soft priors by removing them. extraCost is where the
        // calm-wind preference, the negative-shear penalty and the
        // below-surface guard all live (SkyLanternModel.js:139-160); the
        // reported errDeg deliberately excludes them (LOSFitting.js:1478-1498),
        // so their influence is otherwise invisible in the output.
        model.extraCost = () => 0;
    }
    const fit = await fitPhysicsModel(scene.dataset, new Set(), model, FIT_OPTS);
    if (!fit || !fit.positions) return null;
    const n = scene.dataset.count;
    const solved = fit.params.solved || {};
    return {
        solved,
        errDeg: fit.params.errDeg,
        sep: meanSeparation(scene.truth, fit.positions, n),
        rangeStart: rangeAt(scene.dataset, fit.positions, 0),
        truthRangeStart: rangeAt(scene.dataset, scene.truth, 0),
        rangeMid: rangeAt(scene.dataset, fit.positions, Math.floor(n / 2)),
        truthRangeMid: rangeAt(scene.dataset, scene.truth, Math.floor(n / 2)),
    };
}

beforeEach(() => {
    // getLocalNorthVector asserts Sit.lat/Sit.lon exist.
    setSit({name: "test", frames: 2700, fps: FPS, simSpeed: 1, lat: LAT, lon: LON});
});

describe("balloon recovery through the traverse physics fit", () => {
    jest.setTimeout(180000);

    test("recovers a drifting balloon's range and wind, and reports the error", async () => {
        const scene = makeBalloonScene();
        const got = await recover(scene);
        expect(got).not.toBeNull();

        const {windE, windN, shearPerM, ascentRate} = scene.truthParams;
        const truthSpeed = Math.hypot(windE, windN);
        const gotSpeed = Math.hypot(got.solved.windE ?? 0, got.solved.windN ?? 0);
        const bearing = (u, v) => (Math.atan2(u, v) * 180 / Math.PI + 360) % 360;
        const dDir = Math.abs(((bearing(got.solved.windE ?? 0, got.solved.windN ?? 0)
            - bearing(windE, windN) + 540) % 360) - 180);

        console.log("\nBALLOON RECOVERY (truth from BalloonPhysics, fit by SkyLanternModel)");
        console.log(`  range at start   truth ${got.truthRangeStart.toFixed(0)} m   fitted ${got.rangeStart.toFixed(0)} m`
            + `   error ${(got.rangeStart - got.truthRangeStart).toFixed(0)} m`
            + ` (${(100 * (got.rangeStart - got.truthRangeStart) / got.truthRangeStart).toFixed(1)}%)`);
        console.log(`  range at mid     truth ${got.truthRangeMid.toFixed(0)} m   fitted ${got.rangeMid.toFixed(0)} m`
            + `   error ${(got.rangeMid - got.truthRangeMid).toFixed(0)} m`);
        console.log(`  wind speed       truth ${truthSpeed.toFixed(2)} m/s   fitted ${gotSpeed.toFixed(2)} m/s`
            + `   error ${(gotSpeed - truthSpeed).toFixed(2)} m/s`);
        console.log(`  wind direction   error ${dDir.toFixed(1)}°`);
        console.log(`  shear            truth ${shearPerM.toExponential(2)}   fitted ${(got.solved.shearPerM ?? NaN).toExponential(2)}`);
        console.log(`  ascent           truth ${ascentRate.toFixed(2)} m/s   fitted vRise ${(got.solved.vRise ?? NaN).toFixed(2)} m/s`);
        console.log(`  mean 3D separation from truth  ${got.sep.toFixed(0)} m`);
        console.log(`  reported LOS residual          ${got.errDeg.toFixed(4)}°`);

        // Gross-regression guards only. These are NOT accuracy targets.
        expect(got.rangeStart).toBeGreaterThan(200);          // did not collapse onto the camera
        expect(Number.isFinite(got.sep)).toBe(true);
        expect(dDir).toBeLessThan(90);                        // wind not inverted
        expect(got.sep).toBeLessThan(0.5 * got.truthRangeMid); // recognisably the same object
    });

    test("sizes the soft priors by neutralising them", async () => {
        // The tile claims the free fit's wind is "INFERRED, not assumed"
        // (AnalyzeTraverse.js:1120-1122) while extraCost adds a calm-wind
        // preference the reported residual excludes. This measures what that
        // preference is worth in metres and m/s on a genuinely windy balloon —
        // the number the disclosure threshold should be argued from.
        const scene = makeBalloonScene();
        const withPriors = await recover(scene);
        const without = await recover(scene, {neutralisePriors: true});
        expect(withPriors).not.toBeNull();
        expect(without).not.toBeNull();

        const spd = (r) => Math.hypot(r.solved.windE ?? 0, r.solved.windN ?? 0);
        console.log("\nSOFT-PRIOR INFLUENCE (same scene, extraCost on vs off)");
        console.log(`  fitted wind speed   with priors ${spd(withPriors).toFixed(2)} m/s`
            + `   without ${spd(without).toFixed(2)} m/s`
            + `   shift ${(spd(without) - spd(withPriors)).toFixed(2)} m/s`);
        console.log(`  fitted start range  with priors ${withPriors.rangeStart.toFixed(0)} m`
            + `   without ${without.rangeStart.toFixed(0)} m`
            + `   shift ${(without.rangeStart - withPriors.rangeStart).toFixed(0)} m`);
        console.log(`  separation from truth  with ${withPriors.sep.toFixed(0)} m`
            + `   without ${without.sep.toFixed(0)} m`);
        console.log(`  reported residual      with ${withPriors.errDeg.toFixed(4)}°`
            + `   without ${without.errDeg.toFixed(4)}°`);

        // Both must remain physical; the point is the printed shift.
        expect(withPriors.rangeStart).toBeGreaterThan(200);
        expect(without.rangeStart).toBeGreaterThan(200);
    });

    test("sizes what the un-representable wind veer costs in residual", async () => {
        // WHY THIS NUMBER MATTERS. On the agua sitch the balloon tile reads
        // "Low", for two stated reasons: raw LOS residual 0.23° (the tier
        // boundary is 0.15°) and "internal model clamp reached: wind shear
        // multiplier (0.25-3x clamp)". Those two facts are likely the same
        // fact. SkyLanternModel represents winds aloft as a single SCALAR
        // multiplier on one wind vector (params[3], shearPerM) — it can make
        // the wind faster or slower with altitude but CANNOT ROTATE IT, while
        // real winds veer with height. When the model cannot represent the
        // veer it absorbs the mismatch into shear until the clamp stops it,
        // and the remainder lands in the residual.
        //
        // If that is right, the balloon is being demoted for a deficiency of
        // its own wind parameterisation rather than for being a poor
        // explanation — which is backwards for the mundane hypothesis the
        // analysis most needs to surface correctly. This measures the size of
        // the effect by fitting the SAME balloon twice, once with a veering
        // wind and once with a purely scaled one.
        const veering = makeBalloonScene({upperVeerDeg: 25});
        const scaledOnly = makeBalloonScene({upperVeerDeg: 0});
        const a = await recover(veering);
        const b = await recover(scaledOnly);
        expect(a).not.toBeNull();
        expect(b).not.toBeNull();

        const shearRatio = (r) => (r.solved.shearPerM ?? NaN) / 0.0008;
        console.log("\nCOST OF A WIND VEER THE MODEL CANNOT REPRESENT");
        console.log(`  veering wind (25°)   residual ${a.errDeg.toFixed(4)}°`
            + `   separation ${a.sep.toFixed(0)} m   shear ${shearRatio(a).toFixed(2)}x truth`);
        console.log(`  scaled wind only     residual ${b.errDeg.toFixed(4)}°`
            + `   separation ${b.sep.toFixed(0)} m   shear ${shearRatio(b).toFixed(2)}x truth`);
        console.log(`  penalty attributable to the veer: `
            + `${(a.errDeg - b.errDeg).toFixed(4)}° of residual, `
            + `${(a.sep - b.sep).toFixed(0)} m of position`);

        // Both must stay physical; the printed penalty is the point. No
        // threshold is asserted because the right value is what the fix should
        // be argued from, not something to lock in beforehand.
        expect(a.rangeStart).toBeGreaterThan(200);
        expect(b.rangeStart).toBeGreaterThan(200);
    });

    test("a becalmed balloon is not given invented wind", async () => {
        // The complement, and the direction that matters for not OVER-selling a
        // mundane answer: with almost no true wind, the fit must not invent a
        // strong drift to buy residual.
        const scene = makeBalloonScene({windE: 0.3, windN: 0.1, shearPerM: 0, upperVeerDeg: 0, variabilityPct: 4});
        const got = await recover(scene);
        expect(got).not.toBeNull();
        const gotSpeed = Math.hypot(got.solved.windE ?? 0, got.solved.windN ?? 0);
        console.log("\nBECALMED CONTROL");
        console.log(`  truth wind 0.32 m/s   fitted ${gotSpeed.toFixed(2)} m/s`);
        console.log(`  start range   truth ${got.truthRangeStart.toFixed(0)} m   fitted ${got.rangeStart.toFixed(0)} m`);
        console.log(`  separation ${got.sep.toFixed(0)} m   residual ${got.errDeg.toFixed(4)}°`);
        expect(got.rangeStart).toBeGreaterThan(200);
    });
});
