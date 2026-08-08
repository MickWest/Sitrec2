// The sight lines of "Fit Camera to Points": one line from the camera to each ground point.
//
// What the fit asserts, drawn in the world instead of argued in pixels. Every control-point pair
// says its ground point lies on the sight line through its video point; the camera is wherever ALL
// of those lines can be satisfied at once. Two pairs leave a whole family of cameras, enough of
// them leave one, and seeing the lines converge on a single apex is that statement made visible.
//
// The line runs camera -> GROUND point, and the video point is marked separately where it falls on
// the video hanging in the frustum. So a correct camera draws each line straight through its own
// marker, and any gap between the two is that point's reprojection residual — the same number the
// video overlay prints in pixels, here at the scale and direction it has in the scene.
//
// Real scene geometry rather than lines drawn on an overlay, so terrain occludes them the way it
// occludes the camera frustum: a sight line that disappears into a ridge and comes out the far side
// is telling you something true about where that landmark is.

import {Group, Vector3} from "three";
import {LineSegmentsGeometry} from "three/addons/lines/LineSegmentsGeometry.js";
import {Line2} from "three/addons/lines/Line2.js";
import {disposeMatLine, makeMatLine} from "./MatLines";
import {GlobalScene} from "./LocalFrame";
import {dispose} from "./threeExt";
import * as LAYER from "./LayerMasks";

/** Matches the camera frustum these lines emanate from. */
const LINE_WIDTH = 1.5;

export class FitPointSightLines3D {
    /** @param {Function} getDisplay () => {origin: Vector3, points: [{color, ground}]} | null */
    constructor(getDisplay) {
        this.getDisplay = getDisplay;
        this.enabled = false;
        this.lines = [];
        this.signature = null;

        // Positions are stored RELATIVE to this group, which sits at the camera. Line2 packs its
        // vertices into a float32 buffer, and the world frame is ECEF — absolute coordinates are
        // ~6.4e6, where float32 steps in units of about half a metre and every line would visibly
        // crawl. Held relative to an origin the group carries in JS doubles, the largest number the
        // GPU ever sees is the range to the landmark, and the quantisation is millimetres.
        this.group = new Group();
        this.group.layers.mask = LAYER.MASK_HELPERS;
        this.group.visible = false;
        GlobalScene.add(this.group);
    }

    setEnabled(on) {
        this.enabled = on;
        if (!on) this.clear();
    }

    /**
     * Rebuild the lines if anything about them changed.
     *
     * Called every frame, so the guard matters: LineSegmentsGeometry.setPositions allocates a fresh
     * instanced buffer on every call, and rebuilding seven of those per frame is churn for nothing
     * in the overwhelmingly common case where the camera and the points are both sitting still.
     */
    update() {
        const display = this.enabled ? this.getDisplay() : null;
        if (display === null) {
            if (this.signature !== null) this.clear();
            return;
        }

        const signature = signatureOf(display);
        if (signature === this.signature) return;
        this.signature = signature;

        this.clear(true);
        this.group.position.copy(display.origin);
        this.group.updateMatrix();
        this.group.updateMatrixWorld();
        this.group.visible = true;

        for (const p of display.points) {
            const g = new Vector3().subVectors(p.ground, display.origin);
            const geometry = new LineSegmentsGeometry();
            geometry.setPositions([0, 0, 0, g.x, g.y, g.z]);
            const line = new Line2(geometry, makeMatLine(p.color, LINE_WIDTH));
            line.layers.mask = this.group.layers.mask;
            this.group.add(line);
            this.lines.push(line);
        }
    }

    /** @param {boolean} keepSignature true while rebuilding, so update() does not undo its own key */
    clear(keepSignature = false) {
        for (const line of this.lines) {
            this.group.remove(line);
            dispose(line.geometry);
            disposeMatLine(line.material);
        }
        this.lines = [];
        this.group.visible = false;
        if (!keepSignature) this.signature = null;
    }

    dispose() {
        this.clear();
        GlobalScene.remove(this.group);
    }
}

/**
 * A cheap key for "would this rebuild produce the same lines".
 *
 * Metre resolution on the endpoints: below that the change is smaller than a line is wide at any
 * range these are drawn over, so redrawing would cost a buffer upload to move nothing.
 */
function signatureOf(display) {
    const o = display.origin;
    let s = `${o.x.toFixed(0)},${o.y.toFixed(0)},${o.z.toFixed(0)}`;
    for (const p of display.points) {
        s += `|${p.color},${p.ground.x.toFixed(0)},${p.ground.y.toFixed(0)},${p.ground.z.toFixed(0)}`;
    }
    return s;
}
