/**
 * fitPhysicsModel paramLocks — holding named parameters fixed while the rest
 * refit. This is what lets the analysis trace a range-conditioned solution
 * FAMILY (refit everything else at each of a ladder of ranges) instead of only
 * reporting a model's single best answer.
 *
 * The three properties that must hold:
 *   1. Locking a parameter AT the free solution changes nothing — same
 *      trajectory, same residual. If it did change something, every band the
 *      gallery draws would be offset from the tile it belongs to.
 *   2. The locked value is honoured exactly, and the other parameters move to
 *      compensate.
 *   3. A locked coordinate is never reported as a load-bearing search limit,
 *      and never appears in the identifiability metadata — it was not searched.
 *
 * Scenario construction copied from LOSFittingDeterminism.test.js.
 */

import {fitPhysicsModel} from "../src/LOSFitting";
import {SkyLanternModel} from "../src/SkyLanternModel";

function makeScenario({n = 400, fps = 30, windE = -6, windN = -3} = {}) {
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

const OPTS = {optimizer: "nm", maxIter: 300, sampleStride: 5};

describe("fitPhysicsModel paramLocks", () => {
    let dataset, free;

    beforeAll(async () => {
        dataset = makeScenario();
        free = await fitPhysicsModel(dataset, new Set(), new SkyLanternModel(), OPTS);
        expect(free).not.toBeNull();
    });

    test("no locks leaves the fit byte-identical to before the feature", async () => {
        const again = await fitPhysicsModel(dataset, new Set(), new SkyLanternModel(), OPTS);
        expect(again.params.solved).toEqual(free.params.solved);
        expect(again.params.cost).toBe(free.params.cost);
        expect(again.params.optimizer.lockedParams).toBeNull();
        // The identifiability metadata still names every parameter.
        expect(again.params.optimizer.paramNames).toHaveLength(
            Object.keys(free.params.solved).length);
    });

    test("locking every parameter at the free solution reproduces it exactly", async () => {
        // With nothing left to search the cost is evaluated once at the locked
        // point, so the trajectory must be the free one to the last bit.
        const locked = await fitPhysicsModel(dataset, new Set(), new SkyLanternModel(),
            {...OPTS, paramLocks: {...free.params.solved}});
        expect(locked).not.toBeNull();
        expect(locked.params.solved).toEqual(free.params.solved);
        expect(locked.params.errDeg).toBe(free.params.errDeg);
        expect(Array.from(locked.positions)).toEqual(Array.from(free.positions));
    });

    test("a locked value is honoured exactly and the rest refit around it", async () => {
        const target = free.params.solved.initialRange * 1.6;
        const locked = await fitPhysicsModel(dataset, new Set(), new SkyLanternModel(),
            {...OPTS, paramLocks: {initialRange: target}});
        expect(locked).not.toBeNull();
        // Exactly, not approximately: the coordinate was never in the search.
        expect(locked.params.solved.initialRange).toBe(target);
        // Something else had to move to absorb the change.
        expect(locked.params.solved.windE).not.toBe(free.params.solved.windE);
        // Conditioning the range cannot improve on the unconstrained optimum.
        expect(locked.params.cost).toBeGreaterThanOrEqual(free.params.cost);
    });

    test("a lock overrides a paramOverrides seed for the same parameter", async () => {
        const target = free.params.solved.initialRange * 1.3;
        const locked = await fitPhysicsModel(dataset, new Set(), new SkyLanternModel(),
            {...OPTS, paramOverrides: {initialRange: 9999}, paramLocks: {initialRange: target}});
        expect(locked.params.solved.initialRange).toBe(target);
    });

    test("locked coordinates are excluded from the search metadata and bound pins", async () => {
        // Park the lock hard against the model's own lower bound. Searched,
        // that would read as a load-bearing capability limit; locked, it is
        // just where the caller asked to look.
        const defs = new SkyLanternModel().getParameterDefs();
        const rangeDef = defs.find((d) => d.name === "initialRange");
        const locked = await fitPhysicsModel(dataset, new Set(), new SkyLanternModel(),
            {...OPTS, paramLocks: {initialRange: rangeDef.min}});
        expect(locked).not.toBeNull();
        expect(locked.params.optimizer.lockedParams).toEqual(["initialRange"]);
        expect(locked.params.optimizer.paramNames).not.toContain("initialRange");
        expect(locked.params.pinned.map((p) => p.name)).not.toContain("initialRange");
        // Names stay index-aligned with the per-parameter spread arrays, which
        // settledButUnidentifiable indexes one by the other.
        const spreads = locked.params.optimizer.parameterSpreads;
        if (spreads) expect(spreads).toHaveLength(locked.params.optimizer.paramNames.length);
    });

    test("locking works through the differential-evolution path too", async () => {
        const target = free.params.solved.initialRange;
        const locked = await fitPhysicsModel(dataset, new Set(), new SkyLanternModel(),
            {optimizer: "de", dePop: 12, deGens: 15, maxIter: 150, sampleStride: 5,
                seed: 4321, paramLocks: {initialRange: target}});
        expect(locked).not.toBeNull();
        expect(locked.params.solved.initialRange).toBe(target);
        expect(Number.isFinite(locked.params.errDeg)).toBe(true);
    });
});
