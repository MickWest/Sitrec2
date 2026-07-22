/**
 * NelderMeadIdentifiability.test.js — the settled-vs-unfinished distinction
 * behind the lantern "Optimizer incomplete" fix (BOT Bench round-2 lead: a
 * genuine easy balloon was badged incomplete because its solved flame-out lay
 * beyond the clip, leaving sink/cool-down parameters with zero trajectory
 * effect — the simplex stays wide in exactly those dimensions forever).
 *
 * Pins: (1) NelderMead reports per-dimension spreads + final cost spread;
 * (2) an INERT dimension yields iteration_limit with a settled cost and
 * width confined to that dimension; (3) settledButUnidentifiable converts
 * that — and ONLY that — case into a note instead of a warning.
 */

import {nelderMead} from "../src/NelderMead";
import {localFitCompletionWarnings, settledButUnidentifiable} from "../src/TraverseRanking";

function asOptimizerMeta(result, paramNames) {
    // mirror fitPhysicsModel's packaging (LOSFitting.js optimizer block)
    return {
        stopReason: result.stopReason,
        iterations: result.iterations,
        parameterSpread: result.parameterSpread,
        parameterSpreads: result.parameterSpreads,
        paramNames,
        costSpread: result.costSpread,
        tol: result.tol,
        xTol: result.xTol,
    };
}

describe("Nelder-Mead identifiability metadata", () => {
    test("an unfinished search reports iteration_limit with UNsettled cost spread", async () => {
        // Rosenbrock at a tiny budget: the classic genuinely-unfinished stop.
        const r = await nelderMead(
            (x) => 100 * (x[1] - x[0] * x[0]) ** 2 + (1 - x[0]) ** 2,
            [-1.5, 2], {maxIter: 8, lo: [-5, -5], hi: [5, 5]});
        expect(r.stopReason).toBe("iteration_limit");
        expect(Array.isArray(r.parameterSpreads)).toBe(true);
        expect(r.parameterSpreads.length).toBe(2);
        expect(r.costSpread).toBeGreaterThan(r.tol);   // NOT settled
        expect(Number.isFinite(r.tol)).toBe(true);
        expect(Number.isFinite(r.xTol)).toBe(true);
    });

    test("a fully identifiable objective converges normally with tight metadata", async () => {
        const r = await nelderMead((x) => (x[0] - 1) ** 2 + (x[1] + 2) ** 2, [0, 0], {
            maxIter: 4000, lo: [-10, -10], hi: [10, 10],
        });
        expect(r.stopReason).toBe("cost_and_parameter_tolerance");
        expect(Math.max(...r.parameterSpreads)).toBeLessThan(r.xTol);
        expect(r.costSpread).toBeLessThan(r.tol);
    });
});

describe("settledButUnidentifiable", () => {
    // The lantern-shaped metadata: objective settled (cost spread far below
    // tol) while lifecycle dimensions stay wide. In production this arises
    // from the 12-D fit's epsilon-noise plateau (RK4 cost noise keeps NM
    // reflecting along flat lifecycle directions instead of shrinking) —
    // not reproducible with a low-dimensional toy, so the classifier contract
    // is pinned directly and the end-to-end case lives in the botbench
    // lantern repro bench.
    const settledMeta = (over = {}) => ({
        stopReason: "iteration_limit",
        iterations: 5000,
        parameterSpread: 0.3,
        parameterSpreads: [1e-9, 1e-8, 0.3, 0.12, 0.2],
        paramNames: ["range", "windE", "tauCool", "vSink", "tBurn"],
        // simplex extremes: tBurn spans [70, 300] — entirely beyond a 60 s clip
        parameterMins: [4990, 5.9, 20, 0.2, 70],
        parameterMaxs: [4991, 6.1, 200, 2.5, 300],
        costSpread: 1e-12,
        tol: 1e-8,
        xTol: 1e-6,
        ...over,
    });

    test("converts the settled wide-lifecycle case into a note", () => {
        const meta = settledMeta();
        const note = settledButUnidentifiable(meta, ["tauCool", "vSink", "tBurn"],
            {tBurn: 60});
        expect(note).toMatch(/tauCool, vSink/);
        expect(note).toMatch(/identifiability limit/);
        // The generic warning would have fired without the classification:
        expect(localFitCompletionWarnings(meta).length).toBe(1);
    });

    test("refuses when the simplex CROSSES into the observable region", () => {
        // tBurn simplex straddles the clip end (min 45 s < 60 s clip): a real
        // still-burning/already-cooling ambiguity — must stay incomplete.
        const meta = settledMeta({parameterMins: [4990, 5.9, 20, 0.2, 45]});
        expect(settledButUnidentifiable(meta, ["tauCool", "vSink", "tBurn"],
            {tBurn: 60})).toBeNull();
    });

    test("refuses conservatively when simplex minima metadata is missing", () => {
        const meta = settledMeta({parameterMins: undefined});
        expect(settledButUnidentifiable(meta, ["tauCool", "vSink", "tBurn"],
            {tBurn: 60})).toBeNull();
        // ...but still classifies when no minima requirement is demanded.
        expect(settledButUnidentifiable(meta, ["tauCool", "vSink", "tBurn"]))
            .toMatch(/identifiability limit/);
    });

    test("refuses when a NON-allowed dimension is still wide", () => {
        // range itself is wide: genuinely unfinished, keep the warning.
        const meta = settledMeta({parameterSpreads: [0.2, 1e-8, 0.3, 0.12]});
        expect(settledButUnidentifiable(meta, ["tauCool", "vSink", "tBurn"])).toBeNull();
    });

    test("refuses when the objective is NOT settled", async () => {
        // Rosenbrock at a tiny budget: iteration_limit with genuinely
        // unfinished cost — must stay a warning.
        const r = await nelderMead(
            (x) => 100 * (x[1] - x[0] * x[0]) ** 2 + (1 - x[0]) ** 2,
            [-1.5, 2], {maxIter: 8, lo: [-5, -5], hi: [5, 5]});
        expect(r.stopReason).toBe("iteration_limit");
        const meta = asOptimizerMeta(r, ["a", "b"]);
        expect(settledButUnidentifiable(meta, ["a", "b"])).toBeNull();
        expect(localFitCompletionWarnings(meta).length).toBe(1);
    });

    test("refuses on converged fits and missing metadata (backward compatible)", () => {
        expect(settledButUnidentifiable(
            {stopReason: "cost_and_parameter_tolerance"}, ["x"])).toBeNull();
        expect(settledButUnidentifiable(
            {stopReason: "iteration_limit"}, ["x"])).toBeNull();   // no spreads
        expect(settledButUnidentifiable(null, ["x"])).toBeNull();
    });
});
