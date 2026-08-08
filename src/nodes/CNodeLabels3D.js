// 3D labels (and other text that exists in 3D)
// Uses the 2D canvas overlay system (CNodeDisplaySkyOverlay) for rendering

import * as LAYER from "../LayerMasks";
import {
    DebugArrowAB, DebugArrows, getTilesPointBelow, isVisible, propagateLayerMaskObject,
    removeDebugArrow, setLayerMaskRecursive,
} from "../threeExt";
import {pointOnSphereBelow} from "../SphericalMath";
import {CNodeMunge} from "./CNodeMunge";
import {Globals, guiShowHide, NodeMan, setRenderOne, Units} from "../Globals";
import {CNode3DGroup} from "./CNode3DGroup";
import {par} from "../par";
import {ECEFToLLAVD_radii, LLAToECEF} from "../LLA-ECEF-ENU";
import {meanSeaLevelOffset} from "../EGM96Geoid";

import {assert} from "../assert";
import {V2, V3} from "../threeUtils";
import {EventManager} from "../CEventManager";
import {registerLabel3D, unregisterLabel3D} from "./CNodeDisplaySkyOverlay";
import {t} from "../i18n";


const HIGH_ALTITUDE_LABEL_THRESHOLD_M = 100000 * 0.3048;
const HIGH_ALTITUDE_LABEL_DECIMALS = 2;

export const measurementUIVars = {
}

// global flags to show/hide all measurements, one per 3D view
let measurementUIDdone = false;
let measureArrowGroupNode = null;
let measureDistanceGroupNode = null;

let labelsGroupNode = null;
let labelsControllerMain = null;
let labelsControllerLook = null;

let featuresGroupNode = null;
let featuresControllerMain = null;
let featuresControllerLook = null;

/**
 * Which views measurements are drawn in, as a layer mask.
 *
 * MASK_HELPERS for the main view rather than MASK_MAIN, because MASK_HELPERS is what measurements
 * have always used and is exactly what "the main view, never the recreation" means here — so main
 * on / look off reproduces the old single-flag behaviour bit for bit.
 *
 * The main-view flag keeps its original name, `showMeasurements`, rather than gaining a "Main"
 * suffix to match the label. It is written into every saved sitch (see globalsNeeded in
 * CustomManagerSerialize), and renaming it would silently turn measurements back ON in every sitch
 * that was saved with them off.
 */
export function measurementLayerMask() {
    let mask = 0;
    if (Globals.showMeasurements ?? true) mask |= LAYER.MASK_HELPERS;
    if (Globals.showMeasurementsLook) mask |= LAYER.MASK_LOOK;
    return mask;
}

/**
 * Point every existing measurement at the views the toggles now name.
 *
 * The group flag stays the master switch as well as the mask, because CNodeMeasureAB.update()
 * early-outs on it — a measurement hidden in both views then stops recomputing, and
 * CNodeMeasureAltitude's ground point is a terrain raycast that is not worth running for nothing.
 */
export function refreshMeasurementVisibility() {
    const mask = measurementLayerMask();
    const anyView = mask !== 0;
    NodeMan.iterate((key, node) => {
        if (!node.isMeasurement) return;
        node.group.visible = anyView;
        if (node.layerMask !== undefined) node.layerMask = mask;
        // DebugArrow applies a layer mask only when it CREATES the arrow — later calls under the
        // same name leave the layers alone — so arrows already in the scene have to be re-layered
        // here. Waiting for the next update() would never fix them.
        setLayerMaskRecursive(node.group, mask);
    })
}

function altitudeMSLFromECEF(pos) {
    const lla = ECEFToLLAVD_radii(pos);
    return lla.z - meanSeaLevelOffset(lla.x, lla.y);
}


// adds a new group for measurements, and a GUI controller to toggle it.
export function setupMeasurementUI() {
    if (measurementUIDdone) return;
    measurementUIDdone = true;

    // Measurement roots are created during startup before setupFunctions()
    // initializes Globals.showMeasurements. Default to visible so the roots
    // don't get stuck hidden until the UI toggle is touched later.
    Globals.showMeasurements ??= true;
    // Off by default in the look view, matching labels and features: the look view is the
    // recreation, and measurement arrows drawn across it are exactly what "not in the recreation"
    // was protecting. This is also what makes the new toggle a no-op for every existing sitch.
    Globals.showMeasurementsLook ??= false;

    // We create a group node to hold all the measurement arrows
    measureArrowGroupNode = new CNode3DGroup({
        id: "MeasurementsGroupNode",
        layers: LAYER.MASK_MAINRENDER | LAYER.MASK_LOOKRENDER,
    });
    measureArrowGroupNode.isMeasurement = true

    labelsGroupNode = new CNode3DGroup({id: "LabelsGroupNode"});

    featuresGroupNode = new CNode3DGroup({id: "FeaturesGroupNode"});

    measureDistanceGroupNode = new CNode3DGroup({
        id: "MeasureDistanceGroupNode",
        layers: LAYER.MASK_MAINRENDER | LAYER.MASK_LOOKRENDER,
    });
    measureDistanceGroupNode.isMeasurement = true;



//    console.warn("%%%%%%% setupMeasurementUI: Globals.showMeasurements = " + Globals.showMeasurements)

    refreshMeasurementVisibility();

    measurementUIVars.controller =  guiShowHide.add(Globals, "showMeasurements").name(t("labels3d.measurements.label")).tooltip(t("labels3d.measurements.tooltip")).listen().onChange( (value) => {
//        console.warn("%%%%%%% showMeasurements changed to " + value)
        refreshMeasurementVisibility();
        setRenderOne(true);
    })

    measurementUIVars.controllerLook = guiShowHide.add(Globals, "showMeasurementsLook").name(t("labels3d.measurementsInLook.label")).tooltip(t("labels3d.measurementsInLook.tooltip")).listen().onChange( (value) => {
        refreshMeasurementVisibility();
        setRenderOne(true);
    })

    Globals.showLabelsMain = true;
    Globals.showLabelsLook = false;





    labelsControllerMain = guiShowHide.add(Globals, "showLabelsMain").name(t("labels3d.labelsInMain.label")).tooltip(t("labels3d.labelsInMain.tooltip")).listen().onChange( (value) => {
       refreshLabelVisibility();
       setRenderOne(true);
    });

    labelsControllerLook = guiShowHide.add(Globals, "showLabelsLook").name(t("labels3d.labelsInLook.label")).tooltip(t("labels3d.labelsInLook.tooltip")).listen().onChange( (value) => {
        refreshLabelVisibility();
        setRenderOne(true);
    })

    refreshLabelVisibility();

    Globals.showFeaturesMain = true;
    Globals.showFeaturesLook = false;

    featuresControllerMain = guiShowHide.add(Globals, "showFeaturesMain").name(t("labels3d.featuresInMain.label")).tooltip(t("labels3d.featuresInMain.tooltip")).listen().onChange( (value) => {
        refreshFeatureVisibility();
        setRenderOne(true);
    });

    featuresControllerLook = guiShowHide.add(Globals, "showFeaturesLook").name(t("labels3d.featuresInLook.label")).tooltip(t("labels3d.featuresInLook.tooltip")).listen().onChange( (value) => {
        refreshFeatureVisibility();
        setRenderOne(true);
    })

    refreshFeatureVisibility();

}

export function refreshLabelsAfterLoading() {
    measurementUIVars.controller._callOnChange(); // PATCH: call the onChange function to update the UI for the visibility of the measurements

    labelsControllerMain._callOnChange();
    labelsControllerLook._callOnChange();
    featuresControllerMain._callOnChange();
    featuresControllerLook._callOnChange();

    refreshLabelVisibility();
    refreshFeatureVisibility();
}

export function refreshLabelVisibility() {
    // we just set the layers mask to the appropriate value
    let mask = 0;
    if (Globals.showLabelsMain) {
        mask |= LAYER.MASK_MAIN;
    }
    if (Globals.showLabelsLook) {
        mask |= LAYER.MASK_LOOK;
    }
    labelsGroupNode.group.layers.mask = mask;
    propagateLayerMaskObject(labelsGroupNode.group);
}

export function refreshFeatureVisibility() {
    // we just set the layers mask to the appropriate value
    let mask = 0;
    if (Globals.showFeaturesMain) {
        mask |= LAYER.MASK_MAIN;
    }
    if (Globals.showFeaturesLook) {
        mask |= LAYER.MASK_LOOK;
    }
    featuresGroupNode.group.layers.mask = mask;
    propagateLayerMaskObject(featuresGroupNode.group);
}

export function removeMeasurementUI() {
    if (measureArrowGroupNode) {
        measureArrowGroupNode.dispose();
        measureArrowGroupNode = null;
        measureDistanceGroupNode.dispose();
        measureDistanceGroupNode = null;
        labelsGroupNode.dispose();
        labelsGroupNode = null;
        featuresGroupNode.dispose();
        featuresGroupNode = null;
        measurementUIDdone = false
    }
}

export class CNodeLabel3D extends CNode3DGroup {
    constructor(v) {
        const groupNode = NodeMan.get(v.groupNode ?? "MeasurementsGroupNode");
        v.container = groupNode.group;
        super(v)
        this.groupNode = groupNode;
        this.unitType = v.unitType ?? "big";
        this.decimals = v.decimals ?? 2;
        this.size = v.size ?? 12;
        this.text = v.text ?? "";
        this.optionalInputs(["position"])
        this.position = V3();
        this.textPosition = V3();
        if (this.in.position !== undefined) {
            const pos = this.in.position.p(0);
            this.position.copy(pos)
            this.textPosition.copy(pos)
        }

        if (v.positionLLA !== undefined) {
            const lla = v.positionLLA;
            const pos = LLAToECEF(lla.lat, lla.lon, lla.alt);
            this.position.set(pos.x, pos.y, pos.z);
            this.textPosition.copy(this.position);
        }

        this.input("color",true)

        let color = '#FFFFFF';
        if (this.in.color !== undefined) {
            color = this.in.color.v(0)
            if (color.getStyle !== undefined) {
                color = color.getStyle();
            }
        }

        this.color = color;
        this.useHUDColor = v.useHUDColor ?? this.in.color === undefined;
        
        const groupNodeId = v.groupNode ?? "MeasurementsGroupNode";
        if (v.layers !== undefined) {
            this.layerMask = v.layers;
        } else if (groupNodeId === "LabelsGroupNode" || groupNodeId === "FeaturesGroupNode") {
            this.layerMask = LAYER.MASK_MAIN | LAYER.MASK_LOOK;
        } else if (groupNode.isMeasurement) {
            // Whatever the Show menu currently says. Keyed off the GROUP rather than the else
            // branch, because that branch also catches labels hung on unrelated groups — the night
            // sky's celestial arrows among them — which are not measurements and must not start
            // following the measurement toggles.
            this.layerMask = measurementLayerMask();
        } else {
            this.layerMask = LAYER.MASK_HELPERS;
        }
        
        this.isMeasurement = groupNode.isMeasurement ?? false;

        this.offset = V2(v.offsetX ?? 0, v.offsetY ?? 0);
        
        this.strokeWidth = 0;
        this.strokeColor = null;
        this.fontWeight = null;
        this.textAlign = v.textAlign ?? 'left';

        registerLabel3D(this);
    }

    update(f) {
        if (this.in.position !== undefined) {
            const pos = this.in.position.p(f);
            this.position.copy(pos);
            this.textPosition.copy(pos);
        }
    }

    dispose() {
        unregisterLabel3D(this);
        super.dispose();
    }

    changeText(text) {
        if (this.text === text) return;
        this.text = text;
    }

    shouldRender(viewLayerMask) {
        return true;
    }

}

// a text label that shows a given lat/lon at that position
// for labeling pins, etc
export class CNodeLLALabel extends CNodeLabel3D {
    constructor(v) {
        super(v);
        this.lat = v.lat;
        this.lon = v.lon;
        this.alt = v.alt;
        this.update(0);

    }

    update(f) {
        const lat = this.lat;
        const lon = this.lon;
        const text = `${lat.toFixed(4)} ${lon.toFixed(4)}`;
        this.changeText(text);

        const pos = LLAToECEF(lat, lon, this.alt);
        this.position.set(pos.x, pos.y, pos.z);
        this.textPosition.copy(this.position);
    }

    changeLLA(lat, lon, alt) {
        this.lat = lat;
        this.lon = lon;
        this.alt = alt;
        this.update(0);
    }

}

export class CNodeMeasureAB extends CNodeLabel3D {
    constructor(v) {
        v.position = v.A;
        v.textAlign = 'center';
        super(v);
        this.input("A");
        this.input("B");
        this.update(0)
    }

    update(f) {

        // no need to update if it's parent group is not visible
        if (!this.group.visible)
            return;


        this.A = this.in.A.p(f);
        this.B = this.in.B.p(f);
        const midPoint = this.A.clone().add(this.B).multiplyScalar(0.5);
        this.position.copy(midPoint);
        this.textPosition.copy(midPoint);

        // get a point that's 90% of the way from A to midPoint
        this.C = this.A.clone().lerp(midPoint, 0.9);
        // and the same for B
        this.D = this.B.clone().lerp(midPoint, 0.9);

        let color = 0x00FF00;
        if (this.in.color !== undefined) {
            color = this.in.color.v(f)
        }

        // add an arrow from A to C and B to D
        // Use this.group instead of this.groupNode.group so arrows are children of this measurement
        // and will be hidden/shown along with the text label
        DebugArrowAB(this.id + "start", this.C, this.A, color, true, this.group, 20, this.layerMask);
        DebugArrowAB(this.id + "end", this.D, this.B, color, true, this.group, 20, this.layerMask);

        let length

        if (this.altitude) {
            // User-facing altitude labels should be MSL, so convert from geodetic
            // ellipsoid height (HAE) to MSL at each endpoint before differencing.
            const altA = altitudeMSLFromECEF(this.A);
            const altB = altitudeMSLFromECEF(this.B);
            length = altA - altB;
        } else {
            length = this.A.distanceTo(this.B);
        }



        let text;
        if (this.altitude) {
            const alt = altitudeMSLFromECEF(this.A);
            if (alt >= HIGH_ALTITUDE_LABEL_THRESHOLD_M) {
                text = Units.withUnits(alt, HIGH_ALTITUDE_LABEL_DECIMALS, "big") + " msl";
                this.changeText(text);
                return;
            }
            if (Math.abs(alt-length) < 1) {
                // if the altitude is within 1 meter of the length, then just show the length
                // as that means we are over the ocean (zero altitude msl))
                text = Units.withUnits(length, this.decimals, this.unitType) + " msl\n ";
            } else {
                text = Units.withUnits(length, this.decimals, this.unitType) + " agl";
                text += "\n " + Units.withUnits(alt, this.decimals, this.unitType) + " msl";
            }
            //text += "\n "+Units.withUnits(alt, this.decimals, this.unitType)+ " msl";
        } else {
            text = Units.withUnits(length, this.decimals, this.unitType);
        }
        this.changeText(text);

    }

    dispose() {
        removeDebugArrow(this.id+"start");
        removeDebugArrow(this.id+"end");
        super.dispose();
    }
}

export class CNodeLabeledArrow extends CNodeLabel3D {
    constructor(v) {
        super(v);
        this.input("start");
        this.input("direction")
        this.input("length");
        this.input("color")

        this.label = v.label ?? "";
        this.addSimpleSerial("label");

        this.recalculate(0);
        
        // // For negative lengths, initialize textPosition to start (preRender will fix to end)
        // if (this.length < 0) {
        //     this.textPosition.copy(this.start);
        // }
    }

    recalculate(f) {

        this.calculateVectors(f)

        const color = this.in.color.v(f)
        // add an arrow from A to C and B to D
        DebugArrowAB(this.id+"arrow", this.start, this.end, color, true, this.groupNode.group, 20, this.layerMask);


        this.changeText(this.label);

    }

    calculateVectors(f) {
        this.start = this.in.start.p(f);
        this.length = this.in.length.v(f);
        this.direction = this.in.direction.p(f);

        // normalize the direction
        this.direction.normalize();

        // Always compute end (even if wrong magnitude for negative length)
        // so DebugArrowAB can use it. preRender will fix it for negative lengths.
        this.end = this.start.clone().add(this.direction.clone().multiplyScalar(this.length));
        this.position.copy(this.end);
        
        // Only set textPosition for positive lengths
        // For negative length (pixel-based), textPosition is set in preRender
      //  if (this.length >= 0) {
      //      this.textPosition.copy(this.end);
      //  }
    }

    // update the arrow with a new direction
    // which will override the current direction
    updateDirection(dir) {
        this.calculateVectors(par.frame);

        this.direction.copy(dir);
        this.update(0);
    }



    preRender(view) {
        if (this.length < 0) {
            const lengthPixels = -this.length;
            const lengthMeters = view.pixelsToMeters(this.start, lengthPixels);
            const color = this.in.color.v(0)
            this.end = this.start.clone().add(this.direction.clone().multiplyScalar(lengthMeters));
            DebugArrowAB(this.id+"arrow", this.start, this.end, color, true, this.groupNode.group, 20, this.layerMask);
        }
        this.position.copy(this.end);
        this.textPosition.copy(this.end);
    }

    shouldRender(viewLayerMask) {
        const arrow = DebugArrows[this.id + "arrow"];
        if (!arrow) return false;
        if (!isVisible(arrow)) return false;
        if (!(arrow.layers.mask & viewLayerMask)) return false;
        return true;
    }

    dispose() {
        removeDebugArrow(this.id+"arrow");
        super.dispose();
    }
}


// MeasureAltitude will create a munge node B that has A as an input
// and updates itself to be below A (on terrain if any, or MSL if none)
export class CNodeMeasureAltitude extends CNodeMeasureAB {
    constructor(v) {

        assert(v.id !== undefined, "CNodeMeasureAltitude id is undefined")
        v.A = v.position; // we are going to add an AB measure, so we need A
// we are going to munge the position to get the altitude
        const B = new CNodeMunge({
            id: v.id + "_Below",
            inputs: {source: v.A},
            // The munge below raycasts the loaded Google-photorealistic 3D tiles
            // (~2.5ms per call). The label only ever reads the CURRENT frame, so
            // eagerly baking all Sit.frames in recalculate() took ~15s per cascade —
            // and dragging a spline-editor control point cascades on every
            // pointermove, freezing the browser. lazyCache computes per frame on
            // demand instead.
            lazyCache: true,
            munge: (f) => {
                let B;
                const posNode = NodeMan.get(v.A); // cant use this.in.A as super hasnt been called yet
                const A = posNode.p(f);
                // Ride the same 3D-tile surface the AGL camera sits on, so the AGL
                // readout matches the camera's actual ground (otherwise the label
                // measured the smooth elevation map while the camera rode the tiles,
                // so it read e.g. "17 ft agl" with buildings on but "0 ft agl" off).
                B = getTilesPointBelow(A);
                if (B == null) {
                    if (NodeMan.exists("TerrainModel")) {
                        B = NodeMan.get("TerrainModel").getPointBelow(A);
                    } else {
                        B = pointOnSphereBelow(A);
                    }
                }
                return B;
            }
        })
        v.B = B;

        v.unitType ??= "small";
        v.decimals ??= 0;

        super(v);

        this.altitude = true;
    }
}

// A feature marker with a label and an arrow pointing down from 100 pixels above the feature
export class CNodeFeatureMarker extends CNodeLabel3D {
    constructor(v) {
        v.groupNode = v.groupNode ?? "FeaturesGroupNode";
        
        const arrowLength = v.arrowLength ?? 100;
        
        v.offsetY = v.offsetY ?? arrowLength;
        v.textAlign = 'center';
        
        const textColor = v.textColor ?? v.color ?? 0xFFFFFF;
        v.color = textColor;
        
        super(v);

        this.arrowLength = arrowLength;
        this.arrowColor = v.arrowColor ?? 0xFF0000;
        this.textColor = textColor;
        this.text = v.text ?? "";
        
        const hexString = '#' + textColor.toString(16).padStart(6, '0');
        this.color = hexString;
        
        this.strokeWidth = 1;
        this.strokeColor = 'black';
        this.fontWeight = 'bold';
        
        this.lla = null;
        if (v.positionLLA !== undefined) {
            this.lla = {
                lat: v.positionLLA.lat,
                lon: v.positionLLA.lon,
                alt: v.positionLLA.alt
            };
        }
        
        this.featurePosition = V3();
        
        this.recalculate(0);
        
        EventManager.addEventListener("elevationChanged", () => {
            this.recalculate(0);
        });
    }
    
    recalculate(f) {
        if (!this.lla) return;
        
        if (this.lla.alt === 0) {
            const basePos = LLAToECEF(this.lla.lat, this.lla.lon, 0);
            
            if (NodeMan.exists("TerrainModel")) {
                const terrainNode = NodeMan.get("TerrainModel");
                this.featurePosition.copy(terrainNode.getPointBelow(basePos));
            } else {
                this.featurePosition.copy(pointOnSphereBelow(basePos));
            }
        } else {
            const pos = LLAToECEF(this.lla.lat, this.lla.lon, this.lla.alt);
            this.featurePosition.copy(pos);
        }
        
        this.position.copy(this.featurePosition);
        this.textPosition.copy(this.featurePosition);
    }
    
    preRender(view) {
        const topPosition = view.offsetScreenPixels(this.featurePosition.clone(), 0, this.arrowLength);
        DebugArrowAB(this.id + "_arrow", topPosition, this.featurePosition, this.arrowColor, true, this.group, 20, this.groupNode.group.layers.mask);
    }
    
    dispose() {
        removeDebugArrow(this.id + "_arrow");
        super.dispose();
    }
}


export function doLabel3D(id, pos, text, size, layers) {
    let node = NodeMan.get(id, false);
    if (node === undefined) {
        node = new CNodeLabel3D({id, position: pos, text, size, layers});
        NodeMan.add(id, node);
    }
    return node;

}
