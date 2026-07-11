/**
 * Tests for the hover-capable Quadcopter model (src/QuadcopterModel.js).
 *
 * The model is multirotor kinematics: air-relative speed v along heading psi (v may
 * change via a constant along-track accel), a linearly-varying turn rate, a
 * constant climb, and wind advection. A synthetic drone watched by a turning
 * sensor is fit by the same DE + Nelder-Mead recipe LOSFitting.js uses; the fit
 * must recover the motion REGIME (speed/climb/range) and reproduce the rays.
 *
 * Like SkyLanternModel.test.js, this deliberately avoids importing LOSFitting.js
 * (three.js/Globals) — the fit orchestration is a compact copy of the core.
 */

import {QuadcopterModel} from "../src/QuadcopterModel";
import {integrateRK4} from "../src/PhysicsModel";
import {differentialEvolution} from "../src/DifferentialEvolution";
import {nelderMead} from "../src/NelderMead";
import {quadcopterById} from "../src/VehicleModels";

const DEG = Math.PI / 180;

// Deterministic PRNG (mulberry32) so the DE search can't flake.
let _seed = 135792468;
const lcg = () => {
    _seed = (_seed + 0x6D2B79F5) | 0;
    let t = Math.imul(_seed ^ (_seed >>> 15), 1 | _seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

// Synthetic drone integrated by the model itself (so the fit can recover it
// near-exactly), watched by a slowly turning sensor to make range observable.
function makeQuadScenario({
    n = 1200, fps = 30,
    start = [600, 3000, 200],
    headingDeg = 90, speed = 8, accel = 0, turnRate = 2, turnAccel = 0,
    climb = 1, windE = 0, windN = 0,
} = {}) {
    const model = new QuadcopterModel();
    const times = new Float64Array(n);
    for (let f = 0; f < n; f++) times[f] = f / fps;

    // params[3..8] drive the dynamics; initial position/heading/speed are set
    // directly here (getInitialState is only used by the fit to place the start
    // along the first ray from a solved range).
    const params = [0, headingDeg, speed, accel, turnRate, turnAccel, climb, windE, windN];
    const initialState = [start[0], start[1], start[2], headingDeg * DEG, speed];
    const states = integrateRK4(model, initialState, params, Array.from(times));

    const S = new Float64Array(n * 3);
    const D = new Float64Array(n * 3);
    const Rs = 1500, omega = 0.05;   // sensor turn makes range observable
    for (let f = 0; f < n; f++) {
        const t = times[f];
        S[f * 3] = Rs * Math.sin(omega * t);
        S[f * 3 + 1] = Rs * (1 - Math.cos(omega * t));
        S[f * 3 + 2] = 100 + t;
        const s = states[f];
        let dx = s[0] - S[f * 3], dy = s[1] - S[f * 3 + 1], dz = s[2] - S[f * 3 + 2];
        const dl = Math.hypot(dx, dy, dz);
        D[f * 3] = dx / dl; D[f * 3 + 1] = dy / dl; D[f * 3 + 2] = dz / dl;
    }
    return {dataset: {sensorPos: S, losDir: D, times, count: n}, n, fps};
}

function angErr(fx, fy, fz, sx, sy, sz, dx, dy, dz) {
    let rx = fx - sx, ry = fy - sy, rz = fz - sz;
    const rlen = Math.sqrt(rx * rx + ry * ry + rz * rz);
    rx /= rlen; ry /= rlen; rz /= rlen;
    const dot = Math.max(-1, Math.min(1, rx * dx + ry * dy + rz * dz));
    return Math.acos(dot);
}

// Compact copy of fitPhysicsModel's core (DE + polish over strided frames).
async function fitQuad(dataset, {stride = 5, pop = 48, gens = 120} = {}) {
    const model = new QuadcopterModel();
    const defs = model.getParameterDefs();
    const lo = defs.map(p => p.min), hi = defs.map(p => p.max);
    const x0 = defs.map(p => p.default), scales = defs.map(p => p.scale);
    const {sensorPos, losDir, times, count} = dataset;
    const T = times[count - 1];

    const costFrames = [];
    for (let k = 0; k < count; k += stride) costFrames.push(k);
    if (costFrames[costFrames.length - 1] !== count - 1) costFrames.push(count - 1);
    const costTimes = costFrames.map(i => times[i]);

    const costFn = (params) => {
        const states = integrateRK4(model, model.getInitialState(params, dataset), params, costTimes);
        let sum = 0;
        for (let k = 0; k < costFrames.length; k++) {
            const fi = costFrames[k], s = states[k], b = fi * 3;
            sum += angErr(s[0], s[1], s[2],
                sensorPos[b], sensorPos[b + 1], sensorPos[b + 2],
                losDir[b], losDir[b + 1], losDir[b + 2]);
        }
        const errDeg = (sum / costFrames.length) * 180 / Math.PI;
        return errDeg / 0.02 + model.extraCost(params, dataset, T);
    };

    const de = await differentialEvolution(costFn, lo, hi, {pop, gens, seeds: [x0]});
    let best = nelderMead(costFn, de.params, {lo, hi, initialScale: scales, maxIter: 3000});
    if (de.cost < best.cost) best = de;

    const allTimes = Array.from(times);
    const states = integrateRK4(model, model.getInitialState(best.params, dataset), best.params, allTimes);
    let errSum = 0;
    for (let i = 0; i < count; i++) {
        const s = states[i], b = i * 3;
        errSum += angErr(s[0], s[1], s[2],
            sensorPos[b], sensorPos[b + 1], sensorPos[b + 2],
            losDir[b], losDir[b + 1], losDir[b + 2]);
    }
    const solved = {};
    defs.forEach((d, i) => solved[d.name] = best.params[i]);
    return {solved, errDeg: (errSum / count) * 180 / Math.PI};
}

describe("QuadcopterModel", () => {

    let randSpy;
    beforeEach(() => {
        _seed = 135792468;
        randSpy = jest.spyOn(Math, "random").mockImplementation(lcg);
    });
    afterEach(() => randSpy.mockRestore());

    test("initial state sits on the first LOS ray with heading & speed", () => {
        const model = new QuadcopterModel();
        const dataset = {sensorPos: Float64Array.from([100, 200, 500]), losDir: Float64Array.from([1, 0, 0])};
        const s = model.getInitialState([1000, 90, 7, 0, 0, 0, 0, 0, 0], dataset);
        expect(s[0]).toBeCloseTo(1100, 6);   // 100 + 1000*1
        expect(s[1]).toBeCloseTo(200, 6);
        expect(s[2]).toBeCloseTo(500, 6);
        expect(s[3]).toBeCloseTo(90 * DEG, 9);
        expect(s[4]).toBe(7);
    });

    test("zero air-relative speed produces passive wind drift", () => {
        const model = new QuadcopterModel();
        // params: range, heading, speed, accel, turnRate, turnAccel, climb, windE, windN
        const d = model.derivatives([0, 0, 100, 0, 0], [0, 0, 0, 0, 0, 0, 2, 3, -1], 0);
        expect(d[0]).toBeCloseTo(3, 9);    // pure windE (v = 0)
        expect(d[1]).toBeCloseTo(-1, 9);   // pure windN
        expect(d[2]).toBeCloseTo(2, 9);    // climb
    });

    test("selecting a specific drone tightens the speed & climb bounds", () => {
        const model = new QuadcopterModel();
        model.envelope = quadcopterById("mini4");   // maxSpeed 16, ascent 5, descent 5
        const defs = model.getParameterDefs();
        const speed = defs.find(d => d.name === "speed");
        const climb = defs.find(d => d.name === "climb");
        expect(speed.max).toBe(16);
        expect(climb.max).toBe(5);
        expect(climb.min).toBe(-5);
        // AUTO (no envelope) keeps the generic wide bounds
        const auto = new QuadcopterModel().getParameterDefs().find(d => d.name === "speed");
        expect(auto.max).toBe(60);
    });

    test("recovers a slow climbing drone's motion regime from the sightlines", async () => {
        const {dataset} = makeQuadScenario({speed: 8, climb: 1, turnRate: 2});
        const fit = await fitQuad(dataset);
        // The rays are reproduced closely, and the recovered motion is in the
        // right regime — slow ground speed, gentle climb — not a jet or a
        // stationary point. (LOS fits are degenerate, so test the regime.)
        expect(fit.errDeg).toBeLessThan(0.2);
        expect(fit.solved.speed).toBeGreaterThan(2);
        expect(fit.solved.speed).toBeLessThan(16);
        expect(fit.solved.climb).toBeGreaterThan(-3);
        expect(fit.solved.climb).toBeLessThan(6);
    });
});
