import {MOTION_V1_PLATFORMS, STANDARD_TURN_RATE_DEG_S} from "../../benchmarks/botbench/lib/motionV1Platforms";
import {buildTurnProgram} from "../../benchmarks/botbench/lib/turnPrograms";
import {generatePlatformPath} from "../../benchmarks/botbench/lib/platforms";
import {MOTION_V1_SETS, generateMotionV1Scenario} from "../../benchmarks/botbench/lib/motionV1";

const durations = [...new Set([1, 2, 5, 20, 60, 120, 300,
    ...Object.values(MOTION_V1_SETS).flat().map(v => v.durationSeconds ?? 20)])].sort((a, b) => a - b);
const pathFor = (p, seconds, fps = 10) => generatePlatformPath({...p.spec, altitudeAGL: 1000},
    seconds * fps + 1, Array.from({length: seconds * fps + 1}, (_, i) => i / fps), fps, 5000);

test("exactly two CV, three standard-rate, one S-turn, and four distinct random programs", () => {
    expect(MOTION_V1_PLATFORMS).toHaveLength(10);
    expect(["constant-velocity", "standard-rate", "s-turn", "random"].map(category =>
        MOTION_V1_PLATFORMS.filter(p => p.category === category).length)).toEqual([2, 3, 1, 4]);
    expect(new Set(MOTION_V1_PLATFORMS.map(p => p.id)).size).toBe(10);
    const paths = MOTION_V1_PLATFORMS.map(p => JSON.stringify(Array.from(pathFor(p, 10).positionENU)));
    expect(new Set(paths).size).toBe(10);
});

test.each(durations)("all platform types retain their intended motion at %s seconds", duration => {
    for (const p of MOTION_V1_PLATFORMS) {
        const path = pathFor(p, duration), s = path.profile.segments;
        expect(path.feasibility.valid).toBe(true);
        expect(path.positionENU.every(Number.isFinite)).toBe(true);
        expect(s[0].startSeconds).toBe(0);
        expect(s[s.length - 1].endSeconds).toBe(duration);
        for (let i = 0; i < s.length; i++) {
            expect(s[i].endSeconds).toBeGreaterThan(s[i].startSeconds);
            if (i) expect(s[i].startSeconds).toBe(s[i - 1].endSeconds);
        }

        // Independently detect curvature from the exported positions. This
        // prevents a correct-looking segment label hiding an all-straight path.
        let maxHeadingStep = 0, previousHeading;
        const pos = path.positionENU;
        for (let i = 1; i < pos.length / 3; i++) {
            const heading = Math.atan2(pos[i * 3] - pos[(i - 1) * 3], pos[i * 3 + 1] - pos[(i - 1) * 3 + 1]);
            if (previousHeading !== undefined) {
                const d = heading - previousHeading;
                maxHeadingStep = Math.max(maxHeadingStep, Math.abs(Math.atan2(Math.sin(d), Math.cos(d))));
            }
            previousHeading = heading;
            expect(pos[i * 3 + 2]).toBe(1000);
        }
        if (p.category === "constant-velocity") {
            expect(maxHeadingStep).toBeLessThan(1e-8);
            expect(path.profile.turnCount).toBe(0);
            expect(path.profile.totalAbsoluteHeadingChangeDeg).toBe(0);
        } else {
            expect(maxHeadingStep).toBeGreaterThan(1e-5);
            expect(path.profile.maxBankDeg).toBeLessThan(30);
            expect(path.profile.maxTurnRateDegS).toBe(STANDARD_TURN_RATE_DEG_S);
            if (p.category === "standard-rate") {
                expect(path.profile.turnDurationSeconds).toBe(duration);
                expect(path.profile.totalAbsoluteHeadingChangeDeg).toBeCloseTo(3 * duration, 8);
            } else if (p.category === "s-turn") {
                expect(s.filter(v => v.turnRateDegS < 0)).toHaveLength(1);
                expect(s.filter(v => v.turnRateDegS > 0)).toHaveLength(1);
                expect(path.profile.totalHeadingChangeDeg).toBeCloseTo(0, 8);
            } else {
                expect(path.profile.turnCount).toBeGreaterThanOrEqual(1);
                expect(path.profile.straightCount).toBeGreaterThanOrEqual(1);
                expect(path.profile.turnDurationSeconds).toBeGreaterThan(duration * 0.2);
                expect(path.profile.turnDurationSeconds).toBeLessThan(duration * 0.8);
            }
        }
    }
});

test("standard-rate arc matches its physical circle and 120-second return", () => {
    const p = MOTION_V1_PLATFORMS.find(p => p.id === "rate-right-inbound");
    const path = pathFor(p, 120), radius = 70 / (3 * Math.PI / 180);
    const at = t => Array.from(path.positionENU.slice(t * 10 * 3, t * 10 * 3 + 3));
    expect(at(30)[0]).toBeCloseTo(radius, 8);
    expect(at(30)[1]).toBeCloseTo(-5000 + radius, 8);
    expect(at(120)[0]).toBeCloseTo(0, 8);
    expect(at(120)[1]).toBeCloseTo(-5000, 8);
});

test("platform paths preserve positions at common times across export rates", () => {
    for (const p of MOTION_V1_PLATFORMS) {
        const reference = pathFor(p, 12, 10).positionENU;
        for (const fps of [1, 100]) {
            const actual = pathFor(p, 12, fps).positionENU;
            for (let t = 0; t <= 12; t++) for (let j = 0; j < 3; j++) {
                expect(actual[t * fps * 3 + j]).toBe(reference[t * 10 * 3 + j]);
            }
        }
    }
});

test.each([
    ["Extreme_v1", "propeller-drone-up-down-up", 1000],
    ["Anomalies_v1", "vertical-drop", 11000],
    ["Anomalies_v1", "transmedium", 7000],
])("%s/%s keeps its target, visibility and altitude across platform variants", (setName, kind, altitudeAGL) => {
    const target = MOTION_V1_SETS[setName].find(v => v.kind === kind);
    let reference;
    const ids = new Set();
    for (const p of MOTION_V1_PLATFORMS) {
        const s = generateMotionV1Scenario(setName, target, 10, p);
        reference ??= s;
        expect(s.target.positionENU).toEqual(reference.target.positionENU);
        expect(s.target.profile).toEqual(reference.target.profile);
        expect(s.events).toEqual(reference.events);
        expect(s.observation.measurementAvailable).toEqual(reference.observation.measurementAvailable);
        expect(s.platform.profile.variant).toBe(p.id);
        expect(s.spec.platform.altitudeAGL).toBe(altitudeAGL);
        ids.add(s.scenarioId);
    }
    expect(ids.size).toBe(10);
});

test("invalid timing is rejected rather than silently omitting platform maneuvers", () => {
    const spec = MOTION_V1_PLATFORMS[0].spec;
    expect(() => buildTurnProgram(spec, 0)).toThrow("positive duration");
    expect(() => buildTurnProgram({...spec, segments: [{fraction: 0, turnRateDegS: 3}]}, 10)).toThrow("weighted segments");
});
