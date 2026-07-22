/**
 * export.bench.test.js — round-2 sitch bridge: write selected BOT Bench
 * scenarios as KML files (platform + target gx:Tracks) for loading into a
 * Sitrec custom sitch.
 *
 *     npm run bench-bot-export
 *
 * Files land in benchmarks/botbench/results/sitches/ (gitignored) with a
 * manifest describing each scenario's truth so the visual check has a key.
 */

import fs from "fs";
import path from "path";
import {setSit} from "../../src/Globals";
import {generateScenario} from "./lib/generateScenario";
import {scenarioToKMLPair} from "./lib/exportKml";

const OUT_DIR = path.resolve(__dirname, "results", "sitches");

const EXPORTS = [
    {
        label: "orbit-balloon-5km-60s",
        note: "Classic recoverable case: 70 m/s orbit at 5 km around a neutral "
            + "party balloon drifting in a 6.3 m/s wind at 500 m AGL. CV/KS "
            + "recover range to ~0.6% here.",
        scenarioSeed: 101,
        spec: {
            epochISO: "2025-02-01T20:00:00Z",   // noon PST: daylight at the ocean site
            durationSeconds: 60, fps: 10, initialHorizontalRangeM: 5000,
            siteId: "ocean",   // real ground ~0 m: flat-proxy altitudes render correctly on the live map
            platform: {kind: "orbit-point", speedMS: 70, altitudeAGL: 3000},
            target: {kind: "party-neutral", family: "balloon", parameters: {startAGL: 500}},
            wind: {kind: "fixed"},
            observation: {kind: "clean", fovFullDeg: 0.5},
        },
    },
    {
        label: "straight-balloon-5km-15s",
        note: "The trap scene: straight-and-level sensor, same balloon. Every "
            + "free solver collapses onto the sensor (relSep 1.0).",
        scenarioSeed: 101,
        spec: {
            epochISO: "2025-02-01T20:00:00Z",   // noon PST: daylight at the ocean site
            durationSeconds: 15, fps: 10, initialHorizontalRangeM: 5000,
            siteId: "ocean",   // real ground ~0 m: flat-proxy altitudes render correctly on the live map
            platform: {kind: "straight", speedMS: 70, altitudeAGL: 3000},
            target: {kind: "party-neutral", family: "balloon", parameters: {startAGL: 500}},
            wind: {kind: "fixed"},
            observation: {kind: "clean", fovFullDeg: 0.5},
        },
    },
    {
        label: "anomalous-impulse-east-20km",
        note: "Impossible event: 120 m/s aircraft-like target takes an "
            + "instantaneous +150 m/s eastward velocity step at t=5 s, watched "
            + "from a 20 km orbit.",
        scenarioSeed: 401,
        spec: {
            epochISO: "2025-02-01T20:00:00Z",   // noon PST: daylight at the ocean site
            durationSeconds: 15, fps: 10, initialHorizontalRangeM: 20000,
            siteId: "ocean",   // real ground ~0 m: flat-proxy altitudes render correctly on the live map
            platform: {kind: "orbit-point", speedMS: 70, altitudeAGL: 3000},
            target: {kind: "anomalous", family: "anomalous",
                parameters: {tupleId: "impulse-east", anomalous: true}},
            wind: {kind: "zero"},
            observation: {kind: "clean", fovFullDeg: 0.5},
        },
    },
];

describe("BOT Bench KML export bridge", () => {
    jest.setTimeout(120000);

    beforeAll(() => {
        setSit({name: "botbench-export", frames: 10000, fps: 10, simSpeed: 1, lat: 40, lon: -105});
    });

    test("writes platform+target KML for the selected scenarios", () => {
        fs.mkdirSync(OUT_DIR, {recursive: true});
        const manifest = [];
        for (const e of EXPORTS) {
            const scenario = generateScenario(e.spec, {scenarioSeed: e.scenarioSeed});
            // One KML per track: sibling placemarks in one Document import as
            // SEGMENTS of a single concatenated track (verified live).
            const {platformKml, targetKml} = scenarioToKMLPair(scenario, {label: e.label});
            const platformFile = path.join(OUT_DIR, `${e.label}-platform.kml`);
            const targetFile = path.join(OUT_DIR, `${e.label}-target.kml`);
            fs.writeFileSync(platformFile, platformKml);
            fs.writeFileSync(targetFile, targetKml);
            manifest.push({
                label: e.label, platformFile, targetFile, note: e.note,
                scenarioId: scenario.scenarioId,
                n: scenario.n, durationSeconds: scenario.durationSeconds,
                epochISO: scenario.site.epochISO,
                site: scenario.site,
            });
            for (const kml of [platformKml, targetKml]) {
                expect(kml.match(/<gx:Track>/g).length).toBe(1);
                expect(kml.match(/<when>/g).length).toBe(scenario.n);
            }
        }
        fs.writeFileSync(path.join(OUT_DIR, "manifest.json"),
            JSON.stringify(manifest, null, 2));
        console.log(`[botbench] wrote ${EXPORTS.length} scenario KMLs to ${OUT_DIR}`);
    });
});
