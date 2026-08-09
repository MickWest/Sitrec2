// Surface picking for "Fit Camera to Points": where a ray, or a view pixel, meets the world, and
// where a world point lands on screen.
//
// These functions began life in FitPointHandles3D.js, which also defines the handle
// overlay VIEWS. That placement made them unimportable from anywhere outside the view
// graph: CSitrecAPI imports them for the pickWorldPoint API, and importing the overlay
// module from there closed an import cycle through CNodeViewUI that only Jest's module
// loader trips over — `class CFitHandleOverlay extends CNodeViewUI` evaluated while
// CNodeViewUI was still mid-initialisation. Pure geometry in a leaf module has no such
// problem, so the geometry lives here and the views import it.
//
// projectToCanvas belongs here for the same reason and one more: it is the INVERSE of
// groundUnderCanvasPoint, which needs it — a refracted scene cannot be picked by casting one ray,
// only by casting and checking where the result actually landed. Leaving the two in separate
// modules would have put the cycle straight back.

import {Raycaster, Vector3} from "three";
import {NodeMan} from "./Globals";
import {renderedRect, withDisplayedCamera} from "./ViewUtils";
import {ellipsoidAlongRay, raycastGroundElevationFast} from "./raycastGround";
import {liftWorldPoint} from "./atmosphere/terrestrialRefraction";
import {currentTerrestrialLiftContext} from "./atmosphere/refractionSettings";

/** How far a drag ray will look for ground before giving up. */
const MAX_GROUND_RANGE = 400000;

/**
 * Where a ray meets the world — the elevation surface, or the actual 3D geometry.
 *
 * Two genuinely different answers, which is why it is a choice rather than a default.
 *
 * The elevation map is a smooth height field. It is fast, it covers the whole planet at some zoom,
 * and it is the right surface for a landmark that IS the ground: a river bend, a shoreline, a
 * track. But it has no buildings on it, so a rooftop corner placed against it lands at street
 * level, tens of metres from the thing being pointed at — an error that matters enormously at
 * short range and is invisible at long range.
 *
 * The 3D tiles are the geometry actually on screen: roofs, walls, even trees. Placing against them
 * is what makes a close-range fit possible at all, because at those scales the recognisable
 * features are all things standing UP off the ground rather than marks on it.
 *
 * With tiles selected the order is STRICT PRIORITY — tiles, then elevation, then the ellipsoid —
 * and NOT raycastLocalGround's "nearest concrete surface". That distinction is the whole point.
 * The elevation surface can sit tens of metres ABOVE the tile geometry (raycastGround says so in
 * its own comments, and it is why the shared function skips a HIDDEN basemap entirely), so with
 * the basemap visible and 3D tiles on, "nearest" hands back the invisible height field draped over
 * the building the user is aiming at. Asking for the building and silently getting the terrain in
 * front of it is exactly the error this option exists to remove. Nearest is still right for orbit
 * and pan anchors, which want whatever is visibly frontmost, so that function is left alone.
 *
 * @param {boolean} useTiles
 * @param {object}  camera  needed for the tiles pass — the tile meshes are on the MAIN/LOOK
 *                          layers, so the raycaster has to borrow a camera's layer mask
 * @returns {Vector3|null}
 */
export function surfaceAlongRay(origin, direction, useTiles, camera) {
    const dir = direction.clone().normalize();
    if (!useTiles) return raycastGroundElevationFast(origin, dir, MAX_GROUND_RANGE);

    // 1. The 3D geometry, if any is loaded under this ray.
    if (camera && NodeMan.exists("buildings3DTiles")) {
        const group = NodeMan.get("buildings3DTiles").group;
        if (group && group.children.length > 0) {
            const raycaster = new Raycaster(origin.clone(), dir);
            raycaster.far = MAX_GROUND_RANGE;
            raycaster.layers.mask = camera.layers.mask;
            // firstHitOnly asks the tiles' BVH for just the nearest hit, and is ignored by
            // non-BVH meshes where the sorted hits[0] is the nearest anyway.
            raycaster.firstHitOnly = true;
            const hits = raycaster.intersectObject(group, true);
            if (hits.length > 0) return hits[0].point.clone();
        }
    }

    // 2. The elevation surface. The fast height-field march, not the terrain MESH: the mesh has no
    //    BVH and costs about a millisecond a ray, which a drag cannot afford at one ray per frame.
    const elevation = raycastGroundElevationFast(origin, dir, MAX_GROUND_RANGE);
    if (elevation !== null) return elevation;

    // 3. The ellipsoid, so a ray that reaches neither — outside tile coverage, or before the
    //    elevation has streamed in — still lands somewhere defensible instead of nowhere. Returns
    //    null for a ray heading away from the local ground, so looking at the sky still misses.
    return ellipsoidAlongRay(origin, dir);
}

/**
 * World position -> canvas pixels for a view, or null when it is not in front of the camera.
 *
 * Projects where the render PUTS the point, not where its geometry is. Those differ by the
 * terrestrial refraction lift, which the solid scene gets in the vertex shader and a bare
 * projection does not — nothing at 1 km, 57 px of a 393 px pane on a 38 km sightline from 13 km
 * up. A marker placed on a landmark and drawn at the unlifted projection therefore sat well off
 * the landmark in the look view while being exactly on it in the main view, and slid whenever
 * the camera range changed. See the CPU twin's header in atmosphere/terrestrialRefraction.js.
 *
 * With refraction off the context is null and this reduces to the plain projection exactly.
 */
export function projectToCanvas(view, world) {
    if (!view || !view.camera || !(view.widthPx > 0)) return null;
    return withDisplayedCamera(view, (cam) => {
        // Through matrixWorld, matching updateTerrestrialRefractionUniforms — the observer the
        // shader bends about is the camera's WORLD position, not its local one.
        const eye = new Vector3().setFromMatrixPosition(cam.matrixWorld);
        const apparent = liftWorldPoint(currentTerrestrialLiftContext(eye), world, new Vector3());
        const fwd = new Vector3();
        cam.getWorldDirection(fwd);
        if (apparent.clone().sub(eye).dot(fwd) <= 0) return null;   // behind the camera
        const ndc = apparent.project(cam);
        if (!Number.isFinite(ndc.x) || !Number.isFinite(ndc.y)) return null;
        const r = renderedRect(view, view.widthPx, view.heightPx);
        return [r.x + (ndc.x + 1) * 0.5 * r.w, r.y + (1 - ndc.y) * 0.5 * r.h];
    });
}

/** The surface the GEOMETRIC ray through a canvas pixel meets, or null if it meets none. */
function surfaceUnderCanvasRay(view, r, cx, cy, useTiles) {
    const ray = withDisplayedCamera(view, (cam) => {
        const ndcX = ((cx - r.x) / r.w) * 2 - 1;
        const ndcY = -(((cy - r.y) / r.h) * 2 - 1);
        const origin = new Vector3().setFromMatrixPosition(cam.matrixWorld);
        const dir = new Vector3(ndcX, ndcY, 0.5).unproject(cam).sub(origin).normalize();
        return {origin, dir};
    });
    if (!ray || !Number.isFinite(ray.dir.x)) return null;
    // view.camera, not the LOD-prepared one: prepareCameraForLOD changes fov, aspect and offsets
    // but never the layer mask, which is the only thing the tiles pass reads.
    return surfaceAlongRay(ray.origin, ray.dir, useTiles, view.camera);
}

/** Movement below this many canvas pixels counts as landing on the cursor. */
const PICK_TOLERANCE = 0.25;
/** Refraction is smooth and small; three corrections is far more than it ever needs. */
const PICK_ITERATIONS = 4;

/**
 * Canvas pixels -> the surface point under them, or null if the ray never reaches one.
 *
 * "Under them" means under them ON SCREEN, which is not the same as along the geometric ray once
 * the scene is refracted: the render lofts the ground, so the surface the user is pointing at is
 * BELOW the geometric ray by the bend. Casting the geometric ray and stopping would hand back a
 * point tens of metres from the one they clicked on — and, worse, a point that then draws
 * somewhere else again, so a dragged handle would never settle under the cursor. The same is true
 * of the pickWorldPoint API, which reads a pixel straight off a screenshot: the pixel it is given
 * is a pixel of the REFRACTED render.
 *
 * Solved by iteration rather than by inverting the lift: the lift depends on the range, the range
 * depends on where the ray lands, and the surface is a raycast against terrain or tile geometry
 * with no closed form anyway. Aim, see where that lands on screen, and aim off by the error. The
 * correction is a fraction of a degree and the map is a contraction, so it settles in one or two
 * passes; the loop is bounded regardless.
 *
 * With refraction off the first pass lands exactly on the cursor and the loop exits immediately,
 * leaving the original single-cast behaviour untouched.
 */
export function groundUnderCanvasPoint(view, cx, cy, useTiles = false) {
    if (!view || !view.camera || !(view.widthPx > 0)) return null;
    const r = renderedRect(view, view.widthPx, view.heightPx);
    if (!(r.w > 0) || !(r.h > 0)) return null;

    let aimX = cx, aimY = cy;
    let found = null;
    for (let i = 0; i < PICK_ITERATIONS; i++) {
        const hit = surfaceUnderCanvasRay(view, r, aimX, aimY, useTiles);
        // Aimed off the world (into the sky, past the horizon): keep the last real surface
        // rather than throwing away a good answer because a correction overshot.
        if (!hit) return found;
        found = hit;
        const at = projectToCanvas(view, hit);
        if (at === null) return found;
        const ex = cx - at[0], ey = cy - at[1];
        if (Math.hypot(ex, ey) < PICK_TOLERANCE) break;
        aimX += ex;
        aimY += ey;
    }
    return found;
}
