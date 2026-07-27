/**
 * capability.bench.test.js — EMERGING THREATS (round 3, v2 detector): can
 * bearings-only recovery SURFACE a system running outside known envelopes, or
 * a genuinely new capability class? Detection/attribution, not exclusion.
 *
 *     BOTBENCH_CAP=smoke  npm run bench-bot-capability   # 2-seed plumbing/separability
 *     BOTBENCH_CAP=pilot  npm run bench-bot-capability   # calibrate thresholds from λ=1 controls
 *     BOTBENCH_CAP=holdout ...                            # frozen thresholds (publishable claim)
 *
 * Detector v2 (post-smoke redesign, Codex-reviewed):
 *  - S1' NOMINAL catalog-model failure (residual + envelope prior/pins), NOT a
 *    relaxation sweep;
 *  - S2  range-profile family exceedance lower bound (no speed prior), NOT KS;
 *  - per-rung pairwise separability (λ-exceeded signature vs its matched λ=1
 *    counterfactual), with sub-wobble cells short-circuited to "below detection
 *    floor" rather than run through detectors that produce prior/collapse
 *    artifacts;
 *  - wobble realizations PAIRED across λ via sharedSeedKey (same base case +
 *    geometry + seed => identical pointing error, so a λ difference is the
 *    only thing that moves).
 *
 * Output: results/capability-{stage}.md + capability-{stage}.jsonl.
 */

import fs from "fs";
import path from "path";
import {setSit} from "../../src/Globals";
import {generateScenario} from "./lib/generateScenario";
import {capabilityVerdict, nominalModelFailure, cleanSeparationDeg} from "./lib/capabilityDetect";

const RESULTS_DIR = path.resolve(__dirname, "results");
const fmt = (v, d = 3) => (v === null || v === undefined || !Number.isFinite(v)) ? "-" : v.toFixed(d);
const WOBBLE_DEG = 0.15;   // wobble-amplitude noise floor: clean pairwise sep must exceed this

const GEOMS = {
    recoverable: {initialHorizontalRangeM: 2000, durationSeconds: 60,
        platform: {kind: "orbit-point", speedMS: 70, altitudeAGL: 3000}},
    weak: {initialHorizontalRangeM: 20000, durationSeconds: 15,
        platform: {kind: "orbit-point", speedMS: 70, altitudeAGL: 3000}},
};
const LAMBDA_GRID = [1.0, 1.1, 1.2, 1.5, 2.0];
const BASE_CASES = [
    {dimension: "quad-speed",      catalogId: "air3", family: "quad"},
    {dimension: "quad-climb",      catalogId: "air3", family: "quad"},
    {dimension: "fixedwing-speed", catalogId: "mq9",  family: "fixedwing"},
    {dimension: "fixedwing-g",     catalogId: "mq9",  family: "fixedwing"},   // S2 only
];
const NOVEL_CASES = [
    {novelId: "novel-joint-envelope", family: "quad",      s2Catalog: "racer"},
    {novelId: "novel-hover-dash",     family: "quad",      s2Catalog: "racer"},
    {novelId: "novel-vertical-climb", family: "fixedwing", s2Catalog: "auto"},
];

const WOBBLE = {amplitude: 0.15, driftSpeed: 0.10, reactionTime: 0.4, correctionSpeed: 1.0, accuracy: 0.8};

// Pair wobble across λ: sharedSeedKey depends on base+geom+seed but NOT λ, so
// the identical pointing-error realization is reused at every rung.
function capSpec(geomKey, target, seed, {clean = false, pairKey = null} = {}) {
    const g = GEOMS[geomKey];
    const observation = clean
        ? {kind: "clean", fovFullDeg: 0.9}
        : {kind: "wobble", fovFullDeg: 0.9, wobble: {...WOBBLE},
           ...(pairKey ? {sharedSeedKey: pairKey} : {})};
    return {
        durationSeconds: g.durationSeconds, fps: 10,
        initialHorizontalRangeM: g.initialHorizontalRangeM,
        siteId: "flat-reference", platform: g.platform,
        target, wind: {kind: "zero"}, observation,
        blockId: target.parameters?.novelId ? "NOVEL-TECH" : "CAPABILITY-LADDER",
    };
}

describe("BOT Bench emerging-threats capability detection (v2)", () => {
    jest.setTimeout(6 * 60 * 60 * 1000);
    beforeAll(() => setSit({name: "botbench-cap", frames: 10000, fps: 10, simSpeed: 1, lat: 40, lon: -105}));

    test("capability ladder + novel tech: nominal-model failure + range-family margin", async () => {
        const stage = process.env.BOTBENCH_CAP ?? "smoke";
        const seeds = stage === "smoke" ? [701, 702]
            : stage === "pilot" ? [701, 702, 703, 704, 705]
            : Array.from({length: 20}, (_, i) => 801 + i);   // holdout
        const records = [];

        // Per (geom, base): compute per-RUNG clean pairwise separability once
        // (truth is seed-independent), then run detectors only where above
        // floor. λ=1 is the in-envelope control.
        for (const geomKey of Object.keys(GEOMS)) {
            for (const base of BASE_CASES) {
                // clean λ=1 reference truth
                const ref = generateScenario(capSpec(geomKey,
                    {kind: "capability", family: base.family, parameters: {...base, lambda: 1.0}},
                    seeds[0], {clean: true}), {scenarioSeed: seeds[0]});
                const identByRung = {};
                for (const lambda of LAMBDA_GRID) {
                    const s = generateScenario(capSpec(geomKey,
                        {kind: "capability", family: base.family, parameters: {...base, lambda}},
                        seeds[0], {clean: true}), {scenarioSeed: seeds[0]});
                    identByRung[lambda] = cleanSeparationDeg(
                        ref.observation.cleanDirectionENU, s.observation.cleanDirectionENU, s.n);
                }
                for (const lambda of LAMBDA_GRID) {
                    const ident = identByRung[lambda];
                    const belowFloor = lambda > 1.0 && ident.rmsDeg <= WOBBLE_DEG;
                    const pairKey = `cap-${geomKey}-${base.dimension}`;   // λ-independent
                    for (const seed of seeds) {
                        const scenario = generateScenario(capSpec(geomKey,
                            {kind: "capability", family: base.family, parameters: {...base, lambda}},
                            seed, {pairKey: `${pairKey}-${seed}`}), {scenarioSeed: seed});
                        const rec = {
                            block: "CAPABILITY-LADDER", stage, geomKey, seed,
                            dimension: base.dimension, catalogId: base.catalogId, family: base.family,
                            lambda,
                            trueExceedance: scenario.capabilityProfile.realizedExceedance,
                            measuredBy: scenario.capabilityProfile.measuredBy ?? "fit",
                            identRmsDeg: ident.rmsDeg, identMaxDeg: ident.maxDeg,
                            belowFloor,
                            rcond: scenario.diagnostics.cvDesignLog10RcondObserved,
                        };
                        if (belowFloor) {
                            rec.verdict = "sub-wobble-floor";   // below the wobble-amplitude noise floor
                        } else {
                            const t0 = Date.now();
                            // PRIMARY: constrained-envelope existence test (returns α̂).
                            rec.alpha = await capabilityVerdict(scenario, base.family, base.catalogId);
                            // CORROBORATION: nominal catalog-model failure
                            // (not for fixedwing-g — no production g-fit).
                            if (base.dimension !== "fixedwing-g") {
                                rec.s1 = await nominalModelFailure(scenario, base.dimension, base.catalogId, base.family);
                            }
                            // No binary verdict while the α̂ threshold is
                            // uncalibrated — record the measurement only.
                            rec.verdict = rec.alpha.calibrated
                                ? (rec.alpha.exceedanceForced ? "exceedance-forced" : "in-envelope-feasible")
                                : "alpha-measured-uncalibrated";
                            rec.wallMs = Date.now() - t0;
                        }
                        records.push(rec);
                        console.log(`[cap] ${geomKey} ${base.dimension} λ${lambda} s${seed}: `
                            + `${rec.verdict ?? "detect"} ${rec.wallMs ?? 0}ms`);
                    }
                }
            }
        }
        // NOVEL-TECH (recoverable only for smoke; both geometries for pilot+)
        const novelGeoms = stage === "smoke" ? ["recoverable"] : ["recoverable", "weak"];
        for (const geomKey of novelGeoms) {
            for (const nov of NOVEL_CASES) {
                for (const seed of seeds) {
                    const scenario = generateScenario(capSpec(geomKey,
                        {kind: "capability", family: nov.family, parameters: {...nov}},
                        seed, {pairKey: `nov-${geomKey}-${nov.novelId}-${seed}`}), {scenarioSeed: seed});
                    const rec = {block: "NOVEL-TECH", stage, geomKey, seed,
                        novelId: nov.novelId, family: nov.family,
                        profile: scenario.capabilityProfile,
                        alpha: await capabilityVerdict(scenario, nov.family, nov.s2Catalog),
                        rcond: scenario.diagnostics.cvDesignLog10RcondObserved};
                    records.push(rec);
                    console.log(`[cap] NOVEL ${nov.novelId} ${geomKey} s${seed}: done`);
                }
            }
        }

        // ---- summary ----------------------------------------------------------
        const L = [];
        L.push(`# BOT Bench emerging-threats capability detection — ${stage} (detector v2)`);
        L.push("");
        L.push("PRIMARY DETECTOR: constrained-envelope existence test — α*, the");
        L.push("minimum envelope scale any bearings-consistent trajectory requires.");
        L.push("The solver reports α̂, an optimizer UPPER-BOUND estimate of α*, so the");
        L.push("binary forced/not-forced CLAIM is UNCALIBRATED here and NOT emitted —");
        L.push("the detection threshold must be set by the pilot from the λ=1 control");
        L.push("(null) α̂ distribution. α̂ below is the MEASUREMENT only. S1' (nominal");
        L.push("catalog-model failure) is a corroborating signal. Retired range-family");
        L.push("S2 is not in the verdict path.");
        L.push("");
        L.push("λ=1.0 is the in-envelope control; cells below the wobble-amplitude");
        L.push("noise floor (clean λ-vs-control pairwise sep <= 0.15°) are short-circuited.");
        L.push("");
        L.push("## Per-rung α̂ MEASUREMENT (CAPABILITY-LADDER; median over seeds; NO binary claim)");
        L.push("");
        L.push("| geometry | dimension | λ | true exc | clean sep deg | median α̂ | binding | status | S1' fail |");
        L.push("|---|---|---:|---:|---:|---:|---|---|---:|");
        const med = (v) => { const s = v.filter(Number.isFinite).sort((a, b) => a - b); return s.length ? s[s.length >> 1] : null; };
        const cells = new Map();
        for (const r of records.filter((r) => r.block === "CAPABILITY-LADDER")) {
            const key = `${r.geomKey}|${r.dimension}|${r.lambda}`;
            if (!cells.has(key)) cells.set(key, []);
            cells.get(key).push(r);
        }
        for (const [key, rows] of cells) {
            const [geomKey, dimension, lambda] = key.split("|");
            const r0 = rows[0];
            const alphas = rows.map((r) => r.alpha?.alphaStar).filter(Number.isFinite);
            // "status" describes the MEASUREMENT (sub-wobble / measured), never
            // an uncalibrated forced-exceedance claim.
            const status = r0.belowFloor ? "sub-wobble"
                : (alphas.length ? "α̂ measured (uncalibrated)" : "no fit");
            L.push(`| ${geomKey} | ${dimension} | ${(+lambda).toFixed(1)} | ${fmt(r0.trueExceedance, 2)} `
                + `| ${fmt(r0.identRmsDeg, 3)} | ${fmt(med(alphas), 2)} `
                + `| ${r0.alpha?.bindingDimension ?? "-"} | ${status} `
                + `| ${fmt(med(rows.map((r) => r.s1?.failureScore)), 2)} |`);
        }
        L.push("");
        L.push("## Novel-tech α̂ MEASUREMENT (no binary claim)");
        L.push("");
        L.push("| geometry | signature | median α̂ | binding |");
        L.push("|---|---|---:|---|");
        const ncells = new Map();
        for (const r of records.filter((r) => r.block === "NOVEL-TECH")) {
            const key = `${r.geomKey}|${r.novelId}`;
            if (!ncells.has(key)) ncells.set(key, []);
            ncells.get(key).push(r);
        }
        for (const [key, rows] of ncells) {
            const [geomKey, novelId] = key.split("|");
            const alphas = rows.map((r) => r.alpha?.alphaStar).filter(Number.isFinite);
            L.push(`| ${geomKey} | ${novelId} | ${fmt(med(alphas), 2)} `
                + `| ${rows[0].alpha?.bindingDimension ?? "-"} |`);
        }
        L.push("");

        fs.mkdirSync(RESULTS_DIR, {recursive: true});
        const san = (o) => JSON.parse(JSON.stringify(o, (k, v) =>
            (typeof v === "number" && !Number.isFinite(v)) ? null : v));
        fs.writeFileSync(path.join(RESULTS_DIR, `capability-${stage}.jsonl`),
            records.map((r) => JSON.stringify(san(r))).join("\n") + "\n");
        fs.writeFileSync(path.join(RESULTS_DIR, `capability-${stage}.md`), L.join("\n"));
        console.log("\n" + L.join("\n"));

        expect(records.length).toBeGreaterThan(0);
    });
});
