import {Vector3} from "three";
import {NodeMan} from "./Globals";
import {wgs84} from "./LLA-ECEF-ENU";

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
    // Track the nearest concrete-surface hit so a building roof under the
    // cursor beats the terrain behind it.
    let bestPoint = null;
    let bestDist = Infinity;

    if (NodeMan.exists("TerrainModel")) {
        const terrainNode = NodeMan.get("TerrainModel");
        const hit = terrainNode.getClosestIntersect(raycaster);
        if (hit) {
            bestPoint = hit.point;
            bestDist = hit.distance;
        }
    }

    // Google Photorealistic 3D buildings. The tile meshes are on the MAIN/LOOK
    // layers, so temporarily widen the raycaster's layer mask to the camera's
    // before intersecting the shared tiles group, then restore it. firstHitOnly
    // asks the tiles' BVH for just the nearest hit (also faster); it is ignored
    // for non-BVH meshes, where the sorted hits[0] is still the nearest.
    if (camera && NodeMan.exists("buildings3DTiles")) {
        const group = NodeMan.get("buildings3DTiles").group;
        if (group && group.children.length > 0) {
            const savedMask = raycaster.layers.mask;
            const savedFirstHit = raycaster.firstHitOnly;
            raycaster.layers.mask = camera.layers.mask;
            raycaster.firstHitOnly = true;
            const hits = raycaster.intersectObject(group, true);
            raycaster.layers.mask = savedMask;
            raycaster.firstHitOnly = savedFirstHit;
            if (hits.length > 0 && hits[0].distance < bestDist) {
                bestPoint = hits[0].point;
                bestDist = hits[0].distance;
            }
        }
    }

    if (bestPoint) {
        return {point: bestPoint.clone(), isTerrain: true};
    }

    const o = raycaster.ray.origin;
    const camLen = o.length();
    if (camLen < 1) return null;

    const sinLat = o.z / camLen;
    const cosLatSq = 1 - sinLat * sinLat;
    const a = wgs84.RADIUS;
    const b = wgs84.POLAR_RADIUS;
    const groundRadius = 1 / Math.sqrt(cosLatSq / (a * a) + (sinLat * sinLat) / (b * b));

    const d = raycaster.ray.direction;
    const B = o.dot(d);
    const C = camLen * camLen - groundRadius * groundRadius;
    const disc = B * B - C;
    if (disc < 0) return null;

    // Only the near root is meaningful. The far root is the exit on the
    // opposite side of the planet — never a valid ground anchor.
    const t0 = -B - Math.sqrt(disc);
    if (t0 <= 0) return null;

    return {
        point: new Vector3(o.x + d.x * t0, o.y + d.y * t0, o.z + d.z * t0),
        isTerrain: false,
    };
}
