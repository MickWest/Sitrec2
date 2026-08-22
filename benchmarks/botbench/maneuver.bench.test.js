/**
 * maneuver.bench.test.js — the TRACTABILITY maneuver set in file form:
 * generate one scenario per track kind (lib/maneuverSet.js) and write it out
 * both ways —
 *
 *   results/maneuvers/{Input,Truth,All}/   BOT interchange trios (BotBench dialog)
 *   results/maneuvers/kml/                 platform+target KML pairs (live app)
 *   results/maneuvers/manifest.json        per-type truth key for visual checks
 *
 *     npm run bench-bot-maneuver
 *
 * One scenario per kind at a deliberately DECISIVE geometry (orbiting sensor),
 * so the look at each shape is about the shape, not about collapse. The swept
 * ladders (durations, error rungs, controls) are the botsets —
 * `bench-bot-maneuvers` / `bench-bot-balloons` — which write no KML; this bench
 * is still the only source of KML pairs for the live app.
 */

import fs from "fs";
import path from "path";
import {setSit} from "../../src/Globals";
import {generateScenario} from "./lib/generateScenario";
import {MANEUVER_KINDS, MANEUVER_ANOMALOUS} from "./lib/maneuverTargets";
import {maneuverSpecFor} from "./lib/maneuverSet";
import {writeInterchange, scenarioBaseName} from "./lib/exportInterchange";
import {scenarioToKMLPair} from "./lib/exportKml";

const OUT_DIR = path.resolve(__dirname, "results", "maneuvers");
const KML_DIR = path.join(OUT_DIR, "kml");

// Measured envelope from the generated truth — an independent check on the
// generator's own profile numbers.
function measure(scenario) {
    const p = scenario.target.positionENU;
    const n = scenario.n, dt = 1 / scenario.spec.fps;
    let hMax = 0, vMax = 0, gMax = 0;
    let pvx = null, pvy = null;
    for (let f = 1; f < n; f++) {
        const vx = (p[f * 3] - p[(f - 1) * 3]) / dt;
        const vy = (p[f * 3 + 1] - p[(f - 1) * 3 + 1]) / dt;
        const vz = (p[f * 3 + 2] - p[(f - 1) * 3 + 2]) / dt;
        hMax = Math.max(hMax, Math.hypot(vx, vy));
        vMax = Math.max(vMax, Math.abs(vz));
        if (pvx !== null) {
            gMax = Math.max(gMax, Math.hypot(vx - pvx, vy - pvy) / dt / 9.80665);
        }
        pvx = vx; pvy = vy;
    }
    return {hMax, vMax, gMax};
}

describe("MANEUVER-CLASS first pass", () => {
    jest.setTimeout(120000);

    beforeAll(() => {
        setSit({name: "botbench-maneuver", frames: 10000, fps: 10,
            simSpeed: 1, lat: 40, lon: -105});
    });

    test("generates, verifies, and writes every maneuver kind", () => {
        // Names encode the anomalous flag, so a rename leaves stale files
        // behind — start from an empty output directory every run.
        fs.rmSync(OUT_DIR, {recursive: true, force: true});
        fs.mkdirSync(KML_DIR, {recursive: true});
        const manifest = [];
        const rows = [];

        for (const kind of MANEUVER_KINDS) {
            const spec = maneuverSpecFor(kind);
            const scenario = generateScenario(spec, {scenarioSeed: 801});

            // Deterministic: a second generation is byte-identical.
            const again = generateScenario(spec, {scenarioSeed: 801});
            expect(Buffer.from(scenario.target.positionENU.buffer))
                .toEqual(Buffer.from(again.target.positionENU.buffer));

            const profile = scenario.target.profile;
            expect(profile.kind).toBe(kind);

            // Truth metadata: the spec flag (what interchange truth.json
            // reads) must match the generator's resolved flag, and every
            // anomalous kind must carry a scoring window in events[].
            expect(spec.target.parameters.anomalous).toBe(profile.anomalous);
            if (MANEUVER_ANOMALOUS[kind]) {
                expect(scenario.events.length).toBeGreaterThanOrEqual(1);
                expect(scenario.events.every((e) => e.anomalous)).toBe(true);
                // An anomalous member and its mundane twin must never share a
                // filename (the twin would overwrite the member).
                const twin = {...spec, target: {...spec.target,
                    parameters: {anomalous: false}}};
                expect(scenarioBaseName(twin, 801))
                    .not.toBe(scenarioBaseName(spec, 801));
            }

            // Per-kind sanity on the truth itself.
            const m = measure(scenario);
            if (kind === "static-point") {
                expect(m.hMax).toBe(0);
                expect(m.vMax).toBe(0);
            }
            if (kind === "highg-turn") {
                // Frame-rate differencing underestimates the substepped peak,
                // so allow a loose band around the declared 50 g.
                expect(profile.realizedPeakGLoad).toBeGreaterThan(49);
                expect(profile.realizedPeakGLoad).toBeLessThan(51);
            }
            if (kind === "turn90-instant") {
                const dur = spec.durationSeconds;
                expect(profile.onsetSeconds).toBeGreaterThanOrEqual(0.2 * dur);
                expect(profile.onsetSeconds).toBeLessThanOrEqual(0.8 * dur);
                expect(scenario.events.length).toBe(1);
            }
            if (kind === "hypersonic-glide") {
                expect(m.hMax).toBeGreaterThan(1600);
            }

            writeInterchange(scenario, OUT_DIR, {designIntent: `maneuver-${kind}`});

            const {platformKml, targetKml} = scenarioToKMLPair(scenario, {label: kind});
            fs.writeFileSync(path.join(KML_DIR, `${kind}-platform.kml`), platformKml);
            fs.writeFileSync(path.join(KML_DIR, `${kind}-target.kml`), targetKml);
            expect(targetKml.match(/<when>/g).length).toBe(scenario.n);

            manifest.push({kind, scenarioId: scenario.scenarioId,
                anomalous: !!profile.anomalous, profile,
                rangeM: spec.initialHorizontalRangeM,
                durationSeconds: spec.durationSeconds});
            rows.push([kind, profile.anomalous ? "yes" : "no",
                m.hMax.toFixed(1), m.vMax.toFixed(1), m.gMax.toFixed(1)]);
        }

        fs.writeFileSync(path.join(OUT_DIR, "manifest.json"),
            JSON.stringify(manifest, null, 2));

        const header = ["kind", "anom", "hspd m/s", "vspd m/s", "peak g"];
        const w = header.map((h, i) => Math.max(h.length,
            ...rows.map((r) => r[i].length)));
        const line = (r) => r.map((c, i) => c.padStart(w[i])).join("  ");
        console.log(`[botbench] maneuver first pass -> ${OUT_DIR}\n`
            + line(header) + "\n" + rows.map(line).join("\n"));
    });
});
