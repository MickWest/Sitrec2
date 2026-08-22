/**
 * tractability.bench.test.js — the TRIAGE study: run the shipping traverse
 * analysis (verdictRunner) over the new scenario sets and record, for every
 * scenario, BOTH the pre-fit observables an analyst could triage on AND the
 * scored outcome — so "which LOS sets are worth solving, and how sure can we
 * be" becomes a measured relationship instead of a hunch.
 *
 *     npm run bench-bot-tract                          # all sets
 *     BOTBENCH_TRACT_SET=real|maneuver|standard        # one set
 *     BOTBENCH_TRACT_OFFSET / _LIMIT                   # chunked runs
 *     BOTBENCH_PROGRESS_FILE=...                       # live progress appends
 *
 * Honesty rule: the range-ladder anchor is FIXED at 20 NM for every scenario
 * (the BotBench dialog's default), never taken from the generating spec —
 * an analyst has no bracket centred on the answer.
 *
 * Sets:
 *   real      the 10 case-geometry scenarios cut from real GPS tracks
 *   maneuver  the maneuver-taxonomy shapes, one per kind in lib/maneuverSet.js
 *   standard  a 6-scenario GEO-DURATION ladder (orbit/straight x 5/15/60 s)
 *             — the known recoverable->hopeless gradient, as the baseline the
 *             triage score must at minimum reproduce
 *
 * Output: results/tractability/records[-<set>][-<offset>].jsonl, one record
 * per scenario, appended as each lands (crash-safe).
 */

import fs from "fs";
import path from "path";
import {setSit} from "../../src/Globals";
import {generateScenario} from "./lib/generateScenario";
import {maneuverSpecFor, MANEUVER_CASES} from "./lib/maneuverSet";
import {REAL_SCENARIOS, buildRealScenarioSpec} from "./lib/realScenarioSet";
import {runVerdict} from "./lib/verdictRunner";

const OUT_DIR = path.resolve(__dirname, "results", "tractability");
const ANCHOR_M = 20 * 1852;   // the BotBench dialog's fixed default: 20 NM

const SET = process.env.BOTBENCH_TRACT_SET || "all";
const OFFSET = Math.max(0, parseInt(process.env.BOTBENCH_TRACT_OFFSET || "0", 10) || 0);
const LIMIT = Math.max(0, parseInt(process.env.BOTBENCH_TRACT_LIMIT || "0", 10) || 0);
const PROGRESS = process.env.BOTBENCH_PROGRESS_FILE || null;

function standardLadder() {
    // GEO-DURATION slice: the canonical recoverable->hopeless gradient.
    const out = [];
    for (const platform of ["orbit-point", "straight"]) {
        for (const durationSeconds of [5, 15, 60]) {
            out.push({
                setId: "standard",
                label: `ladder-${platform}-${durationSeconds}s`,
                anomalous: false,
                scenarioSeed: 101,
                spec: {
                    durationSeconds, fps: 10, initialHorizontalRangeM: 5000,
                    siteId: "flat-reference",
                    platform: {kind: platform, speedMS: 70, altitudeAGL: 3000},
                    target: {kind: "party-neutral", family: "balloon",
                        parameters: {startAGL: 500}},
                    wind: {kind: "fixed"},
                    observation: {kind: "white", fovFullDeg: 0.5,
                        gaussianSigmaDeg: 0.03},
                },
            });
        }
    }
    return out;
}

function buildWorkList() {
    const work = [];
    if (SET === "all" || SET === "real") {
        for (const def of REAL_SCENARIOS) {
            work.push({setId: "real",
                label: `${def.label}${def.anomalous ? "-anom" : ""}`,
                anomalous: def.anomalous === true, pairId: def.pairId ?? null,
                scenarioSeed: 901, realDef: def});
        }
    }
    if (SET === "all" || SET === "maneuver") {
        for (const kind of Object.keys(MANEUVER_CASES)) {
            const spec = maneuverSpecFor(kind);
            work.push({setId: "maneuver", label: kind,
                anomalous: spec.target.parameters.anomalous === true,
                scenarioSeed: 801, spec});
        }
    }
    if (SET === "all" || SET === "standard") work.push(...standardLadder());
    return work;
}

// Mean truth range: the scale that turns a separation into a relative one.
function meanTruthRangeM(scenario) {
    const t = scenario.target;
    if (t.kind !== "track") return null;
    const p = scenario.platform.positionENU;
    let sum = 0;
    for (let f = 0; f < scenario.n; f++) {
        sum += Math.hypot(
            t.positionENU[f * 3] - p[f * 3],
            t.positionENU[f * 3 + 1] - p[f * 3 + 1],
            t.positionENU[f * 3 + 2] - p[f * 3 + 2]);
    }
    return sum / scenario.n;
}

function progress(line) {
    if (PROGRESS) fs.appendFileSync(PROGRESS, `${new Date().toISOString()} ${line}\n`);
}

describe("tractability study", () => {
    jest.setTimeout(24 * 60 * 60 * 1000);

    beforeAll(() => {
        setSit({name: "botbench-tract", frames: 100000, fps: 10,
            simSpeed: 1, lat: 40, lon: -105});
    });

    test("runs the shipping analysis over the sets and records triage + outcome", async () => {
        fs.mkdirSync(OUT_DIR, {recursive: true});
        let work = buildWorkList();
        if (OFFSET > 0 || LIMIT > 0) {
            work = work.slice(OFFSET, LIMIT > 0 ? OFFSET + LIMIT : undefined);
        }
        const suffix = (SET !== "all" ? `-${SET}` : "")
            + (OFFSET > 0 || LIMIT > 0 ? `-${OFFSET}` : "");
        const outFile = path.join(OUT_DIR, `records${suffix}.jsonl`);
        fs.writeFileSync(outFile, "");
        progress(`start ${work.length} scenarios -> ${outFile}`);

        for (const item of work) {
            const spec = item.realDef ? buildRealScenarioSpec(item.realDef).spec : item.spec;
            const scenario = generateScenario(spec, {scenarioSeed: item.scenarioSeed});
            const rangeM = meanTruthRangeM(scenario);

            // TRIAGE BLOCK: strictly pre-fit observables. The analysis result
            // must never leak in here — the study's whole point is testing
            // whether these alone predict the outcome.
            const triage = {
                n: scenario.n, fps: spec.fps,
                durationSeconds: spec.durationSeconds,
                fovFullDeg: spec.observation.fovFullDeg,
                observationKind: spec.observation.kind,
                ...scenario.diagnostics,
            };

            const t0 = Date.now();
            let outcome = null, error = null;
            try {
                outcome = await runVerdict(scenario, {anchorM: ANCHOR_M});
            } catch (e) {
                error = String(e?.message ?? e);
            }

            let top = null, best = null;
            if (outcome) {
                const eligible = outcome.hypotheses.filter(
                    (h) => h.eligible && Number.isFinite(h.truthSepM));
                if (eligible.length) {
                    top = eligible[0].truthSepM;
                    best = Math.min(...eligible.map((h) => h.truthSepM));
                }
            }
            const record = {
                setId: item.setId, label: item.label,
                anomalousDeclared: item.anomalous, pairId: item.pairId ?? null,
                scenarioId: scenario.scenarioId,
                meanTruthRangeM: rangeM,
                triage,
                outcome, error,
                derived: {
                    topTruthSepM: top, bestTruthSepM: best,
                    topRelSep: top != null && rangeM ? top / rangeM : null,
                    bestRelSep: best != null && rangeM ? best / rangeM : null,
                },
                wallMs: Date.now() - t0,
            };
            fs.appendFileSync(outFile, `${JSON.stringify(record)}\n`);
            const line = `${item.setId}/${item.label}: `
                + (error ? `ERROR ${error}` :
                    `code=${outcome.executive.code} topRelSep=`
                    + (record.derived.topRelSep?.toFixed(3) ?? "n/a")
                    + ` bestRelSep=${record.derived.bestRelSep?.toFixed(3) ?? "n/a"}`
                    + ` unobs=${outcome.provenance.rangeUnobservable ? 1 : 0}`)
                + ` (${((Date.now() - t0) / 1000).toFixed(0)}s)`;
            console.log(`[tract] ${line}`);
            progress(line);
        }
        progress("done");
    });
});
