import {Vector3} from "three";
import {getCelestialDirection} from "./CelestialMath";
import {DebugArrow, intersectEllipsoid, removeDebugArrow} from "./threeExt";
import {setAlwaysVisibleOverlay} from "./AlwaysVisibleOverlay";
import {MASK_WORLD} from "./LayerMasks";

// Each view owns an arrow, visible only during its world render. This keeps
// the other view's arrow out of the scene and of reflection captures.
export class SunGlintArrow {
    constructor(viewID) {
        this.name = `glintSunArrow_${viewID}`;
        this.position = new Vector3();
        this.forward = new Vector3();
        this.arrow = null;
    }

    render(view, camera, scene, date, draw) {
        if (this.arrow) this.arrow.visible = false;
        camera.updateWorldMatrix(true, false);
        camera.getWorldPosition(this.position);
        camera.getWorldDirection(this.forward);
        const hit = intersectEllipsoid(this.position, this.forward);
        if (!hit || !date) return draw();

        // Use the actual Sun, even when the scene's directional light has
        // been reassigned to the Moon for a long exposure.
        const sunDirection = getCelestialDirection("Sun", date, hit);
        if (!sunDirection) return draw();
        const metresPerPixel = view.pixelsToMeters(hit, 1);
        if (!(metresPerPixel > 0)) return draw();

        const length = metresPerPixel * 120;
        this.arrow = DebugArrow(this.name, sunDirection, hit, length, "#ffff00",
            true, scene, 14, MASK_WORLD);
        this.arrow.setLength(length, metresPerPixel * 14, metresPerPixel * 8);
        // The ellipsoid is often below terrain. Keep the exact anchor while
        // making the diagnostic visible over the ground and buildings.
        setAlwaysVisibleOverlay(this.arrow);
        try {
            return draw();
        } finally {
            this.arrow.visible = false;
        }
    }

    dispose() {
        removeDebugArrow(this.name);
        this.arrow = null;
    }
}
