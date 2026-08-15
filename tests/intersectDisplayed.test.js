// intersectDisplayed() is the pick used wherever a ray means "what is the user
// looking at". The cases below are the two ways the obvious implementation gets
// it wrong, both of which shipped at some point:
//
//   1. raycaster.intersectObject(group, true) ignores .visible, so a tile the
//      renderer has stopped drawing still wins the pick. Over Torrance a hidden
//      coarse LOD sat 1.6 km above the airport and the zoom anchor latched onto
//      it, leaving the camera unable to descend past a point in mid-air.
//   2. A walk that prunes .visible but still calls object.raycast() on every
//      node re-enters 3DTilesRenderer's TilesGroup.raycast override, whose own
//      recursive descent does NOT prune — putting every hidden tile straight
//      back. That is why only geometry-bearing leaves are raycast.
//
// The throwing container below is the regression lock for (2): if anyone
// "simplifies" the walk back to calling raycast() on containers, it throws.

import {Group, Mesh, MeshBasicMaterial, Object3D, PlaneGeometry, Raycaster, Vector3} from "three";
import {intersectDisplayed} from "../src/raycastGround";

/**
 * A plane squarely across the ray at distance `d` down -Z. Its default normal is
 * +Z, so the ray meets its front face and yields exactly ONE hit at exactly d —
 * a closed solid would give two (entry and exit) and blur the assertions.
 */
function wallAt(d) {
    const mesh = new Mesh(new PlaneGeometry(4, 4), new MeshBasicMaterial());
    mesh.position.set(0, 0, -d);
    return mesh;
}

/** Stands in for TilesRenderer.TilesGroup: a container with its own raycast(). */
class ThrowingContainer extends Object3D {
    raycast() {
        throw new Error("container raycast() must never be called");
    }
}

function buildScene() {
    const root = new Group();

    // Nearest of all, but on a layer the raycaster does not test.
    const wrongLayer = wallAt(5);
    wrongLayer.layers.set(5);
    root.add(wrongLayer);

    // Nearest testable hit, but its parent is not being drawn.
    const hiddenGroup = new Group();
    hiddenGroup.visible = false;
    hiddenGroup.add(wallAt(10));
    root.add(hiddenGroup);

    // Inside a container that would throw if we delegated to its raycast().
    // Finding this proves the walk recurses itself instead.
    const container = new ThrowingContainer();
    container.add(wallAt(30));
    root.add(container);

    root.add(wallAt(50));

    root.updateMatrixWorld(true);
    return root;
}

/**
 * Straight down -Z, but offset off the plane's centre. A PlaneGeometry is two
 * triangles sharing a diagonal, and a ray down the exact centre crosses that
 * shared edge and registers a hit on BOTH — one wall would look like two. The
 * offset stays clear of the diagonal (y = ±x) and, since the ray is parallel to
 * Z and the walls are perpendicular to it, every distance is still exactly d.
 */
function downRay() {
    const raycaster = new Raycaster(new Vector3(0.7, 0.3, 0), new Vector3(0, 0, -1));
    raycaster.layers.set(0);
    return raycaster;
}

describe("intersectDisplayed", () => {
    test("skips hidden subtrees and layer-mismatched geometry, nearest first", () => {
        const hits = intersectDisplayed(buildScene(), downRay());

        // 5 (wrong layer) and 10 (hidden ancestor) must not appear.
        expect(hits.map(h => Math.round(h.distance))).toEqual([30, 50]);
    });

    test("never calls a container's own raycast, but still finds geometry inside it", () => {
        const hits = intersectDisplayed(buildScene(), downRay());

        // Reaching the wall at 30 means we descended through the container
        // ourselves rather than handing the subtree to its raycast().
        expect(hits[0].distance).toBeCloseTo(30, 6);
    });

    test("the naive recursive intersect is what this function exists to avoid", () => {
        // Documents the trap rather than testing our code: Three.js calls
        // raycast() on every node, container included.
        expect(() => downRay().intersectObject(buildScene(), true)).toThrow();
    });

    test("a hidden leaf is skipped even when its own visible flag is true", () => {
        // The real case: 3DTilesRenderer hides a tile by clearing visible on the
        // tile's scene root, never on the mesh, and every hidden tile measured in
        // the live page was hidden exactly that way.
        const root = new Group();
        const hiddenParent = new Group();
        hiddenParent.visible = false;
        const leaf = wallAt(10);
        expect(leaf.visible).toBe(true);
        hiddenParent.add(leaf);
        root.add(hiddenParent);
        root.add(wallAt(50));
        root.updateMatrixWorld(true);

        const hits = intersectDisplayed(root, downRay());
        expect(hits.map(h => Math.round(h.distance))).toEqual([50]);
    });

    test("returns an empty array when nothing displayed is in the way", () => {
        const root = new Group();
        const hiddenParent = new Group();
        hiddenParent.visible = false;
        hiddenParent.add(wallAt(10));
        root.add(hiddenParent);
        root.updateMatrixWorld(true);

        expect(intersectDisplayed(root, downRay())).toEqual([]);
    });
});
