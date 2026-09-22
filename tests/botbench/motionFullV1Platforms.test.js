import {MOTION_FULL_V1_PLATFORMS} from "../../benchmarks/botbench/lib/motionFullV1Platforms";
import {MOTION_V1_SETS} from "../../benchmarks/botbench/lib/motionV1";
import {generatePlatformPath} from "../../benchmarks/botbench/lib/platforms";
import {motionFullV1Spec, motionFullV1Basename, generateMotionFullV1Scenario,
    MOTION_FULL_V1_ERRORS} from "../../benchmarks/botbench/lib/motionFullV1";

const set = "Extreme_full_v1", target = MOTION_V1_SETS.Extreme_v1[0];
const specFor = (platform, seconds, fps) => motionFullV1Spec(set, target, platform, seconds, MOTION_FULL_V1_ERRORS[1], fps);
const pathFor = (platform, seconds, fps) => generatePlatformPath(specFor(platform, seconds, fps).platform,
    seconds * fps + 1, Array.from({length: seconds * fps + 1}, (_, i) => i / fps), fps, 5000);

test("ten paths contain two straight controls and eight seeded, slower-than-standard bends", () => {
    expect(MOTION_FULL_V1_PLATFORMS).toHaveLength(10);
    expect(MOTION_FULL_V1_PLATFORMS.filter(p => p.category === "constant-velocity")).toHaveLength(2);
    const curved = MOTION_FULL_V1_PLATFORMS.filter(p => p.category === "curved");
    expect(curved).toHaveLength(8);
    expect(new Set(curved.flatMap(p => p.turnRatesDegS)).size).toBeGreaterThan(6);
    const shapes = new Set();
    for (const p of MOTION_FULL_V1_PLATFORMS) {
        const result = pathFor(p, 120, 10), profile = result.profile;
        shapes.add(JSON.stringify(Array.from(result.positionENU)));
        expect(result.feasibility.valid).toBe(true);
        expect(profile.maxBankDeg).toBeLessThan(20);
        expect(profile.maxTurnRateDegS).toBeLessThan(3);
        const turns = profile.segments.filter(s => s.kind === "turn");
        if (p.category === "curved") {
            expect(turns).toHaveLength(p.turnAnglesDeg.length);
            expect(new Set(turns.map(s => Math.sign(s.turnRateDegS))).size).toBe(1);
            turns.forEach((s, i) => expect(s.turnRateDegS * s.durationSeconds).toBeCloseTo(p.turnAnglesDeg[i], 8));
            expect(profile.segments[0].kind).toBe("straight");
            expect(profile.segments.at(-1).kind).toBe("straight");
            const master = pathFor(p, 300, 10).profile;
            expect(master.turnCount).toBe(turns.length + 2);
            expect(master.segments.some(s => s.kind === "turn" && s.endSeconds < 90)).toBe(true);
            expect(master.segments.some(s => s.kind === "turn" && s.startSeconds > 210)).toBe(true);
            expect(master.totalAbsoluteHeadingChangeDeg).toBeCloseTo(Math.abs(p.turnAnglesDeg.reduce((a, b) => a + b, 0)) + 120, 8);
        } else expect(turns).toHaveLength(0);

        // Measure heading changes from coordinates, independently of the
        // metadata, so tiny doglegs or full circles cannot masquerade as bends.
        let previous, net = 0, absolute = 0;
        for (let f = 1; f <= 1200; f++) {
            const x = result.positionENU[f * 3] - result.positionENU[(f - 1) * 3];
            const y = result.positionENU[f * 3 + 1] - result.positionENU[(f - 1) * 3 + 1];
            const heading = Math.atan2(x, y);
            if (previous !== undefined) {
                const delta = Math.atan2(Math.sin(heading - previous), Math.cos(heading - previous)) * 180 / Math.PI;
                net += delta;
                absolute += Math.abs(delta);
            }
            previous = heading;
            expect(result.positionENU[f * 3 + 2]).toBe(7000);
        }
        const expected = (p.turnAnglesDeg ?? []).reduce((a, b) => a + b, 0);
        expect(net).toBeCloseTo(expected, 6);
        expect(absolute).toBeCloseTo(Math.abs(expected), 6);
        expect(absolute).toBeLessThan(180.000001);
    }
    expect(shapes.size).toBe(10);
});

test.each([20, 40, 60, 120, 180, 240, 300])("%s-second crops retain turns and exact common 1/10 Hz samples", duration => {
    for (const p of MOTION_FULL_V1_PLATFORMS) {
        const master = pathFor(p, 300, 10).positionENU;
        const offset = (300 - duration) * 5;
        for (const fps of [1, 10]) {
            const result = pathFor(p, duration, fps);
            expect(result.feasibility.valid).toBe(true);
            if (p.category === "curved") expect(result.profile.turnCount).toBeGreaterThan(0);
            for (let f = 0; f <= duration * fps; f++) {
                for (let j = 0; j < 3; j++) expect(result.positionENU[f * 3 + j]).toBe(master[(offset + f * 10 / fps) * 3 + j]);
            }
        }
    }
});

test("bent platforms preserve target truth and give stable unique generic filenames", () => {
    const reference = generateMotionFullV1Scenario(set, target, MOTION_FULL_V1_PLATFORMS[0], 120, MOTION_FULL_V1_ERRORS[1], 10);
    const names = [];
    for (const p of MOTION_FULL_V1_PLATFORMS) {
        const scenario = generateMotionFullV1Scenario(set, target, p, 120, MOTION_FULL_V1_ERRORS[1], 10);
        expect(scenario.target.positionENU).toEqual(reference.target.positionENU);
        expect(scenario.target.profile.metrics).toEqual(reference.target.profile.metrics);
        names.push(motionFullV1Basename(set, target, p, true));
    }
    expect(names).toEqual(Array.from({length: 10}, (_, i) => `extreme${String(i + 1).padStart(3, "0")}`));
});
