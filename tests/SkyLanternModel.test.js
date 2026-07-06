/**
 * Tests for the wind-drift Sky Lantern model (src/SkyLanternModel.js).
 *
 * The model is pure kinematics: horizontal velocity == altitude-sheared wind,
 * vertical velocity == lantern life cycle (rise while lit, buoyancy decay
 * after flame-out, terminal sink). A synthetic turning sensor watches a
 * synthetic lantern; the DE+Nelder-Mead fit (the same recipe LOSFitting.js
 * uses) must recover the drift direction, speed regime, and vertical phases.
 *
 * Deliberately does NOT import LOSFitting.js (it pulls in three.js/Globals,
 * which this Jest suite must stay clear of) — the fit orchestration here is a
 * compact copy of fitPhysicsModel's core.
 */

import {SkyLanternModel} from "../src/SkyLanternModel";
import {integrateRK4} from "../src/PhysicsModel";
import {differentialEvolution} from "../src/DifferentialEvolution";
import {nelderMead} from "../src/NelderMead";

const KNOTS_TO_MS = 0.514444;

// Deterministic PRNG (mulberry32) in place of Math.random so the DE search
// can't flake. (A plain LCG's sequential correlation visibly degrades DE's
// population diversity — mulberry32 is cheap and statistically sound.)
let _seed = 987654321;
const lcg = () => {
    _seed = (_seed + 0x6D2B79F5) | 0;
    let t = Math.imul(_seed ^ (_seed >>> 15), 1 | _seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

// Synthetic lantern through sheared wind, watched by a turning sensor.
function makeLanternScenario({
    n = 1800, fps = 30,
    windE = -6, windN = -3,           // drift toward ~243° (wind from ~63°)
    shearPerM = 0.002,
    vRise = 2.0, vSink = 1.2, tBurn = 20, tauCool = 40,
    start = [800, 4000, 250],
} = {}) {
    const S = new Float64Array(n * 3);
    const D = new Float64Array(n * 3);
    const track = new Float64Array(n * 3);
    const z0 = start[2];
    let [x, y, z] = start;
    for (let f = 0; f < n; f++) {
        const t = f / fps;
        track[f * 3] = x; track[f * 3 + 1] = y; track[f * 3 + 2] = z;
        const mult = Math.min(3, Math.max(0.25, 1 + shearPerM * (z - z0)));
        const vz = t <= tBurn ? vRise
            : -vSink + (vRise + vSink) * Math.exp(-(t - tBurn) / tauCool);
        x += windE * mult / fps;
        y += windN * mult / fps;
        z += vz / fps;
    }
    const Rs = 2000, omega = 0.03;    // sensor turn makes range observable
    for (let f = 0; f < n; f++) {
        const t = f / fps;
        S[f * 3] = Rs * Math.sin(omega * t);
        S[f * 3 + 1] = Rs * (1 - Math.cos(omega * t));
        S[f * 3 + 2] = 500 + 1.5 * t;
        let dx = track[f * 3] - S[f * 3];
        let dy = track[f * 3 + 1] - S[f * 3 + 1];
        let dz = track[f * 3 + 2] - S[f * 3 + 2];
        const dl = Math.hypot(dx, dy, dz);
        D[f * 3] = dx / dl; D[f * 3 + 1] = dy / dl; D[f * 3 + 2] = dz / dl;
    }
    const times = new Float64Array(n);
    for (let f = 0; f < n; f++) times[f] = f / fps;
    return {dataset: {sensorPos: S, losDir: D, times, count: n}, track, n, fps};
}

function angErr(fx, fy, fz, sx, sy, sz, dx, dy, dz) {
    let rx = fx - sx, ry = fy - sy, rz = fz - sz;
    const rlen = Math.sqrt(rx * rx + ry * ry + rz * rz);
    rx /= rlen; ry /= rlen; rz /= rlen;
    const dot = Math.max(-1, Math.min(1, rx * dx + ry * dy + rz * dz));
    return Math.acos(dot);
}

// Compact copy of fitPhysicsModel's core (DE + polish over strided frames).
async function fitLantern(dataset, {stride = 5, pop = 48, gens = 120} = {}) {
    const model = new SkyLanternModel();
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
    const track = new Float64Array(count * 3);
    let errSum = 0;
    for (let i = 0; i < count; i++) {
        const s = states[i], b = i * 3;
        track[b] = s[0]; track[b + 1] = s[1]; track[b + 2] = s[2];
        errSum += angErr(s[0], s[1], s[2],
            sensorPos[b], sensorPos[b + 1], sensorPos[b + 2],
            losDir[b], losDir[b + 1], losDir[b + 2]);
    }
    const solved = {};
    defs.forEach((d, i) => solved[d.name] = best.params[i]);
    return {track, solved, errDeg: (errSum / count) * 180 / Math.PI};
}

describe("SkyLanternModel", () => {

    let randSpy;
    beforeEach(() => {
        _seed = 987654321;
        randSpy = jest.spyOn(Math, "random").mockImplementation(lcg);
    });
    afterEach(() => randSpy.mockRestore());

    test("initial state sits on the first LOS ray with z0 riding along", () => {
        const model = new SkyLanternModel();
        const dataset = {
            sensorPos: Float64Array.from([100, 200, 500]),
            losDir: Float64Array.from([0.6, 0.64, -0.48]),
        };
        const s = model.getInitialState([1000, 0, 0, 0, 1, 1, 60, 60], dataset);
        expect(s[0]).toBeCloseTo(100 + 600, 6);
        expect(s[1]).toBeCloseTo(200 + 640, 6);
        expect(s[2]).toBeCloseTo(500 - 480, 6);
        expect(s[3]).toBe(s[2]);   // shear reference = initial altitude
    });

    test("vertical profile: rise while lit, decay to terminal sink after flame-out", () => {
        const model = new SkyLanternModel();
        // params: range, windE, windN, shear, vRise, vSink, tBurn, tauCool
        const p = [1000, 0, 0, 0, 2.0, 1.5, 30, 20];
        expect(model._vz(0, p)).toBeCloseTo(2.0, 9);
        expect(model._vz(30, p)).toBeCloseTo(2.0, 9);          // continuous at burnout
        expect(model._vz(30 + 200, p)).toBeCloseTo(-1.5, 3);   // terminal sink
        // closed-form altitude matches numeric integration of _vz
        const z0 = 250;
        let z = z0;
        const dt = 0.01;
        for (let t = 0; t < 120; t += dt) z += model._vz(t + dt / 2, p) * dt;
        expect(model._zAt(120, p, z0)).toBeCloseTo(z, 1);
        // and with a pre-clip burnout (tBurn < 0)
        const p2 = [1000, 0, 0, 0, 2.0, 1.5, -50, 40];
        let z2 = z0;
        for (let t = 0; t < 120; t += dt) z2 += model._vz(t + dt / 2, p2) * dt;
        expect(model._zAt(120, p2, z0)).toBeCloseTo(z2, 1);
    });

    test("wind shear multiplier is clamped so wind never reverses or blows up", () => {
        const model = new SkyLanternModel();
        const p = [1000, 10, 0, 0.008, 0, 0, 60, 60];
        // way below the reference altitude: clamped at the floor, same sign
        const dLow = model.derivatives([0, 0, -10000, 500], p, 0);
        expect(dLow[0]).toBeCloseTo(10 * 0.25, 6);
        // way above: clamped at the ceiling
        const dHigh = model.derivatives([0, 0, 100000, 500], p, 0);
        expect(dHigh[0]).toBeCloseTo(10 * 3.0, 6);
    });

    test("recovers a synthetic lantern: drift direction, speed regime, phases", async () => {
        const {dataset, track, n, fps} = makeLanternScenario();
        const fit = await fitLantern(dataset);

        // near-exact fit to clean synthetic sightlines
        expect(fit.errDeg).toBeLessThan(0.05);

        // drift direction (wind FROM ~63°) within 20°
        const windFrom = (Math.atan2(-fit.solved.windE, -fit.solved.windN) * 180 / Math.PI + 360) % 360;
        expect(Math.abs(windFrom - 63)).toBeLessThan(20);

        // lantern-plausible drift speed. (LOS-only data admits a degenerate
        // closer-and-slower / farther-and-faster family around the true 14 kt;
        // the model guarantees the REGIME, not the exact member.)
        const T = (n - 1) / fps;
        const dx = fit.track[(n - 1) * 3] - fit.track[0];
        const dy = fit.track[(n - 1) * 3 + 1] - fit.track[1];
        const meanKt = Math.hypot(dx, dy) / T / KNOTS_TO_MS;
        expect(meanKt).toBeGreaterThan(3);
        expect(meanKt).toBeLessThan(25);

        // vertical phases: rising while the flame burns, and the rise has
        // decayed by the end of the clip. (Where exactly the neutral point
        // lands trades off against range within the degenerate family, so
        // only the shape is asserted, not the exact end rate.)
        expect(fit.solved.vRise).toBeGreaterThan(0.5);
        const vzEnd = new SkyLanternModel()._vz(T, Object.values(fit.solved));
        expect(vzEnd).toBeLessThan(fit.solved.vRise);
        expect(vzEnd).toBeLessThan(1.0);

        // positionally sane: the track stays within the degenerate family's
        // envelope of the synthetic truth
        let sum = 0;
        for (let f = 0; f < n; f++) {
            const b = f * 3;
            sum += Math.hypot(fit.track[b] - track[b], fit.track[b + 1] - track[b + 1],
                fit.track[b + 2] - track[b + 2]);
        }
        expect(sum / n).toBeLessThan(600);
    }, 120000);

    test("parameter bounds forbid non-lantern motion", () => {
        const defs = new SkyLanternModel().getParameterDefs();
        const byName = Object.fromEntries(defs.map(d => [d.name, d]));
        // wind bounded to ~39 kt per component (55 kt vector); vertical rates to 4 m/s
        expect(Math.hypot(byName.windE.max, byName.windN.max) / KNOTS_TO_MS).toBeLessThan(60);
        expect(byName.vRise.max).toBeLessThanOrEqual(4);
        expect(byName.vSink.max).toBeLessThanOrEqual(4);
        // rise rate cannot be negative (that's what vSink is for)
        expect(byName.vRise.min).toBeGreaterThanOrEqual(0);
    });
});
