/**
 * Closed-loop recovery for the Wind Tracer fit, against OPERATOR-LIKE pointing
 * error.
 *
 * `tests/TraverseBalloonRecovery.test.js` already measures whether a real
 * balloon is recovered from clean sightlines. It answers a different question
 * from this one, and it shares this file's scene generator by copy rather than
 * by import because the two want different sensor models (this one needs the
 * camera's image-plane basis, which buildLOSDataset supplies for live nodes but
 * a synthetic dataset must build for itself).
 *
 * THE QUESTION HERE. Sitrec's sightlines often come from a camera BORESIGHT —
 * where a human operator was pointing — not from a measurement of the object's
 * direction. The object wanders inside the frame, so the sightline carries an
 * unknown pointing error that is smooth and strongly autocorrelated: the
 * operator drifts off, notices, and re-centres over tens of seconds. Every fit
 * in `LOSFitting.js` treats that error as if it were the object moving, and BOT
 * Bench has already measured autocorrelated pointing error hurting the CV
 * family ~4.7x more than white noise of the same power.
 *
 * `src/WindTracerFit.js` models it explicitly, with a nuisance basis that is
 * band-limited ABOVE the azimuth-sweep frequency so it cannot absorb the
 * trajectory. This test measures whether that actually buys anything, by
 * generating a balloon with KNOWN truth and watching it through three sensors:
 * clean, white-noise, and operator-wobble sightlines of matched RMS.
 *
 * IT REPORTS RATHER THAN GATES, like its sibling. The assertions pin gross
 * regressions — a collapse onto the camera, an inverted wind — not accuracy
 * targets. The console table is the point.
 *
 * AVOIDING THE INVERSE CRIME. As in the balloon test, the truth is deliberately
 * outside the model class: gusts, and a two-layer wind whose upper layer VEERS,
 * which no single speed-scaling shear can represent. The Wind Tracer's vertical
 * law (buoyancy versus drag) is also not the generator's constant ascent rate,
 * so the vertical is mismatched too. A zero residual is unreachable by
 * construction.
 */

import {setSit} from "../src/Globals";
import {FLAT_GEOID, integrateBalloonPositions} from "../src/BalloonPhysics";
import {ecefDisplacementToENU} from "../src/TrackExportMath";
import {fitWindTracer, azimuthSweepCycles} from "../src/WindTracerFit";

const LAT = 40, LON = -100;
const FPS = 10;
const DEG = 180 / Math.PI;

/**
 * A balloon from the real integrator, watched by an arcing camera. Parallax
 * matters: a straight constant-velocity camera makes its own path a
 * zero-residual solution, which is the degenerate regime, not this one.
 *
 * `pointing` selects the sensor error model:
 *   "none"     exact sightlines to the object
 *   "white"    independent per-frame angular jitter
 *   "operator" a smooth, autocorrelated wander in IMAGE coordinates — the
 *              object drifting around inside the frame and being re-centred
 */
function makeScene({
    seconds = 120,
    ascentRate = -0.6,        // a DESCENDING tracer, the case this fit is for
    windE = 6.0,
    windN = -2.5,
    shearPerM = 0.0008,
    kinkAltM = 40,
    upperVeerDeg = 20,
    startAltMSL = 320,
    cameraRadius = 2500,
    variabilityPct = 12,
    pointing = "none",
    pointingRmsDeg = 0.30,
    pointingTauSec = 18,      // operator drift-and-correct timescale
    noiseSeed = 99,
} = {}) {
    const frames = Math.round(seconds * FPS);
    const dt = 1 / FPS;

    const windAt = (lat, lon, altMSL) => {
        const dAlt = altMSL - startAltMSL;
        const mult = Math.max(0.25, Math.min(3, 1 + shearPerM * dAlt));
        let u = windE * mult, v = windN * mult;
        if (dAlt < -kinkAltM) {              // descending: the kink is BELOW
            const frac = Math.min(1, (-dAlt - kinkAltM) / 120);
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
        geoidOffset: FLAT_GEOID,
    }, windAt);

    const origin = truthECEF[0].position;
    const truth = new Float64Array(frames * 3);
    for (let f = 0; f < frames; f++) {
        const e = ecefDisplacementToENU(origin, truthECEF[f].position, LAT, LON);
        truth[f * 3] = e.east; truth[f * 3 + 1] = e.north; truth[f * 3 + 2] = e.up;
    }

    // Deterministic hash jitter — reproducible without PRNG call-order coupling.
    const hash = (k) => {
        const x = Math.sin((k + noiseSeed) * 12.9898) * 43758.5453;
        return x - Math.floor(x);
    };

    // Operator wander: a first-order Gauss-Markov process in the two image-plane
    // angles, scaled afterwards so its RMS matches `pointingRmsDeg` exactly.
    // Matching the RMS is what makes the white/operator comparison fair — the
    // question is about the COLOR of the noise, not its power.
    const opA = new Float64Array(frames), opB = new Float64Array(frames);
    if (pointing === "operator") {
        const rho = Math.exp(-dt / pointingTauSec);
        const drive = Math.sqrt(1 - rho * rho);
        let a = 0, b = 0;
        for (let f = 0; f < frames; f++) {
            a = rho * a + drive * (hash(f * 2 + 500) * 2 - 1);
            b = rho * b + drive * (hash(f * 2 + 501) * 2 - 1);
            opA[f] = a; opB[f] = b;
        }
        let ss = 0;
        for (let f = 0; f < frames; f++) ss += opA[f] * opA[f] + opB[f] * opB[f];
        const rms = Math.sqrt(ss / frames);       // both axes together
        const k = (pointingRmsDeg / DEG) / (rms || 1);
        for (let f = 0; f < frames; f++) { opA[f] *= k; opB[f] *= k; }
    }

    const sensorPos = new Float64Array(frames * 3);
    const losDir = new Float64Array(frames * 3);
    const camUp = new Float64Array(frames * 3);
    const camRight = new Float64Array(frames * 3);
    const times = new Float64Array(frames);
    let whiteScale = 0;
    if (pointing === "white") {
        // Uniform on [-1,1] per axis has RMS 1/sqrt(3); two axes together give
        // sqrt(2/3). Scale so the total matches pointingRmsDeg.
        whiteScale = (pointingRmsDeg / DEG) / Math.sqrt(2 / 3);
    }

    for (let f = 0; f < frames; f++) {
        const t = f * dt;
        times[f] = t;
        const ang = (2 * Math.PI / 240) * t;      // one lap per 240 s
        const sx = cameraRadius * Math.cos(ang);
        const sy = cameraRadius * Math.sin(ang) - 3000;
        const sz = 30;
        sensorPos[f * 3] = sx; sensorPos[f * 3 + 1] = sy; sensorPos[f * 3 + 2] = sz;

        let dx = truth[f * 3] - sx, dy = truth[f * 3 + 1] - sy, dz = truth[f * 3 + 2] - sz;
        const L0 = Math.hypot(dx, dy, dz);
        dx /= L0; dy /= L0; dz /= L0;

        // Image-plane basis about the TRUE direction: right is horizontal, up
        // completes the triad. No roll is modelled — a rolled camera rotates
        // both axes together, which the fit's basis follows either way.
        let rx = dy, ry = -dx, rz = 0;
        const rn = Math.hypot(rx, ry, rz) || 1;
        rx /= rn; ry /= rn; rz /= rn;
        const ux = ry * dz - rz * dy, uy = rz * dx - rx * dz, uz = rx * dy - ry * dx;

        let a = 0, b = 0;
        if (pointing === "operator") { a = opA[f]; b = opB[f]; }
        else if (pointing === "white") {
            a = (hash(f * 3) * 2 - 1) * whiteScale;
            b = (hash(f * 3 + 1) * 2 - 1) * whiteScale;
        }
        // Small-angle tilt of the boresight away from the object, in the image
        // plane: exactly the geometry of an object sitting off-centre in frame.
        let bx = dx + a * rx + b * ux;
        let by = dy + a * ry + b * uy;
        let bz = dz + a * rz + b * uz;
        const L1 = Math.hypot(bx, by, bz);
        bx /= L1; by /= L1; bz /= L1;

        losDir[f * 3] = bx; losDir[f * 3 + 1] = by; losDir[f * 3 + 2] = bz;
        // The fit's basis is built about the BORESIGHT, as it is in the app.
        let r2x = by, r2y = -bx, r2z = 0;
        const r2n = Math.hypot(r2x, r2y, r2z) || 1;
        r2x /= r2n; r2y /= r2n; r2z /= r2n;
        camRight[f * 3] = r2x; camRight[f * 3 + 1] = r2y; camRight[f * 3 + 2] = r2z;
        camUp[f * 3] = r2y * bz - r2z * by;
        camUp[f * 3 + 1] = r2z * bx - r2x * bz;
        camUp[f * 3 + 2] = r2x * by - r2y * bx;
    }

    return {
        dataset: {sensorPos, losDir, camUp, camRight, times, count: frames, maxRange: null},
        truth,
        truthParams: {ascentRate, windE, windN, shearPerM, startAltMSL},
    };
}

function meanSeparation(truth, got, n) {
    let s = 0;
    for (let f = 0; f < n; f++) {
        const b = f * 3;
        s += Math.hypot(got[b] - truth[b], got[b + 1] - truth[b + 1], got[b + 2] - truth[b + 2]);
    }
    return s / n;
}

function rangeAt(dataset, track, f) {
    const b = f * 3;
    return Math.hypot(track[b] - dataset.sensorPos[b],
        track[b + 1] - dataset.sensorPos[b + 1],
        track[b + 2] - dataset.sensorPos[b + 2]);
}

function summarise(label, scene, res) {
    const {dataset, truth, truthParams} = scene;
    const n = dataset.count;
    const sep = meanSeparation(truth, res.positions, n);
    const p = res.params;
    const truthSpeed = Math.hypot(truthParams.windE, truthParams.windN);
    const truthFrom = (Math.atan2(-truthParams.windE, -truthParams.windN) * DEG + 360) % 360;
    return {
        label,
        sepM: sep,
        windErrMs: p.windSpeed - truthSpeed,
        windErrDeg: ((p.windFrom - truthFrom + 540) % 360) - 180,
        rangeErrM: rangeAt(dataset, res.positions, 0) - rangeAt(dataset, truth, 0),
        residDeg: p.errDeg,
        residRawDeg: p.errRawDeg,
        pointingDeg: p.maxPointingDeg,
        pinned: p.boundPinned.length,
    };
}

describe("Wind Tracer recovery against operator-like pointing error", () => {
    // The whole point of the method is measured here, so run all six cells and
    // print one table. Each fit is a deterministic wind rose plus Nelder-Mead
    // with a closed-form inner solve — fast enough to do six.
    jest.setTimeout(180000);

    // BalloonPhysics needs a Sit for its local ENU basis.
    beforeAll(() => {
        setSit({name: "test", frames: 1200, fps: FPS, simSpeed: 1, lat: LAT, lon: LON});
    });

    test("recovers a descending wind tracer; measures what the operator model buys", () => {
        const rows = [];
        const cases = [
            ["clean sightlines", {pointing: "none"}],
            ["white noise 0.30deg", {pointing: "white", pointingRmsDeg: 0.30}],
            ["operator wobble 0.30deg", {pointing: "operator", pointingRmsDeg: 0.30}],
        ];
        const byKey = {};
        for (const [label, sceneOpts] of cases) {
            const scene = makeScene(sceneOpts);
            for (const withModel of [true, false]) {
                const res = fitWindTracer(scene.dataset, {
                    sigmaPointDeg: 0.4,
                    operatorModel: withModel,
                    searchSamples: 600,
                });
                expect(res).toBeTruthy();
                const row = summarise(`${label}${withModel ? "" : "  [model off]"}`, scene, res);
                rows.push(row);
                byKey[`${label}|${withModel}`] = row;
            }
        }

        const sweep = azimuthSweepCycles(makeScene({pointing: "none"}).dataset);
        console.log(`\nazimuth sweep ${sweep.toFixed(2)} cycles over the clip`
            + ` (the operator basis must stay above this)\n`);
        console.log("sensor / operator model            sep(m)  wind(m/s)  wind(deg)"
            + "  range(m)   resid  rawResid  ptg  pinned");
        for (const r of rows) {
            console.log(
                `${r.label.padEnd(34)}${r.sepM.toFixed(0).padStart(7)}`
                + `${r.windErrMs.toFixed(2).padStart(11)}${r.windErrDeg.toFixed(1).padStart(11)}`
                + `${r.rangeErrM.toFixed(0).padStart(10)}${r.residDeg.toFixed(3).padStart(8)}`
                + `${r.residRawDeg.toFixed(3).padStart(10)}${r.pointingDeg.toFixed(2).padStart(5)}`
                + `${String(r.pinned).padStart(8)}`);
        }

        // --- gates: gross regressions only ---
        for (const r of rows) {
            // never collapse onto the camera, never invert the wind
            expect(r.sepM).toBeLessThan(1500);
            expect(Math.abs(r.windErrDeg)).toBeLessThan(90);
            expect(Number.isFinite(r.residDeg)).toBe(true);
        }
        // Clean sightlines must be recovered well — if this loosens, something
        // structural broke, not just an accuracy drift.
        expect(byKey["clean sightlines|true"].sepM).toBeLessThan(250);

        // THE MEASUREMENT THIS TEST EXISTS FOR, and it is not the result the
        // method's motivation would predict.
        //
        // On CLEAN and WHITE-NOISE sightlines the operator model is a clear and
        // stable win — roughly half the distance to truth — because the basis
        // absorbs model mismatch (gusts, the veering upper layer) that the
        // nine-parameter shape cannot represent, leaving the shape parameters
        // better determined.
        //
        // On OPERATOR-COLORED noise, which is the case it was built for, the
        // result is a WASH WITH HIGH VARIANCE. Sweeping the upper cutoff over
        // nMax = 10..18 at nMin = 3 gave separations of 18, 26, 22, 37 and 11 m
        // against 29 m with the model off — scatter, not a trend. The injected
        // error lives inside the basis's own band, so how much of it the fit
        // grabs depends on which local optimum it lands in, and the trajectory
        // error swings with it.
        //
        // The residual, meanwhile, improves every time (0.21 -> 0.09 deg). That
        // is the caution this test is really for: ON COLORED POINTING NOISE A
        // SMALLER RESIDUAL IS NOT A BETTER ANSWER. The gate is therefore loose
        // and one-sided — it catches the nuisance basis running away with the
        // trajectory (which nMin = 2 demonstrably does), not accuracy drift.
        const opOn = byKey["operator wobble 0.30deg|true"];
        const opOff = byKey["operator wobble 0.30deg|false"];
        expect(opOn.sepM).toBeLessThan(opOff.sepM * 2.0);
        // Whatever it absorbs must stay near what a real operator could produce.
        expect(opOn.pointingDeg).toBeLessThan(1.0);
        console.log(`\noperator-wobble separation: model on ${opOn.sepM.toFixed(0)} m,`
            + ` off ${opOff.sepM.toFixed(0)} m`
            + ` (${(opOff.sepM / (opOn.sepM || 1)).toFixed(2)}x);`
            + ` modelled pointing ${opOn.pointingDeg.toFixed(2)} deg against 0.30 injected`);

        // Clean and white-noise ARE stable, so they can be gated properly.
        expect(byKey["clean sightlines|true"].sepM)
            .toBeLessThan(byKey["clean sightlines|false"].sepM);
        expect(byKey["white noise 0.30deg|true"].sepM)
            .toBeLessThan(byKey["white noise 0.30deg|false"].sepM);
    });

    test("the operator basis stays above the azimuth-sweep frequency", () => {
        // The identifiability condition, asserted rather than assumed. A basis
        // that reaches down to the sweep frequency can represent the
        // trajectory's own image-plane signature and will absorb it.
        const scene = makeScene({pointing: "operator"});
        const cycles = azimuthSweepCycles(scene.dataset);
        const res = fitWindTracer(scene.dataset, {searchSamples: 600});
        expect(res.params.operatorBand[0]).toBeGreaterThan(cycles);
        expect(res.params.operatorBand[0]).toBeGreaterThanOrEqual(2);
    });
});
