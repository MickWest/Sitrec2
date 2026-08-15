import {Raycaster, Vector3} from "three";
import {Globals, NodeMan} from "./Globals";
import {ECEFToLLAVD_radii, wgs84} from "./LLA-ECEF-ENU";
import {meanSeaLevelOffset} from "./EGM96Geoid";
import * as LAYER from "./LayerMasks";

// Intersections with a subtree, nearest first, skipping anything the renderer is
// not DRAWING.
//
// NOT raycaster.intersectObject(group, true): Three.js's raycaster ignores
// .visible, and 3DTilesRenderer keeps every loaded tile in the scene graph,
// hiding the LOD levels it is not showing by clearing visible on their tile
// group. A coarse ancestor tile spans a whole region on a few hundred vertices,
// so it interpolates the basin floor from the high ground around it: over Los
// Angeles one sat 1.66 km ABOVE Torrance airport. As the nearest hit that
// invisible tile then won every pick, and because zoom dollies TOWARD the picked
// point — cutting the remaining distance by a fixed fraction each notch — the
// camera converged on a point in mid-air and the airport never got any closer.
// That is what "something is in the way" looks like from the outside.
//
// Pruning invisible subtrees is also cheaper than the recursive intersect, since
// it skips geometry that will never be drawn.
function intersectDisplayed(object, raycaster) {
    const intersects = [];
    gatherDisplayed(object, raycaster, intersects);
    intersects.sort((a, b) => a.distance - b.distance);
    return intersects;
}

// The recursion behind intersectDisplayed.
//
// Only objects that carry geometry are raycast, never the containers. That is
// load-bearing, not tidiness: 3DTilesRenderer's TilesGroup overrides raycast()
// with its own recursive descent, so calling it re-enters the library walk and
// re-introduces every hidden tile this function just pruned. Skipping
// geometry-less nodes leaves the recursion entirely to us. (An earlier version
// of this called object.raycast unconditionally, mirroring Three.js's own
// intersectObject walk, and pruned nothing at all.)
//
// The test is `geometry !== undefined` rather than `isMesh` so it also covers
// the Points that 3DTilesRenderer builds for PNTS point-cloud tiles. Sitrec's
// configured sources (Google Photorealistic, Cesium OSM) are all mesh, and
// InstancedMesh / BatchedMesh are Meshes, so isMesh would be enough today —
// but a leaf with geometry is the property that actually matters here, and
// there is no container in the tiles tree that has one.
function gatherDisplayed(object, raycaster, intersects) {
    if (object.visible === false) return;
    if (object.geometry !== undefined && object.layers.test(raycaster.layers)) {
        object.raycast(raycaster, intersects);
    }
    const children = object.children;
    for (let i = 0; i < children.length; i++) {
        gatherDisplayed(children[i], raycaster, intersects);
    }
}

// Cast a Raycaster's ray at "the ground," in order of preference:
//
//   1. The NEAREST concrete surface the ray reaches: the terrain mesh AND —
//      when `camera` is supplied and Google Photorealistic 3D buildings are
//      loaded — the 3D-tile geometry (building roofs / walls). Whichever is
//      hit FIRST wins, so orbit / pan / zoom anchors on the rooftop the user
//      is looking at rather than the terrain hidden behind it. Without a
//      building hit this is just the terrain mesh, as before.
//   2. A sphere matching the geocentric ellipsoid radius at the CAMERA'S
//      OWN latitude. NOT Globals.equatorRadius — at mid-latitudes the
//      WGS84 equatorial-radius sphere sits several kilometres above the
//      real ground, so a camera near street level is mathematically
//      INSIDE it. From inside a sphere, Three.js's Ray.intersectSphere
//      returns the far exit point ~12,700 km away through the opposite
//      side of the planet, which then poisons orbit/zoom anchors and any
//      other "where is the ground here?" query. The geocentric ellipsoid
//      radius at the camera's latitude keeps the sphere right at local
//      ground level so a cleanly forward-going ray hits the near side.
//   3. Returns null if neither hit succeeds (terrain miss + ray going
//      away from the local ground, e.g. looking up at the sky).
//
// The 3D-tile meshes live on the MAIN / LOOK layers (not layer 0), so hitting
// them needs the caller's camera layer mask. That is why the buildings pass is
// gated on a `camera` argument: legacy callers that pass none get the exact old
// terrain-only behaviour.
//
// Returns {point, isTerrain} or null. point is a freshly allocated Vector3 the
// caller can keep. isTerrain is true for ANY concrete surface hit (terrain OR
// building) and false only for the ellipsoid fallback — CameraControls reads it
// to choose a flat drag-plane (near surface) over a globe drag-sphere, and a
// building roof is a near surface just like terrain.
export function raycastLocalGround(raycaster, camera = undefined) {
    // Flat Earth rendering (Physics → Scenarios → Flat Earth) warps the
    // RENDER into an azimuthal-equidistant disc, so the screen ray must be
    // traced through the warped space and mapped back to globe coordinates.
    // The scenario installs this hook only while it is enabled; it returns
    // this function's exact {point, isTerrain}|null contract.
    if (Globals.flatEarthPickGround) {
        return Globals.flatEarthPickGround(raycaster.ray.origin, raycaster.ray.direction);
    }

    // Track the nearest concrete-surface hit so a building roof under the
    // cursor beats the terrain behind it.
    let bestPoint = null;
    let bestDist = Infinity;

    // Google Photorealistic 3D buildings. The tile meshes are on the MAIN/LOOK
    // layers, so temporarily widen the raycaster's layer mask to the camera's
    // before intersecting the shared tiles group, then restore it. firstHitOnly
    // asks the tiles' BVH for just the nearest hit (also faster); it is ignored
    // for non-BVH meshes, where the sorted hits[0] is still the nearest.
    // Tested BEFORE the terrain so a hidden basemap can be skipped entirely (see
    // below) — when it is hidden this also saves the terrain mesh's ~1 ms
    // BVH-less raycast on every query.
    if (camera && NodeMan.exists("buildings3DTiles")) {
        const group = NodeMan.get("buildings3DTiles").group;
        if (group && group.children.length > 0) {
            const savedMask = raycaster.layers.mask;
            const savedFirstHit = raycaster.firstHitOnly;
            raycaster.layers.mask = camera.layers.mask;
            raycaster.firstHitOnly = true;
            const hits = intersectDisplayed(group, raycaster);
            raycaster.layers.mask = savedMask;
            raycaster.firstHitOnly = savedFirstHit;
            if (hits.length > 0) {
                bestPoint = hits[0].point;
                bestDist = hits[0].distance;
            }
        }
    }

    if (NodeMan.exists("TerrainModel")) {
        const terrainNode = NodeMan.get("TerrainModel");
        // Under Google Photorealistic 3D tiles the basemap is hidden — its group
        // gets visible=false (CNodeTerrainUI.updateTerrainAndOceanVisibility ->
        // setTerrainVisible) — but it stays in the scene, and Three.js's raycaster
        // ignores .visible. The elevation surface can sit tens of metres ABOVE the
        // tile geometry, so as the nearer hit it silently won every pick: the orbit
        // pivot, drag anchor and C-key placement all landed on invisible ground far
        // closer than what is on screen, which reads as "shift-drag rotates about
        // the camera" and "dragging barely moves the world". Only fall back to the
        // hidden terrain for rays that miss the tiles entirely (e.g. outside the
        // 3D-tile coverage, or before they stream in).
        const terrainHidden = terrainNode.group?.visible === false;
        if (!terrainHidden || bestPoint === null) {
            const hit = terrainNode.getClosestIntersect(raycaster);
            if (hit && hit.distance < bestDist) {
                bestPoint = hit.point;
                bestDist = hit.distance;
            }
        }
    }

    if (bestPoint) {
        return {point: bestPoint.clone(), isTerrain: true};
    }

    const point = ellipsoidAlongRay(raycaster.ray.origin, raycaster.ray.direction);
    return point === null ? null : {point, isTerrain: false};
}

/**
 * Where a ray meets a sphere at the local ground radius — the last-resort surface.
 *
 * The radius is the geocentric ellipsoid radius at the RAY ORIGIN'S OWN latitude, not
 * Globals.equatorRadius. At mid-latitudes the WGS84 equatorial-radius sphere sits several
 * kilometres above the real ground, so a camera near street level is mathematically INSIDE it,
 * and from inside a sphere Three.js's Ray.intersectSphere returns the far exit point ~12,700 km
 * away through the opposite side of the planet — which then poisons every anchor derived from it.
 *
 * @param {Vector3} origin
 * @param {Vector3} direction  must be normalised
 * @returns {Vector3|null} null when the ray goes away from the local ground (e.g. up at the sky)
 */
export function ellipsoidAlongRay(origin, direction) {
    const camLen = origin.length();
    if (camLen < 1) return null;

    const sinLat = origin.z / camLen;
    const cosLatSq = 1 - sinLat * sinLat;
    const a = wgs84.RADIUS;
    const b = wgs84.POLAR_RADIUS;
    const groundRadius = 1 / Math.sqrt(cosLatSq / (a * a) + (sinLat * sinLat) / (b * b));

    const B = origin.dot(direction);
    const C = camLen * camLen - groundRadius * groundRadius;
    const disc = B * B - C;
    if (disc < 0) return null;

    // Only the near root is meaningful. The far root is the exit on the
    // opposite side of the planet — never a valid ground anchor.
    const t0 = -B - Math.sqrt(disc);
    if (t0 <= 0) return null;

    return new Vector3(
        origin.x + direction.x * t0,
        origin.y + direction.y * t0,
        origin.z + direction.z * t0,
    );
}

// One sample of the served ground surface under an ECEF point: signed
// clearance above it, footprint lat/lon, which elevation tile answered, its
// subtree slope bound, and the border-cut rectangles for the marcher (see
// QuadTreeMapElevation._getServedIndex). The surface is
// max(bilinear elevation, EGM96 geoid) — the same clamp as
// CNodeTerrain.getPointBelow. Where no elevation data exists (outside the
// sitch region, tiles still loading, no TerrainModel at all) the surface
// degrades to the geoid, i.e. sea level, with tileKey "-1/-1/-1".
export function sampleGroundSurface(p, elevationMap, out) {
    const LLA = ECEFToLLAVD_radii(p);
    const seaLevel = meanSeaLevelOffset(LLA.x, LLA.y);
    let elevation = seaLevel;
    let tileZ = -1;
    let tileX = -1;
    let tileY = -1;
    if (elevationMap) {
        const info = elevationMap.getElevationWithTileInfo(LLA.x, LLA.y);
        if (info.elevation > seaLevel) elevation = info.elevation;
        tileZ = info.tileZ;
        tileX = info.tileX;
        tileY = info.tileY;
    }
    out.lat = LLA.x;
    out.lon = LLA.y;
    out.clearance = LLA.z - elevation;
    out.tileKey = tileZ + "/" + tileX + "/" + tileY;
    if (!elevationMap) {
        out.slope = 0;
        out.rect = null;
        out.descRects = null;
    } else if (tileZ < 0) {
        // Geoid region: flat (geoid gradients ~1e-4, covered by the L
        // floor); step cutting below stops the march just outside any
        // loaded tile's rectangle, so no tile can be entered mid-step.
        out.slope = 0;
        out.rect = null;
        out.descRects = elevationMap.servedGlobalRects();
    } else {
        const sub = elevationMap.subtreeSlopeBound(tileZ, tileX, tileY);
        out.slope = sub.bound;
        out.rect = sub.rect;
        out.descRects = sub.descRects;
    }
    return out;
}

// First parameter s in (0, 1] at which the lat/lon segment enters the
// rectangle expanded by (padLat, padLon), or Infinity. Standard slab test;
// division by zero yields ±Infinity which the min/max logic handles.
function segmentRectEntry(lat0, lon0, lat1, lon1, rect, padLat, padLon) {
    const dLat = lat1 - lat0;
    const dLon = lon1 - lon0;
    let s0 = 0;
    let s1 = 1;
    for (const [p0, d, lo, hi] of [
        [lat0, dLat, rect.latS - padLat, rect.latN + padLat],
        [lon0, dLon, rect.lonW - padLon, rect.lonE + padLon],
    ]) {
        if (d === 0) {
            if (p0 < lo || p0 > hi) return Infinity;
        } else {
            let a = (lo - p0) / d;
            let b = (hi - p0) / d;
            if (a > b) { const tmp = a; a = b; b = tmp; }
            if (a > s0) s0 = a;
            if (b < s1) s1 = b;
        }
    }
    if (s0 > s1 || s0 <= 0 || s0 > 1) return Infinity;
    return s0;
}

// Parameter s in (0, 1] at which the lat/lon segment (starting inside)
// leaves the rectangle shrunk by (padLat, padLon); 0 if it starts outside
// the shrunk rectangle; Infinity if it never leaves within the segment.
function segmentRectExit(lat0, lon0, lat1, lon1, rect, padLat, padLon) {
    const latS = rect.latS + padLat;
    const latN = rect.latN - padLat;
    const lonW = rect.lonW + padLon;
    const lonE = rect.lonE - padLon;
    if (lat0 < latS || lat0 > latN || lon0 < lonW || lon0 > lonE) return 0;
    let s = Infinity;
    const dLat = lat1 - lat0;
    const dLon = lon1 - lon0;
    if (dLat > 0) s = Math.min(s, (latN - lat0) / dLat);
    else if (dLat < 0) s = Math.min(s, (latS - lat0) / dLat);
    if (dLon > 0) s = Math.min(s, (lonE - lon0) / dLon);
    else if (dLon < 0) s = Math.min(s, (lonW - lon0) / dLon);
    return s > 1 ? Infinity : s;
}

// Fast ray→ground intersection against the terrain ELEVATION MAP instead of
// the terrain mesh triangles. raycastLocalGround above is exact against the
// rendered polygons, but terrain tiles have no BVH, so Three.js brute-forces
// every triangle of every tile whose bounding sphere the ray touches — ~1 ms
// per ray on a loaded terrain. Sphere-tracing the same source elevation data
// costs a few dozen sub-microsecond map lookups per ray instead, which is what
// makes bulk per-frame queries viable (the 20,000-frame MISB export spent 25
// of its 25.5 seconds in Raycaster.intersectObjects before this existed).
//
// Differences from raycastLocalGround:
//  - the hit is on the bilinear elevation surface, not the triangulated mesh,
//    so it can differ from the render by interpolation error (sub-meter on
//    ordinary terrain, worst on steep tiles);
//  - buildings / Google 3D tiles are never considered;
//  - where no elevation data exists the fallback surface is the EGM96 geoid
//    (sea level) rather than the camera-latitude geocentric sphere;
//  - terrain "flattening" (flat-earth sitches) bends the rendered mesh away
//    from this analytic surface, so flattened terrain routes to the exact
//    mesh raycast instead of the marcher;
//  - elevation exaggeration (zScale) is honored — the marcher reads it from
//    the elevation map and widens its step safety margin to match.
//
// direction must be normalized. Returns a freshly allocated ECEF Vector3, or
// null if the ray never reaches the ground (looking up / over the horizon)
// within maxDistance.
export function raycastGroundElevationFast(origin, direction, maxDistance = 1000000) {
    const terrainNode = NodeMan.exists("TerrainModel") ? NodeMan.get("TerrainModel") : null;

    // Terrain "flattening" (flat-earth sitches) bends the rendered mesh away
    // from the ellipsoid the elevation surface lives on — the analytic model
    // below simply does not describe the rendered terrain, so use the exact
    // mesh raycast instead.
    if (terrainNode && terrainNode.in.flattening !== undefined && terrainNode.in.flattening.v0 > 0) {
        return raycastGroundMeshFallback(origin, direction);
    }

    const elevationMap = terrainNode ? terrainNode.elevationMap : null;
    const zScale = (elevationMap && elevationMap.options && elevationMap.options.zScale) || 1;

    // Conservative sphere-trace. CONTRACT — what is and is not guaranteed:
    //
    // Core argument: along the ray, the clearance
    // c(t) = rayAltitude − servedElevation falls at a rate of at most
    // (1 + L) per meter — geodetic altitude is 1-Lipschitz in position, the
    // ray's ground-footprint speed is ≤ 1, and the served surface rises at
    // most L per meter of ground distance. Stepping c/(1+L) therefore does
    // not step over a crossing ANYWHERE the L in hand actually bounds the
    // surface being traversed. L is measured, not assumed: per sample,
    // subtreeSlopeBound gives the max clamped bilinear-cell gradient of the
    // answering tile's raster and every loaded descendant that could answer
    // inside its footprint (cached), scaled by the live elevation-
    // exaggeration setting (options.zScale multiplies every elevation and
    // therefore every slope), with a small floor for the geoid fallback
    // surface (geoid gradients are ~1e-4).
    //
    // Where the L-in-hand can fail to bound the traversed surface, and the
    // corresponding defenses:
    //  - a step whose endpoints answer from DIFFERENT tiles: the served
    //    surface can jump at the border (zoom transitions, parent/child
    //    data disagreement). Defense: bisect to the border, check the far
    //    side's clearance right at entry (a downward jump there is itself
    //    the crossing), and re-derive the step from the new tile's bound.
    //  - a descendant "pocket" interior to a same-tile step (transition
    //    ring). Defense: the subtree bound covers pocket SLOPES, and below
    //    CREEP_CEILING clearance in descendant-bearing tiles the marcher
    //    creeps at 1 m steps so a pocket border wall taller than the local
    //    clearance cannot be straddled unobserved.
    //  - footprint-path curvature: the lat/lon footprint of a straight ECEF
    //    ray bows away from its chord by ~dt²/2R, which would let a long
    //    step's path wander into a NEIGHBORING tile and back unobserved.
    //    Defense: MAX_STEP caps dt so the bow stays ≈ 0.1 m, restoring the
    //    convex-rectangle prefix argument to that tolerance.
    //
    // EXPLICIT ASSUMPTIONS AND RESIDUAL MISS CLASSES (not proven, stated):
    //  (1) parent/child served-data disagreement is assumed ≤ CREEP_CEILING
    //      where clearance exceeds it;
    //  (2) slivers below the working tolerances — the ~1 cm border-bisection
    //      window, ~0.1 m footprint bow, sub-meter pocket corner-clips —
    //      can hide only GRAZES, with undetected penetration bounded by
    //      ~(1 + L) × sliver length (meter-scale at worst).
    // Exact closure of (1)–(2) would need quadtree DDA traversal. Callers
    // needing exactness against the RENDERED MESH (which this elevation
    // surface only approximates) must use raycastLocalGround; flattening,
    // and step-budget exhaustion, route there automatically.
    //
    // There is deliberately no distance-proportional step floor (an earlier
    // version had one and it could skip narrow ridges at long range); the
    // 1 m floor is far below the raster's representable feature size.
    const CREEP_CEILING = 30; // m — generous vs typical parent/child disagreement
    const MAX_STEP = 1000;    // m — keeps footprint chord bow ≈ dt²/2R ≤ ~0.1 m
    const MAX_STEPS = 30000;

    const p = new Vector3();
    const probe = {};
    const A = {};
    const B = {};
    const at = (tt, slot) => {
        p.copy(origin).addScaledVector(direction, tt);
        return sampleGroundSurface(p, elevationMap, slot);
    };

    // bisect a bracket [lo: clearance>0, hi: clearance<=0] to ~1 cm
    const bisectHit = (lo, hi) => {
        while (hi - lo > 0.01) {
            const mid = 0.5 * (lo + hi);
            if (at(mid, probe).clearance > 0) lo = mid;
            else hi = mid;
        }
        return new Vector3().copy(origin).addScaledVector(direction, hi);
    };

    at(0, A);
    if (A.clearance <= 0) return origin.clone(); // started at or below the ground

    let t = 0;
    for (let i = 0; i < MAX_STEPS; i++) {
        if (t >= maxDistance) return null; // never reached the ground
        const L = Math.max(0.01, A.slope * zScale);
        let dt = Math.min(MAX_STEP, Math.max(1, A.clearance / (1 + L)));
        if (A.hasDescendants && A.clearance < CREEP_CEILING) dt = 1;
        const tNext = Math.min(t + dt, maxDistance);
        at(tNext, B);
        if (B.tileKey !== A.tileKey) {
            // Footprint crossed into a different served tile: advance only
            // to the border (bisect on the answering tile — the footprint
            // chord exits this tile's convex rectangle exactly once, so the
            // "still tile A" region is a prefix) and check the far side.
            let lo = t;
            let hi = tNext;
            while (hi - lo > 0.01) {
                const mid = 0.5 * (lo + hi);
                if (at(mid, probe).tileKey === A.tileKey) lo = mid;
                else hi = mid;
            }
            at(hi, B);
            if (B.clearance <= 0) return bisectHit(t, hi);
            t = hi;
        } else if (B.clearance <= 0) {
            return bisectHit(t, tNext);
        } else {
            t = tNext;
        }
        A.clearance = B.clearance;
        A.tileKey = B.tileKey;
        A.slope = B.slope;
        A.hasDescendants = B.hasDescendants;
    }

    // Step budget exhausted (pathological grazing ray skimming the surface).
    // Do it the exact, slow way instead of guessing.
    return raycastGroundMeshFallback(origin, direction);
}

// Exact mesh-raycast fallback for rays the elevation marcher gives up on —
// same terrain-mesh + local-sphere preference order as raycastLocalGround.
let fallbackRaycaster = null;
function raycastGroundMeshFallback(origin, direction) {
    if (!fallbackRaycaster) {
        fallbackRaycaster = new Raycaster();
        // terrain tile meshes live on the MAIN/LOOK layers, not layer 0
        fallbackRaycaster.layers.mask |= LAYER.MASK_MAIN | LAYER.MASK_LOOK;
    }
    fallbackRaycaster.set(origin, direction);
    fallbackRaycaster.near = 0;
    fallbackRaycaster.far = Infinity;
    const hit = raycastLocalGround(fallbackRaycaster);
    return hit ? hit.point : null;
}
