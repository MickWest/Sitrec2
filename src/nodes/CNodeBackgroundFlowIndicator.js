// Dispaly an arrow from an object to a celestial body

import {DebugArrowAB, intersectSurface, removeDebugArrow} from "../threeExt";
import {CNode} from "./CNode";
import {guiShowHide, NodeMan} from "../Globals";
import {convertColorInput} from "../ConvertColorInputs";
import {Raycaster, Vector3} from "three";
import * as LAYER from "../LayerMasks";
import {GlobalScene} from "../LocalFrame";
import {assert} from "../assert";
import {t} from "../i18n";

export class CNodeBackgroundFlowIndicator extends CNode {
    constructor(v) {
        v.color ??= "white";
        v.length ??= 1000;
        super(v);
        convertColorInput(v,"color",this.id)
        this.body = v.body;    // "Sun", "Moon", "Mars", etc
        this.input("length");  // length of arrow
        this.input("color");   // color of arrow
        this.arrowName = "backgroundFlow"

        this.overWater = v.overWater ?? false; // whether to assume over water always

        guiShowHide.add(this, 'visible').onChange( (v) => {
            if (v) {
                this.update(0);
            } else {
                this.remove();
            }
        })
            .name(t("misc.backgroundFlowIndicator.label"))
            .tooltip(t("misc.backgroundFlowIndicator.tooltip"))


    }

    update(f) {
        if (!this.visible) return;

        let cameraLOS = NodeMan.get("JetLOSCameraCenter", false)
        if (!cameraLOS) {
            // legacy sitches, e.g. GoFast, use JetLOS if no JetLOSCameraCenter
            cameraLOS = NodeMan.get("JetLOS", false)
        };
        if (!cameraLOS) return;

        const camera = NodeMan.get("lookCamera", false);
        if (!camera) return;
        //const cameraPos = camera.camera.position.clone();

        // get camera vectors at f and f+1

        const losTrackA = cameraLOS.getValue(f);
        const losTrackB = cameraLOS.getValue(f + 1);

        const losA = losTrackA.heading.clone();
        const losB = losTrackB.heading.clone();

        assert(losA && losB, "No LOS values found");
        assert(typeof losA.clone === "function","Invalid LOS value")

        const cameraPosA = losTrackA.position.clone();
        const cameraPosB = losTrackB.position.clone();

        // The two terrain raycasts below are the single most expensive thing this
        // node does (near-horizontal LOS rays skim across many high-detail terrain
        // tiles). When the frame and camera pose are unchanged from the previous
        // update there is nothing to recompute — the flow arrows are persistent
        // named debug objects, so they remain drawn from the last computation.
        // This eliminates the per-frame raycast churn while the camera is static
        // (the dominant CPU cost when a heavy-terrain sitch just sits loaded).
        const EPS = 1e-6; // squared metres; static ECEF positions compare bit-identical
        if (this._cacheFrame === f
            && this._cachePosA && this._cachePosA.distanceToSquared(cameraPosA) < EPS
            && this._cachePosB && this._cachePosB.distanceToSquared(cameraPosB) < EPS
            && this._cacheLosA && this._cacheLosA.distanceToSquared(losA) < EPS
            && this._cacheLosB && this._cacheLosB.distanceToSquared(losB) < EPS) {
            return;
        }
        this._cacheFrame = f;
        this._cachePosA = (this._cachePosA ?? new Vector3()).copy(cameraPosA);
        this._cachePosB = (this._cachePosB ?? new Vector3()).copy(cameraPosB);
        this._cacheLosA = (this._cacheLosA ?? new Vector3()).copy(losA);
        this._cacheLosB = (this._cacheLosB ?? new Vector3()).copy(losB);

        const rayA = new Raycaster(cameraPosA, losA)
        rayA.layers.mask  |= LAYER.MASK_MAIN | LAYER.MASK_LOOK;

        const rayB = new Raycaster(cameraPosB, losB)
        rayB.layers.mask  |= LAYER.MASK_MAIN | LAYER.MASK_LOOK;


        const terrainNode = NodeMan.get("TerrainModel", false);

        if (!terrainNode) {
            console.warn("CNodeBackgroundFlowIndicator: No TerrainModel node found");
            return;
        }

        // attmpet to get the closest intersecting objects/points on the terrain model

        let obA = terrainNode.getClosestIntersect(rayA, terrainNode);
        let obB = terrainNode.getClosestIntersect(rayB, terrainNode);

        let pointA, pointB;

        // also get closest intersection with the globe
        // and use that if it's close (i.e. over ocean)
        const globeA = intersectSurface(cameraPosA, losA);
        const globeB = intersectSurface(cameraPosB, losB);


        if (obA && obB) {
            pointA = obA.point;
            pointB = obB.point;

            // the actual points on the surface plane
           // DebugSphere("FlowA", pointA, 0.5, "#80FF00", GlobalScene, LAYER.MASK_LOOKRENDER)  // green A
           // DebugSphere("FlowB"+f, pointB, 0.5, "#FF8000", GlobalScene, LAYER.MASK_LOOKRENDER)  // blue B


            // move them 1% closer to cameraPos
            // which will ensure they are not underground/underwater
            pointA.lerp(cameraPosA, 0.01);
            pointB.lerp(cameraPosB, 0.01);

        } else {
            // fallback to two points 10km away from the camera in the LOS directions
            pointA = cameraPosA.clone().add(losA.clone().multiplyScalar(10000))
            pointB = cameraPosB.clone().add(losB.clone().multiplyScalar(10000))
        }

        // use globe points if they are closer than the terrain points
        if (globeA) {
            const distGlobeA = globeA.distanceTo(cameraPosA);
            const distPointA = pointA.distanceTo(cameraPosA);
            if (distGlobeA < distPointA) {
                pointA = globeA;
            }
        }

        if (globeB) {
            const distGlobeB = globeB.distanceTo(cameraPosB);
            const distPointB = pointB.distanceTo(cameraPosB);
            if (distGlobeB < distPointB) {
                pointB = globeB;
            }
        }

        // and finally, if overWater is set, just use the globe points
        if (this.overWater) {
            if (globeA) pointA = globeA;
            if (globeB) pointB = globeB;
        }

        const AtoB = new Vector3().subVectors(pointB, pointA);


        DebugArrowAB(this.arrowName+"TO_A", pointA, cameraPosA, "#FF00FF",
            true, GlobalScene, 20, LAYER.MASK_LOOKRENDER);


        DebugArrowAB(this.arrowName+"20", pointA, pointA.clone().add(AtoB.clone().multiplyScalar(20)), "#a0a0a0",       true, GlobalScene, 20, LAYER.MASK_LOOKRENDER);
        DebugArrowAB(this.arrowName,      pointA, pointA.clone().add(AtoB.clone().multiplyScalar(1)), this.in.color.v0, true, GlobalScene, 20, LAYER.MASK_LOOKRENDER);
    }


    remove() {
        removeDebugArrow(this.arrowName)
        removeDebugArrow(this.arrowName+"20")
        // Invalidate the raycast cache so a later show() recomputes and redraws
        // the arrows instead of early-returning on an unchanged camera pose.
        this._cacheFrame = undefined;
    }

    dispose() {
        this.remove();
        super.dispose();
    }


}