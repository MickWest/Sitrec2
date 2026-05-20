// V5 Phase 0.2: pure helper module for terrain tile bounding volumes.
//
// QuadTreeTile owns state; this module owns geometry math. Keep this file
// import-free of QuadTreeTile/QuadTreeMap so unit tests can drive it without
// instantiating the full quadtree.
//
// Math correctness: a right-handed ENU basis at geodetic point (lat, lon) is
//
//     east  = (-sin lon, cos lon, 0)
//     north = (-sin lat cos lon, -sin lat sin lon, cos lat)
//     up    = (cos lat cos lon, cos lat sin lon, sin lat)
//
// satisfying east × north = up. The implementation derives east by
// `north × up` (north dot up = 0 by construction; north × up gives the
// surface-tangent perpendicular pointing east). Re-orthogonalisation uses
// `north = up × east` (NOT `east × up`, which gives -north).

import {Box3, Frustum, Matrix4, Sphere, Vector3} from "three";
// Convenience path; resolves through the package's `./three` export. Webpack
// tree-shakes unused exports (`"sideEffects": false` in the dep's
// package.json); Jest 30 resolves the `./three` export field via a Jest
// moduleNameMapper added in this commit.
import {OBB} from "3d-tiles-renderer/three";
import {LLAToECEFInto} from "./LLA-ECEF-ENU";

// ----- constants (V5 §3) -----

export const GLOBAL_UNMEASURED_MIN_ALT_M = -1500;
export const GLOBAL_UNMEASURED_MAX_ALT_M = 10000;     // 30,000 ft + headroom
export const INHERITED_MIN_SLACK_M       = 500;
export const INHERITED_MAX_SLACK_M       = 1500;
export const BOUNDS_INFLATE_M            = 10;
export const VIS_CACHE_CAP_PER_TILE      = 4;

const FALLBACK_GRID_SPLIT_Z = 6;
const FALLBACK_GRID_SMALL = 3;
const FALLBACK_GRID_LARGE = 5;

export {OBB};

// ----- inheritance (V5 §3.1) -----

export function inheritBoundsFromParent(parentAltitudeBounds) {
    const parentMeasured = !!parentAltitudeBounds?.measured;
    const inheritedMin = parentMeasured
        ? parentAltitudeBounds.min - INHERITED_MIN_SLACK_M
        : GLOBAL_UNMEASURED_MIN_ALT_M;
    const inheritedMax = parentMeasured
        ? parentAltitudeBounds.max + INHERITED_MAX_SLACK_M
        : GLOBAL_UNMEASURED_MAX_ALT_M;
    return {
        min: Math.min(inheritedMin, GLOBAL_UNMEASURED_MIN_ALT_M),
        max: Math.max(inheritedMax, GLOBAL_UNMEASURED_MAX_ALT_M),
        source: "inherited",
        measured: false,
        generation: 0,
    };
}

// ----- local frame (V5 §6.2) -----

export function buildLocalFrame(centerECEF, lat, lon) {
    const cl = Math.cos(lat);
    const sl = Math.sin(lat);
    const co = Math.cos(lon);
    const so = Math.sin(lon);

    const up = new Vector3(cl * co, cl * so, sl).normalize();
    let north = new Vector3(-sl * co, -sl * so, cl);
    let polarFallbackUsed = false;
    if (Math.abs(cl) < 1e-6) {
        polarFallbackUsed = true;
        north.set(1, 0, 0).projectOnPlane(up);
        if (north.lengthSq() < 1e-12) {
            north.set(0, 1, 0).projectOnPlane(up);
        }
    }
    north.normalize();

    const east = north.clone().cross(up).normalize();
    // Re-orthogonalise via north = up × east. (east × up = -north — the
    // formula V4/V5 doc accidentally specified — would flip handedness.)
    north = up.clone().cross(east).normalize();

    return {east, north, up, polarFallbackUsed};
}

// ----- fallback point set (V5 §6.1) -----

export function buildFallbackPointSet(tileBounds, altitudeBounds, options) {
    const {z, x, y, mapProjection} = tileBounds;
    if (z < 3) return 0;

    const {points} = options;
    const gridN = (z < FALLBACK_GRID_SPLIT_Z) ? FALLBACK_GRID_LARGE : FALLBACK_GRID_SMALL;

    const latTop    = mapProjection.getNorthLatitude(y,     z);
    const latBottom = mapProjection.getNorthLatitude(y + 1, z);
    const lonLeft   = mapProjection.getLeftLongitude(x,     z);
    const lonRight  = mapProjection.getLeftLongitude(x + 1, z);

    let n = 0;
    for (let alt of [altitudeBounds.min, altitudeBounds.max]) {
        for (let i = 0; i < gridN; i++) {
            const fi = i / (gridN - 1);
            const lat = latTop + (latBottom - latTop) * fi;
            for (let j = 0; j < gridN; j++) {
                const fj = j / (gridN - 1);
                const lon = lonLeft + (lonRight - lonLeft) * fj;
                LLAToECEFInto(lat, lon, alt, points[n]);
                n++;
            }
        }
    }
    return n;
}

export function maxPointsFor(z) {
    if (z < 3) return 0;
    const gridN = (z < FALLBACK_GRID_SPLIT_Z) ? FALLBACK_GRID_LARGE : FALLBACK_GRID_SMALL;
    return 2 * gridN * gridN;
}

// ----- skirt vertex set (V5 §4.1) -----

export function buildSkirtVertexSet(outerEdgeVerticesECEF, count, skirtDepth, pointsOut) {
    let n = 0;
    for (let i = 0; i < count; i++) {
        const v = outerEdgeVerticesECEF[i];
        const len = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
        if (len < 1e-6) continue;
        const inv = -skirtDepth / len;
        pointsOut[n].set(v.x + v.x * inv, v.y + v.y * inv, v.z + v.z * inv);
        n++;
    }
    return n;
}

// ----- bounding sphere (V5 §6.3) -----

export function buildCullingSphere(points, count) {
    if (count < 1) {
        throw new Error("buildCullingSphere: empty point set");
    }
    let sx = 0, sy = 0, sz = 0;
    for (let i = 0; i < count; i++) {
        sx += points[i].x;
        sy += points[i].y;
        sz += points[i].z;
    }
    const inv = 1 / count;
    const cx = sx * inv, cy = sy * inv, cz = sz * inv;
    let rSq = 0;
    for (let i = 0; i < count; i++) {
        const dx = points[i].x - cx;
        const dy = points[i].y - cy;
        const dz = points[i].z - cz;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 > rSq) rSq = d2;
    }
    return new Sphere(new Vector3(cx, cy, cz), Math.sqrt(rSq) + BOUNDS_INFLATE_M);
}

// ----- bounding OBB (V5 §6.4) -----

const _scratchLocal = new Vector3();
const _scratchSub = new Vector3();
const _scratchBoxCenter = new Vector3();
const _scratchBoxSize = new Vector3();

export function buildCullingOBB(points, count, localFrame, originECEF) {
    if (count < 1) {
        throw new Error("buildCullingOBB: empty point set");
    }
    const {east, north, up} = localFrame;
    const box = new Box3();
    box.min.set(Infinity, Infinity, Infinity);
    box.max.set(-Infinity, -Infinity, -Infinity);
    for (let i = 0; i < count; i++) {
        _scratchSub.subVectors(points[i], originECEF);
        _scratchLocal.set(
            _scratchSub.dot(east),
            _scratchSub.dot(north),
            _scratchSub.dot(up)
        );
        box.expandByPoint(_scratchLocal);
    }
    if (!isFinite(box.min.x) || !isFinite(box.max.x)) {
        throw new Error("buildCullingOBB: non-finite bounds");
    }
    box.getCenter(_scratchBoxCenter);
    box.getSize(_scratchBoxSize);

    const halfX = _scratchBoxSize.x * 0.5 + BOUNDS_INFLATE_M;
    const halfY = _scratchBoxSize.y * 0.5 + BOUNDS_INFLATE_M;
    const halfZ = _scratchBoxSize.z * 0.5 + BOUNDS_INFLATE_M;

    const obbCenterECEF = new Vector3()
        .copy(originECEF)
        .addScaledVector(east, _scratchBoxCenter.x)
        .addScaledVector(north, _scratchBoxCenter.y)
        .addScaledVector(up, _scratchBoxCenter.z);

    const obb = new OBB();
    obb.box.min.set(-halfX, -halfY, -halfZ);
    obb.box.max.set( halfX,  halfY,  halfZ);
    obb.transform.makeBasis(east, north, up).setPosition(obbCenterECEF);
    obb.update();
    return obb;
}

// ----- local-to-ECEF helper (V5 §4.1) -----

export function localToECEF(originECEF, localFrame, localVec, outECEF) {
    return outECEF
        .copy(originECEF)
        .addScaledVector(localFrame.east, localVec.x)
        .addScaledVector(localFrame.north, localVec.y)
        .addScaledVector(localFrame.up, localVec.z);
}

// ----- frustum shape (V5 §7) -----

const NDC_CORNERS = [
    new Vector3(-1, -1, -1), new Vector3( 1, -1, -1),
    new Vector3(-1,  1, -1), new Vector3( 1,  1, -1),
    new Vector3(-1, -1,  1), new Vector3( 1, -1,  1),
    new Vector3(-1,  1,  1), new Vector3( 1,  1,  1),
];

const _viewProjMat4 = new Matrix4();
const _invViewProjMat4 = new Matrix4();

export function buildFrustumShape(shape, camera, projectionMatrix) {
    _viewProjMat4.multiplyMatrices(projectionMatrix, camera.matrixWorldInverse);
    shape.frustum.setFromProjectionMatrix(_viewProjMat4);
    shape.planes = shape.frustum.planes;
    _invViewProjMat4.copy(_viewProjMat4).invert();
    for (let i = 0; i < 8; i++) {
        shape.points[i].copy(NDC_CORNERS[i]).applyMatrix4(_invViewProjMat4);
    }
    return shape;
}

export function createFrustumShape() {
    const frustum = new Frustum();
    const points = [];
    for (let i = 0; i < 8; i++) points.push(new Vector3());
    return {frustum, planes: frustum.planes, points};
}

export function buildDilatedProjectionMatrix(camera, dilationFactor, outMatrix) {
    outMatrix.copy(camera.projectionMatrix);
    if (dilationFactor !== 1.0) {
        outMatrix.elements[0] /= dilationFactor;
        outMatrix.elements[5] /= dilationFactor;
    }
    return outMatrix;
}
