/**
 * V5 Phase 0.2 unit tests for the QuadTreeCullingBounds helper module.
 *
 * Covers:
 *   - inheritBoundsFromParent: clamp to global, slack handling, no leak of measured flag
 *   - buildLocalFrame: right-handed ENU at equator, mid-latitude, exact pole; polar fallback flag
 *   - buildCullingSphere: encloses every input point + slack
 *   - buildCullingOBB: encloses every input point in world space; centre offset preserved; empty input throws
 *   - localToECEF: identity at origin, east maps to east
 *   - buildFrustumShape: 8 world-space corners; NASA OBB.intersectsFrustum accepts the shape; dilated differs from strict
 *   - buildDilatedProjectionMatrix: factor 1.0 identity, factor 1.5 divides [0]/[5]
 */

import {Box3, PerspectiveCamera, Vector3, Matrix4} from "three";
import {
    BOUNDS_INFLATE_M,
    GLOBAL_UNMEASURED_MAX_ALT_M,
    GLOBAL_UNMEASURED_MIN_ALT_M,
    INHERITED_MAX_SLACK_M,
    INHERITED_MIN_SLACK_M,
    OBB,
    buildCullingOBB,
    buildCullingSphere,
    buildDilatedProjectionMatrix,
    buildFrustumShape,
    buildLocalFrame,
    createFrustumShape,
    inheritBoundsFromParent,
    localToECEF,
} from "../src/QuadTreeCullingBounds";

describe("inheritBoundsFromParent", () => {
    test("no parent → global defaults", () => {
        const b = inheritBoundsFromParent(null);
        expect(b.min).toBe(GLOBAL_UNMEASURED_MIN_ALT_M);
        expect(b.max).toBe(GLOBAL_UNMEASURED_MAX_ALT_M);
        expect(b.source).toBe("inherited");
        expect(b.measured).toBe(false);
    });
    test("unmeasured parent → global defaults", () => {
        const b = inheritBoundsFromParent({min: -200, max: 3000, measured: false});
        expect(b.min).toBe(GLOBAL_UNMEASURED_MIN_ALT_M);
        expect(b.max).toBe(GLOBAL_UNMEASURED_MAX_ALT_M);
    });
    test("measured low-relief parent → clamps to global ceiling", () => {
        const b = inheritBoundsFromParent({min: 0, max: 200, measured: true});
        expect(b.max).toBe(GLOBAL_UNMEASURED_MAX_ALT_M);
    });
    test("measured high-relief parent → expands above global", () => {
        const b = inheritBoundsFromParent({min: 0, max: 12000, measured: true});
        expect(b.max).toBe(12000 + INHERITED_MAX_SLACK_M);
    });
    test("measured deep-trench parent → expands below global", () => {
        const b = inheritBoundsFromParent({min: -3000, max: 0, measured: true});
        expect(b.min).toBe(-3000 - INHERITED_MIN_SLACK_M);
    });
});

describe("buildLocalFrame", () => {
    test("right-handed ENU at lat 0, lon 0", () => {
        const f = buildLocalFrame(new Vector3(6378137, 0, 0), 0, 0);
        expect(f.east.x).toBeCloseTo(0, 6);
        expect(f.east.y).toBeCloseTo(1, 6);
        expect(f.east.z).toBeCloseTo(0, 6);
        expect(f.north.x).toBeCloseTo(0, 6);
        expect(f.north.y).toBeCloseTo(0, 6);
        expect(f.north.z).toBeCloseTo(1, 6);
        expect(f.up.x).toBeCloseTo(1, 6);
        expect(f.polarFallbackUsed).toBe(false);
        const cross = f.east.clone().cross(f.north);
        expect(cross.distanceTo(f.up)).toBeLessThan(1e-9);
    });
    test("orthonormality at mid-latitude", () => {
        const lat = (30 * Math.PI) / 180;
        const lon = (45 * Math.PI) / 180;
        const f = buildLocalFrame(new Vector3(1, 1, 1).normalize().multiplyScalar(6378137), lat, lon);
        expect(f.east.length()).toBeCloseTo(1, 6);
        expect(f.north.length()).toBeCloseTo(1, 6);
        expect(f.up.length()).toBeCloseTo(1, 6);
        expect(f.east.dot(f.north)).toBeCloseTo(0, 6);
        expect(f.east.dot(f.up)).toBeCloseTo(0, 6);
        expect(f.north.dot(f.up)).toBeCloseTo(0, 6);
        const cross = f.east.clone().cross(f.north);
        expect(cross.x).toBeCloseTo(f.up.x, 6);
        expect(cross.y).toBeCloseTo(f.up.y, 6);
        expect(cross.z).toBeCloseTo(f.up.z, 6);
    });
    test("polar fallback at exact north pole", () => {
        const f = buildLocalFrame(new Vector3(0, 0, 6378137), Math.PI / 2, 0);
        expect(f.polarFallbackUsed).toBe(true);
        expect(f.up.distanceTo(new Vector3(0, 0, 1))).toBeLessThan(1e-9);
        expect(f.east.length()).toBeCloseTo(1, 6);
        expect(f.north.length()).toBeCloseTo(1, 6);
    });
    test("east points east (V4/V5 doc bug regression)", () => {
        const f = buildLocalFrame(new Vector3(6378137, 0, 0), 0, 0);
        expect(f.east.y).toBeGreaterThan(0.99);
    });
});

describe("buildCullingSphere", () => {
    test("encloses every input point with BOUNDS_INFLATE_M slack", () => {
        const pts = [new Vector3(10, 0, 0), new Vector3(0, 10, 0), new Vector3(0, 0, 10), new Vector3(-5, -5, -5)];
        const sphere = buildCullingSphere(pts, pts.length);
        for (const p of pts) {
            expect(sphere.center.distanceTo(p)).toBeLessThanOrEqual(sphere.radius);
        }
    });
    test("includes BOUNDS_INFLATE_M slack", () => {
        const pts = [new Vector3(0, 0, 0), new Vector3(2, 0, 0)];
        const sphere = buildCullingSphere(pts, pts.length);
        expect(sphere.radius).toBeCloseTo(1 + BOUNDS_INFLATE_M, 6);
    });
    test("throws on empty input", () => {
        expect(() => buildCullingSphere([], 0)).toThrow();
    });
});

describe("buildCullingOBB", () => {
    test("encloses input points in world space at lat 0/lon 0", () => {
        const origin = new Vector3(6378137, 0, 0);
        const f = buildLocalFrame(origin, 0, 0);
        const pts = [
            new Vector3(6378137,     -500, -500),
            new Vector3(6378137,      500, -500),
            new Vector3(6378137,     -500,  500),
            new Vector3(6378137,      500,  500),
            new Vector3(6378137+200, -500, -500),
            new Vector3(6378137+200,  500,  500),
        ];
        const obb = buildCullingOBB(pts, pts.length, f, origin);
        for (const p of pts) {
            expect(obb.containsPoint(p)).toBe(true);
        }
    });
    test("preserves non-zero box centre offset", () => {
        const origin = new Vector3(6378137, 0, 0);
        const f = buildLocalFrame(origin, 0, 0);
        const pts = [
            new Vector3(6378137 + 200, -100, -100),
            new Vector3(6378137 + 200,  100, -100),
            new Vector3(6378137 + 200, -100,  100),
            new Vector3(6378137 + 200,  100,  100),
        ];
        const obb = buildCullingOBB(pts, pts.length, f, origin);
        const transformPos = new Vector3().setFromMatrixPosition(obb.transform);
        expect(transformPos.distanceTo(origin)).toBeGreaterThan(150);
        for (const p of pts) {
            expect(obb.containsPoint(p)).toBe(true);
        }
    });
    test("throws on empty input", () => {
        const f = buildLocalFrame(new Vector3(6378137, 0, 0), 0, 0);
        expect(() => buildCullingOBB([], 0, f, new Vector3(6378137, 0, 0))).toThrow();
    });
});

describe("localToECEF", () => {
    test("origin maps to origin", () => {
        const origin = new Vector3(6378137, 0, 0);
        const f = buildLocalFrame(origin, 0, 0);
        const out = new Vector3();
        localToECEF(origin, f, new Vector3(0, 0, 0), out);
        expect(out.distanceTo(origin)).toBeLessThan(1e-9);
    });
    test("unit east maps to east unit vector in ECEF", () => {
        const origin = new Vector3(6378137, 0, 0);
        const f = buildLocalFrame(origin, 0, 0);
        const out = new Vector3();
        localToECEF(origin, f, new Vector3(1, 0, 0), out);
        expect(out.distanceTo(origin.clone().add(f.east))).toBeLessThan(1e-9);
    });
});

describe("buildFrustumShape", () => {
    test("populates 8 world-space corner points", () => {
        const camera = new PerspectiveCamera(60, 1, 1, 1000);
        camera.position.set(0, 0, 10);
        camera.lookAt(0, 0, 0);
        camera.updateMatrixWorld();
        const shape = createFrustumShape();
        buildFrustumShape(shape, camera, camera.projectionMatrix);
        expect(shape.points.length).toBe(8);
        for (const p of shape.points) expect(p.lengthSq()).toBeGreaterThan(0.01);
        expect(shape.planes.length).toBe(6);
    });
    test("NASA OBB.intersectsFrustum accepts the shape", () => {
        const camera = new PerspectiveCamera(60, 1, 1, 1000);
        camera.position.set(0, 0, 10);
        camera.lookAt(0, 0, 0);
        camera.updateMatrixWorld();
        const shape = createFrustumShape();
        buildFrustumShape(shape, camera, camera.projectionMatrix);
        const obb = new OBB();
        obb.box.min.set(-1, -1, -1);
        obb.box.max.set( 1,  1,  1);
        obb.update();
        expect(obb.intersectsFrustum(shape)).toBe(true);
    });
    test("OBB outside the frustum is rejected", () => {
        const camera = new PerspectiveCamera(60, 1, 1, 1000);
        camera.position.set(0, 0, 10);
        camera.lookAt(0, 0, 0);
        camera.updateMatrixWorld();
        const shape = createFrustumShape();
        buildFrustumShape(shape, camera, camera.projectionMatrix);
        const obb = new OBB();
        obb.box.min.set(-1, -1, -1);
        obb.box.max.set( 1,  1,  1);
        obb.transform.setPosition(0, 0, 100);
        obb.update();
        expect(obb.intersectsFrustum(shape)).toBe(false);
    });
});

describe("buildDilatedProjectionMatrix", () => {
    test("factor 1.0 returns matrix equal to camera.projectionMatrix", () => {
        const camera = new PerspectiveCamera(60, 1, 1, 1000);
        camera.updateProjectionMatrix();
        const out = new Matrix4();
        buildDilatedProjectionMatrix(camera, 1.0, out);
        for (let i = 0; i < 16; i++) {
            expect(out.elements[i]).toBeCloseTo(camera.projectionMatrix.elements[i], 9);
        }
    });
    test("factor 1.5 divides elements [0] and [5]", () => {
        const camera = new PerspectiveCamera(60, 1, 1, 1000);
        camera.updateProjectionMatrix();
        const out = new Matrix4();
        buildDilatedProjectionMatrix(camera, 1.5, out);
        expect(out.elements[0]).toBeCloseTo(camera.projectionMatrix.elements[0] / 1.5, 9);
        expect(out.elements[5]).toBeCloseTo(camera.projectionMatrix.elements[5] / 1.5, 9);
        expect(out.elements[10]).toBeCloseTo(camera.projectionMatrix.elements[10], 9);
    });
});
