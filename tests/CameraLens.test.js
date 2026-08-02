// Camera lens model: pixel <-> ray round trips, field of view, and the guards that stop a bad
// lens from being used.
//
// The point of this module is to be exactly invertible, because everything downstream composes
// the two directions. So most of these tests are round trips, checked to well under the ~0.15 px
// astrometric noise of the footage the model exists for.

import {
    LENS_PRESETS,
    makeLens,
    lensFromVFOV,
    lensToRay,
    rayToPixel,
    lensFOV,
    lensJacobian,
    lensScaleFor,
    lensMaxTheta,
    validateLens,
    serializeLens,
    deserializeLens,
} from "../src/CameraLens";

const SIZE = [1280, 720];
const TYPES = ["rectilinear", "stereographic", "equidistantFisheye", "equisolidFisheye", "orthographicFisheye"];

/** A grid of sample pixels covering the frame including the corners. */
function samplePixels(w = 1280, h = 720, n = 7) {
    const out = [];
    for (let i = 0; i <= n; i++) {
        for (let j = 0; j <= n; j++) out.push([w * i / n, h * j / n]);
    }
    return out;
}

describe("named presets", () => {
    test.each(TYPES)("%s round-trips pixel -> ray -> pixel", (type) => {
        // f chosen so the corner is well inside every preset's domain
        const lens = makeLens({type, focalPx: 900, refSize: SIZE});
        let worst = 0;
        for (const [x, y] of samplePixels()) {
            const ray = lensToRay(lens, x, y, SIZE);
            expect(ray).not.toBeNull();
            // rays are unit
            expect(Math.hypot(ray[0], ray[1], ray[2])).toBeCloseTo(1, 12);
            const px = rayToPixel(lens, ray, SIZE);
            expect(px).not.toBeNull();
            worst = Math.max(worst, Math.hypot(px[0] - x, px[1] - y));
        }
        expect(worst).toBeLessThan(1e-9);
    });

    test.each(TYPES)("%s theta/rho are mutual inverses", (type) => {
        const p = LENS_PRESETS[type];
        for (let i = 1; i <= 20; i++) {
            const theta = (p.maxTheta * 0.95) * i / 20;
            expect(p.theta(p.rho(theta))).toBeCloseTo(theta, 10);
        }
    });

    test("the optical axis maps to the principal point", () => {
        const lens = makeLens({type: "orthographicFisheye", focalPx: 900, principal: [636, 332], refSize: SIZE});
        const px = rayToPixel(lens, [0, 0, 1], SIZE);
        expect(px[0]).toBeCloseTo(636, 9);
        expect(px[1]).toBeCloseTo(332, 9);
    });

    test("camera space is +y DOWN: a pixel below centre gives a +y ray", () => {
        const lens = makeLens({type: "rectilinear", focalPx: 900, refSize: SIZE});
        const ray = lensToRay(lens, 640, 600, SIZE);   // below the 360 centre line
        expect(ray[1]).toBeGreaterThan(0);
        const right = lensToRay(lens, 1000, 360, SIZE);
        expect(right[0]).toBeGreaterThan(0);
    });
});

describe("field of view", () => {
    test("rectilinear matches the pinhole formula", () => {
        const lens = lensFromVFOV(30, SIZE);
        const fov = lensFOV(lens, SIZE);
        expect(fov.vfov).toBeCloseTo(30, 9);
    });

    test("the measured clip's fitted lens is ~89 deg horizontal", () => {
        // The orthographic fit recovered from the rotating-starfield clip.
        const lens = makeLens({type: "orthographicFisheye", focalPx: 914, principal: [636, 332], refSize: SIZE});
        const fov = lensFOV(lens, SIZE);
        expect(fov.hfov).toBeGreaterThan(85);
        expect(fov.hfov).toBeLessThan(95);
    });

    test("a wider lens has a wider field at the same focal length", () => {
        const rect = makeLens({type: "rectilinear", focalPx: 900, refSize: SIZE});
        const ortho = makeLens({type: "orthographicFisheye", focalPx: 900, refSize: SIZE});
        expect(lensFOV(ortho, SIZE).hfov).toBeGreaterThan(lensFOV(rect, SIZE).hfov);
    });
});

describe("custom polynomial lens", () => {
    // Fitted against a true orthographic curve over rho 0..0.803; see the plan's measurement.
    const D = [0.17437, 0.02048, 0.14811];

    test("round-trips like the named presets", () => {
        const lens = makeLens({type: "custom", focalPx: 914, refSize: SIZE, distortion: D});
        let worst = 0;
        for (const [x, y] of samplePixels()) {
            const ray = lensToRay(lens, x, y, SIZE);
            expect(ray).not.toBeNull();
            const px = rayToPixel(lens, ray, SIZE);
            expect(px).not.toBeNull();
            worst = Math.max(worst, Math.hypot(px[0] - x, px[1] - y));
        }
        expect(worst).toBeLessThan(1e-7);
    });

    test("three terms track a real orthographic lens to well under the noise floor", () => {
        // This is the measurement that forced d7 into the schema: a two-term fit leaves ~0.98 px
        // at the corner, which is larger than the 0.31 px solve rms it would be feeding.
        //
        // Measured as a PIXEL error - unproject through the custom lens, reproject through the
        // truth - because that is the quantity that biases astrometry. Converting the angular
        // error at the CENTRE plate scale instead reads 0.28 px, overstating it by 1/cos(53 deg)
        // at the corner, since an orthographic lens compresses radially out there.
        const ortho = makeLens({type: "orthographicFisheye", focalPx: 914, refSize: SIZE});
        const custom = makeLens({type: "custom", focalPx: 914, refSize: SIZE, distortion: D});
        let worst = 0;
        for (const [x, y] of samplePixels(1280, 720, 10)) {
            const ray = lensToRay(custom, x, y, SIZE);
            if (!ray) continue;
            const px = rayToPixel(ortho, ray, SIZE);
            if (!px) continue;
            worst = Math.max(worst, Math.hypot(px[0] - x, px[1] - y));
        }
        expect(worst).toBeLessThan(0.2);
    });

    test("TWO terms would not have been good enough - the reason d7 exists", () => {
        // Best-fit d3,d5 against the same orthographic curve. Kept as a test so the schema
        // decision is checkable rather than a claim in a comment.
        const two = makeLens({type: "custom", focalPx: 914, refSize: SIZE, distortion: [0.14484, 0.15738, 0]});
        const ortho = makeLens({type: "orthographicFisheye", focalPx: 914, refSize: SIZE});
        let worst = 0;
        for (const [x, y] of samplePixels(1280, 720, 10)) {
            const ray = lensToRay(two, x, y, SIZE);
            if (!ray) continue;
            const px = rayToPixel(ortho, ray, SIZE);
            if (!px) continue;
            worst = Math.max(worst, Math.hypot(px[0] - x, px[1] - y));
        }
        expect(worst).toBeGreaterThan(0.5);
    });

    test("a non-monotone curve is REJECTED, not clamped", () => {
        // A strongly negative cubic term turns the curve over inside the frame.
        const bad = makeLens({type: "custom", focalPx: 914, refSize: SIZE, distortion: [-2.0, 0, 0]});
        const v = validateLens(bad, SIZE);
        expect(v.ok).toBe(false);
        expect(v.reason).toMatch(/monotone/);
    });

    test("a sane fitted curve validates", () => {
        expect(validateLens(makeLens({type: "custom", focalPx: 914, refSize: SIZE, distortion: D}), SIZE).ok).toBe(true);
    });
});

describe("rays that have no image", () => {
    test("a ray behind the camera returns null, not a clamped pixel", () => {
        const lens = makeLens({type: "rectilinear", focalPx: 900, refSize: SIZE});
        expect(rayToPixel(lens, [0, 0, -1], SIZE)).toBeNull();
    });

    test("beyond an orthographic fisheye's 90 deg limit returns null", () => {
        const lens = makeLens({type: "orthographicFisheye", focalPx: 900, refSize: SIZE});
        // 91 degrees off axis
        const t = 91 * Math.PI / 180;
        expect(rayToPixel(lens, [Math.sin(t), 0, Math.cos(t)], SIZE)).toBeNull();
    });

    test("an equidistant fisheye still images a ray at 100 deg", () => {
        const lens = makeLens({type: "equidistantFisheye", focalPx: 400, refSize: SIZE});
        const t = 100 * Math.PI / 180;
        expect(rayToPixel(lens, [Math.sin(t), 0, Math.cos(t)], SIZE)).not.toBeNull();
    });
});

describe("refSize handling", () => {
    test("a uniformly scaled decode rescales focal and principal together", () => {
        const lens = makeLens({type: "orthographicFisheye", focalPx: 914, principal: [636, 332], refSize: SIZE});
        const half = [640, 360];
        expect(lensScaleFor(lens, half)).toBeCloseTo(0.5, 12);
        // the same sky direction lands at the same FRACTIONAL position in both
        const ray = lensToRay(lens, 900, 500, SIZE);
        const px = rayToPixel(lens, ray, half);
        expect(px[0]).toBeCloseTo(450, 6);
        expect(px[1]).toBeCloseTo(250, 6);
    });

    test("a different ASPECT is refused rather than silently rescaled", () => {
        const lens = makeLens({type: "rectilinear", focalPx: 914, refSize: SIZE});
        expect(lensScaleFor(lens, [1440, 1080])).toBeNull();
        expect(lensToRay(lens, 100, 100, [1440, 1080])).toBeNull();
        expect(validateLens(lens, [1440, 1080]).ok).toBe(false);
    });
});

describe("lensJacobian", () => {
    test("radial and tangential agree at the optical axis", () => {
        const lens = makeLens({type: "orthographicFisheye", focalPx: 914, refSize: SIZE});
        const j = lensJacobian(lens, 1e-6, SIZE);
        expect(j.radial).toBeCloseTo(j.tangential, 3);
    });

    test("they diverge off axis on a wide lens - which is why a scalar plate scale is wrong", () => {
        const lens = makeLens({type: "orthographicFisheye", focalPx: 914, refSize: SIZE});
        const j = lensJacobian(lens, 40 * Math.PI / 180, SIZE);
        // orthographic compresses radially (dr/dtheta = f cos theta) but not tangentially
        expect(j.radial).toBeLessThan(j.tangential * 0.85);
    });

    test("a rectilinear lens stretches radially instead", () => {
        const lens = makeLens({type: "rectilinear", focalPx: 914, refSize: SIZE});
        const j = lensJacobian(lens, 40 * Math.PI / 180, SIZE);
        expect(j.radial).toBeGreaterThan(j.tangential);
    });
});

describe("serialization", () => {
    test("a default lens serializes to nothing, so old saves are unchanged", () => {
        expect(serializeLens(lensFromVFOV(30, SIZE))).toBeUndefined();
        expect(deserializeLens(undefined)).toBeNull();
    });

    test("a fitted lens survives a round trip", () => {
        const lens = makeLens({
            type: "custom", focalPx: 914, principal: [636, 332], refSize: SIZE,
            distortion: [0.17437, 0.02048, 0.14811], source: "fitted",
        });
        const back = deserializeLens(JSON.parse(JSON.stringify(serializeLens(lens))));
        expect(back.type).toBe("custom");
        expect(back.focalPx).toBeCloseTo(914, 12);
        expect(back.principal).toEqual([636, 332]);
        expect(back.distortion).toEqual([0.17437, 0.02048, 0.14811]);
        const ray = lensToRay(lens, 1000, 200, SIZE);
        const ray2 = lensToRay(back, 1000, 200, SIZE);
        expect(ray2[0]).toBeCloseTo(ray[0], 12);
    });
});

describe("guards", () => {
    test("an unknown type, a zero focal, and a missing refSize are all refused", () => {
        expect(validateLens(makeLens({type: "nope", focalPx: 900, refSize: SIZE})).ok).toBe(false);
        expect(validateLens(makeLens({type: "rectilinear", focalPx: 0, refSize: SIZE})).ok).toBe(false);
        expect(validateLens(makeLens({type: "rectilinear", focalPx: 900})).ok).toBe(false);
    });

    test("lensMaxTheta reports the preset limits", () => {
        expect(lensMaxTheta(makeLens({type: "rectilinear", focalPx: 900, refSize: SIZE}))).toBeCloseTo(Math.PI / 2, 9);
        expect(lensMaxTheta(makeLens({type: "equidistantFisheye", focalPx: 900, refSize: SIZE}))).toBeCloseTo(Math.PI, 9);
    });
});

describe("zoom (focal scale)", () => {
    test("s scales the field of view without touching the lens", () => {
        const lens = makeLens({type: "rectilinear", focalPx: 900, refSize: SIZE});
        const wide = lensFOV(lens, SIZE, 1);
        const tele = lensFOV(lens, SIZE, 2);
        expect(tele.hfov).toBeLessThan(wide.hfov);
    });

    test("round trips still hold at s != 1", () => {
        const lens = makeLens({type: "orthographicFisheye", focalPx: 914, refSize: SIZE});
        for (const s of [0.7, 1, 1.6]) {
            for (const [x, y] of samplePixels(1280, 720, 4)) {
                const ray = lensToRay(lens, x, y, SIZE, s);
                if (!ray) continue;
                const px = rayToPixel(lens, ray, SIZE, s);
                expect(Math.hypot(px[0] - x, px[1] - y)).toBeLessThan(1e-8);
            }
        }
    });
});
