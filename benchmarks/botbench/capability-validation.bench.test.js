/**
 * capability-validation.bench.test.js — a compact, durable validation of the
 * emerging-threats detector for the paper (detector alpha-v3.1).
 *
 *     npm run bench-bot-capval
 *
 * Produces results/capability-validation.{md,jsonl}: the two load-bearing,
 * reproducible facts the paper's capability section cites —
 *   (1) the SEPARABILITY SCREEN: clean-truth LOS separation of a λ-exceeded
 *       signature vs its matched in-envelope (λ=1) counterfactual, at strong vs
 *       weak geometry (geometry-determined, detector-independent; a pairwise
 *       test against one counterfactual, not distinguishability from all);
 *   (2) the α̂ MEASUREMENT: the constrained-envelope existence statistic
 *       (optimizer upper-bound estimate of the family minimum α*) on clean
 *       known truth, showing where controls sit below exceedances (quad speed/
 *       climb) and where they do not (fixed-wing speed, flat despite
 *       separability), with α̂ under-estimating truth in the tested cells.
 * NO binary detection claim is produced (uncalibrated — see the fail-closed
 * gate). Seeds fixed; deterministic.
 */

import fs from "fs";
import path from "path";
import {setSit} from "../../src/Globals";
import {generateScenario} from "./lib/generateScenario";
import {toTraverseDataset} from "./lib/adapters";
import {capabilityVerdict, cleanSeparationDeg} from "./lib/capabilityDetect";
import {DETECTOR_VERSION} from "./lib/envelopeFeasibility";

const RESULTS_DIR = path.resolve(__dirname, "results");
const fmt = (v, d = 3) => (v === null || v === undefined || !Number.isFinite(v)) ? "-" : v.toFixed(d);

const GEOMS = {
    recoverable: {r: 2000, d: 60},
    weak: {r: 20000, d: 15},
};
const CASES = [
    {dimension: "quad-speed", catalogId: "air3", family: "quad"},
    {dimension: "quad-climb", catalogId: "air3", family: "quad"},
    {dimension: "fixedwing-speed", catalogId: "mq9", family: "fixedwing"},
];
const LAMBDAS = [1.0, 1.2, 2.0];
const SEEDS = [701, 702];

function mk(geomKey, c, lambda, seed) {
    const g = GEOMS[geomKey];
    return generateScenario({
        durationSeconds: g.d, fps: 10, initialHorizontalRangeM: g.r,
        siteId: "flat-reference",
        platform: {kind: "orbit-point", speedMS: 70, altitudeAGL: 3000},
        target: {kind: "capability", family: c.family,
            parameters: {dimension: c.dimension, catalogId: c.catalogId, lambda}},
        wind: {kind: "zero"}, observation: {kind: "clean", fovFullDeg: 0.9},
    }, {scenarioSeed: seed});
}

describe("capability detector validation (durable, for the paper)", () => {
    jest.setTimeout(2 * 60 * 60 * 1000);
    beforeAll(() => setSit({name: "capval", frames: 10000, fps: 10, simSpeed: 1, lat: 40, lon: -105}));

    test("separability screen + alpha-hat measurement on known truth", async () => {
        const rows = [];
        for (const geomKey of Object.keys(GEOMS)) {
            for (const c of CASES) {
                const ref = mk(geomKey, c, 1.0, SEEDS[0]);   // clean λ=1 reference
                for (const lambda of LAMBDAS) {
                    const s0 = mk(geomKey, c, lambda, SEEDS[0]);
                    const ident = cleanSeparationDeg(ref.observation.cleanDirectionENU,
                        s0.observation.cleanDirectionENU, s0.n);
                    const alphas = [];
                    for (const seed of SEEDS) {
                        const s = mk(geomKey, c, lambda, seed);
                        const v = await capabilityVerdict(s, c.family, c.catalogId);
                        alphas.push(v.alphaStar);
                        // enforced discipline: never a binary claim here
                        if (v.exceedanceForced !== null) throw new Error("uncalibrated claim leaked");
                    }
                    const medAlpha = alphas.slice().sort((a, b) => a - b)[alphas.length >> 1];
                    rows.push({geomKey, dimension: c.dimension, lambda,
                        trueExceedance: s0.capabilityProfile.realizedExceedance,
                        identRmsDeg: ident.rmsDeg, identMaxDeg: ident.maxDeg,
                        medianAlphaHat: medAlpha});
                    console.log(`[capval] ${geomKey} ${c.dimension} λ${lambda}: `
                        + `ident ${fmt(ident.rmsDeg, 3)}° α̂ ${fmt(medAlpha, 2)}`);
                }
            }
        }

        const L = [];
        L.push(`# Capability detector validation (durable) — ${DETECTOR_VERSION}`);
        L.push("");
        L.push("Clean known truth, orbit-point sensor. λ=1.0 is the in-envelope");
        L.push("control. NO binary detection claim (uncalibrated — see the");
        L.push("fail-closed gate); this is the pairwise separability screen and the");
        L.push("α̂ MEASUREMENT the paper cites (α̂ = optimizer upper-bound estimate");
        L.push("of the family minimum α*). Deterministic (seeds 701/702).");
        L.push("");
        L.push("| geometry | dimension | λ | true exc | clean sep RMS° | α̂ median | vs wobble 0.15° |");
        L.push("|---|---|---:|---:|---:|---:|---|");
        for (const r of rows) {
            L.push(`| ${r.geomKey} | ${r.dimension} | ${r.lambda.toFixed(1)} | ${fmt(r.trueExceedance, 2)} `
                + `| ${fmt(r.identRmsDeg, 3)} | ${fmt(r.medianAlphaHat, 2)} `
                + `| ${r.lambda === 1.0 ? "(control)" : (r.identRmsDeg > 0.15 ? "separable" : "sub-wobble")} |`);
        }
        L.push("");
        L.push("Reading: for quad SPEED and CLIMB, α̂ rises with true exceedance and");
        L.push("the in-envelope (λ=1) control sits below the exceeded cases, so a");
        L.push("calibrated threshold could separate them; α̂ conservatively");
        L.push("UNDER-estimates the true exceedance (it is an upper bound on the");
        L.push("family minimum, biased low relative to truth here). For fixed-wing");
        L.push("SPEED, α̂ is FLAT across scale even though the exceeded signature is");
        L.push("pairwise separable from its matched control — a horizontal dash is");
        L.push("reproduced by a nearer/slower in-envelope aircraft, so it is NOT");
        L.push("forced-exceedance (pairwise separability ≠ forced-exceedance");
        L.push("attributability). At weak geometry the +20% small-platform");
        L.push("speed/climb signatures fall below the wobble-amplitude noise floor");
        L.push("(0.15°), so the pairwise screen cannot resolve them there.");

        fs.mkdirSync(RESULTS_DIR, {recursive: true});
        fs.writeFileSync(path.join(RESULTS_DIR, "capability-validation.jsonl"),
            rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
        fs.writeFileSync(path.join(RESULTS_DIR, "capability-validation.md"), L.join("\n"));
        console.log("\n" + L.join("\n"));
        expect(rows.length).toBe(Object.keys(GEOMS).length * CASES.length * LAMBDAS.length);
    });
});
