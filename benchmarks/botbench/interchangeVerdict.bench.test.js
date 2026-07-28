/**
 * interchangeVerdict.bench.test.js — run the shipping traverse analysis over every
 * published interchange scenario and report which ones it resolves.
 *
 *   BOTBENCH_IV_CONFIG=default|wide|both   (default: both)
 *   BOTBENCH_IV_LIMIT=N                    (first N scenarios only)
 *   BOTBENCH_IV_OUT=<path>                 (JSON rows; default results/interchange-verdict.json)
 *
 * WHY TWO CONFIGURATIONS. The range-ladder bracket is the single biggest lever on
 * this problem and production offers two, so measuring one and calling it "the
 * analysis" would be misleading:
 *
 *   default — GUI Min/Max Dist left alone. Production then builds
 *             adaptiveRangeList(startDistance), and the custom sitch ships
 *             startDistance = 1 NM, giving a 0.3-8 NM bracket. Production also
 *             sets `expand: rangeIsDefault`, so THIS BRANCH AUTO-WIDENS: when the
 *             winner lands on a grid edge the sweep extends geometrically, up to
 *             two rounds of x2.5, so 8 NM can become ~50 NM. That is production
 *             behaviour and is faithfully reproduced here.
 *   wide    — the analyst pins a band, so production builds uniformRangeList over
 *             it AND TURNS EXPANSION OFF. 0.5-60 NM here: wide enough to contain
 *             every published scenario (2 km to 50 km) without being centred on
 *             any of them, and genuinely fixed because nothing widens it.
 *
 * The distinction matters and was got wrong first time round. verdictRunner used
 * to hard-code `expand: true`, so the "pinned" configuration silently widened
 * itself per scenario — which is not a controlled comparison, and made the
 * default bracket look far more capable than a fixed 0.3-8 NM window would be.
 * Rows now record the requested AND resolved brackets so this cannot hide again.
 *
 * Both configurations are FIXED ACROSS SCENARIOS. That is what makes the
 * comparison fair — no scenario gets a bracket tuned to its own answer. Truth is
 * used only to score the result, never to choose the search.
 */

import fs from "fs";
import path from "path";
import {readInterchangeScenario, listInterchangeScenarios} from "./lib/readInterchange";
import {runVerdict} from "./lib/verdictRunner";
import {METERS_PER_NM} from "../../src/TraverseAnalysis";

const DIR = path.resolve(__dirname, "results/interchange/answers/All");
const OUT = process.env.BOTBENCH_IV_OUT
    || path.resolve(__dirname, "results/interchange-verdict.json");
// In-progress rows land here and are promoted to OUT only after validation, so
// an incomplete or failed run never publishes a scoreable-looking artifact.
const PARTIAL = OUT + ".partial";
const WANT = process.env.BOTBENCH_IV_CONFIG || "both";
const LIMIT = process.env.BOTBENCH_IV_LIMIT ? Number(process.env.BOTBENCH_IV_LIMIT) : 0;

/** 44 uniform rungs, matching AnalyzeTraverse.uniformRangeList. */
function uniformRangeList(loM, hiM, count = 44) {
    const out = [];
    for (let i = 0; i < count; i++) out.push(loM + (hiM - loM) * i / (count - 1));
    return out;
}

const CONFIGS = {
    // startDistance = 1 NM is data/custom/SitCustom.js's shipped default.
    default: {anchorM: 1 * METERS_PER_NM, ranges: null},
    wide: {anchorM: 10 * METERS_PER_NM,
        ranges: uniformRangeList(0.5 * METERS_PER_NM, 60 * METERS_PER_NM)},
};

/**
 * Truth label -> the Sitrec interpretation class that would be RIGHT.
 *
 * null means no Sitrec class models this object, so the correct outcome is that
 * no class is confidently claimed — "Unknown" is the right answer, not a miss.
 * Deliberately not force-mapped: how often a bird reads as a balloon is a result.
 */
const TRUTH_TO_CLASS = {
    balloon: "balloon",
    aircraft: "fixedWing",
    venus: "knownObject",
    bird: null,
    aerostat: null,
    anomalous: null,
};

function truthRangeStats(scenario) {
    const t = scenario.target;
    if (!t) return null;
    const S = scenario.platform.positionENU;
    let lo = Infinity, hi = -Infinity;
    for (let f = 0; f < scenario.n; f++) {
        if (!t.valid[f]) continue;
        const dx = t.positionENU[f * 3] - S[f * 3];
        const dy = t.positionENU[f * 3 + 1] - S[f * 3 + 1];
        const dz = t.positionENU[f * 3 + 2] - S[f * 3 + 2];
        const r = Math.hypot(dx, dy, dz);
        if (r < lo) lo = r;
        if (r > hi) hi = r;
    }
    return Number.isFinite(lo) ? {loM: lo, hiM: hi} : null;
}

describe("interchange verdict sweep", () => {
    jest.setTimeout(2 * 60 * 60 * 1000);

    test("run every published All scenario", async () => {
        let ids = listInterchangeScenarios(DIR);
        if (process.env.BOTBENCH_IV_IDS) {
            const want = new Set(process.env.BOTBENCH_IV_IDS.split(",").map((s) => s.trim()));
            ids = ids.filter((id) => want.has(id));
        }
        if (LIMIT > 0) ids = ids.slice(0, LIMIT);
        const configNames = WANT === "both" ? ["default", "wide"] : [WANT];

        const rows = [];
        for (const id of ids) {
            const scenario = readInterchangeScenario(DIR, id);
            const truthClass = TRUTH_TO_CLASS[scenario.labels?.objectClass] ?? null;
            const rangeStats = truthRangeStats(scenario);

            for (const cfg of configNames) {
                const {anchorM, ranges} = CONFIGS[cfg];
                const t0 = Date.now();
                let rec = null, error = null;
                try {
                    rec = await runVerdict(scenario, {anchorM, ranges, families: true});
                } catch (e) {
                    error = String(e?.stack || e?.message || e);
                }
                const top = rec?.hypotheses?.[0] ?? null;
                const row = {
                    id, config: cfg,
                    objectClass: scenario.labels?.objectClass ?? null,
                    targetKind: scenario.labels?.targetKind ?? null,
                    anomalous: scenario.labels?.anomalous ?? false,
                    truthClass,
                    truthRangeLoNM: rangeStats ? rangeStats.loM / METERS_PER_NM : null,
                    truthRangeHiNM: rangeStats ? rangeStats.hiM / METERS_PER_NM : null,
                    bracketLoNM: null, bracketHiNM: null,
                    n: scenario.n,
                    error,
                    executiveCode: rec?.executive?.code ?? null,
                    headline: rec?.executive?.headline ?? null,
                    topKey: top?.key ?? null,
                    topName: top?.name ?? null,
                    topTier: top?.tier ?? null,
                    topErrDeg: top?.errDeg ?? null,
                    topTruthSepM: top?.truthSepM ?? null,
                    viableClasses: (rec?.classes ?? []).filter((c) => c.viable).map((c) => c.key),
                    testedClasses: (rec?.classes ?? []).map((c) => c.key),
                    // The per-class BLOCKER is the whole diagnostic: viability is
                    // complete && close && ordinary, and which of the three failed
                    // says whether the problem is the search (pins/clamps), the fit
                    // (residual), or the physics screen (kinematics). Without it a
                    // failed scenario is just "unresolved" with no way in.
                    classDetail: (rec?.classes ?? []).map((c) => ({
                        key: c.key, tested: c.tested, viable: c.viable,
                        complete: c.complete, close: c.close, ordinary: c.ordinary,
                        bestErrDeg: c.bestErrDeg, blocker: c.blocker,
                        ...(c.key === "balloon" ? {consistency: c.consistency ?? null} : {}),
                    })),
                    // Top few ranked hypotheses, so a wrong winner can be compared
                    // against what it beat.
                    topHypotheses: (rec?.hypotheses ?? []).slice(0, 12).map((h) => ({
                        key: h.key, name: h.name, tier: h.tier, rank: h.rank,
                        errDeg: h.errDeg, truthSepM: h.truthSepM,
                        activePins: h.activePins, modelClamps: h.modelClamps,
                        incomplete: h.incomplete,
                        // `incomplete` is boundaryLimited OR an optimizer warning.
                        // With no pins and no clamps those are very different
                        // diagnoses — one says the model ran out of envelope, the
                        // other says the search never converged — so the warnings
                        // have to be carried, not inferred.
                        optimizerWarnings: h.optimizerWarnings,
                        band: h.band ? {loM: h.band.rangeLoM, hiM: h.band.rangeHiM,
                            screened: h.band.screenedCount, intervals: h.band.intervals?.length,
                            boundaryLimited: h.band.boundaryLimited} : null,
                    })),
                    provenance: rec?.provenance ?? null,
                    unionCoverage: rec?.familyCoverage?.union?.coverageFrac ?? null,
                    perClassCoverage: rec?.familyCoverage?.perClass
                        ? Object.fromEntries(Object.entries(rec.familyCoverage.perClass)
                            .map(([k, v]) => [k, v.coverageFrac]))
                        : null,
                    // What was asked for vs what was actually searched. The sweep
                    // widens its own grid when the winner lands on an edge, so a
                    // "pinned" configuration is only pinned if expansion is off.
                    requestedLoNM: rec ? rec.requestedRangeLoM / METERS_PER_NM : null,
                    requestedHiNM: rec ? rec.requestedRangeHiM / METERS_PER_NM : null,
                    resolvedLoNM: rec ? rec.resolvedRangeLoM / METERS_PER_NM : null,
                    resolvedHiNM: rec ? rec.resolvedRangeHiM / METERS_PER_NM : null,
                    expandEnabled: rec?.expandEnabled ?? null,
                    truthIsDirectionOnly: rec?.truthIsDirectionOnly ?? null,
                    failures: rec?.failures ?? [],
                    timingMs: Date.now() - t0,
                };
                const rl = ranges ?? null;
                if (rl) {
                    row.bracketLoNM = rl[0] / METERS_PER_NM;
                    row.bracketHiNM = rl[rl.length - 1] / METERS_PER_NM;
                }
                rows.push(row);
                // eslint-disable-next-line no-console
                console.log(`${id} [${cfg}] ${row.executiveCode ?? "ERROR"} `
                    + `top=${row.topKey} sep=${row.topTruthSepM === null ? "-"
                        : Math.round(row.topTruthSepM) + "m"} `
                    + `cov=${row.unionCoverage === null ? "-" : row.unionCoverage.toFixed(2)} `
                    + `(${(row.timingMs / 1000).toFixed(1)}s)`);
                // Progress goes to a .partial file, NOT to the canonical path.
                // A run that dies halfway — or one whose scenarios all threw —
                // must not leave a complete-looking artifact for the scorer to
                // read. See the publish step after the loop.
                fs.writeFileSync(PARTIAL, JSON.stringify(rows, null, 1));
            }
        }

        // VALIDATE BEFORE PUBLISHING. A row count alone passes green even if
        // every scenario threw and the table is all nulls, and the scorer would
        // then read those nulls as results — two crashed pair members compare
        // equal and report "INDISTINGUISHABLE", which is a harness failure
        // dressed as a finding. So nothing reaches the canonical path until the
        // rows are known to be complete.
        const problems = [];
        if (rows.length !== ids.length * configNames.length) {
            problems.push(`expected ${ids.length * configNames.length} rows, got ${rows.length}`);
        }
        for (const r of rows.filter((x) => x.error)) {
            problems.push(`${r.id} [${r.config}] errored: ${String(r.error).split("\n")[0]}`);
        }
        for (const r of rows.filter((x) => !x.error && x.executiveCode === null)) {
            problems.push(`${r.id} [${r.config}] produced no executive verdict`);
        }

        if (problems.length) {
            throw new Error(`Run INVALID — ${problems.length} problem(s); `
                + `${path.basename(OUT)} was NOT written, partial rows are in `
                + `${path.basename(PARTIAL)}:\n  ` + problems.join("\n  "));
        }

        fs.writeFileSync(OUT, JSON.stringify(rows, null, 1));
        if (fs.existsSync(PARTIAL)) fs.unlinkSync(PARTIAL);
    });
});
