/**
 * solverRegistry.test.js — the solvers a BOTBench run can select and the fit
 * units behind them (src/analysis/BotBenchSolvers.js).
 */
import {
    BATTERY_UNITS, SOLVERS, UNIT_ORDER, UNIT_VERSIONS, allSolverIds, defaultSolverIds, describeSolvers, includeSetFor,
    isEverySolver, normalizeSolvers, planUnits, rowMemoStorable, sameOptions, selectionKey, solverById, unitOptions,
    unitVersionsFor,
} from "../../src/analysis/BotBenchSolvers";
import {MONTE_CARLO_IDS, MONTE_CARLO_PRESETS, MONTE_CARLO_SEED} from "../../src/MonteCarloLOS";

describe("the solver list", () => {
    test("names the default candidates and six independent GPU Monte Carlo presets", () => {
        expect(SOLVERS).toHaveLength(25);
        expect(defaultSolverIds()).toHaveLength(19);
        expect(allSolverIds().filter(id => id.startsWith("mc_"))).toEqual(MONTE_CARLO_IDS);
        expect(solverById("gfCV").name).toBe("Global Fit: Constant Velocity");
        expect(solverById("gfCA").name).toBe("Global Fit: Constant Acceleration");
        expect(allSolverIds()).toContain("gfKalman");
        expect(solverById("gfKalman").name).toBe("Global Fit: Kalman Smoother");
        expect(allSolverIds().filter((id) => id.startsWith("gfPolyALS:"))).toEqual(
            ["gfPolyALS:1", "gfPolyALS:2", "gfPolyALS:3", "gfPolyALS:4", "gfPolyALS:5"]);
    });

    test("every solver's units exist, and every unit has a version and known needs", () => {
        for (const solver of SOLVERS) {
            for (const unit of solver.units) expect(BATTERY_UNITS[unit]).toBeDefined();
        }
        for (const unit of UNIT_ORDER) {
            expect(Number.isInteger(UNIT_VERSIONS[unit])).toBe(true);
            for (const need of BATTERY_UNITS[unit].needs) {
                expect(UNIT_ORDER.indexOf(need)).toBeLessThan(UNIT_ORDER.indexOf(unit));
            }
        }
    });

    test("a selection is normalized; absent selections retain the original default battery", () => {
        expect(normalizeSolvers(["gfKalman", "constAir", "bogus"])).toEqual(["constAir", "gfKalman"]);
        expect(normalizeSolvers(null)).toEqual(defaultSolverIds());
        expect(normalizeSolvers([])).toEqual(defaultSolverIds());
        expect(isEverySolver(null)).toBe(false);
        expect(isEverySolver(allSolverIds())).toBe(true);
        expect(isEverySolver(["gfKalman"])).toBe(false);
        expect(describeSolvers(["gfKalman"])).toBe("1 of 25 solvers");
        expect(describeSolvers(null)).toBe("19 of 25 solvers");
    });
});

describe("the unit plan", () => {
    test("the Kalman smoother alone needs one unit and no sweep", () => {
        expect(planUnits(["gfKalman"])).toEqual(["kalman"]);
    });

    test("the direct CV and CA fits each need only their own cheap unit", () => {
        expect(planUnits(["gfCV"])).toEqual(["gfCV"]);
        expect(planUnits(["gfCA"])).toEqual(["gfCA"]);
        expect(planUnits(["gfCA", "gfCV"])).toEqual(["gfCV", "gfCA"]);
    });

    test("a range-bounded fit pulls in the constant-air sweep it searches inside", () => {
        expect(planUnits(["aircraft"])).toEqual(["constAir", "aircraft"]);
        expect(planUnits(["saddle"])).toEqual(["constAir", "profiles"]);
        expect(planUnits(["constAir"])).toEqual(["constAir", "profiles"]);
    });

    test("the seeded physics fits pull in the smoother, and the closed-form checks need nothing", () => {
        expect(planUnits(["lantern"])).toEqual(["kalman", "lantern"]);
        expect(planUnits(["droneControl"])).toEqual(["kalman", "droneControl"]);
        expect(planUnits(["ground", "fixedPoint"])).toEqual([]);
    });

    test("every solver plans every unit but the range bands, which need their option and an object model", () => {
        expect(planUnits(allSolverIds())).toEqual(UNIT_ORDER.filter((u) => u !== "families"));
        expect(planUnits(allSolverIds(), {solutionFamilies: true})).toEqual(UNIT_ORDER);
        expect(planUnits(null)).not.toEqual(expect.arrayContaining(MONTE_CARLO_IDS));
        expect(planUnits(["gfKalman"], {solutionFamilies: true})).toEqual(["kalman"]);
    });

    test("each GPU Monte Carlo preset runs without a constant-velocity or range-sweep seed", () => {
        for (const id of MONTE_CARLO_IDS) expect(planUnits([id])).toEqual([id]);
    });

    test("the plan is in battery order whatever the selection order", () => {
        expect(planUnits(["gfPolyALS:3", "lantern", "constAlt"])).toEqual(["constAir", "constAlt", "kalman", "lantern", "polySweep"]);
    });
});

describe("options and keys", () => {
    test("GPU Monte Carlo cache options fix the preset and seed, independent of physics options", () => {
        for (const id of MONTE_CARLO_IDS) {
            const expected = {...MONTE_CARLO_PRESETS[id], seed: MONTE_CARLO_SEED, backend: "webgpu"};
            expect(unitOptions(id, {})).toEqual(expected);
            expect(unitOptions(id, {anchorM: 1, gpuSearch: true, mcOrderSweep: true})).toEqual(expected);
        }
        expect(rowMemoStorable({}, {missingGpuSolvers: ["mc_50k"]})).toBe(false);
        expect(rowMemoStorable({gpuSearch: true}, {searchBackend: "webgpu", missingGpuSolvers: ["mc_1M"]})).toBe(false);
    });
    test("a unit's options are the anchor, plus its own flag where it has one", () => {
        const options = {anchorM: 37040, solutionFamilies: true, mcOrderSweep: true, solvers: ["x"]};
        expect(unitOptions("aircraft", options)).toEqual({anchorM: 37040});
        expect(unitOptions("families", options)).toEqual({anchorM: 37040, solutionFamilies: true});
        expect(unitOptions("polySweep", options)).toEqual({anchorM: 37040, mcOrderSweep: true});
        expect(sameOptions({a: 1, b: 2}, {b: 2, a: 1})).toBe(true);
        expect(sameOptions({a: 1}, {a: 2})).toBe(false);
    });

    test("the selection key names the solvers and the options that shape the candidate set", () => {
        const key = selectionKey(["gfKalman", "aircraft"], {anchorM: 37040});
        expect(key).toBe("aircraft,gfKalman|a=37040|f=0|m=0");
        expect(selectionKey(["aircraft", "gfKalman"], {anchorM: 37040})).toBe(key);
        expect(selectionKey(null, {anchorM: 37040, mcOrderSweep: true})).toMatch(/\|m=1$/);
    });

    test("the GPU search option separates only the units it changes, and only when on", () => {
        const cpu = {anchorM: 37040, solutionFamilies: true};
        const gpu = {...cpu, gpuSearch: true};
        // CPU runs keep exactly the records and keys stored before the option existed.
        expect(unitOptions("aircraft", cpu)).toEqual({anchorM: 37040});
        expect(selectionKey(null, cpu)).not.toMatch(/g=/);
        for (const unit of ["aircraft", "lantern", "quadcopter", "families"]) {
            expect(unitOptions(unit, gpu).gpuSearch).toBe(true);
            expect(sameOptions(unitOptions(unit, gpu), unitOptions(unit, cpu))).toBe(false);
        }
        for (const unit of ["constAir", "profiles", "horizontalSpeed", "gfCV", "gfCA", "kalman", "droneControl", "polySweep"]) {
            expect(sameOptions(unitOptions(unit, gpu), unitOptions(unit, cpu))).toBe(true);
        }
        expect(selectionKey(null, gpu)).toMatch(/\|g=1$/);
    });

    test("a GPU-option row is remembered only when its searches ran on the GPU", () => {
        const gpu = {gpuSearch: true};
        expect(rowMemoStorable(gpu, {searchBackend: "webgpu"})).toBe(true);
        expect(rowMemoStorable(gpu, {searchBackend: "cpu"})).toBe(false);
        expect(rowMemoStorable(gpu, {searchBackend: "mixed"})).toBe(false);
        // Neither search in the selection: nothing could have fallen back.
        expect(rowMemoStorable(gpu, {searchBackend: null})).toBe(true);
        // CPU runs are unaffected.
        expect(rowMemoStorable({}, {searchBackend: "cpu"})).toBe(true);
    });

    test("the include set adds the Monte Carlo tiles only under their option", () => {
        expect(includeSetFor(["gfKalman"]).has("gfMC1:1")).toBe(false);
        expect(includeSetFor(["gfKalman"], {mcOrderSweep: true}).has("gfMC2:5")).toBe(true);
        expect(unitVersionsFor(["kalman"])).toEqual({kalman: UNIT_VERSIONS.kalman});
    });
});
