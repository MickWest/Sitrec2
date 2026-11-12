import {BufferGeometry, Float32BufferAttribute} from "three";
import {CNode3DGroup} from "./CNode3DGroup";
import {SceneLine} from "../SceneLines";
import {SceneLineMaterial} from "../SceneLineMaterial";
import * as LAYER from "../LayerMasks";

// Draws a kite's flying line at the current frame, from the anchor to the kite,
// with its sag. The points come from the kite track (CNodeKiteTrack).
export class CNodeDisplayKiteLine extends CNode3DGroup {
    constructor(v) {
        v.layers ??= LAYER.MASK_HELPERS;
        super(v);
        this.input("track");
        this.color = v.color ?? 0xe8e8e8;
        this.line = null;
        this._drawn = null;
    }

    update(f) {
        super.update(f);
        const track = this.in.track;
        const drawn = `${Math.round(f)}|${track.bakeSerial}`;
        if (drawn === this._drawn) return;
        this._drawn = drawn;
        const points = track.linePointsAt(f);
        if (points.length < 2) {
            if (this.line) this.line.visible = false;
            return;
        }
        if (!this.line || this.line.sourceGeometry.getAttribute("position").count !== points.length) {
            this.disposeLine();
            const geometry = new BufferGeometry();
            geometry.setAttribute("position", new Float32BufferAttribute(new Float32Array(points.length * 3), 3));
            this.line = new SceneLine(geometry, new SceneLineMaterial({color: this.color, linewidth: 1, toneMapped: false}));
            this.group.add(this.line);
            this.propagateLayerMask();
        }
        // The points are drawn relative to the anchor, so they stay in float32 range:
        // ECEF coordinates are about 6,378 km from the origin.
        const anchor = points[0], positions = this.line.sourceGeometry.getAttribute("position");
        this.line.position.copy(anchor);
        points.forEach((point, index) => positions.setXYZ(index, point.x - anchor.x, point.y - anchor.y, point.z - anchor.z));
        this.line.syncGeometry();
        this.line.visible = true;
    }

    disposeLine() {
        if (!this.line) return;
        this.group.remove(this.line);
        this.line.geometry.dispose();
        this.line.sourceGeometry.dispose();
        this.line.material.dispose();
        this.line = null;
    }

    dispose() {
        this.disposeLine();
        super.dispose();
    }
}
