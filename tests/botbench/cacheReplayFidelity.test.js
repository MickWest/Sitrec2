/**
 * THE CACHE MUST NOT BE A SECOND CODE PATH.
 *
 * BOTBench's folder cache stores the fitted BATTERY, not the finished result.
 * A cache hit re-ingests the file and replays runBotBenchAnalysis with that
 * battery handed in, so every line below the fit — truth scoring, declared-range
 * compliance, the report series, the manifest, the row — runs exactly as it does
 * on a fresh analysis.
 *
 * That claim is only worth anything if it is measured, because the failure mode
 * is silent: a cached row that is subtly different from a fresh one looks like a
 * result, not like a bug. So this runs the SAME record twice — once for real,
 * once through JSON and back — and requires the two to agree field by field.
 *
 * It has already earned that: the first run of this file found that the codec
 * dropped the fields rangeProfile hangs off its returned ARRAY, which flipped
 * the manifest's slowProfileBoundaryLimited from true to false while leaving
 * every track identical.
 *
 * @jest-environment jsdom
 */
// threeExt.js — pulled in transitively by the runner — imports three/addons,
// which is ESM inside node_modules and cannot be loaded by Jest. Stubbed HERE
// rather than in the global moduleNameMapper: node-smoke.test.js exists to
// prove those imports resolve for real, and a project-wide stub makes that test
// pass vacuously (measured: it took 121 other tests down with it).
jest.mock("three/addons/lines/LineMaterial.js", () => ({LineMaterial: class {}}), {virtual: true});
jest.mock("three/addons/lines/LineGeometry.js", () => ({LineGeometry: class {}}), {virtual: true});
jest.mock("three/addons/lines/Line2.js", () => ({Line2: class {}}), {virtual: true});

import {setSit} from "../../src/Globals";
import {ingestMISBRecords} from "../../src/analysis/BotBenchIngest";
import {runBotBenchAnalysis} from "../../src/analysis/BotBenchRunner";
import {packForCache, unpackFromCache} from "../../src/analysis/BotBenchCacheCodec";
import {MISB, MISBFields} from "../../src/MISBFields";

jest.setTimeout(600000);

const START_US = 1348087826484970;

// A short clip with a moving sensor and a swinging gimbal — enough geometry for
// the battery to have something to fit, small enough to run twice in a test.
function clipMISB(n = 40) {
    const misb = [];
    for (let i = 0; i < n; i++) {
        const row = new Array(MISBFields).fill(null);
        row[MISB.UnixTimeStamp] = START_US + i * 200000;          // 5 Hz
        row[MISB.SensorLatitude] = 41.0957 + i * 4e-5;
        row[MISB.SensorLongitude] = -104.8702 + i * 6e-5;
        row[MISB.SensorTrueAltitude] = 2933 + i * 0.5;
        row[MISB.PlatformHeadingAngle] = 157.6 + i * 0.05;
        row[MISB.PlatformPitchAngle] = 3.4;
        row[MISB.PlatformRollAngle] = -6.5;
        row[MISB.SensorRelativeAzimuthAngle] = 254.25 + i * 0.02;
        row[MISB.SensorRelativeElevationAngle] = -20.38 + i * 0.01;
        row[MISB.SensorRelativeRollAngle] = 0;
        row[MISB.FrameCenterLatitude] = 41.1068 + i * 1e-5;
        row[MISB.FrameCenterLongitude] = -104.8510 + i * 1e-5;
        row[MISB.FrameCenterElevation] = 1867;
        misb.push(row);
    }
    return misb;
}

const ingest = () => ingestMISBRecords(clipMISB(), {label: "clip.ts", geoid: false});

// Float64Array and friends do not survive JSON.stringify, and neither do NaN or
// Infinity, so the comparison is made on the CODEC's encoding of each side —
// the same encoding the cache file uses. Comparing the encodings is therefore
// comparing exactly what a cache round trip can carry.
const fingerprint = (v) => JSON.stringify(packForCache(v));

// The first place two encodings disagree, as a path. A plain toBe() on two
// multi-megabyte fingerprints prints both in full and says nothing about which
// field moved, which makes a real failure unreadable — and this test only earns
// its keep if a failure points at the cause.
function firstDifference(a, b, path = "results") {
    if (a === b) return null;
    const ta = a === null ? "null" : typeof a, tb = b === null ? "null" : typeof b;
    if (ta !== tb) return `${path}: ${ta} vs ${tb}`;
    if (ta !== "object") return `${path}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`;
    if (Array.isArray(a) !== Array.isArray(b)) return `${path}: array vs object`;
    if (Array.isArray(a)) {
        if (a.length !== b.length) return `${path}.length: ${a.length} vs ${b.length}`;
        for (let i = 0; i < a.length; i++) {
            const d = firstDifference(a[i], b[i], `${path}[${i}]`);
            if (d) return d;
        }
        return null;
    }
    const ka = Object.keys(a), kb = Object.keys(b);
    if (ka.join() !== kb.join()) {
        const missing = ka.filter((k) => !kb.includes(k));
        const extra = kb.filter((k) => !ka.includes(k));
        return `${path}: keys differ (missing ${missing.join()||"-"}, extra ${extra.join()||"-"})`;
    }
    for (const k of ka) {
        const d = firstDifference(a[k], b[k], `${path}.${k}`);
        if (d) return d;
    }
    return null;
}

const diff = (x, y, label) =>
    firstDifference(packForCache(x), packForCache(y), label);

beforeAll(() => {
    setSit({name: "botbench", frames: 100000, fps: 10, simSpeed: 1, lat: 41, lon: -104.87});
    // The report draws its heat maps into a canvas, which jsdom does not
    // implement. Stubbed rather than skipped: BOTH runs render through the same
    // stub, so the images are equally blank and any difference left in the HTML
    // is a difference in the DATA — which is the only thing this test is asking
    // about. The real rendering is a browser concern and is covered there.
    const ctx = new Proxy({}, {get: () => () => ctx});
    document.createElement = ((original) => (tag) => (tag === "canvas"
        ? {width: 0, height: 0, style: {}, getContext: () => ctx,
            toDataURL: () => "data:image/png;base64,stub"}
        : original.call(document, tag)))(document.createElement);
});

describe("a replayed analysis equals a fresh one", () => {
    let fresh, replayed;

    beforeAll(async () => {
        fresh = await runBotBenchAnalysis(ingest(), {});
        // Exactly what the cache does: pack the battery, write it as text, read
        // it back, and hand it to a fresh ingest of the same file.
        const battery = unpackFromCache(JSON.parse(JSON.stringify(packForCache(fresh.battery))));
        replayed = await runBotBenchAnalysis(ingest(), {
            battery, elapsedMs: fresh.elapsedMs,
        });
    });

    // THE ROW IS THE PRODUCT. Everything the table, the export and the scatter
    // plots show comes from here, so this is the headline claim.
    test("the row is identical", () => {
        expect(diff(fresh.row, replayed.row, "row")).toBeNull();
    });

    // Including the timing, which is a measurement of the fit and would
    // otherwise report the replay's own near-zero cost.
    test("the row still reports the original run time", () => {
        expect(replayed.elapsedMs).toBe(fresh.elapsedMs);
    });

    // Every candidate, coordinate for coordinate — the tracks are what Gallery
    // draws and what the handoff turns back into geography.
    test("every hypothesis is identical, tracks included", () => {
        const h1 = fresh.results.hypotheses, h2 = replayed.results.hypotheses;
        expect(h2.length).toBe(h1.length);
        for (let i = 0; i < h1.length; i++) {
            expect(diff(h1[i], h2[i], `hypotheses[${i}](${h1[i].key})`)).toBeNull();
        }
    });

    // The whole result object, minus the closure — the catch-all, so a field
    // added to the analysis later is covered without anyone remembering to
    // extend this file.
    test("the rest of the results object is identical", () => {
        const strip = (r) => {
            const {buildHtml, ...rest} = r;
            return rest;
        };
        expect(diff(strip(fresh.results), strip(replayed.results), "results")).toBeNull();
    });

    // buildHtml is a CLOSURE over values that never reach `results` — the report
    // series, the wind text, the battery's own brackets. Serializing `results`
    // could not have carried it, which is the reason the cache replays the run
    // instead. Same bytes out means the closure was rebuilt over the same data.
    test("the HTML report is byte-identical", () => {
        expect(typeof replayed.results.buildHtml).toBe("function");
        const a = fresh.results.buildHtml(), b = replayed.results.buildHtml();
        if (a !== b) {
            let i = 0;
            while (i < a.length && i < b.length && a[i] === b[i]) i++;
            throw new Error(`report differs at offset ${i} of ${a.length}/${b.length}\n`
                + `  fresh:    ...${a.slice(Math.max(0, i - 90), i + 90)}\n`
                + `  replayed: ...${b.slice(Math.max(0, i - 90), i + 90)}`);
        }
    });
});
