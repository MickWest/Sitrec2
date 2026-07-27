/**
 * physics.bench.test.js — ROUND 2: Sitrec's flagship solvers vs the benchmark.
 *
 *     npm run bench-bot-physics                  # ~140 cells, 1-3 h wall
 *     BOTBENCH_PHYSICS_LIMIT=4 npm run bench-bot-physics    # smoke subset
 *
 * Runs the physics fits (lantern / quadcopter / fixed-wing), the spline
 * methods (min-accel / min-speed), and — for head-to-head context on the
 * same cells — CV and the default Kalman smoother, against a ~140-scenario
 * selection spanning every regime: recoverable noise cells, the geometry/
 * duration axis including collapse, all balloon families x winds, HAB long
 * range, and the anomaly/control pairs.
 *
 * Paper questions this feeds:
 *   Q6 does the balloon fit recover genuine balloons (range + wind)?
 *   Q7 the free quadcopter as the anomaly-reachable fit: what does it do
 *      on anomalies vs ordinary maneuvers?
 *   Q8 min-accel/min-speed range finding vs truth across geometry.
 *   Q9 flagship vs cheap solvers, per regime.
 *
 * Output: results/physics-records.jsonl + results/physics-summary.md.
 * Bench-style: loose invariants, the tables are the point. DE budgets are
 * the moderate deterministic test budgets (see physicsSolvers.js) — fair
 * across solvers here, slightly below in-app production budgets.
 */

import fs from "fs";
import path from "path";
import {setSit} from "../../src/Globals";
import {buildAllScenarioEntries} from "./lib/blocks";
import {generateAllScenarios, runSolver, sanitize} from "./lib/runner";
import {SOLVERS} from "./lib/solvers";
import {PHYSICS_SOLVERS, truthMeanWind} from "./lib/physicsSolvers";
import {computeMetrics} from "./lib/metrics";

const RESULTS_DIR = path.resolve(__dirname, "results");
const fmt = (v, d = 3) => (v === null || v === undefined || !Number.isFinite(v))
    ? "-" : v.toFixed(d);

// ---- cell selection (reuses round-1 scenario entries verbatim) -------------
function selectEntries(entries) {
    return entries.filter((e) => {
        const s = e.spec;
        const p = s.platform.kind;
        switch (e.blockId) {
            case "RECOVERABLE-NOISE":
                return true;                                    // 90
            case "GEO-DURATION":
                return e.scenarioSeed === 101
                    && (p === "orbit-point" || p === "straight")
                    && s.durationSeconds !== 5;                  // 12
            case "TARGET-WIND":
                return e.scenarioSeed === 201 && p === "orbit-point";   // 20
            case "HAB-LONG-RANGE":
                return e.scenarioSeed === 211
                    && (p === "orbit-point" || p === "straight")
                    && s.target.parameters.mslKm === 18;         // 6
            case "ANOMALY-CONTROL":
                return e.scenarioSeed === 401 && p === "orbit-point"
                    && s.observation.kind === "clean";           // 12
            default:
                return false;
        }
    });
}

// Async-aware variant of runSolver for the physics fits (runner.runSolver is
// sync). Same record shape, same metrics.
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
        run: () => estimate});   // reuse record assembly with the finished estimate
    // runSolver re-ran metrics on our estimate (or recorded the failure);
    // overwrite its timing/status bookkeeping with the real ones.
    base.status = status === "ok" ? base.status : status;
    base.error = error ?? base.error;
    base.timing = {wallMs};
    return base;
}

describe("BOT Bench round 2 — flagship solvers", () => {
    jest.setTimeout(6 * 60 * 60 * 1000);

    beforeAll(() => {
        setSit({name: "botbench-physics", frames: 10000, fps: 10, simSpeed: 1, lat: 40, lon: -105});
    });

    test("physics + spline solvers across the selected regimes", async () => {
        const selected = selectEntries(buildAllScenarioEntries());
        const limit = parseInt(process.env.BOTBENCH_PHYSICS_LIMIT ?? "0", 10);
        const offset = parseInt(process.env.BOTBENCH_PHYSICS_OFFSET ?? "0", 10);
        const all = generateAllScenarios(selected, {
            log: (m) => console.log(`[physics] ${m}`),
        });
        const scenarios = all.slice(offset, limit > 0 ? offset + limit : undefined);
        console.log(`[physics] ${scenarios.length} scenarios (offset ${offset} of ${all.length})`);

        const cheap = SOLVERS.filter((s) => s.id === "cv" || s.id === "ks-default");
        const records = [];
        let i = 0;
        for (const scenario of scenarios) {
            i++;
            for (const solver of cheap) {
                records.push(runSolver(scenario, solver));
            }
            for (const solver of PHYSICS_SOLVERS) {
                const rec = await runSolverAsync(scenario, solver);
                // lantern wind recovery vs truth (paper Q6)
                if (solver.id === "physics-lantern" && rec.status === "ok") {
                    const tw = truthMeanWind(scenario);
                    const ps = rec.estimateSummary?.parameterSummary ?? {};
                    if (Number.isFinite(ps.windE) && Number.isFinite(ps.windN)) {
                        rec.windRecovery = {
                            truthU: tw.u, truthV: tw.v,
                            solvedU: ps.windE, solvedV: ps.windN,
                            errorMS: Math.hypot(ps.windE - tw.u, ps.windN - tw.v),
                        };
                    }
                }
                records.push(rec);
                console.log(`[physics] ${i}/${scenarios.length} ${scenario.blockId}`
                    + ` ${scenario.spec.target.kind} ${solver.id}: ${rec.status}`
                    + ` ${rec.timing.wallMs} ms`);
                // Jest buffers console output until the test ends, so the
                // parallel driver (run-physics-parallel.mjs) reads live
                // progress from this sidecar file instead.
                if (process.env.BOTBENCH_PROGRESS_FILE) {
                    fs.appendFileSync(process.env.BOTBENCH_PROGRESS_FILE,
                        `${offset} ${i}/${scenarios.length} ${solver.id}`
                        + ` ${rec.status} ${Math.round(rec.timing.wallMs)}\n`);
                }
            }
        }

        // ---- aggregation ---------------------------------------------------
        const ok = records.filter((r) => r.status === "ok"
            && r.metrics?.truth?.kind === "track" && r.metrics.truth.comparable);
        const groups = new Map();
        for (const r of ok) {
            const regime = r.blockId === "ANOMALY-CONTROL"
                ? (r.axes.anomalous ? "anomaly" : "anomaly-control")
                : r.blockId;
            const k = `${regime}|${r.axes.targetKind ?? r.axes.targetFamily}|${r.solver.id}`;
            if (!groups.has(k)) groups.set(k, []);
            groups.get(k).push(r);
        }
        const med = (v) => {
            const s = v.filter(Number.isFinite).sort((a, b) => a - b);
            return s.length ? s[s.length >> 1] : null;
        };

        const lines = [];
        lines.push("# BOT Bench round 2 — flagship solvers vs truth");
        lines.push("");
        lines.push(`Scenarios: ${scenarios.length}  records: ${records.length}. `
            + "DE budgets are the moderate deterministic bench budgets (see "
            + "physicsSolvers.js) — cross-solver comparisons here are fair; "
            + "absolute in-app quality may be modestly better.");
        lines.push("");
        lines.push("## Truth recovery by regime x target x solver");
        lines.push("");
        lines.push("| regime | target | solver | n | relSep med | clean resid med deg | wall med s |");
        lines.push("|---|---|---|---:|---:|---:|---:|");
        for (const [k, rows] of [...groups].sort((a, b) => a[0].localeCompare(b[0]))) {
            const [regime, target, solverId] = k.split("|");
            lines.push(`| ${regime} | ${target} | ${solverId} | ${rows.length} `
                + `| ${fmt(med(rows.map((r) => r.metrics.truth.meanSeparationM / r.metrics.truth.meanTruthRangeM)), 4)} `
                + `| ${fmt(med(rows.map((r) => r.metrics.angular.cleanMeanDeg)), 4)} `
                + `| ${fmt(med(rows.map((r) => r.timing.wallMs / 1000)), 1)} |`);
        }
        lines.push("");

        lines.push("## Lantern wind recovery (balloon-family cells)");
        lines.push("");
        lines.push("| block | target | wind | truth m/s | solved m/s | error m/s |");
        lines.push("|---|---|---|---:|---:|---:|");
        for (const r of records.filter((r) => r.windRecovery
            && String(r.axes.targetFamily) === "balloon")) {
            const w = r.windRecovery;
            lines.push(`| ${r.blockId} | ${r.axes.targetKind} | ${r.axes.windKind} `
                + `| ${fmt(Math.hypot(w.truthU, w.truthV), 2)} `
                + `| ${fmt(Math.hypot(w.solvedU, w.solvedV), 2)} `
                + `| ${fmt(w.errorMS, 2)} |`);
        }
        lines.push("");

        lines.push("## Status counts");
        lines.push("");
        const statusCounts = new Map();
        for (const r of records) {
            const k = `${r.solver.id}|${r.status}`;
            statusCounts.set(k, (statusCounts.get(k) ?? 0) + 1);
        }
        lines.push("| solver | status | n |");
        lines.push("|---|---|---:|");
        for (const [k, n] of [...statusCounts].sort((a, b) => a[0].localeCompare(b[0]))) {
            const [solverId, status] = k.split("|");
            lines.push(`| ${solverId} | ${status} | ${n} |`);
        }
        lines.push("");

        const out = lines.join("\n");
        fs.mkdirSync(RESULTS_DIR, {recursive: true});
        const suffix = offset > 0 || limit > 0 ? `-${offset}` : "";
        fs.writeFileSync(path.join(RESULTS_DIR, `physics-records${suffix}.jsonl`),
            records.map((r) => JSON.stringify(sanitize(r))).join("\n") + "\n");
        fs.writeFileSync(path.join(RESULTS_DIR, `physics-summary${suffix}.md`), out);
        console.log("\n" + out);

        const exceptions = records.filter((r) => r.status === "exception");
        if (exceptions.length) {
            console.log("[physics] exceptions:", exceptions.slice(0, 5)
                .map((r) => `${r.runId}: ${r.error?.message}`));
        }
        expect(exceptions.length).toBe(0);
        expect(ok.length).toBeGreaterThan(0);
    });
});
