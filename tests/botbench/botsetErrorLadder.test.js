/**
 * botsetErrorLadder.test.js — the botset pointing-error ladder
 * (benchmarks/botbench/lib/botsetErrors.js): its folder labels, its
 * self-similar operator, and its promise that no rung masks the target out of
 * the frame in either family.
 *
 * The rung is the deadband amplitude of the operator wobble model. Its drift
 * and recentring rates scale with the amplitude, so one seed produces the same
 * trace at every rung, scaled — which is what makes "0.01 deg" mean a hundred
 * times less error than "1.0 deg" rather than the same reaction-delay error
 * with a different label.
 */

import {
    BOTSET_ERROR_DEG, BOTSET_ERROR_LEVELS, WOBBLE_FRAME_FACTOR,
    botsetErrorLabel, botsetWobbleParams,
} from "../../benchmarks/botbench/lib/botsetErrors";
import {offsetSeries, generateObservation} from "../../benchmarks/botbench/lib/observation";
import {
    BOTSET_BALLOON_FOV_FULL_DEG, BOTSET_BALLOON_ERROR_LEVELS,
} from "../../benchmarks/botbench/lib/botsetBalloons";
import {
    BOTSET_MANEUVER_VARIANTS, BOTSET_MANEUVER_ERROR_LEVELS, botsetManeuverFov,
} from "../../benchmarks/botbench/lib/botsetManeuvers";

const FPS = 10;
const LONGEST_CLIP_S = 300;
const N = LONGEST_CLIP_S * FPS + 1;

function constantDirections(n) {
    const out = new Float64Array(n * 3);
    for (let f = 0; f < n; f++) {
        out[f * 3 + 1] = 1;     // due north, level
    }
    return out;
}

describe("botset error ladder", () => {

    test("nine rungs, labelled as degrees with at least one decimal", () => {
        expect(BOTSET_ERROR_DEG).toEqual([0, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1.0, 2.0]);
        expect(BOTSET_ERROR_LEVELS.map((l) => l.label)).toEqual([
            "0.0deg", "0.01deg", "0.02deg", "0.05deg", "0.1deg", "0.2deg",
            "0.5deg", "1.0deg", "2.0deg",
        ]);
        expect(botsetErrorLabel(0)).toBe("0.0deg");
        expect(botsetErrorLabel(1)).toBe("1.0deg");
        expect(botsetErrorLabel(0.05)).toBe("0.05deg");
        // Both families publish the one ladder.
        expect(BOTSET_BALLOON_ERROR_LEVELS).toBe(BOTSET_ERROR_LEVELS);
        expect(BOTSET_MANEUVER_ERROR_LEVELS).toBe(BOTSET_ERROR_LEVELS);
    });

    test("the clean rung keeps the family field; a wobble rung widens it only when it must", () => {
        const [clean, ...wobble] = BOTSET_ERROR_LEVELS;
        expect(clean.observation(3)).toEqual({kind: "clean", fovFullDeg: 3});
        expect(clean.fovFor(0.46)).toBe(0.46);
        const fovs = wobble.map((l) => l.observation(BOTSET_BALLOON_FOV_FULL_DEG).fovFullDeg);
        // 3 deg holds every rung to 0.5 deg; 1.0 -> 4 deg, 2.0 -> 8 deg.
        expect(fovs).toEqual([3, 3, 3, 3, 3, 3, 4, 8]);
        for (const l of wobble) {
            const o = l.observation(BOTSET_BALLOON_FOV_FULL_DEG);
            expect(o.kind).toBe("wobble");
            expect(o.wobble.amplitude).toBe(l.deg);
            expect(o.fovFullDeg).toBeGreaterThanOrEqual(WOBBLE_FRAME_FACTOR * l.deg);
        }
    });

    test("the operator is self-similar: one seed, the same trace at every rung, scaled", () => {
        const seed = 424242;
        const lo = offsetSeries({kind: "wobble", fovFullDeg: 3, wobble: botsetWobbleParams(0.02)}, N, FPS, seed);
        const hi = offsetSeries({kind: "wobble", fovFullDeg: 8, wobble: botsetWobbleParams(2.0)}, N, FPS, seed);
        let maxRel = 0, moved = 0;
        for (let f = 0; f < N; f++) {
            const e = Math.hypot(hi.pan[f], hi.tilt[f]);
            if (e > 0.05) moved++;
            maxRel = Math.max(maxRel,
                Math.abs(hi.pan[f] - 100 * lo.pan[f]), Math.abs(hi.tilt[f] - 100 * lo.tilt[f]));
        }
        expect(moved).toBeGreaterThan(N / 2);        // the operator really wobbled
        expect(maxRel).toBeLessThan(1e-9);           // and identically at both scales
    });

    test("realized RMS is proportional to the rung, about two thirds of the amplitude", () => {
        for (const l of BOTSET_ERROR_LEVELS.slice(1)) {
            const o = l.observation(BOTSET_BALLOON_FOV_FULL_DEG);
            const obs = generateObservation(o, constantDirections(N), N, FPS, 99991);
            const ratio = obs.realizedRmsDegAllFrames / l.deg;
            expect(ratio).toBeGreaterThan(0.5);
            expect(ratio).toBeLessThan(0.8);
            expect(obs.realizedMaxDeg / l.deg).toBeLessThan(WOBBLE_FRAME_FACTOR / 2);
        }
    });

    test("no rung masks the target out of the frame, in either family, over the longest clip", () => {
        const familyFovs = [BOTSET_BALLOON_FOV_FULL_DEG,
            ...new Set(BOTSET_MANEUVER_VARIANTS.map((v) => botsetManeuverFov(v)))];
        expect(Math.min(...familyFovs)).toBeLessThan(0.5);   // the narrow pod fields are in the set
        const cleanDir = constantDirections(N);
        for (const fov of familyFovs) {
            for (const l of BOTSET_ERROR_LEVELS) {
                for (const seed of [11, 22, 33]) {
                    const obs = generateObservation(l.observation(fov), cleanDir, N, FPS, seed);
                    expect(obs.outOfFrameCount).toBe(0);
                }
            }
        }
    });
});
