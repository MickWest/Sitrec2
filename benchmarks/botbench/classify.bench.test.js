/**
 * classify.bench.test.js — M3: the Q4 solver-selection protocol over an
 * existing sweep's records (audit-corrected version; see PLAN.md
 * "Post-audit amendments" and the Codex M3 audit).
 *
 *     npm run bench-bot-classify        (after `npm run bench-bot`)
 *
 * POST-HOC CAVEAT (recorded per audit): the original test partition was
 * observed before the audit corrections; models here are refit on the
 * repaired grouping with unchanged form and no test-driven hyperparameters,
 * but the re-evaluation is labeled audit-corrected, not a fresh preregistered
 * result. Direction-regime conclusions rely on the sentinel pool (core
 * direction groups are too few to reach the test split).
 */

import fs from "fs";
import path from "path";
import {
    buildUnits, splitUnits, unitWeights, featureNames, fitImputer,
    fitTree, predictTree, evaluate, baselinePredictors, bootstrapCI,
    abstainCurve, fitRegimeDetector, evaluateRegimeDetector, fitLogistic,
    regimeOf, vectorize,
} from "./lib/classifier";

const RESULTS_DIR = path.resolve(__dirname, "results");
const fmt = (v, d = 3) => (v === null || v === undefined || !Number.isFinite(v))
    ? "-" : v.toFixed(d);

function renderTree(node, depth = 0) {
    const pad = "  ".repeat(depth);
    if (node.leaf) {
        return `${pad}=> ${node.predict}  (n=${node.n}, groups=${node.groups}`
            + `${node.expectedLoss !== undefined ? `, expLoss=${node.expectedLoss.toFixed(3)}` : ""})\n`;
    }
    return `${pad}${node.f} <= ${node.thr.toPrecision(4)}?\n`
        + renderTree(node.left, depth + 1)
        + `${pad}${node.f} > ${node.thr.toPrecision(4)}?\n`
        + renderTree(node.right, depth + 1);
}

function renderConfusion(conf) {
    const labels = new Set();
    for (const t of Object.keys(conf)) {
        labels.add(t);
        for (const p of Object.keys(conf[t])) labels.add(p);
    }
    const ls = [...labels].sort();
    const lines = [`| true \\ pred | ${ls.join(" | ")} |`,
        `|---|${ls.map(() => "---:").join("|")}|`];
    for (const t of ls) {
        lines.push(`| ${t} | ${ls.map((p) => {
            const v = conf[t]?.[p] ?? 0;
            return v ? v.toFixed(1) : "";
        }).join(" | ")} |`);
    }
    return lines.join("\n");
}

describe("BOT Bench Q4 classifier (audit-corrected)", () => {
    jest.setTimeout(15 * 60 * 1000);

    test("trains and evaluates the solver-selection rules", () => {
        const recordsPath = path.join(RESULTS_DIR, "records.jsonl");
        expect(fs.existsSync(recordsPath)).toBe(true);
        const records = fs.readFileSync(recordsPath, "utf8").trim().split("\n")
            .map((l) => JSON.parse(l));
        const scenarios = fs.readFileSync(path.join(RESULTS_DIR, "scenarios.jsonl"), "utf8")
            .trim().split("\n").map((l) => JSON.parse(l));
        const specsById = new Map(scenarios.map((s) => [s.scenarioId, s.spec]));

        const units = buildUnits(records, specsById);
        const split = splitUnits(units);
        const {train, val, test, sentinels, unrecoverable} = split;

        // INDEPENDENT leakage guard (audit round 2: asserting on groupId alone
        // is tautological). Recompute a canonical deterministic truth signature
        // straight from the stored specs, with its own construction, and assert
        // every signature maps to exactly one group AND one partition.
        const sigOf = (scenarioId, seed) => {
            const spec = specsById.get(scenarioId);
            const det = ["zero", "fixed", "hab-steady"].includes(spec.wind.kind)
                && !["bird", "tethered-aerostat"].includes(spec.target.kind);
            const p = {...(spec.target.parameters ?? {})};
            delete p.anomalous;
            return JSON.stringify([spec.platform, spec.target.kind, p, spec.wind,
                spec.initialHorizontalRangeM ?? null, det ? "det" : `seed:${seed}`]);
        };
        const partitionOfUnit = new Map();
        for (const [name, set] of Object.entries({train, val, test})) {
            for (const u of set) partitionOfUnit.set(u.scenarioId, name);
        }
        const sigGroup = new Map(), sigPart = new Map();
        for (const u of [...train, ...val, ...test]) {
            const sig = sigOf(u.scenarioId, records.find((r) => r.scenarioId === u.scenarioId).scenarioSeed);
            if (sigGroup.has(sig)) expect(sigGroup.get(sig)).toBe(u.groupId);
            else sigGroup.set(sig, u.groupId);
            const part = partitionOfUnit.get(u.scenarioId);
            if (sigPart.has(sig)) expect(sigPart.get(sig)).toBe(part);
            else sigPart.set(sig, part);
        }

        console.log(`[classify] units ${units.length}: `
            + `${train.length}/${val.length}/${test.length} train/val/test, `
            + `${sentinels.length} sentinels, ${unrecoverable.length} unrecoverable`);
        expect(train.length).toBeGreaterThan(100);

        const names = featureNames(units);
        expect(names).not.toContain("activeNoiseRmsDeg");   // forbidden feature stays out
        const imputer = fitImputer(train, names);
        const wTrain = unitWeights(train);

        const treeBalanced = fitTree(train, names, imputer, wTrain, {mode: "balanced"});
        const treeUnbalanced = fitTree(train, names, imputer, wTrain, {mode: "unbalanced"});
        const treeCost = fitTree(train, names, imputer, wTrain, {mode: "cost"});
        const regime = fitRegimeDetector(train, wTrain);
        const baselines = baselinePredictors(train, wTrain);

        // Logistic sensitivity model: C from {0.01, 0.1, 1, 10} by val macro-F1.
        const wVal = unitWeights(val);
        let logistic = null, bestF1 = -1, bestC = null;
        for (const C of [0.01, 0.1, 1, 10]) {
            const m = fitLogistic(train, names, imputer, wTrain, {l2: 1 / C});
            const ev = evaluate(val, names, imputer, (x) => m.predict(x), wVal);
            if (ev.macroF1 > bestF1) { bestF1 = ev.macroF1; bestC = C; logistic = m; }
        }

        const models = {
            "cost-tree (operational)": (x, u) => predictTree(treeCost, x),
            "cart-unbalanced": (x, u) => predictTree(treeUnbalanced, x),
            "cart-balanced (prereg)": (x, u) => predictTree(treeBalanced, x),
            [`logistic (C=${bestC})`]: (x) => logistic.predict(x),
            ...Object.fromEntries(Object.entries(baselines)
                .map(([n, p]) => [n, (x, u) => p(u)])),
        };

        const report = [];
        report.push("# BOT Bench Q4 classifier report (M3, audit-corrected)");
        report.push("");
        report.push("POST-HOC CAVEAT: models refit on the repaired grouping after the");
        report.push("Codex M3 audit; the test partition had been observed before the");
        report.push("corrections. Model form and hyperparameters are unchanged and not");
        report.push("test-driven, but treat this as an audit-corrected re-evaluation,");
        report.push("not a fresh preregistered result. Direction-regime conclusions use");
        report.push("the sentinel pool (core direction groups never reach test).");
        report.push("");
        report.push(`Units: ${units.length} (train ${train.length} / val ${val.length} `
            + `/ test ${test.length}; sentinels ${sentinels.length}; `
            + `unrecoverable ${unrecoverable.length})`);
        report.push("");
        report.push("## Operational cost-sensitive tree (leaves minimize expected clamped loss)");
        report.push("");
        report.push("```");
        report.push(renderTree(treeCost).trimEnd());
        report.push("```");
        report.push("");
        report.push("## Unbalanced group-weighted CART");
        report.push("");
        report.push("```");
        report.push(renderTree(treeUnbalanced).trimEnd());
        report.push("```");
        report.push("");
        report.push("## Preregistered class-balanced CART (sensitivity model)");
        report.push("");
        report.push("```");
        report.push(renderTree(treeBalanced).trimEnd());
        report.push("```");
        report.push("");
        report.push("## Binary rcond regime detector (CV-unrecoverable when log10Rcond <= thr)");
        report.push("");
        if (regime) {
            report.push(`Weighted train ROC-AUC ${fmt(regime.auc)}, PR-AUC ${fmt(regime.prAuc)}. `
                + `Operating points: Youden J ${regime.thresholdYouden.toFixed(3)} `
                + `(paper-facing, prevalence-robust); accuracy-optimal `
                + `${regime.thresholdAccuracy.toFixed(3)} (high-recall, prevalence-`
                + `sensitive — test prevalence ~0.87 means raw accuracy barely beats `
                + `"always unrecoverable").`);
            report.push("");
            report.push("| set | operating pt | thr | acc | balanced acc | P | R | FPR | prevalence |");
            report.push("|---|---|---:|---:|---:|---:|---:|---:|---:|");
            for (const [label, set] of [["val", val], ["test", test],
                ["sentinels", sentinels]]) {
                for (const [opName, thr] of [["youden", regime.thresholdYouden],
                    ["accuracy", regime.thresholdAccuracy]]) {
                    const ev = evaluateRegimeDetector(thr, set, unitWeights(set));
                    if (ev) report.push(`| ${label} | ${opName} | ${thr.toFixed(3)} `
                        + `| ${fmt(ev.accuracy)} | ${fmt(ev.balancedAccuracy)} `
                        + `| ${fmt(ev.precision, 2)} | ${fmt(ev.recall, 2)} `
                        + `| ${fmt(ev.fpr, 2)} | ${fmt(ev.prevalence, 2)} |`);
                }
            }
        }
        report.push("");

        const table = [];
        const evalSet = (set, label) => {
            if (!set.length) return;
            const w = unitWeights(set);
            for (const [name, p] of Object.entries(models)) {
                table.push({label, model: name, ...evaluate(set, names, imputer, p, w)});
            }
        };
        evalSet(val, "val");
        evalSet(test, "test");
        evalSet(sentinels.filter((u) => u.oracle !== null), "sentinels");

        report.push("## Performance (ALL metrics group-weighted; regret on track truth;");
        report.push("fixed-direction chosen on a track counts as infinite regret + catastrophic)");
        report.push("");
        report.push("| set | model | acc | top-2 | macro-F1 | regret med | regret p90 | infW | cat | oracle floor | excess cat | dir P/R/FPR |");
        report.push("|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|");
        for (const r of table) {
            report.push(`| ${r.label} | ${r.model} | ${fmt(r.accuracy)} | ${fmt(r.top2Accuracy)} `
                + `| ${fmt(r.macroF1)} | ${fmt(r.regretMedian, 4)} | ${fmt(r.regretP90, 4)} `
                + `| ${fmt(r.regretInfiniteWeight, 3)} | ${fmt(r.catastrophicRate)} `
                + `| ${fmt(r.oracleCatastrophicFloor)} | ${fmt(r.excessCatastrophic)} `
                + `| ${fmt(r.direction.precision, 2)}/${fmt(r.direction.recall, 2)}/${fmt(r.direction.fpr, 2)} |`);
        }
        report.push("");

        // Confusion matrices for the operational rule on test.
        const wTest = unitWeights(test);
        const evCostTest = evaluate(test, names, imputer,
            (x) => predictTree(treeCost, x), wTest);
        report.push("## Confusion (test, cost-tree; weighted)");
        report.push("");
        report.push(renderConfusion(evCostTest.confusion));
        report.push("");

        // Regime-stratified results (test).
        report.push("## Regime-stratified test performance (cost-tree)");
        report.push("");
        report.push("| regime | n | acc | cat | oracle floor | excess |");
        report.push("|---|---:|---:|---:|---:|---:|");
        const strata = new Map();
        for (const u of test) {
            const s = regimeOf(u);
            if (!strata.has(s)) strata.set(s, []);
            strata.get(s).push(u);
        }
        for (const [s, set] of [...strata].sort((a, b) => a[0].localeCompare(b[0]))) {
            const ev = evaluate(set, names, imputer, (x) => predictTree(treeCost, x),
                unitWeights(set));
            report.push(`| ${s} | ${set.length} | ${fmt(ev.accuracy)} | ${fmt(ev.catastrophicRate)} `
                + `| ${fmt(ev.oracleCatastrophicFloor)} | ${fmt(ev.excessCatastrophic)} |`);
        }
        report.push("");

        const ciCost = bootstrapCI(test, names, imputer, (x) => predictTree(treeCost, x), wTest);
        const ciUnb = bootstrapCI(test, names, imputer, (x) => predictTree(treeUnbalanced, x), wTest);
        report.push(`Test accuracy 95% cluster-bootstrap CI — cost-tree: ${fmt(ciCost.lo)}..${fmt(ciCost.hi)}, `
            + `unbalanced: ${fmt(ciUnb.lo)}..${fmt(ciUnb.hi)}`);
        report.push("");

        report.push("## Abstain sensitivity (test, cost-tree; group-weighted coverage)");
        report.push("");
        report.push("| log10(rcond) floor | coverage | acc | cat | oracle floor | excess |");
        report.push("|---:|---:|---:|---:|---:|---:|");
        for (const r of abstainCurve(test, names, imputer, (x) => predictTree(treeCost, x), wTest)) {
            report.push(`| ${r.rcondThreshold === -Infinity ? "none" : r.rcondThreshold} `
                + `| ${fmt(r.coverage, 2)} | ${fmt(r.accuracy)} | ${fmt(r.catastrophicRate)} `
                + `| ${fmt(r.oracleCatastrophicFloor)} | ${fmt(r.excessCatastrophic)} |`);
        }
        report.push("");
        report.push("CAUTION (audit): the rcond floor mostly selects the unavoidable-");
        report.push("failure cases — total catastrophe among answered scenarios RISES");
        report.push("toward the floor's value as coverage falls. This is a coverage/");
        report.push("excess-catastrophe trade, NOT a safety-improving abstention rule.");
        report.push("");

        report.push("## Leave-one-platform-family-out (secondary check, cost-tree)");
        report.push("");
        report.push("| held-out | n | acc | cat | oracle floor |");
        report.push("|---|---:|---:|---:|---:|");
        const corePool = [...train, ...val, ...test];
        for (const fam of ["orbit", "curve", "straight"]) {
            const tr = corePool.filter((u) => u.platformFamily !== fam);
            const te = corePool.filter((u) => u.platformFamily === fam);
            if (!tr.length || !te.length) continue;
            const imp = fitImputer(tr, names);
            const t = fitTree(tr, names, imp, unitWeights(tr), {mode: "cost"});
            const ev = evaluate(te, names, imp, (x) => predictTree(t, x), unitWeights(te));
            report.push(`| ${fam} | ${te.length} | ${fmt(ev.accuracy)} `
                + `| ${fmt(ev.catastrophicRate)} | ${fmt(ev.oracleCatastrophicFloor)} |`);
        }
        report.push("");

        const out = report.join("\n");
        fs.writeFileSync(path.join(RESULTS_DIR, "classifier-report.md"), out);
        console.log("\n" + out);

        // Loose invariants.
        const testCost = table.find((r) => r.label === "test" && r.model === "cost-tree (operational)");
        expect(Number.isFinite(testCost.accuracy)).toBe(true);
        expect(testCost.excessCatastrophic).toBeLessThan(0.35);
    });
});
