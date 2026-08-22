/**
 * botbench.bench.test.js — the BOT Bench sweep (bearings-only tracking).
 *
 * NOT part of the normal test run (benchmarks/ is in testPathIgnorePatterns).
 * Run deliberately:
 *
 *     npm run bench-bot                          # full 855-scenario sweep
 *     BOTBENCH_BLOCKS=GEO-DURATION npm run bench-bot   # subset by block id
 *
 * Contract: benchmarks/botbench/PLAN.md (v2, the agreed contract). Assertions
 * here are loose invariants — the real output is
 * benchmarks/botbench/results/{records.jsonl, scenarios.jsonl, summary.md}.
 * Timings under Jest/Babel are ratios, not absolute (~17x slower than a
 * production bundle — see losFitting.bench.test.js).
 */

import fs from "fs";
import path from "path";
import {setSit} from "../../src/Globals";
import {buildAllScenarioEntries, EXPECTED_TOTAL} from "./lib/blocks";
import {generateAllScenarios, runSweep, aggregate, sanitize, axesOf} from "./lib/runner";

const RESULTS_DIR = path.resolve(__dirname, "results");

const fmt = (v, d = 3) => (v === null || v === undefined || !Number.isFinite(v))
    ? "-" : v.toFixed(d);

function renderSummary(agg, scenarios, records) {
    const lines = [];
    lines.push("# BOT Bench results (M2 descriptive sweep)");
    lines.push("");
    lines.push(`Scenarios: ${scenarios.length}   solver runs: ${records.length}`);
    lines.push("");

    const SUMMARY_SOLVERS = new Set(["cv", "ks-default", "fixed-point"]);
    lines.push("## Q1/Q2 — GEO-DURATION: median(mean 3D sep / truth range) by platform x RANGE x duration");
    lines.push("");
    lines.push("(cv / ks-default / fixed-point only — full grouping in records.jsonl. "
        + "failRate counts non-ok, on-sensor-collapsed, and >50% median relative "
        + "range error runs over ALL group members.)");
    lines.push("");
    lines.push("| platform | range km | dur s | solver | relSep med | relSep IQR | clean resid deg | obs resid deg | fail rate |");
    lines.push("|---|---:|---:|---|---:|---:|---:|---:|---:|");
    const q12 = [...agg.q12]
        .filter((r) => SUMMARY_SOLVERS.has(r.solverId))
        .sort((a, b) =>
            a.platformKind.localeCompare(b.platformKind)
            || a.rangeM - b.rangeM
            || a.durationSeconds - b.durationSeconds
            || a.solverId.localeCompare(b.solverId));
    for (const r of q12) {
        lines.push(`| ${r.platformKind} | ${(r.rangeM / 1000).toFixed(0)} | ${r.durationSeconds} `
            + `| ${r.solverId} `
            + `| ${fmt(r.relSep.med, 4)} | ${fmt(r.relSep.q1, 4)}..${fmt(r.relSep.q3, 4)} `
            + `| ${fmt(r.cleanResidualDeg, 4)} | ${fmt(r.observedResidualDeg, 4)} `
            + `| ${fmt(r.failRate, 2)} |`);
    }
    lines.push("");

    lines.push("## Q3 — PAIRED wobble minus matched-white contrasts (same truth/seed)");
    lines.push("");
    lines.push("(pairedDelta = wobble sep - white sep per pair, metres; guarded ratio "
        + "only when white sep > 1 m; pairs with a failed/collapsed member counted "
        + "in failed, never silently dropped. RECOVERABLE-NOISE rows are GATED on "
        + "the same solver's paired clean run recovering (clean relSep <= 0.10); "
        + "cleanFail counts pairs dropped by that gate. MATCHED-NOISE has no clean "
        + "members: ungated rows measure observability loss, not accuracy.)");
    lines.push("");
    lines.push("| block | platform | target | dur s | solver | gated | pairs | cleanFail | failed | delta med m | delta IQR | ratio med | white med m |");
    lines.push("|---|---|---|---:|---|---|---:|---:|---:|---:|---:|---:|---:|");
    const q3 = [...agg.q3].sort((a, b) =>
        a.blockId.localeCompare(b.blockId)
        || a.platformKind.localeCompare(b.platformKind)
        || a.targetFamily.localeCompare(b.targetFamily)
        || a.durationSeconds - b.durationSeconds
        || a.solverId.localeCompare(b.solverId));
    for (const r of q3) {
        lines.push(`| ${r.blockId} | ${r.platformKind} | ${r.targetFamily} | ${r.durationSeconds} `
            + `| ${r.solverId} | ${r.gated ? "yes" : "no"} | ${r.pairs} `
            + `| ${r.pairsCleanUnrecoverable} | ${r.pairsFailed} `
            + `| ${fmt(r.pairedDeltaM.med, 1)} | ${fmt(r.pairedDeltaM.q1, 1)}..${fmt(r.pairedDeltaM.q3, 1)} `
            + `| ${fmt(r.guardedRatio.med, 2)} | ${fmt(r.whiteSepM, 1)} |`);
    }
    lines.push("");

    lines.push("## Q5 — ANOMALY-CONTROL: event-blind ROC AUC (globalPeakRobustZ, anomalous vs control)");
    lines.push("");
    lines.push("| solver | AUC all | clean | matched-white | wobble | paired dExcess med | IQR | n anom | n ctrl | collapsed |");
    lines.push("|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
    for (const r of [...agg.q5].sort((a, b) => a.solverId.localeCompare(b.solverId))) {
        lines.push(`| ${r.solverId} | ${fmt(r.aucAll, 3)} | ${fmt(r.perNoise.clean, 3)} `
            + `| ${fmt(r.perNoise["matched-white"], 3)} | ${fmt(r.perNoise.wobble, 3)} `
            + `| ${fmt(r.pairedExcessDelta?.med, 3)} `
            + `| ${fmt(r.pairedExcessDelta?.q1, 3)}..${fmt(r.pairedExcessDelta?.q3, 3)} `
            + `| ${r.nAnom} | ${r.nCtrl} | ${fmt(r.collapsedRate, 2)} |`);
    }
    lines.push("");
    lines.push("Collapsed (on-sensor) estimates are COUNTED as non-detections "
        + "(flat 180 deg residual per the meanAngularError convention, robust-Z 0) "
        + "and reported in the collapsed column — never silently omitted.");
    lines.push("");

    lines.push("## TARGET-WIND: relSep by target x wind (cv / ks-default / fixed-point)");
    lines.push("");
    lines.push("| target | wind | solver | relSep med | fail rate | n |");
    lines.push("|---|---|---|---:|---:|---:|");
    for (const r of [...agg.targetWind]
        .filter((r) => SUMMARY_SOLVERS.has(r.solverId))
        .sort((a, b) => a.targetKind.localeCompare(b.targetKind)
            || a.windKind.localeCompare(b.windKind)
            || a.solverId.localeCompare(b.solverId))) {
        lines.push(`| ${r.targetKind} | ${r.windKind} | ${r.solverId} `
            + `| ${fmt(r.relSep.med, 4)} | ${fmt(r.failRate, 2)} | ${r.n} |`);
    }
    lines.push("");

    lines.push("## HAB-LONG-RANGE: relSep by platform x range (cv / ks-default / fixed-point)");
    lines.push("");
    lines.push("| platform | range km | solver | relSep med | fail rate | n |");
    lines.push("|---|---:|---|---:|---:|---:|");
    for (const r of [...agg.hab]
        .filter((r) => SUMMARY_SOLVERS.has(r.solverId))
        .sort((a, b) => a.platformKind.localeCompare(b.platformKind)
            || a.rangeM - b.rangeM
            || a.solverId.localeCompare(b.solverId))) {
        lines.push(`| ${r.platformKind} | ${(r.rangeM / 1000).toFixed(0)} | ${r.solverId} `
            + `| ${fmt(r.relSep.med, 4)} | ${fmt(r.failRate, 2)} | ${r.n} |`);
    }
    lines.push("");

    lines.push("## Venus (direction truth): finite-solver behavior");
    lines.push("");
    lines.push("| solver | med dir err deg | fitted range med m | IQR | behind-sensor rate |");
    lines.push("|---|---:|---:|---:|---:|");
    for (const r of [...agg.venusTable].sort((a, b) => a.solverId.localeCompare(b.solverId))) {
        lines.push(`| ${r.solverId} | ${fmt(r.meanDirErrDeg, 4)} `
            + `| ${fmt(r.fittedRangeMeanM.med, 0)} `
            + `| ${fmt(r.fittedRangeMeanM.q1, 0)}..${fmt(r.fittedRangeMeanM.q3, 0)} `
            + `| ${fmt(r.behindSensorRate, 2)} |`);
    }
    lines.push("");

    lines.push("## Status counts per block x solver");
    lines.push("");
    lines.push("| block | solver | total | statuses |");
    lines.push("|---|---|---:|---|");
    for (const r of [...agg.statusTable].sort((a, b) =>
        a.blockId.localeCompare(b.blockId) || a.solverId.localeCompare(b.solverId))) {
        lines.push(`| ${r.blockId} | ${r.solverId} | ${r.total} | `
            + `${Object.entries(r.counts).map(([k, v]) => `${k}:${v}`).join(" ")} |`);
    }
    lines.push("");
    return lines.join("\n");
}

describe("BOT Bench sweep", () => {
    jest.setTimeout(60 * 60 * 1000);

    beforeAll(() => {
        setSit({name: "botbench", frames: 10000, fps: 10, simSpeed: 1, lat: 40, lon: -105});
    });

    test("generates the scenario matrix and runs all solver configurations", () => {
        const entries = buildAllScenarioEntries();
        expect(entries.length).toBe(EXPECTED_TOTAL);

        const filterEnv = process.env.BOTBENCH_BLOCKS;
        const blockFilter = filterEnv ? new Set(filterEnv.split(",")) : null;

        const tGen0 = Date.now();
        const scenarios = generateAllScenarios(entries, {
            blockFilter, log: (m) => console.log(`[botbench] ${m}`),
        });
        const genMs = Date.now() - tGen0;
        expect(scenarios.length).toBeGreaterThan(0);

        const tRun0 = Date.now();
        const records = runSweep(scenarios, {
            log: (m) => console.log(`[botbench] ${m}`),
            mc2: !blockFilter,   // sentinels only make sense on the full grid
        });
        const runMs = Date.now() - tRun0;

        const agg = aggregate(records);
        const summary = renderSummary(agg, scenarios, records);

        fs.mkdirSync(RESULTS_DIR, {recursive: true});
        fs.writeFileSync(path.join(RESULTS_DIR, "records.jsonl"),
            records.map((r) => JSON.stringify(sanitize(r))).join("\n") + "\n");
        fs.writeFileSync(path.join(RESULTS_DIR, "scenarios.jsonl"),
            scenarios.map((s) => JSON.stringify(sanitize({
                scenarioId: s.scenarioId, scenarioGroupId: s.scenarioGroupId,
                blockId: s.blockId, pairId: s.pairId, scenarioSeed: s.scenarioSeed,
                axes: axesOf(s), spec: s.spec,
                diagnostics: s.diagnostics,
                observation: {
                    realizedRmsDegAllFrames: s.observation.realizedRmsDegAllFrames,
                    realizedRmsDegActiveFrames: s.observation.realizedRmsDegActiveFrames,
                    outOfFrameFraction: s.observation.outOfFrameFraction,
                },
                feasibility: s.platform.feasibility,
                events: s.events,
            }))).join("\n") + "\n");
        fs.writeFileSync(path.join(RESULTS_DIR, "summary.md"), summary);
        fs.writeFileSync(path.join(RESULTS_DIR, "meta.json"), JSON.stringify({
            generatedAtISO: new Date().toISOString(),
            scenarios: scenarios.length,
            records: records.length,
            blockFilter: filterEnv ?? null,
            generateMs: genMs,
            sweepMs: runMs,
            jestBabelCaveat: "timings are ratios, not production speeds",
        }, null, 2));

        console.log(`\n[botbench] generation ${genMs} ms, sweep ${runMs} ms`);
        console.log(`[botbench] wrote ${records.length} records to ${RESULTS_DIR}`);
        console.log("\n" + summary);

        // Loose invariants only (machine-independent).
        const okCount = records.filter((r) => r.status === "ok").length;
        expect(okCount).toBeGreaterThan(records.length * 0.7);
        const exceptions = records.filter((r) => r.status === "exception");
        if (exceptions.length) {
            console.log("[botbench] exceptions:",
                exceptions.slice(0, 5).map((r) => `${r.runId}: ${r.error.message}`));
        }
        expect(exceptions.length).toBe(0);
    });
});
