/**
 * lantern-incomplete.bench.test.js — reproduce the round-2 lead headless:
 * the live gallery badged the Sky Lantern/Balloon fit "Optimizer incomplete"
 * on a GENUINE easy balloon (the bridged orbit-balloon-5km-60s scenario that
 * Constant Altitude recovered exactly).
 *
 *     npx jest benchmarks/botbench/lantern-incomplete.bench.test.js \
 *         --testPathIgnorePatterns /node_modules/ --forceExit
 *
 * Runs the production physics fit (fitPhysicsModel + SkyLanternModel, DE +
 * Nelder-Mead polish) on that exact scenario's sightlines and prints the new
 * optimizer identifiability metadata: stop reason, final cost spread, and
 * per-parameter simplex spreads. The printed evidence decides which branch
 * badged the tile:
 *   - settled cost + width confined to {vSink, tauCool, tBurn} with solved
 *     tBurn beyond the clip  -> the settledButUnidentifiable classification
 *     applies (identifiability limit, not an unfinished search);
 *   - unsettled cost or width in range/wind dims -> genuinely incomplete,
 *     and the fix must NOT suppress the warning.
 * Assertions are loose invariants; the numbers are the point (bench style).
 */

import {setSit} from "../../src/Globals";
import {fitPhysicsModel} from "../../src/LOSFitting";
import {SkyLanternModel} from "../../src/SkyLanternModel";
import {settledButUnidentifiable, localFitCompletionWarnings} from "../../src/TraverseRanking";
import {generateScenario} from "./lib/generateScenario";
import {toLOSDataset} from "./lib/adapters";

describe("lantern optimizer-incomplete repro (production fit path)", () => {
    jest.setTimeout(15 * 60 * 1000);

    beforeAll(() => {
        setSit({name: "botbench-lantern", frames: 10000, fps: 10, simSpeed: 1, lat: 35, lon: -125});
    });

    test("genuine balloon: which stop condition does the lantern fit hit?", async () => {
        // The exact bridged scenario (ocean site, clean observation — the
        // in-app run had constructed LOS, i.e. effectively clean too).
        const scenario = generateScenario({
            durationSeconds: 60, fps: 10, initialHorizontalRangeM: 5000,
            siteId: "ocean",
            platform: {kind: "orbit-point", speedMS: 70, altitudeAGL: 3000},
            target: {kind: "party-neutral", family: "balloon", parameters: {startAGL: 500}},
            wind: {kind: "fixed"},
            observation: {kind: "clean", fovFullDeg: 0.5},
        }, {scenarioSeed: 101});

        const ds = toLOSDataset(scenario);
        const clipT = (scenario.n - 1) / scenario.fps;
        const model = new SkyLanternModel();
        model.clipDuration = clipT;

        // DE + NM polish — the production optimizer recipe. The DE budget is
        // moderate (bench runtime); the identifiability mechanism under test
        // is in the NM polish stop condition, which runs at full fidelity.
        const fit = await fitPhysicsModel(ds, new Set(), model, {
            optimizer: "de", dePop: 30, deGens: 40, sampleStride: 2,
        });
        expect(fit).not.toBeNull();

        const opt = fit.params.optimizer;
        const solved = fit.params.solved ?? {};
        const spreads = (opt.parameterSpreads ?? [])
            .map((s, j) => `${opt.paramNames?.[j] ?? j}=${s.toExponential(1)}`)
            .join("  ");
        console.log("\nLANTERN FIT STOP CONDITION (genuine easy balloon)");
        console.log(`  stopReason      ${opt.stopReason}   iterations ${opt.iterations}`);
        console.log(`  costSpread      ${opt.costSpread?.toExponential?.(2)}   (tol ${opt.tol})`);
        console.log(`  spreads         ${spreads}`);
        console.log(`  solved tBurn    ${solved.tBurn?.toFixed?.(1)} s   (clip ${clipT} s)`);
        console.log(`  errDeg          ${fit.params.errDeg?.toFixed?.(4)}`);

        const allowed = ["vSink", "tauCool", "tBurn"];
        const note = (Number.isFinite(solved.tBurn) && solved.tBurn >= clipT)
            ? settledButUnidentifiable(opt, allowed) : null;
        const warnings = localFitCompletionWarnings(opt);
        console.log(`  classification  ${note ? "IDENTIFIABILITY NOTE: " + note
            : warnings.length ? "GENUINE INCOMPLETE: " + warnings[0]
            : "converged (" + opt.stopReason + ")"}`);

        // Loose invariants: the fit must be a recognizable balloon (range in
        // the right decade), and the classification must be internally
        // consistent — a note and a warning can never both apply.
        expect(fit.params.errDeg).toBeLessThan(2);
        if (note) expect(warnings.length).toBeGreaterThan(0);   // note replaces a REAL warning
    });
});
