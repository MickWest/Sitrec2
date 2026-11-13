// Stabilize on Stars: per-frame maps that can rotate as well as shift.
//
// The maps come from the Star Tracker's frame transforms, and CVideoData draws the picture with
// them and maps overlay points with them. A star seen on any frame must land where it is on the
// first frame, at any decoded size, and the shift-only modes must keep their old numbers.

import {CVideoData, applyAffine, invertAffine} from "../src/CVideoData";
import {applyTransform, stabilizingMaps} from "../src/starTrack/StarMatch";

const D2R = Math.PI / 180;

/** A similarity (reference chart -> frame pixels): rotation (deg), scale, shift. */
function similarity(rotDeg, scale, tx, ty) {
    return {A: [scale * Math.cos(rotDeg * D2R), scale * Math.sin(rotDeg * D2R)], B: [tx, ty]};
}

// A camera that drifts and rolls, as the Jupiter clip does (up to 1.45 deg, tens of px).
const TRANSFORMS = [
    similarity(0, 1, 0, 0),
    similarity(0.4, 1, 3.5, -8.2),
    similarity(1.45, 1, 12.7, 18.3),
    similarity(-0.8, 1.002, -25, 40),
];
const STARS = [[722.8, 401.6], [784.8, 335.3], [824.4, 272], [100, 900], [1800, 50]];

describe("stabilizingMaps", () => {
    test("every star goes to where it is on the first frame", () => {
        const maps = stabilizingMaps(TRANSFORMS);
        TRANSFORMS.forEach((T, i) => {
            for (const [rx, ry] of STARS) {
                const [x0, y0] = applyTransform(TRANSFORMS[0], rx, ry);
                const [xi, yi] = applyTransform(T, rx, ry);
                const [sx, sy] = applyAffine(maps[i], xi, yi);
                expect(Math.hypot(sx - x0, sy - y0)).toBeLessThan(1e-9);
            }
        });
    });

    test("the first frame's map does nothing, and a missing transform has no map", () => {
        const maps = stabilizingMaps([similarity(10, 1, 5, 5), undefined, similarity(12, 1, 7, 3)]);
        const [x, y] = applyAffine(maps[0], 123, 456);
        expect(x).toBeCloseTo(123, 9);
        expect(y).toBeCloseTo(456, 9);
        expect(maps[1]).toBeNull();
    });
});

describe("CVideoData per-frame maps", () => {
    const W = 1920, H = 1080;
    function video() {
        const v = new CVideoData({id: "video", frames: 0});
        v.originalVideoWidth = W;
        v.originalVideoHeight = H;
        v.videoWidth = 1280;
        v.videoHeight = 720;
        return v;
    }
    const mapsByFrame = () => new Map(stabilizingMaps(TRANSFORMS).map((m, i) => [42 + i, m]));

    test("a map made at the analysed size works at the decoded size", () => {
        const v = video();
        v.setStabilizationTransforms(mapsByFrame(), W, H);
        v.setStabilizationEnabled(true);
        const k = 1280 / W;
        const full = v.stabilizationMatrix(44, W, H);
        const decoded = v.stabilizationMatrix(44, 1280, 720);
        for (const [x, y] of STARS) {
            const [fx, fy] = applyAffine(full, x, y);
            const [dx, dy] = applyAffine(decoded, x * k, y * k);
            expect(dx).toBeCloseTo(fx * k, 9);
            expect(dy).toBeCloseTo(fy * k, 9);
        }
    });

    test("a frame with no map keeps the map of the frame before it, or the first map", () => {
        const v = video();
        v.setStabilizationTransforms(mapsByFrame(), W, H);
        v.setStabilizationEnabled(true);
        expect(v.stabilizationMatrix(1000, W, H)).toEqual(v.stabilizationMatrix(45, W, H));
        expect(v.stabilizationMatrix(10, W, H)).toEqual(v.stabilizationMatrix(42, W, H));
    });

    test("off, or replaced by a tracked point, it no longer rotates", () => {
        const v = video();
        v.setStabilizationTransforms(mapsByFrame(), W, H);
        expect(v.stabilizationMatrix(44, W, H)).toBeNull();     // not enabled yet
        v.setStabilizationEnabled(true);
        v.setStabilizationData(new Map([[44, {x: 900, y: 500}]]), {x: 900, y: 500});
        expect(v.stabilizationAffine).toBeNull();
        v.stabilizeCenters = false;
        expect(v.stabilizationMatrix(44, W, H)).toEqual({a: 1, b: 0, c: 0, d: 1, e: 0, f: 0});
        v.clearStabilization();
        expect(v.stabilizationMatrix(44, W, H)).toBeNull();
    });

    test("the inverse map takes a stabilized point back to the frame as recorded", () => {
        const m = stabilizingMaps(TRANSFORMS)[2];
        const back = invertAffine(m);
        const [x, y] = applyAffine(back, ...applyAffine(m, 640.5, 222.25));
        expect(x).toBeCloseTo(640.5, 9);
        expect(y).toBeCloseTo(222.25, 9);
    });
});

describe("the shift-only modes keep their numbers", () => {
    function video() {
        const v = new CVideoData({id: "video", frames: 0});
        v.originalVideoWidth = 1920;
        v.originalVideoHeight = 1080;
        v.videoWidth = 1280;
        v.videoHeight = 720;
        return v;
    }

    test("a tracked point, kept at its first position or at the center", () => {
        const v = video();
        v.setStabilizationData(new Map([[0, {x: 900, y: 500}], [10, {x: 1000, y: 600}]]), {x: 900, y: 500});
        v.setStabilizationEnabled(true);
        v.stabilizeCenters = false;
        // Decoded at 2/3 size: the shift is (reference - point) * 2/3.
        let m = v.stabilizationMatrix(10, 1280, 720);
        expect([m.a, m.b, m.c, m.d]).toEqual([1, 0, 0, 1]);
        expect(m.e).toBeCloseTo(-100 * 1280 / 1920, 9);
        expect(m.f).toBeCloseTo(-100 * 720 / 1080, 9);
        v.stabilizeCenters = true;
        m = v.stabilizationMatrix(10, 1280, 720);
        expect(m.e).toBeCloseTo(640 - 1000 * 1280 / 1920, 9);
        expect(m.f).toBeCloseTo(360 - 600 * 720 / 1080, 9);
    });

    test("motion analysis offsets are in decoded pixels", () => {
        const v = video();
        v.setStabilizationData(new Map([[3, {x: -12, y: 7}]]), {x: 0, y: 0}, true);
        v.setStabilizationEnabled(true);
        expect(v.stabilizationMatrix(3, 1280, 720)).toEqual({a: 1, b: 0, c: 0, d: 1, e: -12, f: 7});
        // The same offsets in original pixels, as a point track overlay asks for them.
        const m = v.stabilizationMatrix(3, 1920, 1080);
        expect(m.e).toBeCloseTo(-18, 9);
        expect(m.f).toBeCloseTo(10.5, 9);
    });
});

describe("getStabilizedImage", () => {
    let savedDocument, calls;
    beforeAll(() => {
        savedDocument = global.document;
        global.document = {createElement: () => ({getContext: () => ({
            fillRect() {},
            drawImage(...args) { calls.push(["drawImage", ...args.slice(1)]); },
            setTransform(...args) { calls.push(["setTransform", ...args]); },
        })})};
    });
    afterAll(() => { global.document = savedDocument; });
    beforeEach(() => { calls = []; });

    test("a shift is drawn at an offset, a rotation through the canvas transform", () => {
        const v = new CVideoData({id: "video", frames: 0});
        v.originalVideoWidth = 1920;
        v.originalVideoHeight = 1080;
        const image = {width: 1280, height: 720};

        v.setStabilizationData(new Map([[5, {x: 1000, y: 600}]]), {x: 900, y: 500});
        v.stabilizeCenters = false;
        v.setStabilizationEnabled(true);
        v.getStabilizedImage(5, image);
        expect(calls).toHaveLength(1);
        expect(calls[0][0]).toBe("drawImage");
        expect(calls[0][1]).toBeCloseTo(-100 * 1280 / 1920, 9);

        calls = [];
        v.setStabilizationTransforms(new Map([[5, stabilizingMaps(TRANSFORMS)[2]]]), 1920, 1080);
        v.getStabilizedImage(5, image);
        const m = v.stabilizationMatrix(5, 1280, 720);
        expect(calls[0]).toEqual(["setTransform", m.a, m.b, m.c, m.d, m.e, m.f]);
        expect(calls[1]).toEqual(["drawImage", 0, 0]);
    });
});
