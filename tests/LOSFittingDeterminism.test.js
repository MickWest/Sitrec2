/**
 * Pins TRAV-DE-001 through the PRODUCTION path: fitPhysicsModel in
 * src/LOSFitting.js injects a seeded PRNG (rng: mulberry32(options.seed ??
 * 0xF17DE5)) into differential evolution. The model suites (SkyLantern /
 * Quadcopter) fit through a hand-copied core with Math.random mocked, which
 * never exercises this wiring — so a regression to unseeded randomness in the
 * real fit would not fail any test. This suite runs the actual fit twice and
 * requires bit-identical output with Math.random left untouched.
 */

import {fitPhysicsModel} from "../src/LOSFitting";
import {SkyLanternModel} from "../src/SkyLanternModel";
import {PhysicsModel} from "../src/PhysicsModel";

// Synthetic lantern drifting through constant wind, watched by a turning
// sensor (same construction as the model suites, smaller for speed).
function makeScenario({n = 600, fps = 30, windE = -6, windN = -3} = {}) {
    const S = new Float64Array(n * 3);
    const D = new Float64Array(n * 3);
    let x = 800, y = 4000, z = 250;
    const track = [];
    for (let f = 0; f < n; f++) {
        const t = f / fps;
        track.push([x, y, z]);
        const vz = t <= 10 ? 2.0 : -1.2 + 3.2 * Math.exp(-(t - 10) / 40);
        x += windE / fps; y += windN / fps; z += vz / fps;
    }
    const Rs = 2000, omega = 0.03;
    for (let f = 0; f < n; f++) {
        const t = f / fps;
        S[f * 3] = Rs * Math.sin(omega * t);
        S[f * 3 + 1] = Rs * (1 - Math.cos(omega * t));
        S[f * 3 + 2] = 500 + 1.5 * t;
        const dx = track[f][0] - S[f * 3];
        const dy = track[f][1] - S[f * 3 + 1];
        const dz = track[f][2] - S[f * 3 + 2];
        const dl = Math.hypot(dx, dy, dz);
        D[f * 3] = dx / dl; D[f * 3 + 1] = dy / dl; D[f * 3 + 2] = dz / dl;
    }
    const times = new Float64Array(n);
    for (let f = 0; f < n; f++) times[f] = f / fps;
    return {sensorPos: S, losDir: D, times, count: n};
}

describe("fitPhysicsModel determinism (production seeded path)", () => {
    test("same inputs + same seed produce bit-identical fits", async () => {
        const dataset = makeScenario();
        const opts = {
            optimizer: "de", dePop: 24, deGens: 40,
            maxIter: 800, sampleStride: 5, seed: 1234,
        };
        const a = await fitPhysicsModel(dataset, new Set(), new SkyLanternModel(), opts);
        const b = await fitPhysicsModel(dataset, new Set(), new SkyLanternModel(), opts);

        expect(a).not.toBeNull();
        expect(Number.isFinite(a.params.errDeg)).toBe(true);
        // Bit-identical: solved parameters, composite cost, and every position.
        expect(b.params.solved).toEqual(a.params.solved);
        expect(b.params.cost).toBe(a.params.cost);
        expect(b.params.errDeg).toBe(a.params.errDeg);
        expect(Array.from(b.positions)).toEqual(Array.from(a.positions));
    }, 60000);

    test("a non-finite composite cost fails closed even when the track is finite", async () => {
        class NaNPriorModel extends PhysicsModel {
            maxDt = 1;
            getName() { return "NaN prior test"; }
            getParameterDefs() {
                return [{name: "range", min: 100, max: 2000, default: 1000, scale: 100}];
            }
            getInitialState(params, dataset) {
                return [
                    dataset.sensorPos[0] + params[0] * dataset.losDir[0],
                    dataset.sensorPos[1] + params[0] * dataset.losDir[1],
                    dataset.sensorPos[2] + params[0] * dataset.losDir[2],
                    0, 0, 0,
                ];
            }
            extraCost() { return NaN; }
        }

        const dataset = {
            sensorPos: new Float64Array([0, 0, 0, 0, 0, 0]),
            losDir: new Float64Array([1, 0, 0, 1, 0, 0]),
            times: new Float64Array([0, 1]),
            count: 2,
        };
        const result = await fitPhysicsModel(dataset, new Set(), new NaNPriorModel(), {
            optimizer: "nm", maxIter: 4,
        });
        expect(result).toBeNull();
    });

    test("the production Nelder-Mead path observes cancellation during refinement", async () => {
        const dataset = makeScenario({n: 60});
        let checks = 0;
        await expect(fitPhysicsModel(dataset, new Set(), new SkyLanternModel(), {
            optimizer: "nm", maxIter: 1000,
            shouldCancel: () => ++checks >= 5,
        })).rejects.toThrow("cancelled");
        expect(checks).toBeLessThan(20);
    });
});
