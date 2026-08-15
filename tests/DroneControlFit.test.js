/**
 * Drone hypothesis fitted as CONTROL INPUTS, seeded from a geometric solution.
 *
 * The claim under test: pricing control EFFORT (how much the inputs must move)
 * rather than bounding path shape both (a) kills the corkscrew and (b) leaves
 * genuinely manoeuvring flight reachable. Both halves are necessary — a change
 * that only did (a) would be a thumb on the scale toward slow, straight answers,
 * which is exactly what this codebase must not do.
 *
 * The headline comparison is against the free QuadcopterModel on the SAME
 * sightlines, because that is the behaviour being replaced.
 */

import {fitPhysicsModel} from "../src/LOSFitting";
import {QuadcopterModel} from "../src/QuadcopterModel";
import {
    DroneControlModel, inverseControls, toKnots,
} from "../src/DroneControlFit";

const FPS = 10;
const DEG = Math.PI / 180;

function sceneFromTrack(truthFn, {seconds = 60, noiseDeg = 0.04, seed = 11} = {}) {
    const n = Math.round(seconds * FPS);
    const sensorPos = new Float64Array(n * 3);
    const losDir = new Float64Array(n * 3);
    const times = new Float64Array(n);
    const truth = new Float64Array(n * 3);
    const noise = (k) => {
        const x = Math.sin((k + seed) * 12.9898) * 43758.5453;
        return (x - Math.floor(x)) * 2 - 1;
    };
    for (let f = 0; f < n; f++) {
        const t = f / FPS;
        times[f] = t;
        const ang = (2 * Math.PI / 500) * t;
        const sx = 1800 * Math.cos(ang), sy = 1800 * Math.sin(ang) - 1600, sz = 40;
        sensorPos[f * 3] = sx; sensorPos[f * 3 + 1] = sy; sensorPos[f * 3 + 2] = sz;
        const p = truthFn(t);
        truth[f * 3] = p[0]; truth[f * 3 + 1] = p[1]; truth[f * 3 + 2] = p[2];
        let dx = p[0] - sx, dy = p[1] - sy, dz = p[2] - sz;
        const L = Math.hypot(dx, dy, dz);
        dx /= L; dy /= L; dz /= L;
        if (noiseDeg > 0) {
            const s = noiseDeg * DEG;
            dx += noise(f * 3) * s; dy += noise(f * 3 + 1) * s; dz += noise(f * 3 + 2) * s;
            const L2 = Math.hypot(dx, dy, dz);
            dx /= L2; dy /= L2; dz /= L2;
        }
        losDir[f * 3] = dx; losDir[f * 3 + 1] = dy; losDir[f * 3 + 2] = dz;
    }
    return {dataset: {sensorPos, losDir, times, count: n, maxRange: null}, truth, n};
}

// Kept modest: this file already runs several DE fits, and Babel makes them
// far slower than the shipped bundle.
const OPTS = {optimizer: "de", dePop: 24, deGens: 40, sampleStride: 4};

function meanSep(truth, got, n) {
    let s = 0;
    for (let f = 0; f < n; f++) {
        const b = f * 3;
        s += Math.hypot(got[b] - truth[b], got[b + 1] - truth[b + 1], got[b + 2] - truth[b + 2]);
    }
    return s / n;
}

/** Total heading travel of an arbitrary track, in degrees — the corkscrew meter. */
function headingTravel(track, n) {
    let total = 0, prev = null;
    for (let f = 1; f < n; f++) {
        const vx = track[f * 3] - track[(f - 1) * 3];
        const vy = track[f * 3 + 1] - track[(f - 1) * 3 + 1];
        if (Math.hypot(vx, vy) < 1e-6) continue;
        const h = Math.atan2(vx, vy) / DEG;
        if (prev !== null) {
            let d = h - prev;
            while (d > 180) d -= 360;
            while (d < -180) d += 360;
            total += Math.abs(d);
        }
        prev = h;
    }
    return total;
}

/**
 * Stand-in for the geometric seed the real pipeline supplies (a global fit or
 * the plausible least-manoeuvring track). Deliberately crude — a
 * constant-velocity fit through the truth endpoints — so the test proves the
 * refinement does the work, not a flattering seed.
 */
function crudeSeedTrack(scene) {
    const {truth, n} = scene;
    const out = new Float64Array(n * 3);
    for (let f = 0; f < n; f++) {
        const u = f / (n - 1);
        for (let c = 0; c < 3; c++) {
            out[f * 3 + c] = truth[c] * (1 - u) + truth[(n - 1) * 3 + c] * u;
        }
    }
    return out;
}

async function fitControls(scene, K = 4, optOverrides = {}) {
    const m = new DroneControlModel(K);
    m.seedFromTrack(crudeSeedTrack(scene), scene.dataset);
    const defs = m.getParameterDefs();
    const overrides = {};
    const sp = m.seedParams();
    defs.forEach((d, i) => { overrides[d.name] = sp[i]; });
    const fit = await fitPhysicsModel(scene.dataset, new Set(), m,
        {...OPTS, ...optOverrides, paramOverrides: overrides});
    if (!fit || !fit.positions) return null;
    const params = defs.map((d) => fit.params.solved[d.name]);
    return {
        model: m, fit, params,
        errDeg: fit.params.errDeg,
        sep: meanSep(scene.truth, fit.positions, scene.n),
        travel: headingTravel(fit.positions, scene.n),
        describe: m.describe(params),
        priors: fit.params.priors,
    };
}

async function fitFreeQuad(scene) {
    // fitMaxDt coarsens the integration used to SCORE candidates during the search; the
    // trajectory that comes back is always re-integrated at the model's own maxDt
    // (LOSFitting.js), so every assertion below still sees a full-resolution result. This
    // mirrors what the shipped code already does for a quadcopter — TraverseBattery.js
    // passes fitMaxDt: 0.5 for exactly this model — so the test now exercises the
    // production search settings rather than a slower configuration nothing else uses.
    const fit = await fitPhysicsModel(scene.dataset, new Set(), new QuadcopterModel(),
        {...OPTS, fitMaxDt: 0.5});
    if (!fit || !fit.positions) return null;
    return {
        errDeg: fit.params.errDeg,
        sep: meanSep(scene.truth, fit.positions, scene.n),
        travel: headingTravel(fit.positions, scene.n),
    };
}

describe("drone control-input fit", () => {
    // 10 minutes, not 5: the corkscrew test runs two full DE fits and took
    // 363 s on a slow shared macOS CI runner (2.104.0 CI #1298 timed out at
    // 300 s there while passing locally in a fraction of that). The budgets
    // themselves must NOT be trimmed to fit a timeout — an under-budgeted
    // control fit degrades toward straight flight (see the turning-flight
    // test below), which would be a quiet bias, not a speedup.
    jest.setTimeout(600000);

    test("inverse controls recover the inputs that produced a known flight", () => {
        // A leg at 9 m/s on heading 40, then a turn to 130 over the second half.
        const n = 600, times = new Float64Array(n), track = new Float64Array(n * 3);
        let x = 0, y = 0;
        for (let f = 0; f < n; f++) {
            const t = f / FPS;
            times[f] = t;
            const hd = (t < 30 ? 40 : 130) * DEG;
            if (f > 0) { x += 9 * Math.sin(hd) / FPS; y += 9 * Math.cos(hd) / FPS; }
            track[f * 3] = x; track[f * 3 + 1] = y; track[f * 3 + 2] = 200 + 0.5 * t;
        }
        const c = inverseControls(track, times, n);
        // Sample away from the ends and the discontinuity.
        expect(c.speed[100]).toBeCloseTo(9, 1);
        expect(c.speed[500]).toBeCloseTo(9, 1);
        expect(c.heading[100]).toBeCloseTo(40, 0);
        expect(c.heading[500]).toBeCloseTo(130, 0);
        expect(c.climb[300]).toBeCloseTo(0.5, 1);
        const k = toKnots(c.heading, n, 4);
        expect(k.length).toBe(4);
    });

    test("the corkscrew is priced out — and the free model shows it is not straw", async () => {
        // Straight, constant-velocity truth plus tracker wobble: the exact
        // situation that made the free model corkscrew on Aguadilla.
        const scene = sceneFromTrack((t) => [400 + 6 * t, 900 + 2 * t, 300]);
        const free = await fitFreeQuad(scene);
        const ctrl = await fitControls(scene);
        expect(free).not.toBeNull();
        expect(ctrl).not.toBeNull();

        console.log("\nSTRAIGHT TRUTH + TRACKER WOBBLE");
        console.log(`  free quadcopter   residual ${free.errDeg.toFixed(4)}°`
            + `  separation ${free.sep.toFixed(0).padStart(5)} m`
            + `  heading travel ${(free.travel / 360).toFixed(1)} revolutions`);
        console.log(`  control-input fit residual ${ctrl.errDeg.toFixed(4)}°`
            + `  separation ${ctrl.sep.toFixed(0).padStart(5)} m`
            + `  heading travel ${(ctrl.travel / 360).toFixed(1)} revolutions`);
        console.log(`                    ${ctrl.describe}`);

        // THE claim: a straight truth needs no turning, and the control fit
        // does not invent any.
        expect(ctrl.travel).toBeLessThan(360);
        expect(ctrl.travel).toBeLessThan(free.travel);

        // NOT claimed: that it is closer to truth than the free model. On a
        // short, clean scene like this one the free model only wanders ~0.6
        // revolutions and its extra freedom can put it marginally nearer (5 m
        // vs 8 m when this was written). The control fit buys INTERPRETABILITY
        // and the absence of invented motion, not a better distance here; the
        // distance argument belongs on a long, noisy scene where the free model
        // actually goes pathological. Require only that it stays in the same
        // league, so a real regression still trips this.
        expect(ctrl.sep).toBeLessThan(Math.max(50, free.sep * 3));
    });

    test("a genuinely turning flight is still recovered — manoeuvring stays reachable", async () => {
        // A deliberate 90-degree course change mid-clip at 10 m/s. If pricing
        // control effort made this unreachable, the change would be a bias
        // toward straight/slow answers rather than a fix.
        const scene = sceneFromTrack((t) => {
            const hd = (t < 45 ? 20 : 110) * DEG;
            const tt = Math.min(t, 45), rest = Math.max(0, t - 45);
            return [
                500 + 10 * Math.sin(20 * DEG) * tt + 10 * Math.sin(110 * DEG) * rest,
                900 + 10 * Math.cos(20 * DEG) * tt + 10 * Math.cos(110 * DEG) * rest,
                320,
            ];
        });
        // A LARGER SEARCH BUDGET, DELIBERATELY, AND THE REASON MATTERS.
        // At the cheap budget the rest of this file uses, the recovered turn
        // shrinks from ~65° to ~39° — the search under-converges and settles
        // for something straighter. That is not a model defect but it IS a real
        // hazard for the integration: an under-budgeted control fit degrades
        // toward straight flight, which is a quiet bias toward the slow, simple
        // answer. Whatever budget ships must be validated on a turning case,
        // not only on a straight one.
        const ctrl = await fitControls(scene, 4, {dePop: 40, deGens: 90});
        expect(ctrl).not.toBeNull();
        console.log("\n90° COURSE CHANGE TRUTH");
        console.log(`  control-input fit residual ${ctrl.errDeg.toFixed(4)}°`
            + `  separation ${ctrl.sep.toFixed(0)} m`
            + `  heading travel ${ctrl.travel.toFixed(0)}°`);
        console.log(`                    ${ctrl.describe}`);
        if (ctrl.priors) {
            console.log(`  control effort paid: ${ctrl.priors.total.toFixed(3)}° `
                + `(${Object.entries(ctrl.priors.terms).map(([k, v]) => `${k} ${v.toFixed(3)}°`).join(", ")})`);
        }
        // MEASURED LIMITATION, recorded rather than tuned around: against a
        // 90° truth the fit recovers ~39° with K=4 knots, and DOUBLING the
        // search budget does not improve it — so this is the parameterisation,
        // not the optimizer. Four knots spread evenly over the clip cannot
        // place a sharp mid-clip course change; they smear it into a gradual
        // one, and a gradual turn through less total heading fits the rays
        // nearly as well.
        //
        // It matters because the error is DIRECTIONAL: the fit under-states
        // manoeuvring, which is a quiet bias toward the simpler, slower
        // reading. Before this ships, either K should rise (at the cost of
        // approaching the free model's overfitting) or the knots should be
        // placed where the seed's control history actually changes rather than
        // uniformly. Adaptive knots look like the better answer and are not
        // implemented yet.
        expect(ctrl.travel).toBeGreaterThan(25);   // it does turn, materially
        expect(ctrl.travel).toBeLessThan(200);     // and does not invent a spiral
        expect(ctrl.sep).toBeLessThan(400);
    });

    test("holding an input is free; sweeping heading is not", () => {
        const m = new DroneControlModel(4);
        m._T = 90;
        // [range, s0..s3, heading0, dh0..dh2, c0..c3] — heading is an initial
        // value plus per-interval INCREMENTS, so a bound is a statement about
        // how far it can turn in an interval rather than about where an
        // unwrapped heading may sit.
        const held = [2000, 8, 8, 8, 8, 45, 0, 0, 0, 0, 0, 0, 0];
        const orbiting = [2000, 8, 8, 8, 8, 0, 90, 90, 90, 0, 0, 0, 0];
        const corkscrew = [2000, 8, 8, 8, 8, 0, 1440, 1440, 1440, 0, 0, 0, 0];
        const cost = (p) => m.extraCost(p, null, 90);
        console.log("\nCONTROL EFFORT (fit-cost units; 1 unit = 0.02° of residual)");
        console.log(`  held inputs (hover / straight leg)   ${cost(held).toFixed(4)}`);
        console.log(`  steady orbit (270° over 90 s)        ${cost(orbiting).toFixed(4)}`);
        console.log(`  corkscrew (4,320° over 90 s)         ${cost(corkscrew).toFixed(1)}`);
        expect(cost(held)).toBe(0);                       // holding is free
        expect(cost(orbiting)).toBeLessThan(1);           // orbiting is cheap
        // The meaningful comparison is against what the corkscrew BOUGHT, not
        // against a multiple of the orbit: on Aguadilla the free model's
        // 61-revolution spiral improved the residual by ~0.011°. One cost unit
        // is errSigma = 0.02° of residual budget, so the price must dwarf 0.55
        // units for the trade to be refused. It does, by two orders of
        // magnitude — and it is a PRICE, not a ban: the fit may still buy the
        // spiral if the sightlines ever pay for it.
        const boughtUnits = 0.011 / 0.02;
        expect(cost(corkscrew)).toBeGreaterThan(100 * boughtUnits);
        // ...and turning must remain far cheaper than spiralling.
        expect(cost(orbiting)).toBeLessThan(cost(corkscrew) / 100);
    });

    // The same physical flight must cost the same however many knots describe it,
    // for SPEED and CLIMB — not just yaw (TA-10). The old sum-of-squared-per-knot-
    // differences form made the same total speed/climb change ~(K-1)^2 cheaper as
    // K grew, so long clips (K scales with duration) under-priced throttle/climb
    // activity. Total-variation-squared removes that.
    test("speed and climb effort are knot-count invariant", () => {
        const T = 600, dV = 6, dC = 2;
        // A monotonic speed ramp V0->V0+dV, climb ramp C0->C0+dC, no turning.
        const rampParams = (K) => {
            const p = new Array(1 + 3 * K).fill(0);
            p[0] = 2000;                                   // range
            for (let k = 0; k < K; k++) p[1 + k] = 8 + dV * k / (K - 1);        // speed knots
            p[1 + K] = 0;                                  // heading0
            for (let k = 0; k < K - 1; k++) p[1 + K + 1 + k] = 0;               // no heading change
            for (let k = 0; k < K; k++) p[1 + 2 * K + k] = 0 + dC * k / (K - 1); // climb knots
            return p;
        };
        const terms = (K) => new DroneControlModel(K).extraCostTerms(rampParams(K), null, T);
        const t4 = terms(4), t8 = terms(8), t12 = terms(12);
        // identical total change => identical cost at any K
        expect(t8["speed changes"]).toBeCloseTo(t4["speed changes"], 9);
        expect(t12["speed changes"]).toBeCloseTo(t4["speed changes"], 9);
        expect(t8["climb changes"]).toBeCloseTo(t4["climb changes"], 9);
        expect(t12["climb changes"]).toBeCloseTo(t4["climb changes"], 9);
        // and it is (total variation)^2 * weight
        expect(t4["speed changes"]).toBeCloseTo(0.0167 * dV * dV, 9);
        expect(t4["climb changes"]).toBeCloseTo(0.0167 * dC * dC, 9);
        // duration-invariant too: a longer clip does not change a total-variation cost
        const t4long = new DroneControlModel(4).extraCostTerms(rampParams(4), null, 6000);
        expect(t4long["speed changes"]).toBeCloseTo(t4["speed changes"], 9);
    });
});
