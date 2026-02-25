import {makeMatLine} from "../MatLines";
import {dispose, intersectMSL} from "../threeExt";
import {metersFromMiles, radians} from "../utils";
import {CNode3DGroup} from "./CNode3DGroup";
import {LineGeometry} from "three/addons/lines/LineGeometry.js";
import {Line2} from "three/addons/lines/Line2.js";
import * as LAYER from "../LayerMasks";
import {getLocalUpVector} from "../SphericalMath";
import {guiShowHide, setRenderOne, Sit} from "../Globals";
import {Vector3} from "three";

export class CNodeGimbalTriangulate extends CNode3DGroup {
    constructor(v) {
        v.layers ??= LAYER.MASK_HELPERS;
        super(v);

        this.input("LOS");
        this.angleOffset = v.angleOffset ?? 3.7;
        this.LOSLengthMiles = v.LOSLength ?? 400;
        this.clipSeaLevel = v.clipSeaLevel ?? true;

        this.blueMaterial = makeMatLine(0x0080ff, v.width ?? 2);
        this.orangeMaterial = makeMatLine(0xff8000, v.width ?? 2);
        this.magentaMaterial = makeMatLine(0xff00ff, v.width ?? 2);
        this.redMaterial = makeMatLine(0xff0000, v.width ?? 2);
        this.whiteMaterial = makeMatLine(0xffffff, v.width ?? 3);

        this.lines = [];

        this.recalculate();
        this.showHider("Zaine Triangulation");
        this.show(false);

        guiShowHide.add(this, "angleOffset", 2, 5, 0.001).name("Angular Traverse").onChange(() => {
            this.recalculate();
            setRenderOne(true);
        });
    }

    recalculate() {
        this.lines.forEach(item => {
            this.group.remove(item.line);
            dispose(item.geometry);
        });
        this.lines = [];

        const frames = this.in.LOS.frames;
        if (frames < 2) return;

        const firstFrame = Sit.aFrame ?? 0;
        const lastFrame = Sit.bFrame ?? (frames - 1);

        const line1 = this.getLineData(firstFrame, 0);
        const line2 = this.getLineData(lastFrame, 0);
        const line3 = this.getLineData(firstFrame, this.angleOffset);
        const line4 = this.getLineData(lastFrame, -this.angleOffset);

        this.addLine(line1.start, line1.end, this.blueMaterial);
        this.addLine(line2.start, line2.end, this.orangeMaterial);
        this.addLine(line3.start, line3.end, this.magentaMaterial);
        this.addLine(line4.start, line4.end, this.redMaterial);

        const pointA = this.closestPointBetweenLines(line1.start, line1.dir, line4.start, line4.dir);
        const pointB = this.closestPointBetweenLines(line2.start, line2.dir, line3.start, line3.dir);

        if (pointA && pointB) {
            this.addLine(pointA, pointB, this.whiteMaterial);
        }

        this.propagateLayerMask();
    }

    getLineData(frame, angleDegrees) {
        const los = this.in.LOS.v(frame);
        const start = los.position.clone();
        const dir = los.heading.clone();

        if (angleDegrees !== 0) {
            const upAxis = getLocalUpVector(start);
            dir.applyAxisAngle(upAxis, radians(angleDegrees));
        }

        const scale = metersFromMiles(this.LOSLengthMiles);
        const fwd = dir.clone().multiplyScalar(scale);
        let end = start.clone().add(fwd);

        if (this.clipSeaLevel && fwd.dot(getLocalUpVector(start)) < 0) {
            const seaLevelPoint = intersectMSL(start, fwd);
            if (seaLevelPoint) {
                end = seaLevelPoint;
            }
        }

        return {start, end, dir};
    }

    addLine(A, B, material) {
        const mid = A.clone().add(B).multiplyScalar(0.5);
        const localA = A.clone().sub(mid);
        const localB = B.clone().sub(mid);

        const lineOb = {};
        lineOb.geometry = new LineGeometry();
        lineOb.geometry.setPositions([localA.x, localA.y, localA.z, localB.x, localB.y, localB.z]);
        lineOb.line = new Line2(lineOb.geometry, material);
        lineOb.line.position.set(mid.x, mid.y, mid.z);

        this.lines.push(lineOb);
        this.group.add(lineOb.line);
    }

    closestPointBetweenLines(p1, d1, p2, d2) {
        const w0 = new Vector3().subVectors(p1, p2);
        const a = d1.dot(d1);
        const b = d1.dot(d2);
        const c = d2.dot(d2);
        const d = d1.dot(w0);
        const e = d2.dot(w0);

        const denom = a * c - b * b;
        if (Math.abs(denom) < 1e-10) return null;

        const s = (b * e - c * d) / denom;
        const t = (a * e - b * d) / denom;

        const point1 = p1.clone().add(d1.clone().multiplyScalar(s));
        const point2 = p2.clone().add(d2.clone().multiplyScalar(t));

        return point1.add(point2).multiplyScalar(0.5);
    }
}
