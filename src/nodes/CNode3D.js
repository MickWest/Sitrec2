import {CNode} from "./CNode";
import {Globals, guiShowHide, mainLoopCount, markShadowCastersDirty, NodeFactory, setRenderOne} from "../Globals";
import {par} from "../par";
import {assert} from "../assert";
import {normalizeLayerType} from "../utils";
import {altitudeAboveSphere, getLocalNorthVector, getLocalUpVector} from "../SphericalMath";

// wrapper class for THREE.JS objects, like cameras, groups, 3D models, etc.
// Mostly to allow hooking up of controllers, which previous were camera-only
export class CNode3D extends CNode {
    constructor(v) {
        super(v);
        v.layers = normalizeLayerType(v.layers)
        this._object = null;    // a 3D object

        // all 3D objects are display nodes
        this.isDisplayNode = true;
    }

    update(f) {
        super.update(f);
        this.applyControllers(f);
        this.noteShadowCasterState("transform");
    }

    hasVisibleShadowCaster() {
        if (!this._object?.traverse || !this._object.visible) return false;

        let found = false;
        this._object.traverse(child => {
            if (found) return;
            if (child.visible !== false && child.castShadow === true) {
                found = true;
            }
        });
        return found;
    }

    noteShadowCasterState(reason = "shadow caster state") {
        if (!Globals.shadowsEnabled || !this._object) return;

        const hasCaster = this.hasVisibleShadowCaster();
        if (!hasCaster) {
            if (this._lastShadowCasterActive) {
                markShadowCastersDirty(`${this.id}:${reason}:removed`);
            }
            this._lastShadowCasterActive = false;
            this._lastShadowCasterMatrixWorld = null;
            return;
        }

        this._object.updateMatrixWorld(true);
        const elements = this._object.matrixWorld.elements;
        let previous = this._lastShadowCasterMatrixWorld;
        if (!previous) {
            previous = this._lastShadowCasterMatrixWorld = new Array(16);
            for (let i = 0; i < 16; i++) previous[i] = elements[i];
            this._lastShadowCasterActive = true;
            markShadowCastersDirty(`${this.id}:${reason}:added`);
            return;
        }

        let changed = !this._lastShadowCasterActive;
        for (let i = 0; i < 16 && !changed; i++) {
            changed = Math.abs(previous[i] - elements[i]) > 1e-7;
        }

        if (changed) {
            for (let i = 0; i < 16; i++) previous[i] = elements[i];
            markShadowCastersDirty(`${this.id}:${reason}`);
        }
        this._lastShadowCasterActive = true;
    }

    // get the MSL altitude of the origin of the object (or group)
    // (typically will be the CoG of the object, like a plane)
    getAltitude() {
        if (!this._object || !this._object.position) {
            console.warn("getAltitude(): No 3D object attached to " + this.id)
            return 0;
        }
        const alt = altitudeAboveSphere(this._object.position);
        return alt;
    }

    // add a gui checkbox toggle for a member variable
    guiToggle(member, name, tip) {
        const ctrl = guiShowHide.add(this, member).name(name ?? member).listen().onChange((v) => {setRenderOne(true)})
        if (tip) ctrl.tooltip(tip);

        // as its something controlled by the UI, we need to ensure that it's serialized
        this.addSimpleSerial(member)
    }

    applyControllers(f, depth = 0) {
        // To prevent loops, we only apply controllers at most twice per frame
        // remember the f value called with
        // if it's new, then reset count to zero
        // if not new, increment count
        // if count > 100, then it's an inifite loop
        if (mainLoopCount !== this.lastMLC || f !== this.lastF) {
//            console.log("Resetting applyControllersCount for " + this.id + " at mainLoop " + mainLoopCount);
            this.lastF = f;
            this.lastMLC = mainLoopCount;
            this.applyControllersCount = 0
        } else {
//            console.log("Incrementing applyControllersCount to " + this.applyControllersCount+ " for " + this.id + " at mainLoop " + mainLoopCount);
            this.applyControllersCount++
 //           console.log("Inc applyControllersCount to" + this.applyControllersCount + " for " + this.id + " at mainLoop " + mainLoopCount)
            if (this.applyControllersCount === 1000) {
                console.log("ApplyControllersCount reached 1000 for " + this.id + " at mainLoop " + mainLoopCount)
            }
            if (this.applyControllersCount > 1000) {


                // // Dump nodes
                // console.log("DUMPING NODES")
                // console.log(NodeMan.dumpNodes())


                console.warn("Infinite loop detected in controllers for " + this.id + " at mainLoop " + mainLoopCount);
                for (const inputID in this.inputs) {
                    const input = this.inputs[inputID]
                    if (input.isController) {

                        console.log("Controller:  " + input.id)

                    }
                }

                console.log (" f="+f, "depth="+depth, "lastF="+this.lastF, "applyControllersCount="+this.applyControllersCount)

                debugger;
                return
            }
        }

        // Note: JS will iterate object in the order they were added
        // assuming all the keys are non-numeric strings
        // and your browser is reasonable (ES2015+)
        // see https://www.stefanjudis.com/today-i-learned/property-order-is-predictable-in-javascript-objects-since-es2015/
        for (const inputID in this.inputs) {
            const input = this.inputs[inputID]
            if (input.isController && input.enabled) {

                if (par.paused) {
                    //if (depth === 0) {
                    //    console.log("Apply: "+ input.id +" to " + this.id + "frame " + f + " depth " + depth);
                    //} else {
                    //    console.log("|---".repeat(depth) + " Apply:  " + input.id)
                    //}
                }

                input.apply(f,this)
            }
        }

        if (this.postApplyControllers) this.postApplyControllers(f);

    }

    addController(type, def) {
        assert(def.camera === undefined, "Adding a controller with a camera defined, should be object!")
        if (def.id === undefined) {
            def.id = this.id + "_Controller" + type;
        }
        const controller = NodeFactory.create("Controller"+type, def);
        this.addControllerNode(controller)
        return this;
    }

    addControllerNode(node) {
        node.isController = true;
        this.addInput(node.id, node)
        // If object has GUI and controller supports moving GUI, move it to object's folder
        if (this.gui && typeof this.gui.add === 'function' && typeof node.moveGuiTo === 'function') {
            node.moveGuiTo(this.gui);
        }
        return this;
    }


    getUpVector(position) {

        if (position === undefined) {
            position = this._object.position
        }

        // for "lookAt" to work, we need to set the up vector
        // to account for the curvature of the Earth
        // it defaults to 0,1,0, which is only correct at the origin
        if (this.northUp) {
            return getLocalNorthVector(position)
        } else {
            return getLocalUpVector(position)
        }
    }

}
