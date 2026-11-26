// The ground under a point when 3D tiles are on screen.
//
// Each view has its own tile renderer, and each renderer has its own level of detail.
// A ray that goes straight down therefore meets one surface for each view, and the
// surfaces can be a metre apart. Two rules keep a point that is "above ground level"
// in one place:
//
//   1. pickGroundHit. Of the hits that can be ground, take the hit on the most
//      detailed tile. The earlier rule was "the hit nearest to the elevation map".
//      That rule is a test of plausibility, not of quality: between two good surfaces
//      it chose by accident, so the zoom of one view moved a camera that another
//      view showed.
//
//   2. GroundAnchorRegion. A load region that makes a renderer load its most detailed
//      tile in one vertical column, whatever its cameras show. The tile under a camera
//      that looks at the horizon is outside that camera's view, so no view asks for
//      it. With the region the most detailed tile is always there to pick, and the
//      height does not depend on where the views looked before.

import {Ray, Sphere} from "three";

// The detail of a tile is its geometric error in metres: a smaller value is finer.
// A tile renderer writes it in the userData of the root object of each tile it loads.
export const TILE_DETAIL_KEY = "tileGeometricError";

/**
 * The detail of the tile that an object belongs to.
 * @param {Object3D} object any object inside a loaded tile
 * @returns {number|undefined} geometric error in metres, or undefined when no parent has it
 */
export function tileDetailOf(object) {
    for (let node = object; node; node = node.parent) {
        const detail = node.userData?.[TILE_DETAIL_KEY];
        if (detail !== undefined) return detail;
    }
    return undefined;
}

/**
 * Which hit of a straight-down ray is the ground?
 *
 * A hit farther than `tolerance` from the elevation-map ground is not ground (a coarse
 * tile that is still streaming can be kilometres off). Of the others, the hit on the
 * most detailed tile wins. Hits of equal detail, and hits whose detail is not known,
 * go by distance from the elevation-map ground.
 *
 * @param {number} count number of hits
 * @param {function(number): number} heightOf height of hit i along the local up vector, metres
 * @param {function(number): (number|undefined)} detailOf geometric error of the tile of hit i, metres
 * @param {number} referenceHeight height of the elevation-map ground on the same axis, metres
 * @param {number} tolerance metres
 * @returns {number} the index of the hit, or -1 when no hit can be ground
 */
export function pickGroundHit(count, heightOf, detailOf, referenceHeight, tolerance) {
    let best = -1;
    let bestDetail = Infinity;
    let bestOffset = Infinity;
    for (let hitIndex = 0; hitIndex < count; hitIndex++) {
        const offset = Math.abs(heightOf(hitIndex) - referenceHeight);
        if (offset > tolerance) continue;
        const detail = detailOf(hitIndex) ?? Infinity;
        if (detail < bestDetail || (detail === bestDetail && offset < bestOffset)) {
            best = hitIndex;
            bestDetail = detail;
            bestOffset = offset;
        }
    }
    return best;
}

/**
 * Does anything that is shown read this node now?
 *
 * It follows the outputs of the node, and it goes through a switch only when the switch
 * has that input selected. A node with no outputs is the end of a chain (a view, a
 * controller, a display), so the chain to it is in use. Example: with the camera on a
 * loaded track, the Manual camera position feeds the position switch and the flight
 * simulator, and neither is selected, so nothing that is shown reads it.
 *
 * @param {{outputs: Array}} node a node of the graph
 * @returns {boolean}
 */
export function isLiveSource(node) {
    const seen = new Set();
    const live = current => {
        if (seen.has(current)) return false;
        seen.add(current);
        if (current.outputs.length === 0) return true;
        for (const output of current.outputs) {
            const isSwitch = output.choice !== undefined && typeof output.selectOption === "function";
            if (isSwitch && output.inputs[output.choice] !== current) continue;
            if (live(output)) return true;
        }
        return false;
    };
    return live(node);
}

/**
 * A load region for one vertical column of ground, for the LoadRegionPlugin of
 * 3d-tiles-renderer. The plugin reads `mask` and calls the three methods below; it
 * does not need a base class.
 *
 * A tile is in the region when the vertical line through `point` goes through its
 * bounding volume within `reach` metres of the point. The error target is zero, so the
 * renderer refines the column down to its last tile.
 *
 * `point` and `up` are in the frame of the tile renderer's group.
 */
export class GroundAnchorRegion {
    constructor(point, up, reach) {
        // Not a mask: the region adds to what the cameras ask for, and hides nothing.
        this.mask = false;
        this.errorTarget = 0;
        this.sphere = new Sphere(point.clone(), reach);
        this.ray = new Ray();
        this.setColumn(point, up);
    }

    setColumn(point, up) {
        this.sphere.center.copy(point);
        this.ray.origin.copy(point).addScaledVector(up, this.sphere.radius);
        this.ray.direction.copy(up).negate();
    }

    intersectsTile(boundingVolume) {
        return boundingVolume.intersectsSphere(this.sphere) && boundingVolume.intersectsRay(this.ray);
    }

    // Small distances load first, so the column loads before the far field.
    calculateDistance(boundingVolume) {
        return boundingVolume.distanceToPoint(this.sphere.center);
    }

    // The library refines a tile while this value is more than the renderer's own
    // target. With an error target of zero that is every tile but the last.
    calculateError(tile, tilesRenderer) {
        return tile.geometricError - this.errorTarget + tilesRenderer.errorTarget;
    }
}
