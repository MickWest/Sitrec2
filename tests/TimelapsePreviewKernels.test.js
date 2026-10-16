// The timelapse preview's worker kernels: the lens projection must agree with
// the renderer's CPU twin, and the trail steps must behave as the render does.
import {Vector3} from "three";
import {fisheye, fisheyeUniforms, fisheyeViewToNDC} from "../src/FisheyeProjection";
import {celestialTrail, makeProjector, makeSink, prepareJob, skyDirection, starBand} from "../src/TimelapsePreviewKernels";

function fisheyeSnapshot(aspect) {
    fisheyeViewToNDC(new Vector3(0, 0, -1), aspect);   // brings the uniforms up to date
    const u = fisheyeUniforms;
    return {
        lensType: fisheye.lensType, curveK: fisheye.curveK, rhoEdge: u.uFishRhoEdge.value,
        circleScale: fisheye.circlePct / 100, centerX: fisheye.centerX / 100, centerY: fisheye.centerY / 100,
        roll: fisheye.roll * Math.PI / 180, maxTheta: u.uFishMaxTheta.value, cullTheta: u.uFishCullTheta.value,
        showCircle: !!fisheye.showCircle,
    };
}

describe("makeProjector", () => {
    const W = 1600, H = 900, aspect = W / H;

    test.each([
        ["equisolidFisheye", {fov: 180, circlePct: 100}],
        ["equidistantFisheye", {fov: 190, circlePct: 150, centerX: 5, centerY: -3, roll: 20}],
        ["stereographic", {fov: 160, circlePct: 120}],
        ["generalFisheye", {fov: 200, circlePct: 110, curveK: 0.3}],
    ])("the fisheye agrees with fisheyeViewToNDC (%s)", (lensType, settings) => {
        Object.assign(fisheye, {lensType, centerX: 0, centerY: 0, roll: 0, showCircle: true, curveK: 0.5}, settings);
        const project = makeProjector({lensMode: "fisheye", qInv: [0, 0, 0, 1], W, H, aspect,
            fisheye: fisheyeSnapshot(aspect)});
        const out = {x: 0, y: 0};
        let compared = 0;
        for (let i = 0; i < 400; i++) {
            const theta = Math.PI * (i % 20) / 20, phi = 2 * Math.PI * Math.floor(i / 20) / 20;
            const v = new Vector3(Math.sin(theta) * Math.cos(phi), Math.sin(theta) * Math.sin(phi), -Math.cos(theta));
            const reference = v.clone();
            const shown = fisheyeViewToNDC(reference, aspect);
            expect(project(v, out)).toBe(shown);
            if (!shown) continue;
            expect(out.x).toBeCloseTo((reference.x + 1) * 0.5 * W, 6);
            expect(out.y).toBeCloseTo((1 - reference.y) * 0.5 * H, 6);
            compared++;
        }
        expect(compared).toBeGreaterThan(100);
    });

    test("pinhole: through the projection matrix, nothing behind the camera", () => {
        // a 90° square frustum: x/-z and y/-z map straight to NDC
        const e = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1, -1, 0, 0, -0.2, 0];
        const project = makeProjector({lensMode: "pinhole", e, qInv: [0, 0, 0, 1], W: 200, H: 100, aspect: 2});
        const out = {x: 0, y: 0};
        expect(project(new Vector3(0.5, -0.5, -1), out)).toBe(true);
        expect(out).toEqual({x: 150, y: 75});
        expect(project(new Vector3(0, 0, 1), out)).toBe(false);
    });
});

describe("celestial trails", () => {
    // An observer on the equator at longitude 0, looking at the zenith (+x) with
    // a pinhole camera; no refraction and no extinction.
    function job() {
        return prepareJob({
            durationSeconds: 3600, segments: 20, minSkySegmentPx: 4, skyRadius: 100,
            m0: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], earthRate: 7.2921158553e-5, skyRotations: null,
            camPos: [6378137, 0, 0], up: [1, 0, 0], axis: [1, 0, 0], coneAngle: 1, horizonSin: -0.01,
            projection: {lensMode: "pinhole", qInv: [0, -Math.SQRT1_2, 0, Math.SQRT1_2], W: 1000, H: 1000, aspect: 1,
                pxPerRad: 500, e: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1, -1, 0, 0, -0.2, 0]},
            satMag: 4, extinctionK: 0, kAltScale: 1, reddening: false, psfSigma: 0.6, windowSeconds: 10,
            zenith: [1, 0, 0], skyRefraction: {enabled: false},
        });
    }

    test("a star at the zenith drifts west with the sky's turn", () => {
        const j = job();
        const eq = new Vector3(1, 0, 0), out = new Vector3();
        skyDirection(j, eq, 3600, out);
        // 15.04° in an hour, about the pole, westward (towards -y in ECEF at longitude 0)
        expect(out.angleTo(eq) * 180 / Math.PI).toBeCloseTo(15.04, 1);
        expect(out.y).toBeLessThan(0);
    });

    test("a slow star keeps nearly all its light in one pixel: value = flux x along-track fraction", () => {
        const j = job();
        const project = makeProjector(j.projection);
        const sink = makeSink();
        const eq = new Vector3(1, 0, 0);
        const drawn = celestialTrail(j, project, (s, out) => skyDirection(j, eq, s, out), 1, [1, 1, 1], sink);
        expect(drawn).toBe(true);
        // 15°/h at 500 px/rad is 0.036 px/s, 0.36 px per 10 s window: close to a point
        const v = sink.col[0];
        expect(v).toBeGreaterThan(0.55);
        expect(v).toBeLessThan(0.6);
        // trail length 15° * 500 px/rad = 131 px: 20 segments, the limit
        expect(sink.pos.length / 6).toBe(20);
    });

    test("the star band never rejects a star whose path enters the view cone", () => {
        let seed = 7;
        const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
        let rejected = 0, total = 0;
        for (const [coneDeg, hours, decDeg] of [[12, 0.4, 20], [20, 3, -50], [35, 8, 70], [8, 12, 0]]) {
            const j = job();
            j.coneAngle = coneDeg * Math.PI / 180;
            j.durationSeconds = hours * 3600;
            // an EQJ->ECEF start rotation of 1.3 rad about z, and a view axis at decDeg
            const r = 1.3, c = Math.cos(r), s = Math.sin(r);
            j.m0 = [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
            const d = decDeg * Math.PI / 180;
            j.axisV = new Vector3(Math.cos(d), 0.3 * Math.cos(d), Math.sin(d)).normalize();
            const band = starBand(j);
            const eq = new Vector3(), out = new Vector3();
            for (let i = 0; i < 3000; i++) {
                const ra = 2 * Math.PI * rand(), dec = Math.asin(2 * rand() - 1);
                eq.set(Math.cos(dec) * Math.cos(ra), Math.cos(dec) * Math.sin(ra), Math.sin(dec));
                let closest = Math.PI;
                for (let k = 0; k <= 400; k++) {
                    skyDirection(j, eq, j.durationSeconds * k / 400, out);
                    closest = Math.min(closest, out.angleTo(j.axisV));
                }
                const passes = band(ra, dec);
                if (closest <= j.coneAngle) expect(passes).toBe(true);
                if (!passes) rejected++;
                total++;
            }
        }
        // and it does reject most of the sky for these cones
        expect(rejected / total).toBeGreaterThan(0.5);
    });

    test("a star below the horizon all through gives nothing", () => {
        const j = job();
        const project = makeProjector(j.projection);
        const sink = makeSink();
        const eq = new Vector3(-1, 0, 0);
        expect(celestialTrail(j, project, (s, out) => skyDirection(j, eq, s, out), 1, [1, 1, 1], sink)).toBe(false);
        expect(sink.pos.length).toBe(0);
    });
});
