/**
 * realtracks.bench.test.js — REAL-TRACK ARM first pass: standard synthetic
 * platforms observing targets cut from real GPS tracks (real-tracks/*.csv),
 * arranged as recognizable case geometries:
 *
 *   gofast      "Go Fast": fast high platform, wind-borne balloon midway
 *               between platform altitude and the ocean. Paired with a
 *               spliced-impulse twin — a Go Fast that actually goes fast.
 *   aguadilla   "Aguadilla": low platform arcing past a lantern-like slow
 *               riser near the surface, operator wobble.
 *   rubberduck  "Rubber Duck": two full orbits of a slow-moving target
 *               (balloon drift / slow hexarotor) — maximum parallax.
 *   burst       radiosonde burst window: a mundane object with a violent
 *               dynamics discontinuity — the anomaly false-positive probe.
 *   dash        real 44 m/s VTOL run seen from 20 km on a straight pass —
 *               the fast-far vs slow-near ambiguity, with real texture.
 *   circuits    real fixed-wing flying tight circuits — the figure-eight
 *               family's real-world anchor.
 *   hover pair  slow hexarotor segment, raw (ctrl) vs +120 m/s impulse
 *               splice (anom), identical pointing-error realization.
 *
 *     npm run bench-bot-real
 *
 * Output: results/real-scenarios/{Input,Truth,All}/ interchange trios,
 * kml/ pairs, manifest.json. Anomaly pairs share pairId and the observation
 * seed key, so the members differ ONLY in the spliced event — the seam-free
 * pairing the real-track arm exists to provide.
 */

import fs from "fs";
import path from "path";
import {setSit} from "../../src/Globals";
import {generateScenario} from "./lib/generateScenario";
import {REAL_SCENARIOS, buildRealScenarioSpec} from "./lib/realScenarioSet";
import {writeInterchange, scenarioBaseName} from "./lib/exportInterchange";
import {scenarioToKMLPair} from "./lib/exportKml";

const OUT_DIR = path.resolve(__dirname, "results", "real-scenarios");
const KML_DIR = path.join(OUT_DIR, "kml");

describe("REAL-TRACK ARM first pass", () => {
    jest.setTimeout(180000);

    beforeAll(() => {
        setSit({name: "botbench-real", frames: 10000, fps: 10,
            simSpeed: 1, lat: 40, lon: -105});
    });

    test("builds the case-geometry set from real segments", () => {
        fs.rmSync(OUT_DIR, {recursive: true, force: true});
        fs.mkdirSync(KML_DIR, {recursive: true});
        const manifest = [];
        const rows = [];
        const byName = new Map();
        const generated = new Map();

        for (const def of REAL_SCENARIOS) {
            const {spec, seg} = buildRealScenarioSpec(def);
            const scenario = generateScenario(spec, {scenarioSeed: 901});

            // Determinism through the registry.
            const again = generateScenario(spec, {scenarioSeed: 901});
            expect(Buffer.from(scenario.target.positionENU.buffer))
                .toEqual(Buffer.from(again.target.positionENU.buffer));

            // Names must be unique across the whole set (pairs included).
            const name = scenarioBaseName(spec, 901);
            expect(byName.has(name)).toBe(false);
            byName.set(name, def);

            // Provenance is bound to the file bytes.
            expect(scenario.target.profile.provenance.sourceSha256)
                .toMatch(/^[0-9a-f]{64}$/);

            if (def.anomalous) {
                expect(scenario.events.length).toBe(1);
                expect(scenario.events[0].anomalous).toBe(true);
            } else if (def.paired) {
                // A control carries its twin's event window, zero delta-v.
                expect(scenario.events.length).toBe(1);
                expect(scenario.events[0].anomalous).toBe(false);
            } else {
                expect(scenario.events.length).toBe(0);
            }

            writeInterchange(scenario, OUT_DIR, {designIntent: `real-${def.label}`});
            const {platformKml, targetKml} = scenarioToKMLPair(scenario, {label: name});
            fs.writeFileSync(path.join(KML_DIR, `${name}-platform.kml`), platformKml);
            fs.writeFileSync(path.join(KML_DIR, `${name}-target.kml`), targetKml);

            generated.set(`${def.label}|${def.anomalous ? "anom" : "ctrl"}`, scenario);
            manifest.push({label: def.label, anomalous: def.anomalous === true,
                pairId: def.pairId ?? null, name,
                scenarioId: scenario.scenarioId, note: def.note,
                provenance: seg.provenance});

            const p = scenario.target.positionENU;
            const dt = 1 / spec.fps;
            let hMax = 0, vMin = 0, vMax = 0;
            for (let f = 1; f < scenario.n; f++) {
                hMax = Math.max(hMax, Math.hypot(p[f * 3] - p[(f - 1) * 3],
                    p[f * 3 + 1] - p[(f - 1) * 3 + 1]) / dt);
                const vz = (p[f * 3 + 2] - p[(f - 1) * 3 + 2]) / dt;
                vMin = Math.min(vMin, vz);
                vMax = Math.max(vMax, vz);
            }
            rows.push([name.split("_")[3] + (def.anomalous ? "*" : ""),
                String(scenario.n), `${spec.fps}`, hMax.toFixed(1),
                `${vMin.toFixed(1)}..${vMax.toFixed(1)}`,
                seg.provenance.nativeMeanDtSeconds.toFixed(2)]);
        }

        // Pair discipline: identical pointing-error realization, and the
        // spliced impulse accounts for the entire truth difference.
        for (const pair of ["gofast", "hover"]) {
            const ctrl = generated.get(`${pair}|ctrl`);
            const anom = generated.get(`${pair}|anom`);
            expect(Buffer.from(ctrl.observation.tangentErrorDeg.buffer))
                .toEqual(Buffer.from(anom.observation.tangentErrorDeg.buffer));
            const ev = anom.events[0];
            const T = (anom.n - 1) / anom.spec.fps;
            const dtEnd = T - ev.onsetSeconds;
            const i = (anom.n - 1) * 3;
            const dv = ev.parameters.deltaVENU;
            expect(anom.target.positionENU[i] - ctrl.target.positionENU[i])
                .toBeCloseTo(dv[0] * dtEnd, 6);
            expect(anom.target.positionENU[i + 1] - ctrl.target.positionENU[i + 1])
                .toBeCloseTo(dv[1] * dtEnd, 6);
        }

        fs.writeFileSync(path.join(OUT_DIR, "manifest.json"),
            JSON.stringify(manifest, null, 2));

        const header = ["scenario", "n", "fps", "hspd m/s", "vspd m/s", "src dt s"];
        const w = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
        const line = (r) => r.map((c, i) => c.padStart(w[i])).join("  ");
        console.log(`[botbench] real-track arm -> ${OUT_DIR}\n`
            + line(header) + "\n" + rows.map(line).join("\n"));
    });
});
