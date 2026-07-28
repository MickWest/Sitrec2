/**
 * verdict.bench.test.js — the bulk pass: run the SHIPPING traverse analysis
 * over BOT Bench scenarios and report one row per scenario with calibrated
 * per-class percentages.
 *
 *     BOTBENCH_VERDICT=smoke npm run bench-bot-verdict     # 6 cells, ~4 min
 *     BOTBENCH_VERDICT=pilot npm run bench-bot-verdict     # ~60 cells, ~35 min
 *     BOTBENCH_VERDICT=full  npm run bench-bot-verdict     # 855 cells, hours
 *     BOTBENCH_VERDICT_OFFSET / _LIMIT                     # chunked runs
 *
 * COST. One scenario is ~30-60 s with range bands on (three physics models
 * re-fitted at ~11 held ranges each, plus two global basin probes per model).
 * The full matrix is therefore an overnight job, not something to run casually
 * — hence the staged modes and the chunking, matching physics.bench.test.js.
 *
 * WHAT THIS MEASURES, AND WHAT IT DOES NOT. The percentages are frequencies
 * over THIS scenario population, and the population is synthetic and not
 * distributed like the real world. It has no multirotor target at all, its
 * winds are exact constants where a real sounding is not, and it runs a
 * reduced hypothesis set (see verdictRunner.ABSENT_HYPOTHESES). Every one of
 * those is printed in the report rather than left to a footnote.
 *
 * Output: results/verdict-records.jsonl, verdict-rows.csv, verdict-summary.md.
 */

import fs from "fs";
import path from "path";
import {setSit} from "../../src/Globals";
import {buildAllScenarioEntries} from "./lib/blocks";
import {generateScenario} from "./lib/generateScenario";
import {sanitize} from "./lib/runner";
import {runVerdict, signatureKey, ABSENT_HYPOTHESES} from "./lib/verdictRunner";
import {
    REPORT_CLASSES, DEFAULT_LABELS, UNMAPPED_LABELS, UNCALIBRATED_CLASSES,
    assignGroups, splitByGroup, buildCalibration, predictDistribution,
    formatDistribution, weightedDistribution, calibrateK, configKey, MIN_GROUPS,
    truthLabelOf, classOfTruth,
} from "./lib/classProbability";

const RESULTS_DIR = path.resolve(__dirname, "results");
const MODE = process.env.BOTBENCH_VERDICT || "smoke";
const OFFSET = Math.max(0, parseInt(process.env.BOTBENCH_VERDICT_OFFSET || "0", 10) || 0);
const LIMIT = Math.max(0, parseInt(process.env.BOTBENCH_VERDICT_LIMIT || "0", 10) || 0);
const K = Number(process.env.BOTBENCH_VERDICT_K || "1.5");
const pct = (v) => (Number.isFinite(v) ? `${(v * 100).toFixed(0)}%` : "-");
const num = (v, d = 3) => (Number.isFinite(v) ? v.toFixed(d) : "-");

// Family ids carry a "|" (key + windEvidenceRole), which would split a markdown
// table cell. Name them for the report instead of escaping.
const BAND_LABELS = {
    "lantern|free": "Balloon (free wind)",
    "quadcopter|": "Quadcopter",
    "aircraft|": "Fixed-wing",
};

/**
 * Scenario selection per mode. `pilot` deliberately spans every truth label the
 * calibration can and cannot map — including birds and anomaly controls, which
 * are the cases that test whether "Unknown" behaves.
 */
function selectEntries(entries) {
    if (MODE === "full") return entries;
    if (MODE === "smoke") {
        const want = ["party-neutral", "aircraft-cruise", "bird", "venus"];
        const out = [];
        for (const kind of want) {
            const hit = entries.find((e) => e.spec.target.kind === kind
                && e.spec.platform.kind === "orbit-point" && e.spec.durationSeconds <= 15);
            if (hit) out.push(hit);
        }
        const anom = entries.filter((e) => e.blockId === "ANOMALY-CONTROL"
            && e.spec.platform.kind === "orbit-point").slice(0, 2);
        return out.concat(anom);
    }
    // pilot: one seed, orbit + straight, every target family represented.
    return entries.filter((e) => {
        const s = e.spec;
        const p = s.platform.kind;
        if (p !== "orbit-point" && p !== "straight") return false;
        switch (e.blockId) {
            case "TARGET-WIND": return e.scenarioSeed === 201;
            case "GEO-DURATION":
                return e.scenarioSeed === 101 && s.durationSeconds === 15;
            case "ANOMALY-CONTROL":
                return e.scenarioSeed === 401 && s.observation.kind === "clean";
            case "RECOVERABLE-NOISE":
                return e.scenarioSeed === 601 && s.observation.kind === "clean";
            default: return false;
        }
    });
}

jest.setTimeout(24 * 60 * 60 * 1000);

describe("BOT Bench verdict sweep", () => {
    test("runs the shipping analysis in bulk and calibrates class percentages", async () => {
        setSit({name: "botbench", frames: 100000, fps: 10, simSpeed: 1, lat: 40, lon: -105});

        const all = buildAllScenarioEntries();
        let selected = selectEntries(all);
        const selectedTotal = selected.length;
        if (OFFSET > 0 || LIMIT > 0) {
            selected = selected.slice(OFFSET, LIMIT > 0 ? OFFSET + LIMIT : undefined);
        }
        console.log(`[verdict] mode=${MODE} selected=${selectedTotal} running=${selected.length}`
            + (OFFSET || LIMIT ? ` (offset ${OFFSET}, limit ${LIMIT || "none"})` : ""));

        const records = [];
        const progressFile = process.env.BOTBENCH_PROGRESS_FILE || null;
        for (let i = 0; i < selected.length; i++) {
            const entry = selected[i];
            const scenario = generateScenario(entry.spec, {scenarioSeed: entry.scenarioSeed});
            scenario.scenarioId = entry.scenarioId ?? `${entry.blockId}-${i + OFFSET}`;
            scenario.spec = {...entry.spec, scenarioSeed: entry.scenarioSeed};
            let rec;
            try {
                rec = await runVerdict(scenario, {K});
            } catch (e) {
                rec = {scenarioId: scenario.scenarioId, spec: scenario.spec,
                    truthFamily: entry.spec.target.family, error: String(e?.message || e)};
            }
            rec.blockId = entry.blockId;
            records.push(rec);
            const line = `[verdict] ${i + 1}/${selected.length} ${rec.scenarioId} `
                + `truth=${rec.truthFamily} code=${rec.executive?.code ?? "ERR"} `
                + `${rec.timingMs ?? 0}ms`;
            if (progressFile) { try { fs.appendFileSync(progressFile, line + "\n"); } catch (e) { /* best effort */ } }
            console.log(line);
        }

        // --- calibration ----------------------------------------------------
        const usable = records.filter((r) => r.signature && r.spec);
        const grouped = assignGroups(usable);
        const {train, test} = splitByGroup(grouped);
        const calibration = buildCalibration(train, {signatureKey});
        const cfgKey = configKey({K});

        // Band-width coverage per class, at the K this run used. A full sweep
        // over K needs one run per K; a single run reports the coverage it
        // achieved so the K choice can be made from several runs.
        const coverage = {};
        for (const r of usable) {
            const per = r.familyCoverage?.perClass ?? {};
            for (const [id, c] of Object.entries(per)) {
                if (!coverage[id]) coverage[id] = {covered: 0, scored: 0};
                if (c.coverageFrac === null) continue;
                coverage[id].scored++;
                if (c.covered) coverage[id].covered++;
            }
        }
        const coverageByK = Object.fromEntries(Object.entries(coverage)
            .map(([id, c]) => [id, {[K]: c.scored ? c.covered / c.scored : 0}]));
        const chosenK = calibrateK(coverageByK);

        // --- rows -----------------------------------------------------------
        // Every row is tagged with the split it came from. A row whose signature
        // helped BUILD the calibration is not evidence that the calibration
        // works, so the confusion matrix below is computed over test rows only.
        const testIds = new Set(test.map((r) => r.scenarioId));
        const rows = grouped.map((r) => {
            const p = predictDistribution(calibration, r.signature, {signatureKey});
            return {
                scenarioId: r.scenarioId, blockId: r.blockId,
                split: testIds.has(r.scenarioId) ? "test" : "train",
                truthLabel: r.truthLabel, truthClass: classOfTruth(r.truthLabel) ?? "unknown",
                code: r.executive?.code ?? "error",
                dist: p.dist, calibrated: p.calibrated, backedOff: p.backedOff,
                groups: p.groups, n: p.n,
                summary: p.calibrated ? formatDistribution(p.dist)
                    : "Unknown 100% (no calibration support)",
                unionCoverage: r.familyCoverage?.union?.coverageFrac ?? null,
            };
        });

        // --- output ---------------------------------------------------------
        fs.mkdirSync(RESULTS_DIR, {recursive: true});
        const suffix = OFFSET > 0 || LIMIT > 0 ? `-${OFFSET}` : "";
        fs.writeFileSync(path.join(RESULTS_DIR, `verdict-records${suffix}.jsonl`),
            records.map((r) => JSON.stringify(sanitize(r))).join("\n") + "\n");

        const csvHead = ["scenarioId", "block", "split", "truthLabel", "truthClass", "verdictCode",
            ...REPORT_CLASSES.map((c) => `p_${c}`), "calibrated", "groups", "unionCoverage"];
        const csv = [csvHead.join(",")].concat(rows.map((r) => [
            r.scenarioId, r.blockId, r.split, r.truthLabel, r.truthClass, r.code,
            ...REPORT_CLASSES.map((c) => (r.dist[c] ?? 0).toFixed(4)),
            r.calibrated ? 1 : 0, r.groups,
            r.unionCoverage === null ? "" : r.unionCoverage.toFixed(3),
        ].join(",")));
        fs.writeFileSync(path.join(RESULTS_DIR, `verdict-rows${suffix}.csv`), csv.join("\n") + "\n");

        const md = buildSummary({records, rows, train, test, calibration, coverage,
            chosenK, cfgKey, selectedTotal});
        fs.writeFileSync(path.join(RESULTS_DIR, `verdict-summary${suffix}.md`), md);
        console.log("\n" + md);

        const errored = records.filter((r) => r.error);
        if (errored.length) {
            console.log("[verdict] errors:", errored.slice(0, 5)
                .map((r) => `${r.scenarioId}: ${r.error}`));
        }
        expect(records.length).toBe(selected.length);
        expect(errored.length).toBe(0);
    });
});

function buildSummary({records, rows, train, test, calibration, coverage, chosenK,
    cfgKey, selectedTotal}) {
    const L = [];
    L.push("# BOT Bench — traverse verdict sweep");
    L.push("");
    L.push(`Mode: \`${MODE}\`  selected: ${selectedTotal}  run: ${records.length}  `
        + `K: ${K}  config: \`${cfgKey}\``);
    L.push("");

    L.push("## What these percentages are");
    L.push("");
    L.push("They are **measured frequencies over this synthetic population**, not model");
    L.push("likelihoods: of the scenarios whose analysis produced the same evidence signature,");
    L.push("this fraction actually were each class. Sitrec computes no cross-model likelihood");
    L.push("and none is implied here. Each truth-content group carries equal weight (so repeated");
    L.push("seeds cannot outvote distinct content) and intervals come from resampling groups.");
    L.push("");
    L.push("**Do not read them as real-world priors.** The population is a block matrix, not a");
    L.push("sample of anything.");
    L.push("");

    L.push("## Coverage limits of this run");
    L.push("");
    L.push("Hypotheses NOT run (a reduced profile of the shipping analysis):");
    for (const a of ABSENT_HYPOTHESES) L.push(`- ${a}`);
    L.push("");
    L.push("Classes this matrix cannot calibrate — reported as *not calibrated*, never 0%:");
    for (const [c, why] of Object.entries(UNCALIBRATED_CLASSES)) L.push(`- **${c}**: ${why}`);
    L.push("");
    L.push("Truth labels with no Sitrec class (they count as Unknown, which is the correct answer):");
    for (const [c, why] of Object.entries(UNMAPPED_LABELS)) L.push(`- **${c}**: ${why}`);
    L.push("");

    L.push("## Split");
    L.push("");
    const tg = new Set(train.map((r) => r.groupId)).size;
    const sg = new Set(test.map((r) => r.groupId)).size;
    L.push(`Train: ${train.length} scenarios / ${tg} truth-content groups. `
        + `Test: ${test.length} / ${sg}. Split is by GROUP — no truth content appears on both sides.`);
    L.push(`Bins need >= ${MIN_GROUPS} independent groups before they report a distribution; `
        + "thinner bins back off to a coarser signature, and a bin still thin at the coarsest "
        + "level abstains to Unknown.");
    L.push("");

    L.push("## Per-scenario class percentages");
    L.push("");
    L.push("A row marked `train` had its own signature in the calibration it is being scored by;");
    L.push("only `test` rows are held out. Read the held-out ones for how well this generalises.");
    L.push("");
    L.push("| scenario | block | split | truth | verdict | percentages | support |");
    L.push("|---|---|---|---|---|---|---|");
    for (const r of rows.slice(0, 200)) {
        L.push(`| ${r.scenarioId} | ${r.blockId} | ${r.split} | ${r.truthLabel} | ${r.code} `
            + `| ${r.summary} `
            + `| ${r.calibrated ? `${r.groups} groups${r.backedOff ? ", backed off" : ""}` : "none"} |`);
    }
    if (rows.length > 200) L.push(`| ... | | | | | _${rows.length - 200} more rows in the CSV_ |`);
    L.push("");

    L.push("## Confusion: truth label vs modal predicted class — HELD-OUT ROWS ONLY");
    L.push("");
    const heldOut = rows.filter((r) => r.split === "test");
    if (!heldOut.length) {
        L.push("_No held-out rows in this run — the split needs enough truth-content groups._");
        L.push("Training rows are deliberately NOT shown here: a row whose signature helped build");
        L.push("the calibration cannot demonstrate that the calibration generalises.");
        L.push("");
    } else {
        L.push("Abstentions (bins without enough independent groups) are counted SEPARATELY, not as");
        L.push("an \"Unknown\" prediction. A refusal to predict and a prediction of Unknown are");
        L.push("different claims, and pooling them would make the abstention machinery look like");
        L.push("accuracy on the one truth label it happens to match.");
        L.push("");
        L.push(`| truth \\ predicted | ${REPORT_CLASSES.map((c) => DEFAULT_LABELS[c]).join(" | ")} | abstained | n |`);
        L.push(`|---|${REPORT_CLASSES.map(() => "---:").join("|")}|---:|---:|`);
        const labels = [...new Set(heldOut.map((r) => r.truthLabel))].sort();
        for (const lab of labels) {
            const mine = heldOut.filter((r) => r.truthLabel === lab);
            const counts = Object.fromEntries(REPORT_CLASSES.map((c) => [c, 0]));
            let abstained = 0;
            for (const r of mine) {
                if (!r.calibrated) { abstained++; continue; }
                const modal = REPORT_CLASSES.reduce(
                    (a, b) => ((r.dist[b] ?? 0) > (r.dist[a] ?? 0) ? b : a), REPORT_CLASSES[0]);
                counts[modal]++;
            }
            L.push(`| ${lab} | ${REPORT_CLASSES.map((c) => counts[c]).join(" | ")} `
                + `| ${abstained} | ${mine.length} |`);
        }
        const abst = heldOut.filter((r) => !r.calibrated).length;
        L.push("");
        L.push(`Held-out rows: ${heldOut.length}; abstained: ${abst} `
            + `(${pct(abst / heldOut.length)}). Predictions were made on ${heldOut.length - abst}.`);
        L.push("");
    }

    // The verdict code is the analysis's OWN output, not a calibrated
    // prediction, so it is not held-out and every row belongs here.
    L.push("## Verdict codes by truth label (all rows — this is the analysis's own output)");
    L.push("");
    const allLabels = [...new Set(rows.map((r) => r.truthLabel))].sort();
    const codes = [...new Set(rows.map((r) => r.code))].sort();
    L.push(`| truth | ${codes.join(" | ")} |`);
    L.push(`|---|${codes.map(() => "---:").join("|")}|`);
    for (const lab of allLabels) {
        const mine = rows.filter((r) => r.truthLabel === lab);
        L.push(`| ${lab} | ${codes.map((c) => mine.filter((r) => r.code === c).length).join(" | ")} |`);
    }
    L.push("");

    L.push("## Range-band truth coverage");
    L.push("");
    L.push("Does the band the analysis reports actually contain the true trajectory? Truth is used");
    L.push("HERE ONLY — never as an input to the analysis or the band.");
    L.push("");
    L.push("| class band | scenarios scored | contained (>=95% of frames) | coverage | K chosen | reached 90% target |");
    L.push("|---|---:|---:|---:|---:|---|");
    for (const [id, c] of Object.entries(coverage)) {
        const k = chosenK[id];
        L.push(`| ${BAND_LABELS[id] ?? id.replace(/\|/g, " ")} | ${c.scored} | ${c.covered} `
            + `| ${pct(c.scored ? c.covered / c.scored : NaN)} `
            + `| ${k ? k.K : "-"} | ${k ? (k.reachedTarget ? "yes" : "**no**") : "-"} |`);
    }
    L.push("");
    L.push("A class that never reaches the target is a FINDING: the band construction is missing a");
    L.push("degree of freedom for it. Widening K until it passes would make the band uninformative.");
    L.push("");

    const times = records.map((r) => r.timingMs).filter(Number.isFinite).sort((a, b) => a - b);
    if (times.length) {
        L.push("## Cost");
        L.push("");
        L.push(`Median ${num(times[times.length >> 1] / 1000, 1)} s per scenario, `
            + `total ${num(times.reduce((a, b) => a + b, 0) / 60000, 1)} min.`);
        L.push("");
    }
    return L.join("\n");
}
