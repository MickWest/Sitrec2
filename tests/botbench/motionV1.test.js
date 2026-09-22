import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import {MOTION_V1_SETS, generateMotionV1Scenario, generateMotionV1Sets} from "../../benchmarks/botbench/lib/motionV1";
import {generateMotionV1Truth, MOTION_G} from "../../benchmarks/botbench/lib/motionV1Targets";
import {EXTREME_V1_ENVELOPES} from "../../benchmarks/botbench/lib/extremeV1";
import {buildInputCsv, buildAllCsv, buildScenarioJson, invalidFrames} from "../../benchmarks/botbench/lib/exportInterchange";
import {ingestBotCSV} from "../../src/analysis/BotBenchIngest";

const cases = Object.entries(MOTION_V1_SETS).flatMap(([set, variants]) => variants.map(v => [set, v]));
const generated = new Map();
beforeAll(() => { for (const [set, v] of cases) generated.set(v.kind, generateMotionV1Scenario(set, v)); });
const point = (s, time) => Array.from(s.target.positionENU.slice(Math.round(time * s.fps) * 3, Math.round(time * s.fps) * 3 + 3));

test("one example per variant: twenty aviation extremes and eight hypothetical anomalies", () => {
    expect(MOTION_V1_SETS.Extreme_v1).toHaveLength(20);
    expect(MOTION_V1_SETS.Anomalies_v1).toHaveLength(8);
    expect(generated.size).toBe(28);
    expect(Object.keys(EXTREME_V1_ENVELOPES).map(c => MOTION_V1_SETS.Extreme_v1.filter(v => v.parameters.extremeClass === c).length))
        .toEqual([6, 5, 5, 4]);
    for (const [set, v] of cases) {
        const s = generated.get(v.kind);
        expect(s.n).toBe((v.durationSeconds ?? 20) * 10 + 1);
        expect(s.fps).toBe(10);
        expect(s.target.profile.anomalous).toBe(set === "Anomalies_v1");
        expect(s.platform.feasibility.valid).toBe(true);
        expect(s.target.positionENU.every(Number.isFinite)).toBe(true);
        expect(s.events.length).toBeGreaterThan(0);
        expect(s.events.every(e => e.completeInClip && e.endSeconds > e.onsetSeconds)).toBe(true);
    }
});

test.each(cases.map(([set, v]) => [`${set}/${v.kind}`, v]))("%s preserves the trajectory and physical peaks at 1, 10 and 100 Hz", (_, v) => {
    const s = generated.get(v.kind);
    for (const fps of [1, 100]) {
        const r = generateMotionV1Truth(s.spec.target, {n: s.durationSeconds * fps + 1, fps});
        for (let second = 0; second <= s.durationSeconds; second++) {
            expect(Array.from(r.target.positionENU.slice(second * fps * 3, second * fps * 3 + 3))).toEqual(point(s, second));
        }
        expect(r.target.profile.metrics).toEqual(s.target.profile.metrics);
        expect(r.events.map(e => [e.onsetSeconds, e.endSeconds])).toEqual(s.events.map(e => [e.onsetSeconds, e.endSeconds]));
    }
});

test("class limits are published references plus 30%, with claims and assumptions identified", () => {
    expect(Object.values(EXTREME_V1_ENVELOPES).map(e => e.accelerationLimitG)).toEqual([16.354, 26, 15.600000000000001, 52]);
    expect(EXTREME_V1_ENVELOPES["propeller-drone"].speedLimitMS).toBeCloseTo(730 / 3.6 * 1.3, 8);
    expect(EXTREME_V1_ENVELOPES["jet-drone"].speedLimitMS).toBeCloseTo(2211 * 0.44704 * 1.3, 8);
    expect(EXTREME_V1_ENVELOPES["fast-aircraft"].speedLimitMS).toBeCloseTo(3529.56 / 3.6 * 1.3, 8);
    expect(EXTREME_V1_ENVELOPES.hypersonic.speedReference.status).toBe("reported-claim");
    expect(EXTREME_V1_ENVELOPES.hypersonic.accelerationReference.status).toBe("simulation-assumption");
    for (const e of Object.values(EXTREME_V1_ENVELOPES)) {
        expect(e.speedLimitMS / e.referenceSpeedMS).toBeCloseTo(1.3, 10);
        expect(e.accelerationLimitG / e.accelerationReference.value).toBeCloseTo(1.3, 10);
        expect(e.speedReference.url).toMatch(/^https:/);
        expect(e.accelerationReference.url).toMatch(/^https:/);
    }
});

test("all extreme variants reach their speed target and respect the stated g convention", () => {
    for (const v of MOTION_V1_SETS.Extreme_v1) {
        const {metrics: m, envelope: e} = generated.get(v.kind).target.profile;
        expect(m.peakSpeedMS).toBeCloseTo(e.speedLimitMS, 6);
        const g = e.accelerationMetric === "inertial" ? m.peakInertialAccelerationG : m.peakSpecificForceG;
        expect(g).toBeLessThanOrEqual(e.accelerationLimitG + 1e-6);
        expect(m.minAltitudeAGL).toBeGreaterThan(0);
        if (["turn-90", "stop-reverse", "brake-turn-reverse", "shallow-turn"].includes(v.parameters.motion)) {
            expect(g).toBeCloseTo(e.accelerationLimitG, 3);
        }
    }
});

test("vertical drone maneuvers stay in place, and up-down-up contains all three excursions", () => {
    for (const motion of ["ascent", "descent", "up-down-up"]) {
        const s = generated.get(`propeller-drone-${motion}`);
        for (let i = 0; i < s.n; i++) expect(Array.from(s.target.positionENU.slice(i * 3, i * 3 + 2))).toEqual([0, 0]);
        const sign = motion === "descent" ? -1 : 1;
        expect(sign * (point(s, s.durationSeconds)[2] - point(s, 0)[2])).toBeGreaterThan(800);
    }
    const s = generated.get("propeller-drone-up-down-up"), legs = s.events.filter(e => e.kind !== "vertical-stop");
    expect(legs.map(e => e.kind)).toEqual(["accelerate-up", "accelerate-down", "accelerate-up"]);
    expect(s.target.profile.metrics.peakInertialAccelerationG).toBeCloseTo(16.354, 4);
});

test("maximum-speed turns finish at 90 degrees and reversals return along the reciprocal heading", () => {
    for (const cls of ["propeller-drone", "jet-drone", "fast-aircraft"]) {
        const s = generated.get(`${cls}-turn-90`), t = s.durationSeconds;
        const d = point(s, t).map((x, i) => x - point(s, t - 1)[i]);
        expect(d[0]).toBeCloseTo(0, 6);
        expect(d[1]).toBeCloseTo(s.target.profile.envelope.speedLimitMS, 5);
        expect(d[2]).toBeCloseTo(0, 6);
        const reverse = generated.get(`${cls}-${cls === "propeller-drone" ? "stop-reverse" : "brake-turn-reverse"}`);
        const end = reverse.durationSeconds;
        const dx = point(reverse, end)[0] - point(reverse, end - 1)[0];
        expect(dx).toBeCloseTo(-reverse.target.profile.envelope.speedLimitMS, 5);
    }
    const drone = generated.get("propeller-drone-stop-reverse");
    const stop = drone.events[0].endSeconds;
    const t = Math.ceil(stop * 10) / 10;
    expect(point(drone, t)[0]).toBeCloseTo(point(drone, t + 0.1)[0], 6);
});

test("hypersonic variants cover straight/turning crossed with flat/descending", () => {
    for (const motion of ["straight", "turn"]) for (const slope of ["flat", "descending"]) {
        const s = generated.get(`hypersonic-${motion}-${slope}`), p0 = point(s, 0), p1 = point(s, s.durationSeconds);
        expect(p1[0]).toBeGreaterThan(p0[0]);
        if (slope === "flat") expect(p1[2]).toBe(p0[2]);
        else expect(p1[2]).toBeLessThan(p0[2] - 5000);
        if (motion === "straight") expect(p1[1]).toBe(0);
        else expect(p1[1]).toBeGreaterThan(1000);
    }
});

test.each(["propeller-drone-random-3d", "propeller-drone-stop-reverse", "fast-aircraft-climb", "jet-drone-brake-turn-reverse"])
("%s positions independently reproduce the reported acceleration", kind => {
    const s = generated.get(kind);
    const {target} = generateMotionV1Truth(s.spec.target, {n: s.durationSeconds * 100 + 1, fps: 100});
    const p = target.positionENU;
    let peak = 0;
    for (let i = 1; i < p.length / 3 - 1; i++) {
        const a = [0, 1, 2].map(j => (p[3 * (i + 1) + j] - 2 * p[3 * i + j] + p[3 * (i - 1) + j]) * 10000);
        peak = Math.max(peak, Math.hypot(...a) / MOTION_G);
    }
    expect(peak / s.target.profile.metrics.peakInertialAccelerationG).toBeCloseTo(1, 3);
});

test("the 20,000-foot drop completes in one second and rests at both ends", () => {
    const s = generated.get("vertical-drop");
    expect(point(s, 4.9)).toEqual(point(s, 5));
    expect(point(s, 6)).toEqual(point(s, 6.1));
    expect(point(s, 5)[2] - point(s, 6)[2]).toBe(20000 * 0.3048);
    expect(point(s, 5.5)[2]).toBe(6800 - 6096 / 2);
    expect(s.target.profile.metrics.peakSpeedMS).toBeCloseTo(11430, 5);
    // Independent second differences of a denser position export verify that
    // the analytic acceleration metadata describes the actual generated path.
    const {target} = generateMotionV1Truth(s.spec.target, {n: 20001, fps: 1000});
    let peak = 0;
    for (let i = 5001; i < 6000; i++) {
        const z = target.positionENU;
        peak = Math.max(peak, Math.abs(z[3 * (i + 1) + 2] - 2 * z[3 * i + 2] + z[3 * (i - 1) + 2]) * 1e6 / MOTION_G);
    }
    expect(peak / target.profile.metrics.peakInertialAccelerationG).toBeCloseTo(1, 4);
});

test("ping-pong stays within a 1 km region and changes direction repeatedly", () => {
    const s = generated.get("ping-pong");
    const positions = Array.from({length: s.n}, (_, i) => point(s, i / 10));
    let maxSeparation = 0;
    for (const a of positions) for (const b of positions) {
        maxSeparation = Math.max(maxSeparation, Math.hypot(...a.map((x, j) => x - b[j])));
    }
    expect(maxSeparation).toBeLessThan(1000);
    expect(maxSeparation).toBeGreaterThan(700);
    expect(s.events.length).toBeGreaterThan(10);
});

test("loop finishes at its initial altitude; J-hook reverses along the same ground line", () => {
    const loop = generated.get("vertical-loop"), hook = generated.get("j-hook");
    expect(point(loop, 10)[2]).toBe(2000);
    expect(point(loop, 10)[0] - point(loop, 9)[0]).toBeCloseTo(350, 6);
    expect(loop.target.profile.metrics.maxAltitudeAGL).toBeCloseTo(2400, 3);
    expect(point(hook, 10)[2]).toBe(2200);
    expect(point(hook, 10)[0] - point(hook, 9)[0]).toBeCloseTo(-250, 6);
    expect(point(hook, 10)[1]).toBe(0);
});

test("finite speed and heading changes have the intended magnitudes", () => {
    const speed = generated.get("acceleration-braking");
    expect(point(speed, 6)[0] - point(speed, 5.9)[0]).toBeCloseTo(120, 5);
    expect(point(speed, 8)[0] - point(speed, 7)[0]).toBeCloseTo(20, 5);
    const turn = generated.get("sharp-turn");
    expect(point(turn, 10)[0] - point(turn, 9)[0]).toBeCloseTo(0, 6);
    expect(point(turn, 10)[1] - point(turn, 9)[1]).toBeCloseTo(300, 6);
    expect(turn.target.profile.metrics.peakInertialAccelerationG).toBeGreaterThan(350);
    expect(generated.get("high-g-turn").target.profile.metrics.peakSpecificForceG).toBeCloseTo(50, 3);
});

test("water masks measurements without erasing truth, and import does not bridge the gap", () => {
    const s = generated.get("transmedium");
    const bad = invalidFrames(s);
    expect(bad).toEqual(Array.from({length: 69}, (_, i) => i + 46));
    expect(s.observation.occludedCount).toBe(69);
    expect(s.observation.outOfFrameCount).toBe(0);
    expect(s.target.valid.every(Boolean)).toBe(true);
    const csv = buildAllCsv(s, "water", "botbench"), rows = csv.trim().split(/\r?\n/).map(l => l.split(","));
    for (const i of bad) {
        const row = rows[i + 1];
        for (const name of ["LOSUnitVectorX", "LOSUnitVectorY", "LOSUnitVectorZ", "AngularDiameterMaxDeg"]) {
            expect(row[rows[0].indexOf(name)]).toBe("");
        }
        expect(Number(row[rows[0].indexOf("TruePositionZ")])).toBeLessThan(0);
    }
    const record = ingestBotCSV(csv, {sidecar: buildScenarioJson(s, "water")});
    expect(record.dataset.n).toBe(86);
    expect(record.outputSamples.times[0]).toBe(11.5);
    expect(record.outputSamples.times[85]).toBe(20);
});

test("generated files round-trip through Sitrec, match their seals, and reproduce byte for byte", () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "motion-v1-test-"));
    const hash = file => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    try {
        const first = generateMotionV1Sets({outRoot: path.join(temp, "a")});
        generateMotionV1Sets({outRoot: path.join(temp, "b")});
        expect(first.map(r => r.scenarios)).toEqual([200, 80]);
        for (const r of first) {
            const manifest = JSON.parse(fs.readFileSync(path.join(r.dir, "manifest.json")));
            for (const v of MOTION_V1_SETS[r.set]) {
                const variants = manifest.filter(entry => entry.kind === v.kind);
                expect(variants).toHaveLength(10);
                expect(["constant-velocity", "standard-rate", "s-turn", "random"].map(category =>
                    variants.filter(entry => entry.platformCategory === category).length)).toEqual([2, 3, 1, 4]);
                expect(new Set(variants.map(entry => entry.platformVariant)).size).toBe(10);
                expect(new Set(variants.map(entry => entry.durationSeconds)).size).toBe(1);
            }
            for (const entry of manifest) {
                const read = key => fs.readFileSync(path.join(r.dir, entry.files[key]), "utf8");
                expect(hash(path.join(r.dir, entry.files.inputFile))).toBe(entry.digests.inputCsvSha256);
                expect(hash(path.join(r.dir, entry.files.scenarioFile))).toBe(entry.digests.scenarioJsonSha256);
                expect(hash(path.join(r.dir, entry.files.truthFile))).toBe(entry.digests.truthCsvCommit);
                expect(hash(path.join(r.dir, entry.files.truthJsonFile))).toBe(entry.digests.truthJsonCommit);
                expect(hash(path.join(r.dir, entry.files.allFile))).toBe(entry.digests.allCsvCommit);
                const sidecar = JSON.parse(read("scenarioFile"));
                const labels = JSON.parse(read("truthJsonFile"));
                expect(labels.platformProfile).toEqual(entry.platform.profile);
                const record = ingestBotCSV(read("allFile"), {sidecar, labels});
                expect(record.dataset.n).toBe(entry.kind === "transmedium" ? 86 : entry.frames);
                expect(record.dataset.fps).toBeCloseTo(10, 7);
                for (const file of Object.values(entry.files)) {
                    expect(hash(path.join(r.dir, file))).toBe(hash(path.join(temp, "b", r.set, file)));
                }
            }
        }
        expect(() => generateMotionV1Sets({outRoot: path.join(temp, "a")})).toThrow("output already exists");
        const selected = generateMotionV1Sets({outRoot: path.join(temp, "only"), sets: ["Anomalies_v1"]});
        expect(selected.map(r => r.set)).toEqual(["Anomalies_v1"]);
        expect(selected[0].scenarios).toBe(80);
        expect(fs.existsSync(path.join(temp, "only", "Extreme_v1"))).toBe(false);
        expect(() => generateMotionV1Sets({outRoot: path.join(temp, "bad"), sets: ["unknown"]})).toThrow("select unique set names");
    } finally { fs.rmSync(temp, {recursive: true, force: true}); }
});

test("ordinary cases export complete visible LOS without optional water metadata", () => {
    const s = generated.get("fast-aircraft-turn-90");
    expect(invalidFrames(s)).toEqual([]);
    expect(buildScenarioJson(s, "aircraft").sensor.visibility).toBeUndefined();
    const rows = buildInputCsv(s, "aircraft", "botbench").trim().split(/\r?\n/);
    expect(rows).toHaveLength(s.n + 1);
});
