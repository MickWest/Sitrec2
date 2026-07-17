/**
 * Tests for the Tracking Wobble offset generator (src/TrackingWobbleMath.js):
 * the deterministic manual-tracking operator model behind
 * CNodeControllerTrackingWobble. Determinism matters doubly here — the
 * LOS/MISB CSV export re-runs the camera controller stack per frame, so the
 * exported center track must match the rendered video exactly.
 */

import {generateWobbleOffsets} from "../src/TrackingWobbleMath";

const PARAMS = {
    seed: 42,
    amplitude: 0.5,        // deg
    driftSpeed: 0.3,       // deg/s
    reactionTime: 0.4,     // s
    correctionSpeed: 2,    // deg/s
    accuracy: 0.7,
};

const FPS = 30;
const FRAMES = 60 * FPS;   // one minute

describe("generateWobbleOffsets", () => {
    test("returns one {pan, tilt} entry per frame", () => {
        const out = generateWobbleOffsets(PARAMS, FRAMES, FPS);
        expect(out.length).toBe(FRAMES);
        expect(out[0]).toEqual({pan: 0, tilt: 0});
        for (const o of out) {
            expect(Number.isFinite(o.pan)).toBe(true);
            expect(Number.isFinite(o.tilt)).toBe(true);
        }
    });

    test("same params → byte-identical series (determinism)", () => {
        const a = generateWobbleOffsets(PARAMS, FRAMES, FPS);
        const b = generateWobbleOffsets({...PARAMS}, FRAMES, FPS);
        expect(b).toEqual(a);
    });

    test("different seed → different series", () => {
        const a = generateWobbleOffsets(PARAMS, FRAMES, FPS);
        const b = generateWobbleOffsets({...PARAMS, seed: 43}, FRAMES, FPS);
        const differ = a.some((o, i) => o.pan !== b[i].pan || o.tilt !== b[i].tilt);
        expect(differ).toBe(true);
    });

    test("error is bounded near the amplitude", () => {
        // drift can exceed amplitude only during the reaction delay:
        // max ≈ amplitude + 1.5*driftSpeed * 1.3*reactionTime ≈ 0.73 deg.
        // Assert a comfortable envelope of 2x amplitude.
        const out = generateWobbleOffsets(PARAMS, FRAMES, FPS);
        const maxErr = Math.max(...out.map(o => Math.hypot(o.pan, o.tilt)));
        expect(maxErr).toBeGreaterThan(PARAMS.amplitude * 0.5); // it does actually wander
        expect(maxErr).toBeLessThan(PARAMS.amplitude * 2);
    });

    test("operator recenters: error returns near center after drifting out", () => {
        const out = generateWobbleOffsets(PARAMS, FRAMES, FPS);
        const errs = out.map(o => Math.hypot(o.pan, o.tilt));
        const firstOut = errs.findIndex(e => e > PARAMS.amplitude);
        expect(firstOut).toBeGreaterThan(0);
        // corrections aim within (1-accuracy)*amplitude = 0.15 deg of center
        const minAfter = Math.min(...errs.slice(firstOut));
        expect(minAfter).toBeLessThan((1 - PARAMS.accuracy) * PARAMS.amplitude + 0.02);
    });

    test("zero drift speed → no wobble at all", () => {
        const out = generateWobbleOffsets({...PARAMS, driftSpeed: 0}, 300, FPS);
        for (const o of out) {
            expect(o.pan).toBe(0);
            expect(o.tilt).toBe(0);
        }
    });

    test("degenerate correctionSpeed of 0 does not freeze the state machine", () => {
        const out = generateWobbleOffsets({...PARAMS, correctionSpeed: 0}, FRAMES, FPS);
        const errs = out.map(o => Math.hypot(o.pan, o.tilt));
        const firstOut = errs.findIndex(e => e > PARAMS.amplitude);
        expect(firstOut).toBeGreaterThan(0);
        // even at the 0.05 deg/s floor, the error must eventually come back down
        const minAfter = Math.min(...errs.slice(firstOut));
        expect(minAfter).toBeLessThan(PARAMS.amplitude);
    });
});
