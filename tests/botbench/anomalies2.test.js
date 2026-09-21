import fs from "fs";
import os from "os";
import path from "path";
import {generateScenario} from "../../benchmarks/botbench/lib/generateScenario";
import {anomalyViewStats} from "../../benchmarks/botbench/lib/anomalies2";
import {generateBotsetManeuverBatch, BOTSET_MANEUVER_SEED} from "../../benchmarks/botbench/lib/botsetManeuverBatch";
import {
    BOTSET_MANEUVER_DURATIONS_SECONDS, BOTSET_MANEUVER_ERROR_LEVELS,
    botsetManeuverVariants, botsetManeuverSpec,
} from "../../benchmarks/botbench/lib/botsetManeuvers";

const variants = botsetManeuverVariants("anomalies2");
const clean = BOTSET_MANEUVER_ERROR_LEVELS[0];
const make = (v, duration, error = clean) => generateScenario(
    botsetManeuverSpec(v, duration, error), {scenarioSeed: BOTSET_MANEUVER_SEED});

test.each(BOTSET_MANEUVER_DURATIONS_SECONDS)("Anomalies2 at %i seconds has the requested 80%% downward mix", duration => {
    const angles = [];
    for (const v of variants) {
        const scenario = make(v, duration);
        const view = anomalyViewStats(scenario);
        angles.push(Math.round(view.initialDeg));
        expect(scenario.spec.platform.altitudeAGL).toBe(7000);
        expect(scenario.spec.platform.kind).toBe("orbit-point");
        expect(scenario.platform.feasibility.valid).toBe(true);
        expect(scenario.target.profile.anomalous).toBe(true);
        expect(scenario.events.length).toBeGreaterThan(0);
        expect(scenario.observation.outOfFrameCount).toBe(0);
        expect(scenario.observation.observedDirectionENU.every(Number.isFinite)).toBe(true);
        expect(view.minDeg).toBeLessThanOrEqual(view.medianDeg);
        expect(view.medianDeg).toBeLessThanOrEqual(view.maxDeg);
    }
    expect(angles.filter(a => a === 45)).toHaveLength(6);
    expect(angles.filter(a => a === 75)).toHaveLength(6);
    expect(angles.filter(a => a < 45)).toHaveLength(3);
});

test("pointing-error rungs share the same target and sensor truth", () => {
    for (const v of variants) {
        const reference = make(v, 20);
        for (const error of [BOTSET_MANEUVER_ERROR_LEVELS[4], BOTSET_MANEUVER_ERROR_LEVELS[8]]) {
            const noisy = make(v, 20, error);
            expect(noisy.target.positionENU).toEqual(reference.target.positionENU);
            expect(noisy.platform.positionENU).toEqual(reference.platform.positionENU);
            expect(noisy.events).toEqual(reference.events);
            expect(noisy.observation.outOfFrameCount).toBe(0);
            expect(noisy.scenarioId).not.toBe(reference.scenarioId);
        }
    }
});

test("the original anomaly set keeps its old altitude and ranges", () => {
    const originals = botsetManeuverVariants("anomalies");
    expect(originals).toHaveLength(15);
    for (const v of originals) {
        const spec = botsetManeuverSpec(v, 120, clean);
        expect(spec.platform).toEqual({kind: "orbit-point", speedMS: 70, altitudeAGL: 3000});
        expect(spec.initialHorizontalRangeM).toBe(v.rangeM);
        expect(v.depressionDeg).toBeUndefined();
    }
});

test.each([1, 10])("exports a complete %i Hz batch with angular size, paired sidecars, and measured view angles", (fps) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "anomalies2-test-"));
    try {
        const out = generateBotsetManeuverBatch({setKey: "anomalies2", durationSeconds: 20,
            errorLabel: "0.0deg", outRoot: root, fps});
        expect(out.scenarios).toBe(15);
        expect(out.files).toBe(75);
        expect(out.dir).toBe(path.join(root, "Anomalies2", "batch_20s", "0.0deg"));
        const rows = JSON.parse(fs.readFileSync(path.join(out.dir, "manifest.json"), "utf8"));
        expect(new Set(rows.map(r => r.basename)).size).toBe(15);
        expect(fs.readdirSync(path.join(out.dir, "meta"))).toHaveLength(30);
        for (const row of rows) {
            const csv = fs.readFileSync(path.join(out.dir, "All", `${row.basename}.all.csv`), "utf8");
            const lines = csv.trim().split(/\r?\n/);
            const header = lines[0].split(",");
            const angularSize = header.indexOf("AngularDiameterMaxDeg");
            expect(angularSize).toBeGreaterThanOrEqual(0);
            expect(lines).toHaveLength(20 * fps + 2);
            expect(row.fps).toBe(fps);
            expect(row.frames).toBe(20 * fps + 1);
            const sidecar = JSON.parse(fs.readFileSync(path.join(out.dir, "meta", `${row.basename}.scenario.json`), "utf8"));
            expect(sidecar.nominalFps).toBe(fps);
            expect(sidecar.frameCount).toBe(row.frames);
            expect(sidecar.durationSeconds).toBe(20);
            const timeIndex = header.indexOf("Time");
            const timestamps = lines.slice(1).map(line => Number(line.split(",")[timeIndex]));
            expect(timestamps[1] - timestamps[0]).toBeCloseTo(1 / fps, 6);
            expect(timestamps[timestamps.length - 1] - timestamps[0]).toBeCloseTo(20, 6);
            expect(Number(lines[1].split(",")[angularSize])).toBeGreaterThan(0);
            expect(Number.isFinite(row.view.medianDeg)).toBe(true);
            if (row.view.requestedInitialDeg !== null) {
                expect(row.view.initialDeg).toBeCloseTo(row.view.requestedInitialDeg, 8);
            }
        }
    } finally {
        fs.rmSync(root, {recursive: true, force: true});
    }
});
