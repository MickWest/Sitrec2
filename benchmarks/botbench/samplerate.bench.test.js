/**
 * samplerate.bench.test.js — SAMPLE-RATE STUDY: what changes when the same
 * 60 s encounter is observed at 1 Hz (ADS-B-like), 5 Hz, 10 Hz (benchmark
 * reference), and 30 Hz (video-like)?
 *
 *     BOTBENCH_RATES=1 npm run bench-bot-rate          # one rate per process
 *     BOTBENCH_RATES=1,30 BOTBENCH_RATE_LIMIT=3 ...    # smoke subset
 *
 * Design (per rate): 2 platforms (orbit-point = recoverable geometry,
 * straight = range-degenerate) x 3 targets x 3 observation models x 3 seeds
 * = 54 scenarios. Deterministic truths — party-neutral balloon in gust-free
 * "fixed" wind (exact advection) and the analytic aircraft-turn — sample the
 * IDENTICAL continuous path at every rate, isolating the rate effect. The
 * bird target is seeded per-rate (truthKey includes fps), so bird rows are a
 * statistical comparison only, never a matched-truth one.
 *
 * Mechanisms this separates:
 *   information — white per-sample noise: more samples should average down;
 *   noise color — wobble is time-correlated: extra samples are redundant;
 *   dynamics    — do splines/KS miss maneuvers between 1 Hz samples?
 *   geometry    — conditioning/collapse should be rate-invariant;
 *   cost        — solver wall time vs n.
 *
 * Output: results/samplerate-records-<fps>.jsonl (one file per rate).
 * Analysis/report: results/samplerate-report.md (written by the analysis
 * step, not this bench).
 */

import fs from "fs";
import path from "path";
import {setSit} from "../../src/Globals";
import {PLATFORM_SPECS} from "./lib/blocks";
import {generateAllScenarios, runSolver, sanitize} from "./lib/runner";
import {SOLVERS} from "./lib/solvers";
import {PHYSICS_SOLVERS, truthMeanWind} from "./lib/physicsSolvers";

const RESULTS_DIR = path.resolve(__dirname, "results");

const RATES = (process.env.BOTBENCH_RATES ?? "1,5,10,30")
    .split(",").map((s) => parseInt(s.trim(), 10)).filter((v) => v > 0);
const LIMIT = parseInt(process.env.BOTBENCH_RATE_LIMIT ?? "0", 10);
const PROGRESS_FILE = process.env.BOTBENCH_PROGRESS_FILE ?? null;

const DURATION_S = 60;
const SEEDS = [601, 602, 603];
const HEAVY_SEED = 601;   // DE physics trio runs only on this seed's scenarios

const TARGETS = [
    {id: "party-neutral", rangeM: 2000,
        target: {kind: "party-neutral", family: "balloon", parameters: {startAGL: 500}}},
    {id: "aircraft-turn", rangeM: 20000,
        target: {kind: "aircraft-turn", family: "aircraft", parameters: {}}},
    {id: "bird", rangeM: 2000,
        target: {kind: "bird", family: "bird", parameters: {}}},
];

const OBSERVATIONS = {
    "clean":  {kind: "clean", fovFullDeg: 0.5},
    "white":  {kind: "white", fovFullDeg: 0.5, gaussianSigmaDeg: 0.03},
    // Same wobble parameters and FOV as the MATCHED-NOISE block.
    "wobble": {kind: "wobble", fovFullDeg: 0.9, wobble: {amplitude: 0.15,
        driftSpeed: 0.10, reactionTime: 0.4, correctionSpeed: 1.0, accuracy: 0.8}},
};

const FAST_IDS = new Set(["cv", "ca", "ks-default", "alsq2", "fixed-point"]);
const SPLINE_IDS = new Set(["min-accel", "min-speed"]);
const HEAVY_IDS = new Set(["physics-lantern", "physics-quadcopter", "physics-fixedwing"]);

function buildEntries(fps) {
    const out = [];
    for (const platformId of ["orbit-point", "straight"])
        for (const t of TARGETS)
            for (const obsId of Object.keys(OBSERVATIONS))
                for (const scenarioSeed of SEEDS) {
                    out.push({blockId: "RATE-STUDY", scenarioSeed, spec: {
                        blockId: "RATE-STUDY",
                        durationSeconds: DURATION_S, fps,
                        initialHorizontalRangeM: t.rangeM,
                        siteId: "flat-reference",
                        platform: PLATFORM_SPECS[platformId],
                        target: t.target,
                        wind: {kind: "fixed"},
                        observation: {...OBSERVATIONS[obsId]},
                        pairId: null,
                    }});
                }
    return out;
}

async function runSolverAsync(scenario, solver) {
    const t0 = Date.now();
    let estimate = null, status = "ok", error = null;
    try {
        estimate = await solver.run(scenario);
        if (!estimate) status = "null-result";
    } catch (e) {
        status = "exception";
        error = {name: e?.name ?? "Error", message: String(e?.message ?? e)};
    }
    const wallMs = Date.now() - t0;
    const base = runSolver(scenario, {id: solver.id, family: solver.family,
        outputKind: solver.outputKind, options: solver.options,
        run: () => estimate});
    base.status = status === "ok" ? base.status : status;
    base.error = error ?? base.error;
    base.timing = {wallMs};
    return base;
}

function progress(line) {
    console.log(`[rate] ${line}`);
    if (PROGRESS_FILE) fs.appendFileSync(PROGRESS_FILE, line + "\n");
}

describe("BOT Bench — sample-rate study (1/5/10/30 Hz)", () => {
    jest.setTimeout(6 * 60 * 60 * 1000);

    beforeAll(() => {
        setSit({name: "botbench-rate", frames: 10000, fps: 10, simSpeed: 1, lat: 40, lon: -105});
    });

    test("solvers vs sample rate", async () => {
        const fastSolvers = SOLVERS.filter((s) => FAST_IDS.has(s.id));
        const splineSolvers = PHYSICS_SOLVERS.filter((s) => SPLINE_IDS.has(s.id));
        const heavySolvers = PHYSICS_SOLVERS.filter((s) => HEAVY_IDS.has(s.id));

        for (const fps of RATES) {
            const entries = buildEntries(fps);
            let scenarios = generateAllScenarios(entries,
                {log: (m) => console.log(`[rate ${fps}Hz] ${m}`)});
            if (LIMIT > 0) scenarios = scenarios.slice(0, LIMIT);
            progress(`${fps}Hz: ${scenarios.length} scenarios, n=${scenarios[0]?.n}`);

            const records = [];
            let i = 0;
            for (const scenario of scenarios) {
                i++;
                for (const solver of fastSolvers) records.push(runSolver(scenario, solver));
                for (const solver of splineSolvers) {
                    records.push(await runSolverAsync(scenario, solver));
                }
                if (scenario.scenarioSeed === HEAVY_SEED) {
                    for (const solver of heavySolvers) {
                        const rec = await runSolverAsync(scenario, solver);
                        if (solver.id === "physics-lantern" && rec.status === "ok") {
                            const tw = truthMeanWind(scenario);
                            const ps = rec.estimateSummary?.parameterSummary ?? {};
                            if (Number.isFinite(ps.windE) && Number.isFinite(ps.windN)) {
                                rec.windRecovery = {truthU: tw.u, truthV: tw.v,
                                    solvedU: ps.windE, solvedV: ps.windN,
                                    errorMS: Math.hypot(ps.windE - tw.u, ps.windN - tw.v)};
                            }
                        }
                        records.push(rec);
                        progress(`${fps}Hz ${i}/${scenarios.length} `
                            + `${scenario.spec.target.kind} ${solver.id}: ${rec.status} `
                            + `${Math.round(rec.timing.wallMs)} ms`);
                    }
                } else {
                    progress(`${fps}Hz ${i}/${scenarios.length} ${scenario.spec.target.kind} fast+splines done`);
                }
            }

            fs.mkdirSync(RESULTS_DIR, {recursive: true});
            fs.writeFileSync(
                path.join(RESULTS_DIR, `samplerate-records-${fps}.jsonl`),
                records.map((r) => JSON.stringify(sanitize(r))).join("\n") + "\n");
            progress(`${fps}Hz DONE: ${records.length} records written`);

            const exceptions = records.filter((r) => r.status === "exception");
            if (exceptions.length) {
                console.log(`[rate ${fps}Hz] exceptions:`, exceptions.slice(0, 5)
                    .map((r) => `${r.runId}: ${r.error?.message}`));
            }
            expect(exceptions.length).toBe(0);
            expect(records.some((r) => r.status === "ok")).toBe(true);
        }
    });
});
