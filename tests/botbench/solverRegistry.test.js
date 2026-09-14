/**
 * solverRegistry.test.js — the solvers a BOTBench run can select and the fit
 * units behind them (src/analysis/BotBenchSolvers.js).
 */
import {
    BATTERY_UNITS, SOLVERS, UNIT_ORDER, UNIT_VERSIONS, allSolverIds, describeSolvers, includeSetFor,
    isEverySolver, normalizeSolvers, planUnits, sameOptions, selectionKey, solverById, unitOptions,
    unitVersionsFor,
} from "../../src/analysis/BotBenchSolvers";

describe("the solver list", () => {
    test("names the sixteen candidates the charts show, with the Kalman smoother among them", () => {
        expect(SOLVERS).toHaveLength(16);
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

    test("a selection is normalized to known ids in candidate order; nothing means everything", () => {
        expect(normalizeSolvers(["gfKalman", "constAir", "bogus"])).toEqual(["constAir", "gfKalman"]);
        expect(normalizeSolvers(null)).toEqual(allSolverIds());
        expect(normalizeSolvers([])).toEqual(allSolverIds());
        expect(isEverySolver(null)).toBe(true);
        expect(isEverySolver(["gfKalman"])).toBe(false);
        expect(describeSolvers(["gfKalman"])).toBe("1 of 16 solvers");
        expect(describeSolvers(null)).toBe("all 16 solvers");
    });
});

describe("the unit plan", () => {
    test("the Kalman smoother alone needs one unit and no sweep", () => {
        expect(planUnits(["gfKalman"])).toEqual(["kalman"]);
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
        expect(planUnits(null)).toEqual(UNIT_ORDER.filter((u) => u !== "families"));
        expect(planUnits(null, {solutionFamilies: true})).toEqual(UNIT_ORDER);
        expect(planUnits(["gfKalman"], {solutionFamilies: true})).toEqual(["kalman"]);
    });

    test("the plan is in battery order whatever the selection order", () => {
        expect(planUnits(["gfPolyALS:3", "lantern", "constAlt"])).toEqual(["constAir", "constAlt", "kalman", "lantern", "polySweep"]);
    });
});

describe("options and keys", () => {
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

    test("the include set adds the Monte Carlo tiles only under their option", () => {
        expect(includeSetFor(["gfKalman"]).has("gfMC1:1")).toBe(false);
        expect(includeSetFor(["gfKalman"], {mcOrderSweep: true}).has("gfMC2:5")).toBe(true);
        expect(unitVersionsFor(["kalman"])).toEqual({kalman: UNIT_VERSIONS.kalman});
    });
});
