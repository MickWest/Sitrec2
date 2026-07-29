/**
 * Sitrec FOV interchange format — src/FOVInterchange.js
 *
 * Covers the pure format layer and the keyframe reduction. The reduction is the
 * interesting part: it has to reproduce the sampled FOV exactly under the FOV
 * Editor's LINEAR interpolation, which means an instant zoom change must come out
 * as two keyframes one frame apart (a step), never one (a ramp).
 *
 * sampleFOVPerFrame / importFOVJSON / exportFOVForEditor are not covered here —
 * they drive NodeMan, the look camera and the GUI.
 */

import {
    isFOVJSON,
    makeFOVJSON,
    reduceToKeyframes,
    validateFOVJSON,
    FOV_FILE_TYPE,
    FOV_FILE_VERSION,
} from "../src/FOVInterchange";

// Replays the FOV Editor's interpolation (CNodeCurveEditor2.interpolateValue:
// linear between points, held flat outside the range) so a reduction can be
// checked against the samples it claims to reproduce.
function interpolate(keyframes, frame) {
    if (frame <= keyframes[0][0]) return keyframes[0][1];
    const last = keyframes[keyframes.length - 1];
    if (frame >= last[0]) return last[1];
    for (let i = 0; i < keyframes.length - 1; i++) {
        const [x0, y0] = keyframes[i];
        const [x1, y1] = keyframes[i + 1];
        if (frame >= x0 && frame <= x1) {
            return y0 + (y1 - y0) * (frame - x0) / (x1 - x0);
        }
    }
    return last[1];
}

function maxReplayError(values, keyframes) {
    let worst = 0;
    for (let f = 0; f < values.length; f++) {
        worst = Math.max(worst, Math.abs(values[f] - interpolate(keyframes, f)));
    }
    return worst;
}

describe("reduceToKeyframes", () => {
    test("a constant run collapses to its two ends", () => {
        const values = new Array(100).fill(2.5);
        const kf = reduceToKeyframes(values);
        expect(kf).toEqual([[0, 2.5], [99, 2.5]]);
    });

    test("a linear ramp collapses to its two ends", () => {
        const values = Array.from({length: 101}, (_, f) => 1 + f * 0.03);
        const kf = reduceToKeyframes(values);
        expect(kf).toHaveLength(2);
        expect(maxReplayError(values, kf)).toBeLessThan(1e-9);
    });

    // The property the whole format hinges on.
    test("an instant change becomes two keyframes ONE frame apart", () => {
        const values = [...new Array(50).fill(0.8), ...new Array(50).fill(4)];
        const kf = reduceToKeyframes(values);
        expect(kf).toEqual([[0, 0.8], [49, 0.8], [50, 4], [99, 4]]);
        // one frame apart across the transition => a step, not a ramp
        expect(kf[2][0] - kf[1][0]).toBe(1);
        expect(maxReplayError(values, kf)).toBe(0);
    });

    test("reproduces a multi-step zoom track exactly", () => {
        // Aguadilla's actual shape: alternating 0.8 and 4 degrees.
        const values = [];
        const push = (v, n) => { for (let i = 0; i < n; i++) values.push(v); };
        push(0.8, 7); push(4, 628); push(0.8, 5158); push(4, 379);
        push(0.8, 167); push(4, 689);
        const kf = reduceToKeyframes(values);
        // Not bit-exact like the single step above: replaying a long flat run
        // evaluates y0 + (y1-y0)*t with y0 === y1, which is one ULP off zero.
        expect(maxReplayError(values, kf)).toBeLessThan(1e-12);
        // 6 runs => 12 keyframes (each run contributes its two ends)
        expect(kf).toHaveLength(12);
        expect(kf[0]).toEqual([0, 0.8]);
        expect(kf[kf.length - 1][0]).toBe(values.length - 1);
    });

    test("a single-frame spike survives", () => {
        const values = [...new Array(10).fill(1), 5, ...new Array(10).fill(1)];
        const kf = reduceToKeyframes(values);
        expect(maxReplayError(values, kf)).toBe(0);
        expect(kf.some(k => k[1] === 5)).toBe(true);
    });

    test("always keeps the first and last sample", () => {
        const values = [3, 3, 3, 7];
        const kf = reduceToKeyframes(values);
        expect(kf[0][0]).toBe(0);
        expect(kf[kf.length - 1][0]).toBe(3);
    });

    test("degenerate inputs", () => {
        expect(reduceToKeyframes([])).toEqual([]);
        expect(reduceToKeyframes([2.5])).toEqual([[0, 2.5]]);
    });

    // Within epsilon the wobble is noise, not a zoom change, and collapsing it is
    // what keeps a per-frame source from becoming a keyframe per frame.
    test("epsilon absorbs sub-tolerance wobble", () => {
        const values = Array.from({length: 200}, (_, f) => 2 + (f % 2) * 1e-6);
        const kf = reduceToKeyframes(values, 1e-4);
        expect(kf).toHaveLength(2);
    });

    test("a change larger than epsilon is not absorbed", () => {
        const values = [...new Array(20).fill(2), ...new Array(20).fill(2.01)];
        const kf = reduceToKeyframes(values, 1e-4);
        expect(kf.length).toBeGreaterThan(2);
        expect(maxReplayError(values, kf)).toBeLessThanOrEqual(1e-4);
    });

    // The reduction used to re-test every interior sample each time the run grew,
    // which is quadratic: an hour of 30 fps (108,000 samples) of constant zoom —
    // the best case for the OUTPUT, the worst for the old inner loop — froze the
    // browser. Linear now, so this is milliseconds.
    test("a long constant track reduces in linear time", () => {
        const values = new Array(200000).fill(3.5);
        const t0 = Date.now();
        const kf = reduceToKeyframes(values);
        const elapsed = Date.now() - t0;
        expect(kf).toEqual([[0, 3.5], [199999, 3.5]]);
        expect(elapsed).toBeLessThan(2000);
    });

    test("a long ramp reduces in linear time", () => {
        const values = Array.from({length: 200000}, (_, f) => 1 + f * 1e-5);
        const t0 = Date.now();
        const kf = reduceToKeyframes(values);
        expect(Date.now() - t0).toBeLessThan(2000);
        expect(kf).toHaveLength(2);
        expect(maxReplayError(values, kf)).toBeLessThan(1e-4);
    });

    test("keyframe frames strictly increase", () => {
        const values = [];
        for (let i = 0; i < 40; i++) values.push(i % 7 === 0 ? 5 : 1);
        const kf = reduceToKeyframes(values);
        for (let i = 1; i < kf.length; i++) {
            expect(kf[i][0]).toBeGreaterThan(kf[i - 1][0]);
        }
    });
});

describe("isFOVJSON", () => {
    test("accepts an FOV file, malformed or not", () => {
        expect(isFOVJSON({fileType: FOV_FILE_TYPE, keyframes: [[0, 1]]})).toBe(true);
        // claimed but broken still gets claimed, so the validator can report why
        expect(isFOVJSON({fileType: FOV_FILE_TYPE})).toBe(true);
    });

    test("rejects other files", () => {
        expect(isFOVJSON(null)).toBe(false);
        expect(isFOVJSON({fileType: "sitrec-spline", points: []})).toBe(false);
        expect(isFOVJSON({type: "FeatureCollection", features: []})).toBe(false);
    });
});

describe("validateFOVJSON", () => {
    const good = () => ({
        fileType: FOV_FILE_TYPE,
        version: FOV_FILE_VERSION,
        name: "agua-fov",
        keyframes: [[0, 0.8], [6, 0.8], [7, 4], [7027, 4]],
    });

    test("passes a well-formed file", () => {
        expect(validateFOVJSON(good())).toBeNull();
    });

    test("rejects a missing or empty keyframe list", () => {
        expect(validateFOVJSON({fileType: FOV_FILE_TYPE})).toMatch(/no keyframes array/);
        expect(validateFOVJSON({...good(), keyframes: []})).toMatch(/no keyframes/);
    });

    test("rejects a future version", () => {
        expect(validateFOVJSON({...good(), version: FOV_FILE_VERSION + 1}))
            .toMatch(/not one this build understands/);
    });

    test.each([
        ["a short row", [[0]]],
        ["a non-array row", [{frame: 0, fov: 1}]],
        ["a string fov", [[0, "4"]]],
        ["NaN", [[0, NaN]]],
        ["Infinity", [[0, Infinity]]],
    ])("rejects %s", (_label, keyframes) => {
        expect(validateFOVJSON({...good(), keyframes})).not.toBeNull();
    });

    // A zero or negative FOV is a degenerate camera; a huge one means the file is
    // in radians or is raw zoom values rather than degrees.
    test("rejects out-of-range fov", () => {
        expect(validateFOVJSON({...good(), keyframes: [[0, 0]]})).toMatch(/outside/);
        expect(validateFOVJSON({...good(), keyframes: [[0, -4]]})).toMatch(/outside/);
        expect(validateFOVJSON({...good(), keyframes: [[0, 400]]})).toMatch(/outside/);
    });

    test("rejects duplicate or decreasing frames", () => {
        expect(validateFOVJSON({...good(), keyframes: [[0, 1], [5, 2], [5, 3]]}))
            .toMatch(/must strictly increase/);
        expect(validateFOVJSON({...good(), keyframes: [[0, 1], [9, 2], [5, 3]]}))
            .toMatch(/must strictly increase/);
    });

    test("rejects a non-string name", () => {
        expect(validateFOVJSON({...good(), name: 7})).toMatch(/name must be a string/);
    });

    // These say how to READ the numbers. Reinterpreting them silently would give a
    // plausible-looking but wrong zoom track, so they are refused, not coerced.
    describe("declared interpretation", () => {
        test("rejects units that are not degrees", () => {
            expect(validateFOVJSON({...good(), units: "radians"})).toMatch(/not degrees/);
        });

        test("rejects a horizontal FOV axis", () => {
            expect(validateFOVJSON({...good(), axis: "horizontal"})).toMatch(/not vertical/);
        });

        test("rejects non-linear interpolation", () => {
            expect(validateFOVJSON({...good(), interpolation: "step"})).toMatch(/not linear/);
        });

        test("accepts the declarations this format writes, and their absence", () => {
            expect(validateFOVJSON({
                ...good(), units: "degrees", axis: "vertical", interpolation: "linear",
            })).toBeNull();
            expect(validateFOVJSON(good())).toBeNull();
        });
    });
});

describe("makeFOVJSON", () => {
    test("produces a file its own sniff and validator accept", () => {
        const values = [...new Array(20).fill(0.8), ...new Array(20).fill(4)];
        const json = makeFOVJSON({name: "test-fov", values, source: "fovSwitch:Manual"});
        expect(isFOVJSON(json)).toBe(true);
        expect(validateFOVJSON(json)).toBeNull();
        expect(json.fileType).toBe(FOV_FILE_TYPE);
        expect(json.version).toBe(FOV_FILE_VERSION);
        expect(json.frames).toBe(40);
        expect(json.sourceNode).toBe("fovSwitch:Manual");
    });

    // The editor's y axis is vertical FOV in degrees; recording that stops a
    // horizontal-FOV or radians file being fed in silently.
    test("declares its units and axis", () => {
        const json = makeFOVJSON({name: "u", values: [1, 1], source: "x"});
        expect(json.units).toBe("degrees");
        expect(json.axis).toBe("vertical");
        expect(json.interpolation).toBe("linear");
        expect(json.columns).toEqual(["frame", "fov"]);
    });

    test("round trips the sampled values through its own keyframes", () => {
        const values = [];
        for (let f = 0; f < 500; f++) values.push(f < 100 ? 0.8 : f < 300 ? 4 : 2.2);
        const json = makeFOVJSON({name: "rt", values, source: "x"});
        expect(maxReplayError(values, json.keyframes)).toBe(0);
    });
});
