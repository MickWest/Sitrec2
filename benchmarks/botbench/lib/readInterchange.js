/**
 * readInterchange.js — read a published BOT interchange scenario back in.
 *
 * The interchange release (benchmarks/botbench/results/interchange) is the honest
 * input to the analysis, and it is honest for a specific reason: the sidecar
 * carries only what a solver is entitled to see — frame origin, epoch, fps, the
 * declared LOS error, the analyst wind ESTIMATE, the sensor FOV — and deliberately
 * withholds the generating spec. In particular it carries no
 * `initialHorizontalRangeM`, so a run built from these files cannot accidentally
 * anchor its range search on the target's true starting range the way a run built
 * from an in-memory scenario can (see verdictRunner.runVerdict's anchorM).
 *
 * TRUTH IS QUARANTINED. The All CSV's TruePosition columns are read into
 * `target`, which `truthReference()` uses for SCORING only. Nothing that reaches
 * `buildHypotheses` is derived from them:
 *
 *   analysis sees   S (SensorPosition), D (LOSUnitVector), W (sidecar wind
 *                   estimate), fps, origin, epoch, MaxRange
 *   scoring sees    TruePosition, and the labels in the .truth.json sidecar
 *
 * The `spec` field is left UNDEFINED on purpose rather than reconstructed. Any
 * caller that wants a range anchor must state it explicitly and use the same one
 * for every scenario, which is what makes a cross-scenario comparison fair.
 */

import fs from "fs";
import path from "path";

// The columns of the three interchange shapes (BOT-Interchange-Format.html).
// Matched case-insensitively after trimming, like the app-side importer.
const COL = {
    trackId: "trackid", time: "time",
    sensorX: "sensorpositionx", sensorY: "sensorpositiony", sensorZ: "sensorpositionz",
    losX: "losunitvectorx", losY: "losunitvectory", losZ: "losunitvectorz",
    maxRange: "maxrange", losUncertainty: "losuncertainty",
    truthX: "truepositionx", truthY: "truepositiony", truthZ: "truepositionz",
};

/**
 * Empty cells are MISSING, not zero.
 *
 * Number("") is 0, which would silently place a point at the frame origin. The
 * format uses a blank truth triple for a direction-only target (Venus has a
 * bearing and no finite range), so this distinction decides whether that scenario
 * gets a truth track at all.
 */
function cell(v) {
    if (v === undefined || v === null) return NaN;
    const s = String(v).trim();
    return s === "" ? NaN : Number(s);
}

function parseCsv(text) {
    const lines = text.trim().split(/\r?\n/);
    const header = lines[0].split(",").map((h) => h.trim().toLowerCase());
    const idx = {};
    for (const [key, name] of Object.entries(COL)) idx[key] = header.indexOf(name);
    const rows = lines.slice(1).map((l) => l.split(","));
    return {idx, rows};
}

/**
 * Load one published scenario.
 *
 * `dir` is the directory holding bot-NNNN.all.csv and bot-NNNN.scenario.json;
 * the .truth.json label sidecar is read when present (labels only — they are
 * carried on `labels`, never on anything the analysis reads).
 */
export function readInterchangeScenario(dir, id) {
    const csvPath = path.join(dir, `${id}.all.csv`);
    const jsonPath = path.join(dir, `${id}.scenario.json`);
    const {idx, rows} = parseCsv(fs.readFileSync(csvPath, "utf8"));
    const sidecar = JSON.parse(fs.readFileSync(jsonPath, "utf8"));

    let labels = null;
    const truthJson = path.join(dir, `${id}.truth.json`);
    if (fs.existsSync(truthJson)) labels = JSON.parse(fs.readFileSync(truthJson, "utf8"));

    const n = rows.length;
    const fps = sidecar.nominalFps ?? 1;

    const S = new Float64Array(n * 3);
    const D = new Float64Array(n * 3);
    const W = new Float64Array(n * 3);
    const inFov = new Uint8Array(n);
    const T = new Float64Array(n * 3);
    const tValid = new Uint8Array(n);

    // The sidecar wind is the ANALYST estimate: the generator's mean field
    // perturbed by a deterministic draw at sigmaMS, published precisely so a
    // solver has something imperfect to work with. Using the generator's exact
    // field here would be an inverse crime. Constant over the clip, so the
    // per-frame displacement is just velocity / fps.
    const windE = sidecar.wind?.E ?? 0;
    const windN = sidecar.wind?.N ?? 0;

    // invalidFrames marks frames the format declares unusable (target outside the
    // sensor FOV, or otherwise not observed). They are excluded from scoring and
    // from the coverage denominator, matching lib/observation.js.
    const invalid = new Set(sidecar.invalidFrames ?? []);

    let anyTruth = false;
    let maxRangeM = null;

    for (let f = 0; f < n; f++) {
        const r = rows[f];
        S[f * 3] = cell(r[idx.sensorX]);
        S[f * 3 + 1] = cell(r[idx.sensorY]);
        S[f * 3 + 2] = cell(r[idx.sensorZ]);
        D[f * 3] = cell(r[idx.losX]);
        D[f * 3 + 1] = cell(r[idx.losY]);
        D[f * 3 + 2] = cell(r[idx.losZ]);
        W[f * 3] = windE / fps;
        W[f * 3 + 1] = windN / fps;
        W[f * 3 + 2] = 0;
        inFov[f] = invalid.has(f) ? 0 : 1;

        if (idx.truthX !== -1) {
            const tx = cell(r[idx.truthX]), ty = cell(r[idx.truthY]), tz = cell(r[idx.truthZ]);
            if (Number.isFinite(tx) && Number.isFinite(ty) && Number.isFinite(tz)) {
                T[f * 3] = tx; T[f * 3 + 1] = ty; T[f * 3 + 2] = tz;
                tValid[f] = 1;
                anyTruth = true;
            }
        }
        if (idx.maxRange !== -1) {
            const mr = cell(r[idx.maxRange]);
            if (Number.isFinite(mr)) maxRangeM = maxRangeM === null ? mr : Math.max(maxRangeM, mr);
        }
    }

    const [originLat, originLon] = sidecar.frame?.originLLA ?? [35, -125, 0];

    return {
        scenarioId: id,
        n, fps,
        platform: {positionENU: S},
        observation: {observedDirectionENU: D, cleanDirectionENU: D, inFov},
        wind: {displacementPerFrameENU: W},
        // Direction-only targets get NO target object at all, so truthReference()
        // returns null and band containment is undefined rather than scored zero.
        target: anyTruth
            ? {positionENU: T, valid: tValid, family: labels?.objectClass ?? null}
            : null,
        constraints: {maxRangeM, minRangeM: undefined},
        site: {
            latDeg: originLat, lonDeg: originLon,
            epochISO: sidecar.epochISO ?? "2025-02-01T20:00:00Z",
        },
        // spec is deliberately absent — see the module comment.
        sidecar,
        labels,
    };
}

/** Every scenario id in `dir`, in published order. */
export function listInterchangeScenarios(dir) {
    return fs.readdirSync(dir)
        .filter((f) => f.endsWith(".all.csv"))
        .map((f) => f.replace(/\.all\.csv$/, ""))
        .sort();
}
